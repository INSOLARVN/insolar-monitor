// Tiện ích mã hóa / băm dùng Web Crypto của Cloudflare Workers
const te = new TextEncoder();
const td = new TextDecoder();

export const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", te.encode(text)));
}

export async function md5B64(text) {
  return b64(await crypto.subtle.digest("MD5", te.encode(text)));
}

export async function hmacB64(algo, key, msg) {
  const k = await crypto.subtle.importKey("raw", te.encode(key), { name: "HMAC", hash: algo }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", k, te.encode(msg)));
}

async function aesKey(secret) {
  const raw = await crypto.subtle.digest("SHA-256", te.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(secret, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), te.encode(JSON.stringify(obj)));
  return b64(iv) + "." + b64(ct);
}

export async function decrypt(secret, s) {
  if (!s) return null;
  const [iv, ct] = s.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(secret), unb64(ct));
  return JSON.parse(td.decode(pt));
}

export function randomToken(n = 18) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, n * 2);
}

// So sánh chuỗi thời gian hằng số
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
