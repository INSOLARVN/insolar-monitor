// SOLARMAN OpenAPI v1.0 — dùng cho mọi máy gắn logger/dongle Solarman:
// Deye, SRNE, Sofar, Afore, Kstar, Sunsynk... (xem trong app Solarman Smart / Business)
// appId + appSecret: email service@solarmanpv.com để xin quyền OpenAPI
import { sha256Hex } from "../crypto.js";
import { fetchJson, station, num, isoFromAny, vnDate, statusFromTime, alarm } from "./util.js";

const base = (c) => (c.api_url || "https://globalapi.solarmanpv.com").replace(/\/$/, "");

async function getToken(creds, cached) {
  if (cached?.token && cached.exp > Date.now() + 3600e3) return { token: cached.token, fresh: null };
  const pw = /^[a-f0-9]{64}$/.test(creds.password) ? creds.password : await sha256Hex(creds.password);
  const body = { appSecret: creds.app_secret, password: pw };
  if (creds.username.includes("@")) body.email = creds.username;
  else if (/^\+?\d{8,}$/.test(creds.username)) { body.mobile = creds.username; body.countryCode = "84"; }
  else body.username = creds.username;
  if (creds.org_id) body.orgId = Number(creds.org_id); // tài khoản Solarman Business
  const res = await fetchJson(`${base(creds)}/account/v1.0/token?appId=${encodeURIComponent(creds.app_id)}&language=en`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.access_token) throw new Error(`Solarman: ${res.msg || "không lấy được token"}`);
  const exp = Date.now() + (num(res.expires_in) || 5184000) * 1000;
  return { token: res.access_token, fresh: { token: res.access_token, exp } };
}

async function post(creds, token, path, body) {
  const res = await fetchJson(`${base(creds)}${path}?language=en`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (res.success === false) throw new Error(`Solarman ${path}: ${res.msg || res.code}`);
  return res;
}

export default {
  brand: "solarman",
  label: "Solarman OpenAPI (trả phí — cần App ID)",
  fields: [
    { key: "app_id", label: "App ID" },
    { key: "app_secret", label: "App Secret", type: "password" },
    { key: "username", label: "Email / SĐT / tên đăng nhập Solarman" },
    { key: "password", label: "Mật khẩu Solarman", type: "password" },
    { key: "org_id", label: "Org ID (chỉ khi dùng Solarman Business)", optional: true },
    { key: "api_url", label: "API URL", placeholder: "https://globalapi.solarmanpv.com", optional: true },
  ],
  help: "OpenAPI Solarman là dịch vụ trả phí. Không có App ID thì chọn \"Solarman Smart (đăng nhập app)\". Gửi email tới service@solarmanpv.com xin quyền OpenAPI (nêu là doanh nghiệp, tài khoản Solarman Business) để nhận App ID + App Secret.",

  async fetchStations(creds, cached) {
    const { token, fresh } = await getToken(creds, cached);
    const list = [];
    for (let page = 1; page <= 20; page++) {
      const r = await post(creds, token, "/station/v1.0/list", { page, size: 100 });
      list.push(...(r.stationList || []));
      if ((r.stationList || []).length < 100) break;
    }
    const today = vnDate();
    const out = [];
    for (const s of list) {
      let rt = {}, day = {};
      try { rt = await post(creds, token, "/station/v1.0/realTime", { stationId: s.id }); } catch {}
      try {
        const h = await post(creds, token, "/station/v1.0/history", { stationId: s.id, timeType: 2, startTime: today, endTime: today });
        day = (h.stationDataItems || [])[0] || {};
      } catch {}
      const t = isoFromAny(rt.lastUpdateTime || s.lastUpdateTime);
      const net = String(s.networkStatus || "").toUpperCase();
      let status = net === "ALL_OFFLINE" ? "offline" : statusFromTime(t);
      if (num(s.warningStatus) > 0 || /ALARM|FAULT/.test(net)) status = "alarm";
      out.push(station({
        ext_id: s.id,
        name: s.name,
        address: s.locationAddress, lat: s.locationLat, lon: s.locationLng,
        capacity_kwp: s.installedCapacity,
        status,
        pv_power_w: rt.generationPower ?? s.generationPower,
        load_power_w: rt.usePower,
        // SỬA (08/11/2026): cùng nền tảng Solarman — wirePower âm = mua (đã kiểm với dữ liệu thật Solarman Business) → đổi dấu; không có thì để trống
        grid_power_w: num(rt.wirePower) === null ? null : -num(rt.wirePower),
        battery_power_w: num(rt.dischargePower) !== null || num(rt.chargePower) !== null ? (num(rt.dischargePower) || 0) - (num(rt.chargePower) || 0) : rt.batteryPower, // MỚI (01/11/2026)
        battery_soc: rt.batterySoc,
        today_kwh: day.generationValue ?? rt.generationValue,
        total_kwh: rt.generationTotal ?? s.generationTotal,
        data_time: t,
      }));
    }
    return { stations: out, token: fresh };
  },

  // Toàn bộ thông số của inverter giống app Solarman (PV1/PV2, điện áp pha, BMS…)
  async fetchDetail(creds, cached, stationId) {
    const { token, fresh } = await getToken(creds, cached);
    const dev = await post(creds, token, "/station/v1.0/device", { stationId: Number(stationId), deviceType: "INVERTER" });
    const items = dev.deviceListItems || [];
    const inv = items.find((x) => /INVERTER/i.test(x.deviceType || "")) || items[0];
    if (!inv) throw new Error("Trạm chưa có inverter trên Solarman");
    const cur = await post(creds, token, "/device/v1.0/currentData", { deviceSn: inv.deviceSn });
    let bms = null;
    const bmsDev = items.find((x) => /BMS|BATTERY/i.test(x.deviceType || ""));
    if (bmsDev) { try { bms = await post(creds, token, "/device/v1.0/currentData", { deviceSn: bmsDev.deviceSn }); } catch {} }
    const list = [...(cur.dataList || []), ...((bms?.dataList || []).map((x) => ({ ...x, group: "BMS" })))];
    return { list, serial: inv.deviceSn, time: cur.collectionTime, token: fresh };
  },

  // MỚI (07/11/2026): cảnh báo theo thiết bị — /device/v1.0/alertList (giây, 7 ngày)
  async fetchAlarms(creds, cached, stationIds, diag = []) {
    const { token, fresh } = await getToken(creds, cached);
    const end = Math.floor(Date.now() / 1000), start = end - 7 * 86400;
    const out = [];
    for (const id of stationIds) {
      let dev;
      try { dev = await post(creds, token, "/station/v1.0/device", { stationId: Number(id) }); } catch (e) { diag.push(`${id}: ${String(e.message || e).slice(0, 160)}`); continue; }
      for (const d of (dev.deviceListItems || []).filter((x) => /INVERTER/i.test(x.deviceType || "")).slice(0, 5)) {
        const r = await post(creds, token, "/device/v1.0/alertList", { deviceSn: d.deviceSn, startTimestamp: start, endTimestamp: end, page: 1, size: 50 });
        for (const a of r.alertList || r.list || []) {
          const lv = num(a.level);
          out.push(alarm({
            ext_id: id, code: a.alertCode ?? a.alertId, message: a.alertName || a.alertNameInPAAS || a.alertCode, advice: a.solution,
            level: lv >= 2 ? "fault" : lv === 0 ? "info" : "warning", device_sn: d.deviceSn,
            start: a.alertTime ?? a.startTime, end: num(a.endTime) ? a.endTime : null,
          }));
        }
      }
    }
    return { alarms: out, token: fresh };
  },
};
