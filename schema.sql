-- Tài khoản cloud của từng hãng (thông tin đăng nhập được mã hóa AES-GCM)
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  label TEXT NOT NULL,
  creds_enc TEXT NOT NULL,
  token_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Gateway INSOLAR (ESP32) gắn tại nhà khách: đọc RS485/CAN/BMS, nhận lệnh cài đặt
CREATE TABLE IF NOT EXISTS gateways (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  profile TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',      -- {"mppt":2,"phase":1,"pack":1}
  slave INTEGER NOT NULL DEFAULT 1,
  transport TEXT NOT NULL DEFAULT 'rs485', -- rs485 | solarman_v5
  v5_host TEXT, v5_serial TEXT,
  poll INTEGER NOT NULL DEFAULT 10,
  can_enabled INTEGER NOT NULL DEFAULT 1,
  bms_kind TEXT,                           -- jbd | daly | NULL
  bms_transport TEXT DEFAULT 'uart',       -- uart | ble
  bms_ble_names TEXT,
  allow_write INTEGER NOT NULL DEFAULT 1,
  invert_battery INTEGER NOT NULL DEFAULT 0,
  invert_grid INTEGER NOT NULL DEFAULT 0,
  station_id INTEGER,
  last_seen TEXT, fw TEXT, ip TEXT, rssi INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Trạm (nhà máy) đã chuẩn hóa
CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL DEFAULT 0,   -- 0 = trạm từ gateway
  gateway_id TEXT,
  brand TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  name TEXT,
  customer TEXT, phone TEXT, note TEXT, address TEXT,
  capacity_kwp REAL,
  battery_kwh REAL,
  status TEXT,
  pv_power_w REAL, load_power_w REAL, grid_power_w REAL, battery_power_w REAL, battery_soc REAL,
  today_kwh REAL, total_kwh REAL,
  data_time TEXT, synced_at TEXT,
  share_token TEXT,
  lat REAL, lon REAL,   -- toạ độ trạm (lấy thời tiết khu vực)
  UNIQUE(account_id, ext_id)
);

-- Dữ liệu chi tiết gần nhất (JSON chuẩn hóa)
CREATE TABLE IF NOT EXISTS details (
  station_id INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Lịch sử 5 phút/lần
CREATE TABLE IF NOT EXISTS readings (
  station_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  pv_power_w REAL, load_power_w REAL, grid_power_w REAL, battery_power_w REAL, battery_soc REAL,
  today_kwh REAL, load_kwh REAL, import_kwh REAL, export_kwh REAL, charge_kwh REAL, discharge_kwh REAL,
  PRIMARY KEY (station_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

-- Nhật ký lệnh cài đặt từ xa
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER, gateway_id TEXT,
  setting TEXT, name TEXT, value TEXT,
  fc INTEGER, addr INTEGER, values_json TEXT,
  status TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
