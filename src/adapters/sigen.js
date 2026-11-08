// MỚI (01/11/2026): Sigenergy (mySigen) OpenAPI — developer.sigencloud.com (cần mã mời của Sigenergy để đăng ký App Key/Secret),
// hoặc đăng nhập bằng tài khoản mySigen của chủ hệ. Tham khảo: github.com/schwarzbr0t/sigenergy-ha.
// GIỚI HẠN: mỗi endpoint chỉ gọi được 1 lần / 5 phút / hệ → lưu kết quả gần nhất trong bộ đệm (token_enc) và dùng lại khi bị chặn.
import { fetchJson, station, num, toW, isoFromAny } from "./util.js";

const REGIONS = { eu: "https://openapi-eu.sigencloud.com", apac: "https://openapi-apac.sigencloud.com", cn: "https://openapi-cn.sigencloud.com", aus: "https://openapi-aus.sigencloud.com", us: "https://openapi-us.sigencloud.com", jp: "https://openapi-jp.sigencloud.com" };
const base = (c) => (c.api_url || REGIONS[String(c.region || "apac").toLowerCase()] || REGIONS.apac).replace(/\/$/, "");
const parse = (v) => { if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } } return v; };
const RATE = new Set([1110, 1201]);

async function getToken(creds, cached) {
  if (cached?.token && cached.exp > Date.now() + 600e3) return { token: cached.token, fresh: null };
  let path, body;
  if (!(creds.app_key && creds.app_secret) && !(creds.username && creds.password)) throw new Error("Sigenergy: nhập App Key + App Secret hoặc email + mật khẩu mySigen");
  if (creds.app_key && creds.app_secret) { path = "/openapi/auth/login/key"; body = { key: btoa(`${creds.app_key}:${creds.app_secret}`) }; }
  else { path = "/openapi/auth/login/password"; body = { username: creds.username, password: creds.password }; }
  const res = await fetchJson(base(creds) + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (Number(res.code) !== 0) throw new Error(`Sigenergy: ${res.msg || "đăng nhập lỗi (mã " + res.code + ")"}`);
  const d = parse(res.data) || {};
  if (!d.accessToken) throw new Error("Sigenergy: không lấy được accessToken");
  const exp = Date.now() + (num(d.expiresIn) || 43199) * 1000;
  return { token: d.accessToken, fresh: { token: d.accessToken, exp } };
}

async function api(creds, token, path, params) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetchJson(base(creds) + path + qs, { headers: { Authorization: `Bearer ${token}` } });
  const code = Number(res.code);
  if (RATE.has(code)) { const e = new Error("Sigenergy giới hạn 1 lần/5 phút — dùng dữ liệu gần nhất"); e.rate = true; throw e; }
  if (code !== 0) throw new Error(`Sigenergy ${path}: ${res.msg || "mã " + code}`);
  return parse(res.data);
}

// Bộ đệm lưu trong token_enc: { token, exp, sys: {at, list}, flow: {id: {at, d}}, sum: {id: {at, d}} }
async function cachedCall(creds, token, cache, bucket, id, maxAge, path, params) {
  const box = (cache[bucket] ||= {});
  const hit = id === null ? box : box[id];
  if (hit?.at && Date.now() - hit.at < maxAge) return hit.d;
  try {
    const d = await api(creds, token, path, params);
    if (id === null) Object.assign(box, { at: Date.now(), d }); else box[id] = { at: Date.now(), d };
    return d;
  } catch (e) {
    if (hit?.d !== undefined && Date.now() - hit.at < 30 * 60e3) return hit.d; // bị giới hạn/lỗi tạm → dùng bản gần nhất (≤ 30 phút)
    throw e;
  }
}

const kw = (v) => toW(v, "kW");

export default {
  brand: "sigen",
  label: "Sigenergy (mySigen)",
  fields: [
    { key: "region", label: "Vùng máy chủ: apac / eu / cn / aus / us / jp", placeholder: "apac", optional: true },
    { key: "app_key", label: "App Key (developer.sigencloud.com)", optional: true },
    { key: "app_secret", label: "App Secret", type: "password", optional: true },
    { key: "username", label: "Hoặc: email tài khoản mySigen", optional: true },
    { key: "password", label: "Mật khẩu mySigen", type: "password", optional: true },
    { key: "api_url", label: "API URL (để trống = theo vùng)", optional: true },
  ],
  help: "Đăng ký tại developer.sigencloud.com (cần mã mời từ Sigenergy) để lấy App Key/Secret, hoặc dùng tài khoản mySigen của chủ hệ. Việt Nam chọn vùng apac. Sigenergy chỉ cho đọc 5 phút/lần.",

  async fetchStations(creds, cached) {
    const { token, fresh } = await getToken(creds, cached);
    const cache = { ...(cached || {}), ...(fresh || {}) };
    const systems = (await cachedCall(creds, token, cache, "sys", null, 3600e3, "/openapi/system")) || [];
    const out = [];
    for (const s of Array.isArray(systems) ? systems : []) {
      const id = String(s.systemId);
      let f = {}, sm = {}, err = null;
      try { f = (await cachedCall(creds, token, cache, "flow", id, 280e3, `/openapi/systems/${id}/energyFlow`, { systemId: id })) || {}; } catch (e) { err = e; }
      try { sm = (await cachedCall(creds, token, cache, "sum", id, 900e3, `/openapi/systems/${id}/summary`, { systemId: id })) || {}; } catch {}
      const at = cache.flow?.[id]?.at;
      const bp = kw(f.batteryPower); // Sigenergy: + = sạc → app: + = xả
      out.push(station({
        ext_id: id,
        name: s.systemName || s.name || id,
        address: s.addr || s.address || null, lat: s.latitude ?? s.lat, lon: s.longitude ?? s.lng ?? s.lon,
        capacity_kwp: num(s.pvCapacity),
        status: err && !at ? "offline" : at && Date.now() - at > 30 * 60e3 ? "offline" : /fault|alarm/i.test(String(s.status || "")) ? "alarm" : "online",
        pv_power_w: kw(f.pvPower),
        load_power_w: kw(f.loadPower),
        grid_power_w: kw(f.gridPower), // + = mua
        battery_power_w: bp === null ? null : -bp,
        battery_soc: f.batterySoc,
        today_kwh: num(sm.dailyPowerGeneration),
        total_kwh: num(sm.lifetimePowerGeneration),
        data_time: at ? new Date(at).toISOString() : null,
      }));
    }
    return { stations: out, token: cache };
  },

  async fetchDetail(creds, cached, systemId) {
    const { token, fresh } = await getToken(creds, cached);
    const cache = { ...(cached || {}), ...(fresh || {}) };
    const id = String(systemId);
    const L = [];
    const add = (name, value, unit, group) => { if (value !== null && value !== undefined && value !== "") L.push({ name, value, unit, group }); };
    const f = cache.flow?.[id]?.d || {};
    const sm = cache.sum?.[id]?.d || {};
    add("Total Solar Power", kw(f.pvPower), "W"); add("Total Consumption Power", kw(f.loadPower), "W"); add("Total Grid Power", kw(f.gridPower), "W");
    if (num(f.batteryPower) !== null) add("Battery Power", -kw(f.batteryPower), "W");
    add("SOC", num(f.batterySoc), "%"); add("EV Charger Power", kw(f.evPower), "W"); add("Heat Pump Power", kw(f.heatPumpPower), "W");
    add("Daily Production", num(sm.dailyPowerGeneration), "kWh"); add("Total Production", num(sm.lifetimePowerGeneration), "kWh");
    let serial = null, model = null;
    try {
      const devs = (await cachedCall(creds, token, cache, "dev", id, 3600e3, `/openapi/system/${id}/devices`, { systemId: id })) || [];
      const inv = devs.find((d) => /inverter/i.test(d.deviceType || ""));
      const meter = devs.find((d) => /gateway|meter/i.test(d.deviceType || ""));
      serial = inv?.serialNumber || null;
      model = parse(inv?.attrMap)?.model || inv?.deviceType || null;
      if (inv) {
        const r = await cachedCall(creds, token, cache, "rt", inv.serialNumber, 280e3, `/openapi/systems/${id}/devices/${inv.serialNumber}/realtimeInfo`, { systemId: id, serialNumber: inv.serialNumber });
        const x = parse(r?.realTimeInfo) || r || {};
        for (const [k, v] of Object.entries(x)) {
          const m = k.match(/^pv(\d+)(Voltage|Current|Power)$/i);
          if (m) add(`${m[2] === "Voltage" ? "Voltage" : m[2] === "Current" ? "Current" : "Power"} PV${m[1]}`, m[2] === "Power" ? kw(v) : num(v), m[2] === "Voltage" ? "V" : m[2] === "Current" ? "A" : "W");
        }
        ["a", "b", "c"].forEach((p, i) => { add(`Load Voltage L${i + 1}`, num(x[`${p}PhaseVoltage`]), "V"); add(`AC Current L${i + 1}`, num(x[`${p}PhaseCurrent`]), "A"); });
        add("Inverter AC Power", kw(x.activePower), "W"); add("Inverter Temperature", num(x.internalTemperature), "℃");
        add("Daily Charging Energy", num(x.esChargingDay), "kWh"); add("Daily Discharging Energy", num(x.esDischargingDay), "kWh");
        add("Grid Frequency", num(x.gridFrequency), "Hz");
        if (!L.some((q) => q.name === "Battery Power") && num(x.batPower) !== null) add("Battery Power", -kw(x.batPower), "W");
      }
      if (meter) {
        const r = await cachedCall(creds, token, cache, "rt", meter.serialNumber, 280e3, `/openapi/systems/${id}/devices/${meter.serialNumber}/realtimeInfo`, { systemId: id, serialNumber: meter.serialNumber });
        const x = parse(r?.realTimeInfo) || r || {};
        // Đồng hồ/gateway đo đúng điểm đấu lưới → áp/dòng LƯỚI thật
        ["A", "B", "C"].forEach((p, i) => { add(`Grid Voltage L${i + 1}`, num(x[`voltage${p}`]), "V"); add(`Grid Current L${i + 1}`, num(x[`current${p}`]), "A"); });
      }
    } catch (e) { if (!L.length) throw e; }
    return { list: L, serial, device: { model }, token: cache };
  },
};
