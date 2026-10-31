// Giải mã / mã hóa thanh ghi Modbus theo profile inverter.
// Port sang JavaScript từ parser của ha-solarman (MIT © David Rapan & Contributors),
// giữ nguyên quy tắc (rule 1..10, scale, offset, mask, lookup, sensors ghép…).
import { PROFILES } from "../profiles/index.js";

const DEF = { update_interval: 60, code: 0x03, min_span: 25, max_size: 125, digits: 6 };
const PARAM_KEYS = { mod: "mod", mppt: "mppt", l: "phase", pack: "pack" };
export const DEFAULT_PARAMS = { mod: 0, mppt: 4, phase: 3, pack: 1 };

const clone = (o) => JSON.parse(JSON.stringify(o));
const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function unwrap(src, key, mod) {
  const c = src[key];
  if (Array.isArray(c)) src[key] = mod < c.length ? c[mod] : c[c.length - 1];
}

function modify(src, mod) {
  for (const k of Object.keys(src)) {
    if (["scale", "min", "max", "default", "step"].includes(k)) unwrap(src, k, mod);
    if (k === "registers" && Array.isArray(src[k]) && src[k].length && Array.isArray(src[k][0])) {
      unwrap(src, k, mod);
      if (!src[k] || !src[k].length) src.disabled = true;
    } else if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k])) modify(src[k], mod);
  }
}

function enforce(src, params) {
  for (const [k, pk] of Object.entries(PARAM_KEYS)) {
    if (k in src && params[pk] !== undefined && !(src[k] <= params[pk])) return false;
  }
  return true;
}

export function getCode(item, type, dflt) {
  const c = item.code ?? item.mb_functioncode;
  if (c !== undefined && c !== null) {
    if (typeof c === "number") return type === "read" ? c : dflt;
    if (c[type] !== undefined) return c[type];
  }
  return dflt;
}

const cache = new Map();

// Chuẩn bị profile theo cấu hình (số MPPT, số pha, số pack pin…)
export function prepare(profileId, userParams = {}) {
  const params = { ...DEFAULT_PARAMS, ...userParams };
  const ck = profileId + JSON.stringify(params);
  if (cache.has(ck)) return cache.get(ck);
  const prof = PROFILES[profileId];
  if (!prof) throw new Error("Không có profile " + profileId);
  const d = { ...DEF, ...(prof.default || {}) };
  const table = {};
  if (prof.requests && !prof.requests_fine_control) {
    for (const r of prof.requests) {
      const code = r.code ?? r.mb_functioncode ?? d.code;
      for (let a = r.start; a <= r.end; a++) table[a] = code;
    }
  }
  const items = [];
  const seen = {};
  for (const group of prof.parameters) {
    const g = { ...group };
    delete g.items;
    for (const raw of group.items || []) {
      const item = clone(raw);
      if (!("platform" in item)) item.platform = "configurable" in item ? "number" : "sensor";
      modify(item, params.mod);
      if (item.sensors) {
        item.registers = [];
        for (const s of item.sensors) {
          modify(s, params.mod);
          if (s.registers?.length) {
            if (enforce(s, params)) {
              item.registers.push(...s.registers);
              if (s.multiply) { modify(s.multiply, params.mod); if (s.multiply.registers) item.registers.push(...s.multiply.registers); }
            } else s.registers = [];
          }
        }
      }
      for (const [k, v] of Object.entries(g)) {
        if (!(k in item) && v !== null && v !== undefined && (item.registers || k === "update_interval")) item[k] = v;
      }
      if (item.code === undefined && item.mb_functioncode === undefined && item.registers?.length) {
        item.code = table[Math.min(...item.registers)] ?? d.code;
      }
      if (item.sensors) {
        for (const s of item.sensors) {
          if (s.registers?.length) {
            if (s.code === undefined) s.code = item.code;
            if (s.scale === undefined && item.scale !== undefined) s.scale = item.scale;
            if (s.multiply) {
              if (s.multiply.code === undefined) s.multiply.code = s.code;
              if (s.multiply.scale === undefined && s.scale !== undefined) s.multiply.scale = s.scale;
            }
          }
        }
      }
      if (!enforce(item, params)) continue;
      if (!("name" in item) || !("rule" in item) || item.disabled) continue;
      let key = slug(item.name) + "_" + item.platform;
      if (seen[key]) key += "_" + ++seen[key]; else seen[key] = 1;
      item.key = key;
      item.groupName = group.group;
      items.push(item);
    }
  }
  // Gộp thanh ghi cần đọc thành các yêu cầu Modbus
  const regs = [];
  const seenR = new Set();
  for (const i of items) {
    if (!(i.rule > 0) || !i.registers) continue;
    const code = getCode(i, "read", d.code);
    for (const r of i.registers) {
      const k = code * 100000 + r;
      if (!seenR.has(k)) { seenR.add(k); regs.push([code, r]); }
    }
  }
  regs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const requests = [];
  let cur = null;
  for (const [code, r] of regs) {
    if (cur && cur.code === code && (d.min_span < 0 || r - cur.last <= d.min_span) && r - cur.start < d.max_size) {
      cur.last = r;
    } else {
      if (cur) requests.push([cur.code, cur.start, cur.last - cur.start + 1]);
      cur = { code, start: r, last: r };
    }
  }
  if (cur) requests.push([cur.code, cur.start, cur.last - cur.start + 1]);
  const out = { id: profileId, label: prof.label, manufacturer: prof.manufacturer, params, digits: d.digits, defaultCode: d.code, items, requests };
  cache.set(ck, out);
  return out;
}

// regs: { "3": { addr: value }, "4": {...} }
const get = (regs, code, addr) => regs?.[code]?.[addr];

function inRange(v, rule) {
  return !((rule.min !== undefined && rule.min !== null && v < rule.min) || (rule.max !== undefined && rule.max !== null && v > rule.max));
}

function readUnsigned(regs, def) {
  const code = getCode(def, "read", 3);
  if (!def.registers?.length) return null;
  let value = 0, mul = 1;
  for (const r of def.registers) {
    const t = get(regs, code, r);
    if (t === undefined) return null;
    value += (t & 0xffff) * mul;
    mul *= 65536;
  }
  if (def.range && !inRange(value, def.range)) return def.range.default ?? null;
  if (def.mask !== undefined && def.mask !== null) value = Number(BigInt(value) & BigInt(def.mask));
  if (def.bit !== undefined && def.bit !== null) value = Math.floor(value / 2 ** def.bit) & 1;
  if (def.bitmask !== undefined && def.bitmask !== null) value = Math.floor(Number(BigInt(value) & BigInt(def.bitmask)) / def.bitmask);
  if (!("lookup" in def)) {
    if (def.offset != null) value -= def.offset;
    if (def.scale != null) value *= def.scale;
    if (def.divide != null) value = Math.floor(value / def.divide);
  }
  return value;
}

function readSigned(regs, def) {
  const code = getCode(def, "read", 3);
  if (!def.registers?.length) return null;
  let value = 0, mul = 1;
  for (const r of def.registers) {
    const t = get(regs, code, r);
    if (t === undefined) return null;
    value += (t & 0xffff) * mul;
    mul *= 65536;
  }
  const maxint = mul - 1;
  if (value > Math.floor(maxint / 2)) value = def.magnitude ? -(value - (mul / 2)) : value - maxint - 1;
  if (def.range && !inRange(value, def.range)) return def.range.default ?? null;
  if (def.offset != null) value -= def.offset;
  if (def.scale != null) value *= def.scale;
  if (def.divide != null) value = Math.floor(value / def.divide);
  return value;
}

function readCustom(regs, def) {
  let value = 0;
  for (const s of def.sensors) {
    if (!s.registers?.length) continue;
    let n = "signed" in s ? readSigned(regs, s) : readUnsigned(regs, s);
    if (n === null) return null;
    if (s.multiply) {
      const c = "signed" in s.multiply ? readSigned(regs, s.multiply) : readUnsigned(regs, s.multiply);
      if (c !== null) n *= c;
    }
    if (s.validation && !inRange(n, s.validation)) {
      if (s.validation.default === undefined || s.validation.default === null) continue;
      n = s.validation.default;
    }
    switch (s.operator) {
      case "subtract": value -= n; break;
      case "multiply": value *= n; break;
      case "divide": if (n !== 0) value /= n; break;
      default: value += n;
    }
  }
  return value;
}

const bitIndex = (v) => (Array.isArray(v) ? v.reduce((a, i) => a + 2 ** i, 0) : 2 ** v);

export function lookupValue(value, dict) {
  let dflt = dict[0]?.value;
  for (const o of dict) {
    let key = "bit" in o ? bitIndex(o.bit) : o.key;
    if (o.mode === "|" && typeof key === "number" && (value & key) === key) key = value;
    if ("default" in o || key === "default") dflt = o.value;
    if (Array.isArray(key) ? key.includes(value) : key === value) return o.value;
  }
  return dflt;
}

const round = (v, digits) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return v;
  if (Number.isInteger(v)) return v;
  return digits > -1 ? Number(v.toFixed(Math.min(digits, 10))) : v;
};

function parseItem(regs, i, digits) {
  const code = getCode(i, "read", 3);
  const rr = i.registers;
  if (!rr?.length || get(regs, code, rr[0]) === undefined) return undefined;
  const vals = [];
  for (const r of rr) {
    const t = get(regs, code, r);
    if (t === undefined) return undefined;
    vals.push(t);
  }
  switch (i.rule) {
    case 1: case 3: case 2: case 4: {
      const signed = i.rule === 2 || i.rule === 4;
      let v = i.sensors ? readCustom(regs, i) : signed ? readSigned(regs, i) : readUnsigned(regs, i);
      if (v === null || v === undefined) return undefined;
      if (signed && i.inverted) v = -v;
      if (!signed && "uint" in i && v < 0) v = 0;
      if (!signed && "lookup" in i) return { v: lookupValue(i.display?.mask ? v & i.display.mask : v, i.lookup), raw: v };
      if (i.validation && !inRange(v, i.validation)) {
        if (i.validation.default === undefined || i.validation.default === null) return undefined;
        v = i.validation.default;
      }
      return { v: round(v, i.digits ?? digits), raw: v };
    }
    case 5: {
      let s = "";
      for (const t of vals) s += String.fromCharCode(t >> 8, t & 0xff);
      return { v: s.replace(/\0/g, "").trim() };
    }
    case 6: return { v: vals.map((t) => "0x" + t.toString(16)), raw: vals };
    case 7: {
      const hex = "hex" in i;
      const f = (n) => (hex ? n.toString(16) : String(n));
      let dDigit = ".", dReg = "-";
      if (typeof i.delimiter === "string") dDigit = i.delimiter;
      else if (i.delimiter && typeof i.delimiter === "object") { dDigit = i.delimiter.digit ?? "."; dReg = i.delimiter.register ?? "-"; }
      let s = vals.map((t) => [t >> 12, (t >> 8) & 15, (t >> 4) & 15, t & 15].map(f).join(dDigit)).join(vals.length > 1 ? dReg : "");
      if (i.remove) s = s.split(i.remove).join("");
      return { v: s.toUpperCase() };
    }
    case 8: {
      let p;
      if (vals.length === 3) p = [vals[0] >> 8, vals[0] & 255, vals[1] >> 8, vals[1] & 255, vals[2] >> 8, vals[2] & 255];
      else if (vals.length === 6) p = vals;
      else return undefined;
      const [y, mo, d, h, mi, s] = p;
      const z = (n) => String(n).padStart(2, "0");
      return { v: `${2000 + (y % 100)}-${z(mo)}-${z(d)} ${z(h)}:${z(mi)}:${z(s)}`, raw: vals };
    }
    case 9: {
      const hex = "hex" in i;
      const dv = hex ? (i.hex ?? 0x100) : (i.dec ?? 100);
      let fmt = (n) => (hex ? n.toString(16) : String(n)).padStart(2, "0");
      if (vals.length === 1) {
        const t = vals[0];
        return { v: `${fmt(Math.floor(t / dv))}:${fmt(t % dv)}`, raw: vals };
      }
      let s = "";
      vals.forEach((t0, idx) => {
        let t = t0;
        if (t >= dv) {
          fmt = (n) => String(n).padStart(2, "0");
          if (i.offset) t -= i.offset;
          t = Number(`${Math.floor(t / dv)}${t % dv}`);
        }
        s += fmt(t);
        if (idx === 0 || (idx === 1 && vals.length > 2)) s += ":";
      });
      return { v: s, raw: vals };
    }
    case 10: return { v: vals, raw: vals };
    default: return undefined;
  }
}

// Giải mã toàn bộ: trả về danh sách thông số có nhóm, đơn vị, giá trị
export function decode(prep, regs) {
  const out = [];
  for (const i of prep.items) {
    if (!(i.rule > 0)) continue;
    let r;
    try { r = parseItem(regs, i, prep.digits); } catch { r = undefined; }
    if (r === undefined) continue;
    out.push({
      key: i.key, name: i.name, group: i.groupName, value: r.v, raw: r.raw,
      uom: i.uom || i.unit_of_measurement || null, cls: i.class || null, platform: i.platform,
      attribute: "attribute" in i || undefined,
    });
  }
  return out;
}

// ---------- Ghi cài đặt ----------
export function settingsSchema(prep) {
  const out = [];
  for (const i of prep.items) {
    if (!["number", "select", "switch", "time", "datetime"].includes(i.platform) || !i.registers?.length) continue;
    const s = { key: i.key, name: i.name, group: i.groupName, platform: i.platform, uom: i.uom || null };
    if (i.platform === "number") {
      const cfg = i.configurable || {};
      let min = cfg.min, max = cfg.max;
      if (min === undefined && max === undefined && i.range) {
        min = i.range.min; max = i.range.max;
        if (i.scale != null) { min = min * i.scale; max = max * i.scale; }
      }
      s.min = min ?? 0; s.max = max ?? 65535;
      s.step = cfg.step ?? (i.scale && i.scale < 1 ? i.scale : 1);
      if (i.registers.length > 1) s.readonly = "Thông số 2 thanh ghi — chỉ xem";
    }
    if (i.platform === "select") s.options = [...new Set((i.lookup || []).map((o) => o.value))].filter((v) => v !== undefined);
    if (i.platform === "switch") {
      s.on = 1; s.off = 0; s.bit = null;
      if (i.value && typeof i.value === "object") {
        if ("on" in i.value) s.on = i.value.on;
        if ("off" in i.value) s.off = i.value.off;
        if ("bit" in i.value) s.bit = i.value.bit;
      }
    }
    out.push(s);
  }
  return out;
}

function toWords(v, n) {
  if (v < 0) v = v + 65536 ** n;
  const words = [];
  for (let k = 0; k < n; k++) { words.push(v % 65536); v = Math.floor(v / 65536); }
  return words; // từ thấp trước, khớp cách đọc
}

// Tính lệnh ghi. current: kết quả decode gần nhất (để lấy raw), regs: thanh ghi đã đọc
export function encodeWrite(prep, key, input, regs) {
  const i = prep.items.find((x) => x.key === key);
  if (!i) throw new Error("Không tìm thấy thông số");
  const codeRead = getCode(i, "read", 3);
  const codeWrite = getCode(i, "write", 0x10);
  const regsList = i.registers;
  const addr = Math.min(...regsList);
  const curRaw = (r) => get(regs, codeRead, r);
  let data;

  if (i.platform === "number") {
    if (regsList.length > 1) throw new Error("Thông số này không hỗ trợ ghi từ xa");
    const v = Number(input);
    if (!Number.isFinite(v)) throw new Error("Giá trị không hợp lệ");
    const sch = settingsSchema({ items: [i] })[0];
    if (v < sch.min || v > sch.max) throw new Error(`Giá trị phải từ ${sch.min} đến ${sch.max}`);
    let n = i.scale ? Math.round(v / i.scale) : Math.round(v);
    if (i.offset != null) n += i.offset;
    if (n < 0) n += 65536;
    data = [Math.min(n, 0xffff)];
  } else if (i.platform === "select") {
    const mask = i.display?.mask;
    let key = null;
    for (const o of i.lookup || []) {
      if (o.value !== input) continue;
      let k = "bit" in o ? bitIndex(o.bit) : o.key;
      if (Array.isArray(k)) k = k[0];
      if (k === null || k === undefined || k === "default") continue;
      const cur = curRaw(addr);
      if (mask) { if (cur === undefined) throw new Error("Chưa đọc được giá trị hiện tại"); key = (cur & (0xffffffff - mask)) | k; }
      else if (o.mode) { if (cur === undefined) throw new Error("Chưa đọc được giá trị hiện tại"); key = cur | k; }
      else key = k;
      break;
    }
    if (key === null) throw new Error("Lựa chọn không hợp lệ");
    data = toWords(key, regsList.length);
  } else if (i.platform === "switch") {
    let on = 1, off = 0, bit = null;
    if (i.value && typeof i.value === "object") {
      if ("on" in i.value) on = i.value.on;
      if ("off" in i.value) off = i.value.off;
      if ("bit" in i.value) bit = i.value.bit;
    }
    let v = input === true || input === "on" || input === 1 ? on : off;
    if (bit !== null) {
      const cur = curRaw(addr);
      if (cur === undefined) throw new Error("Chưa đọc được giá trị hiện tại");
      v = (cur & ~(1 << bit)) | (v << bit);
    }
    data = toWords(v, regsList.length);
  } else if (i.platform === "time") {
    const m = String(input).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) throw new Error("Giờ phải dạng HH:MM");
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) throw new Error("Giờ không hợp lệ");
    const multi = regsList.length > 1 && regsList[1] === regsList[0] + 1;
    if ("hex" in i) {
      const ch = (a, b) => parseInt(`${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`, 16);
      data = multi && i.offset >= 0x100 ? [ch(Math.floor(h / 10), h % 10) + i.offset, ch(Math.floor(mi / 10), mi % 10) + i.offset] : [ch(h, mi)];
    } else data = multi ? [h, mi] : [h * (i.dec ?? 100) + mi];
  } else if (i.platform === "datetime") {
    const d = new Date(input);
    if (isNaN(d)) throw new Error("Ngày giờ không hợp lệ");
    // Giờ Việt Nam
    const t = new Date(d.getTime() + 7 * 3600e3);
    const p = [t.getUTCFullYear() - 2000, t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()];
    data = regsList.length >= 6 ? p : [(p[0] << 8) + p[1], (p[2] << 8) + p[3], (p[4] << 8) + p[5]];
  } else throw new Error("Không ghi được loại này");

  let start = addr;
  if (i.writeback) {
    const wb = i.writeback;
    const block = [];
    for (let a = wb.register; a < wb.register + wb.count; a++) {
      const c = curRaw(a);
      if (c === undefined) throw new Error("Chưa đọc đủ thanh ghi để ghi");
      block.push(c);
    }
    for (const o of wb.overrides || []) block[o.register - wb.register] = o.value;
    data.forEach((v, idx) => (block[addr + idx - wb.register] = v));
    start = wb.register;
    data = block;
  }
  const fc = data.length === 1 && codeWrite === 6 ? 6 : 16;
  return { fc, addr: start, values: data, name: i.name };
}

export function profileList() {
  return Object.values(PROFILES).map((p) => ({ id: p.id, label: p.label, manufacturer: p.manufacturer }));
}
