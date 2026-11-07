// MỚI (07/11/2026): Solarman qua đăng nhập kiểu app Solarman Smart / web home.solarmanpv.com
// Lý do: OpenAPI của Solarman (App ID/App Secret) là dịch vụ trả phí → dùng chính API mà app/web dùng,
// chỉ cần email + mật khẩu Solarman. API không công khai, Solarman có thể đổi bất cứ lúc nào.
// Nếu web bắt captcha khi đăng nhập: dán "Token" lấy từ trình duyệt (xem help) — token sống ~60 ngày.
import { sha256Hex } from "../crypto.js";
import { fetchJson, station, num, isoFromAny, statusFromTime } from "./util.js";

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
async function withSession(creds, cached, fn) {
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
  return list.filter((x) => !x.deviceType || /INVERTER/i.test(x.deviceType));
}

export default {
  brand: "solarman_app",
  label: "Solarman Smart (đăng nhập app, không cần API)",
  fields: [
    { key: "username", label: "Email / SĐT đăng nhập app Solarman Smart" },
    { key: "password", label: "Mật khẩu Solarman (bỏ trống nếu dán Token)", type: "password", optional: true },
    { key: "token", label: "Token (chỉ khi đăng nhập bị đòi captcha)", type: "password", optional: true },
    { key: "api_url", label: "Máy chủ", placeholder: "https://globalhome.solarmanpv.com", optional: true },
  ],
  help: "Không cần mua API: dùng đúng email + mật khẩu app Solarman Smart. Nếu báo captcha: đăng nhập home.solarmanpv.com trên máy tính → F12 → Application → Cookies/Local Storage → chép giá trị token (chuỗi dài bắt đầu bằng eyJ) dán vào ô Token. Dữ liệu cập nhật 5 phút/lần, chỉ xem — chưa cài đặt từ xa.",

  async fetchStations(creds, cached) {
    const { out, fresh } = await withSession(creds, cached, async (s) => {
      const list = [];
      for (let page = 1; page <= 20; page++) {
        const r = await call(s, "POST", `/maintain-s/operating/station/search?page=${page}&size=50&order.direction=ASC&order.property=name`, {
          region: { nationId: null, level1: null, level2: null, level3: null, level4: null, level5: null },
        });
        const items = arr(r).map((x) => x.station ? { ...x.station, ...x } : x);
        list.push(...items);
        if (items.length < 50 || (num(r.total) && list.length >= num(r.total))) break;
      }
      const stations = [];
      for (const it of list) {
        let f = {};
        try { f = await call(s, "GET", `/maintain-s/fast/system/${it.id}`); } catch {}
        const t = isoFromAny(f.lastUpdateTime || it.lastUpdateTime);
        const net = String(f.networkStatus || it.networkStatus || "").toUpperCase();
        let status = net === "ALL_OFFLINE" ? "offline" : statusFromTime(t);
        if (num(it.warningStatus) > 0 || /ALARM|FAULT/.test(net)) status = "alarm";
        stations.push(station({
          ext_id: it.id,
          name: it.name,
          address: it.locationAddress || it.location?.address,
          lat: it.locationLat ?? it.location?.lat, lon: it.locationLng ?? it.location?.lng,
          capacity_kwp: it.installedCapacity,
          status,
          pv_power_w: f.generationPower ?? it.generationPower,
          load_power_w: f.usePower ?? it.usePower,
          grid_power_w: gridW(f),
          battery_power_w: batW(f),
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
    const { out, fresh } = await withSession(creds, cached, async (s) => {
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
    const { out, fresh } = await withSession(creds, cached, async (s) => {
      const bar = (it, label, day) => ({ label, day, pv: num(it.generationValue), load: num(it.useValue), imp: num(it.buyValue), exp: num(it.gridValue), chg: num(it.chargeValue), dis: num(it.dischargeValue) });
      if (range === "month") {
        const r = await call(s, "GET", `/maintain-s/history/batteryPower/${stationId}/stats/month?year=${y}&month=${m}`);
        return { bars: (r.records || []).map((it, i) => { const dd = it.day || i + 1; const day = `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`; return bar(it, day.slice(8), day); }) };
      }
      if (range === "year") {
        const r = await call(s, "GET", `/maintain-s/history/batteryPower/${stationId}/stats/year?year=${y}`);
        return { bars: (r.records || []).map((it, i) => bar(it, String(it.month || i + 1).padStart(2, "0"))) };
      }
      const r = await call(s, "GET", `/maintain-s/history/batteryPower/${stationId}/stats/daily?year=${y}&month=${m}&day=${d}`);
      const points = (r.records || []).map((it) => ({
        ts: isoFromAny(it.dateTime), pv: num(it.generationPower), load: num(it.usePower),
        grid: gridW(it), bat: batW(it), soc: num(it.batterySoc), today_kwh: null,
      })).filter((x) => x.ts && (x.pv !== null || x.load !== null)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
      return { points };
    });
    return { ...out, token: fresh };
  },
};
