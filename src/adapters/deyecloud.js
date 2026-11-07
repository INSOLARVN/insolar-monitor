// Deye Cloud OpenAPI v1.0 — tạo app tại developer.deyecloud.com để lấy appId/appSecret
import { sha256Hex } from "../crypto.js";
import { fetchJson, station, num, isoFromAny, vnDate, statusFromTime, alarm } from "./util.js";

const base = (c) => (c.api_url || "https://eu1-developer.deyecloud.com/v1.0").replace(/\/$/, "");

async function getToken(creds, cached) {
  if (cached?.token && cached.exp > Date.now() + 3600e3) return { token: cached.token, fresh: null };
  const pw = /^[a-f0-9]{64}$/.test(creds.password) ? creds.password : await sha256Hex(creds.password);
  const body = { appSecret: creds.app_secret, password: pw };
  if (creds.username.includes("@")) body.email = creds.username;
  else { body.mobile = creds.username; body.countryCode = "84"; }
  if (creds.company_id) body.companyId = creds.company_id;
  const res = await fetchJson(`${base(creds)}/account/token?appId=${encodeURIComponent(creds.app_id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const token = res.accessToken || res.data?.accessToken;
  if (!token) throw new Error(`Deye Cloud: ${res.msg || "không lấy được token"}`);
  const exp = Date.now() + (num(res.expiresIn || res.data?.expiresIn) || 5184000) * 1000;
  return { token, fresh: { token, exp } };
}

// Mã trả về thành công của Deye Cloud (bảng mã trên cổng developer)
const OK_CODES = new Set([0, 1000000, 1106000]);
const NO_PERMISSION = new Set([2101027, 2101042]);
const BUSY = new Set([2104004]);
const OFFLINE = new Set([2104006]);

async function call(creds, token, method, path, body) {
  const url = `${base(creds)}${path}`;
  const res = await fetchJson(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  const code = res.code !== undefined && res.code !== null ? Number(res.code) : null;
  if (res.success === false || (code !== null && !Number.isNaN(code) && !OK_CODES.has(code))) {
    if (NO_PERMISSION.has(code)) throw new Error("Tài khoản chưa được Deye cấp quyền điều khiển thiết bị này (bật trong Deye Cloud → thiết bị → quyền điều khiển).");
    if (BUSY.has(code)) throw new Error("Biến tần đang xử lý lệnh khác, thử lại sau ít giây.");
    if (OFFLINE.has(code)) throw new Error("Biến tần đang ngoại tuyến trên Deye Cloud.");
    throw new Error(`Deye ${path}: ${res.msg || code}`);
  }
  // Một số API để dữ liệu trong "data", số khác để ở gốc
  return res.data && typeof res.data === "object" && !Array.isArray(res.data) ? { ...res, ...res.data } : res;
}
const post = (creds, token, path, body) => call(creds, token, "POST", path, body);

// SỬA (31/10/2026): trước đây nuốt hết lỗi và chỉ nhận đúng loại "INVERTER" → báo "không tìm thấy inverter".
// Nay: ưu tiên INVERTER, sau đó các loại biến tần/lưu trữ khác (trừ bộ thu thập, đồng hồ…), và ghi lại lỗi/loại thiết bị để báo rõ.
const INV_PREF = [/^INVERTER$/i, /INVERTER|STORAGE|PCS|HYBRID/i];
const NOT_INV = /COLLECTOR|DTU|METER|BATTERY|RELAY|WEATHER|OPTIMIZER|PV_MODULE/i;
async function inverterSns(creds, token, stationId, diag = []) {
  // SỬA (31/10/2026): station/device hay lỗi 500 → thử 1 lần rồi chuyển sang listWithDevice (tối đa 50/trang, duyệt tới khi gặp trạm).
  // Tổng số trạm của listWithDevice nằm ở "stationTotal" (không phải "total").
  const pick = (list) => {
    for (const re of INV_PREF) {
      const sns = list.filter((x) => x.deviceSn && re.test(String(x.deviceType || "INVERTER"))).map((x) => x.deviceSn);
      if (sns.length) return sns;
    }
    return list.filter((x) => x.deviceSn && !NOT_INV.test(String(x.deviceType || ""))).map((x) => x.deviceSn);
  };
  const types = (list) => [...new Set(list.map((x) => x.deviceType))].join(",") || "-";
  try {
    const r = await post(creds, token, "/station/device", { stationIds: [Number(stationId)], page: 1, size: 20 });
    const list = r.deviceListItems || [];
    diag.push(`/station/device: ${list.length} thiết bị [${types(list)}]`);
    const sns = pick(list);
    if (sns.length) return sns;
  } catch (e) { diag.push(`/station/device: ${e.message}`); }
  try {
    for (let page = 1; page <= 40; page++) {
      const r = await post(creds, token, "/station/listWithDevice", { page, size: 50 });
      const sts = r.stationList || [];
      const mine = sts.find((s) => String(s.id) === String(stationId));
      if (mine) {
        const list = mine.deviceListItems || [];
        diag.push(`/station/listWithDevice: ${list.length} thiết bị [${types(list)}]`);
        return pick(list);
      }
      if (sts.length < 50 || page * 50 >= (Number(r.stationTotal) || 0)) { diag.push(`/station/listWithDevice: không thấy trạm ${stationId} trong ${page} trang`); break; }
    }
  } catch (e) { diag.push(`/station/listWithDevice: ${e.message}`); }
  return [];
}

// ---------- Cài đặt từ xa qua Deye Cloud (lệnh "order" bất đồng bộ) ----------
// Tham khảo: github.com/maxbanton/hass-deye-cloud (MIT) — các endpoint /order/* và /config/*.
const WORK = { SELLING_FIRST: "Export First", ZERO_EXPORT_TO_LOAD: "Zero Export To Load", ZERO_EXPORT_TO_CT: "Zero Export To CT" };
const PATTERN = { LOAD_FIRST: "Load First", BATTERY_FIRST: "Battery First" };
const rev = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
const CHG_OPTS = ["Disabled", "Grid", "Generator", "Both"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = (v) => { const s = String(v ?? "").trim(); if (s.includes(":")) { const [h, m] = s.split(":"); return `${String(+h).padStart(2, "0")}:${String(+m || 0).padStart(2, "0")}`; } const d = s.padStart(4, "0"); return `${d.slice(0, 2)}:${d.slice(2, 4)}`; };

async function readConfig(creds, token, sn) {
  const get = async (path) => { try { return await post(creds, token, path, { deviceSn: sn }); } catch { return {}; } };
  const [sys, bat, tou] = await Promise.all([get("/config/system"), get("/config/battery"), get("/config/tou")]);
  return { sys, bat, tou };
}

function settingsFrom(cfg) {
  const { sys, bat, tou } = cfg, out = [];
  const add = (o) => out.push({ group: "Settings", uom: null, ...o });
  if (sys.systemWorkMode !== undefined) add({ key: "work_mode", name: "Work Mode", group: "Work Mode", platform: "select", options: Object.values(WORK), value: WORK[sys.systemWorkMode] ?? sys.systemWorkMode });
  if (sys.energyPattern !== undefined) add({ key: "energy_pattern", name: "Energy Pattern", group: "Work Mode", platform: "select", options: Object.values(PATTERN), value: PATTERN[sys.energyPattern] ?? sys.energyPattern });
  add({ key: "solar_sell", name: "Export Surplus", group: "Work Mode", platform: "switch", on: 1, off: 0, bit: null, value: sys.solarSellAction === undefined ? null : /on|true|1/i.test(String(sys.solarSellAction)) ? 1 : 0 });
  add({ key: "max_sell_power", name: "Export Surplus Power", group: "Work Mode", platform: "number", uom: "W", min: 0, max: 30000, step: 100, value: num(sys.maxSellPower) });
  add({ key: "max_charge", name: "Battery Max Charging Current", platform: "number", uom: "A", min: 0, max: 240, step: 1, value: num(bat.maxChargeCurrent) });
  add({ key: "max_discharge", name: "Battery Max Discharging Current", platform: "number", uom: "A", min: 0, max: 240, step: 1, value: num(bat.maxDischargeCurrent) });
  add({ key: "grid_charge_a", name: "Battery Grid Charging Current", platform: "number", uom: "A", min: 0, max: 240, step: 1, value: num(bat.gridChargeAmpere) });
  add({ key: "batt_low", name: "Battery Low SOC", platform: "number", uom: "%", min: 5, max: 100, step: 1, value: num(bat.battLowCapacity) });
  const items = tou.timeUseSettingItems || [];
  if (items.length) {
    add({ key: "tou_switch", name: "Time of Use", group: "Work Mode", platform: "switch", on: 1, off: 0, bit: null, value: tou.touAction === undefined ? null : /on|true|1/i.test(String(tou.touAction)) ? 1 : 0 });
    items.slice(0, 6).forEach((it, i) => {
      const n = i + 1, g = "Work Mode";
      add({ key: `tou_${n}_time`, name: `Program ${n} Time`, group: g, platform: "time", value: hhmm(it.time) });
      add({ key: `tou_${n}_power`, name: `Program ${n} Power`, group: g, platform: "number", uom: "W", min: 0, max: 30000, step: 100, value: num(it.power) });
      add({ key: `tou_${n}_soc`, name: `Program ${n} SOC`, group: g, platform: "number", uom: "%", min: 0, max: 100, step: 1, value: num(it.soc) });
      const gc = !!it.enableGridCharge, gen = !!it.enableGeneration;
      add({ key: `tou_${n}_chg`, name: `Program ${n} Charging`, group: g, platform: "select", options: CHG_OPTS, value: gc && gen ? "Both" : gc ? "Grid" : gen ? "Generator" : "Disabled" });
    });
  }
  return out;
}

async function order(creds, token, path, body) {
  const r = await post(creds, token, path, body);
  const id = r.orderId;
  if (!id) return;
  const end = Date.now() + 28000;
  while (Date.now() < end) {
    await sleep(2000);
    const st = await call(creds, token, "GET", `/order/${id}`);
    const status = Number(st.status);
    if (status === 666) return;
    // MỚI (31/10/2026): mã lỗi theo tài liệu OrderRecordResponse.error
    const ERR = { 501: "lệnh xung đột", 502: "sai loại sản phẩm", 505: "lỗi hệ thống", 510: "lỗi phân tích lệnh", 511: "phiên bản không hợp lệ", 530: "lệnh thất bại", 573: "không giao tiếp được với thiết bị" };
    if (![0, 100].includes(status)) throw new Error(`Biến tần từ chối lệnh (trạng thái ${st.status}${st.error ? `, ${ERR[st.error] || "mã " + st.error}` : ""})`);
  }
  throw new Error("Biến tần chưa xác nhận lệnh sau 28 giây — kiểm tra lại sau.");
}

export default {
  brand: "deyecloud",
  label: "Deye Cloud",
  fields: [
    { key: "app_id", label: "App ID" },
    { key: "app_secret", label: "App Secret", type: "password" },
    { key: "username", label: "Email / SĐT Deye Cloud" },
    { key: "password", label: "Mật khẩu Deye Cloud", type: "password" },
    { key: "company_id", label: "Company ID (tài khoản doanh nghiệp)", optional: true },
    { key: "api_url", label: "API URL", placeholder: "https://eu1-developer.deyecloud.com/v1.0", optional: true },
  ],
  help: "Đăng ký tại developer.deyecloud.com → tạo Application → lấy App ID, App Secret. Tài khoản Châu Á thường dùng máy chủ eu1.",

  async fetchStations(creds, cached) {
    const { token, fresh } = await getToken(creds, cached);
    const list = [];
    for (let page = 1; page <= 20; page++) {
      const r = await post(creds, token, "/station/list", { page, size: 100 });
      list.push(...(r.stationList || []));
      if ((r.stationList || []).length < 100) break;
    }
    // SỬA (31/10/2026): theo tài liệu Deye, station/history granularity=2 loại trừ endAt → phải đặt endAt = ngày mai
    // (trước đây startAt=endAt=hôm nay nên có thể trả rỗng → điện hôm nay = 0)
    const today = vnDate();
    const tomorrow = vnDate(new Date(Date.now() + 86400e3));
    const out = [];
    for (const s of list) {
      let lt = {}, day = {};
      try { lt = await post(creds, token, "/station/latest", { stationId: s.id }); } catch {}
      try {
        const h = await post(creds, token, "/station/history", { stationId: s.id, granularity: 2, startAt: today, endAt: tomorrow });
        day = (h.stationDataItems || [])[0] || {};
      } catch {}
      const t = isoFromAny(lt.lastUpdateTime || s.lastUpdateTime);
      const conn = String(s.connectionStatus || "").toUpperCase();
      let status = conn === "ALL_OFFLINE" || conn === "OFFLINE" ? "offline" : statusFromTime(t);
      if (/ALARM|FAULT|ERROR/.test(conn)) status = "alarm";
      out.push(station({
        ext_id: s.id,
        name: s.name,
        address: s.locationAddress, lat: s.locationLat, lon: s.locationLng,
        capacity_kwp: s.installedCapacity,
        status,
        pv_power_w: lt.generationPower ?? s.generationPower,
        load_power_w: lt.consumptionPower,
        grid_power_w: lt.gridPower ?? lt.wirePower,
        battery_soc: lt.batterySOC ?? s.batterySOC,
        battery_power_w: num(lt.dischargePower) !== null || num(lt.chargePower) !== null ? (num(lt.dischargePower) || 0) - (num(lt.chargePower) || 0) : null,
        today_kwh: day.generationValue,
        total_kwh: lt.generationTotal,
        data_time: t,
      }));
    }
    return { stations: out, token: fresh };
  },

  async fetchDetail(creds, cached, stationId) {
    const { token, fresh } = await getToken(creds, cached);
    const diag = [];
    const sns = await inverterSns(creds, token, stationId, diag);
    if (!sns.length) throw new Error(`Không tìm thấy inverter của trạm trên Deye Cloud (${diag.join(" | ")})`);
    const r = await post(creds, token, "/device/latest", { deviceList: sns.slice(0, 1) });
    const dd = (r.deviceDataList || [])[0] || {};
    const human = (k) => String(k).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/(\D)(\d)/g, "$1$2");
    const list = (dd.dataList || []).map((x) => ({ key: x.key, name: human(x.key), value: x.value, unit: x.unit }));
    const sn = dd.deviceSn || sns[0];
    let settings = null, settingsError = null;
    try { settings = settingsFrom(await readConfig(creds, token, sn)); } catch (e) { settingsError = e.message; }
    return { list, serial: sn, time: dd.collectionTime, token: fresh, settings, settingsError };
  },

  // MỚI (31/10/2026): lịch sử lấy thẳng từ Deye Cloud (station/history) — không phải đợi app tự tích luỹ.
  // ngày: granularity 1 (theo khung công suất); tháng: granularity 2 (từng ngày); năm: granularity 3 (từng tháng). endAt bị loại trừ.
  async fetchHistory(creds, cached, stationId, range, date) {
    const { token, fresh } = await getToken(creds, cached);
    const id = Number(stationId);
    const addDays = (d, k) => vnDate(new Date(new Date(d + "T00:00:00+07:00").getTime() + k * 86400e3));
    const bar = (it, label, day) => ({ label, day, pv: num(it.generationValue), load: num(it.consumptionValue), imp: num(it.purchaseValue), exp: num(it.gridValue), chg: num(it.chargeValue), dis: num(it.dischargeValue) });
    if (range === "month") {
      const from = date.slice(0, 7) + "-01";
      const nm = new Date(from + "T00:00:00Z"); nm.setUTCMonth(nm.getUTCMonth() + 1);
      const to = nm.toISOString().slice(0, 10);
      const h = await post(creds, token, "/station/history", { stationId: id, granularity: 2, startAt: from, endAt: to });
      const bars = (h.stationDataItems || []).map((it, i) => { const dd = /^\d{4}-\d{2}-\d{2}/.test(String(it.timeStamp)) ? String(it.timeStamp).slice(0, 10) : addDays(from, i); return bar(it, dd.slice(8), dd); });
      return { bars, token: fresh };
    }
    if (range === "year") {
      const y = Number(date.slice(0, 4));
      const h = await post(creds, token, "/station/history", { stationId: id, granularity: 3, startAt: `${y}-01`, endAt: `${y + 1}-01` });
      const bars = (h.stationDataItems || []).slice(0, 12).map((it, i) => bar(it, String(i + 1).padStart(2, "0")));
      return { bars, token: fresh };
    }
    const h = await post(creds, token, "/station/history", { stationId: id, granularity: 1, startAt: date });
    const points = (h.stationDataItems || []).map((it) => {
      const ts = isoFromAny(it.timeStamp);
      const pv = num(it.generationPower), load = num(it.consumptionPower);
      const grid = num(it.gridPower) ?? num(it.wirePower);
      const bat = num(it.dischargePower) !== null || num(it.chargePower) !== null ? (num(it.dischargePower) || 0) - (num(it.chargePower) || 0) : num(it.batteryPower);
      return { ts, pv, load, grid, bat, soc: num(it.batterySOC), today_kwh: null };
    }).filter((x) => x.ts && (x.pv !== null || x.load !== null)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    return { points, token: fresh };
  },

  // Ghi 1 cài đặt. cur = danh sách cài đặt đang hiển thị (để lấy giá trị cũ khi ghi lịch TOU)
  async writeSetting(creds, cached, stationId, key, value) {
    const { token } = await getToken(creds, cached);
    const sn = (await inverterSns(creds, token, stationId))[0];
    if (!sn) throw new Error("Không tìm thấy inverter của trạm trên Deye Cloud");
    const n = Number(value);
    const needNum = (min, max) => { if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Giá trị phải từ ${min} đến ${max}`); return Math.round(n); };
    const onOff = value === true || value === "on" || value === 1 ? "on" : "off";
    let m;
    if (key === "work_mode") { const v = rev(WORK)[value]; if (!v) throw new Error("Chế độ không hợp lệ"); return order(creds, token, "/order/sys/workMode/update", { deviceSn: sn, workMode: v }); }
    if (key === "energy_pattern") { const v = rev(PATTERN)[value]; if (!v) throw new Error("Lựa chọn không hợp lệ"); return order(creds, token, "/order/sys/energyPattern/update", { deviceSn: sn, energyPattern: v }); }
    if (key === "solar_sell") return order(creds, token, "/order/sys/solarSell/control", { deviceSn: sn, action: onOff });
    if (key === "max_sell_power") return order(creds, token, "/order/sys/power/update", { deviceSn: sn, powerType: "MAX_SELL_POWER", value: needNum(0, 30000) });
    const BAT = { max_charge: ["MAX_CHARGE_CURRENT", 0, 240], max_discharge: ["MAX_DISCHARGE_CURRENT", 0, 240], grid_charge_a: ["GRID_CHARGE_AMPERE", 0, 240], batt_low: ["BATT_LOW", 5, 100] };
    if (BAT[key]) return order(creds, token, "/order/battery/parameter/update", { deviceSn: sn, paramterType: BAT[key][0], value: needNum(BAT[key][1], BAT[key][2]) });
    if (key === "tou_switch") return order(creds, token, "/order/sys/tou/switch", { deviceSn: sn, action: onOff });
    if ((m = key.match(/^tou_(\d)_(time|power|soc|chg)$/))) {
      // Lịch TOU phải gửi đủ 6 mốc: đọc lịch hiện tại rồi sửa đúng 1 ô
      const cfg = await post(creds, token, "/config/tou", { deviceSn: sn });
      const items = (cfg.timeUseSettingItems || []).map((it) => ({ time: hhmm(it.time), power: num(it.power) ?? 0, soc: num(it.soc) ?? 0, voltage: num(it.voltage) ?? 0, enableGridCharge: !!it.enableGridCharge, enableGeneration: !!it.enableGeneration }));
      const it = items[Number(m[1]) - 1];
      if (!it) throw new Error("Không đọc được lịch sạc xả hiện tại");
      if (m[2] === "time") { if (!/^\d{1,2}:\d{2}$/.test(String(value))) throw new Error("Giờ phải dạng HH:MM"); it.time = hhmm(value); }
      if (m[2] === "power") it.power = needNum(0, 30000);
      if (m[2] === "soc") it.soc = needNum(0, 100);
      if (m[2] === "chg") { if (!CHG_OPTS.includes(value)) throw new Error("Lựa chọn không hợp lệ"); it.enableGridCharge = value === "Grid" || value === "Both"; it.enableGeneration = value === "Generator" || value === "Both"; }
      return order(creds, token, "/order/sys/tou/update", { deviceSn: sn, timeUseSettingItems: items });
    }
    throw new Error("Cài đặt này chưa hỗ trợ qua Deye Cloud");
  },

  // MỚI (07/11/2026): cảnh báo/lỗi của trạm giống tab "Cảnh báo" trên Deye Cloud — POST /station/alertList (giây, 7 ngày gần nhất)
  // SỬA (07/11/2026): lỗi từng trạm không làm hỏng cả lượt; ghi chẩn đoán (diag) để biết vì sao rỗng
  async fetchAlarms(creds, cached, stationIds, diag = []) {
    const { token, fresh } = await getToken(creds, cached);
    const end = Math.floor(Date.now() / 1000), start = end - 7 * 86400;
    const out = [];
    for (const id of stationIds) {
      try {
      for (let page = 1; page <= 5; page++) {
        const r = await post(creds, token, "/station/alertList", { stationId: Number(id), startTimestamp: start, endTimestamp: end, page, size: 50 });
        const items = r.list || r.stationAlertItems || r.alertList || r.alertListItems || r.items || [];
        if (diag.length < 3) diag.push(`${id}: ${items.length} mục, khoá [${Object.keys(r).join(",")}]${items[0] ? " mẫu " + JSON.stringify(items[0]).slice(0, 300) : ""}`);
        for (const a of items) {
          const name = String(a.alertName || a.alertMsg || a.alertCode || "");
          const lv = num(a.level);
          out.push(alarm({
            ext_id: id, code: a.alertCode ?? a.alertId ?? name, message: name.replace(/_/g, " "),
            level: /fault|err/i.test(name) || lv >= 3 ? "fault" : lv === 0 || /changed|notice/i.test(name) ? "info" : "warning",
            device_sn: a.deviceSn, start: a.alertStartTime ?? a.startTime, end: num(a.alertEndTime ?? a.endTime) ? (a.alertEndTime ?? a.endTime) : null,
          }));
        }
        if (items.length < 50) break;
      }
      } catch (e) { diag.push(`${id}: ${String(e.message || e).slice(0, 160)}`); }
    }
    return { alarms: out, token: fresh };
  },
};
