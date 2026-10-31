// =====================================================================
//  INSOLAR Gateway — ESP32
//  - Đọc inverter qua RS485 Modbus RTU hoặc qua dongle Solarman (V5, TCP 8899) trong LAN
//  - Nghe thụ động bus CAN pin <-> inverter (CAN-H/CAN-L, 500 kbit/s, chế độ listen-only)
//  - Đọc BMS từng cell: JBD/Xiaoxiang, Daly qua UART/RS485 (JBD còn đọc được qua Bluetooth)
//  - Kết nối ra ngoài tới Worker bằng WebSocket, nhận cấu hình và lệnh ghi cài đặt
//  Giải mã dữ liệu làm ở phía máy chủ; gateway chỉ gửi thanh ghi/khung thô.
// =====================================================================
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiManager.h>
#include <Preferences.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <map>
#include <vector>
#include "driver/twai.h"
#if GW_ENABLE_BLE
#include <NimBLEDevice.h>
#endif

// ---------------- Chân kết nối (ESP32 DevKit) ----------------
#define INV_RX 16   // RS485 inverter: RO  -> GPIO16
#define INV_TX 17   //                 DI  <- GPIO17
#define INV_DE 4    //                 DE+RE <- GPIO4 (bỏ qua nếu module tự đảo chiều)
#define BMS_RX 26   // RS485/TTL BMS:  RO/TX của BMS -> GPIO26
#define BMS_TX 27   //                 DI/RX của BMS <- GPIO27
#define BMS_DE 25
#define CAN_TX 21   // SN65HVD230: CTX <- GPIO21
#define CAN_RX 22   //             CRX -> GPIO22
#define LED_PIN 2
#define BOOT_BTN 0  // giữ 5 giây để xóa cấu hình WiFi/máy chủ

static const char* FW_VERSION = "1.0.0";

Preferences prefs;
WebSocketsClient ws;
WiFiClient v5client;
String srvUrl, gwId, gwKey;

struct Req { uint8_t code; uint16_t start; uint16_t count; };
struct Config {
  uint16_t poll = 10;
  uint8_t slave = 1;
  std::vector<Req> reqs;
  bool v5 = false;
  String v5host;
  uint16_t v5port = 8899;
  uint32_t v5serial = 0;
  bool can = false;
  String bmsKind;
  bool bmsBle = false;
  std::vector<String> bleNames;
  std::vector<std::pair<String, String>> bmsReqs;  // mã lệnh -> gói hex
  bool ready = false;
} cfg;

bool wsConnected = false, pollNow = false, canStarted = false;
uint32_t lastPoll = 0;
uint16_t v5seq = 1;
std::map<uint32_t, String> canFrames;

// ---------------- Tiện ích ----------------
static String toHex(const uint8_t* b, size_t n) {
  static const char* H = "0123456789ABCDEF";
  String s; s.reserve(n * 2);
  for (size_t i = 0; i < n; i++) { s += H[b[i] >> 4]; s += H[b[i] & 15]; }
  return s;
}
static std::vector<uint8_t> fromHex(const String& h) {
  std::vector<uint8_t> v;
  for (size_t i = 0; i + 1 < h.length(); i += 2) v.push_back((uint8_t)strtol(h.substring(i, i + 2).c_str(), nullptr, 16));
  return v;
}
static uint16_t crc16(const uint8_t* d, size_t n) {
  uint16_t c = 0xFFFF;
  for (size_t i = 0; i < n; i++) {
    c ^= d[i];
    for (int k = 0; k < 8; k++) c = (c & 1) ? (c >> 1) ^ 0xA001 : c >> 1;
  }
  return c;
}

// ---------------- Truyền RTU qua RS485 ----------------
static bool rs485Transact(HardwareSerial& port, int dePin, const uint8_t* req, size_t len, std::vector<uint8_t>& resp, size_t expect, uint32_t timeoutMs) {
  while (port.available()) port.read();
  if (dePin >= 0) digitalWrite(dePin, HIGH);
  port.write(req, len);
  port.flush();
  if (dePin >= 0) digitalWrite(dePin, LOW);
  resp.clear();
  uint32_t t0 = millis(), last = millis();
  while (millis() - t0 < timeoutMs) {
    while (port.available()) { resp.push_back(port.read()); last = millis(); }
    if (expect && resp.size() >= expect) break;
    if (!expect && resp.size() && millis() - last > 60) break;
    if (resp.size() >= 5 && (resp[1] & 0x80)) break;  // ngoại lệ Modbus
    delay(2);
  }
  return !resp.empty();
}

// ---------------- Truyền RTU qua dongle Solarman V5 ----------------
static bool v5Transact(const uint8_t* rtu, size_t len, std::vector<uint8_t>& resp, uint32_t timeoutMs) {
  if (!v5client.connected()) {
    v5client.stop();
    if (!v5client.connect(cfg.v5host.c_str(), cfg.v5port, 3000)) return false;
  }
  std::vector<uint8_t> f;
  uint16_t plen = 15 + len;
  uint16_t seq = v5seq++;
  if (v5seq > 0xFF) v5seq = 1;
  f.push_back(0xA5);
  f.push_back(plen & 0xFF); f.push_back(plen >> 8);
  f.push_back(0x10); f.push_back(0x45);
  f.push_back(seq & 0xFF); f.push_back(seq >> 8);
  for (int i = 0; i < 4; i++) f.push_back((cfg.v5serial >> (8 * i)) & 0xFF);
  f.push_back(0x02); f.push_back(0); f.push_back(0);
  for (int i = 0; i < 12; i++) f.push_back(0);
  f.insert(f.end(), rtu, rtu + len);
  uint8_t sum = 0;
  for (size_t i = 1; i < f.size(); i++) sum += f[i];
  f.push_back(sum); f.push_back(0x15);
  while (v5client.available()) v5client.read();
  v5client.write(f.data(), f.size());

  uint32_t t0 = millis();
  std::vector<uint8_t> buf;
  while (millis() - t0 < timeoutMs) {
    while (v5client.available()) buf.push_back(v5client.read());
    // tách từng khung V5 trong bộ đệm
    while (buf.size() >= 13) {
      if (buf[0] != 0xA5) { buf.erase(buf.begin()); continue; }
      size_t total = 13 + (buf[1] | (buf[2] << 8));
      if (buf.size() < total) break;
      bool ok = buf[total - 1] == 0x15 && buf[3] == 0x10 && buf[4] == 0x15 && buf[5] == (seq & 0xFF) && total > 27;
      if (ok) {
        resp.assign(buf.begin() + 25, buf.begin() + total - 2);
        return resp.size() >= 5;
      }
      buf.erase(buf.begin(), buf.begin() + total);  // bỏ khung keep-alive (0x4710) hoặc khung lạ
    }
    delay(5);
  }
  v5client.stop();
  return false;
}

static bool rtuTransact(const uint8_t* req, size_t len, std::vector<uint8_t>& resp, size_t expect) {
  if (cfg.v5) return v5Transact(req, len, resp, 4000);
  return rs485Transact(Serial2, INV_DE, req, len, resp, expect, 1000);
}

// Đọc thanh ghi (FC03/FC04)
static bool mbRead(uint8_t fc, uint16_t addr, uint16_t cnt, std::vector<uint16_t>& out, String& err) {
  uint8_t req[8] = {cfg.slave, fc, (uint8_t)(addr >> 8), (uint8_t)addr, (uint8_t)(cnt >> 8), (uint8_t)cnt, 0, 0};
  uint16_t c = crc16(req, 6); req[6] = c & 0xFF; req[7] = c >> 8;
  std::vector<uint8_t> r;
  for (int attempt = 0; attempt < 2; attempt++) {
    if (!rtuTransact(req, 8, r, 5 + 2 * cnt)) { err = "không phản hồi"; continue; }
    if (r.size() >= 5 && (r[1] & 0x80)) { err = "ngoại lệ Modbus " + String(r[2]); return false; }
    if (r.size() < (size_t)(5 + 2 * cnt) || r[1] != fc || r[2] != 2 * cnt) { err = "khung sai độ dài"; continue; }
    uint16_t rc = crc16(r.data(), 3 + 2 * cnt);
    if (r[3 + 2 * cnt] != (rc & 0xFF) || r[4 + 2 * cnt] != (rc >> 8)) { err = "sai CRC"; continue; }
    out.clear();
    for (uint16_t i = 0; i < cnt; i++) out.push_back((r[3 + 2 * i] << 8) | r[4 + 2 * i]);
    return true;
  }
  return false;
}

// Ghi thanh ghi (FC06 / FC16)
static bool mbWrite(uint8_t fc, uint16_t addr, const std::vector<uint16_t>& vals, String& err) {
  std::vector<uint8_t> req;
  req.push_back(cfg.slave);
  if (fc == 6 && vals.size() == 1) {
    req.push_back(6); req.push_back(addr >> 8); req.push_back(addr & 0xFF); req.push_back(vals[0] >> 8); req.push_back(vals[0] & 0xFF);
  } else {
    req.push_back(16); req.push_back(addr >> 8); req.push_back(addr & 0xFF);
    req.push_back(vals.size() >> 8); req.push_back(vals.size() & 0xFF); req.push_back(vals.size() * 2);
    for (auto v : vals) { req.push_back(v >> 8); req.push_back(v & 0xFF); }
  }
  uint16_t c = crc16(req.data(), req.size());
  req.push_back(c & 0xFF); req.push_back(c >> 8);
  std::vector<uint8_t> r;
  if (!rtuTransact(req.data(), req.size(), r, 8)) { err = "inverter không phản hồi"; return false; }
  if (r.size() >= 5 && (r[1] & 0x80)) { err = "inverter từ chối (ngoại lệ " + String(r[2]) + ")"; return false; }
  if (r.size() < 8) { err = "phản hồi ghi không hợp lệ"; return false; }
  return true;
}

// ---------------- CAN (TWAI, chỉ nghe) ----------------
static void canStart() {
  if (canStarted) return;
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT((gpio_num_t)CAN_TX, (gpio_num_t)CAN_RX, TWAI_MODE_LISTEN_ONLY);
  g.rx_queue_len = 64;
  twai_timing_config_t t = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  if (twai_driver_install(&g, &t, &f) == ESP_OK && twai_start() == ESP_OK) canStarted = true;
}
static void canStop() {
  if (!canStarted) return;
  twai_stop(); twai_driver_uninstall();
  canStarted = false;
}
static void canPump() {
  if (!canStarted) return;
  twai_message_t m;
  while (twai_receive(&m, 0) == ESP_OK) {
    if (m.rtr) continue;
    if (canFrames.size() < 96 || canFrames.count(m.identifier)) canFrames[m.identifier] = toHex(m.data, m.data_length_code);
  }
}

// ---------------- BMS qua UART ----------------
static String bmsUartQuery(const String& hex, std::vector<String>* multi) {
  auto req = fromHex(hex);
  std::vector<uint8_t> r;
  rs485Transact(Serial1, BMS_DE, req.data(), req.size(), r, 0, 600);
  if (r.empty()) return "";
  if (!multi) return toHex(r.data(), r.size());
  // Daly trả nhiều khung 13 byte liên tiếp (lệnh 0x95/0x96)
  for (size_t i = 0; i + 13 <= r.size();) {
    if (r[i] != 0xA5) { i++; continue; }
    multi->push_back(toHex(&r[i], 13));
    i += 13;
  }
  return "";
}

#if GW_ENABLE_BLE
// ---------------- BMS JBD qua Bluetooth ----------------
static NimBLEClient* bleClient = nullptr;
static NimBLERemoteCharacteristic* bleTx = nullptr;
static std::vector<uint8_t> bleBuf;
static uint32_t lastBleTry = 0;

static void bleNotify(NimBLERemoteCharacteristic*, uint8_t* data, size_t len, bool) {
  bleBuf.insert(bleBuf.end(), data, data + len);
}
static bool bleEnsure() {
  if (bleClient && bleClient->isConnected() && bleTx) return true;
  if (millis() - lastBleTry < 60000 && lastBleTry) return false;
  lastBleTry = millis();
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);
  NimBLEScanResults res = scan->start(5, false);
  for (int i = 0; i < res.getCount(); i++) {
    NimBLEAdvertisedDevice d = res.getDevice(i);
    String name = d.getName().c_str();
    bool match = false;
    for (auto& n : cfg.bleNames) if (n.length() && name.indexOf(n) >= 0) match = true;
    if (!match) continue;
    if (!bleClient) bleClient = NimBLEDevice::createClient();
    if (!bleClient->connect(&d)) continue;
    NimBLERemoteService* svc = bleClient->getService("ff00");
    if (!svc) { bleClient->disconnect(); continue; }
    NimBLERemoteCharacteristic* rx = svc->getCharacteristic("ff01");
    bleTx = svc->getCharacteristic("ff02");
    if (!rx || !bleTx || !rx->subscribe(true, bleNotify)) { bleClient->disconnect(); bleTx = nullptr; continue; }
    return true;
  }
  return false;
}
static String bleJbdQuery(const String& hex) {
  if (!bleEnsure()) return "";
  bleBuf.clear();
  auto req = fromHex(hex);
  bleTx->writeValue(req.data(), req.size(), false);
  uint32_t t0 = millis();
  while (millis() - t0 < 1500) {
    if (bleBuf.size() >= 7 && bleBuf[0] == 0xDD && bleBuf.size() >= (size_t)(4 + bleBuf[3] + 3) && bleBuf.back() == 0x77)
      return toHex(bleBuf.data(), bleBuf.size());
    delay(10);
  }
  return "";
}
#endif

// ---------------- Gửi dữ liệu ----------------
static void sendJson(JsonDocument& doc) {
  String s;
  serializeJson(doc, s);
  ws.sendTXT(s);
}

static void doPoll() {
  if (!cfg.ready) return;
  digitalWrite(LED_PIN, HIGH);
  JsonDocument doc;
  doc["t"] = "modbus";
  doc["rssi"] = WiFi.RSSI();
  JsonArray blocks = doc["blocks"].to<JsonArray>();
  String err;
  int ok = 0, fail = 0;
  for (auto& r : cfg.reqs) {
    // chia nhỏ tối đa 100 thanh ghi mỗi lần đọc
    for (uint16_t off = 0; off < r.count; off += 100) {
      uint16_t n = min<uint16_t>(100, r.count - off);
      std::vector<uint16_t> vals;
      if (mbRead(r.code, r.start + off, n, vals, err)) {
        JsonArray b = blocks.add<JsonArray>();
        b.add(r.code); b.add(r.start + off);
        JsonArray v = b.add<JsonArray>();
        for (auto x : vals) v.add(x);
        ok++;
      } else fail++;
      ws.loop();
      delay(30);
    }
  }
  if (fail) doc["err"] = err;
  if (ok) sendJson(doc);

  if (cfg.can && canStarted && !canFrames.empty()) {
    JsonDocument c;
    c["t"] = "can";
    JsonArray fr = c["frames"].to<JsonArray>();
    char id[10];
    for (auto& kv : canFrames) {
      snprintf(id, sizeof(id), "%lX", (unsigned long)kv.first);
      JsonArray f = fr.add<JsonArray>(); f.add(id); f.add(kv.second);
    }
    sendJson(c);
    canFrames.clear();
  }

  if (cfg.bmsKind.length() && cfg.bmsReqs.size()) {
    JsonDocument b;
    b["t"] = "bms";
    b["kind"] = cfg.bmsKind;
    JsonObject frames = b["frames"].to<JsonObject>();
    int got = 0;
    for (auto& q : cfg.bmsReqs) {
      String hex;
      if (cfg.bmsBle) {
#if GW_ENABLE_BLE
        if (cfg.bmsKind == "jbd") hex = bleJbdQuery(q.second);
#endif
      } else if (cfg.bmsKind == "daly" && (q.first == "95" || q.first == "96")) {
        std::vector<String> multi;
        bmsUartQuery(q.second, &multi);
        if (!multi.empty()) { JsonArray a = frames[q.first].to<JsonArray>(); for (auto& m : multi) a.add(m); got++; }
        continue;
      } else hex = bmsUartQuery(q.second, nullptr);
      if (hex.length()) { frames[q.first] = hex; got++; }
      ws.loop();
    }
    if (got) sendJson(b);
  }
  digitalWrite(LED_PIN, LOW);
}

// ---------------- Xử lý lệnh từ máy chủ ----------------
static void applyConfig(JsonDocument& m) {
  cfg.poll = max<uint16_t>(5, m["poll"] | 10);
  cfg.slave = m["slave"] | 1;
  cfg.reqs.clear();
  for (JsonArray r : m["requests"].as<JsonArray>()) cfg.reqs.push_back({(uint8_t)(int)r[0], (uint16_t)(int)r[1], (uint16_t)(int)r[2]});
  cfg.v5 = String((const char*)(m["transport"] | "rs485")) == "solarman_v5";
  if (cfg.v5) {
    cfg.v5host = (const char*)(m["v5"]["host"] | "");
    cfg.v5port = m["v5"]["port"] | 8899;
    cfg.v5serial = m["v5"]["serial"] | 0;
    v5client.stop();
  }
  cfg.can = m["can"]["enabled"] | false;
  if (cfg.can) canStart(); else canStop();
  cfg.bmsKind = "";
  cfg.bmsReqs.clear();
  cfg.bleNames.clear();
  if (!m["bms"].isNull()) {
    cfg.bmsKind = (const char*)(m["bms"]["kind"] | "");
    cfg.bmsBle = String((const char*)(m["bms"]["transport"] | "uart")) == "ble";
    for (JsonVariant n : m["bms"]["ble_names"].as<JsonArray>()) cfg.bleNames.push_back(n.as<const char*>());
    for (JsonPair kv : m["bms"]["requests"].as<JsonObject>()) cfg.bmsReqs.push_back({kv.key().c_str(), kv.value().as<const char*>()});
  }
  cfg.ready = true;
  pollNow = true;
}

static void handleMessage(const char* payload, size_t len) {
  JsonDocument m;
  if (deserializeJson(m, payload, len)) return;
  String t = m["t"] | "";
  if (t == "config") { applyConfig(m); return; }
  if (t == "poll") { pollNow = true; return; }
  if (t == "write" || t == "read") {
    JsonDocument a;
    a["t"] = "ack";
    a["cid"] = m["cid"];
    String err;
    uint8_t oldSlave = cfg.slave;
    if (!m["slave"].isNull()) cfg.slave = m["slave"];
    bool ok;
    if (t == "write") {
      std::vector<uint16_t> vals;
      for (JsonVariant v : m["values"].as<JsonArray>()) vals.push_back(v.as<uint16_t>());
      ok = vals.size() && mbWrite(m["fc"] | 16, m["addr"] | 0, vals, err);
    } else {
      std::vector<uint16_t> vals;
      ok = mbRead(m["fc"] | 3, m["addr"] | 0, min<int>(125, m["count"] | 1), vals, err);
      if (ok) { JsonArray v = a["values"].to<JsonArray>(); for (auto x : vals) v.add(x); }
    }
    cfg.slave = oldSlave;
    a["ok"] = ok;
    if (!ok) a["error"] = err;
    sendJson(a);
  }
}

static void onWs(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED: {
      wsConnected = true;
      JsonDocument h;
      h["t"] = "hello"; h["fw"] = FW_VERSION; h["rssi"] = WiFi.RSSI(); h["ip"] = WiFi.localIP().toString();
      sendJson(h);
      break;
    }
    case WStype_DISCONNECTED: wsConnected = false; break;
    case WStype_TEXT: handleMessage((const char*)payload, len); break;
    default: break;
  }
}

// ---------------- Kết nối máy chủ ----------------
static void connectServer() {
  String u = srvUrl;
  u.trim();
  bool ssl = !u.startsWith("ws://") && !u.startsWith("http://");
  int p = u.indexOf("://");
  if (p >= 0) u = u.substring(p + 3);
  String host = u, base = "";
  int slash = u.indexOf('/');
  if (slash >= 0) { host = u.substring(0, slash); base = u.substring(slash); if (base.endsWith("/")) base.remove(base.length() - 1); }
  uint16_t port = ssl ? 443 : 80;
  int colon = host.indexOf(':');
  if (colon >= 0) { port = host.substring(colon + 1).toInt(); host = host.substring(0, colon); }
  String path = base + "/gw/ws?id=" + gwId + "&key=" + gwKey;
  if (ssl) ws.beginSSL(host.c_str(), port, path.c_str());
  else ws.begin(host.c_str(), port, path.c_str());
  ws.onEvent(onWs);
  ws.setReconnectInterval(5000);
  ws.enableHeartbeat(20000, 5000, 2);
}

// ---------------- Cấu hình WiFi + máy chủ (cổng cấu hình) ----------------
static bool shouldSave = false;
static void setupWifi(bool forcePortal) {
  prefs.begin("gw", false);
  srvUrl = prefs.getString("srv", "");
  gwId = prefs.getString("id", "");
  gwKey = prefs.getString("key", "");

  WiFiManager wm;
  WiFiManagerParameter pSrv("srv", "Máy chủ (vd wss://monitor.tenmien.vn)", srvUrl.c_str(), 120);
  WiFiManagerParameter pId("id", "Gateway ID", gwId.c_str(), 40);
  WiFiManagerParameter pKey("key", "Khóa", gwKey.c_str(), 64);
  wm.addParameter(&pSrv); wm.addParameter(&pId); wm.addParameter(&pKey);
  wm.setSaveParamsCallback([]() { shouldSave = true; });
  wm.setSaveConfigCallback([]() { shouldSave = true; });
  wm.setConfigPortalTimeout(300);
  wm.setTitle("INSOLAR Gateway");
  bool ok;
  if (forcePortal || !srvUrl.length() || !gwId.length()) ok = wm.startConfigPortal("INSOLAR-GW", "insolar123");
  else ok = wm.autoConnect("INSOLAR-GW", "insolar123");
  if (shouldSave) {
    srvUrl = pSrv.getValue(); gwId = pId.getValue(); gwKey = pKey.getValue();
    prefs.putString("srv", srvUrl); prefs.putString("id", gwId); prefs.putString("key", gwKey);
  }
  if (!ok) ESP.restart();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BOOT_BTN, INPUT_PULLUP);
  pinMode(INV_DE, OUTPUT); digitalWrite(INV_DE, LOW);
  pinMode(BMS_DE, OUTPUT); digitalWrite(BMS_DE, LOW);
  Serial2.begin(9600, SERIAL_8N1, INV_RX, INV_TX);   // Deye/Solis/SRNE: 9600 8N1
  Serial1.begin(9600, SERIAL_8N1, BMS_RX, BMS_TX);
#if GW_ENABLE_BLE
  NimBLEDevice::init("INSOLAR-GW");
#endif
  bool force = digitalRead(BOOT_BTN) == LOW;
  setupWifi(force);
  connectServer();
  Serial.printf("INSOLAR GW %s — %s\n", FW_VERSION, gwId.c_str());
}

void loop() {
  ws.loop();
  canPump();
  // Giữ BOOT 5 giây: xóa cấu hình và mở lại cổng cài đặt
  static uint32_t pressed = 0;
  if (digitalRead(BOOT_BTN) == LOW) {
    if (!pressed) pressed = millis();
    if (millis() - pressed > 5000) { prefs.clear(); WiFiManager wm; wm.resetSettings(); ESP.restart(); }
  } else pressed = 0;

  if (wsConnected && cfg.ready && (pollNow || millis() - lastPoll > (uint32_t)cfg.poll * 1000)) {
    pollNow = false;
    lastPoll = millis();
    doPoll();
  }
  // Nháy LED chậm khi chưa kết nối máy chủ
  if (!wsConnected) digitalWrite(LED_PIN, (millis() / 500) % 2);
  if (WiFi.status() != WL_CONNECTED) { static uint32_t t = 0; if (millis() - t > 15000) { t = millis(); WiFi.reconnect(); } }
  delay(2);
}
