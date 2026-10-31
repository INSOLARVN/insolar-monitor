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

export function decodeBms(kind, frames) {
  if (kind === "jbd") return decodeJbd(frames);
  if (kind === "daly") return decodeDaly(frames);
  return null;
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
