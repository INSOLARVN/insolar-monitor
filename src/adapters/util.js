import { balanceSigns } from "../lib/canonical.js";
export const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Đổi công suất về W dựa theo đơn vị hãng trả về
export function toW(v, unit) {
  const n = num(v);
  if (n === null) return null;
  const u = String(unit || "W").toLowerCase();
  if (u.startsWith("mw")) return n * 1e6;
  if (u.startsWith("kw")) return n * 1000;
  return n;
}

// Đổi năng lượng về kWh
export function toKWh(v, unit) {
  const n = num(v);
  if (n === null) return null;
  const u = String(unit || "kWh").toLowerCase();
  if (u.startsWith("gwh")) return n * 1e6;
  if (u.startsWith("mwh")) return n * 1000;
  if (u === "wh") return n / 1000;
  return n;
}

// Ngày hôm nay theo giờ Việt Nam: YYYY-MM-DD
export function vnDate(d = new Date()) {
  return new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
}

export function isoFromAny(t) {
  if (t === null || t === undefined || t === "") return null;
  if (typeof t === "number" || /^\d+$/.test(String(t))) {
    let n = Number(t);
    if (n < 1e12) n *= 1000; // giây -> ms
    return new Date(n).toISOString();
  }
  const d = new Date(String(t).replace(" ", "T") + (/[zZ+]/.test(String(t)) ? "" : "+07:00"));
  return isNaN(d) ? null : d.toISOString();
}

export async function fetchJson(url, init = {}, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`); }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${data.msg || data.message || text.slice(0, 200)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Mô hình trạm chuẩn hóa
export function station(o) {
  // MỚI (01/11/2026): tự sửa dấu pin/lưới nếu hãng trả ngược (kiểm tra PV + pin + lưới ≈ tải)
  const { sb, sg } = balanceSigns(o.pv_power_w, o.load_power_w, o.battery_power_w, o.grid_power_w);
  if (sb < 0) o = { ...o, battery_power_w: -num(o.battery_power_w) };
  if (sg < 0) o = { ...o, grid_power_w: -num(o.grid_power_w) };
  return {
    ext_id: String(o.ext_id),
    name: o.name || String(o.ext_id),
    address: o.address || null,
    lat: num(o.lat), lon: num(o.lon), // MỚI (31/10/2026): toạ độ để lấy thời tiết khu vực
    capacity_kwp: num(o.capacity_kwp),
    status: o.status || "offline",
    pv_power_w: num(o.pv_power_w),
    load_power_w: num(o.load_power_w),
    grid_power_w: num(o.grid_power_w),
    battery_soc: num(o.battery_soc),
    battery_power_w: num(o.battery_power_w), // MỚI (31/10/2026): công suất pin (+ = xả, − = sạc) để lịch sử có đường Pin
    today_kwh: num(o.today_kwh),
    total_kwh: num(o.total_kwh),
    data_time: o.data_time || null,
  };
}

// Nếu dữ liệu cũ hơn 30 phút thì coi như mất kết nối
export function statusFromTime(iso, fallback = "online") {
  if (!iso) return fallback;
  return Date.now() - new Date(iso).getTime() > 30 * 60e3 ? "offline" : fallback;
}
