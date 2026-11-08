// INSOLAR Monitor — giám sát & cài đặt điện mặt trời đa hãng
import { ADAPTERS, publicAdapterInfo } from "./adapters/index.js";
import { encrypt, decrypt, hmacB64, randomToken, safeEqual, sha256Hex } from "./crypto.js";
import { profileList, prepare, decode, settingsSchema } from "./lib/modbus-profile.js";
import { fromCloudList, fromModbus, mergeBattery, summary } from "./lib/canonical.js";
import { simulateRegisters, simulateCan, simulateJbd } from "./lib/simulator.js";
import { decodeCan } from "./lib/can.js";
import { decodeJbd } from "./lib/bms.js";
import UI_HTML from "./ui.html";
import FLASH_HTML from "./flash.html";
import FW_BIN from "../firmware/insolar-gw-full.bin";
import { ensureAuth, publicAuthRoutes, currentUser, userRoutes } from "./auth.js";

export { GatewayHub } from "./gateway-hub.js";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

const SEC_HEADERS = { "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };

// ---------- Phiên đăng nhập: xem src/auth.js (SỬA 31/10/2026 — nhiều người dùng) ----------

// ---------- Đồng bộ cloud ----------
const slot5 = () => new Date(Math.floor(Date.now() / 300e3) * 300e3).toISOString();

async function syncAccount(env, acc, opt = {}) {
  const adapter = ADAPTERS[acc.brand];
  if (!adapter) throw new Error("Không hỗ trợ hãng " + acc.brand);
  const creds = await decrypt(env.ENC_KEY, acc.creds_enc);
  const cached = acc.token_enc ? await decrypt(env.ENC_KEY, acc.token_enc).catch(() => null) : null;
  const now = new Date().toISOString();
  try {
    const { stations, token } = await adapter.fetchStations(creds, cached);
    const ts = slot5();
    const stmts = [];
    await ensureLatLon(env);
    for (const s of stations) {
      if (isNum(s.month_kwh) || isNum(s.year_kwh)) stmts.push(env.DB.prepare("UPDATE stations SET month_kwh=?3, year_kwh=?4, my_day=?5 WHERE account_id=?1 AND ext_id=?2").bind(acc.id, s.ext_id, s.month_kwh ?? null, s.year_kwh ?? null, vnToday()));
      if (isNum(s.lat) && isNum(s.lon) && (s.lat || s.lon)) stmts.push(env.DB.prepare("UPDATE stations SET lat=COALESCE(lat, ?3), lon=COALESCE(lon, ?4) WHERE account_id=?1 AND ext_id=?2").bind(acc.id, s.ext_id, s.lat, s.lon));
      stmts.push(env.DB.prepare(
        `INSERT INTO stations (account_id, brand, ext_id, name, address, capacity_kwp, status, pv_power_w, load_power_w, grid_power_w, battery_soc, today_kwh, total_kwh, data_time, synced_at, battery_power_w)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
         ON CONFLICT(account_id, ext_id) DO UPDATE SET
           name=excluded.name, address=COALESCE(excluded.address, stations.address),
           capacity_kwp=COALESCE(excluded.capacity_kwp, stations.capacity_kwp), status=excluded.status,
           pv_power_w=excluded.pv_power_w, load_power_w=excluded.load_power_w, grid_power_w=excluded.grid_power_w,
           battery_soc=excluded.battery_soc, battery_power_w=COALESCE(excluded.battery_power_w, stations.battery_power_w),
           today_kwh=excluded.today_kwh, total_kwh=COALESCE(excluded.total_kwh, stations.total_kwh),
           data_time=excluded.data_time, synced_at=excluded.synced_at`
      ).bind(acc.id, acc.brand, s.ext_id, s.name, s.address, s.capacity_kwp, s.status, s.pv_power_w, s.load_power_w,
        s.grid_power_w, s.battery_soc, s.today_kwh, s.total_kwh, s.data_time, now, s.battery_power_w ?? null));
      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO readings (station_id, ts, pv_power_w, load_power_w, grid_power_w, battery_power_w, battery_soc, today_kwh)
         SELECT id, ?3, ?4, ?5, ?6, ?7, ?8, ?9 FROM stations WHERE account_id=?1 AND ext_id=?2`
      ).bind(acc.id, s.ext_id, ts, s.pv_power_w, s.load_power_w, s.grid_power_w, s.battery_power_w ?? null, s.battery_soc, s.today_kwh));
    }
    stmts.push(env.DB.prepare("UPDATE accounts SET last_sync=?2, last_error=NULL, token_enc=COALESCE(?3, token_enc) WHERE id=?1")
      .bind(acc.id, now, token ? await encrypt(env.ENC_KEY, token) : null));
    for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
    // MỚI (07/11/2026): đồng bộ cảnh báo/lỗi của hãng — 15 phút/lần (hoặc khi bấm đồng bộ)
    let alarms = null;
    if (adapter.fetchAlarms && (opt.alarms || Math.floor(Date.now() / 300e3) % 3 === 0)) alarms = await syncAlarms(env, acc, creds, token || cached);
    return { ok: true, count: stations.length, alarms };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    // SỬA (07/11/2026): adapter giữ refresh token trong token_enc (Solarman Business) thì không xoá khi lỗi tạm thời
    await env.DB.prepare(`UPDATE accounts SET last_sync=?2, last_error=?3${adapter.keepToken ? "" : ", token_enc=NULL"} WHERE id=?1`).bind(acc.id, now, msg).run();
    return { ok: false, error: msg };
  }
}

// ---------- Cảnh báo / lỗi từ cloud hãng (MỚI 07/11/2026) ----------
// Mỗi adapter có fetchAlarms(creds, cached, extIds) → { alarms: [alarm()], token }. Đồng bộ 15 phút/lần (cron 5 phút, lấy 1/3 lượt).
let alarmsReady = false;
async function ensureAlarms(env) {
  if (alarmsReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS alarms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, station_id INTEGER NOT NULL, account_id INTEGER, brand TEXT,
    code TEXT, message TEXT, level TEXT, device_sn TEXT, advice TEXT,
    start_at TEXT, end_at TEXT, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT,
    UNIQUE(station_id, code, start_at))`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS alarms_active ON alarms(active, station_id)").run();
  await env.DB.prepare("ALTER TABLE accounts ADD COLUMN alarm_note TEXT").run().catch(() => {}); // MỚI (07/11/2026): chẩn đoán đồng bộ cảnh báo
  // MỚI (07/11/2026): giá bán điện từng trạm (đ/kWh) để tính tiền khai thác; NULL = dùng giá mặc định 3.870 đ/kWh
  await env.DB.prepare("ALTER TABLE stations ADD COLUMN price_kwh REAL").run().catch(() => {});
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS field_maps (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT NOT NULL,
    scope TEXT NOT NULL, scope_val TEXT, src TEXT NOT NULL, field TEXT NOT NULL, factor REAL, created_at TEXT DEFAULT (datetime('now')))`).run(); // MỚI (07/11/2026)
  alarmsReady = true;
}
const ALARM_MAX_STATIONS = 60; // giới hạn số trạm/lượt để không vượt số request của Worker

async function syncAlarms(env, acc, creds, token) {
  const ad = ADAPTERS[acc.brand];
  if (!ad?.fetchAlarms) return { ok: false, error: "Hãng này chưa hỗ trợ đồng bộ cảnh báo" };
  await ensureAlarms(env);
  const { results: sts } = await env.DB.prepare("SELECT id, ext_id FROM stations WHERE account_id=?1 ORDER BY id").bind(acc.id).all();
  if (!sts.length) return { ok: true, count: 0 };
  const byExt = new Map(sts.map((x) => [String(x.ext_id), x.id]));
  try {
    const diag = [];
    const r = await ad.fetchAlarms(creds, token, sts.slice(0, ALARM_MAX_STATIONS).map((x) => x.ext_id), diag);
    const now = new Date().toISOString();
    // Đánh dấu hết toàn bộ cảnh báo đang mở của tài khoản rồi bật lại những cái cloud còn trả về
    const stmts = [env.DB.prepare("UPDATE alarms SET active=0, end_at=COALESCE(end_at, ?2), updated_at=?2 WHERE account_id=?1 AND active=1").bind(acc.id, now)];
    let n = 0;
    for (const a of r.alarms || []) {
      const sid = byExt.get(String(a.ext_id));
      if (!sid) continue;
      n++;
      stmts.push(env.DB.prepare(
        `INSERT INTO alarms (station_id, account_id, brand, code, message, level, device_sn, advice, start_at, end_at, active, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(station_id, code, start_at) DO UPDATE SET message=excluded.message, level=excluded.level, advice=COALESCE(excluded.advice, alarms.advice),
           end_at=excluded.end_at, active=excluded.active, updated_at=excluded.updated_at`
      ).bind(sid, acc.id, acc.brand, a.code, a.message, a.level, a.device_sn, a.advice, a.start_at || "", a.end_at, a.active ? 1 : 0, now));
    }
    // Giữ lịch sử 90 ngày
    stmts.push(env.DB.prepare("DELETE FROM alarms WHERE active=0 AND COALESCE(end_at, updated_at) < ?1").bind(new Date(Date.now() - 90 * 86400e3).toISOString()));
    for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
    if (r.token) await env.DB.prepare("UPDATE accounts SET token_enc=?2 WHERE id=?1").bind(acc.id, await encrypt(env.ENC_KEY, r.token)).run();
    await env.DB.prepare("UPDATE accounts SET alarm_note=?2 WHERE id=?1").bind(acc.id, `${now} · ${n} cảnh báo · ${diag.join(" | ")}`.slice(0, 2000)).run();
    return { ok: true, count: n };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    await env.DB.prepare("UPDATE accounts SET alarm_note=?2 WHERE id=?1").bind(acc.id, `${new Date().toISOString()} · LỖI ${msg}`).run().catch(() => {});
    return { ok: false, error: msg };
  }
}

async function syncAll(env, opt = {}) {
  const { results } = await env.DB.prepare("SELECT * FROM accounts WHERE enabled=1").all();
  await Promise.allSettled(results.map((a) => syncAccount(env, a, opt)));
  const old = new Date(Date.now() - 10 * 60e3).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE stations SET status='offline' WHERE gateway_id IS NOT NULL AND status!='offline' AND (data_time IS NULL OR data_time < ?1)").bind(old),
    env.DB.prepare("DELETE FROM readings WHERE ts < ?1").bind(new Date(Date.now() - 400 * 86400e3).toISOString()),
  ]);
}

// ---------- Chi tiết ----------
const hub = (env, gwId) => env.GATEWAY.get(env.GATEWAY.idFromName(gwId));

function demoDetail(st) {
  const p3 = st.capacity_kwp >= 15;
  const profile = p3 ? "deye_p3" : "deye_hybrid";
  const params = p3 ? { mppt: 2, phase: 3, pack: 2 } : { mppt: 2, phase: 1, pack: 1 };
  const { regs, scenario } = simulateRegisters(profile, params, { kwp: st.capacity_kwp || 8, rated: p3 ? 12000 : 8000 });
  const prep = prepare(profile, params);
  const dec = decode(prep, regs);
  const d = fromModbus(dec, profile, {});
  mergeBattery(d, decodeCan(simulateCan(scenario)), decodeJbd(simulateJbd(scenario)));
  const byKey = new Map(dec.map((x) => [x.key, x.value]));
  d.settings = settingsSchema(prep).map((s) => ({ ...s, value: byKey.get(s.key) ?? null }));
  d.settings_enabled = false;
  d.settings_note = "Trạm demo: chỉ xem, không gửi lệnh.";
  d.device.profile_label = prep.label;
  d.device.manufacturer = "Deye";
  d.source = "demo";
  d.updated = new Date().toISOString();
  return d;
}

// MỚI (31/10/2026): ghi cài đặt qua cloud hãng, ghi nhật ký lệnh, xoá bộ đệm chi tiết để đọc lại
async function cloudSetting(env, st, b) {
  const acc = st.account_id ? await env.DB.prepare("SELECT * FROM accounts WHERE id=?1").bind(st.account_id).first() : null;
  const ad = acc && ADAPTERS[acc.brand];
  if (!ad?.writeSetting) return json({ error: "Trạm này chưa hỗ trợ cài đặt từ xa (cần gateway INSOLAR hoặc tài khoản Deye Cloud / SolisCloud)" }, 400);
  if (!b || typeof b.key !== "string") return json({ error: "Thiếu tên cài đặt" }, 400);
  const row = await env.DB.prepare("SELECT json FROM details WHERE station_id=?1").bind(st.id).first();
  const name = (row ? JSON.parse(row.json).settings || [] : []).find((s) => s.key === b.key)?.name || b.key;
  const val = typeof b.value === "object" ? JSON.stringify(b.value) : String(b.value);
  const ins = await env.DB.prepare("INSERT INTO commands (station_id, setting, name, value, status) VALUES (?1,?2,?3,?4,'sent') RETURNING id").bind(st.id, b.key, name, val).first();
  let ok = true, error = null;
  try {
    const creds = await decrypt(env.ENC_KEY, acc.creds_enc);
    const cached = acc.token_enc ? await decrypt(env.ENC_KEY, acc.token_enc).catch(() => null) : null;
    await ad.writeSetting(creds, cached, st.ext_id, b.key, b.value);
  } catch (e) { ok = false; error = String(e.message || e); }
  await env.DB.batch([
    env.DB.prepare("UPDATE commands SET status=?2, error=?3, finished_at=?4 WHERE id=?1").bind(ins.id, ok ? "ok" : "error", error, new Date().toISOString()),
    env.DB.prepare("DELETE FROM details WHERE station_id=?1").bind(st.id),
  ]);
  return json({ ok, error, name });
}

// ---------- Thời tiết khu vực (MỚI 31/10/2026) ----------
// Open-Meteo: miễn phí, không cần khoá. Đệm 15 phút tại Cloudflare theo toạ độ làm tròn ~1 km.
// Trạm chưa có toạ độ → dùng TP Thanh Hoá.
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
let latLonReady = false;
async function ensureLatLon(env) {
  if (latLonReady) return;
  for (const c of ["lat", "lon"]) await env.DB.prepare(`ALTER TABLE stations ADD COLUMN ${c} REAL`).run().catch(() => {});
  // MỚI (07/11/2026): danh sách chuỗi PV đã từng phát điện (vd "1,2") → chỉ hiện PV thật đang đấu
  await env.DB.prepare("ALTER TABLE stations ADD COLUMN pv_seen TEXT").run().catch(() => {});
  // MỚI (08/11/2026): sản lượng tháng/năm hãng trả sẵn trong danh sách trạm + ngày lấy
  for (const c of ["month_kwh REAL", "year_kwh REAL", "my_day TEXT"]) await env.DB.prepare(`ALTER TABLE stations ADD COLUMN ${c}`).run().catch(() => {});
  latLonReady = true;
}
async function weatherFor(env, st) {
  try {
    await ensureLatLon(env);
    const row = await env.DB.prepare("SELECT lat, lon FROM stations WHERE id=?1").bind(st.id).first();
    const exact = isNum(row?.lat) && isNum(row?.lon) && (row.lat || row.lon);
    const lat = exact ? row.lat : 19.807, lon = exact ? row.lon : 105.776;
    const q = `latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}`;
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}&current=weather_code,cloud_cover,precipitation,rain,showers,is_day,shortwave_radiation,temperature_2m&timezone=Asia%2FBangkok`, { cf: { cacheTtl: 900, cacheEverything: true } });
    if (!r.ok) return null;
    const c = (await r.json()).current || {};
    return { code: c.weather_code ?? null, cloud: c.cloud_cover ?? null, rain: (c.precipitation ?? 0) || (c.rain ?? 0) + (c.showers ?? 0), radiation: c.shortwave_radiation ?? null, temp: c.temperature_2m ?? null, is_day: c.is_day ?? null, time: c.time || null, approx: !exact };
  } catch {
    return null;
  }
}

// MỚI (07/11/2026): bảng gán thông số do người dùng tự đặt (theo trạm / dòng máy / cả hãng)
async function fieldMaps(env, brand, stationId) {
  const { results } = await env.DB.prepare(
    `SELECT scope, scope_val, src, field, factor FROM field_maps WHERE brand=?1 AND (scope<>'station' OR scope_val=?2)
     ORDER BY CASE scope WHEN 'station' THEN 0 WHEN 'model' THEN 1 ELSE 2 END, id DESC`
  ).bind(brand, String(stationId)).all().catch(() => ({ results: [] }));
  return results;
}

// MỚI (07/11/2026): cloud/profile thường trả đủ PV1…PV4 dù máy chỉ có 1–2 chuỗi được đấu.
// Chuỗi nào từng có điện áp ≥ 50V hoặc công suất ≥ 10W thì ghi nhớ vào stations.pv_seen;
// giao diện chỉ hiện các chuỗi đã ghi nhớ (ban đêm vẫn đúng nhờ nhớ từ ban ngày).
async function stationDetail(env, st, ctx) {
  const r = await stationDetailRaw(env, st, ctx);
  const d = r.detail;
  if (!d?.pv?.strings?.length) return r;
  try {
    const row = await env.DB.prepare("SELECT pv_seen FROM stations WHERE id=?1").bind(st.id).first();
    const old = String(row?.pv_seen || "").split(",").filter(Boolean).map(Number);
    const seen = new Set(old);
    for (const x of d.pv.strings) if ((isNum(x.v) && x.v >= 50) || (isNum(x.w) && x.w >= 10) || (isNum(x.a) && x.a >= 0.3)) seen.add(x.n);
    const list = [...seen].sort((a, b) => a - b);
    if (list.length && list.join(",") !== old.join(",")) ctx.waitUntil(env.DB.prepare("UPDATE stations SET pv_seen=?2 WHERE id=?1").bind(st.id, list.join(",")).run());
    if (list.length) d.pv.strings = d.pv.strings.filter((x) => seen.has(x.n));
    d.pv.strings_all = !list.length; // chưa từng thấy chuỗi nào phát (trạm mới, đang đêm) → tạm hiện đủ
  } catch {}
  return r;
}

async function stationDetailRaw(env, st, ctx) {
  if (st.gateway_id) {
    const r = await hub(env, st.gateway_id).fetch("https://hub/live");
    const live = await r.json();
    if (live.detail) return { online: live.online, detail: live.detail };
    const row = await env.DB.prepare("SELECT json FROM details WHERE station_id=?1").bind(st.id).first();
    return { online: false, detail: row ? JSON.parse(row.json) : null };
  }
  if (st.brand === "demo") return { online: st.status !== "offline", detail: demoDetail(st) };
  const row = await env.DB.prepare("SELECT json, updated_at FROM details WHERE station_id=?1").bind(st.id).first();
  if (row && Date.now() - new Date(row.updated_at) < 90e3) return { online: st.status !== "offline", detail: JSON.parse(row.json) };
  const acc = await env.DB.prepare("SELECT * FROM accounts WHERE id=?1").bind(st.account_id).first();
  const ad = acc && ADAPTERS[acc.brand];
  if (!ad?.fetchDetail) return { online: st.status !== "offline", detail: row ? JSON.parse(row.json) : null };
  try {
    const creds = await decrypt(env.ENC_KEY, acc.creds_enc);
    const cached = acc.token_enc ? await decrypt(env.ENC_KEY, acc.token_enc).catch(() => null) : null;
    const r = await ad.fetchDetail(creds, cached, st.ext_id);
    const d = fromCloudList(r.list, acc.brand, { serial: r.serial, manufacturer: ad.label, ...(r.device || {}) }, await fieldMaps(env, acc.brand, st.id));
    d.source = acc.brand;
    // MỚI (31/10/2026): cài đặt từ xa qua API điều khiển của cloud hãng (Deye Cloud, SolisCloud)
    if (r.settings?.length && ad.writeSetting) {
      d.settings = r.settings;
      d.settings_enabled = true;
      d.settings_note = `Lệnh gửi qua ${ad.label}, mỗi lệnh mất 5–30 giây`;
    } else {
      d.settings_enabled = false;
      d.settings_note = r.settingsError || "Trạm lấy dữ liệu qua cloud của hãng. Lắp gateway INSOLAR để cài đặt từ xa.";
    }
    // Bổ sung số liệu tổng từ danh sách trạm nếu cloud thiếu
    d.pv.power ??= st.pv_power_w; d.load.power ??= st.load_power_w; d.grid.power ??= st.grid_power_w;
    d.battery.soc ??= st.battery_soc; d.battery.power ??= st.battery_power_w; d.pv.today_kwh ??= st.today_kwh; d.pv.total_kwh ??= st.total_kwh;
    d.updated = new Date().toISOString();
    const stmts = [env.DB.prepare("INSERT OR REPLACE INTO details (station_id, json, updated_at) VALUES (?1,?2,?3)").bind(st.id, JSON.stringify(d), d.updated)];
    if (r.token) stmts.push(env.DB.prepare("UPDATE accounts SET token_enc=?2 WHERE id=?1").bind(acc.id, await encrypt(env.ENC_KEY, r.token)));
    if (d.battery.power !== null && d.battery.power !== undefined) stmts.push(env.DB.prepare("UPDATE stations SET battery_power_w=?2 WHERE id=?1").bind(st.id, d.battery.power));
    ctx.waitUntil(env.DB.batch(stmts));
    return { online: st.status !== "offline", detail: d };
  } catch (e) {
    const d = row ? JSON.parse(row.json) : null;
    return { online: st.status !== "offline", detail: d, error: String(e.message || e) };
  }
}

// ---------- Lịch sử ----------
const vnToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

// MỚI (31/10/2026): lịch sử lấy từ cloud hãng nếu adapter hỗ trợ (Deye); lỗi/rỗng thì dùng dữ liệu app tự lưu
async function cloudHistory(env, st, range, d, ctx) {
  try {
    if (!st.account_id || st.gateway_id) return null;
    const acc = await env.DB.prepare("SELECT * FROM accounts WHERE id=?1").bind(st.account_id).first();
    const ad = acc && ADAPTERS[acc.brand];
    if (!ad?.fetchHistory) return null;
    const creds = await decrypt(env.ENC_KEY, acc.creds_enc);
    const cached = acc.token_enc ? await decrypt(env.ENC_KEY, acc.token_enc).catch(() => null) : null;
    const r = await ad.fetchHistory(creds, cached, st.ext_id, range, d);
    if (r.token) ctx?.waitUntil?.(env.DB.prepare("UPDATE accounts SET token_enc=?2 WHERE id=?1").bind(acc.id, await encrypt(env.ENC_KEY, r.token)).run());
    return r;
  } catch (e) { return { error: String(e.message || e) }; }
}

// SỬA (08/11/2026): số "năm" của cloud Solarman không tin được (lớn hơn cả tổng) → năm = cộng sản lượng
// từng tháng (lấy bằng lịch sử tháng, số này khớp app gốc). Tháng đã qua đệm 1 ngày, tháng này đệm 1 giờ.
async function cacheJson(key, ttl, fn) {
  const req = new Request(`https://cache.insolar-monitor/${key}`);
  try { const hit = await caches.default.match(req); if (hit) return await hit.json(); } catch {}
  const v = await fn();
  if (v !== null && v !== undefined) try { await caches.default.put(req, new Response(JSON.stringify(v), { headers: { "Cache-Control": `max-age=${ttl}`, "Content-Type": "application/json" } })); } catch {}
  return v;
}
async function cloudMonthKwh(env, st, ym, ctx) {
  const r = await cloudHistory(env, st, "month", ym + "-01", ctx);
  if (!r?.bars) return null; // lỗi → không đệm
  const by = {};
  for (const b of r.bars) if (isNum(b.pv)) by[b.day || b.label] = Math.max(by[b.day || b.label] ?? 0, b.pv);
  return Math.round(Object.values(by).reduce((t, x) => t + x, 0) * 10) / 10;
}
// SỬA (08/11/2026): cộng các tháng năm nay vẫn ra lớn hơn thực tế → Năm nay = Tổng − sản lượng các năm trước
// (các năm trước cộng theo tháng, đệm 7 ngày; dừng khi gặp năm không có sản lượng = trước ngày lắp).
async function yearKwh(env, st, y, ctx) {
  return cacheJson(`ey4/${st.id}/${y}`, 7 * 86400, async () => {
    const xs = await Promise.all(Array.from({ length: 12 }, (_, i) => cloudMonthKwh(env, st, `${y}-${String(i + 1).padStart(2, "0")}`, ctx).catch(() => null)));
    if (xs.some((x) => x === null)) return null;
    return Math.round(xs.reduce((t, x) => t + x, 0) * 10) / 10;
  });
}
async function cloudYear(env, st, ctx) {
  if (!st.account_id || st.gateway_id) return null;
  const d = vnToday(), y = Number(d.slice(0, 4));
  const month = await cacheJson(`em3/${st.id}/${d.slice(0, 7)}/${d}-${new Date().getUTCHours()}`, 3600, () => cloudMonthKwh(env, st, d.slice(0, 7), ctx));
  if (!isNum(month)) return null;
  const total = isNum(st.total_kwh) && st.total_kwh > 0 ? st.total_kwh : null;
  let year = null;
  if (total !== null) {
    let prev = 0, ok = true;
    for (let k = 1; k <= 5; k++) { // tối đa 5 năm trước
      const v = await yearKwh(env, st, y - k, ctx);
      if (v === null) { ok = false; break; }
      if (v <= 0) break;
      prev += v;
    }
    if (ok) year = total - prev;
  }
  if (isNum(year) && year < month) year = month;
  if (isNum(year) && total !== null && year > total) year = total;
  return { month, year: isNum(year) ? Math.round(year * 10) / 10 : null };
}

// MỚI (07/11/2026): sản lượng tháng/năm (cộng max today_kwh từng ngày trong readings) để tính tiền khai thác
// SỬA (08/11/2026): trước chỉ cộng readings (chỉ có từ ngày thêm trạm vào app) → tháng = năm, thiếu số.
// Nay ưu tiên lấy sản lượng từng tháng của năm từ cloud hãng (đệm 1 giờ), lỗi mới dùng readings.
async function energySum(env, st, ctx) {
  const cloud = await cloudYear(env, st, ctx).catch(() => null);
  // Hãng có sẵn tháng/năm trong danh sách trạm (Solis, Sigenergy) → dùng luôn nếu là số của tháng này
  if (!cloud?.year) {
    const r = await env.DB.prepare("SELECT month_kwh, year_kwh, my_day FROM stations WHERE id=?1").bind(st.id).first().catch(() => null);
    if (r?.my_day && r.my_day.slice(0, 7) === vnToday().slice(0, 7) && (isNum(r.month_kwh) || isNum(r.year_kwh)))
      return { today: st.today_kwh ?? null, month: r.month_kwh ?? cloud?.month ?? null, year: r.year_kwh ?? null, total: st.total_kwh ?? null, src: "brand" };
  }
  if (cloud) return { today: st.today_kwh ?? null, ...cloud, total: st.total_kwh ?? null, src: "cloud" };
  try {
    const d = vnToday();
    const r = await env.DB.prepare(
      `SELECT SUM(CASE WHEN day >= ?3 THEN pv ELSE 0 END) AS month, SUM(pv) AS year FROM
        (SELECT substr(datetime(ts,'+7 hours'),1,10) AS day, MAX(today_kwh) AS pv FROM readings WHERE station_id=?1 AND ts >= ?2 GROUP BY day)`
    ).bind(st.id, new Date(d.slice(0, 4) + "-01-01T00:00:00+07:00").toISOString(), d.slice(0, 7) + "-01").first();
    return { today: st.today_kwh ?? null, month: r?.month ?? null, year: r?.year ?? null, total: st.total_kwh ?? null };
  } catch { return null; }
}

async function history(env, st, range, date, ctx) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : vnToday();
  const cloud = await cloudHistory(env, st, range, d, ctx);
  if (cloud?.bars?.length) return { range, date: d, bars: cloud.bars };
  if (cloud?.points?.length && range !== "month" && range !== "year") return { range: "day", date: d, points: cloud.points };
  const note = cloud?.error ? `Không lấy được lịch sử từ cloud: ${cloud.error}` : null;
  if (range === "month" || range === "year") {
    const from = range === "month" ? d.slice(0, 7) + "-01" : d.slice(0, 4) + "-01-01";
    const toDate = new Date(from + "T00:00:00+07:00");
    if (range === "month") toDate.setUTCMonth(toDate.getUTCMonth() + 1); else toDate.setUTCFullYear(toDate.getUTCFullYear() + 1);
    const { results } = await env.DB.prepare(
      `SELECT substr(datetime(ts,'+7 hours'),1,10) AS day, MAX(today_kwh) AS pv, MAX(load_kwh) AS load, MAX(import_kwh) AS imp,
        MAX(export_kwh) AS exp, MAX(charge_kwh) AS chg, MAX(discharge_kwh) AS dis
       FROM readings WHERE station_id=?1 AND ts >= ?2 AND ts < ?3 GROUP BY day ORDER BY day`
    ).bind(st.id, new Date(from + "T00:00:00+07:00").toISOString(), toDate.toISOString()).all();
    if (range === "month") return { range, date: d, note, bars: results.map((r) => ({ label: r.day.slice(8), ...r })) };
    const by = {};
    for (const r of results) {
      const k = r.day.slice(5, 7);
      by[k] ??= { label: k, pv: 0, load: 0, imp: 0, exp: 0, chg: 0, dis: 0 };
      for (const f of ["pv", "load", "imp", "exp", "chg", "dis"]) by[k][f] += r[f] || 0;
    }
    return { range, date: d, note, bars: Object.values(by) };
  }
  const from = new Date(d + "T00:00:00+07:00").toISOString();
  const to = new Date(d + "T23:59:59+07:00").toISOString();
  const { results } = await env.DB.prepare(
    `SELECT ts, pv_power_w AS pv, load_power_w AS load, grid_power_w AS grid, battery_power_w AS bat, battery_soc AS soc, today_kwh
     FROM readings WHERE station_id=?1 AND ts BETWEEN ?2 AND ?3 ORDER BY ts`
  ).bind(st.id, from, to).all();
  let points = results;
  if (!points.length && st.brand === "demo") points = demoDay(st, d);
  return { range: "day", date: d, note, points };
}

function demoDay(st, d) {
  const out = [];
  const nowH = d === vnToday() ? (Date.now() / 3600e3 + 7) % 24 : 24;
  for (let m = 0; m <= nowH * 60; m += 10) {
    const h = m / 60;
    const sun = Math.max(0, Math.sin(((h - 6) / 12.5) * Math.PI)) * (0.85 + 0.15 * Math.sin(h * 7.3));
    const pv = Math.round((st.capacity_kwp || 8) * 820 * sun);
    const load = Math.round((h >= 17.5 && h <= 22.5 ? 2300 : h < 6 ? 450 : 900) + 120 * Math.sin(m));
    const soc = Math.max(20, Math.min(100, Math.round(h < 6 ? 45 - h * 2 : h < 15 ? 33 + (h - 6) * 7.4 : h < 17.5 ? 100 : 100 - (h - 17.5) * 9)));
    let bat = pv > load && soc < 100 ? -Math.min(pv - load, 4500) : pv < load && soc > 20 ? Math.min(load - pv, 5000) : 0;
    out.push({ ts: new Date(new Date(d + "T00:00:00+07:00").getTime() + m * 60e3).toISOString(), pv, load, bat, grid: load - pv - bat, soc, today_kwh: null });
  }
  return out;
}

// ---------- API ----------
// SỬA (31/10/2026): thêm s.account_id, s.ext_id (mã trạm bên hãng, thiếu → gọi cloud bằng 'undefined') — thiếu cột này làm mở chi tiết trạm cloud báo D1_TYPE_ERROR (bind undefined)
const STATION_COLS = `s.id, s.brand, s.name, s.customer, s.phone, s.note, s.address, s.capacity_kwp, s.battery_kwh, s.status, s.pv_power_w,
  s.load_power_w, s.grid_power_w, s.battery_power_w, s.battery_soc, s.today_kwh, s.total_kwh, s.data_time, s.synced_at, s.share_token,
  s.gateway_id, s.account_id, s.ext_id, s.lat, s.lon, s.price_kwh, COALESCE(a.label, 'Gateway INSOLAR') AS account_label,
  (SELECT COUNT(*) FROM alarms al WHERE al.station_id=s.id AND al.active=1) AS alarm_count,
  (SELECT COUNT(*) FROM alarms al WHERE al.station_id=s.id AND al.active=1 AND al.level='fault') AS fault_count`;

const GW_FIELDS = ["name", "profile", "params", "slave", "transport", "v5_host", "v5_serial", "poll", "can_enabled", "bms_kind", "bms_transport",
  "bms_ble_names", "allow_write", "invert_battery", "invert_grid"];

function cleanGateway(b) {
  const o = {};
  for (const k of GW_FIELDS) if (k in b) o[k] = b[k];
  if ("params" in o) o.params = JSON.stringify(typeof o.params === "string" ? JSON.parse(o.params || "{}") : o.params || {});
  for (const k of ["slave", "poll"]) if (k in o) o[k] = Math.max(1, Math.min(k === "poll" ? 300 : 247, Number(o[k]) || 1));
  for (const k of ["can_enabled", "allow_write", "invert_battery", "invert_grid"]) if (k in o) o[k] = o[k] ? 1 : 0;
  if ("transport" in o && !["rs485", "solarman_v5"].includes(o.transport)) o.transport = "rs485";
  if ("bms_kind" in o && !["jbd", "daly"].includes(o.bms_kind)) o.bms_kind = null;
  if ("profile" in o) prepare(o.profile, {}); // ném lỗi nếu profile không tồn tại
  return o;
}

async function pushGatewayConfig(env, id) {
  const g = await env.DB.prepare("SELECT * FROM gateways WHERE id=?1").bind(id).first();
  if (g) await hub(env, id).fetch("https://hub/config", { method: "POST", body: JSON.stringify(g) });
}

async function getStation(env, id) {
  return env.DB.prepare(`SELECT ${STATION_COLS} FROM stations s LEFT JOIN accounts a ON a.id=s.account_id WHERE s.id=?1`).bind(id).first();
}

async function api(req, env, url, ctx) {
  const p = url.pathname;
  await ensureLatLon(env); // MỚI (31/10/2026): tự thêm cột toạ độ cho CSDL tạo trước bản này
  await ensureAlarms(env); // MỚI (07/11/2026): bảng cảnh báo từ cloud hãng
  const method = req.method;

  await ensureAuth(env);
  const pa = await publicAuthRoutes(req, env, url);
  if (pa) return pa;
  if (p === "/api/logout") return json({ ok: true }, 200, { "Set-Cookie": "ims=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });

  // Trang chia sẻ cho khách
  let m = p.match(/^\/api\/public\/([a-z0-9]{12,})(\/history)?$/);
  if (m && method === "GET") {
    const st = await env.DB.prepare(`SELECT ${STATION_COLS} FROM stations s LEFT JOIN accounts a ON a.id=s.account_id WHERE s.share_token=?1`).bind(m[1]).first();
    if (!st) return json({ error: "Không tìm thấy" }, 404);
    if (m[2]) return json(await history(env, st, url.searchParams.get("range") || "day", url.searchParams.get("date"), ctx));
    const det = await stationDetail(env, st, ctx);
    if (det.detail) { det.detail.settings = []; det.detail.params = []; }
    const { customer, phone, note, share_token, gateway_id, account_id, ext_id, account_label, lat, lon, ...pub } = st;
    const [weather, energy] = await Promise.all([weatherFor(env, st), energySum(env, st, ctx)]);
    return json({ station: pub, ...det, weather, energy });
  }

  const me = await currentUser(req, env);
  if (!me) return json({ error: "Chưa đăng nhập" }, 401);
  if (method !== "GET" && req.headers.get("X-Req") !== "1") return json({ error: "Bad request" }, 400);
  const ur = await userRoutes(req, env, url, me);
  if (ur) return ur;
  if (p === "/api/brands") return json(publicAdapterInfo());
  if (p === "/api/profiles") return json(profileList());

  // ----- Gán thông số hãng → ô hiển thị (MỚI 07/11/2026) -----
  if (p === "/api/field-maps" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT f.*, s.name AS station_name FROM field_maps f LEFT JOIN stations s ON f.scope='station' AND s.id=CAST(f.scope_val AS INTEGER) ORDER BY f.brand, f.id DESC").all();
    return json(results);
  }
  if (p === "/api/field-maps" && method === "POST") {
    const b = await req.json();
    const st = await getStation(env, Number(b.station_id));
    if (!st || st.gateway_id || !st.account_id) return json({ error: "Chỉ gán được cho trạm lấy dữ liệu từ cloud hãng" }, 400);
    const scope = ["station", "model", "brand"].includes(b.scope) ? b.scope : "station";
    const val = scope === "station" ? String(st.id) : scope === "model" ? String(b.model || "").slice(0, 80) : null;
    if (scope === "model" && !val) return json({ error: "Không xác định được dòng máy" }, 400);
    const src = String(b.src || "").trim().slice(0, 120), field = String(b.field || "").trim();
    if (!src || !/^[a-z]+\.[a-z0-9_]+(\.[a-z_]+)?$/.test(field)) return json({ error: "Thiếu thông số hoặc ô cần gán" }, 400);
    const factor = b.factor === "" || b.factor === null || b.factor === undefined ? null : Number(b.factor);
    if (factor !== null && !Number.isFinite(factor)) return json({ error: "Hệ số không hợp lệ" }, 400);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM field_maps WHERE brand=?1 AND scope=?2 AND IFNULL(scope_val,'')=IFNULL(?3,'') AND field=?4").bind(st.brand, scope, val, field),
      env.DB.prepare("INSERT INTO field_maps (brand, scope, scope_val, src, field, factor) VALUES (?1,?2,?3,?4,?5,?6)").bind(st.brand, scope, val, src, field, factor),
      env.DB.prepare("UPDATE details SET updated_at='2000-01-01T00:00:00Z' WHERE station_id IN (SELECT id FROM stations WHERE brand=?1)").bind(st.brand), // đọc lại ngay
    ]);
    return json({ ok: true });
  }
  m = p.match(/^\/api\/field-maps\/(\d+)$/);
  if (m && method === "DELETE") {
    const r = await env.DB.prepare("DELETE FROM field_maps WHERE id=?1 RETURNING brand").bind(Number(m[1])).first();
    if (r) await env.DB.prepare("UPDATE details SET updated_at='2000-01-01T00:00:00Z' WHERE station_id IN (SELECT id FROM stations WHERE brand=?1)").bind(r.brand).run();
    return json({ ok: true });
  }

  if (p === "/api/stations" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT ${STATION_COLS} FROM stations s LEFT JOIN accounts a ON a.id=s.account_id ORDER BY CASE WHEN s.status='alarm' OR fault_count>0 THEN 0 WHEN s.status='offline' THEN 1 ELSE 2 END, s.name`
    ).all();
    return json(results);
  }

  m = p.match(/^\/api\/stations\/(\d+)(?:\/(detail|history|share|settings|raw|commands))?$/);
  if (m) {
    const st = await getStation(env, Number(m[1]));
    if (!st) return json({ error: "Không tìm thấy trạm" }, 404);
    const sub = m[2];
    if (!sub && method === "GET") return json(st);
    if (sub === "detail") {
      const [det, weather, energy] = await Promise.all([stationDetail(env, st, ctx), weatherFor(env, st), energySum(env, st, ctx)]);
      return json({ ...det, weather, energy });
    }
    if (sub === "history") return json(await history(env, st, url.searchParams.get("range") || "day", url.searchParams.get("date"), ctx));
    if (sub === "commands") {
      const { results } = await env.DB.prepare("SELECT * FROM commands WHERE station_id=?1 ORDER BY id DESC LIMIT 50").bind(st.id).all();
      return json(results);
    }
    if (sub === "share" && method === "POST") {
      const { revoke } = await req.json().catch(() => ({}));
      const tok = revoke ? null : randomToken(16);
      await env.DB.prepare("UPDATE stations SET share_token=?2 WHERE id=?1").bind(st.id, tok).run();
      return json({ share_token: tok });
    }
    if ((sub === "settings" || sub === "raw") && method === "POST") {
      if (!st.gateway_id && sub === "settings") return cloudSetting(env, st, await req.json());
      if (!st.gateway_id) return json({ error: "Công cụ Modbus chỉ dùng được với gateway INSOLAR" }, 400);
      const b = await req.json();
      const path = sub === "settings" ? "/write" : b.op === "write" ? "/write" : "/read";
      const body = sub === "settings" ? { key: b.key, value: b.value } : b.op === "write" ? { raw: true, fc: b.fc, addr: b.addr, values: b.values } : { fc: b.fc, addr: b.addr, count: b.count };
      const r = await hub(env, st.gateway_id).fetch("https://hub" + path, { method: "POST", body: JSON.stringify(body) });
      return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json" } });
    }
    if (!sub && method === "PATCH") {
      const b = await req.json();
      if ("customer" in b || "name" in b) await env.DB.prepare("UPDATE stations SET customer=?2, phone=?3, note=?4, name=COALESCE(?5,name), capacity_kwp=COALESCE(?6,capacity_kwp), battery_kwh=?7 WHERE id=?1")
        .bind(st.id, b.customer ?? null, b.phone ?? null, b.note ?? null, b.name || null, b.capacity_kwp ? Number(b.capacity_kwp) : null, b.battery_kwh ? Number(b.battery_kwh) : null).run();
      if ("lat" in b || "lon" in b) {
        await ensureLatLon(env);
        const la = b.lat === "" || b.lat === null ? null : Number(b.lat), lo = b.lon === "" || b.lon === null ? null : Number(b.lon);
        if ((la !== null && !(Math.abs(la) <= 90)) || (lo !== null && !(Math.abs(lo) <= 180))) return json({ error: "Toạ độ không hợp lệ" }, 400);
        await env.DB.prepare("UPDATE stations SET lat=?2, lon=?3 WHERE id=?1").bind(st.id, la, lo).run();
      }
      if ("price_kwh" in b) { // MỚI (07/11/2026): giá điện tính tiền khai thác
        const pr = b.price_kwh === "" || b.price_kwh === null ? null : Number(b.price_kwh);
        if (pr !== null && !(pr >= 0 && pr < 1e6)) return json({ error: "Giá điện không hợp lệ" }, 400);
        await env.DB.prepare("UPDATE stations SET price_kwh=?2 WHERE id=?1").bind(st.id, pr).run();
      }
      return json({ ok: true });
    }
  }

  // ----- Gateway -----
  if (p === "/api/gateways" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT g.*, s.name AS station_name FROM gateways g LEFT JOIN stations s ON s.id=g.station_id ORDER BY g.created_at DESC"
    ).all();
    return json(results.map(({ key_hash, ...g }) => g));
  }
  if (p === "/api/gateways" && method === "POST") {
    const b = await req.json();
    let o;
    try { o = cleanGateway(b); } catch (e) { return json({ error: e.message }, 400); }
    if (!o.name || !o.profile) return json({ error: "Cần tên và dòng inverter" }, 400);
    const id = "gw_" + randomToken(6);
    const key = randomToken(16);
    const prof = profileList().find((x) => x.id === o.profile);
    const st = await env.DB.prepare(
      "INSERT INTO stations (account_id, gateway_id, brand, ext_id, name, status, capacity_kwp, address, customer, phone) VALUES (0, ?1, ?2, ?1, ?3, 'offline', ?4, ?5, ?6, ?7) RETURNING id"
    ).bind(id, (prof?.manufacturer || "gateway").toLowerCase(), o.name, b.capacity_kwp ? Number(b.capacity_kwp) : null, b.address || null, b.customer || null, b.phone || null).first();
    const cols = ["id", "key_hash", "station_id", ...Object.keys(o)];
    const vals = [id, await sha256Hex(key), st.id, ...Object.values(o)];
    await env.DB.prepare(`INSERT INTO gateways (${cols.join(",")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(",")})`).bind(...vals).run();
    return json({ ok: true, id, key, station_id: st.id });
  }
  m = p.match(/^\/api\/gateways\/(gw_[a-z0-9]+)(\/rekey)?$/);
  if (m) {
    const id = m[1];
    const g = await env.DB.prepare("SELECT id, station_id FROM gateways WHERE id=?1").bind(id).first();
    if (!g) return json({ error: "Không tìm thấy gateway" }, 404);
    if (m[2] && method === "POST") {
      const key = randomToken(16);
      await env.DB.prepare("UPDATE gateways SET key_hash=?2 WHERE id=?1").bind(id, await sha256Hex(key)).run();
      return json({ ok: true, key });
    }
    if (method === "PATCH") {
      let o;
      try { o = cleanGateway(await req.json()); } catch (e) { return json({ error: e.message }, 400); }
      const keys = Object.keys(o);
      if (keys.length) {
        await env.DB.prepare(`UPDATE gateways SET ${keys.map((k, i) => `${k}=?${i + 2}`).join(",")} WHERE id=?1`).bind(id, ...Object.values(o)).run();
        if (o.name) await env.DB.prepare("UPDATE stations SET name=?2 WHERE id=?1").bind(g.station_id, o.name).run();
        ctx.waitUntil(pushGatewayConfig(env, id));
      }
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM readings WHERE station_id=?1").bind(g.station_id),
        env.DB.prepare("DELETE FROM details WHERE station_id=?1").bind(g.station_id),
        env.DB.prepare("DELETE FROM stations WHERE id=?1").bind(g.station_id),
        env.DB.prepare("DELETE FROM gateways WHERE id=?1").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  // ----- Tài khoản cloud -----
  if (p === "/api/accounts" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.brand, a.label, a.enabled, a.last_sync, a.last_error, a.created_at,
        (SELECT COUNT(*) FROM stations s WHERE s.account_id=a.id) AS station_count FROM accounts a ORDER BY a.id`
    ).all();
    return json(results);
  }
  if (p === "/api/accounts" && method === "POST") {
    const b = await req.json();
    const ad = ADAPTERS[b.brand];
    if (!ad) return json({ error: "Hãng không hợp lệ" }, 400);
    const creds = {};
    for (const f of ad.fields) {
      const v = String(b.creds?.[f.key] ?? "").trim();
      if (!v && !f.optional) return json({ error: `Thiếu: ${f.label}` }, 400);
      if (v) creds[f.key] = v;
    }
    const r = await env.DB.prepare("INSERT INTO accounts (brand, label, creds_enc) VALUES (?1, ?2, ?3) RETURNING *")
      .bind(b.brand, String(b.label || ad.label).slice(0, 80), await encrypt(env.ENC_KEY, creds)).first();
    const res = await syncAccount(env, r, { alarms: true });
    if (!res.ok) {
      await env.DB.prepare("DELETE FROM accounts WHERE id=?1").bind(r.id).run();
      return json({ error: "Kết nối thất bại: " + res.error }, 400);
    }
    return json({ ok: true, id: r.id, count: res.count });
  }
  m = p.match(/^\/api\/accounts\/(\d+)(\/sync)?$/);
  if (m) {
    const id = Number(m[1]);
    const acc = await env.DB.prepare("SELECT * FROM accounts WHERE id=?1").bind(id).first();
    if (!acc) return json({ error: "Không tìm thấy" }, 404);
    if (m[2] && method === "POST") return json(await syncAccount(env, acc, { alarms: true }));
    if (method === "PATCH") {
      const b = await req.json();
      await env.DB.prepare("UPDATE accounts SET enabled=?2 WHERE id=?1").bind(id, b.enabled ? 1 : 0).run();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM readings WHERE station_id IN (SELECT id FROM stations WHERE account_id=?1)").bind(id),
        env.DB.prepare("DELETE FROM details WHERE station_id IN (SELECT id FROM stations WHERE account_id=?1)").bind(id),
        env.DB.prepare("DELETE FROM stations WHERE account_id=?1").bind(id),
        env.DB.prepare("DELETE FROM accounts WHERE id=?1").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  if (p === "/api/sync-all" && method === "POST") {
    ctx.waitUntil(syncAll(env, { alarms: true }));
    return json({ ok: true });
  }

  // MỚI (07/11/2026): danh sách cảnh báo/lỗi đồng bộ từ cloud hãng. ?active=1 chỉ cái đang xảy ra, ?station=ID theo trạm
  if (p === "/api/alarms" && method === "GET") {
    const q = url.searchParams;
    const where = [], args = [];
    if (q.get("active") === "1") where.push("al.active=1");
    if (q.get("active") === "0") where.push("al.active=0");
    if (q.get("station")) { args.push(Number(q.get("station"))); where.push(`al.station_id=?${args.length}`); }
    const limit = Math.min(500, Number(q.get("limit")) || 200);
    const { results } = await env.DB.prepare(
      `SELECT al.id, al.station_id, al.brand, al.code, al.message, al.level, al.device_sn, al.advice, al.start_at, al.end_at, al.active, al.updated_at, s.name AS station_name
       FROM alarms al LEFT JOIN stations s ON s.id=al.station_id ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY al.active DESC, CASE al.level WHEN 'fault' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, al.start_at DESC LIMIT ${limit}`
    ).bind(...args).all();
    return json(results);
  }

  return json({ error: "Not found" }, 404);
}

// Gateway kết nối: wss://<tên miền>/gw/ws?id=gw_xxx&key=yyy
async function gatewayConnect(req, env, url) {
  if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
  const id = url.searchParams.get("id") || req.headers.get("X-GW-ID");
  const key = url.searchParams.get("key") || req.headers.get("X-GW-KEY");
  if (!id || !key) return new Response("Unauthorized", { status: 401 });
  const g = await env.DB.prepare("SELECT * FROM gateways WHERE id=?1").bind(id).first();
  if (!g || !safeEqual(g.key_hash, await sha256Hex(key))) {
    await new Promise((r) => setTimeout(r, 500));
    return new Response("Unauthorized", { status: 401 });
  }
  const { key_hash, ...gw } = g;
  const h = new Headers(req.headers);
  h.set("X-Gateway", JSON.stringify(gw));
  return hub(env, id).fetch(new Request("https://hub/connect", { headers: h }));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/gw/ws") return await gatewayConnect(req, env, url);
      if (url.pathname === "/flash") return new Response(FLASH_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (url.pathname === "/flash/manifest.json") {
        return json({ name: "INSOLAR Gateway", version: "1.0.0", new_install_prompt_erase: true,
          builds: [{ chipFamily: "ESP32", parts: [{ path: "/flash/insolar-gw-full.bin", offset: 0 }] }] });
      }
      if (url.pathname === "/flash/insolar-gw-full.bin") return new Response(FW_BIN, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=3600" } });
      if (url.pathname.startsWith("/api/")) {
        const r = await api(req, env, url, ctx);
        const out = new Response(r.body, r);
        for (const [k, v] of Object.entries(SEC_HEADERS)) out.headers.set(k, v);
        return out;
      }
      if (url.pathname === "/" || url.pathname.startsWith("/s/") || url.pathname.startsWith("/app")) {
        return new Response(UI_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SEC_HEADERS } });
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(syncAll(env));
  },
};
