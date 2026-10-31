// Giải mã khung CAN giữa pin và inverter (nghe thụ động, 500 kbit/s).
// Giao thức Pylontech LV CAN (Deye, Growatt, Sofar, Solis… đều dùng chung khi chọn "PYL"/"Lithium 00"),
// cộng các khung mở rộng 0x370–0x373 theo kiểu Victron mà nhiều BMS (JK, Seplos, Pace…) gửi kèm.

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const s16 = (b, i) => { const v = u16(b, i); return v > 32767 ? v - 65536 : v; };
const hexToBytes = (h) => (String(h).match(/../g) || []).map((x) => parseInt(x, 16));
const bits = (byte, map) => Object.entries(map).filter(([bit]) => byte & (1 << Number(bit))).map(([, name]) => name);

const PROT0 = { 1: "Quá áp cell", 2: "Thấp áp cell", 3: "Quá nhiệt", 4: "Nhiệt độ thấp", 7: "Quá dòng xả" };
const PROT1 = { 0: "Quá dòng sạc", 3: "Lỗi hệ thống BMS" };
const ALM0 = { 1: "Điện áp cao", 2: "Điện áp thấp", 3: "Nhiệt độ cao", 4: "Nhiệt độ thấp", 7: "Dòng xả cao" };
const ALM1 = { 0: "Dòng sạc cao", 3: "Mất liên lạc nội bộ" };
const REQ = { 7: "Cho phép sạc", 6: "Cho phép xả", 5: "Yêu cầu sạc cưỡng bức 1", 4: "Yêu cầu sạc cưỡng bức 2", 3: "Yêu cầu sạc đầy" };

// frames: [[id, "hex"], ...] (khung mới nhất của mỗi ID)
export function decodeCan(frames) {
  const r = { protocol: null, frames: [], alarms: [], protections: [], flags: [] };
  const known = new Set();
  for (const [idRaw, hex] of frames || []) {
    const id = typeof idRaw === "string" ? parseInt(idRaw, 16) : idRaw;
    const b = hexToBytes(hex);
    r.frames.push({ id: "0x" + id.toString(16).toUpperCase().padStart(3, "0"), data: String(hex).toUpperCase() });
    if (b.length < 2) continue;
    switch (id) {
      case 0x351:
        known.add(id);
        r.charge_voltage_limit = u16(b, 0) / 10;
        r.charge_current_limit = s16(b, 2) / 10;
        r.discharge_current_limit = s16(b, 4) / 10;
        if (b.length >= 8 && u16(b, 6)) r.discharge_voltage_limit = u16(b, 6) / 10;
        break;
      case 0x355:
        known.add(id);
        r.soc = u16(b, 0);
        r.soh = u16(b, 2);
        if (b.length >= 6 && u16(b, 4)) r.soc_hr = u16(b, 4) / 100;
        break;
      case 0x356:
        known.add(id);
        r.voltage = s16(b, 0) / 100;
        r.current = s16(b, 2) / 10;
        r.temperature = s16(b, 4) / 10;
        r.power = Math.round(r.voltage * r.current);
        break;
      case 0x359:
        known.add(id);
        r.protections = [...bits(b[0], PROT0), ...bits(b[1], PROT1)];
        r.alarms = [...bits(b[2] ?? 0, ALM0), ...bits(b[3] ?? 0, ALM1)];
        if (b.length >= 5) r.modules = b[4];
        if (b.length >= 7 && b[5] === 0x50 && b[6] === 0x4e) r.protocol = "Pylontech";
        break;
      case 0x35c:
        known.add(id);
        r.flags = bits(b[0], REQ);
        r.charge_enable = !!(b[0] & 0x80);
        r.discharge_enable = !!(b[0] & 0x40);
        break;
      case 0x35e:
        known.add(id);
        r.manufacturer = String.fromCharCode(...b.filter((c) => c >= 32 && c < 127)).trim();
        if (!r.protocol) r.protocol = /PYLON/i.test(r.manufacturer) ? "Pylontech" : "Pylontech-compatible";
        break;
      case 0x35f: // một số BMS: loại pin, phiên bản, dung lượng
        known.add(id);
        if (b.length >= 6) { r.bms_version = `${b[2]}.${b[3]}`; r.capacity_ah = u16(b, 4); }
        break;
      case 0x372: // Victron: số module
        known.add(id);
        r.modules_online = u16(b, 0);
        r.modules_block_charge = u16(b, 2);
        r.modules_block_discharge = u16(b, 4);
        if (b.length >= 8) r.modules_offline = u16(b, 6);
        break;
      case 0x373: // Victron: min/max cell
        known.add(id);
        r.cell_v_min = u16(b, 0) / 1000;
        r.cell_v_max = u16(b, 2) / 1000;
        if (b.length >= 8) {
          r.cell_t_min = +(u16(b, 4) - 273.15).toFixed(1);
          r.cell_t_max = +(u16(b, 6) - 273.15).toFixed(1);
        }
        r.cell_delta_mv = Math.round((r.cell_v_max - r.cell_v_min) * 1000);
        break;
      case 0x305: case 0x307: // inverter gửi heartbeat / định danh
        known.add(id);
        r.inverter_heartbeat = true;
        if (id === 0x307 && b.length >= 8) r.inverter_vendor = String.fromCharCode(...b.slice(5, 8).filter((c) => c >= 32 && c < 127));
        break;
    }
  }
  r.frames.sort((a, b) => a.id.localeCompare(b.id));
  r.decoded_ids = [...known].map((x) => "0x" + x.toString(16).toUpperCase());
  if (!r.protocol && known.size) r.protocol = "Pylontech-compatible";
  return r;
}
