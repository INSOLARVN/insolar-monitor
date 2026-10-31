// MỚI (31/10/2026): tài khoản người dùng — đăng nhập bằng email / số điện thoại + mật khẩu,
// quên mật khẩu (mã 6 số gửi email, hoặc mã khôi phục dùng 1 lần), đăng nhập Google / Apple,
// chủ hệ thống quản lý người dùng. ADMIN_PASSWORD (bí mật Worker) vẫn là mật khẩu khẩn cấp của chủ.
import { connect } from "cloudflare:sockets";
import { b64, encrypt, decrypt, hmacB64, safeEqual } from "./crypto.js";

const te = new TextEncoder(), td = new TextDecoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
const SESSION_DAYS = 30;
const COOKIE = (v, age) => `ims=${v}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;

// ---------- Bảng ----------
let ready = false;
export async function ensureAuth(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, phone TEXT UNIQUE, name TEXT,
      pw TEXT, role TEXT NOT NULL DEFAULT 'staff', google_sub TEXT UNIQUE, apple_sub TEXT UNIQUE, sv INTEGER NOT NULL DEFAULT 1,
      disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS otps (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS recovery_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code_hash TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_hits (k TEXT NOT NULL, ts INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_auth_hits ON auth_hits(k, ts)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_config (k TEXT PRIMARY KEY, v TEXT)`),
  ]);
  ready = true;
}
async function cfg(env, k) { return (await env.DB.prepare("SELECT v FROM app_config WHERE k=?1").bind(k).first())?.v ?? null; }
async function setCfg(env, k, v) {
  if (v === null || v === undefined || v === "") await env.DB.prepare("DELETE FROM app_config WHERE k=?1").bind(k).run();
  else await env.DB.prepare("INSERT OR REPLACE INTO app_config (k, v) VALUES (?1, ?2)").bind(k, v).run();
}

// ---------- Tiện ích ----------
export function normId(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? { email: s.toLowerCase() } : null;
  let d = s.replace(/[^\d+]/g, "");
  if (d.startsWith("+84")) d = "0" + d.slice(3);
  else if (d.startsWith("84") && d.length === 11) d = "0" + d.slice(2);
  d = d.replace(/\D/g, "");
  return /^0\d{8,10}$/.test(d) ? { phone: d } : null;
}
async function findUser(env, id) {
  if (!id) return null;
  return id.email
    ? env.DB.prepare("SELECT * FROM users WHERE email=?1").bind(id.email).first()
    : env.DB.prepare("SELECT * FROM users WHERE phone=?1").bind(id.phone).first();
}
const pub = (u) => u && { id: u.id, email: u.email, phone: u.phone, name: u.name, role: u.role, google: !!u.google_sub, apple: !!u.apple_sub, disabled: !!u.disabled, created_at: u.created_at, last_login: u.last_login, has_pw: !!u.pw };
const mask = (e) => (e ? e.replace(/^(.)(.*)(.@.*)$/, (_, a, b, c) => a + "*".repeat(Math.min(6, b.length)) + c) : null);
const ip = (req) => req.headers.get("CF-Connecting-IP") || "?";

async function hashPw(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$100000$${b64(salt)}$${await derive(pw, salt, 100000)}`;
}
async function derive(pw, salt, it) {
  const key = await crypto.subtle.importKey("raw", te.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return b64(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: it }, key, 256));
}
async function checkPw(pw, stored) {
  if (!stored || !pw) return false;
  const [kind, it, salt, h] = stored.split("$");
  if (kind !== "pbkdf2") return false;
  return safeEqual(h, await derive(pw, Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), Number(it)));
}
const pwRule = (pw) => (typeof pw === "string" && pw.length >= 8 && pw.length <= 128 ? null : "Mật khẩu phải từ 8 ký tự");
const codeHash = (env, uid, code) => hmacB64("SHA-256", env.ENC_KEY, `otp.${uid}.${String(code).replace(/[\s-]/g, "").toUpperCase()}`);

// Giới hạn số lần thử (chống dò mật khẩu / spam email)
async function limited(env, k, windowMs, max) {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_hits WHERE k=?1 AND ts>?2").bind(k, Date.now() - windowMs).first();
  return (n?.n || 0) >= max;
}
async function hit(env, k) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO auth_hits (k, ts) VALUES (?1, ?2)").bind(k, Date.now()),
    env.DB.prepare("DELETE FROM auth_hits WHERE ts<?1").bind(Date.now() - 86400e3),
  ]);
}

// ---------- Phiên ----------
async function sessionCookie(env, u) {
  const exp = Date.now() + SESSION_DAYS * 86400e3;
  const sig = await hmacB64("SHA-256", env.ENC_KEY, `u.${u.id}.${u.sv}.${exp}`);
  await env.DB.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?1").bind(u.id).run();
  return COOKIE(encodeURIComponent(`${u.id}.${u.sv}.${exp}.${sig}`), SESSION_DAYS * 86400);
}
export async function currentUser(req, env) {
  const m = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)ims=([^;]+)/);
  if (!m) return null;
  const [uid, sv, exp, sig] = decodeURIComponent(m[1]).split(".");
  if (!sig || Number(exp) < Date.now()) return null;
  if (!safeEqual(sig, await hmacB64("SHA-256", env.ENC_KEY, `u.${uid}.${sv}.${exp}`))) return null;
  const u = await env.DB.prepare("SELECT * FROM users WHERE id=?1").bind(Number(uid)).first();
  return u && !u.disabled && String(u.sv) === sv ? u : null;
}
const loggedIn = async (env, u, extra = {}) => json({ ok: true, user: pub(u), ...extra }, 200, { "Set-Cookie": await sessionCookie(env, u) });

// ---------- Gửi email (Gmail SMTP qua cổng 465, hoặc Resend) ----------
async function mailConf(env) {
  const raw = await cfg(env, "mail");
  return raw ? decrypt(env.ENC_KEY, raw).catch(() => null) : null;
}
const b64u8 = (s) => { const u = te.encode(s); let out = ""; for (let i = 0; i < u.length; i += 0x8000) out += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(out); };
const encWord = (s) => `=?UTF-8?B?${b64u8(s)}?=`;
async function sendMail(env, to, subject, html) {
  const mc = await mailConf(env);
  if (!mc) throw new Error("Chưa cấu hình email gửi mã (Tài khoản → Cấu hình đăng nhập)");
  if (mc.kind === "resend") {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${mc.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: mc.from, to: [to], subject, html }),
    });
    if (!r.ok) throw new Error("Resend: " + (await r.text()).slice(0, 200));
    return;
  }
  return Promise.race([smtpSend(mc, to, subject, html), new Promise((_, j) => setTimeout(() => j(new Error("Máy chủ email không phản hồi")), 25000))]);
}
async function smtpSend(mc, to, subject, html) {
  const sock = connect({ hostname: mc.host || "smtp.gmail.com", port: Number(mc.port) || 465 }, { secureTransport: "on" });
  const w = sock.writable.getWriter(), r = sock.readable.getReader();
  let buf = "";
  const reply = async () => {
    for (;;) {
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3}(?: |$)/.test(lines[i])) { const text = lines.slice(0, i + 1).join("\n"); buf = lines.slice(i + 1).join("\r\n"); return { code: Number(lines[i].slice(0, 3)), text }; }
      }
      const { value, done } = await r.read();
      if (done) throw new Error("Máy chủ email đóng kết nối");
      buf += td.decode(value, { stream: true });
    }
  };
  const cmd = async (line, ok) => {
    if (line !== null) await w.write(te.encode(line + "\r\n"));
    const res = await reply();
    if (!ok.includes(res.code)) throw new Error(res.code === 535 ? "Sai email hoặc mật khẩu ứng dụng Gmail" : "Email: " + res.text.slice(0, 180));
    return res;
  };
  try {
    await cmd(null, [220]);
    await cmd("EHLO insolar-monitor", [250]);
    await cmd("AUTH LOGIN", [334]);
    await cmd(btoa(mc.user), [334]);
    await cmd(btoa(mc.pass), [235]);
    await cmd(`MAIL FROM:<${mc.user}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd("DATA", [354]);
    const body = b64u8(html).replace(/(.{76})/g, "$1\r\n");
    const msg = [
      `From: ${encWord(mc.from_name || "INSOLAR Monitor")} <${mc.user}>`, `To: <${to}>`, `Subject: ${encWord(subject)}`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@insolar-monitor>`, "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body, ".",
    ].join("\r\n");
    await cmd(msg, [250]);
    await cmd("QUIT", [221]).catch(() => {});
  } finally {
    try { sock.close(); } catch {}
  }
}
const mailHtml = (title, code, note) => `<div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:16px">
  <h2 style="margin:0 0 8px;color:#111827">${title}</h2><p style="color:#4b5563;margin:0 0 18px">${note}</p>
  <div style="font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;padding:14px;background:#f3f4f6;border-radius:12px;color:#111827">${code}</div>
  <p style="color:#9ca3af;font-size:12px;margin:18px 0 0">Mã có hiệu lực 10 phút. Nếu không phải bạn yêu cầu, hãy bỏ qua email này.<br>INSOLAR Monitor</p></div>`;

// ---------- Xác minh token Google / Apple (RS256 + JWKS) ----------
const b64uBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
async function verifyJwt(token, jwksUrl, issuers, aud) {
  const [h, p, s] = String(token || "").split(".");
  if (!s) throw new Error("Token không hợp lệ");
  const hdr = JSON.parse(td.decode(b64uBytes(h))), pl = JSON.parse(td.decode(b64uBytes(p)));
  if (hdr.alg !== "RS256") throw new Error("Token không hợp lệ");
  const jwks = await (await fetch(jwksUrl, { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
  const jwk = (jwks.keys || []).find((k) => k.kid === hdr.kid);
  if (!jwk) throw new Error("Không tìm thấy khoá ký");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uBytes(s), te.encode(`${h}.${p}`)))) throw new Error("Chữ ký token sai");
  if (!issuers.includes(pl.iss)) throw new Error("Nguồn token sai");
  if (!(Array.isArray(pl.aud) ? pl.aud.includes(aud) : pl.aud === aud)) throw new Error("Token không dành cho ứng dụng này");
  if (!pl.exp || pl.exp * 1000 < Date.now() - 60e3) throw new Error("Token đã hết hạn");
  return pl;
}

// Đăng nhập / liên kết bằng nhà cung cấp ngoài
async function oauthLogin(req, env, provider, claims) {
  const col = provider === "google" ? "google_sub" : "apple_sub";
  const name = provider === "google" ? "Google" : "Apple";
  const linking = await currentUser(req, env);
  if (linking) {
    const other = await env.DB.prepare(`SELECT id FROM users WHERE ${col}=?1`).bind(claims.sub).first();
    if (other && other.id !== linking.id) return json({ error: `Tài khoản ${name} này đã gắn với người dùng khác` }, 409);
    await env.DB.prepare(`UPDATE users SET ${col}=?2 WHERE id=?1`).bind(linking.id, claims.sub).run();
    return json({ ok: true, linked: true });
  }
  let u = await env.DB.prepare(`SELECT * FROM users WHERE ${col}=?1`).bind(claims.sub).first();
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!u && claims.email && verified) {
    u = await env.DB.prepare("SELECT * FROM users WHERE email=?1").bind(String(claims.email).toLowerCase()).first();
    if (u) await env.DB.prepare(`UPDATE users SET ${col}=?2 WHERE id=?1`).bind(u.id, claims.sub).run();
  }
  if (!u) return json({ error: `Email ${name} ${claims.email ? "(" + claims.email + ") " : ""}chưa được cấp quyền. Nhờ chủ hệ thống thêm email này vào danh sách người dùng.` }, 403);
  if (u.disabled) return json({ error: "Tài khoản đã bị khoá" }, 403);
  return loggedIn(env, u);
}

// ---------- API công khai (chưa đăng nhập) ----------
export async function publicAuthRoutes(req, env, url) {
  const p = url.pathname, method = req.method;
  if (!p.startsWith("/api/auth/") && p !== "/api/login") return null;
  await ensureAuth(env);
  if (p === "/api/auth/config" && method === "GET") {
    return json({ google_client_id: await cfg(env, "google_client_id"), apple_service_id: await cfg(env, "apple_service_id"), email_reset: !!(await cfg(env, "mail")) });
  }
  if (method !== "POST") return json({ error: "Không hỗ trợ" }, 405);
  if (req.headers.get("X-Req") !== "1") return json({ error: "Bad request" }, 400);
  if (!env.ENC_KEY) return json({ error: "Chưa cấu hình ENC_KEY" }, 500);
  const b = await req.json().catch(() => ({}));
  const IP = ip(req);

  if (p === "/api/login" || p === "/api/auth/login") {
    if (await limited(env, "login:" + IP, 15 * 60e3, 15)) return json({ error: "Thử sai quá nhiều lần. Đợi 15 phút rồi thử lại." }, 429);
    const raw = String(b.id ?? "").trim(), pw = String(b.password || "");
    const id = normId(raw);
    // SỬA (31/10/2026): ô tài khoản để trống hoặc "admin" = chủ hệ thống đầu tiên (khi chủ chưa có email/SĐT)
    let u = id ? await findUser(env, id) : !raw || raw.toLowerCase() === "admin" ? await env.DB.prepare("SELECT * FROM users WHERE role='owner' AND disabled=0 ORDER BY id LIMIT 1").first() : null;
    if (u && !u.disabled && (await checkPw(pw, u.pw))) return loggedIn(env, u);
    // Mật khẩu khẩn cấp của chủ (bí mật ADMIN_PASSWORD trên Cloudflare)
    if (env.ADMIN_PASSWORD && safeEqual(pw, env.ADMIN_PASSWORD) && (!raw || raw.toLowerCase() === "admin" || (u && u.role === "owner") || (!u && id))) {
      let owner = u?.role === "owner" ? u : await env.DB.prepare("SELECT * FROM users WHERE role='owner' AND disabled=0 ORDER BY id LIMIT 1").first();
      if (!owner) {
        // Lần đầu: tạo chủ hệ thống bằng email / SĐT vừa nhập
        owner = await env.DB.prepare("INSERT INTO users (email, phone, name, pw, role) VALUES (?1, ?2, 'Chủ hệ thống', ?3, 'owner') RETURNING *")
          .bind(id?.email || null, id?.phone || null, await hashPw(pw)).first();
      }
      if (!u || u.id === owner.id) return loggedIn(env, owner);
    }
    await hit(env, "login:" + IP);
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: id || !raw ? "Sai tài khoản hoặc mật khẩu" : "Nhập email hoặc số điện thoại hợp lệ" }, 401);
  }

  if (p === "/api/auth/forgot") {
    const id = normId(b.id);
    if (!id) return json({ error: "Nhập email hoặc số điện thoại đã đăng ký" }, 400);
    const key = "forgot:" + (id.email || id.phone);
    if ((await limited(env, key, 3600e3, 4)) || (await limited(env, "forgotip:" + IP, 3600e3, 10))) return json({ error: "Đã gửi quá nhiều mã. Thử lại sau 1 giờ." }, 429);
    await hit(env, key); await hit(env, "forgotip:" + IP);
    const u = await findUser(env, id);
    if (u && !u.disabled && u.email) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
      await env.DB.batch([
        env.DB.prepare("UPDATE otps SET used=1 WHERE user_id=?1 AND used=0").bind(u.id),
        env.DB.prepare("INSERT INTO otps (user_id, code_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)").bind(u.id, await codeHash(env, u.id, code), Date.now() + 10 * 60e3, Date.now()),
      ]);
      try { await sendMail(env, u.email, `Mã đặt lại mật khẩu: ${code}`, mailHtml("Đặt lại mật khẩu", code, `Xin chào ${u.name || ""}, đây là mã để đặt lại mật khẩu INSOLAR Monitor của bạn.`)); }
      catch (e) { return json({ error: "Không gửi được email: " + e.message }, 502); }
    }
    // Trả lời giống nhau dù tài khoản có tồn tại hay không (tránh dò tài khoản)
    return json({ ok: true, hint: u?.email ? mask(u.email) : null });
  }

  if (p === "/api/auth/reset") {
    const id = normId(b.id), code = String(b.code || "").replace(/[\s-]/g, "").toUpperCase();
    const err = pwRule(b.password);
    if (err) return json({ error: err }, 400);
    if (!id || !code) return json({ error: "Thiếu thông tin" }, 400);
    if (await limited(env, "reset:" + IP, 15 * 60e3, 12)) return json({ error: "Thử sai quá nhiều lần. Đợi 15 phút." }, 429);
    const u = await findUser(env, id);
    let ok = false;
    if (u && !u.disabled) {
      const h = await codeHash(env, u.id, code);
      const otp = await env.DB.prepare("SELECT * FROM otps WHERE user_id=?1 AND used=0 AND expires_at>?2 ORDER BY id DESC LIMIT 1").bind(u.id, Date.now()).first();
      if (otp && otp.tries < 5) {
        if (safeEqual(otp.code_hash, h)) { ok = true; await env.DB.prepare("UPDATE otps SET used=1 WHERE id=?1").bind(otp.id).run(); }
        else await env.DB.prepare("UPDATE otps SET tries=tries+1 WHERE id=?1").bind(otp.id).run();
      }
      if (!ok) {
        const rc = await env.DB.prepare("SELECT id FROM recovery_codes WHERE user_id=?1 AND used=0 AND code_hash=?2").bind(u.id, h).first();
        if (rc) { ok = true; await env.DB.prepare("UPDATE recovery_codes SET used=1 WHERE id=?1").bind(rc.id).run(); }
      }
    }
    if (!ok) { await hit(env, "reset:" + IP); return json({ error: "Mã không đúng hoặc đã hết hạn" }, 400); }
    const nu = await env.DB.prepare("UPDATE users SET pw=?2, sv=sv+1 WHERE id=?1 RETURNING *").bind(u.id, await hashPw(b.password)).first();
    return loggedIn(env, nu);
  }

  if (p === "/api/auth/google") {
    const aud = await cfg(env, "google_client_id");
    if (!aud) return json({ error: "Chưa bật đăng nhập Google" }, 400);
    try { return await oauthLogin(req, env, "google", await verifyJwt(b.credential, "https://www.googleapis.com/oauth2/v3/certs", ["accounts.google.com", "https://accounts.google.com"], aud)); }
    catch (e) { return json({ error: "Google: " + e.message }, 401); }
  }
  if (p === "/api/auth/apple") {
    const aud = await cfg(env, "apple_service_id");
    if (!aud) return json({ error: "Chưa bật đăng nhập Apple" }, 400);
    try { return await oauthLogin(req, env, "apple", await verifyJwt(b.id_token, "https://appleid.apple.com/auth/keys", ["https://appleid.apple.com"], aud)); }
    catch (e) { return json({ error: "Apple: " + e.message }, 401); }
  }
  return json({ error: "Không tìm thấy" }, 404);
}

// ---------- API khi đã đăng nhập: tài khoản của tôi, người dùng, cấu hình ----------
export async function userRoutes(req, env, url, me) {
  const p = url.pathname, method = req.method;
  const owner = me.role === "owner";
  const body = () => req.json().catch(() => ({}));

  if (p === "/api/me" && method === "GET") {
    const rc = await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id=?1 AND used=0").bind(me.id).first();
    return json({ ok: true, user: pub(me), recovery_left: rc?.n || 0, email_reset: !!(await cfg(env, "mail")) });
  }
  if (p === "/api/me" && method === "PATCH") {
    const b = await body();
    const em = b.email ? normId(b.email) : null, ph = b.phone ? normId(b.phone) : null;
    if (b.email && !em?.email) return json({ error: "Email không hợp lệ" }, 400);
    if (b.phone && !ph?.phone) return json({ error: "Số điện thoại không hợp lệ" }, 400);
    try {
      await env.DB.prepare("UPDATE users SET name=?2, email=?3, phone=?4 WHERE id=?1").bind(me.id, String(b.name || "").slice(0, 80) || null, em?.email || null, ph?.phone || null).run();
    } catch { return json({ error: "Email hoặc số điện thoại đã có người dùng khác" }, 409); }
    return json({ ok: true });
  }
  if (p === "/api/me/password" && method === "POST") {
    const b = await body();
    if (me.pw && !(await checkPw(String(b.old || ""), me.pw))) return json({ error: "Mật khẩu hiện tại không đúng" }, 400);
    const err = pwRule(b.password);
    if (err) return json({ error: err }, 400);
    const nu = await env.DB.prepare("UPDATE users SET pw=?2, sv=sv+1 WHERE id=?1 RETURNING *").bind(me.id, await hashPw(b.password)).first();
    return loggedIn(env, nu); // đăng xuất mọi máy khác, giữ máy này
  }
  if (p === "/api/me/unlink" && method === "POST") {
    const b = await body();
    const col = b.provider === "apple" ? "apple_sub" : b.provider === "google" ? "google_sub" : null;
    if (!col) return json({ error: "Sai nhà cung cấp" }, 400);
    await env.DB.prepare(`UPDATE users SET ${col}=NULL WHERE id=?1`).bind(me.id).run();
    return json({ ok: true });
  }
  if (p === "/api/me/recovery" && method === "POST") {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const codes = [...Array(8)].map(() => [...crypto.getRandomValues(new Uint8Array(8))].map((x) => A[x % A.length]).join("").replace(/(.{4})/, "$1-"));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM recovery_codes WHERE user_id=?1").bind(me.id),
      ...(await Promise.all(codes.map(async (c) => env.DB.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?1, ?2)").bind(me.id, await codeHash(env, me.id, c))))),
    ]);
    return json({ ok: true, codes });
  }

  // ----- Chủ hệ thống: quản lý người dùng -----
  if (p === "/api/users" || p.startsWith("/api/users/") || p === "/api/auth-config" || p === "/api/auth-config/test") {
    if (!owner) return json({ error: "Chỉ chủ hệ thống được làm việc này" }, 403);
  }
  if (p === "/api/users" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY role DESC, id").all();
    return json(results.map(pub));
  }
  if (p === "/api/users" && method === "POST") {
    const b = await body();
    const em = b.email ? normId(b.email) : null, ph = b.phone ? normId(b.phone) : null;
    if (!em?.email && !ph?.phone) return json({ error: "Cần email hoặc số điện thoại hợp lệ" }, 400);
    const err = b.password ? pwRule(b.password) : null;
    if (err) return json({ error: err }, 400);
    try {
      const u = await env.DB.prepare("INSERT INTO users (email, phone, name, pw, role) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *")
        .bind(em?.email || null, ph?.phone || null, String(b.name || "").slice(0, 80) || null, b.password ? await hashPw(b.password) : null, b.role === "owner" ? "owner" : "staff").first();
      return json({ ok: true, user: pub(u) });
    } catch { return json({ error: "Email hoặc số điện thoại đã tồn tại" }, 409); }
  }
  let m = p.match(/^\/api\/users\/(\d+)$/);
  if (m && method === "PATCH") {
    const id = Number(m[1]), b = await body();
    if (id === me.id && (b.disabled || b.role === "staff")) return json({ error: "Không thể tự khoá hoặc tự hạ quyền chính mình" }, 400);
    const sets = [], args = [id];
    if ("disabled" in b) { args.push(b.disabled ? 1 : 0); sets.push(`disabled=?${args.length}`); }
    if ("role" in b) { args.push(b.role === "owner" ? "owner" : "staff"); sets.push(`role=?${args.length}`); }
    if (b.password) {
      const err = pwRule(b.password);
      if (err) return json({ error: err }, 400);
      args.push(await hashPw(b.password)); sets.push(`pw=?${args.length}`); sets.push("sv=sv+1");
    }
    if (!sets.length) return json({ ok: true });
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?1`).bind(...args).run();
    return json({ ok: true });
  }
  if (m && method === "DELETE") {
    const id = Number(m[1]);
    if (id === me.id) return json({ error: "Không thể tự xoá chính mình" }, 400);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM users WHERE id=?1").bind(id),
      env.DB.prepare("DELETE FROM otps WHERE user_id=?1").bind(id),
      env.DB.prepare("DELETE FROM recovery_codes WHERE user_id=?1").bind(id),
    ]);
    return json({ ok: true });
  }

  // ----- Chủ hệ thống: cấu hình đăng nhập -----
  if (p === "/api/auth-config" && method === "GET") {
    const mc = await mailConf(env);
    return json({ google_client_id: await cfg(env, "google_client_id"), apple_service_id: await cfg(env, "apple_service_id"),
      mail: mc ? { kind: mc.kind, user: mc.user, from: mc.from, from_name: mc.from_name, host: mc.host, port: mc.port } : null });
  }
  if (p === "/api/auth-config" && method === "POST") {
    const b = await body();
    if ("google_client_id" in b) {
      const v = String(b.google_client_id || "").trim();
      if (v && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(v)) return json({ error: "Client ID Google có dạng ….apps.googleusercontent.com" }, 400);
      await setCfg(env, "google_client_id", v);
    }
    if ("apple_service_id" in b) await setCfg(env, "apple_service_id", String(b.apple_service_id || "").trim());
    if ("mail" in b) {
      const x = b.mail;
      if (!x) await setCfg(env, "mail", null);
      else {
        const old = await mailConf(env);
        const mc = x.kind === "resend"
          ? { kind: "resend", key: x.key || old?.key, from: String(x.from || "").trim() }
          : { kind: "smtp", user: String(x.user || "").trim(), pass: String(x.pass || "").replace(/\s/g, "") || old?.pass, from_name: x.from_name || "INSOLAR Monitor", host: x.host || "smtp.gmail.com", port: Number(x.port) || 465 };
        if (mc.kind === "smtp" && (!/@/.test(mc.user) || !mc.pass)) return json({ error: "Nhập Gmail và mật khẩu ứng dụng" }, 400);
        if (mc.kind === "resend" && (!mc.key || !mc.from)) return json({ error: "Nhập khoá Resend và địa chỉ gửi" }, 400);
        await setCfg(env, "mail", await encrypt(env.ENC_KEY, mc));
      }
    }
    return json({ ok: true });
  }
  if (p === "/api/auth-config/test" && method === "POST") {
    const b = await body();
    const to = normId(b.to)?.email || me.email;
    if (!to) return json({ error: "Nhập email nhận thử" }, 400);
    try { await sendMail(env, to, "Thử gửi email — INSOLAR Monitor", mailHtml("Gửi email thành công", "OK", "Cấu hình email gửi mã của INSOLAR Monitor đã hoạt động.")); }
    catch (e) { return json({ error: e.message }, 502); }
    return json({ ok: true, to });
  }
  return null;
}
