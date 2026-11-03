// Chuẩn hóa dữ liệu (từ gateway Modbus hoặc từ cloud hãng) về một mô hình chung cho giao diện.
// Quy ước dấu: battery.power > 0 = pin đang XẢ, < 0 = đang SẠC; grid.power > 0 = MUA điện, < 0 = BÁN lên lưới.

const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : v !== null && v !== undefined && v !== "" && !isNaN(Number(v)) ? Number(v) : null);

export function emptyDetail() {
  return {
    device: {}, pv: { strings: [] }, grid: { phases: [] }, load: { phases: [] }, output: { phases: [] },
    battery: { packs: [] }, gen: {}, can: null, bms: null, params: [], settings: [],
  };
}

// Tìm theo tên (không phân biệt hoa thường), ưu tiên mẫu đứng trước
function pick(map, ...names) {
  for (const nm of names) {
    const v = map.get(nm.toLowerCase());
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

// Từ danh sách thông số đã giải mã của profile Modbus
export function fromModbus(decoded, profileId, opts = {}) {
  const d = emptyDetail();
  const m = new Map();
  // Ưu tiên thông số đo (sensor) hơn thông số cài đặt trùng tên (vd. "PV Power", "Grid frequency")
  const isSensor = (p) => !p.platform || p.platform === "sensor" || p.platform === "binary_sensor";
  for (const p of [...decoded.filter((x) => !isSensor(x)), ...decoded.filter(isSensor)]) m.set(String(p.name).toLowerCase(), p.value);
  const g = (...a) => n(pick(m, ...a));
  const s = (...a) => pick(m, ...a);

  d.device = {
    profile: profileId,
    type: s("Device"),
    serial: s("Device Serial Number", "Serial Number", "Inverter SN"),
    firmware: s("Device Control Board Firmware Version", "Firmware Version", "Inverter Firmware"),
    comm_firmware: s("Device Communication Board Firmware Version"),
    protocol: s("Device Protocol Version"),
    rated_power: g("Device Rated Power", "Rated Power"),
    state: s("Device State", "Inverter Status", "Operating Status", "Running Status", "State"),
    alarm: s("Device Alarm", "Alarm"),
    fault: s("Device Fault", "Fault", "Fault Status 04 (Device)"),
    temp_dc: g("DC Temperature", "Radiator Temperature"),
    temp_ac: g("Temperature", "AC Temperature", "Inverter Temperature"),
    temp_ambient: g("Ambient Temperature"),
    clock: s("Date & Time"),
    relay: s("Device Relay"),
  };

  // PV
  d.pv.power = g("PV Power", "DC Power", "Input Power");
  for (let i = 1; i <= 12; i++) {
    const v = g(`PV${i} Voltage`), a = g(`PV${i} Current`), w = g(`PV${i} Power`);
    if (v === null && a === null && w === null) continue;
    d.pv.strings.push({ n: i, v, a, w: w ?? (v !== null && a !== null ? Math.round(v * a) : null) });
  }
  if (d.pv.power === null && d.pv.strings.length) d.pv.power = d.pv.strings.reduce((t, x) => t + (x.w || 0), 0);
  d.pv.today_kwh = g("Today Production", "Today Energy", "Daily Production", "Today PV Production");
  d.pv.total_kwh = g("Total Production", "Total Energy");

  // Lưới
  const sign = opts.invertGrid ? -1 : 1;
  let gp = g("Grid Power", "Total Grid Power", "Internal Power");
  if (gp === null && m.has("meter active power")) gp = -g("Meter Active Power");
  d.grid.power = gp === null ? null : gp * sign;
  d.grid.freq = g("Grid Frequency", "Meter Frequency", "Inverter Frequency");
  for (const l of [1, 2, 3]) {
    const v = g(`Grid L${l} Voltage`, l === 1 ? "Grid Voltage" : "_", l === 1 ? "Meter Voltage" : "_");
    const a = g(`Grid L${l} Current`, `Internal CT${l} Current`, l === 1 ? "Meter Current" : "_");
    const w = g(`Grid L${l} Power`, `Internal CT${l} Power`);
    if (v === null && a === null && w === null) continue;
    d.grid.phases.push({ l, v, a, w: w === null ? null : w * sign });
  }
  d.grid.pf = g("Grid Power Factor", "Meter Power Factor");
  d.grid.ct_power = g("External Power");
  d.grid.today_import = g("Today Energy Import", "Daily Energy Bought", "Today Grid Import");
  d.grid.today_export = g("Today Energy Export", "Daily Energy Sold", "Today Grid Export");
  d.grid.total_import = g("Total Energy Import");
  d.grid.total_export = g("Total Energy Export");
  d.grid.status = s("Grid");

  // Tải
  d.load.power = g("Load Power", "House Load Power", "Load Consumption Power", "Total Load Power");
  d.load.ups_power = g("Load UPS Power", "Backup Load Power");
  d.load.freq = g("Load Frequency", "Output Frequency");
  d.load.today_kwh = g("Today Load Consumption", "Daily Load Consumption");
  d.load.total_kwh = g("Total Load Consumption");
  for (const l of [1, 2, 3]) {
    const v = g(`Load L${l} Voltage`, `Output L${l} Voltage`, l === 1 ? "Output Voltage" : "_");
    const a = g(`Load L${l} Current`, `Output L${l} Current`, l === 1 ? "Output Current" : "_");
    const w = g(`Load L${l} Power`, `Load Consumption L${l} Power`);
    if (v === null && a === null && w === null) continue;
    d.load.phases.push({ l, v, a, w });
  }
  // Đầu ra inverter
  d.output.power = g("Power", "Inverter AC Power", "Inverter Active Power");
  d.output.freq = g("Output Frequency", "Inverter Frequency");
  for (const l of [1, 2, 3]) {
    const v = g(`Output L${l} Voltage`, l === 1 ? "Output Voltage" : "_", l === 1 ? "Inverter Voltage" : "_");
    const a = g(`Output L${l} Current`, l === 1 ? "Output Current" : "_", l === 1 ? "Inverter Current" : "_");
    const w = g(`Output L${l} Power`);
    if (v === null && a === null && w === null) continue;
    d.output.phases.push({ l, v, a, w });
  }
  d.output.losses = g("Power losses");

  // Pin
  const bs = opts.invertBattery ? -1 : 1;
  let bp = g("Battery Power");
  const bstate = s("Battery State");
  if (bp !== null && /^solis/.test(profileId)) bp = Math.abs(bp) * (/charg/i.test(bstate) && !/dis/i.test(bstate) ? -1 : 1);
  let bc = g("Battery Current", "BMS Battery Current");
  if (bc !== null && /^solis/.test(profileId) && bp !== null) bc = Math.abs(bc) * Math.sign(bp || 1);
  d.battery.power = bp === null ? null : bp * bs;
  d.battery.current = bc === null ? null : bc * bs;
  d.battery.voltage = g("Battery Voltage", "BMS Battery Voltage");
  d.battery.soc = g("Battery", "Battery SOC", "SOC");
  d.battery.soh = g("Battery SOH");
  d.battery.temp = g("Battery Temperature");
  d.battery.capacity_ah = g("Battery Capacity");
  d.battery.today_charge = g("Today Battery Charge");
  d.battery.today_discharge = g("Today Battery Discharge");
  d.battery.total_charge = g("Total Battery Charge");
  d.battery.total_discharge = g("Total Battery Discharge");
  d.battery.cycles_total = g("Total Battery Life Cycles");
  d.battery.alarm = s("Battery Alarm");
  d.battery.fault = s("Battery Fault", "Battery Fault Status");
  d.battery.charge_limit = g("Battery Charge Current Limit", "BMS Battery Charge Current Limit");
  d.battery.discharge_limit = g("Battery Discharge Current Limit", "BMS Battery Discharge Current Limit");
  for (let i = 1; i <= 20; i++) {
    const soc = g(`Battery ${i}`), v = g(`Battery ${i} Voltage`);
    if (soc === null && v === null) continue;
    d.battery.packs.push({
      n: i, soc, v, a: g(`Battery ${i} Current`), soh: g(`Battery ${i} SOH`), temp: g(`Battery ${i} Temperature`),
      t_max: g(`Battery ${i} Max Cell Temperature`), t_min: g(`Battery ${i} Min Cell Temperature`), t_mos: g(`Battery ${i} MOS Temperature`),
      cell_max: g(`Battery ${i} Max Cell Voltage`), cell_min: g(`Battery ${i} Min Cell Voltage`), cycles: g(`Battery ${i} Cycles`),
      capacity: g(`Battery ${i} Capacity`), imbalance: g(`Battery ${i} Imbalance`), alarm: s(`Battery ${i} Alarm`), fault: s(`Battery ${i} Fault`),
    });
  }

  // Máy phát / SmartLoad
  d.gen.power = g("Generator Power");
  d.gen.today_kwh = g("Generator Energy - today");
  d.gen.voltage = g("Generator Voltage", "Generator L1 Voltage");

  d.params = decoded
    .filter((p) => p.platform === "sensor" || p.platform === "binary_sensor" || !p.platform)
    .map(({ key, name, group, value, uom }) => ({ key, name, group, value, uom }));
  return finish(d);
}

// Bổ sung dữ liệu CAN/BMS vào phần pin
export function mergeBattery(d, can, bms) {
  if (can) {
    d.can = can;
    const b = d.battery;
    b.soc ??= can.soc ?? null;
    b.soh ??= can.soh ?? null;
    b.voltage ??= can.voltage ?? null;
    if (b.temp === null || b.temp === undefined) b.temp = can.temperature ?? null;
    b.charge_limit ??= can.charge_current_limit ?? null;
    b.discharge_limit ??= can.discharge_current_limit ?? null;
  }
  if (bms) {
    d.bms = bms;
    const b = d.battery;
    if (b.soc === null || b.soc === undefined) b.soc = bms.soc ?? null;
    if (b.voltage === null || b.voltage === undefined) b.voltage = bms.voltage ?? null;
  }
  return d;
}

// Tóm tắt để lưu vào bảng stations
export function summary(d) {
  return {
    pv_power_w: n(d.pv.power),
    load_power_w: n(d.load.power),
    grid_power_w: n(d.grid.power),
    battery_power_w: n(d.battery.power),
    battery_soc: n(d.battery.soc),
    today_kwh: n(d.pv.today_kwh),
    total_kwh: n(d.pv.total_kwh),
  };
}

// MỚI (01/11/2026): kiểm tra cân bằng công suất PV + Pin(xả) + Lưới(mua) ≈ Tải để phát hiện hãng trả NGƯỢC DẤU pin/lưới.
// Trả về { sb, sg } = hệ số dấu nên nhân cho pin, lưới (1 = giữ nguyên, -1 = đảo). Chỉ đảo khi đảo khớp rõ rệt hơn hẳn.
export function balanceSigns(pv, load, bat, grid) {
  pv = n(pv); load = n(load); bat = n(bat); grid = n(grid);
  if (pv === null || load === null || (bat === null && grid === null)) return { sb: 1, sg: 1 };
  const err = (sb, sg) => Math.abs(pv + sb * (bat || 0) + sg * (grid || 0) - load);
  const tol = Math.max(150, 0.15 * Math.max(pv, load));
  const base = err(1, 1);
  if (base <= tol) return { sb: 1, sg: 1 };
  let best = { sb: 1, sg: 1, e: base };
  for (const [sb, sg] of [[1, -1], [-1, 1], [-1, -1]]) {
    if (sb < 0 && !(Math.abs(bat || 0) > 50)) continue;
    if (sg < 0 && !(Math.abs(grid || 0) > 50)) continue;
    const e = err(sb, sg);
    if (e < best.e) best = { sb, sg, e };
  }
  return best.e <= tol && best.e < base * 0.3 ? { sb: best.sb, sg: best.sg } : { sb: 1, sg: 1 };
}

// MỚI (01/11/2026): bước hoàn thiện chung cho mọi nguồn (gateway Modbus + cloud các hãng)
function finish(d) {
  const b = d.battery, g = d.grid;
  // 1) Đảo dấu pin/lưới nếu hãng trả ngược quy ước (pin + = xả, lưới + = mua)
  const { sb, sg } = balanceSigns(d.pv.power, d.load.power, b.power, g.power);
  if (sb < 0) { b.power = -b.power; if (n(b.current) !== null) b.current = -b.current; d.sign_fixed = [...(d.sign_fixed || []), "battery"]; }
  if (sg < 0) { g.power = -g.power; for (const p of g.phases) if (n(p.w) !== null) p.w = -p.w; d.sign_fixed = [...(d.sign_fixed || []), "grid"]; }
  // 2) Dòng pin cùng dấu với công suất pin (nhiều hãng trả dòng luôn dương)
  if (n(b.power) !== null && n(b.current) !== null && Math.abs(b.power) > 30 && Math.sign(b.power) !== Math.sign(b.current) && b.current !== 0) b.current = -b.current;
  if (n(b.power) !== null && n(b.current) === null && n(b.voltage)) b.current = Math.round((b.power / b.voltage) * 10) / 10;
  // 3) Thiếu công suất tải → tính từ cân bằng
  if (n(d.load.power) === null && n(d.pv.power) !== null && n(g.power) !== null) d.load.power = Math.max(0, Math.round(d.pv.power + (n(b.power) || 0) + g.power));
  // 4) Tải & 5) Lưới — SỬA (01/11/2026): chỉ suy công suất pha từ tổng khi hệ 1 pha (hệ 3 pha chia đều là SAI → để trống);
  //    dòng chỉ tính từ công suất pha THẬT; dòng hãng trả lệch hẳn so với P/U (vd. 1,44 kW mà 0,5 A) thì tính lại từ P/U.
  // SỬA (03/11/2026): đối chiếu dữ liệu thật — Deye Cloud ("Grid Current L1L2") và PV Pro (grid.vip.current) trả dòng ĐẦU RA BIẾN TẦN
  //   thay cho dòng lưới (lưới 18 W mà 7,9 A; lưới 26 W mà 22,8 A). PV Pro còn trả công suất/dòng tải pha là cổng UPS (-3 W) trong khi tải nhà 5,3 kW.
  //   → Pha "thật" = pha có áp > 50 V. Hệ 1 pha: công suất pha lệch hẳn tổng thì lấy tổng. Dòng lệch hẳn P/U (quá nhỏ HOẶC quá lớn) thì tính lại từ P/U.
  const live = (o) => o.phases.filter((p) => !(n(p.v) !== null && p.v < 50 && !n(p.a) && !n(p.w)));
  const fixPhases = (o, total, ref) => {
    const ps = live(o);
    if (!ps.length) return;
    if (ps.length === 1 && n(total) !== null) {
      const p = ps[0];
      if (n(p.w) === null || Math.abs(p.w - total) > Math.max(150, 0.25 * Math.abs(total))) p.w = Math.round(total);
    }
    for (const p of ps) {
      if (!(n(p.v) > 50) || n(p.w) === null) continue;
      const calc = Math.round((Math.abs(p.w) / p.v) * 10) / 10;
      const va = n(p.a) === null ? null : Math.abs(p.a) * p.v, w = Math.abs(p.w);
      const r = ref && ref.find((q) => q.l === p.l);
      const copy = r && n(r.a) !== null && n(p.a) !== null && Math.abs(p.a) > 1 && Math.abs(Math.abs(p.a) - Math.abs(r.a)) <= Math.max(0.3, 0.05 * Math.abs(r.a)) && Math.abs(Math.abs(r.a) * p.v - w) > 200;
      if (va === null || (w > 200 && va < 0.5 * w) || va > 2 * w + 250 || copy) p.a = calc;
    }
  };
  // Lưới: dòng từng pha tính từ công suất LƯỚI (không lấy dòng biến tần) — lưới mua 141 W phải ra ~0,6 A chứ không phải 16 A
  for (const p of d.output.phases) {
    const x = g.phases.find((q) => q.l === p.l);
    if (x && !n(p.v)) p.v = x.v;
  }
  fixPhases(d.load, d.load.power, null);
  fixPhases(g, g.power, d.output.phases);
  return d;
}

// ---------- Từ cloud hãng (danh sách {name, value, unit}) ----------
// Solarman / Deye Cloud trả về danh sách thông số có tên tiếng Anh giống app của hãng.
const CLOUD_MAP = [
  [/^(dc )?voltage pv(\d+)$|^pv(\d+) voltage$|^dc voltage pv(\d+)$/i, (d, v, mm) => str(d, +(mm[2] || mm[3] || mm[4])).v = v],
  [/^(dc )?current pv(\d+)$|^pv(\d+) current$|^dc current pv(\d+)$/i, (d, v, mm) => str(d, +(mm[2] || mm[3] || mm[4])).a = v],
  [/^(dc )?power pv(\d+)$|^pv(\d+) (input )?power$|^dc power pv(\d+)$/i, (d, v, mm) => str(d, +(mm[2] || mm[3] || mm[5])).w = v],
  [/^(total )?(dc|solar|pv) (input )?power$|^total solar power$|^production power$/i, (d, v) => (d.pv.power = v)],
  [/^(daily|today('s)?) production|^daily production \(active\)$|^cumulative production \(active\)$/i, (d, v, mm, name) => (/cumulative/i.test(name) ? (d.pv.total_kwh = v) : (d.pv.today_kwh = v))],
  [/^total production|^cumulative production$/i, (d, v) => (d.pv.total_kwh = v)],
  [/^ac voltage r\/u\/a$|^grid voltage l1$|^ac voltage l1$|^grid voltage$/i, (d, v) => (ph(d.grid, 1).v = v)],
  [/^ac voltage s\/v\/b$|^grid voltage l2$|^ac voltage l2$/i, (d, v) => (ph(d.grid, 2).v = v)],
  [/^ac voltage t\/w\/c$|^grid voltage l3$|^ac voltage l3$/i, (d, v) => (ph(d.grid, 3).v = v)],
  // SỬA (01/11/2026): "AC current R/S/T" của cloud là dòng đầu ra BIẾN TẦN, không phải dòng điện lưới → đưa vào output
  [/^ac current r\/u\/a$|^ac current l1$/i, (d, v) => (ph(d.output, 1).a = v)],
  [/^ac current s\/v\/b$|^ac current l2$/i, (d, v) => (ph(d.output, 2).a = v)],
  [/^ac current t\/w\/c$|^ac current l3$/i, (d, v) => (ph(d.output, 3).a = v)],
  [/^grid power l(\d)$/i, (d, v, mm) => (ph(d.grid, +mm[1]).w = v)], // MỚI (01/11/2026)
  [/^grid current l1$/i, (d, v) => (ph(d.grid, 1).a = v)],
  [/^grid current l2$/i, (d, v) => (ph(d.grid, 2).a = v)],
  [/^grid current l3$/i, (d, v) => (ph(d.grid, 3).a = v)],
  [/^ac output frequency|^grid frequency$|^ac frequency$/i, (d, v) => (d.grid.freq = v)],
  [/^total grid power$|^grid power$|^grid total power$/i, (d, v) => (d.grid.power = v)],
  [/^daily energy (bought|purchased)$|^today('s)? (energy )?(purchased|bought)/i, (d, v) => (d.grid.today_import = v)],
  [/^daily (grid feed-in|energy sold)$|^today('s)? (energy )?(sold|feed-in)/i, (d, v) => (d.grid.today_export = v)],
  [/^total consumption power$|^load power$|^total load power$|^consumption power$/i, (d, v) => (d.load.power = v)],
  [/^daily consumption$|^today('s)? consumption$|^daily load consumption$/i, (d, v) => (d.load.today_kwh = v)],
  [/^load voltage l1$/i, (d, v) => (ph(d.load, 1).v = v)],
  [/^load voltage l2$/i, (d, v) => (ph(d.load, 2).v = v)],
  [/^load voltage l3$/i, (d, v) => (ph(d.load, 3).v = v)],
  [/^load current l(\d)$/i, (d, v, mm) => (ph(d.load, +mm[1]).a = v)], // MỚI (01/11/2026)
  [/^load power l(\d)$/i, (d, v, mm) => (ph(d.load, +mm[1]).w = v)], // MỚI (01/11/2026)
  [/^generator power$/i, (d, v) => (d.gen.power = v)], // MỚI (01/11/2026)
  [/^battery voltage$/i, (d, v) => (d.battery.voltage = v)],
  [/^battery current$/i, (d, v) => (d.battery.current = v)],
  [/^battery power$/i, (d, v) => (d.battery.power = v)],
  [/^(battery )?soc$|^remaining battery capacity$/i, (d, v) => (d.battery.soc = v)],
  [/^soh$|^battery soh$/i, (d, v) => (d.battery.soh = v)],
  [/^battery temperature$|^bms temperature$/i, (d, v) => (d.battery.temp = v)],
  [/^daily charging energy$|^today('s)? charg/i, (d, v) => (d.battery.today_charge = v)],
  [/^daily discharging energy$|^today('s)? discharg/i, (d, v) => (d.battery.today_discharge = v)],
  [/^bms charge current limit|^bms charging current limit/i, (d, v) => (d.battery.charge_limit = v)],
  [/^bms discharge current limit|^bms discharging current limit/i, (d, v) => (d.battery.discharge_limit = v)],
  [/^dc temperature|^radiator temperature|^heat ?sink temperature/i, (d, v) => (d.device.temp_dc = v)],
  [/^ac temperature|^inverter temperature|^igbt temperature/i, (d, v) => (d.device.temp_ac = v)],
  [/^inverter ac power$|^ac output power$|^inverter output power$/i, (d, v) => (d.output.power = v)], // MỚI (01/11/2026)
  [/^rated power$/i, (d, v) => (d.device.rated_power = v)],
  [/^inverter status$|^running status$|^state$/i, (d, v) => (d.device.state = v)],
  [/^inverter alarm$/i, (d, v) => (d.device.alarm = v)],
  [/^inverter fault$/i, (d, v) => (d.device.fault = v)],
  [/^battery bms link$/i, (d, v) => (d.battery.alarm = v)], // MỚI (01/11/2026): báo BMS không giao tiếp
  // MỚI (31/10/2026): tên thông số thật của Deye Cloud (đối chiếu dữ liệu trạm thật) — trước đây không khớp nên hiện "--"
  [/^pv daily power generation|^daily active production$/i, (d, v) => (d.pv.today_kwh = v)],
  [/^pv cumulative power generation|^total active production$/i, (d, v) => (d.pv.total_kwh = v)],
  [/^ac voltage rua$|^grid voltage l1l2$/i, (d, v) => (ph(d.grid, 1).v = v)],
  [/^ac current rua$/i, (d, v) => (ph(d.output, 1).a = v)], // SỬA (01/11/2026): dòng biến tần, không phải dòng lưới
  [/^grid current l1l2$/i, (d, v) => (ph(d.grid, 1).a = v)],
  [/^daily grid feed in$/i, (d, v) => (d.grid.today_export = v)],
  [/^cumulative grid feed in$/i, (d, v) => (d.grid.total_export = v)],
  [/^cumulative energy purchased$/i, (d, v) => (d.grid.total_import = v)],
  [/^external ct power/i, (d, v) => (d.grid.ct_power = v)],
  [/^load voltage l1l2$/i, (d, v) => (ph(d.load, 1).v = v)],
  [/^cumulative consumption$/i, (d, v) => (d.load.total_kwh = v)],
  [/^ups load power$/i, (d, v) => (d.load.ups_power = v)],
  [/^total charge energy$/i, (d, v) => (d.battery.total_charge = v)],
  [/^total discharge energy$/i, (d, v) => (d.battery.total_discharge = v)],
  [/^battery rated capacity$/i, (d, v) => (d.battery.capacity_ah = v)],
  [/^charge current limit$/i, (d, v) => (d.battery.charge_limit = v)],
  [/^discharge current limit$/i, (d, v) => (d.battery.discharge_limit = v)],
  [/^total gen power$/i, (d, v) => (d.gen.power = v)],
  [/^gen voltage$/i, (d, v) => (d.gen.voltage = v)],
  [/^daily production generator$/i, (d, v) => (d.gen.today_kwh = v)],
  [/^ac power l(\d)$/i, (d, v, mm) => (ph(d.output, +mm[1]).w = v)], // SolaX: công suất AC biến tần từng pha (SỬA 01/11/2026: trước gán nhầm vào lưới)
  [/^battery rated capacity \(kwh\)$/i, () => {}],
];
const str = (d, i) => { let x = d.pv.strings.find((s) => s.n === i); if (!x) { x = { n: i, v: null, a: null, w: null }; d.pv.strings.push(x); } return x; };
const ph = (o, l) => { let x = o.phases.find((p) => p.l === l); if (!x) { x = { l, v: null, a: null, w: null }; o.phases.push(x); } return x; };

export function fromCloudList(list, source, extra = {}) {
  const d = emptyDetail();
  d.device = { profile: source, ...extra };
  for (const it of list || []) {
    const name = String(it.name || it.key || "").trim();
    const num = n(it.value);
    const val = num ?? it.value;
    for (const [re, fn] of CLOUD_MAP) {
      const mm = name.match(re);
      if (mm) { try { fn(d, val, mm, name); } catch {} break; }
    }
    d.params.push({ key: it.key || name, name, group: it.group || "Thông số", value: val, uom: it.unit || null });
  }
  d.pv.strings.sort((a, b) => a.n - b.n);
  for (const s of d.pv.strings) if (s.w === null && s.v !== null && s.a !== null) s.w = Math.round(s.v * s.a);
  if (d.pv.power === null || d.pv.power === undefined) d.pv.power = d.pv.strings.length ? d.pv.strings.reduce((t, x) => t + (x.w || 0), 0) : null;
  return finish(d);
}
