# INSOLAR Monitor

Hệ thống giám sát và cài đặt điện mặt trời đa hãng, chạy hoàn toàn trên Cloudflare của anh (Worker + D1 + Durable Objects), tên miền riêng, không dùng chung gì với INS / insolar.vn.

## Hai cách lấy dữ liệu

| Cách | Đọc được | Cài đặt từ xa |
|---|---|---|
| **Gateway INSOLAR (ESP32)** gắn tại nhà khách | Toàn bộ thanh ghi inverter (PV từng MPPT, áp/dòng từng pha, tần số, nhiệt độ, trạng thái, lỗi…), khung CAN pin↔inverter, BMS từng cell | Có — giống app của hãng (chế độ làm việc, dòng sạc/xả, SOC, lịch 6 mốc, bán điện dư, máy phát…) |
| **Cloud hãng** (Solarman, Deye Cloud, SolisCloud, SolaX) | Tổng quan + danh sách thông số hãng cung cấp | **Deye Cloud**: chế độ làm việc, ưu tiên năng lượng, bán điện dư, dòng sạc/xả, SOC thấp, lịch 6 mốc (cần bật quyền điều khiển thiết bị cho App trên developer.deyecloud.com). **SolisCloud**: chế độ lưu trữ, sạc từ lưới, dự phòng, dòng sạc/xả, SOC, 6 khung sạc + 6 khung xả (cần email Solis xin mở API điều khiển). Solarman/SolaX: không |

## Deploy

Kho `INSOLARVN/insolar-monitor` đã nối Cloudflare Workers Builds: mỗi lần đẩy lên nhánh `main` là Cloudflare tự deploy Worker `insolar-monitor`.

## Cài lên Cloudflare (1 lần)

```bash
npm install
npx wrangler login
npx wrangler d1 create insolar-monitor              # chép database_id vào wrangler.toml
npx wrangler d1 execute insolar-monitor --remote --file=schema.sql
npx wrangler secret put ADMIN_PASSWORD              # mật khẩu đăng nhập
npx wrangler secret put ENC_KEY                     # chuỗi ngẫu nhiên ≥ 32 ký tự, KHÔNG được làm mất
npx wrangler deploy
```

Tên miền riêng: mở dòng `routes` trong `wrangler.toml`, sửa tên miền, `npx wrangler deploy` lại.
Durable Objects loại SQLite chạy được trên gói Workers miễn phí.

## Gateway INSOLAR

**Linh kiện** (khoảng 250–350 nghìn đồng):
- ESP32 DevKit V1 (ESP32-WROOM-32)
- 1–2 module RS485 3.3V (MAX3485 hoặc loại tự đảo chiều): 1 cho inverter, 1 cho BMS (tuỳ chọn)
- 1 module CAN SN65HVD230 (3.3V)
- Nguồn 5V (hạ áp từ 12/24V hoặc adapter USB)

**Nối dây**

| Module | Chân | ESP32 |
|---|---|---|
| RS485 inverter | RO · DI · DE+RE | GPIO16 · GPIO17 · GPIO4 |
| CAN SN65HVD230 | CTX · CRX | GPIO21 · GPIO22 |
| RS485/TTL BMS | RO · DI · DE+RE | GPIO26 · GPIO27 · GPIO25 |

- A/B RS485 → cổng Modbus/RS485 của inverter (Deye: cổng "Modbus" hoặc "Meter-485" tuỳ dòng). Tốc độ 9600 8N1.
- CAN-H/CAN-L → nối song song vào dây CAN giữa pin và inverter. Gateway chỉ **nghe**, không gửi gì lên bus.
- Không muốn đi dây RS485? Chọn "Qua dongle Solarman trong mạng LAN": gateway nói chuyện với dongle Solarman sẵn có (cổng 8899).

**Nạp firmware**: mở `https://<tên miền>/flash` bằng Chrome/Edge trên máy tính, cắm ESP32, bấm nạp.
(Hoặc tự build: thư mục `firmware/`, PlatformIO → Upload.)

**Cấu hình**: trong app → Gateway → `+` → nhập tên trạm, dòng inverter… → app hiện **Máy chủ / Gateway ID / Khóa**.
ESP32 phát WiFi `INSOLAR-GW` (mật khẩu `insolar123`) → chọn WiFi nhà khách, dán 3 thông tin trên → Lưu.
Giữ nút BOOT 5 giây để cài lại.

## Dòng inverter hỗ trợ (đọc + cài đặt qua gateway)

Deye hybrid 1 pha / 3 pha (LP3, HP3), Deye hòa lưới, Deye micro, Solis hybrid & hòa lưới (1P/3P 4G/5G, S6), SRNE ASF/ASP, Sofar (HYD G3, KTLX G3, ME3000…), Afore, Kstar, Anenji, Megarevo, Chint, INVT, Swatten, Hinen, Renon, Tsun, Pylontech Force… (30 dòng).

Bản đồ thanh ghi lấy từ dự án mã nguồn mở **ha-solarman** (MIT, © David Rapan & Contributors) — xem `src/profiles/LICENSE-ha-solarman.txt`. Cập nhật: `python3 tools/convert_profiles.py <inverter_definitions> src/profiles`.

## CAN và BMS

- **CAN**: giao thức Pylontech LV (Deye, Growatt, Sofar, Solis… dùng khi chọn PYL/Lithium) — giới hạn áp/dòng sạc xả, SOC/SOH, áp/dòng/nhiệt, cờ cho phép sạc/xả, cảnh báo/bảo vệ, tên hãng pin, và khung mở rộng 0x372/0x373 (cell max/min, nhiệt cell) nếu BMS gửi. Có bảng khung thô (ID + dữ liệu hex).
- **BMS từng cell**: JBD/Xiaoxiang (UART hoặc Bluetooth), Daly (UART).

## Lưu ý

- Firmware đã biên dịch thành công nhưng **chưa chạy thử trên mạch thật**; phía máy chủ đã chạy thử đầy đủ bằng gateway giả lập (`tools/gateway-sim.mjs`).
- Thử cài đặt từ xa trên 1 máy trước. Mọi lệnh đều kiểm tra khoảng cho phép và ghi nhật ký; có thể khóa quyền cài đặt từng gateway.
- Quy ước dấu: pin dương = đang xả; lưới dương = đang mua. Nếu một dòng máy báo ngược, bật "Đảo dấu" trong cấu hình gateway.
- Senergy, AuxSol, Chisage chưa có bản đồ thanh ghi công khai. Nếu máy dùng dongle Solarman thì đọc qua mục Solarman; muốn cài đặt từ xa cần tài liệu Modbus từ hãng để thêm profile.
- Cloud Solarman / Deye Cloud / Solis cần xin API key (xem hướng dẫn trong app khi thêm tài khoản).

## Thử ở máy tính

```bash
printf 'ADMIN_PASSWORD=test123\nENC_KEY=dev-key-123\n' > .dev.vars
npx wrangler d1 execute insolar-monitor --local --file=schema.sql
npx wrangler dev
# tạo gateway trong app, rồi chạy gateway giả lập:
npx esbuild tools/gateway-sim.mjs --bundle --platform=node --format=esm --loader:.json=json --outfile=tools/gateway-sim.bundle.mjs
node tools/gateway-sim.bundle.mjs ws://localhost:8787 <GATEWAY_ID> <KHÓA> deye_hybrid '{"mppt":2,"phase":1,"pack":1}'
```

## Ảnh ngôi nhà (render 3D)

Kiểu sơ đồ "Ngôi nhà" dùng ảnh render bằng Blender: `tools/blender/house_scene.py` (dựng nhà, cột điện, ô tô, pin lưu trữ dùng ảnh thiết kế mặt trước). Render lại:

```bash
pip install bpy   # cần Python 3.11
python3.11 tools/blender/house_scene.py <ảnh-mặt-trước-pin.png> out both 48
```
Ảnh ban ngày render theo từng giờ 06–18h (mặt trời đúng vị trí thật ở Thanh Hoá, bóng đổ dịch chuyển theo giờ):

```bash
python3.11 tools/blender/house_scene.py <ảnh-mặt-trước-pin.png> out hours 48     # ra out/house_06.png … house_18.png
python3.11 tools/blender/house_scene.py <ảnh-mặt-trước-pin.png> out night 48     # ra out/house_night.png
```
Chuyển sang webp đặt vào `public/img/house-06.webp … house-18.webp`, `house-night.webp` (Cloudflare phục vụ tĩnh). App trộn 2 khung giờ gần nhất theo giờ thật, mặt trời chạy từ Đông (phải) sang Tây (trái), tối đến trời tối dần, mặt trăng mọc theo đúng pha trăng hôm đó.
Nếu đổi góc máy ảnh thì chép `anchors.json` vào `src/img/house-anchors.json` và cập nhật `HOUSE_ANCH` trong `src/ui.html`.
