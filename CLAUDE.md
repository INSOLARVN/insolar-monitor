# INSOLAR Monitor — hướng dẫn cho trợ lý AI

App giám sát + cài đặt điện mặt trời **đa hãng** (Deye, Solis, Solarman, SolaX, SRNE, Sofar…) trong 1 giao diện, giống Deye Cloud / SolisCloud / Solarman Business.
**Hoàn toàn tách riêng** khỏi INS (insolar.uk) và insolar.vn: Worker riêng, D1 riêng, kho GitHub riêng.

## Môi trường thật
- Worker: `insolar-monitor` — https://insolar-monitor.kinhdoanh-kithuat.workers.dev (chưa gắn tên miền riêng)
- Tài khoản Cloudflare: kinhdoanh.kithuat@gmail.com (account id `8fc7e298cd1fe86b260b73a3c9e3ebd5`)
- D1: `insolar-monitor` (id `2cc76a3a-742f-4d12-8371-26a2b0d315ca`, APAC)
- Bí mật Worker: `ADMIN_PASSWORD` (mật khẩu khẩn cấp của chủ), `ENC_KEY` (khoá mã hoá — **KHÔNG được đổi/mất**, mất là hỏng toàn bộ tài khoản cloud đã lưu và phiên đăng nhập)
- **Deploy:** kho `INSOLARVN/insolar-monitor` đã nối Cloudflare Workers Builds → **mỗi lần đẩy lên `main` là tự deploy lên trang thật**. Kiểm tra cú pháp trước khi đẩy.
- Ảnh tĩnh `public/` phục vụ qua `[assets]` (không tính vào dung lượng Worker).

## Cách người dùng muốn làm việc
- Trả lời **rất ngắn** bằng tiếng Việt (Xong / Chưa xong + 1 dòng lý do). Không giải thích dài.
- Được giao toàn quyền thì làm luôn, không hỏi lại.
- Giao diện ghi pin là **"Pin lưu trữ"** — không bao giờ ghi "INS.ESS".
- Không vẽ lại xe/nhân vật/thiết kế có bản quyền (đã từ chối vẽ VinFast VF7 → dùng xe SUV coupe tự thiết kế).
- Chú thích code bằng tiếng Việt, ghi `MỚI (dd/mm/yyyy)` / `SỬA (dd/mm/yyyy)` kèm lý do.

## Cấu trúc
| Đường dẫn | Nội dung |
|---|---|
| `src/index.js` | Router API, đồng bộ cloud (cron 5 phút), chi tiết trạm, lịch sử, cài đặt từ xa qua cloud (`cloudSetting`), thời tiết (`weatherFor`, Open-Meteo, đệm 15 phút), `/flash` nạp firmware |
| `src/auth.js` | Tài khoản người dùng (xem mục Đăng nhập) |
| `src/gateway-hub.js` | Durable Object `GatewayHub`: 1 WebSocket/gateway ESP32, giải mã Modbus/CAN/BMS, ghi lệnh (chờ ack 20s), ghi D1 mỗi 5 phút |
| `src/adapters/` | `solis.js` (HMAC-SHA1 + điều khiển `/v2/api/atReadBatch`, `/v2/api/control`), `deyecloud.js` (OpenAPI v1.0 + lệnh `/order/...`, chờ `GET /order/{id}` status 666), `solarman.js` (OpenAPI trả phí), `solarmanapp.js` (MỚI 07/11/2026: đăng nhập email+mật khẩu như app Solarman Smart, API không công khai `/oauth-s/oauth/token`, `/maintain-s/...`, `/device-s/device/v3/detail`; bị captcha thì dán Token JWT từ trình duyệt), `solax.js`, `foxess.js` (API Key, chữ ký md5), `inteless.js` (app PV Pro / logger E-Linter — Chisage, Sosen, Sunsynk; cài đặt từ xa qua `api/v1/common/setting/{sn}/read|set` (chế độ, ưu tiên, bán dư, dòng sạc/xả, SOC, lịch 6 mốc); đăng nhập RSA PKCS#1 tự viết bằng BigInt, tự dò máy chủ pv/api/euapi/usapi.inteless.com, api.sunsynk.net), `sigen.js` (Sigenergy OpenAPI, giới hạn 1 lần/5 phút/endpoint → đệm trong token_enc), `demo.js`, `util.js` (`station()` có `lat/lon`) |
| `src/lib/` | `modbus-profile.js` (port ha-solarman, MIT), `can.js` (Pylontech LV 0x351…0x35F, 0x372/0x373), `bms.js` (JBD, Daly), `canonical.js` (quy ước dấu: pin + = xả, lưới + = mua; `finish()` tự đảo dấu pin/lưới nếu PV+pin+lưới≠tải, dòng lưới tính từ công suất lưới — dòng AC biến tần nằm ở `output`), `simulator.js` |
| `src/profiles/` | 30 bản đồ thanh ghi inverter (từ ha-solarman, giấy phép kèm theo) |
| `src/ui.html` | Toàn bộ giao diện 1 tệp (hash router). Kiểm cú pháp: tách `<script>` rồi `node --check` |
| `public/img/house-06…18.webp`, `house-night.webp` | Ảnh render Blender ngôi nhà theo từng giờ |
| `tools/blender/house_scene.py` | Dựng & render cảnh (chế độ `hours` = 13 khung giờ theo vị trí mặt trời thật ở Thanh Hoá) |
| `tools/preview-mock.js` | Giả lập API cho bản xem thử (artifact) — có thanh kéo giờ + chọn thời tiết |
| `firmware/` | ESP32 gateway (PlatformIO): RS485 Modbus RTU / Solarman V5 TCP, CAN nghe thụ động (TWAI), BMS JBD (UART/BLE) & Daly, WiFiManager "INSOLAR-GW" |
| `schema.sql` | Bảng: accounts, gateways, stations (có lat/lon), details, readings, commands. Bảng tài khoản tự tạo trong `ensureAuth` |

## Đã xây dựng
1. **Nguồn dữ liệu:** cloud hãng (Deye Cloud, SolisCloud, Solarman, SolaX) và **gateway INSOLAR ESP32** đọc thẳng inverter (PV từng MPPT, áp/dòng từng pha, tần số, nhiệt, BMS từng cell, khung CAN).
2. **Cài đặt từ xa:** qua gateway (mọi thanh ghi của profile) và qua cloud — Deye Cloud (chế độ làm việc, ưu tiên năng lượng, bán điện dư, dòng sạc/xả, SOC thấp, lịch TOU 6 mốc; cần bật quyền điều khiển cho App trên developer.deyecloud.com) và SolisCloud (chế độ lưu trữ CID 636 theo bit, dòng sạc/xả 7224/7226, SOC 157/158/160, 6 khung sạc + 6 khung xả; cần xin Solis mở API điều khiển). **Chưa thử với tài khoản thật.**
3. **Giao diện:** sáng/tối, kính đen graphite + ánh sáng lướt, đăng nhập 2 tấm kính trượt (skin INS), 3 kiểu sơ đồ năng lượng (Tối giản / Ngôi nhà / Sơ đồ khối).
4. **Sơ đồ Ngôi nhà:** ảnh Blender theo giờ thật (trộn 2 khung gần nhất → bóng đổ dịch dần), mặt trời chạy Đông→Tây (phải→trái), chạng vạng, đêm có sao + mặt trăng đúng pha; **thời tiết khu vực** (mây trôi, mưa, dông, sương mù, trời u ám) + "Phát X% công suất".
5. **Tài khoản (src/auth.js):** đăng nhập email hoặc SĐT + mật khẩu (PBKDF2 100k); ô tài khoản trống hoặc `admin` = chủ hệ thống; `ADMIN_PASSWORD` luôn đăng nhập được vào chủ (khẩn cấp). Quên mật khẩu: mã 6 số gửi email (Gmail SMTP cổng 465 qua `cloudflare:sockets`, hoặc Resend) hoặc 8 mã khôi phục dùng 1 lần. Google (GIS) / Apple (popup) — chỉ hiện khi chủ nhập Client ID / Services ID, chỉ email đã được thêm mới vào được. Chủ quản lý người dùng (thêm, khoá, xoá, đặt mật khẩu). Đổi mật khẩu → tăng `sv` → đăng xuất máy khác. Giới hạn thử sai (`auth_hits`). Cấu hình gửi mail lưu mã hoá trong `app_config`.
   - SMS OTP **chưa bật** (tốn phí). Gửi email qua Gmail **chưa thử thật** — bấm "Gửi thử" trong Tài khoản → Cấu hình đăng nhập.

## Việc còn lại / tiếp theo
- Kết nối API thật của Deye Cloud, SolisCloud, Solarman và các hãng khác (người dùng đã có tài khoản Deye, Solarman với nhiều hệ đã lắp).
- Chủ hệ thống hiện **chưa có email/SĐT** → vào Tài khoản thêm email để dùng quên mật khẩu.
- Chisage, Sosen dùng logger E-Linter (app PV Pro) → adapter `inteless`. Senergy, AuxSol chưa có API/bản đồ thanh ghi công khai.
- Solarman Smart (đăng nhập app, 07/11/2026) **chưa thử với tài khoản thật** — Solarman báo OpenAPI phải trả phí.
- FoxESS, Sigenergy, PV Pro/Inteless (01/11/2026) **chưa thử với tài khoản thật**.
- Firmware gateway đã biên dịch nhưng chưa chạy trên mạch thật.
- Gắn tên miền riêng khi người dùng chọn (mở `routes` trong `wrangler.toml`).

## Kiểm tra trước khi đẩy lên main
```bash
npx esbuild src/index.js --bundle --format=esm --external:cloudflare:workers --external:cloudflare:sockets \
  --loader:.json=json --loader:.html=text --loader:.bin=binary --outfile=/tmp/b.js
python3 -c "import re;s=open('src/ui.html').read();open('/tmp/ui.js','w').write('\n'.join(re.findall(r'<script>(.*?)</script>',s,re.S)))" && node --check /tmp/ui.js
npx wrangler deploy --dry-run --outdir /tmp/dist
```
Không đưa lên git: `.dev.vars`, `.env`, `.wrangler/`, `node_modules/`, mã API Cloudflare.
