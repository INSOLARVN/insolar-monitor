// Giải mã dữ liệu BMS đọc trực tiếp (UART/RS485/Bluetooth) — từng cell pin.
// JBD / Xiaoxiang (lệnh 0x03 thông tin chung, 0x04 điện áp cell) và Daly (0x90–0x96).

const hexToBytes = (h) => (String(h).match(/../g) || []).map((x) => parseInt(x, 16));
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const s16be = (b, i) => { const v = u16be(b, i); return v > 32767 ? v - 65536 : v; };

const JBD_PROT = ["Quá áp cell", "Thấp áp cell", "Quá áp tổng", "Thấp áp tổng", "Quá nhiệt khi sạc", "Nhiệt thấp khi sạc",
  "Quá nhiệt khi xả", "Nhiệt thấp khi xả", "Quá dòng sạc", "Quá dòng xả", "Ngắn mạch", "Lỗi IC đo", "Khóa MOS"];

// Gói JBD: DD cmd status len data... chk(2) 77
function jbdPayload(hex) {
  const b = hexToBytes(hex);
  if (b[0] !== 0xdd || b.length < 7) return null;
  const len = b[3];
  if (b[2] !== 0x00 || b.length < 4 + len + 3) return null;
  const data = b.slice(4, 4 + len);
  let sum = 0;
  for (let i = 2; i < 4 + len; i++) sum += b[i];
  const chk = (0x10000 - sum) & 0xffff;
  if (((b[4 + len] << 8) | b[5 + len]) !== chk) return null;
  return data;
}

export function decodeJbd(frames) {
  const r = { type: "JBD / Xiaoxiang" };
  const basic = frames?.["03"] && jbdPayload(frames["03"]);
  if (basic && basic.length >= 23) {
    const b = basic;
    r.voltage = u16be(b, 0) / 100;
    r.current = s16be(b, 2) / 100;
    r.remaining_ah = u16be(b, 4) / 100;
    r.capacity_ah = u16be(b, 6) / 100;
    r.cycles = u16be(b, 8);
    const d = u16be(b, 10);
    r.production_date = `${2000 + (d >> 9)}-${String((d >> 5) & 15).padStart(2, "0")}-${String(d & 31).padStart(2, "0")}`;
    const bal = u16be(b, 12) | (u16be(b, 14) << 16);
    const prot = u16be(b, 16);
    r.protections = JBD_PROT.filter((_, i) => prot & (1 << i));
    r.sw_version = `${b[18] >> 4}.${b[18] & 15}`;
    r.soc = b[19];
    r.charge_mos = !!(b[20] & 1);
    r.discharge_mos = !!(b[20] & 2);
    r.cell_count = b[21];
    const ntc = b[22];
    r.temperatures = [];
    for (let i = 0; i < ntc && 23 + i * 2 + 1 < b.length; i++) r.temperatures.push(+((u16be(b, 23 + i * 2) - 2731) / 10).toFixed(1));
    r.balancing = [];
    for (let i = 0; i < r.cell_count; i++) if (bal & (1 << i)) r.balancing.push(i + 1);
    r.power = Math.round(r.voltage * r.current);
  }
  const cells = frames?.["04"] && jbdPayload(frames["04"]);
  if (cells) {
    r.cells = [];
    for (let i = 0; i + 1 < cells.length; i += 2) r.cells.push(u16be(cells, i) / 1000);
  }
  return finish(r);
}

// Gói Daly: A5 01 cmd 08 data(8) chk — frames: {"90": "hex", "91": ..., "95": ["hex", ...], "96": [...]}
function dalyData(hex) {
  const b = hexToBytes(hex);
  if (b[0] !== 0xa5 || b.length < 13) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += b[i];
  if ((sum & 0xff) !== b[12]) return null;
  return b.slice(4, 12);
}

export function decodeDaly(frames) {
  const r = { type: "Daly" };
  const f90 = frames?.["90"] && dalyData(frames["90"]);
  if (f90) {
    r.voltage = u16be(f90, 0) / 10;
    r.current = (u16be(f90, 4) - 30000) / 10;
    r.soc = u16be(f90, 6) / 10;
    r.power = Math.round(r.voltage * r.current);
  }
  const f93 = frames?.["93"] && dalyData(frames["93"]);
  if (f93) {
    r.charge_mos = !!f93[1];
    r.discharge_mos = !!f93[2];
    r.cycles = f93[3];
    r.remaining_ah = ((f93[4] << 24) | (f93[5] << 16) | (f93[6] << 8) | f93[7]) / 1000;
  }
  const f94 = frames?.["94"] && dalyData(frames["94"]);
  if (f94) r.cell_count = f94[0];
  const list95 = [].concat(frames?.["95"] || []);
  if (list95.length) {
    const cells = [];
    for (const h of list95) {
      const d = dalyData(h);
      if (!d) continue;
      const idx = (d[0] - 1) * 3;
      for (let k = 0; k < 3; k++) cells[idx + k] = u16be(d, 1 + k * 2) / 1000;
    }
    r.cells = cells.slice(0, r.cell_count || cells.length).filter((v) => v !== undefined);
  }
  const list96 = [].concat(frames?.["96"] || []);
  if (list96.length) {
    r.temperatures = [];
    for (const h of list96) {
      const d = dalyData(h);
      if (d) for (let k = 1; k < 8; k++) if (d[k] && d[k] !== 0xff) r.temperatures.push(d[k] - 40);
    }
  }
  return finish(r);
}

function finish(r) {
  if (r.cells?.length) {
    const v = r.cells.filter((x) => x > 0.5);
    if (v.length) {
      r.cell_v_max = Math.max(...v);
      r.cell_v_min = Math.min(...v);
      r.cell_v_avg = +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3);
      r.cell_delta_mv = Math.round((r.cell_v_max - r.cell_v_min) * 1000);
      r.cell_max_index = r.cells.indexOf(r.cell_v_max) + 1;
      r.cell_min_index = r.cells.indexOf(r.cell_v_min) + 1;
    }
  }
  if (r.capacity_ah && r.remaining_ah !== undefined && r.soh === undefined) r.soh = null;
  return r;
}

// ================= MỚI (13/11/2026): Top BMS — BMS pin cao áp (tài liệu hãng "HV BMS Modbus Protocol V3.0") =================
// Modbus RTU 9600 8N1, địa chỉ 0x01, lệnh 03. Số liệu theo đúng đơn vị tài liệu; dòng: + = SẠC, - = XẢ (ngược quy ước app).
function crc16(b) {
  let c = 0xffff;
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1; }
  return c;
}
export function mbReq(slave, fc, addr, count) {
  const b = [slave, fc, addr >> 8, addr & 255, count >> 8, count & 255];
  const c = crc16(b);
  return [...b, c & 255, c >> 8].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}
// Khung trả về 01 03 N data CRC → mảng thanh ghi 16 bit (null nếu sai CRC/độ dài/ngoại lệ)
function mbRegs(hex) {
  const b = hexToBytes(hex);
  if (b.length < 5 || b[1] !== 0x03) return null;
  const n = b[2];
  if (b.length < 5 + n) return null;
  const c = crc16(b.slice(0, 3 + n));
  if (b[3 + n] !== (c & 255) || b[4 + n] !== c >> 8) return null;
  const r = [];
  for (let i = 0; i < n; i += 2) r.push(u16be(b, 3 + i));
  return r;
}
const s16 = (v) => (v > 32767 ? v - 65536 : v);
const TOP_BITS = ["Quá áp tổng", "Thấp áp tổng", "Quá áp cell", "Thấp áp cell", "Quá nhiệt khi sạc", "Nhiệt thấp khi sạc", "Lệch áp cell cao",
  "Quá dòng sạc", "Quá dòng xả", "SOC thấp", "Quá nhiệt khi xả", "Nhiệt thấp khi xả", "Lệch nhiệt độ cao", "Cách điện thấp", "SOC cao"];
const bitsOf = (v, names) => names.filter((_, i) => v & (1 << i));
const ver = (v) => (v ? "V" + v.toString(16).split("").join(".") : null);
// Thông số cài đặt BMS (chỉ đọc để hiển thị) — [địa chỉ, tên, hệ số, đơn vị, có dấu]
// 0xA5/0xA6 (lệch áp cell): tài liệu ghi đơn vị 0,1% nhưng giống chép nhầm → hiện số thô, không đơn vị.
const TOP_SET = [
  [0x82, "Shunt (A/75mV)", 1, "A"], [0x83, "Cell quá áp – cảnh báo", 1, "mV"], [0x84, "Cell quá áp – bảo vệ", 1, "mV"], [0x85, "Cell quá áp – hết bảo vệ", 1, "mV"],
  [0x86, "Cell quá áp – trễ", 1, "ms"], [0x87, "Cell thấp áp – cảnh báo", 1, "mV"], [0x88, "Cell thấp áp – bảo vệ", 1, "mV"], [0x89, "Cell thấp áp – hết bảo vệ", 1, "mV"],
  [0x8a, "Cell thấp áp – trễ", 1, "ms"], [0x8b, "Tổng quá áp – cảnh báo", 0.1, "V"], [0x8c, "Tổng quá áp – bảo vệ", 0.1, "V"], [0x8d, "Tổng quá áp – hết bảo vệ", 0.1, "V"],
  [0x8e, "Tổng quá áp – trễ", 1, "ms"], [0x8f, "Tổng thấp áp – cảnh báo", 0.1, "V"], [0x90, "Tổng thấp áp – bảo vệ", 0.1, "V"], [0x91, "Tổng thấp áp – hết bảo vệ", 0.1, "V"],
  [0x92, "Tổng thấp áp – trễ", 1, "ms"], [0x93, "Sạc quá nhiệt – cảnh báo", 1, "°C", 1], [0x94, "Sạc quá nhiệt – bảo vệ", 1, "°C", 1], [0x95, "Sạc quá nhiệt – hết bảo vệ", 1, "°C", 1],
  [0x96, "Sạc nhiệt thấp – cảnh báo", 1, "°C", 1], [0x97, "Sạc nhiệt thấp – bảo vệ", 1, "°C", 1], [0x98, "Sạc nhiệt thấp – hết bảo vệ", 1, "°C", 1],
  [0x99, "Quá dòng sạc – cảnh báo", 0.1, "A"], [0x9a, "Quá dòng sạc – bảo vệ", 0.1, "A"], [0x9b, "Quá dòng sạc – trễ", 1, "ms"],
  [0x9c, "Quá dòng xả – cảnh báo", 0.1, "A"], [0x9d, "Quá dòng xả – bảo vệ", 0.1, "A"], [0x9e, "Quá dòng xả – trễ", 1, "ms"],
  [0x9f, "Cân bằng – áp cell bắt đầu", 1, "mV"], [0xa0, "Cân bằng – chênh áp bắt đầu", 1, "mV"], [0xa1, "SOC thấp – cảnh báo", 0.1, "%"], [0xa2, "SOC thấp – bảo vệ", 0.1, "%"],
  [0xa3, "SOC cao – cảnh báo", 0.1, "%"], [0xa4, "SOC cao – bảo vệ", 0.1, "%"], [0xa5, "Lệch áp cell – cảnh báo (số thô)", 1, ""], [0xa6, "Lệch áp cell – bảo vệ (số thô)", 1, ""],
  [0xa7, "Xả quá nhiệt – cảnh báo", 1, "°C", 1], [0xa8, "Xả quá nhiệt – bảo vệ", 1, "°C", 1], [0xa9, "Xả quá nhiệt – hết bảo vệ", 1, "°C", 1],
  [0xaa, "Xả nhiệt thấp – cảnh báo", 1, "°C", 1], [0xab, "Xả nhiệt thấp – bảo vệ", 1, "°C", 1], [0xac, "Xả nhiệt thấp – hết bảo vệ", 1, "°C", 1],
  [0xad, "Lệch nhiệt – cảnh báo", 1, "°C"], [0xae, "Lệch nhiệt – bảo vệ", 1, "°C"], [0xaf, "Quá dòng sạc – thời gian tự phục hồi", 0.1, "s"], [0xb0, "Quá dòng xả – thời gian tự phục hồi", 0.1, "s"],
  [0xb1, "Quạt – nhiệt độ bật", 1, "°C", 1], [0xb2, "Quạt – nhiệt độ tắt", 1, "°C", 1], [0xb3, "Sưởi – nhiệt độ bật", 1, "°C", 1], [0xb4, "Sưởi – nhiệt độ tắt", 1, "°C", 1],
  [0xb5, "Áp sạc pin", 0.1, "V"], [0xb6, "Áp xả pin (cắt)", 0.1, "V"], [0xb7, "Giới hạn dòng sạc", 0.1, "A"], [0xb8, "Giới hạn dòng xả", 0.1, "A"],
];
// Lệnh hỏi: khối trạng thái 0x40, tham số 0x7E/0x80/0xA3; nhiệt độ 0x100 và cell 0x200 theo số cell/số cảm biến BMS báo (0x80/0x81)
export function topbmsRequests(info = {}) {
  const q = { "40": mbReq(1, 3, 0x40, 27), "7E": mbReq(1, 3, 0x7e, 2), "80": mbReq(1, 3, 0x80, 35), "A3": mbReq(1, 3, 0xa3, 22) };
  if (info.temps > 0) q["100"] = mbReq(1, 3, 0x100, Math.min(info.temps, 64));
  for (let i = 0; i < Math.min(info.cells || 0, 256); i += 64) q[(0x200 + i).toString(16).toUpperCase()] = mbReq(1, 3, 0x200 + i, Math.min(64, info.cells - i));
  return q;
}
export function topbmsInfo(frames) {
  const p = frames?.["80"] && mbRegs(frames["80"]);
  return p && p.length >= 2 ? { cells: p[0], temps: p[1] } : null;
}
export function decodeTopBms(frames) {
  const r = { type: "Top BMS (cao áp)", current_charge_positive: true };
  const a = frames?.["40"] && mbRegs(frames["40"]);
  if (a && a.length >= 27) {
    const g = (addr) => a[addr - 0x40];
    r.state = ["Bình thường", "Cảnh báo", "Bảo vệ"][g(0x40)] ?? String(g(0x40));
    r.voltage = g(0x41) / 10;
    r.current = s16(g(0x42)) / 10;
    r.charge_limit = g(0x43) / 10;
    r.discharge_limit = g(0x44) / 10;
    r.soc = g(0x45) / 10;
    r.bms_cell_max = g(0x46) / 1000; r.bms_cell_max_no = g(0x47);
    r.bms_cell_min = g(0x49) / 1000; r.bms_cell_min_no = g(0x4a);
    r.temp_max = s16(g(0x4c)); r.temp_max_no = g(0x4d);
    r.temp_min = s16(g(0x4f)); r.temp_min_no = g(0x50);
    r.relays = [1, 2, 3, 4, 5, 6].map((i) => ({ no: i, on: !!(g(0x52) & (1 << (i - 1))) }));
    r.alarms = bitsOf(g(0x53), TOP_BITS);
    r.protections = bitsOf(g(0x54), TOP_BITS);
    r.remaining_ah = g(0x57) / 100;
    r.full_ah = g(0x58) / 100;
    r.capacity_ah = g(0x59) / 100;
    r.cycles = g(0x5a);
  }
  const v = frames?.["7E"] && mbRegs(frames["7E"]);
  if (v && v.length >= 2) { r.hw_version = ver(v[0]); r.sw_version = ver(v[1]); }
  const p80 = frames?.["80"] && mbRegs(frames["80"]), pA3 = frames?.["A3"] && mbRegs(frames["A3"]);
  if (p80) { r.cell_count = p80[0]; r.temp_count = p80[1]; }
  const reg = (addr) => (p80 && addr >= 0x80 && addr - 0x80 < p80.length ? p80[addr - 0x80] : pA3 && addr >= 0xa3 && addr - 0xa3 < pA3.length ? pA3[addr - 0xa3] : undefined);
  r.settings = TOP_SET.map(([addr, name, k, uom, signed]) => {
    const raw = reg(addr);
    if (raw === undefined) return null;
    return { addr: "0x" + addr.toString(16).toUpperCase(), name, value: +((signed ? s16(raw) : raw) * k).toFixed(3), uom };
  }).filter(Boolean);
  const t = frames?.["100"] && mbRegs(frames["100"]);
  if (t) r.temperatures = t.map(s16);
  // Cell: các khối 0x200, 0x240, 0x280… ghép lại theo thứ tự; khối nào lỗi thì cell đó để trống
  if (r.cell_count) {
    const cells = new Array(r.cell_count).fill(null);
    for (let i = 0; i < r.cell_count; i += 64) {
      const blk = frames?.[(0x200 + i).toString(16).toUpperCase()];
      const regs = blk && mbRegs(blk);
      if (regs) regs.forEach((x, k) => { if (i + k < cells.length) cells[i + k] = x / 1000; });
    }
    if (cells.some((x) => x !== null)) r.cells = cells;
  }
  return finishTop(r);
}
function finishTop(r) {
  const res = finish({ ...r, cells: r.cells ? r.cells.map((x) => x ?? 0) : undefined });
  if (r.cells) res.cells = r.cells.map((x) => x ?? null);
  return res;
}

export function decodeBms(kind, frames) {
  if (kind === "jbd") return decodeJbd(frames);
  if (kind === "daly") return decodeDaly(frames);
  if (kind === "topbms") return decodeTopBms(frames);
  return null;
}

// MỚI (13/11/2026): lệnh hỏi theo loại BMS; Top BMS cần biết số cell/cảm biến (đọc được ở lần hỏi đầu) để hỏi đủ cell
export function bmsRequests(kind, info) {
  return kind === "topbms" ? topbmsRequests(info || {}) : BMS_REQUESTS[kind];
}

// Lệnh hỏi BMS (gateway gửi đi nguyên văn)
export const BMS_REQUESTS = {
  jbd: { "03": "DDA50300FFFD77", "04": "DDA50400FFFC77" },
  daly: { "90": "A5409008000000000000000000000000000000000000".slice(0, 26), "93": "", "94": "", "95": "", "96": "" },
};
(function buildDaly() {
  for (const c of ["90", "91", "92", "93", "94", "95", "96"]) {
    const b = [0xa5, 0x40, parseInt(c, 16), 0x08, 0, 0, 0, 0, 0, 0, 0, 0];
    const sum = b.reduce((a, x) => a + x, 0) & 0xff;
    BMS_REQUESTS.daly[c] = [...b, sum].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
})();
