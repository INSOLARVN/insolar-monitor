// Bộ giả lập inverter: sinh thanh ghi Modbus đúng theo profile để chạy thử giao diện và gateway
// (dùng cho trạm Demo và script tools/gateway-sim.mjs).
import { prepare, encodeWrite, getCode } from "./modbus-profile.js";

function setWords(regs, code, registers, n) {
  regs[code] ??= {};
  const total = 65536 ** registers.length;
  if (n < 0) n += total;
  registers.forEach((r, i) => { regs[code][r] = Math.floor(n / 65536 ** i) % 65536; });
}

// Ghi giá trị "người đọc" vào thanh ghi theo định nghĩa của thông số
export function encodeSensor(prep, regs, name, value) {
  const i = prep.items.find((x) => x.name === name && x.registers?.length);
  if (!i) return false;
  if (i.sensors) {
    // Thông số ghép nhiều thanh ghi: dồn giá trị vào thanh ghi đầu, các thanh ghi còn lại = 0
    const ss = i.sensors.filter((x) => x.registers?.length);
    if (!ss.length || ss.some((x) => x.operator) || typeof value !== "number") return false;
    ss.forEach((x, k) => {
      let n = k === 0 ? value : 0;
      if (x.scale) n /= x.scale;
      setWords(regs, getCode(x, "read", 3), x.registers, Math.round(n));
    });
    return true;
  }
  const code = getCode(i, "read", 3);
  if (i.lookup) {
    const o = i.lookup.find((x) => x.value === value);
    if (!o) return false;
    let k = "bit" in o ? 2 ** o.bit : o.key;
    if (Array.isArray(k)) k = k[0];
    if (typeof k !== "number") return false;
    setWords(regs, code, i.registers, k);
    return true;
  }
  if (![1, 2, 3, 4].includes(i.rule) || typeof value !== "number") return false;
  let n = value;
  if (i.scale) n = n / i.scale;
  if (i.offset != null) n += i.offset;
  n = Math.round(n);
  if (i.inverted) n = -n;
  setWords(regs, code, i.registers, n);
  return true;
}

const DEFAULT_SETTINGS = {
  "Battery Max Charging Current": 100, "Battery Max Discharging Current": 100, "Battery Capacity": 200,
  "Battery Shutdown SOC": 15, "Battery Restart SOC": 30, "Battery Low SOC": 20, "Battery Grid Charging Current": 40,
  "Battery Grid Charging Start": 30, "Zero Export power": 20, "Export Surplus Power": 6000, "Battery Equalization": 56.4,
  "Battery Absorption": 56, "Battery Float": 54, "Battery Empty": 46, "Grid reconnection time": 60,
  "Program 1 SOC": 50, "Program 2 SOC": 40, "Program 3 SOC": 30, "Program 4 SOC": 30, "Program 5 SOC": 60, "Program 6 SOC": 50,
  "Program 1 Power": 5000, "Program 2 Power": 5000, "Program 3 Power": 5000, "Program 4 Power": 5000, "Program 5 Power": 5000, "Program 6 Power": 5000,
  "Program 1 Time": "00:00", "Program 2 Time": "05:00", "Program 3 Time": "09:00", "Program 4 Time": "13:00", "Program 5 Time": "17:00", "Program 6 Time": "22:00",
};

const rnd = (a, b) => a + Math.random() * (b - a);

// Kịch bản theo giờ trong ngày (giờ Việt Nam)
export function scenario(hourVN, kwp = 8, phases = 1) {
  const sun = Math.max(0, Math.sin(((hourVN - 6) / 12.5) * Math.PI));
  const cloud = 0.85 + 0.15 * Math.sin(hourVN * 7.3);
  const pv = Math.round(kwp * 1000 * 0.82 * sun * cloud);
  const evening = hourVN >= 17.5 && hourVN <= 22.5;
  const load = Math.round((evening ? 2300 : hourVN < 6 ? 450 : 900) + rnd(-120, 160));
  const dayFrac = hourVN < 6 ? 0 : hourVN > 18.5 ? 1 : (1 - Math.cos(((hourVN - 6) / 12.5) * Math.PI)) / 2;
  let soc = Math.round(hourVN < 6 ? 45 - hourVN * 2 : hourVN < 15 ? 33 + (hourVN - 6) * 7.4 : hourVN < 17.5 ? 100 : 100 - (hourVN - 17.5) * 9);
  soc = Math.max(20, Math.min(100, soc));
  let bat = 0; // + xả, - sạc
  if (pv > load && soc < 100) bat = -Math.min(pv - load, 4500);
  else if (pv < load && soc > 20) bat = Math.min(load - pv, 5000);
  const grid = load - pv - bat;
  const bv = +(48 + soc * 0.06 + (bat < 0 ? 0.6 : -0.3)).toFixed(2);
  return {
    pv, load, bat, grid, soc, bv, sun, phases,
    pvToday: +(kwp * 4.4 * dayFrac).toFixed(1), loadToday: +(4 + hourVN * 0.65).toFixed(1),
    chargeToday: +(Math.min(9.8, Math.max(0, (hourVN - 7) * 1.4))).toFixed(1), dischargeToday: +(3.2 + Math.max(0, hourVN - 17.5) * 1.6).toFixed(1),
    importToday: +(0.6 + Math.max(0, hourVN - 21) * 0.4).toFixed(1), exportToday: +(Math.max(0, (hourVN - 11) * 0.3)).toFixed(1),
  };
}

export function simulateRegisters(profileId, params, opt = {}) {
  const prep = prepare(profileId, params);
  const regs = {};
  for (const [code, start, count] of prep.requests) {
    regs[code] ??= {};
    for (let a = start; a < start + count; a++) regs[code][a] ??= 0;
  }
  const hour = opt.hour ?? ((Date.now() / 3600e3 + 7) % 24);
  const s = scenario(hour, opt.kwp ?? 8, prep.params.phase);
  const set = (n, v) => encodeSensor(prep, regs, n, v);
  // Thông tin thiết bị
  set("Device", profileId === "deye_p3" ? "LV 3-Phase Hybrid Inverter" : "Single-Phase Hybrid Inverter");
  set("Device Rated Phase", profileId === "deye_p3" ? "Three-Phase" : "Single-Phase");
  set("Device Rated Power", (opt.rated ?? 8000));
  const sn = "2405128801";
  const snItem = prep.items.find((x) => x.name === "Device Serial Number");
  if (snItem) snItem.registers.forEach((r, i) => { regs[3][r] = (sn.charCodeAt(i * 2) << 8) | (sn.charCodeAt(i * 2 + 1) || 32); });
  const fw = prep.items.find((x) => x.name === "Device Control Board Firmware Version");
  if (fw) [0x1144, 0x3240, 0x0112].forEach((v, i) => (regs[3][fw.registers[i]] = v));
  set("Device Protocol Version", 0x0104);
  set("Device MPPTs", 0x0200);
  // Trạng thái
  set("Device State", "Normal");
  // PV
  const strings = [0.56, 0.44];
  strings.forEach((k, i) => {
    const w = Math.round(s.pv * k);
    const v = s.sun > 0.02 ? +(rnd(360, 395) * (0.9 + s.sun * 0.1)).toFixed(1) : +(rnd(2, 14)).toFixed(1);
    set(`PV${i + 1} Power`, w);
    set(`PV${i + 1} Voltage`, v);
    set(`PV${i + 1} Current`, +(w / Math.max(v, 1)).toFixed(1));
  });
  const pvItem = prep.items.find((x) => x.name === "PV Power" && x.sensors);
  if (pvItem) pvItem.sensors.filter((x) => x.registers?.length).forEach((x, k) =>
    setWords(regs, getCode(x, "read", 3), x.registers, Math.round((strings[k] ? s.pv * strings[k] : 0) / (x.scale || 1))));
  const pver = prep.items.find((x) => x.name === "Device Protocol Version");
  if (pver) regs[3][pver.registers[0]] = 0x0104;
  // Pin
  set("Battery Power", s.bat);
  set("Battery Voltage", s.bv);
  set("Battery Current", +(s.bat / s.bv).toFixed(2));
  set("Battery", s.soc);
  set("Battery SOH", 99);
  set("Battery Temperature", +rnd(27, 31).toFixed(1));
  set("Battery Capacity", 200);
  // Lưới & tải
  const gv = () => +rnd(224, 233).toFixed(1);
  const ph = profileId === "deye_p3" ? 3 : 1;
  set("Grid Power", s.grid);
  set("Grid Frequency", +rnd(49.96, 50.04).toFixed(2));
  set("Load Power", s.load);
  set("Load Frequency", 50.0);
  set("Output Frequency", 50.0);
  for (let l = 1; l <= ph; l++) {
    const v = gv();
    set(`Grid L${l} Voltage`, v);
    set(`Grid L${l} Power`, Math.round(s.grid / ph));
    set(`Grid L${l} Current`, +(s.grid / ph / v).toFixed(1));
    set(`Internal CT${l} Power`, Math.round(s.grid / ph));
    set(`Internal CT${l} Current`, +(s.grid / ph / v).toFixed(1));
    set(`Load L${l} Voltage`, v - 0.4);
    set(`Load L${l} Power`, Math.round(s.load / ph));
    set(`Load L${l} Current`, +(s.load / ph / v).toFixed(1));
    set(`Output L${l} Voltage`, v - 0.2);
    set(`Output L${l} Current`, +((s.load - s.grid) / ph / v).toFixed(1));
    set(`Output L${l} Power`, Math.round((s.load - s.grid) / ph));
  }
  set("Grid Voltage", gv());
  set("Output Voltage", gv());
  set("Power", s.load - s.grid);
  set("DC Temperature", +rnd(38, 48).toFixed(1));
  set("Temperature", +rnd(34, 42).toFixed(1));
  // Sản lượng
  set("Today Production", s.pvToday);
  set("Total Production", 9234.5);
  set("Today Load Consumption", s.loadToday);
  set("Total Load Consumption", 7710.2);
  set("Today Battery Charge", s.chargeToday);
  set("Today Battery Discharge", s.dischargeToday);
  set("Total Battery Charge", 2810.4);
  set("Total Battery Discharge", 2655.9);
  set("Today Energy Import", s.importToday);
  set("Today Energy Export", s.exportToday);
  set("Total Energy Import", 1290.7);
  set("Total Energy Export", 401.3);
  // Pack pin (3 pha)
  for (let p = 1; p <= (prep.params.pack || 1); p++) {
    set(`Battery ${p}`, s.soc);
    set(`Battery ${p} Voltage`, s.bv);
    set(`Battery ${p} Current`, +(s.bat / s.bv / (prep.params.pack || 1)).toFixed(1));
    set(`Battery ${p} SOH`, 98);
    set(`Battery ${p} Temperature`, 29);
    set(`Battery ${p} Max Cell Voltage`, +(s.bv / 16 + 0.008).toFixed(3));
    set(`Battery ${p} Min Cell Voltage`, +(s.bv / 16 - 0.006).toFixed(3));
    set(`Battery ${p} Max Cell Temperature`, 30);
    set(`Battery ${p} Min Cell Temperature`, 28);
    set(`Battery ${p} Cycles`, 182);
  }
  // Cài đặt mặc định
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const it = prep.items.find((x) => x.name === k && x.platform !== "sensor");
    if (!it) continue;
    try { const w = encodeWrite(prep, it.key, v, regs); w.values.forEach((val, i) => (regs[3][w.addr + i] = val)); } catch {}
  }
  for (const [k, v] of [["Work Mode", "Zero Export To CT"], ["Energy Pattern", "Load First"], ["Battery Control Mode", "Lithium"]]) {
    const it = prep.items.find((x) => x.name === k && x.platform === "select");
    if (it) { try { const w = encodeWrite(prep, it.key, v, regs); regs[3][w.addr] = w.values[0]; } catch {} }
  }
  const dt = prep.items.find((x) => x.platform === "datetime");
  if (dt) { try { const w = encodeWrite(prep, dt.key, new Date().toISOString(), regs); w.values.forEach((v, i) => (regs[3][w.addr + i] = v)); } catch {} }
  return { regs, scenario: s };
}

// Khung CAN Pylontech giả lập
export function simulateCan(s) {
  const le = (v) => { if (v < 0) v += 65536; return [v & 255, (v >> 8) & 255]; };
  const hex = (arr) => arr.map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  const cur = Math.round((-s.bat / s.bv) * 10);
  return [
    ["351", hex([...le(568), ...le(1000), ...le(1000), ...le(470)])],
    ["355", hex([...le(s.soc), ...le(99)])],
    ["356", hex([...le(Math.round(s.bv * 100)), ...le(cur), ...le(292), 0, 0])],
    ["359", hex([0, 0, 0, 0, 2, 0x50, 0x4e, 0])],
    ["35C", hex([0xc0, 0])],
    ["35E", hex([...new TextEncoder().encode("PYLON   ")])],
    ["373", hex([...le(Math.round(s.bv / 16 * 1000) - 6), ...le(Math.round(s.bv / 16 * 1000) + 9), ...le(301), ...le(303)])],
  ];
}

// Gói JBD giả lập (16 cell)
export function simulateJbd(s) {
  const be = (v) => { if (v < 0) v += 65536; return [(v >> 8) & 255, v & 255]; };
  const pkt = (cmd, data) => {
    const body = [0x00, data.length, ...data];
    const sum = body.reduce((a, b) => a + b, 0);
    const chk = (0x10000 - sum) & 0xffff;
    return [0xdd, cmd, ...body, chk >> 8, chk & 255, 0x77].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  };
  const cellBase = Math.round((s.bv / 16) * 1000);
  const cells = Array.from({ length: 16 }, (_, i) => cellBase + Math.round(Math.sin(i * 1.7) * 6) + (i === 9 ? 9 : 0));
  const basic = [
    ...be(Math.round(s.bv * 100)), ...be(Math.round((-s.bat / s.bv) * 100)), ...be(Math.round(2 * s.soc * 100)), ...be(20000),
    ...be(182), ...be((24 << 9) | (6 << 5) | 15), ...be(1 << 9), ...be(0), ...be(0),
    0x27, s.soc, 0b11, 16, 3, ...be(2731 + 291), ...be(2731 + 297), ...be(2731 + 305),
  ];
  return { "03": pkt(0x03, basic), "04": pkt(0x04, cells.flatMap(be)) };
}
