import solis from "./solis.js";
import solarman from "./solarman.js";
import deyecloud from "./deyecloud.js";
import solax from "./solax.js";
import demo from "./demo.js";

// Thêm hãng mới: tạo file adapter có fetchStations() trả về danh sách trạm chuẩn hóa rồi khai báo ở đây.
export const ADAPTERS = { solarman, deyecloud, solis, solax, demo };

export const publicAdapterInfo = () =>
  Object.values(ADAPTERS).map(({ brand, label, fields, help }) => ({ brand, label, fields, help }));
