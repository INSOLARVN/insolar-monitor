// MỚI (07/11/2026): Solarman qua đăng nhập kiểu app Solarman Smart / web home.solarmanpv.com
// Lý do: OpenAPI của Solarman (App ID/App Secret) là dịch vụ trả phí → dùng chính API mà app/web dùng,
// chỉ cần email + mật khẩu Solarman. API không công khai, Solarman có thể đổi bất cứ lúc nào.
// Nếu web bắt captcha khi đăng nhập: dán "Token" lấy từ trình duyệt (xem help) — token sống ~60 ngày.
// MỚI (07/11/2026): thêm Solarman Business (globalpro.solarmanpv.com) — đăng nhập web bắt captcha Cloudflare nên dùng
// refresh token lấy từ cookie trình duyệt (sống ~6 tháng): /oauth2-s/oauth/token grant_type=refresh_token → access token ~24h.
// Refresh token mới (nếu Solarman đổi) được lưu trong token_enc (adapter đặt keepToken để lỗi tạm thời không xoá mất).
import { sha256Hex } from "../crypto.js";
import { fetchJson, station, num, isoFromAny, statusFromTime, alarm } from "./util.js";

const HOSTS = ["https://globalhome.solarmanpv.com", "https://home.solarmanpv.com", "https://api4home.solarmanpv.com"];
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const clean = (u) => String(u || "").trim().replace(/\/$/, "");

// Giải phần thân JWT để biết hạn dùng (exp)
function jwtExp(t) {
  try {
    const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return p.exp ? p.exp * 1000 : null;
  } catch { return null; }
}

function jwtBody(t) {
  try { return JSON.parse(atob(String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}
// Tách access token / refresh token từ chuỗi người dùng dán (cookie, JSON localStorage hoặc từng token).
// Refresh token của Spring OAuth có trường "ati" trong thân JWT.
export function pickTokens(...texts) {
  const out = { access: null, refresh: null };
  for (const t of texts) {
    for (const j of String(t || "").match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) || []) {
      const b = jwtBody(j);
      if (!b) continue;
      if (b.ati) { if (!out.refresh || (b.exp || 0) > (jwtBody(out.refresh)?.exp || 0)) out.refresh = j; }
      else if (!out.access || (b.exp || 0) > (jwtBody(out.access)?.exp || 0)) out.access = j;
    }
  }
  return out;
}

const BIZ_HOST = "https://globalpro.solarmanpv.com";
const BIZ_HEAD = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json, text/plain, */*", "User-Agent": UA, "log-platform-code": "SOLARMAN_BUSINESS", "log-channel": "Web", "log-lan": "en" };

// Đổi refresh token lấy access token mới (không cần captcha)
async function bizRefresh(host, refresh) {
  let last = "";
  for (const path of ["/oauth2-s/oauth/token", "/oauth-s/oauth/token"]) {
    try {
      const r = await fetchJson(`${host}${path}`, { method: "POST", headers: BIZ_HEAD, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: "test" }).toString() });
      if (r.access_token) return r;
      last = r.error_description || r.msg || r.error || JSON.stringify(r).slice(0, 150);
    } catch (e) { last = String(e.message || e); }
  }
  throw new Error(`Solarman Business: không gia hạn được token (${last}). Đăng nhập lại pro.solarmanpv.com rồi dán cookie mới.`);
}

// Token Business phải gắn tổ chức (organizationId); nếu chưa có mà người dùng nhập Org ID thì đổi sang tổ chức đó
async function bizSwitchOrg(host, access, orgId) {
  const b = jwtBody(access) || {};
  if (!orgId || Number(b.organizationId || b.orgId || 0) === Number(orgId)) return null;
  const r = await fetchJson(`${host}/oauth2-s/oauth/token`, { method: "POST", headers: { ...BIZ_HEAD, Authorization: `Bearer ${access}` }, body: new URLSearchParams({ grant_type: "switch_org", access_token: access, client_id: "test", org_id: String(orgId), system: "SOLARMAN" }).toString() });
  return r.access_token ? r : null;
}

async function bizSession(creds, cached, force = false) {
  const host = clean(creds.api_url) || BIZ_HOST;
  const src = String(creds.cookie || "") + " " + String(creds.refresh_token || "") + " " + String(creds.token || "");
  // Người dùng dán cookie mới → bỏ token cũ trong bộ đệm
  const fresh = !cached || cached.src !== src.length + ":" + src.slice(-24);
  if (!force && !fresh && cached?.token && (cached.exp || 0) > Date.now() + 300e3) return { s: cached, fresh: null };
  const given = pickTokens(src);
  let refresh = (!fresh && cached?.refresh) || given.refresh;
  let access = null, exp = 0;
  if (!force && given.access && fresh && (jwtExp(given.access) || 0) > Date.now() + 300e3) { access = given.access; exp = jwtExp(given.access); }
  if (!access) {
    if (!refresh) throw new Error("Solarman Business: chưa có refresh token (hoặc token đã hết hạn). Xem hướng dẫn lấy cookie.");
    const r = await bizRefresh(host, refresh);
    access = r.access_token; refresh = r.refresh_token || refresh;
    exp = Date.now() + (num(r.expires_in) || 86400) * 1000;
  }
  try {
    const sw = await bizSwitchOrg(host, access, creds.org_id);
    if (sw) { access = sw.access_token; refresh = sw.refresh_token || refresh; exp = Date.now() + (num(sw.expires_in) || 86400) * 1000; }
  } catch {}
  const s = { token: access, host, exp, refresh, src: src.length + ":" + src.slice(-24), biz: 1 };
  return { s, fresh: s };
}

async function login(creds) {
  // Token dán tay (khi đăng nhập tự động bị captcha chặn)
  const manual = String(creds.token || "").trim().replace(/^bearer\s+/i, "");
  if (manual) {
    const host = clean(creds.api_url) || HOSTS[0];
    return { token: manual, host, exp: jwtExp(manual) || Date.now() + 30 * 86400e3 };
  }
  if (!creds.username || !creds.password) throw new Error("Solarman: cần email/SĐT + mật khẩu, hoặc dán Token");
  const pw = String(creds.password);
  const user = String(creds.username).trim();
  const form = new URLSearchParams({
    grant_type: "password", client_id: "test", system: "SOLARMAN",
    username: user, clear_text_pwd: pw, password: await sha256Hex(pw),
    identity_type: user.includes("@") ? "2" : /^\+?\d{8,}$/.test(user) ? "1" : "3",
  });
  const hosts = creds.api_url ? [clean(creds.api_url)] : HOSTS;
  let lastErr = "không đăng nhập được";
  for (const host of hosts) {
    try {
      const r = await fetchJson(`${host}/oauth-s/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": UA },
        body: form.toString(),
      });
      if (r.access_token) {
        return { token: r.access_token, host, exp: Date.now() + (num(r.expires_in) || 5184000) * 1000 };
      }
      lastErr = r.msg || r.message || r.error_description || r.error || JSON.stringify(r).slice(0, 150);
      // Sai mật khẩu/tài khoản thì dừng luôn, không thử máy chủ khác (tránh bị khoá tài khoản)
      if (/password|pwd|account|user|mật khẩu/i.test(lastErr)) break;
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  throw new Error(`Solarman: ${lastErr}. Nếu bị đòi captcha, đăng nhập home.solarmanpv.com trên máy tính rồi dán Token vào tài khoản này.`);
}

async function session(creds, cached) {
  if (cached?.token && cached.host && (cached.exp || 0) > Date.now() + 3600e3 && (!creds.token || cached.manual === creds.token)) {
    return { s: cached, fresh: null };
  }
  const s = await login(creds);
  if (creds.token) s.manual = creds.token;
  return { s, fresh: s };
}

async function call(s, method, path, body) {
  const r = await fetchJson(`${s.host}${path}`, {
    method,
    headers: { Authorization: `bearer ${s.token}`, Accept: "application/json", "User-Agent": UA, ...(body ? { "Content-Type": "application/json;charset=utf-8" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r && r.success === false) throw new Error(`Solarman ${path}: ${r.msg || r.code}`);
  return r;
}

// Gọi API; token hết hạn (401) thì đăng nhập lại 1 lần
async function withSession(creds, cached, fn, biz = false) {
  if (biz) {
    let { s, fresh } = await bizSession(creds, cached);
    try { return { out: await fn(s), fresh }; } catch (e) {
      if (!/HTTP 401|HTTP 403|invalid_token|unauthorized/i.test(String(e.message))) throw e;
      ({ s } = await bizSession(creds, s, true)); // access token hết hạn sớm → gia hạn bằng refresh token rồi thử lại 1 lần
      return { out: await fn(s), fresh: s };
    }
  }
  let { s, fresh } = await session(creds, cached);
  try {
    return { out: await fn(s), fresh };
  } catch (e) {
    if (!/HTTP 401|HTTP 403|invalid_token|unauthorized/i.test(String(e.message)) || creds.token) {
      if (creds.token && /HTTP 401|invalid_token/i.test(String(e.message))) throw new Error("Solarman: Token đã hết hạn — lấy Token mới từ home.solarmanpv.com");
      throw e;
    }
    s = await login(creds);
    return { out: await fn(s), fresh: s };
  }
}

const arr = (r) => (Array.isArray(r) ? r : r?.data || r?.list || r?.records || r?.deviceList || []);
const ymd = (date) => ({ y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) });
const batW = (o) => (num(o.dischargePower) !== null || num(o.chargePower) !== null ? (num(o.dischargePower) || 0) - (num(o.chargePower) || 0) : num(o.batteryPower));
const gridW = (o) => num(o.wirePower) ?? (num(o.buyPower) !== null || num(o.gridPower) !== null ? (num(o.buyPower) || 0) - (num(o.gridPower) || 0) : null);

async function inverters(s, stationId) {
  let list = [];
  try { list = arr(await call(s, "GET", `/maintain-s/fast/device/${stationId}/device-list?deviceType=INVERTER`)); } catch {}
  if (!list.length) {
    try { list = arr(await call(s, "POST", `/maintain-s/operating/device/search?page=1&size=20`, { stationId: Number(stationId), deviceType: "INVERTER" })); } catch {}
  }
  if (!list.length) {
    try { list = arr(await call(s, "GET", `/maintain-s/operating/system/device/INVERTER/list?siteId=${stationId}&size=20&order.direction=ASC&order.property=name`)); } catch {}
  }
  return list.filter((x) => !x.deviceType || /INVERTER/i.test(x.deviceType));
}
// Thử lần lượt các đường dẫn (bản Smart và bản Business khác nhau đôi chút)
async function first(s, paths) {
  let err;
  for (const p of paths) { try { return await call(s, "GET", p); } catch (e) { err = e; } }
  throw err;
}
const REALTIME_MAX = 40; // số trạm lấy luồng năng lượng chi tiết mỗi lượt (giới hạn request của Worker)

function make(biz) {
  const W = (creds, cached, fn) => withSession(creds, cached, fn, biz);
  return {
  ...(biz ? {
  brand: "solarman_biz",
  label: "Solarman Business (không cần API)",
  keepToken: true,
  fields: [
    { key: "cookie", label: "Dán cookie đăng nhập pro.solarmanpv.com", type: "password" },
    { key: "org_id", label: "Org ID (chỉ khi có nhiều công ty)", optional: true },
    { key: "api_url", label: "Máy chủ", placeholder: BIZ_HOST, optional: true },
  ],
  help: "Solarman Business bắt captcha khi đăng nhập nên không tự đăng nhập được. Cách lấy cookie (1 lần, dùng ~6 tháng, app tự gia hạn): mở máy tính → đăng nhập pro.solarmanpv.com bằng Chrome → bấm F12 → tab Console → gõ copy(document.cookie) rồi Enter → quay lại đây dán (Ctrl+V) vào ô cookie. Nếu báo không có refresh token: F12 → Application → Cookies → chép 2 giá trị dài bắt đầu bằng eyJ dán vào, cách nhau dấu cách.",
  } : {
  brand: "solarman_app",
  label: "Solarman Smart (đăng nhập app, không cần API)",
  fields: [
    { key: "username", label: "Email / SĐT đăng nhập app Solarman Smart" },
    { key: "password", label: "Mật khẩu Solarman (bỏ trống nếu dán Token)", type: "password", optional: true },
    { key: "token", label: "Token (chỉ khi đăng nhập bị đòi captcha)", type: "password", optional: true },
    { key: "api_url", label: "Máy chủ", placeholder: "https://globalhome.solarmanpv.com", optional: true },
  ],
  help: "Không cần mua API: dùng đúng email + mật khẩu app Solarman Smart. Nếu báo captcha: đăng nhập home.solarmanpv.com trên máy tính → F12 → Application → Cookies/Local Storage → chép giá trị token (chuỗi dài bắt đầu bằng eyJ) dán vào ô Token. Dữ liệu cập nhật 5 phút/lần, chỉ xem — chưa cài đặt từ xa.",
  }),

  async fetchStations(creds, cached) {
    const { out, fresh } = await W(creds, cached, async (s) => {
      const list = [];
      for (let page = 1; page <= 20; page++) {
        const r = biz
          ? await call(s, "POST", `/maintain-s/operating/station/v2/search?page=${page}&size=50&order.direction=ASC&order.property=name`, { station: { powerTypeList: ["PV"] } })
          : await call(s, "POST", `/maintain-s/operating/station/search?page=${page}&size=50&order.direction=ASC&order.property=name`, {
            region: { nationId: null, level1: null, level2: null, level3: null, level4: null, level5: null },
          });
        const items = arr(r).map((x) => x.station ? { ...x.station, ...x } : x);
        list.push(...items);
        if (items.length < 50 || (num(r.total) && list.length >= num(r.total))) break;
      }
      const stations = [];
      for (const [i, it] of list.entries()) {
        let f = {};
        // SỬA (07/11/2026): Solarman chặn khi gọi dồn dập (HTTP 429) → giãn 250 ms giữa các trạm
        if (i < REALTIME_MAX) { if (i) await new Promise((r) => setTimeout(r, 250)); try { f = await call(s, "GET", `/maintain-s/fast/system/${it.id}`); } catch {} }
        const t = isoFromAny(f.lastUpdateTime || it.lastUpdateTime);
        const net = String(f.networkStatus || it.networkStatus || "").toUpperCase();
        let status = net === "ALL_OFFLINE" ? "offline" : statusFromTime(t);
        if (num(it.warningStatus) > 0 || /ALARM|FAULT/.test(net) || /ALERT|FAULT|WARN/i.test(String(it.businessWarningStatus || ""))) status = "alarm";
        stations.push(station({
          ext_id: it.id,
          name: it.name,
          address: it.locationAddress || it.location?.address,
          lat: it.locationLat ?? it.location?.lat, lon: it.locationLng ?? it.location?.lng,
          capacity_kwp: it.installedCapacity,
          status,
          pv_power_w: f.generationPower ?? it.generationPower,
          load_power_w: f.usePower ?? it.usePower,
          grid_power_w: gridW(f) ?? gridW(it),
          battery_power_w: batW(f) ?? batW(it),
          battery_soc: f.batterySoc ?? it.batterySoc,
          today_kwh: f.generationValue ?? it.generationValue,
          total_kwh: f.generationTotal ?? it.generationTotal,
          data_time: t,
        }));
      }
      return stations;
    });
    return { stations: out, token: fresh };
  },

  // Toàn bộ thông số inverter giống trang thiết bị trên web Solarman (PV1..4, lưới/tải từng pha, pin, BMS, nhiệt…)
  async fetchDetail(creds, cached, stationId) {
    const { out, fresh } = await W(creds, cached, async (s) => {
      const inv = (await inverters(s, stationId))[0];
      if (!inv) throw new Error("Trạm chưa có inverter trên Solarman");
      const deviceId = num(inv.deviceId ?? inv.id);
      const body = { deviceId, language: "en", needRealTimeDataFlag: true, siteId: Number(stationId) };
      let det;
      try { det = await call(s, "POST", "/device-s/device/v3/detail", body); } catch { det = await call(s, "POST", "/device-s/device/detail", body); }
      const list = [];
      for (const cat of det.paramCategoryList || []) {
        for (const f of cat.fieldList || []) {
          list.push({ key: f.storageName || f.key, name: f.name || f.key, value: f.value, unit: f.unit, group: /bms/i.test(cat.tag || cat.name || "") ? "BMS" : cat.name });
        }
      }
      return { list, serial: det.deviceSn || inv.deviceSn, time: det.collectionTime };
    });
    return { ...out, token: fresh };
  },

  // Lịch sử lấy thẳng từ Solarman: ngày (5 phút/điểm), tháng (từng ngày), năm (từng tháng)
  async fetchHistory(creds, cached, stationId, range, date) {
    const { y, m, d } = ymd(date);
    const { out, fresh } = await W(creds, cached, async (s) => {
      const bar = (it, label, day) => ({ label, day, pv: num(it.generationValue), load: num(it.useValue), imp: num(it.buyValue), exp: num(it.gridValue), chg: num(it.chargeValue), dis: num(it.dischargeValue) });
      if (range === "month") {
        const r = await first(s, [`/maintain-s/history/batteryPower/${stationId}/stats/month?year=${y}&month=${m}`, `/maintain-s/history/power/${stationId}/stats/month?year=${y}&month=${m}`]);
        return { bars: (r.records || []).map((it, i) => { const dd = it.day || i + 1; const day = `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`; return bar(it, day.slice(8), day); }) };
      }
      if (range === "year") {
        const r = await first(s, [`/maintain-s/history/batteryPower/${stationId}/stats/year?year=${y}`, `/maintain-s/history/power/${stationId}/stats/year?year=${y}`]);
        return { bars: (r.records || []).map((it, i) => bar(it, String(it.month || i + 1).padStart(2, "0"))) };
      }
      const r = await first(s, [`/maintain-s/history/batteryPower/${stationId}/stats/daily?year=${y}&month=${m}&day=${d}`, `/maintain-s/history/power/${stationId}/record?year=${y}&month=${m}&day=${d}`]);
      const points = (r.records || []).map((it) => ({
        ts: isoFromAny(it.dateTime), pv: num(it.generationPower), load: num(it.usePower),
        grid: gridW(it), bat: batW(it), soc: num(it.batterySoc), today_kwh: null,
      })).filter((x) => x.ts && (x.pv !== null || x.load !== null)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
      return { points };
    });
    return { ...out, token: fresh };
  },

  // MỚI (07/11/2026): cảnh báo giống mục "Cảnh báo" trên web Solarman — POST /maintain-s/operating/alert/search theo trạm
  // SỬA (07/11/2026): gọi từng trạm bị Solarman chặn (HTTP 429 "limiter not allow") → lấy 1 lần cho cả tài khoản
  // (không truyền plantId, phân trang), lọc theo trạm; nếu không được mới gọi từng trạm, cách nhau 1,2 giây, gặp 429 thì dừng.
  async fetchAlarms(creds, cached, stationIds, diag = []) {
    const want = new Set(stationIds.map(String));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const URL0 = (page) => `/maintain-s/operating/alert/search?order.direction=DESC&order.property=alertTime&page=${page}&size=100&total=0`;
    const body = (plantId) => ({ deviceType: "", language: "en", level: "", startTime: "", levelList: null, ...(plantId ? { plantId: Number(plantId) } : {}) });
    const { out, fresh } = await W(creds, cached, async (s) => {
      let raw = [], whole = false;
      try {
        for (let page = 1; page <= 5; page++) {
          const r = await call(s, "POST", URL0(page), body(null));
          const items = arr(r);
          raw.push(...items);
          if (page === 1) diag.push(`toàn tài khoản: ${num(r.total) ?? items.length} mục${items[0] ? ", khoá [" + Object.keys(items[0]).join(",") + "]" : ""}`);
          if (items.length < 100) break;
          await sleep(800);
        }
        whole = true;
      } catch (e) { diag.push(`toàn tài khoản: ${String(e.message || e).slice(0, 120)}`); }
      // Một số tài khoản bắt buộc plantId → gọi từng trạm, chậm
      if (!whole) {
        for (const id of stationIds) {
          try { raw.push(...arr(await call(s, "POST", URL0(1).replace("size=100", "size=50"), body(id))).map((a) => ({ plantId: id, ...a }))); }
          catch (e) { diag.push(`${id}: ${String(e.message || e).slice(0, 100)}`); if (/429|limiter/.test(String(e.message))) break; }
          await sleep(1200);
        }
      }
      const res = [];
      const since = Date.now() - 7 * 86400e3;
      for (const a of raw) {
        if (a.plantId != null && !want.has(String(a.plantId))) continue;
        const start = a.alertTime ?? a.startTime ?? a.alarmTime;
        const end = a.recoveryTime ?? a.restoreTime ?? a.endTime ?? a.alertEndTime ?? null;
        const t = isoFromAny(start);
        if (t && new Date(t).getTime() < since) continue; // chỉ giữ 7 ngày gần nhất
        const lv = String(a.level ?? a.importance ?? a.alertLevel ?? "");
        const st = a.alertStatus ?? a.status ?? a.state;
        res.push(alarm({
          ext_id: a.plantId ?? a.stationId, code: a.code ?? a.alertCode ?? a.ruleId ?? a.alertId ?? a.showName,
          message: [a.code ? (a.addr ? a.addr + " " : "") + a.code : null, a.showName || a.alertName || a.name].filter(Boolean).join(" · ") || "Cảnh báo",
          advice: a.solution || a.suggestion || a.customAlertConfigDisplayReason, level: /^2$|^3$|fault|high|serious|urgent/i.test(lv) ? "fault" : /^0$|info|low|tip/i.test(lv) ? "info" : "warning",
          device_sn: a.deviceSn, start, end: num(end) ? end : null,
          // SỬA (07/11/2026): API trả cả lịch sử, không có giờ kết thúc → chỉ coi là đang diễn ra nếu phát sinh trong 2 giờ gần nhất
          active: (st !== undefined && st !== null ? /^(0|1|ALERT|UNRECOVERED|ACTIVE|UNHANDLED)$/i.test(String(st)) : true) && !num(end) && (!t || Date.now() - new Date(t).getTime() < 2 * 3600e3),
        }));
      }
      return res;
    });
    return { alarms: out, token: fresh };
  },
  };
}

export default make(false);
export const solarmanBiz = make(true);
