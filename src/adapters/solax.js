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
function toList(creds, inv, bat) {
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
  if (bat) {
    add("SOC", num(bat.batterySOC), "%");
    add("SOH", num(bat.batterySOH), "%");
    const cp = num(bat.chargeDischargePower); // dương = sạc → app: dương = xả
    add("Battery Power", cp === null ? null : -cp, "W");
    add("Battery Voltage", num(bat.batteryVoltage), "V");
    add("Battery Current", num(bat.batteryCurrent), "A");
    add("Battery Temperature", num(bat.batteryTemperature), "℃");
    add("Total Charge Energy", num(bat.totalDevicCharge), "kWh");
    add("Total Discharge Energy", num(bat.totalDeviceDischarge), "kWh");
    add("Total Battery Life Cycles", num(bat.batteryCycleTimes), "");
  }
  return L;
}

const BAD = new Set([103, 104]);

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
    const sn = devs[0]?.deviceSn;
    if (!sn) throw new Error("Không tìm thấy inverter của trạm trên SolaX Cloud");
    const inv = (await get(creds, token, "/openapi/v2/device/realtime_data", { snList: sn, deviceType: "1" }))?.[0] || {};
    let bat = null;
    try { bat = (await get(creds, token, "/openapi/v2/device/realtime_data", { snList: sn, deviceType: "2", requestSnType: "1" }))?.[0] || null; } catch {}
    const list = toList(creds, inv, bat);
    return { list, serial: sn, time: inv.plantLocalTime, token: fresh };
  },
};
