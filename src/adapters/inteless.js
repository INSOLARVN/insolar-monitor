// MỚI (01/11/2026): nền tảng Inteless / E-Linter — app "PV Pro" (Chengdu E-Linter), cũng là nền của Sunsynk Connect.
// Biến tần Chisage, Sosen, Alpsolar… gắn logger E-Linter đẩy dữ liệu lên đây. Đăng nhập bằng chính tài khoản PV Pro.
// Tham khảo: github.com/jamesridgway/sunsynk-api-client (MIT), github.com/chukaonline/ha-alpsolar-inteless.
// Đăng nhập mới: lấy khoá công khai RSA → mã hoá mật khẩu (PKCS#1 v1.5) → /oauth/token/new; máy chủ cũ: /oauth/token mật khẩu thường.
import { fetchJson, station, num, isoFromAny, statusFromTime } from "./util.js";

// Máy chủ thử lần lượt khi người dùng không nhập API URL
const HOSTS = ["https://pv.inteless.com", "https://api.inteless.com", "https://euapi.inteless.com", "https://usapi.inteless.com", "https://api.sunsynk.net"];
const SOURCE = "sunsynk";

async function md5Hex(text) {
  const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- RSA PKCS#1 v1.5 (WebCrypto không hỗ trợ) — đọc khoá SPKI bằng bộ đọc DER tối giản rồi tính m^e mod n bằng BigInt ----
function derRead(b, i) {
  const tag = b[i++]; let len = b[i++];
  if (len & 0x80) { let k = len & 0x7f; len = 0; while (k--) len = len * 256 + b[i++]; }
  return { tag, start: i, end: i + len };
}
function rsaKey(b64key) {
  const b = Uint8Array.from(atob(b64key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  let n = derRead(b, 0); // SEQUENCE
  let x = derRead(b, n.start); // SEQUENCE thuật toán
  let bit = derRead(b, x.end); // BIT STRING
  let seq = derRead(b, bit.start + 1); // SEQUENCE { n, e }
  const ni = derRead(b, seq.start), ei = derRead(b, ni.end);
  const big = (s, e) => { let v = 0n; for (let k = s; k < e; k++) v = (v << 8n) | BigInt(b[k]); return v; };
  return { n: big(ni.start, ni.end), e: big(ei.start, ei.end) };
}
function modPow(base, exp, mod) { let r = 1n; base %= mod; while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; base = (base * base) % mod; exp >>= 1n; } return r; }
function rsaEncrypt(b64key, text) {
  const { n, e } = rsaKey(b64key);
  const k = Math.ceil(n.toString(16).length / 2);
  const m = new TextEncoder().encode(text);
  const ps = new Uint8Array(k - m.length - 3);
  crypto.getRandomValues(ps);
  for (let i = 0; i < ps.length; i++) while (ps[i] === 0) ps[i] = crypto.getRandomValues(new Uint8Array(1))[0];
  const em = new Uint8Array(k); em[1] = 2; em.set(ps, 2); em.set(m, k - m.length);
  let v = 0n; for (const x of em) v = (v << 8n) | BigInt(x);
  let hex = modPow(v, e, n).toString(16).padStart(k * 2, "0");
  return btoa(String.fromCharCode(...hex.match(/../g).map((h) => parseInt(h, 16))));
}

async function loginAt(host, creds) {
  // Cách mới (RSA)
  try {
    const nonce = Date.now();
    const pk = await fetchJson(`${host}/anonymous/publicKey?nonce=${nonce}&source=${SOURCE}&sign=${await md5Hex(`nonce=${nonce}&source=${SOURCE}POWER_VIEW`)}`);
    if (pk?.success && pk.data) {
      const n2 = Date.now();
      const r = await fetchJson(`${host}/oauth/token/new`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: creds.username, password: rsaEncrypt(pk.data, creds.password), grant_type: "password", client_id: "csp-web", source: SOURCE, nonce: n2, sign: await md5Hex(`nonce=${n2}&source=${SOURCE}${String(pk.data).slice(0, 10)}`) }),
      });
      if (r?.success && r.data?.access_token) return r.data;
      if (r?.msg) throw Object.assign(new Error(r.msg), { auth: true });
    }
  } catch (e) { if (e.auth) throw e; }
  // Cách cũ (mật khẩu thường)
  const r = await fetchJson(`${host}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: creds.username, password: creds.password, grant_type: "password", client_id: "csp-web" }) });
  if (r?.data?.access_token) return r.data;
  throw Object.assign(new Error(r?.msg || "sai tài khoản/mật khẩu"), { auth: true });
}

async function getToken(creds, cached) {
  if (cached?.token && cached.host && cached.exp > Date.now() + 300e3) return { token: cached.token, host: cached.host, fresh: null };
  const hosts = creds.api_url ? [creds.api_url.replace(/\/$/, "")] : cached?.host ? [cached.host, ...HOSTS.filter((h) => h !== cached.host)] : HOSTS;
  const errs = [];
  for (const host of hosts) {
    try {
      const d = await loginAt(host, creds);
      const exp = Date.now() + (num(d.expires_in) || 7 * 86400) * 1000;
      return { token: d.access_token, host, fresh: { token: d.access_token, host, exp } };
    } catch (e) { errs.push(`${host.replace("https://", "")}: ${e.message}`); }
  }
  throw new Error(`PV Pro / Inteless: không đăng nhập được (${errs.join(" | ")})`);
}

async function get(host, token, path, params) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const r = await fetchJson(`${host}/${path}${qs}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (!r?.success) throw new Error(`Inteless ${path}: ${r?.msg || "lỗi"}`);
  return r.data;
}
async function paged(host, token, path, params) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const d = await get(host, token, path, { page, limit: 50, ...params });
    const infos = d?.infos || [];
    out.push(...infos);
    if (infos.length < 50 || (num(d?.total) !== null && out.length >= d.total)) break;
  }
  return out;
}
const inverters = (h, t) => paged(h, t, "api/v1/inverters", { total: 0, status: -1, sn: "", plantId: "", type: -2, softVer: "", hmiVer: "", agentCompanyId: -1, gsn: "" });

// Luồng năng lượng → quy ước app (pin + = xả, lưới + = mua)
function fromFlow(f) {
  const pb = num(f.battPower), pg = num(f.gridOrMeterPower);
  const bat = pb === null ? null : f.toBat ? -Math.abs(pb) : f.batTo ? Math.abs(pb) : pb;
  const grid = pg === null ? null : f.toGrid ? -Math.abs(pg) : f.gridTo ? Math.abs(pg) : pg;
  return { pv: num(f.pvPower), load: num(f.loadOrEpsPower) ?? num(f.homeLoadPower), bat, grid, soc: num(f.soc) };
}

export default {
  brand: "inteless",
  label: "PV Pro / Inteless (E-Linter: Chisage, Sosen, Sunsynk…)",
  fields: [
    { key: "username", label: "Email / SĐT tài khoản PV Pro" },
    { key: "password", label: "Mật khẩu PV Pro", type: "password" },
    { key: "api_url", label: "API URL (để trống = tự dò máy chủ)", placeholder: "https://pv.inteless.com", optional: true },
  ],
  help: "Dùng đúng tài khoản đăng nhập app PV Pro (logger E-Linter). Máy chủ được tự dò: pv.inteless.com, api.inteless.com, euapi, usapi, Sunsynk.",

  async fetchStations(creds, cached) {
    const { token, host, fresh } = await getToken(creds, cached);
    const plants = await paged(host, token, "api/v1/plants", { name: "", status: "" });
    const invs = await inverters(host, token);
    const out = [];
    for (const p of plants) {
      const mine = invs.filter((x) => String(x.plant?.id) === String(p.id));
      const sum = { pv: null, load: null, bat: null, grid: null, soc: null };
      const add = (k, v) => { if (v !== null) sum[k] = (sum[k] || 0) + v; };
      for (const inv of mine.slice(0, 10)) {
        try { const f = fromFlow(await get(host, token, `api/v1/inverter/${inv.sn}/flow`)); add("pv", f.pv); add("load", f.load); add("bat", f.bat); add("grid", f.grid); if (f.soc !== null) sum.soc = f.soc; } catch {}
      }
      const t = isoFromAny(p.updateAt);
      // status của plant: 1 = bình thường, 2 = cảnh báo/lỗi, 0/3 = ngoại tuyến (theo Sunsynk Connect)
      const st = Number(p.status);
      let status = st === 0 || st === 3 ? "offline" : statusFromTime(t);
      if (st === 2) status = "alarm";
      out.push(station({
        ext_id: p.id, name: p.name, address: p.address, lat: p.lat, lon: p.lon, capacity_kwp: num(p.totalPower), status,
        pv_power_w: sum.pv ?? num(p.pac), load_power_w: sum.load, grid_power_w: sum.grid, battery_power_w: sum.bat, battery_soc: sum.soc,
        today_kwh: num(p.etoday), total_kwh: num(p.etotal), data_time: t,
      }));
    }
    return { stations: out, token: fresh };
  },

  async fetchDetail(creds, cached, plantId) {
    const { token, host, fresh } = await getToken(creds, cached);
    const inv = (await inverters(host, token)).find((x) => String(x.plant?.id) === String(plantId));
    if (!inv) throw new Error("Trạm chưa có biến tần trên PV Pro");
    const sn = inv.sn;
    const g = async (path, params) => { try { return (await get(host, token, path, params)) || {}; } catch { return {}; } };
    const [flow, input, output, grid, load, bat] = await Promise.all([
      g(`api/v1/inverter/${sn}/flow`), g(`api/v1/inverter/${sn}/realtime/input`), g(`api/v1/inverter/${sn}/realtime/output`),
      g(`api/v1/inverter/grid/${sn}/realtime`, { sn }), g(`api/v1/inverter/load/${sn}/realtime`, { sn }), g(`api/v1/inverter/battery/${sn}/realtime`, { sn, lan: "en" }),
    ]);
    const L = [];
    const add = (name, value, unit) => { if (num(value) !== null || (typeof value === "string" && value)) L.push({ name, value, unit }); };
    const f = fromFlow(flow);
    for (const s of input.pvIV || []) { const i = num(s.pvNo); if (!i) continue; add(`Voltage PV${i}`, s.vpv, "V"); add(`Current PV${i}`, s.ipv, "A"); add(`Power PV${i}`, s.ppv, "W"); }
    add("Total DC Input Power", f.pv ?? input.pac, "W");
    add("Daily Production", input.etoday, "kWh"); add("Total Production", input.etotal, "kWh");
    // Lưới: vip của grid là áp/dòng đo tại CT/đồng hồ lưới → đúng dòng LƯỚI
    (grid.vip || []).forEach((x, i) => { add(`Grid Voltage L${i + 1}`, x.volt, "V"); add(`Grid Current L${i + 1}`, x.current, "A"); });
    add("Grid Frequency", grid.fac, "Hz");
    add("Total Grid Power", f.grid ?? grid.pac, "W");
    add("Daily Energy Bought", grid.etodayFrom, "kWh"); add("Daily Energy Sold", grid.etodayTo, "kWh");
    add("Cumulative Energy Purchased", grid.etotalFrom, "kWh"); add("Cumulative Grid Feed In", grid.etotalTo, "kWh");
    // Đầu ra biến tần
    (output.vip || []).forEach((x, i) => add(`AC Current L${i + 1}`, x.current, "A"));
    add("Inverter AC Power", output.pInv ?? output.pac, "W");
    // Tải
    (load.vip || []).forEach((x, i) => { add(`Load Voltage L${i + 1}`, x.volt, "V"); add(`Load Current L${i + 1}`, x.current, "A"); add(`Load Power L${i + 1}`, x.power, "W"); });
    add("Total Consumption Power", f.load ?? load.totalPower, "W");
    add("Daily Consumption", load.dailyUsed, "kWh"); add("Cumulative Consumption", load.totalUsed, "kWh");
    add("UPS Load Power", load.upsPowerTotal ?? flow.upsLoadPower, "W");
    // Pin (Sunsynk/Deye: power + = xả)
    add("Battery Power", f.bat ?? bat.power, "W");
    add("Battery Voltage", bat.voltage, "V"); add("Battery Current", bat.current, "A");
    add("SOC", f.soc ?? bat.soc, "%"); add("Battery Temperature", bat.temp, "℃");
    add("Daily Charging Energy", bat.etodayChg, "kWh"); add("Daily Discharging Energy", bat.etodayDischg, "kWh");
    add("Total Charge Energy", bat.etotalChg, "kWh"); add("Total Discharge Energy", bat.etotalDischg, "kWh");
    add("BMS Charge Current Limit", bat.chargeCurrentLimit, "A"); add("BMS Discharge Current Limit", bat.dischargeCurrentLimit, "A");
    add("Generator Power", flow.genPower, "W");
    return { list: L, serial: sn, device: { model: inv.model || inv.equipMode || null, firmware: inv.masterVer || null }, token: fresh };
  },

  // Lịch sử: ngày = plant/energy/{id}/day (5 phút); tháng = plant/energy/{id}/month
  async fetchHistory(creds, cached, plantId, range, date) {
    const { token, host, fresh } = await getToken(creds, cached);
    if (range === "year") return { bars: [], token: fresh };
    if (range === "month") {
      const d = await get(host, token, `api/v1/plant/energy/${plantId}/month`, { lan: "en", date: date.slice(0, 7), id: plantId });
      const ser = (re) => (d?.infos || []).find((x) => re.test(String(x.label || "")))?.records || [];
      const by = {};
      const put = (re, k) => { for (const r of ser(re)) { const day = String(r.time).slice(0, 10); (by[day] ||= { label: day.slice(8), day })[k] = num(r.value); } };
      put(/^pv$/i, "pv"); put(/load|consumption/i, "load"); put(/^buy|import|purchas/i, "imp"); put(/^sell|export|feed/i, "exp"); put(/^charg/i, "chg"); put(/^discharg/i, "dis");
      return { bars: Object.values(by).sort((a, b) => (a.day < b.day ? -1 : 1)), token: fresh };
    }
    const d = await get(host, token, `api/v1/plant/energy/${plantId}/day`, { lan: "en", date, id: plantId });
    const pts = new Map();
    for (const s of d?.infos || []) {
      const lb = String(s.label || "").toLowerCase();
      const k = lb === "pv" ? "pv" : /load|consum/.test(lb) ? "load" : /soc/.test(lb) ? "soc" : /batt/.test(lb) ? "bat" : /grid/.test(lb) ? "grid" : null;
      if (!k) continue;
      for (const r of s.records || []) {
        const ts = isoFromAny(/^\d{1,2}:\d{2}/.test(r.time) ? `${date} ${r.time}` : r.time);
        if (!ts) continue;
        (pts.get(ts) || pts.set(ts, { ts, pv: null, load: null, grid: null, bat: null, soc: null, today_kwh: null }).get(ts))[k] = num(r.value);
      }
    }
    return { points: [...pts.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1)), token: fresh };
  },
};
