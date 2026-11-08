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
- **KHÔNG ĐOÁN BỪA (08/11/2026):** số liệu hiển thị phải là số thật hãng trả về hoặc đo được. Không tự suy/ước tính (vd lấy Tổng − năm trước, cộng dồn rồi "chặn" cho hợp lý). Chưa có số thật thì hiện "--" và ghi rõ lý do. Chưa xem được dữ liệu thô của API thì phải nói thẳng là chưa kiểm chứng, làm công cụ xem số liệu gốc (vd nút "Xem số liệu gốc từ hãng") để đối chiếu trước khi sửa — không đẩy lên trang thật một cách tính dựa trên phỏng đoán tên trường/ý nghĩa API.
- **Ẩn số 0 / không có (08/11/2026):** ở Tổng quan, Pin & BMS, Biến tần: dòng thông số hãng không trả hoặc đang = 0 thì ẩn (`blank()` + `hideBlank(el)` trong ui.html), khác 0 thì hiện. Số lớn ở sơ đồ/tiêu đề thẻ, thẻ Tiền khai thác và tab Cài đặt không áp dụng. Nút "Chép toàn bộ thông số gốc" vẫn chép đủ cả số 0.
- Chú thích code bằng tiếng Việt, ghi `MỚI (dd/mm/yyyy)` / `SỬA (dd/mm/yyyy)` kèm lý do.

## Cấu trúc
| Đường dẫn | Nội dung |
|---|---|
| `src/index.js` | Router API, đồng bộ cloud (cron 5 phút), chi tiết trạm, lịch sử, cài đặt từ xa qua cloud (`cloudSetting`), thời tiết (`weatherFor`, Open-Meteo, đệm 15 phút), `/flash` nạp firmware |
| `src/auth.js` | Tài khoản người dùng (xem mục Đăng nhập) |
| `src/gateway-hub.js` | Durable Object `GatewayHub`: 1 WebSocket/gateway ESP32, giải mã Modbus/CAN/BMS, ghi lệnh (chờ ack 20s), ghi D1 mỗi 5 phút |
| `src/adapters/` | `solis.js` (HMAC-SHA1 + điều khiển `/v2/api/atReadBatch`, `/v2/api/control`), `deyecloud.js` (OpenAPI v1.0 + lệnh `/order/...`, chờ `GET /order/{id}` status 666), `solarman.js` (OpenAPI trả phí), `solarmanapp.js` (MỚI 07/11/2026: đăng nhập email+mật khẩu như app Solarman Smart, API không công khai `/oauth-s/oauth/token`, `/maintain-s/...`, `/device-s/device/v3/detail`; bị captcha thì dán Token JWT từ trình duyệt; cùng tệp có `solarman_biz` = **Solarman Business** globalpro.solarmanpv.com: đăng nhập web bắt captcha → người dùng dán cookie (`copy(document.cookie)`), lấy refresh token (JWT có `ati`, ~6 tháng) → `/oauth2-s/oauth/token` grant refresh_token; refresh mới lưu trong token_enc, `keepToken` để lỗi không xoá; trạm `/maintain-s/operating/station/v2/search`), `solax.js`, `foxess.js` (API Key, chữ ký md5), `inteless.js` (app PV Pro / logger E-Linter — Chisage, Sosen, Sunsynk; cài đặt từ xa qua `api/v1/common/setting/{sn}/read|set` (chế độ, ưu tiên, bán dư, dòng sạc/xả, SOC, lịch 6 mốc); đăng nhập RSA PKCS#1 tự viết bằng BigInt, tự dò máy chủ pv/api/euapi/usapi.inteless.com, api.sunsynk.net), `sigen.js` (Sigenergy OpenAPI, giới hạn 1 lần/5 phút/endpoint → đệm trong token_enc), `demo.js`, `util.js` (`station()` có `lat/lon`) |
| `src/lib/` | `modbus-profile.js` (port ha-solarman, MIT), `can.js` (Pylontech LV 0x351…0x35F, 0x372/0x373), `bms.js` (JBD, Daly), `canonical.js` (quy ước dấu: pin + = xả, lưới + = mua — **adapter tự quy đổi theo quy ước từng hãng, không tự đảo dấu**; dòng pha giữ nguyên số hãng trả — dòng AC biến tần nằm ở `output`), `simulator.js` |
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
3. **Giao diện:** 5 bộ giao diện (MỚI 08/11/2026, chọn ở Tài khoản → Giao diện, `data-skin`/`imSkin`): Kính INSOLAR (mặc định), shadcn/ui, Material 3, Ant Design, Grafana — mỗi bộ có sáng/tối; sáng/tối, kính đen graphite + ánh sáng lướt, đăng nhập 2 tấm kính trượt (skin INS), 3 kiểu sơ đồ năng lượng (Tối giản / Ngôi nhà / Sơ đồ khối).
4. **Sơ đồ Ngôi nhà:** ảnh Blender theo giờ thật (trộn 2 khung gần nhất → bóng đổ dịch dần), mặt trời chạy Đông→Tây (phải→trái), chạng vạng, đêm có sao + mặt trăng đúng pha; **thời tiết khu vực** (mây trôi, mưa, dông, sương mù, trời u ám) + "Phát X% công suất".
5. **Tài khoản (src/auth.js):** đăng nhập email hoặc SĐT + mật khẩu (PBKDF2 100k); ô tài khoản trống hoặc `admin` = chủ hệ thống; `ADMIN_PASSWORD` luôn đăng nhập được vào chủ (khẩn cấp). Quên mật khẩu: mã 6 số gửi email (Gmail SMTP cổng 465 qua `cloudflare:sockets`, hoặc Resend) hoặc 8 mã khôi phục dùng 1 lần. Google (GIS) / Apple (popup) — chỉ hiện khi chủ nhập Client ID / Services ID, chỉ email đã được thêm mới vào được. Chủ quản lý người dùng (thêm, khoá, xoá, đặt mật khẩu). Đổi mật khẩu → tăng `sv` → đăng xuất máy khác. Giới hạn thử sai (`auth_hits`). Cấu hình gửi mail lưu mã hoá trong `app_config`.
   - SMS OTP **chưa bật** (tốn phí). Gửi email qua Gmail **chưa thử thật** — bấm "Gửi thử" trong Tài khoản → Cấu hình đăng nhập.

6. **Cảnh báo/sự cố từ cloud hãng (07/11/2026):** adapter có `fetchAlarms` (Deye `/station/alertList`, Solis `/v1/api/alarmList`, SolaX `/openapi/v2/alarm/page_alarm_info`, PV Pro `api/v1/event/{sn}/realtime`, Solarman OpenAPI `/device/v1.0/alertList`, Solarman app `/maintain-s/operating/alert/search`) → bảng `alarms` (tự tạo trong `ensureAlarms`), đồng bộ 15 phút/lần (hoặc khi bấm đồng bộ), tối đa 60 trạm/tài khoản/lượt. Trang `#/alarms` (nút chuông), thẻ cảnh báo trong Tổng quan trạm; trạm có lỗi đang mở hiện "Cảnh báo". Danh sách trạm có hàng lọc theo hãng. FoxESS, Sigenergy, gateway chưa có. **Chưa thử với tài khoản thật.**

7. **Tiền khai thác (07/11/2026, sửa 08/11/2026):** mỗi trạm có `stations.price_kwh` (đ/kWh, trống = 3.870); thẻ "Tiền khai thác" ở Tổng quan (hôm nay / tháng / năm / tổng = sản lượng PV × giá). `energySum`: tháng = số hãng trả sẵn (`stations.month_kwh`) hoặc lịch sử tháng của cloud; năm = **chỉ** số hãng trả sẵn (`stations.year_kwh`: Solis `yearEnergy`, Sigenergy, Solarman `generationYear` nếu có); `readings` chỉ dùng khi app đã ghi đủ từ đầu tháng/năm; không có → "--". Số "năm" của Solarman (`/stats/year`) và cộng tháng đã cho kết quả sai với trạm thật (Daikin – LHP) → đã bỏ. Bấm nhãn giá → "Xem số liệu gốc từ hãng" (`/api/stations/:id/energy-raw`, adapter `rawEnergy`, hiện có ở Solarman) để kiểm chứng.
8. **Tìm kiếm danh sách trạm (07/11/2026):** ô tìm nằm ngoài vùng vẽ lại, chờ 150 ms, bỏ qua lúc bộ gõ đang ghép dấu, tìm không dấu (`fold`), hiện 40 trạm đầu + "Xem thêm".

9. **Gán thông số (07/11/2026) — ĐÃ TẮT 08/11/2026** (người dùng: "không ai biết gán gì"; `canMap()` = false, `stationDetail` không áp `field_maps`; mã/bảng còn giữ nhưng không dùng). Thay bằng quy tắc chung trong `CLOUD_MAP`/`fillBattery` do kỹ thuật thêm khi có dữ liệu thật. Cũ: mỗi hãng/dòng/đời máy đặt tên khác nhau → (a) `fillBattery` trong `canonical.js` tự dò tên pin linh hoạt; (b) người dùng bấm vào thông số (tab Biến tần hoặc "Tất cả thông số pin từ hãng") → chọn ô hiển thị + phạm vi (trạm / dòng máy `device.model_key` / cả hãng) + hệ số nhân. Lưu bảng `field_maps` (tự tạo trong `ensureAlarms`), áp dụng trong `fromCloudList(…, maps)` qua `applyMaps` (ghi đè tự dò; trạm > dòng máy > hãng). API `/api/field-maps` (GET/POST/DELETE). Chỉ cho trạm cloud (gateway dùng profile thanh ghi).

10. **Rà soát "không đoán" (08/11/2026):** đã bỏ: SolaX tự tính công suất tải/điện tiêu thụ/dung lượng pin Ah (giả định 51,2V); `finish()` ghi đè công suất pha bằng tổng và tính lại dòng pha từ P/U (nay số pha lệch thì để trống); thẻ Tải nhà lấy áp/dòng đầu ra biến tần khi thiếu số tải; tên trường tháng/năm đoán của Sigenergy/Solarman. Còn giữ nhưng **ghi rõ**: công suất tải tính từ cân bằng khi hãng không trả (`load.calc` → "≈ (tính)"), dòng pin = P/U (`battery.current_calc` → "≈"), thời tiết dùng TP Thanh Hoá khi trạm chưa có toạ độ (ghi rõ). Còn giữ: PV chuỗi = V×A khi thiếu W; ẩn chuỗi PV chưa từng phát (`pv_seen`). **Chưa kiểm chứng với dữ liệu thật:** sản lượng tháng Solarman (lịch sử tháng), dò tên pin `fillBattery`.

11. **Dữ liệu thật Solarman Business (Daikin – LHP, 08/11/2026):** `fast/system`: `generationUploadTotal` = 9.909,2 (công tơ biến tần, khớp app gốc 35,66 tr ở giá 3.600 đ). `/stats/total` = 18.469,3 = 2025 (2.934,2, chỉ có tháng 12) + 2026 (15.535,1); tháng 1/2026 = 5.758,4 và 12/2025 = 2.934,2 là số thống kê **sai của Solarman** (hệ 12,3 kWp). Tháng 2–11 hợp lý; tháng 11 = 196,5 khớp. Danh sách trạm `generationMonth/generationYear` = số `/stats/month|year`. Giao diện: tháng/năm hãng trả > tổng công tơ → không hiện, ghi rõ lý do. Giá tiền app gốc = `incomeValue/generationValue` = 3.600 đ/kWh.

12. **Dữ liệu thật Deye Cloud (INSOLAR VN 83LHP, SUN-12K 3 pha, 08/11/2026):** có `Grid Voltage/Current/Power L1–L3` (dòng lưới THẬT, có thể lớn so với công suất vì phản kháng `x Phase Reactive Power Of Power Grid`), `AC Voltage/Current RUA/SVB/TWC` (đầu ra biến tần), `Inverter Output Power L1–L3`, `Load Voltage L1–L3`, `Load Phase Power A/B/C` (tải nhà, khớp tổng), `Load Power L1–L3` (cổng UPS); **không có dòng tải từng pha, không có SOH pin 1** (`Lithium Battery2SOH` là pin 2). Đã bỏ việc ẩn dòng pha theo công suất; `fillBattery` bỏ thông số pin 2. Nút "Chép toàn bộ thông số gốc từ hãng" ở tab Biến tần để đối chiếu, khung "Số hãng trả đã bị ẩn" (`d.hidden`).

13. **Dữ liệu thật Solarman Smart – SRNE 12 kW 3 pha (Tranh An, 08/11/2026):** cùng bộ tên kiểu Deye (logger Solarman): `Grid Voltage/Current/Power L1–L3` có thật, `AC Voltage/Current R/U/A…` = đầu ra biến tần, `Load phase power A/B/C` = tải nhà, `Load Voltage  L1` (2 dấu cách → gộp khoảng trắng), `Daily Energy Buy`/`Daily energy sell`, `Total Energy Buy/Sell`, `Total Consumption`, `Load Fequency` (sai chính tả của hãng), `Battery current 1`, `BMS Temperature`. **Không có:** dòng tải từng pha, SOH pin. Tệp mẫu để thử: chạy `fromCloudList` với danh sách tên/giá trị.

14. **Dữ liệu thật SolaX X1-Lite-LV (Chú Thượng, 08/11/2026):** `inv.mpptMap.MPPT1Voltage/Current/Power` (chữ hoa); `inv.dailyYield/totalYield` = sản lượng PV (4,5 / 6.583,5); `plant.dailyYield/totalYield` và `inv.dailyACOutput/totalACOutput` = điện AC biến tần xuất (8,7) — không phải PV; `inv.acVoltage1/acCurrent1/acPower1` = đầu ra AC biến tần (988 W ≈ tải khi lưới 0); `EPSL1Voltage` trống; **không có** áp/dòng tải riêng. Web SolaX (đối chiếu 08/11): Daily Solar 7,30 / Total 6.587,27 = `inv.dailyYield/totalYield` (đúng); Daily consumption lấy từ `get_stat_data` (dateType 2) `loadConsumption` của ngày hôm nay; công suất "Home" realtime không có trong OpenAPI → app vẫn "≈ (tính)". Adapter SolaX đưa nguyên trường gốc vào nhóm "Gốc SolaX – …" .

15. **Dữ liệu thật Deye 20 kW 3 pha SG05 (Kim Chung, 08/11/2026):** "Grid Status: Purchasing energy" + `Total Grid Power` +710 → Deye: lưới + = mua; `Battery Power` -1.644 + dòng âm → pin âm = sạc (trùng quy ước app). Tải hãng báo (8.592) ≠ PV+pin+lưới (7.022) → **đã BỎ tự đảo dấu theo cân bằng** (`balanceSigns`) vì đảo sai cả pin lẫn lưới. 2 cụm pin: `Battery Current1/2`, dùng `Battery Total Current`. Máy này `Grid Current L2/L3` (22,74 / 11,28 A) ≈ `AC Current SVB/TWC` (23,4 / 12,6 A) trong khi công suất lưới pha chỉ ~240 W → số của Deye, app hiện nguyên. Solarman `wirePower` âm = mua (Daikin: -1.694, `wireStatus` PURCHASE) → adapter đổi dấu. Deye `station/latest` (danh sách trạm) **chưa kiểm dấu** → xem bằng "Xem số liệu gốc từ hãng".

16. **Deye `station/latest` thật (Kim Chung, 08/11/2026):** `chargePower` = `batteryPower` = -8.557 khi sạc, `dischargePower` null → dùng `batteryPower` (âm = sạc). `wirePower` -15 (quá nhỏ, **chưa xác định dấu** — cần gửi lại lúc mua/bán nhiều), `gridPower` null, không có `generationTotal`. `/station/history` granularity 2 (ngày) có `year/month/day`, `generationValue`; granularity 3 phải trong 12 tháng (`endAt` = `YYYY-12`). Lịch sử tháng trả rỗng thì tháng = "--" (không còn ra 0).

17. **Dữ liệu thật PV Pro (Chú Nam Đông Sơn, 08/11/2026):** `api/v1/plants` (danh sách) có `pac, etoday, etotal, updateAt` nhưng **không** có kWp/toạ độ; `api/v1/plant/{id}` có `totalPower` (kWp = 12), `lat/lon`, `realtime.emonth/eyear/etotal` → adapter gọi thêm chi tiết từng trạm (≤ 40/lượt) để lấy kWp, toạ độ, tháng/năm. Nhãn hãng hiển thị "PV Pro".

18. **Đánh dấu "chưa gán" (08/11/2026):** `fromCloudList` đặt `params[].used` (khớp `CLOUD_MAP`, `fillBattery` hoặc gán của người dùng). Tab Biến tần gắn nhãn "chưa gán" cho thông số số, khác 0, `used === false` (bỏ nhóm "Gốc …") + dòng tổng số ở đầu → gặp đời máy/tên mới thì người dùng chép thông số gốc gửi kỹ thuật thêm vào quy tắc chung (không gán tay). Quy tắc gán là CHUNG theo tên thông số của hãng (mọi trạm/dòng máy trả cùng tên đều áp dụng), trạm thật chỉ dùng để kiểm nghĩa của tên.

## Việc còn lại / tiếp theo
- Kết nối API thật của Deye Cloud, SolisCloud, Solarman và các hãng khác (người dùng đã có tài khoản Deye, Solarman với nhiều hệ đã lắp).
- Chủ hệ thống hiện **chưa có email/SĐT** → vào Tài khoản thêm email để dùng quên mật khẩu.
- Chisage, Sosen dùng logger E-Linter (app PV Pro) → adapter `inteless`. Senergy, AuxSol chưa có API/bản đồ thanh ghi công khai.
- Người dùng dùng **Solarman Business** (nhiều hệ), Smart rất ít. Solarman Smart/Business (07/11/2026) **chưa thử với tài khoản thật** — Solarman báo OpenAPI phải trả phí.
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
