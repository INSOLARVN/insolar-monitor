// Giả lập API cho bản xem trước (chạy toàn bộ bộ giải mã thật trên dữ liệu inverter mô phỏng)
import { prepare, decode, settingsSchema, encodeWrite, profileList } from "../src/lib/modbus-profile.js";
import { fromModbus, mergeBattery, summary } from "../src/lib/canonical.js";
import { simulateRegisters, simulateCan, simulateJbd, scenario } from "../src/lib/simulator.js";
import { decodeCan } from "../src/lib/can.js";
import { decodeJbd } from "../src/lib/bms.js";

// SỬA (31/10/2026): dùng giờ thật Việt Nam; thanh "giờ mô phỏng" chỉ có ở bản xem thử để xem mặt trời/mặt trăng chạy
const HOUR = (Date.now() / 3600e3 + 7) % 24;
window.__PREVIEW__ = true;
setInterval(() => {
  const on = !!document.querySelector(".scene.full");
  let bar = document.getElementById("pvHour");
  if (!on) { if (bar) bar.style.display = "none"; return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "pvHour";
    bar.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(86px + env(safe-area-inset-bottom));z-index:40;display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:16px;background:rgba(14,16,22,.82);color:#fff;font:600 12px Inter,system-ui;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)";
    bar.innerHTML = '<span id="pvHourT" style="min-width:42px">--:--</span><input id="pvHourR" type="range" min="0" max="23.95" step="0.05" style="flex:1"><button id="pvHourN" style="border:0;border-radius:10px;padding:5px 9px;background:#2563eb;color:#fff;font:inherit">Giờ thật</button><select id="pvWx" style="border:0;border-radius:10px;padding:5px 6px;background:#1f2937;color:#fff;font:inherit"><option value="sun">Nắng</option><option value="cloud">Mây</option><option value="rain">Mưa</option><option value="storm">Dông</option></select>';
    document.body.appendChild(bar);
    const R = bar.querySelector("#pvHourR");
    R.oninput = () => { window.__HOUR = Number(R.value); window.__insRedraw?.(); };
    bar.querySelector("#pvHourN").onclick = () => { delete window.__HOUR; window.__insRedraw?.(); };
    const X = bar.querySelector("#pvWx"); X.value = window.__WX;
    X.onchange = async () => { window.__WX = X.value; try { await loadDetail(); } catch {} window.__insRedraw?.(); };
  }
  bar.style.display = "flex";
  const h = window.__HOUR ?? (Date.now() / 3600e3 + 7) % 24, R = bar.querySelector("#pvHourR");
  if (document.activeElement !== R) R.value = h;
  bar.querySelector("#pvHourT").textContent = String(Math.floor(h)).padStart(2, "0") + ":" + String(Math.floor((h % 1) * 60)).padStart(2, "0");
}, 300);
try { if (!location.hash) location.hash = "#/login"; } catch {}
const ST = [
  { id: 1, name: "Nhà anh Hùng – Sầm Sơn", customer: "Anh Hùng", phone: "0912 345 678", kwp: 10, profile: "deye_hybrid", params: { mppt: 2, phase: 1, pack: 1 }, gw: true, bms: true },
  { id: 2, name: "Xưởng gỗ Minh Phát", customer: "Cty Minh Phát", kwp: 30, profile: "deye_p3", params: { mppt: 2, phase: 3, pack: 2 }, gw: true, bms: false },
  { id: 3, name: "Homestay Hải Tiến", customer: "", kwp: 15, profile: "deye_hybrid", params: { mppt: 2, phase: 1, pack: 1 }, gw: false, brand: "solarman" },
  { id: 4, name: "Nhà chị Lan – TP Thanh Hóa", customer: "Chị Lan", kwp: 8, profile: "srne_asf", params: { mppt: 2, phase: 1, pack: 1 }, gw: true, status: "offline" },
  { id: 5, name: "Kho lạnh Nghi Sơn", customer: "Cty Hải sản NS", kwp: 50, profile: "deye_p3", params: { mppt: 4, phase: 3, pack: 4 }, gw: false, brand: "solis" },
];
const regsById = {}, scById = {};
for (const s of ST) {
  const r = simulateRegisters(s.profile, s.params, { hour: HOUR, kwp: s.kwp, rated: s.kwp >= 15 ? 12000 : 8000 });
  regsById[s.id] = r.regs; scById[s.id] = r.scenario;
}
const log = [];
function detail(s) {
  const prep = prepare(s.profile, s.params);
  const dec = decode(prep, regsById[s.id]);
  const d = fromModbus(dec, s.profile, {});
  mergeBattery(d, s.gw ? decodeCan(simulateCan(scById[s.id])) : null, s.bms ? decodeJbd(simulateJbd(scById[s.id])) : null);
  const byKey = new Map(dec.map((x) => [x.key, x.value]));
  d.settings = settingsSchema(prep).map((x) => ({ ...x, value: byKey.get(x.key) ?? null }));
  d.settings_enabled = !!s.gw;
  if (!s.gw) d.settings_note = "Trạm lấy dữ liệu qua cloud của hãng. Lắp gateway INSOLAR để cài đặt từ xa.";
  d.device.profile_label = prep.label; d.device.manufacturer = prep.manufacturer;
  d.source = s.gw ? "gateway" : s.brand;
  if (s.gw) d.gateway = { id: "gw_" + (100000 + s.id * 7919).toString(36), fw: "1.0.0", rssi: -61, transport: "rs485" };
  d.updated = new Date(Date.now() - 20e3).toISOString();
  return d;
}
// Thời tiết giả lập cho bản xem thử (máy chủ thật lấy từ Open-Meteo theo toạ độ trạm)
const WX_PRESET = { sun: { code: 0, cloud: 8, rad: 820, f: 1 }, cloud: { code: 3, cloud: 92, rad: 210, f: 0.24 }, rain: { code: 63, cloud: 100, rad: 70, f: 0.08 }, storm: { code: 95, cloud: 100, rad: 25, f: 0.03 } };
window.__WX = "cloud";
function mockWeather() {
  const p = WX_PRESET[window.__WX] || WX_PRESET.sun, h = window.__HOUR ?? (Date.now() / 3600e3 + 7) % 24, day = h > 6 && h < 18;
  return { code: p.code, cloud: p.cloud, rain: p.code >= 61 ? 2.4 : 0, radiation: day ? Math.round(p.rad * Math.max(0, Math.sin(((h - 6) / 12) * Math.PI))) : 0, temp: p.code >= 61 ? 23 : 29, is_day: day ? 1 : 0, approx: true };
}
// Trời mây/mưa → PV phát ít: thu nhỏ số liệu PV, phần thiếu lấy từ lưới
function wxScale(d) {
  const f = (WX_PRESET[window.__WX] || WX_PRESET.sun).f;
  if (f === 1 || typeof d.pv.power !== "number") return d;
  const old = d.pv.power;
  d.pv.power = Math.round(old * f);
  for (const st of d.pv.strings) { if (typeof st.w === "number") st.w = Math.round(st.w * f); if (typeof st.a === "number") st.a = +(st.a * f).toFixed(1); }
  if (typeof d.grid.power === "number") d.grid.power = Math.round(d.grid.power + (old - d.pv.power));
  return d;
}
function row(s) {
  const d = detail(s), m = summary(d);
  return { id: s.id, brand: s.gw ? s.profile.split("_")[0] : s.brand, name: s.name, customer: s.customer, phone: s.phone || "", note: "", address: "Thanh Hóa",
    capacity_kwp: s.kwp, status: s.status || (s.id === 5 ? "alarm" : "online"), ...m, data_time: new Date(Date.now() - 60e3).toISOString(),
    synced_at: new Date().toISOString(), share_token: null, gateway_id: s.gw ? d.gateway.id : null, account_label: s.gw ? "Gateway INSOLAR" : "Cloud" };
}
function dayPoints(s) {
  const out = [];
  for (let m = 0; m <= HOUR * 60; m += 10) {
    const sc = scenario(m / 60, s.kwp, 1);
    out.push({ ts: new Date(Date.UTC(2026, 9, 30, 17, 0) + m * 60e3).toISOString(), pv: sc.pv, load: sc.load, bat: sc.bat, grid: sc.grid, soc: sc.soc, today_kwh: sc.pvToday });
  }
  return out;
}
function bars(s, range) {
  const n = range === "month" ? 31 : 12, out = [];
  for (let i = 1; i <= (range === "month" ? 30 : 10); i++) {
    const k = range === "month" ? 1 : 30;
    const r = (x) => +(x * k * (0.8 + Math.abs(Math.sin(i * 2.3)) * 0.4)).toFixed(1);
    out.push({ label: String(i).padStart(2, "0"), pv: r(s.kwp * 4.2), load: r(s.kwp * 3.1), imp: r(s.kwp * 0.4), exp: r(s.kwp * 0.3), chg: r(s.kwp * 1.1), dis: r(s.kwp * 1.0) });
  }
  void n;
  return out;
}
const R = (d) => Promise.resolve(JSON.parse(JSON.stringify(d)));
window.__mock = async (path, opt = {}) => {
  const method = (opt.method || "GET").toUpperCase();
  const u = new URL(path, "https://x");
  const p = u.pathname;
  await new Promise((r) => setTimeout(r, 120));
  if (p === "/api/login" || p === "/api/logout" || p === "/api/sync-all") return R({ ok: true });
  // Tài khoản (bản xem thử)
  const ME = { id: 1, name: "Chủ hệ thống", email: "insolarvn@gmail.com", phone: "0912345678", role: "owner", google: false, apple: false, has_pw: true };
  if (p === "/api/auth/login" || p === "/api/auth/reset") return R({ ok: true, user: ME });
  if (p === "/api/auth/forgot") return R({ ok: true, hint: "i********n@gmail.com" });
  if (p === "/api/auth/config") return R({ google_client_id: null, apple_service_id: null, email_reset: true });
  if (p === "/api/me") return R({ ok: true, user: ME, recovery_left: 0, email_reset: true });
  if (p.startsWith("/api/me/")) return R(p.endsWith("recovery") ? { ok: true, codes: ["K7QX-3MPA", "T9ZC-8WLE", "H2RN-6VDB", "Y4FS-9JQK", "M8PA-2XTC", "C3WE-7NRH", "R6LD-4BZY", "P5UG-8KMS"] } : { ok: true });
  if (p === "/api/users" && (opt.method || "GET") === "GET") return R([ME, { id: 2, name: "Kỹ thuật Tuấn", email: null, phone: "0987654321", role: "staff" }]);
  if (p.startsWith("/api/users") || p.startsWith("/api/auth-config")) return R((opt.method || "GET") === "GET" ? { google_client_id: null, apple_service_id: null, mail: null } : { ok: true, to: ME.email });
  if (p === "/api/stations") return R(ST.map(row));
  if (p === "/api/profiles") return R(profileList());
  if (p === "/api/brands") return R([{ brand: "solarman", label: "Solarman (Deye, SRNE… gắn logger Solarman)", help: "Gửi email service@solarmanpv.com xin quyền OpenAPI.", fields: [{ key: "app_id", label: "App ID" }, { key: "app_secret", label: "App Secret", type: "password" }] }]);
  if (p === "/api/accounts") return R([{ id: 1, brand: "solarman", label: "Solarman – tài khoản công ty", enabled: 1, last_sync: new Date().toISOString(), station_count: 1 }, { id: 2, brand: "solis", label: "SolisCloud", enabled: 1, last_sync: new Date().toISOString(), station_count: 1 }]);
  if (p === "/api/gateways") return R(ST.filter((s) => s.gw).map((s) => ({ id: detail(s).gateway.id, name: s.name, profile: s.profile, params: JSON.stringify(s.params), transport: "rs485", slave: 1, poll: 10, can_enabled: 1, bms_kind: s.bms ? "jbd" : null, allow_write: 1, station_id: s.id, last_seen: s.status === "offline" ? new Date(Date.now() - 864e5).toISOString() : new Date().toISOString(), fw: "1.0.0", rssi: -61 })));
  const m = p.match(/^\/api\/stations\/(\d+)(?:\/(\w+))?$/);
  if (m) {
    const s = ST.find((x) => x.id === Number(m[1]));
    if (!m[2]) return R(row(s));
    if (m[2] === "detail") return R({ online: s.status !== "offline", detail: wxScale(detail(s)), weather: mockWeather() });
    if (m[2] === "history") { const range = u.searchParams.get("range"); return R(range === "day" ? { range, date: u.searchParams.get("date"), points: dayPoints(s) } : { range, date: u.searchParams.get("date"), bars: bars(s, range) }); }
    if (m[2] === "commands") return R(log.filter((c) => c.station_id === s.id).slice().reverse());
    if (m[2] === "settings") {
      const b = JSON.parse(opt.body);
      const prep = prepare(s.profile, s.params);
      try {
        const w = encodeWrite(prep, b.key, b.value, regsById[s.id]);
        w.values.forEach((v, i) => (regsById[s.id][3][w.addr + i] = v));
        log.push({ station_id: s.id, name: w.name, value: String(b.value), status: "ok", created_at: new Date().toISOString() });
        return R({ ok: true, name: w.name });
      } catch (e) { throw new Error(e.message); }
    }
    if (m[2] === "raw") { const b = JSON.parse(opt.body); const vals = []; for (let a = b.addr; a < b.addr + (b.count || 1); a++) vals.push(regsById[s.id][b.fc]?.[a] ?? 0); return R({ ok: true, values: vals }); }
    if (m[2] === "share") return R({ share_token: "xem-truoc-chua-tao-link" });
    return R({ ok: true });
  }
  return R({ ok: true });
};
