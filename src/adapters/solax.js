// SolaX Developer Portal OpenAPI v2 — MỚI (31/10/2026): thay API Token ID cũ bằng OAuth client_credentials.
// Lấy Client ID + Client Secret: developer.solaxcloud.com → Application → tạo ứng dụng (đăng nhập bằng tài khoản SolaXCloud).
// Tài liệu: POST /openapi/auth/oauth/token (form: client_id, client_secret, grant_type=client_credentials) → token 30 ngày.
// Mã thành công của các API dữ liệu là 10000 (đăng nhập là 0). businessType: 1 = dân dụng, 4 = thương mại/công nghiệp.
import { fetchJson, station, num, isoFromAny, statusFromTime } from "./util.js";

const base = (c) => (c.api_url || "https://openapi-eu.solaxcloud.com").replace(/\/$/, "");
const bt = (c) => Number(c.business_type) === 4 ? 4 : 1;

async function getToken(creds, cached) {
  if (cached?.token && cached.exp > Date.now() + 3600e3) return { token: cached.token, fresh: null };
  const res = await fetchJson(`${base(creds)}/openapi/auth/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds.client_id, client_secret: creds.client_secret, grant_type: "client_credentials" }).toString(),
  });
  const t = res.result?.access_token;
  if (res.code !== 0 || !t) throw new Error(`SolaX: ${res.message || "không lấy được token (mã " + res.code + ")"}`);
  const exp = Date.now() + (num(res.result.expires_in) || 2592000) * 1000;
  return { token: t, fresh: { token: t, exp } };
}

async function get(creds, token, path, params) {
  const qs = new URLSearchParams({ ...params, businessType: String(bt(creds)) }).toString();
  const res = await fetchJson(`${base(creds)}${path}?${qs}`, { headers: { Authorization: `bearer ${token}` } });
  if (res.code !== 10000) throw new Error(`SolaX ${path}: ${res.message || "mã " + res.code}`);
  return res.result;
}

// Công suất: W khi dân dụng (businessType 1), kW khi thương mại (4) → đổi về W
const toW = (c, v) => { const n = num(v); return n === null ? null : bt(c) === 4 ? n * 1000 : n; };

async function allPages(creds, token, path, params) {
  const out = [];
  for (let pageNo = 1; pageNo <= 20; pageNo++) {
    const r = await get(creds, token, path, { ...params, pageNo: String(pageNo) });
    out.push(...(r.records || []));
    if (pageNo >= (Number(r.pages) || 1)) break;
  }
  return out;
}

async function inverterOf(creds, token, plantId) {
  const devs = await allPages(creds, token, "/openapi/v2/device/page_device_info", { plantId, deviceType: "1" });
  return devs;
}

// Quy đổi dữ liệu thời gian thực của inverter + pin thành danh sách tên chuẩn để giao diện nhận
function toList(creds, inv, bat, ex = {}) {
  const L = [];
  const add = (name, value, unit) => { if (value !== null && value !== undefined) L.push({ name, value, unit }); };
  const pv = inv.pvMap || {};
  const mp = inv.mpptMap || {};
  for (let i = 1; i <= 12; i++) {
    const v = num(pv[`pv${i}Voltage`] ?? mp[`mppt${i}Voltage`]), a = num(pv[`pv${i}Current`] ?? mp[`mppt${i}Current`]), p = toW(creds, pv[`pv${i}Power`] ?? mp[`mppt${i}Power`]);
    if (v === null && a === null && p === null) continue;
    if (!(v || a || p) && i > 4) continue; // bỏ các MPPT không dùng
    add(`Voltage PV${i}`, v, "V"); add(`Current PV${i}`, a, "A"); add(`Power PV${i}`, p, "W");
  }
  add("Total DC Input Power", toW(creds, inv.MPPTTotalInputPower), "W");
  add("Daily Production", num(inv.dailyYield), "kWh");
  add("Total Production", num(inv.totalYield), "kWh");
  for (let i = 1; i <= 3; i++) {
    add(`Grid Voltage L${i}`, num(inv[`acVoltage${i}`]), "V");
    add(`Grid Current L${i}`, num(inv[`acCurrent${i}`]), "A");
  }
  add("Grid Frequency", num(inv.gridFrequency) || num(inv.acFrequency1), "Hz");
  // gridPower của SolaX: dương = bán, âm = mua → đổi sang quy ước app (dương = mua)
  const gp = toW(creds, inv.gridPower);
  add("Total Grid Power", gp === null ? null : -gp, "W");
  add("Daily Energy Purchased", num(inv.todayImportEnergy), "kWh");
  add("Daily Grid Feed In", num(inv.todayExportEnergy), "kWh");
  add("Cumulative Energy Purchased", num(inv.totalImportEnergy), "kWh");
  add("Cumulative Grid Feed In", num(inv.totalExportEnergy), "kWh");
  add("Inverter Temperature", num(inv.inverterTemperature), "℃");
  add("Total Power Factor", num(inv.totalPowerFactor), "");
  for (let i = 1; i <= 3; i++) add(`EPS Power L${i}`, toW(creds, inv[`EPSL${i}ActivePower`]), "W");
  // Công suất AC từng pha + công suất tổng của inverter
  for (let i = 1; i <= 3; i++) add(`AC Power L${i}`, toW(creds, inv[`acPower${i}`]), "W");
  const eps = [1, 2, 3].map((i) => toW(creds, inv[`EPSL${i}ActivePower`])).filter((v) => v !== null);
  if (eps.length) add("UPS Load Power", eps.reduce((a, b) => a + b, 0), "W");
  add("Rated Power", ex.ratedW, "W");
  if (RUN[inv.deviceStatus] || inv.deviceStatus != null) add("Inverter Status", RUN[inv.deviceStatus] || String(inv.deviceStatus), "");
  add("Total Consumption Power", ex.loadW, "W");
  add("Daily Consumption", ex.dailyLoad, "kWh");
  add("Cumulative Consumption", ex.totalLoad, "kWh");
  add("Daily Charging Energy", ex.dailyCharged, "kWh");
  add("Daily Discharging Energy", ex.dailyDischarged, "kWh");
  if (bat) {
    add("SOC", num(bat.batterySOC), "%");
    add("SOH", num(bat.batterySOH), "%");
    const cp = num(bat.chargeDischargePower); // dương = sạc → app: dương = xả
    add("Battery Power", cp === null ? null : -cp, "W");
    add("Battery Voltage", num(bat.batteryVoltage), "V");
    const bc = num(bat.batteryCurrent); // SolaX: dương = sạc → app: dương = xả
    add("Battery Current", bc === null ? null : -bc, "A");
    add("Battery Remaining Energy", num(bat.batteryRemainings), "kWh");
    add("Battery Rated Capacity", ex.batAh, "Ah");
    add("Battery Temperature", num(bat.batteryTemperature), "℃");
    add("Total Charge Energy", num(bat.totalDevicCharge) ?? ex.totalCharged, "kWh");
    add("Total Discharge Energy", num(bat.totalDeviceDischarge) ?? ex.totalDischarged, "kWh");
    add("Total Battery Life Cycles", num(bat.batteryCycleTimes), "");
  }
  return L;
}

const BAD = new Set([103, 104]);
// Tên dòng biến tần (deviceModel, dân dụng) theo Phụ lục 4 của tài liệu SolaX
const MODEL = { 1: "X1-LX", 2: "X-Hybrid", 3: "X1-Hybrid-G3", 4: "X1-Boost/Air/Mini", 5: "X3-Hybrid-G1/G2", 6: "X3-20K/30K", 7: "X3-MIC/PRO", 8: "X1-Smart", 9: "X1-AC", 10: "A1-Hybrid", 11: "A1-FIT", 12: "A1", 13: "J1-ESS", 14: "X3-Hybrid-G4", 15: "X1-Hybrid-G4", 16: "X3-MIC/PRO-G2", 17: "X1-SPT", 18: "X1-Boost-G4", 19: "A1-HYB-G2", 20: "A1-AC-G2", 21: "A1-SMT-G2", 22: "X1-Mini-G4", 23: "X1-IES", 24: "X3-IES", 25: "X3-ULT", 26: "X1-SMART-G2", 31: "X3-AELIO", 32: "X3-HYB-G4 PRO", 33: "X3-NEO-LV", 34: "X1-VAST", 35: "X3-IES-P", 36: "J3-ULT-LV-16.5K", 37: "J3-ULT-30K", 38: "J1-ESS-HB-2", 39: "C3-IES", 40: "X3-IES-A", 41: "X1-IES-A", 43: "X3-ULT-GLV", 44: "X1-MINI-G4 PLUS", 46: "X1-Reno-LV", 47: "A1-HYB-G3", 50: "X-MS 2700", 100: "X3-FTH", 101: "X3-MGA-G2", 102: "X1-Hybrid-LV", 103: "X1-Lite-LV", 104: "X3-GRAND-HV", 105: "X3-FORTH-PLUS", 108: "X3-MIC-G3", 109: "X3-PRO-G3" };
// Trạng thái biến tần (deviceStatus) theo Phụ lục 6
const RUN = { 100: "Waiting", 101: "Self-check", 102: "Normal", 103: "Fault", 104: "Permanent Fault", 105: "Updating", 106: "EPS Check", 107: "EPS Mode", 108: "Self Test", 109: "Idle", 110: "Standby", 111: "PV Wake Up Battery", 112: "Generator Check", 113: "Generator Running", 114: "RSD Standby", 130: "VPP", 131: "TOU Self-use", 132: "TOU Charging", 133: "TOU Discharging", 134: "TOU Battery off", 135: "TOU Peak Shaving", 140: "Start", 150: "Self Use", 151: "Force Time Use", 152: "Back Up", 153: "Feed-in Priority", 154: "Demand", 155: "Const Power", 170: "Stop", 171: "Debug" };

export default {
  brand: "solax",
  label: "SolaX Cloud",
  fields: [
    { key: "client_id", label: "Client ID" },
    { key: "client_secret", label: "Client Secret", type: "password" },
    { key: "business_type", label: "Loại hệ: 1 = dân dụng, 4 = thương mại", placeholder: "1", optional: true },
    { key: "api_url", label: "API URL", placeholder: "https://openapi-eu.solaxcloud.com", optional: true },
  ],
  help: "developer.solaxcloud.com → Application → Create application (đăng nhập bằng tài khoản SolaXCloud) → lấy Client ID và Client Secret. API URL xem ở My Account trên cổng developer (mặc định máy chủ EU).",

  async fetchStations(creds, cached) {
    const { token, fresh } = await getToken(creds, cached);
    const plants = await allPages(creds, token, "/openapi/v2/plant/page_plant_info", {});
    const out = [];
    for (const p of plants) {
      let rt = {}, inv = {}, bat = null, online = null;
      try { rt = await get(creds, token, "/openapi/v2/plant/realtime_data", { plantId: p.plantId }); } catch {}
      let devs = [];
      try {
        devs = await inverterOf(creds, token, p.plantId);
        const sn = devs[0]?.deviceSn;
        if (sn) {
          online = devs.some((d) => Number(d.onlineStatus) === 1);
          inv = (await get(creds, token, "/openapi/v2/device/realtime_data", { snList: sn, deviceType: "1" }))?.[0] || {};
          try { bat = (await get(creds, token, "/openapi/v2/device/realtime_data", { snList: sn, deviceType: "2", requestSnType: "1" }))?.[0] || null; } catch {}
        }
      } catch {}
      const t = isoFromAny(inv.dataTime || null);
      const pvW = toW(creds, inv.MPPTTotalInputPower) ?? (inv.pvMap ? [1, 2, 3, 4, 5, 6].map((i) => toW(creds, inv.pvMap[`pv${i}Power`])).filter((v) => v !== null).reduce((a, b) => a + b, 0) : null);
      const gridExp = toW(creds, inv.gridPower); // + = bán
      const batCharge = bat ? num(bat.chargeDischargePower) : 0; // + = sạc
      const load = pvW !== null ? Math.max(0, pvW - (batCharge || 0) - (gridExp || 0)) : null;
      let status = online === false ? "offline" : statusFromTime(t);
      if (BAD.has(Number(inv.deviceStatus))) status = "alarm";
      out.push(station({
        ext_id: p.plantId,
        name: p.plantName,
        address: p.plantAddress, lat: p.latitude, lon: p.longitude,
        capacity_kwp: p.pvCapacity,
        status,
        pv_power_w: pvW,
        load_power_w: load,
        grid_power_w: gridExp === null ? null : -gridExp,
        battery_power_w: bat && batCharge !== null ? -batCharge : undefined,
        battery_soc: bat?.batterySOC,
        today_kwh: rt.dailyYield,
        total_kwh: rt.totalYield,
        data_time: t,
      }));
    }
    return { stations: out, token: fresh };
  },

  async fetchDetail(creds, cached, plantId) {
    const { token, fresh } = await getToken(creds, cached);
    const devs = await inverterOf(creds, token, plantId);
    const dev = devs[0];
    const sn = dev?.deviceSn;
    if (!sn) throw new Error("Không tìm thấy inverter của trạm trên SolaX Cloud");
    const inv = (await get(creds, token, "/openapi/v2/device/realtime_data", { snList: sn, deviceType: "1" }))?.[0] || {};
    let bat = null, rt = {}, batInfo = null;
    try { bat = (await get(creds, token, "/openapi/v2/device/realtime_data", { snList: sn, deviceType: "2", requestSnType: "1" }))?.[0] || null; } catch {}
    try { rt = await get(creds, token, "/openapi/v2/plant/realtime_data", { plantId }); } catch {}
    try { batInfo = (await allPages(creds, token, "/openapi/v2/device/page_device_info", { plantId, deviceType: "2" }))[0] || null; } catch {}
    // Công suất tải = PV − (sạc +) − (bán +) ; điện tiêu thụ trong ngày = sản xuất + mua + xả − sạc − bán
    const pvW = toW(creds, inv.MPPTTotalInputPower) ?? (inv.pvMap ? [1, 2, 3, 4, 5, 6].map((i) => toW(creds, inv.pvMap[`pv${i}Power`])).filter((v) => v !== null).reduce((a, b) => a + b, 0) : null);
    const loadW = pvW === null ? null : Math.max(0, pvW - (num(bat?.chargeDischargePower) || 0) - (toW(creds, inv.gridPower) || 0));
    const f = (k) => num(rt[k]);
    const sum = (a, b, c, d, e) => [a, b, c, d, e].some((v) => v === null) ? null : Math.round((a + b + c - d - e) * 10) / 10;
    const dailyLoad = sum(f("dailyYield"), f("dailyImported"), f("dailyDischarged"), f("dailyCharged"), f("dailyExported"));
    const totalLoad = sum(f("totalYield"), f("totalImported"), f("totalDischarged"), f("totalCharged"), num(inv.totalExportEnergy));
    // Dung lượng pin (Ah) quy đổi từ Wh danh định / điện áp (≈51,2V cho pin LFP 48V)
    const wh = num(batInfo?.ratedCapacity);
    const v = num(bat?.batteryVoltage);
    const batAh = wh ? Math.round(wh / (v && v >= 40 && v <= 60 ? 51.2 : v || 51.2)) : null;
    const ex = {
      ratedW: dev?.ratedPower != null && num(dev.ratedPower) !== null ? Math.round(num(dev.ratedPower) * 1000) : null,
      loadW, dailyLoad, totalLoad, batAh,
      dailyCharged: f("dailyCharged"), dailyDischarged: f("dailyDischarged"), totalCharged: f("totalCharged"), totalDischarged: f("totalDischarged"),
    };
    const list = toList(creds, inv, bat, ex);
    const model = MODEL[Number(dev.deviceModel)];
    const device = { type: model ? `SolaX ${model}` : undefined, firmware: [dev.armVersion, dev.dspVersion].filter(Boolean).join(" / ") || undefined };
    return { list, serial: sn, time: inv.plantLocalTime, token: fresh, device };
  },
};
