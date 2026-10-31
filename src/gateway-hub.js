// Durable Object: mỗi gateway INSOLAR một phiên bản.
// Giữ kết nối WebSocket (hibernation), giải mã dữ liệu Modbus/CAN/BMS, gửi lệnh cài đặt và chờ phản hồi.
import { DurableObject } from "cloudflare:workers";
import { prepare, decode, settingsSchema, encodeWrite } from "./lib/modbus-profile.js";
import { fromModbus, mergeBattery, summary } from "./lib/canonical.js";
import { decodeCan } from "./lib/can.js";
import { decodeBms, BMS_REQUESTS } from "./lib/bms.js";

const FLUSH_MS = 5 * 60e3;
const PERSIST_MS = 60e3;
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const slot5 = () => new Date(Math.floor(Date.now() / 300e3) * 300e3).toISOString();

export class GatewayHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const s = await this.ctx.storage.get(["gw", "regs", "can", "bms", "latest", "lastFlush", "canFrames", "bmsFrames"]);
    this.gw = s.get("gw") || null;
    this.regs = s.get("regs") || {};
    this.canFrames = s.get("canFrames") || {};
    this.bmsFrames = s.get("bmsFrames") || null;
    this.latest = s.get("latest") || null;
    this.lastFlush = s.get("lastFlush") || 0;
    this.lastPersist = Date.now();
    this.loaded = true;
  }

  online() {
    return this.ctx.getWebSockets().length > 0;
  }

  config() {
    const g = this.gw;
    const prep = prepare(g.profile, JSON.parse(g.params || "{}"));
    const bms = g.bms_kind
      ? { kind: g.bms_kind, transport: g.bms_transport || "uart", ble_names: (g.bms_ble_names || "").split(",").map((x) => x.trim()).filter(Boolean), requests: BMS_REQUESTS[g.bms_kind] }
      : null;
    return {
      t: "config", poll: g.poll || 10, slave: g.slave || 1, requests: prep.requests,
      transport: g.transport || "rs485", v5: g.transport === "solarman_v5" ? { host: g.v5_host, port: 8899, serial: Number(g.v5_serial || 0) } : null,
      can: { enabled: !!g.can_enabled, bitrate: 500000 }, bms,
    };
  }

  send(obj) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
  }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/connect") {
      this.gw = JSON.parse(req.headers.get("X-Gateway"));
      await this.ctx.storage.put("gw", this.gw);
      for (const old of this.ctx.getWebSockets()) { try { old.close(4000, "replaced"); } catch {} }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify(this.config()));
      this.ctx.waitUntil(this.env.DB.prepare("UPDATE gateways SET last_seen=?2, ip=?3 WHERE id=?1")
        .bind(this.gw.id, new Date().toISOString(), req.headers.get("CF-Connecting-IP")).run());
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (p === "/live") {
      return json({ online: this.online(), detail: this.latest });
    }

    if (p === "/config" && req.method === "POST") {
      this.gw = await req.json();
      await this.ctx.storage.put("gw", this.gw);
      if (this.online()) this.send(this.config());
      return json({ ok: true });
    }

    if ((p === "/write" || p === "/read") && req.method === "POST") {
      if (!this.gw) return json({ error: "Gateway chưa kết nối lần nào" }, 400);
      if (!this.online()) return json({ error: "Gateway đang ngoại tuyến — không gửi được lệnh" }, 409);
      const b = await req.json();
      let cmd, name, settingKey = null, valueStr = null;
      if (p === "/write") {
        if (!this.gw.allow_write) return json({ error: "Gateway này đang tắt quyền cài đặt từ xa" }, 403);
        const prep = prepare(this.gw.profile, JSON.parse(this.gw.params || "{}"));
        try {
          if (b.raw) {
            const vals = (b.values || []).map(Number);
            if (!vals.length || vals.some((v) => !Number.isInteger(v) || v < 0 || v > 65535)) throw new Error("Giá trị thanh ghi phải 0–65535");
            cmd = { fc: vals.length === 1 && b.fc === 6 ? 6 : 16, addr: Number(b.addr), values: vals, name: `Ghi thanh ghi ${b.addr}` };
          } else cmd = encodeWrite(prep, b.key, b.value, this.regs);
        } catch (e) {
          return json({ error: e.message }, 400);
        }
        name = cmd.name; settingKey = b.key || "raw"; valueStr = String(b.raw ? b.values.join(",") : b.value);
      } else {
        const count = Math.min(125, Math.max(1, Number(b.count) || 1));
        cmd = { fc: Number(b.fc) === 4 ? 4 : 3, addr: Number(b.addr), count, name: `Đọc ${count} thanh ghi từ ${b.addr}` };
        name = cmd.name;
      }
      const row = await this.env.DB.prepare(
        "INSERT INTO commands (station_id, gateway_id, setting, name, value, fc, addr, values_json, status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'sent') RETURNING id"
      ).bind(this.gw.station_id ?? null, this.gw.id, settingKey, name, valueStr, cmd.fc, cmd.addr, JSON.stringify(cmd.values || [cmd.count])).first();
      const cid = row.id;
      const ack = await new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(cid); resolve({ ok: false, error: "Hết thời gian chờ gateway phản hồi" }); }, 20000);
        this.pending.set(cid, (m) => { clearTimeout(timer); resolve(m); });
        this.send(p === "/write"
          ? { t: "write", cid, slave: this.gw.slave || 1, fc: cmd.fc, addr: cmd.addr, values: cmd.values }
          : { t: "read", cid, slave: this.gw.slave || 1, fc: cmd.fc, addr: cmd.addr, count: cmd.count });
      });
      await this.env.DB.prepare("UPDATE commands SET status=?2, error=?3, finished_at=?4 WHERE id=?1")
        .bind(cid, ack.ok ? "ok" : "error", ack.ok ? null : String(ack.error || "Lỗi").slice(0, 300), new Date().toISOString()).run();
      if (ack.ok && p === "/write") {
        // Cập nhật bộ nhớ thanh ghi rồi yêu cầu đọc lại ngay
        const code = String(cmd.fc === 6 || cmd.fc === 16 ? 3 : cmd.fc);
        this.regs[code] ??= {};
        cmd.values.forEach((v, i) => (this.regs[code][cmd.addr + i] = v));
        this.recompute();
        this.send({ t: "poll" });
      }
      return json({ ok: !!ack.ok, error: ack.error || null, values: ack.values || null, command_id: cid, name });
    }

    return json({ error: "not found" }, 404);
  }

  recompute() {
    const g = this.gw;
    if (!g) return;
    const prep = prepare(g.profile, JSON.parse(g.params || "{}"));
    const decoded = decode(prep, this.regs);
    const d = fromModbus(decoded, g.profile, { invertBattery: !!g.invert_battery, invertGrid: !!g.invert_grid });
    const frames = Object.entries(this.canFrames || {}).filter(([, f]) => Date.now() - f.ts < 120e3).map(([id, f]) => [id, f.hex]);
    const can = g.can_enabled && frames.length ? decodeCan(frames) : null;
    const bms = this.bmsFrames ? decodeBms(this.bmsFrames.kind, this.bmsFrames.frames) : null;
    mergeBattery(d, can, bms);
    const byKey = new Map(decoded.map((x) => [x.key, x.value]));
    d.settings = settingsSchema(prep).map((s) => ({ ...s, value: byKey.get(s.key) ?? null }));
    d.settings_enabled = !!g.allow_write;
    d.device.profile_label = prep.label;
    d.device.manufacturer = prep.manufacturer;
    d.source = "gateway";
    d.gateway = { id: g.id, fw: g.fw || null, rssi: g.rssi ?? null, transport: g.transport };
    d.updated = new Date().toISOString();
    this.latest = d;
  }

  async webSocketMessage(ws, message) {
    await this.load();
    let m;
    try { m = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); } catch { return; }
    const now = Date.now();
    switch (m.t) {
      case "hello":
        if (this.gw) {
          this.gw.fw = m.fw || null; this.gw.rssi = m.rssi ?? null;
          this.ctx.waitUntil(this.env.DB.prepare("UPDATE gateways SET fw=?2, rssi=?3, last_seen=?4 WHERE id=?1")
            .bind(this.gw.id, this.gw.fw, this.gw.rssi, new Date().toISOString()).run());
        }
        ws.send(JSON.stringify(this.config()));
        return;
      case "ack": {
        const fn = this.pending.get(m.cid);
        if (fn) { this.pending.delete(m.cid); fn(m); }
        return;
      }
      case "modbus":
        for (const [code, start, vals] of m.blocks || []) {
          const c = String(code);
          this.regs[c] ??= {};
          (vals || []).forEach((v, i) => (this.regs[c][start + i] = v));
        }
        if (m.rssi !== undefined && this.gw) this.gw.rssi = m.rssi;
        break;
      case "can":
        for (const [id, hex] of m.frames || []) this.canFrames[String(id)] = { hex, ts: now };
        break;
      case "bms":
        this.bmsFrames = { kind: m.kind, frames: m.frames, ts: now };
        break;
      default:
        return;
    }
    this.recompute();
    if (now - this.lastPersist > PERSIST_MS) {
      this.lastPersist = now;
      await this.ctx.storage.put({ regs: this.regs, canFrames: this.canFrames, bmsFrames: this.bmsFrames, latest: this.latest, gw: this.gw });
    }
    if (m.t === "modbus" && now - this.lastFlush > FLUSH_MS) {
      this.lastFlush = now;
      await this.ctx.storage.put("lastFlush", now);
      await this.flush();
    }
  }

  async flush() {
    const d = this.latest, g = this.gw;
    if (!d || !g?.station_id) return;
    const s = summary(d);
    const iso = new Date().toISOString();
    const faulty = d.device.fault && !/^(ok|normal|no fault|none|0|\[\])$/i.test(String(d.device.fault)) && !/^\[?\s*\]?$/.test(String(d.device.fault));
    const status = faulty || (d.can?.protections?.length) ? "alarm" : "online";
    const slim = { ...d };
    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE stations SET status=?2, pv_power_w=?3, load_power_w=?4, grid_power_w=?5, battery_power_w=?6, battery_soc=?7,
        today_kwh=?8, total_kwh=COALESCE(?9,total_kwh), data_time=?10, synced_at=?10 WHERE id=?1`)
        .bind(g.station_id, status, s.pv_power_w, s.load_power_w, s.grid_power_w, s.battery_power_w, s.battery_soc, s.today_kwh, s.total_kwh, iso),
      this.env.DB.prepare(`INSERT OR REPLACE INTO readings (station_id, ts, pv_power_w, load_power_w, grid_power_w, battery_power_w, battery_soc,
        today_kwh, load_kwh, import_kwh, export_kwh, charge_kwh, discharge_kwh) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`)
        .bind(g.station_id, slot5(), s.pv_power_w, s.load_power_w, s.grid_power_w, s.battery_power_w, s.battery_soc, s.today_kwh,
          d.load.today_kwh ?? null, d.grid.today_import ?? null, d.grid.today_export ?? null, d.battery.today_charge ?? null, d.battery.today_discharge ?? null),
      this.env.DB.prepare("INSERT OR REPLACE INTO details (station_id, json, updated_at) VALUES (?1, ?2, ?3)").bind(g.station_id, JSON.stringify(slim), iso),
      this.env.DB.prepare("UPDATE gateways SET last_seen=?2, rssi=?3 WHERE id=?1").bind(g.id, iso, g.rssi ?? null),
    ]);
  }

  async webSocketClose(ws) {
    await this.load();
    try { ws.close(1000, "bye"); } catch {}
    if (this.gw?.station_id && !this.online()) {
      await this.env.DB.prepare("UPDATE stations SET status='offline' WHERE id=?1").bind(this.gw.station_id).run();
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
