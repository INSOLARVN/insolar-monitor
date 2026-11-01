// MỚI (01/11/2026): FoxESS Cloud OpenAPI — lấy API Key tại foxesscloud.com → Hồ sơ người dùng → API Management.
// Chữ ký: md5(path + "\r\n" + token + "\r\n" + timestamp) — "\r\n" là CHUỖI 4 ký tự (gạch chéo r gạch chéo n), không phải xuống dòng.
// Tham khảo: github.com/TonyM1958/FoxESS-Cloud (MIT). Giới hạn ~1440 lần gọi/ngày/biến tần → đồng bộ 5 phút gọi gộp nhiều biến tần.
import { fetchJson, station, num, toW, isoFromAny, statusFromTime } from "./util.js";

// Giờ FoxESS dạng "2026-11-01 09:15:00 ICT+0700" → ISO
const foxTime = (t) => {
  const m = String(t || "").match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?: [A-Za-z]*([+-]\d{2})(\d{2}))?/);
  if (!m) return isoFromAny(t);
  const d = new Date(`${m[1]}T${m[2]}${m[3] ? `${m[3]}:${m[4]}` : "+07:00"}`);
  return isNaN(d) ? null : d.toISOString();
};

const base = (c) => (c.api_url || "https://www.foxesscloud.com").replace(/\/$/, "");

async function md5Hex(text) {
  const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function call(creds, method, path, body, params) {
  const token = String(creds.api_key || "").trim();
  const ts = String(Date.now());
  const headers = {
    token, timestamp: ts, lang: "en", timezone: "Asia/Ho_Chi_Minh", "Content-Type": "application/json",
    signature: await md5Hex(`${path}\\r\\n${token}\\r\\n${ts}`),
  };
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetchJson(`${base(creds)}${path}${qs}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  if (Number(res.errno) !== 0) {
    const M = { 40256: "thiếu header", 40257: "tham số sai", 40400: "quá nhiều lần gọi, thử lại sau", 41807: "sai API Key", 41808: "API Key hết hạn", 41809: "API Key không hợp lệ", 40402: "vượt giới hạn gọi trong ngày", 41930: "không có quyền với thiết bị", 41935: "thiết bị ngoại tuyến" };
    throw new Error(`FoxESS ${path}: ${M[res.errno] || res.msg || "mã " + res.errno}`);
  }
  return res.result;
}
const post = (c, path, body) => call(c, "POST", path, body);
const get = (c, path, params) => call(c, "GET", path, null, params);

async function devices(creds) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await post(creds, "/op/v0/device/list", { currentPage: page, pageSize: 100 });
    out.push(...(r?.data || []));
    if ((r?.data || []).length < 100) break;
  }
  return out;
}

// Dữ liệu thời gian thực của nhiều biến tần trong 1 lần gọi (tối đa 50)
async function realOf(creds, sns) {
  const map = {};
  for (let i = 0; i < sns.length; i += 50) {
    const r = await post(creds, "/op/v1/device/real/query", { sns: sns.slice(i, i + 50) });
    for (const x of r || []) {
      const v = {};
      for (const it of x.datas || []) v[it.variable] = { value: it.value, unit: it.unit, name: it.name };
      map[x.deviceSN] = { v, time: x.time };
    }
  }
  return map;
}

const W = (v, k) => (v[k] ? toW(v[k].value, v[k].unit || "kW") : null);
const V = (v, k) => (v[k] ? num(v[k].value) : null);
const first = (v, ...ks) => { for (const k of ks) { const x = V(v, k); if (x !== null) return x; } return null; };
const firstW = (v, ...ks) => { for (const k of ks) { const x = W(v, k); if (x !== null) return x; } return null; };

// Tổng hợp công suất theo quy ước app: lưới + = mua, pin + = xả
function powers(v) {
  const imp = W(v, "gridConsumptionPower"), exp = W(v, "feedinPower");
  const chg = W(v, "batChargePower"), dis = W(v, "batDischargePower");
  let pv = W(v, "pvPower");
  if (pv === null) { const ps = [...Array(18)].map((_, i) => W(v, `pv${i + 1}Power`)).filter((x) => x !== null); pv = ps.length ? ps.reduce((a, b) => a + b, 0) : null; }
  return {
    pv,
    load: firstW(v, "loadsPower", "loadsPowerTotal"),
    grid: imp !== null || exp !== null ? (imp || 0) - (exp || 0) : null,
    bat: chg !== null || dis !== null ? (dis || 0) - (chg || 0) : firstW(v, "invBatPower") === null ? null : -firstW(v, "invBatPower"),
    soc: first(v, "SoC", "SoC_1"),
  };
}

function toList(v) {
  const L = [];
  const add = (name, value, unit) => { if (value !== null && value !== undefined) L.push({ name, value, unit }); };
  const p = powers(v);
  for (let i = 1; i <= 18; i++) {
    const vv = V(v, `pv${i}Volt`), a = V(v, `pv${i}Current`), w = W(v, `pv${i}Power`);
    if (vv === null && a === null && w === null) continue;
    if (!(vv || a || w) && i > 4) continue;
    add(`Voltage PV${i}`, vv, "V"); add(`Current PV${i}`, a, "A"); add(`Power PV${i}`, w, "W");
  }
  add("Total DC Input Power", p.pv, "W");
  ["R", "S", "T"].forEach((ph, i) => {
    add(`Grid Voltage L${i + 1}`, V(v, `${ph}Volt`), "V");
    add(`AC Current L${i + 1}`, V(v, `${ph}Current`), "A"); // dòng đầu ra biến tần
    add(`AC Power L${i + 1}`, W(v, `${ph}Power`), "W");
  });
  add("Grid Frequency", first(v, "RFreq", "SFreq"), "Hz");
  add("Total Grid Power", p.grid, "W");
  add("Total Consumption Power", p.load, "W");
  add("Inverter AC Power", W(v, "generationPower"), "W");
  add("UPS Load Power", firstW(v, "epsPower"), "W");
  add("Battery Power", p.bat, "W");
  add("Battery Voltage", first(v, "invBatVolt", "batVolt", "batVolt_1"), "V");
  add("Battery Current", first(v, "invBatCurrent", "batCurrent", "batCurrent_1"), "A");
  add("SOC", p.soc, "%");
  add("SOH", first(v, "SOH", "SOH_1"), "%");
  add("Battery Temperature", first(v, "batTemperature", "batTemperature_1"), "℃");
  add("Inverter Temperature", first(v, "invTemperation"), "℃");
  add("Daily Production", first(v, "todayYield"), "kWh");
  add("Inverter Status", v.runningState ? String(v.runningState.value) : null, "");
  // Mọi biến còn lại vẫn hiện trong bảng thông số
  const known = new Set(L.map((x) => x.name));
  for (const [k, x] of Object.entries(v)) if (!known.has(k) && x && x.value !== null && x.value !== undefined && typeof x.value !== "object") L.push({ name: x.name || k, key: k, value: x.value, unit: x.unit || null, group: "FoxESS" });
  return L;
}

export default {
  brand: "foxess",
  label: "FoxESS Cloud",
  fields: [
    { key: "api_key", label: "API Key", type: "password" },
    { key: "api_url", label: "API URL", placeholder: "https://www.foxesscloud.com", optional: true },
  ],
  help: "foxesscloud.com → biểu tượng người dùng → User Profile → API Management → Generate API key.",

  async fetchStations(creds) {
    const plants = [];
    for (let page = 1; page <= 10; page++) {
      const r = await post(creds, "/op/v0/plant/list", { currentPage: page, pageSize: 100 });
      plants.push(...(r?.data || []));
      if ((r?.data || []).length < 100) break;
    }
    const devs = await devices(creds);
    let real = {};
    try { real = await realOf(creds, devs.filter((d) => Number(d.status) !== 3).map((d) => d.deviceSN)); } catch {}
    const out = [];
    for (const pl of plants) {
      const mine = devs.filter((d) => String(d.stationID) === String(pl.stationID));
      const sum = { pv: null, load: null, grid: null, bat: null, soc: null, today: null };
      let t = null;
      const add = (k, x) => { if (x !== null && x !== undefined) sum[k] = (sum[k] || 0) + x; };
      for (const d of mine) {
        const r = real[d.deviceSN];
        if (!r) continue;
        const p = powers(r.v);
        add("pv", p.pv); add("load", p.load); add("grid", p.grid); add("bat", p.bat); add("today", V(r.v, "todayYield"));
        if (p.soc !== null) sum.soc = p.soc;
        t = foxTime(r.time) || t;
      }
      const sts = mine.map((d) => Number(d.status));
      let status = !mine.length || sts.every((s) => s === 3) ? "offline" : statusFromTime(t);
      if (sts.includes(2)) status = "alarm";
      out.push(station({
        ext_id: pl.stationID, name: pl.name, status,
        pv_power_w: sum.pv, load_power_w: sum.load, grid_power_w: sum.grid, battery_power_w: sum.bat, battery_soc: sum.soc,
        today_kwh: sum.today, data_time: t,
      }));
    }
    return { stations: out };
  },

  async fetchDetail(creds, _cached, stationId) {
    const devs = (await devices(creds)).filter((d) => String(d.stationID) === String(stationId));
    const inv = devs[0];
    if (!inv) throw new Error("Trạm chưa có biến tần trên FoxESS Cloud");
    const r = (await realOf(creds, [inv.deviceSN]))[inv.deviceSN];
    if (!r) throw new Error("FoxESS chưa trả dữ liệu thời gian thực");
    const list = toList(r.v);
    try {
      const g = await get(creds, "/op/v0/device/generation", { sn: inv.deviceSN });
      if (num(g?.cumulative) !== null) list.push({ name: "Total Production", value: num(g.cumulative), unit: "kWh" });
      if (num(g?.today) !== null && !list.some((x) => x.name === "Daily Production")) list.push({ name: "Daily Production", value: num(g.today), unit: "kWh" });
    } catch {}
    return { list, serial: inv.deviceSN, device: { model: inv.deviceType || null }, time: r.time };
  },

  // Lịch sử: ngày = history/query (mỗi 5 phút); tháng/năm = report/query
  async fetchHistory(creds, _cached, stationId, range, date) {
    const inv = (await devices(creds)).find((d) => String(d.stationID) === String(stationId));
    if (!inv) throw new Error("Không tìm thấy biến tần của trạm");
    const [y, m, dd] = date.split("-").map(Number);
    if (range === "month" || range === "year") {
      const vars = ["generation", "loads", "gridConsumption", "feedin", "chargeEnergyToTal", "dischargeEnergyToTal"];
      const r = await post(creds, "/op/v0/device/report/query", { sn: inv.deviceSN, dimension: range === "year" ? "year" : "month", variables: vars, year: y, month: m, day: dd });
      const by = Object.fromEntries((r || []).map((x) => [x.variable, x.values || []]));
      const len = Math.max(0, ...Object.values(by).map((a) => a.length));
      const bars = [];
      for (let i = 0; i < len; i++) {
        const lb = String(i + 1).padStart(2, "0");
        const val = (k) => num(by[k]?.[i]);
        bars.push({ label: lb, day: range === "month" ? `${date.slice(0, 7)}-${lb}` : undefined, pv: val("generation"), load: val("loads"), imp: val("gridConsumption"), exp: val("feedin"), chg: val("chargeEnergyToTal"), dis: val("dischargeEnergyToTal") });
      }
      if (range === "month") { const days = new Date(Date.UTC(y, m, 0)).getUTCDate(); return { bars: bars.slice(0, days) }; }
      return { bars: bars.slice(0, 12) };
    }
    const t0 = new Date(date + "T00:00:00+07:00").getTime();
    const vars = ["pvPower", "loadsPower", "gridConsumptionPower", "feedinPower", "batChargePower", "batDischargePower", "SoC"];
    const r = await post(creds, "/op/v0/device/history/query", { sn: inv.deviceSN, variables: vars, begin: t0, end: t0 + 86400e3 - 1 });
    const datas = r?.[0]?.datas || [];
    const pts = new Map();
    for (const x of datas) {
      for (const it of x.data || []) {
        const ts = foxTime(it.time);
        if (!ts) continue;
        const p = pts.get(ts) || {};
        p[x.variable] = x.variable === "SoC" ? num(it.value) : toW(it.value, x.unit || "kW");
        pts.set(ts, p);
      }
    }
    const points = [...pts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ts, p]) => ({
      ts, pv: p.pvPower ?? null, load: p.loadsPower ?? null,
      grid: p.gridConsumptionPower !== undefined || p.feedinPower !== undefined ? (p.gridConsumptionPower || 0) - (p.feedinPower || 0) : null,
      bat: p.batChargePower !== undefined || p.batDischargePower !== undefined ? (p.batDischargePower || 0) - (p.batChargePower || 0) : null,
      soc: p.SoC ?? null, today_kwh: null,
    }));
    return { points };
  },
};

