import solis from "./solis.js";
import solarman from "./solarman.js";
import solarman_app, { solarmanBiz as solarman_biz } from "./solarmanapp.js"; // MỚI (07/11/2026): Solarman đăng nhập kiểu app, không cần OpenAPI trả phí
import deyecloud from "./deyecloud.js";
import solax from "./solax.js";
import foxess from "./foxess.js"; // MỚI (01/11/2026)
import sigen from "./sigen.js"; // MỚI (01/11/2026)
import inteless from "./inteless.js"; // MỚI (01/11/2026): PV Pro / E-Linter
import demo from "./demo.js";

// Thêm hãng mới: tạo file adapter có fetchStations() trả về danh sách trạm chuẩn hóa rồi khai báo ở đây.
export const ADAPTERS = { solarman_biz, solarman_app, solarman, deyecloud, solis, solax, foxess, sigen, inteless, demo };

export const publicAdapterInfo = () =>
  Object.values(ADAPTERS).map(({ brand, label, fields, help }) => ({ brand, label, fields, help }));
