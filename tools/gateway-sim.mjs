// Gateway giả lập: kết nối Worker như một ESP32 thật để thử toàn bộ luồng (dữ liệu + lệnh cài đặt).
// Dùng: node tools/gateway-sim.bundle.mjs ws://localhost:8787 gw_xxx KEY deye_hybrid '{"mppt":2,"phase":1,"pack":1}'
import { simulateRegisters, simulateCan, simulateJbd } from "../src/lib/simulator.js";

const [base, id, key, profile = "deye_hybrid", paramsJson = "{}"] = process.argv.slice(2);
const params = JSON.parse(paramsJson);
const overrides = {}; // thanh ghi đã bị ghi từ xa
let cfg = null, timer = null, ws;

function readBlock(regs, code, start, count) {
  const out = [];
  for (let a = start; a < start + count; a++) out.push(overrides[code]?.[a] ?? regs[code]?.[a] ?? 0);
  return out;
}

function poll() {
  if (!cfg || ws.readyState !== 1) return;
  const { regs, scenario } = simulateRegisters(profile, params, {});
  ws.send(JSON.stringify({ t: "modbus", rssi: -58, blocks: cfg.requests.map(([c, s, n]) => [c, s, readBlock(regs, c, s, n)]) }));
  if (cfg.can?.enabled) ws.send(JSON.stringify({ t: "can", frames: simulateCan(scenario) }));
  if (cfg.bms) ws.send(JSON.stringify({ t: "bms", kind: cfg.bms.kind, frames: simulateJbd(scenario) }));
}

function connect() {
  ws = new WebSocket(`${base}/gw/ws?id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`);
  ws.onopen = () => { console.log("connected"); ws.send(JSON.stringify({ t: "hello", fw: "sim-1.0", rssi: -58 })); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "config") {
      cfg = m;
      console.log("config", m.requests.length, "requests, poll", m.poll, "s");
      clearInterval(timer);
      timer = setInterval(poll, m.poll * 1000);
      poll();
    } else if (m.t === "poll") poll();
    else if (m.t === "write") {
      const code = 3;
      overrides[code] ??= {};
      m.values.forEach((v, i) => (overrides[code][m.addr + i] = v));
      console.log("WRITE fc", m.fc, "addr", m.addr, "values", m.values);
      setTimeout(() => ws.send(JSON.stringify({ t: "ack", cid: m.cid, ok: true })), 300);
    } else if (m.t === "read") {
      const { regs } = simulateRegisters(profile, params, {});
      ws.send(JSON.stringify({ t: "ack", cid: m.cid, ok: true, values: readBlock(regs, m.fc, m.addr, m.count) }));
    }
  };
  ws.onclose = (e) => { console.log("closed", e.code); clearInterval(timer); setTimeout(connect, 3000); };
  ws.onerror = () => {};
}
connect();
