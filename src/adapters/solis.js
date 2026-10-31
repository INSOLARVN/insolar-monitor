// SolisCloud Platform API V2.0 — chữ ký HMAC-SHA1
// Lấy API ID/Secret: soliscloud.com > Account > Basic Settings > API Management
import { md5B64, hmacB64 } from "../crypto.js";
import { fetchJson, station, toW, toKWh, num, isoFromAny } from "./util.js";

async function call(creds, path, body) {
  const base = (creds.api_url || "https://www.soliscloud.com:13333").replace(/\/$/, "");
  const json = JSON.stringify(body);
  const contentMd5 = await md5B64(json);
  const contentType = "application/json";
  const date = new Date().toUTCString();
  const sign = await hmacB64("SHA-1", creds.api_secret, `POST\n${contentMd5}\n${contentType}\n${date}\n${path}`);
  const res = await fetchJson(base + path, {
    method: "POST",
    headers: {
      "Content-MD5": contentMd5,
      "Content-Type": contentType,
      Date: date,
      Authorization: `API ${creds.api_id}:${sign}`,
    },
    body: json,
  });
  if (res.code !== "0" && res.success !== true) throw new Error(`Solis: ${res.msg || res.message || "lỗi"}`);
  return res.data;
}

// ---------- Cài đặt từ xa qua SolisCloud (API điều khiển /v2/api/atRead + /v2/api/control, cần Solis mở quyền) ----------
// Mã CID tham khảo từ github.com/mkuthan/solis-cloud-control (dòng hybrid thế hệ mới).
const CID = { mode: 636, maxChg: 7224, maxDis: 7226, reserve: 157, overdis: 158, force: 160 };
const SLOT = [
  [5916, 5946, 5948, 5928], [5917, 5949, 5951, 5929], [5918, 5952, 5954, 5930], [5919, 5955, 5957, 5931], [5920, 5958, 5960, 5932], [5921, 5961, 5963, 5933],
];
const DSLOT = [
  [5922, 5964, 5967, 5965], [5923, 5968, 5971, 5969], [5924, 5972, 5975, 5973], [5925, 5976, 5979, 5977], [5926, 5980, 5983, 5981], [5927, 5987, 5986, 5984],
];
const MODES = { "Self-Use": 0, "Feed-in Priority": 6, "Off-Grid": 2 };
const MODE_BITS = { mode_grid: 5, mode_backup: 4, mode_tou: 1 };
async function inverterSn(creds, stationId) {
  const inv = await call(creds, "/v1/api/inverterList", { pageNo: 1, pageSize: 20, stationId: String(stationId) });
  const first = inv?.page?.records?.[0];
  if (!first) throw new Error("Trạm chưa có inverter trên SolisCloud");
  return first.sn;
}
async function readBatch(creds, sn, cids) {
  const out = {};
  for (let i = 0; i < cids.length; i += 40) {
    const data = await call(creds, "/v2/api/atReadBatch", { inverterSn: sn, cids: cids.slice(i, i + 40).join(",") });
    for (const grp of data || []) for (const it of [].concat(grp || [])) if (it && it.cid !== undefined) out[Number(it.cid)] = it.msg;
  }
  return out;
}
async function control(creds, sn, cid, value, old) {
  const body = { inverterSn: sn, cid, value: String(value) };
  if (old !== undefined && old !== null) body.yuanzhi = String(old);
  const data = await call(creds, "/v2/api/control", body);
  for (const d of [].concat(data || [])) if (d && d.code !== undefined && String(d.code) !== "0") throw new Error(`Solis từ chối lệnh: ${d.msg || d.code}`);
}
function solisSettings(v) {
  const out = [], n = (x) => (x === undefined || x === null || x === "" || isNaN(Number(x)) ? null : Number(x));
  const mode = n(v[CID.mode]);
  if (mode !== null) {
    const cur = Object.entries(MODES).find(([, b]) => mode & (1 << b))?.[0] ?? null;
    out.push({ key: "mode", name: "Storage Control Mode", group: "Work Mode", platform: "select", options: Object.keys(MODES), value: cur });
    out.push({ key: "mode_grid", name: "Battery Grid Charging", group: "Work Mode", platform: "switch", on: 1, off: 0, bit: null, value: mode & (1 << 5) ? 1 : 0 });
    out.push({ key: "mode_backup", name: "Backup Mode", group: "Work Mode", platform: "switch", on: 1, off: 0, bit: null, value: mode & (1 << 4) ? 1 : 0 });
    out.push({ key: "mode_tou", name: "Time of Use", group: "Work Mode", platform: "switch", on: 1, off: 0, bit: null, value: mode & (1 << 1) ? 1 : 0 });
  }
  const numS = (key, cid, name, uom, min, max) => n(v[cid]) !== null && out.push({ key, name, group: "Settings", platform: "number", uom, min, max, step: 1, value: n(v[cid]) });
  numS("max_chg", CID.maxChg, "Battery Max Charging Current", "A", 0, 200);
  numS("max_dis", CID.maxDis, "Battery Max Discharging Current", "A", 0, 200);
  numS("reserve", CID.reserve, "Backup Mode SOC", "%", 0, 100);
  numS("overdis", CID.overdis, "Overdischarge SOC", "%", 0, 100);
  numS("force", CID.force, "Force Charge SOC", "%", 0, 100);
  [[SLOT, "Charge"], [DSLOT, "Discharge"]].forEach(([tbl, kind]) => tbl.forEach(([sw, tm, cur, soc], i) => {
    if (v[tm] === undefined) return;
    const g = "Time of Use", k = kind[0].toLowerCase();
    out.push({ key: `${k}${i + 1}_on`, name: `Timed ${kind} ${i + 1} Enable`, group: g, platform: "switch", on: 1, off: 0, bit: null, value: String(v[sw]) === "1" ? 1 : 0 });
    out.push({ key: `${k}${i + 1}_time`, name: `Timed ${kind} ${i + 1} Time`, group: g, platform: "text", pattern: "^([01]\\d|2[0-3]):[0-5]\\d-([01]\\d|2[0-3]):[0-5]\\d$", hint: "HH:MM-HH:MM", value: v[tm] });
    if (n(v[cur]) !== null) out.push({ key: `${k}${i + 1}_cur`, name: `Timed ${kind} ${i + 1} Current`, group: g, platform: "number", uom: "A", min: 0, max: 200, step: 1, value: n(v[cur]) });
    if (n(v[soc]) !== null) out.push({ key: `${k}${i + 1}_soc`, name: `Timed ${kind} ${i + 1} SOC`, group: g, platform: "number", uom: "%", min: 0, max: 100, step: 1, value: n(v[soc]) });
  }));
  return out;
}
const ALL_CIDS = [CID.mode, CID.maxChg, CID.maxDis, CID.reserve, CID.overdis, CID.force, ...SLOT.flat(), ...DSLOT.flat()];

const STATE = { 1: "online", 2: "offline", 3: "alarm" };

export default {
  brand: "solis",
  label: "Solis (SolisCloud)",
  fields: [
    { key: "api_id", label: "API ID (KeyId)" },
    { key: "api_secret", label: "API Secret", type: "password" },
    { key: "api_url", label: "API URL", placeholder: "https://www.soliscloud.com:13333", optional: true },
  ],
  help: "SolisCloud > Tài khoản > Cài đặt cơ bản > Quản lý API → bật và lấy API ID, API Secret.",

  async fetchStations(creds) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const data = await call(creds, "/v1/api/userStationList", { pageNo: page, pageSize: 100 });
      const recs = data?.page?.records || [];
      for (const r of recs) {
        out.push(station({
          ext_id: r.id,
          name: r.stationName || r.sno,
          address: r.addr || r.addrOrigin, lat: r.latitude, lon: r.longitude,
          capacity_kwp: num(r.capacity) !== null ? toKWh(r.capacity, r.capacityStr?.replace("p", "h")) : null,
          status: STATE[r.state] || "offline",
          pv_power_w: toW(r.power, r.powerStr),
          load_power_w: toW(r.familyLoadPower, r.familyLoadPowerStr),
          grid_power_w: toW(r.psum, r.psumStr),
          battery_soc: r.batteryPercent ?? r.batteryCapacitySoc,
          today_kwh: toKWh(r.dayEnergy, r.dayEnergyStr),
          total_kwh: toKWh(r.allEnergy, r.allEnergyStr),
          data_time: isoFromAny(r.dataTimestamp),
        }));
      }
      if (recs.length < 100) break;
    }
    return { stations: out };
  },

  async fetchDetail(creds, _cached, stationId) {
    const inv = await call(creds, "/v1/api/inverterList", { pageNo: 1, pageSize: 20, stationId: String(stationId) });
    const first = inv?.page?.records?.[0];
    if (!first) throw new Error("Trạm chưa có inverter trên SolisCloud");
    const x = await call(creds, "/v1/api/inverterDetail", { id: first.id, sn: first.sn });
    const L = (name, value, unit, group) => ({ name, value, unit, group });
    const list = [];
    for (let i = 1; i <= 32; i++) {
      if (x["uPv" + i] === undefined) break;
      list.push(L(`PV${i} Voltage`, x["uPv" + i], "V", "PV"), L(`PV${i} Current`, x["iPv" + i], "A", "PV"), L(`PV${i} Power`, toW(x["pow" + i], x["pow" + i + "Str"]), "W", "PV"));
    }
    [["uAc1", "Grid Voltage L1", "V"], ["uAc2", "Grid Voltage L2", "V"], ["uAc3", "Grid Voltage L3", "V"],
      ["iAc1", "Grid Current L1", "A"], ["iAc2", "Grid Current L2", "A"], ["iAc3", "Grid Current L3", "A"], ["fac", "Grid Frequency", "Hz"],
      ["inverterTemperature", "Inverter Temperature", "°C"], ["batteryCapacitySoc", "SOC", "%"], ["batteryHealthSoh", "Battery SOH", "%"],
      ["batteryVoltage", "Battery Voltage", "V"], ["storageBatteryCurrent", "Battery Current", "A"],
      ["bmsChargeCurrentLimit", "BMS Charge Current Limit", "A"], ["bmsDischargeCurrentLimit", "BMS Discharge Current Limit", "A"]]
      .forEach(([k, n, u]) => x[k] !== undefined && list.push(L(n, x[k], u)));
    list.push(L("Total DC Power", toW(x.pac, x.pacStr), "W"));
    // SolisCloud: batteryPower dương = đang sạc → đổi sang quy ước chung (dương = xả)
    if (x.batteryPower !== undefined) list.push(L("Battery Power", -toW(x.batteryPower, x.batteryPowerStr), "W"));
    if (x.familyLoadPower !== undefined) list.push(L("Load Power", toW(x.familyLoadPower, x.familyLoadPowerStr), "W"));
    if (x.psum !== undefined) list.push(L("Grid Power", -toW(x.psum, x.psumStr), "W"));
    if (x.eToday !== undefined) list.push(L("Daily Production", toKWh(x.eToday, x.eTodayStr), "kWh"));
    if (x.eTotal !== undefined) list.push(L("Total Production", toKWh(x.eTotal, x.eTotalStr), "kWh"));
    if (x.homeLoadTodayEnergy !== undefined) list.push(L("Daily Consumption", toKWh(x.homeLoadTodayEnergy, x.homeLoadTodayEnergyStr), "kWh"));
    if (x.gridPurchasedTodayEnergy !== undefined) list.push(L("Daily Energy Bought", toKWh(x.gridPurchasedTodayEnergy, x.gridPurchasedTodayEnergyStr), "kWh"));
    if (x.gridSellTodayEnergy !== undefined) list.push(L("Daily Energy Sold", toKWh(x.gridSellTodayEnergy, x.gridSellTodayEnergyStr), "kWh"));
    if (x.batteryTodayChargeEnergy !== undefined) list.push(L("Daily Charging Energy", toKWh(x.batteryTodayChargeEnergy, x.batteryTodayChargeEnergyStr), "kWh"));
    if (x.batteryTodayDischargeEnergy !== undefined) list.push(L("Daily Discharging Energy", toKWh(x.batteryTodayDischargeEnergy, x.batteryTodayDischargeEnergyStr), "kWh"));
    let settings = null, settingsError = null;
    try { settings = solisSettings(await readBatch(creds, first.sn, ALL_CIDS)); } catch (e) { settingsError = "Chưa đọc được cài đặt: " + e.message + " (cần xin Solis mở quyền điều khiển API)"; }
    return { list, serial: first.sn, time: x.dataTimestamp, settings, settingsError };
  },

  async writeSetting(creds, _cached, stationId, key, value) {
    const sn = await inverterSn(creds, stationId);
    const num = Number(value), m = key.match(/^([cd])(\d)_(on|time|cur|soc)$/);
    const range = (min, max) => { if (!Number.isFinite(num) || num < min || num > max) throw new Error(`Giá trị phải từ ${min} đến ${max}`); return Math.round(num); };
    if (key === "mode" || MODE_BITS[key] !== undefined) {
      const cur = Number((await readBatch(creds, sn, [CID.mode]))[CID.mode]);
      if (!Number.isFinite(cur)) throw new Error("Không đọc được chế độ hiện tại");
      let nv = cur;
      if (key === "mode") {
        if (MODES[value] === undefined) throw new Error("Chế độ không hợp lệ");
        for (const b of Object.values(MODES)) nv &= ~(1 << b);
        nv |= 1 << MODES[value];
      } else {
        const on = value === true || value === "on" || value === 1;
        nv = on ? nv | (1 << MODE_BITS[key]) : nv & ~(1 << MODE_BITS[key]);
      }
      return control(creds, sn, CID.mode, nv, cur);
    }
    const SIMPLE = { max_chg: [CID.maxChg, 0, 200], max_dis: [CID.maxDis, 0, 200], reserve: [CID.reserve, 0, 100], overdis: [CID.overdis, 0, 100], force: [CID.force, 0, 100] };
    if (SIMPLE[key]) return control(creds, sn, SIMPLE[key][0], range(SIMPLE[key][1], SIMPLE[key][2]));
    if (m) {
      const row = (m[1] === "c" ? SLOT : DSLOT)[Number(m[2]) - 1];
      if (!row) throw new Error("Mốc không hợp lệ");
      if (m[3] === "on") return control(creds, sn, row[0], value === true || value === "on" || value === 1 ? 1 : 0);
      if (m[3] === "time") { if (!/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) throw new Error("Giờ phải dạng HH:MM-HH:MM"); return control(creds, sn, row[1], value); }
      if (m[3] === "cur") return control(creds, sn, row[2], range(0, 200));
      if (m[3] === "soc") return control(creds, sn, row[3], range(0, 100));
    }
    throw new Error("Cài đặt này chưa hỗ trợ qua SolisCloud");
  },
};
