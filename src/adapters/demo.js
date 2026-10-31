// Dữ liệu giả lập để chạy thử giao diện khi chưa có API key thật
import { station } from "./util.js";

const DEMO = [
  ["Nhà anh Hùng - Sầm Sơn", 10, "Deye", 1],
  ["Xưởng gỗ Minh Phát", 50, "Solis", 0.95],
  ["Nhà chị Lan - TP Thanh Hóa", 8, "SRNE", 0.9],
  ["Homestay Hải Tiến", 15, "SolaX", 1.05],
  ["Trang trại gà Đông Sơn", 30, "Deye", 0],
  ["Nhà anh Tuấn - Quảng Xương", 6, "Senergy", 0.85],
];

export default {
  brand: "demo",
  label: "Demo (dữ liệu giả lập)",
  fields: [],
  help: "Tạo 6 trạm giả lập để xem thử giao diện.",
  async fetchStations() {
    const h = ((Date.now() / 3600e3 + 7) % 24); // giờ VN
    const sun = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
    return {
      stations: DEMO.map(([name, kwp, brand, k], i) => {
        const p = kwp * 1000 * 0.78 * sun * k * (0.9 + Math.random() * 0.1);
        const dayFrac = h < 6 ? 0 : h > 18 ? 1 : (1 - Math.cos(((h - 6) / 12) * Math.PI)) / 2;
        return station({
          ext_id: "demo-" + i,
          name: `${name} (${brand})`,
          address: "Thanh Hóa",
          capacity_kwp: kwp,
          status: k === 0 ? "offline" : i === 5 ? "alarm" : "online",
          pv_power_w: k === 0 ? 0 : Math.round(p),
          load_power_w: Math.round(800 + Math.random() * 1500),
          battery_soc: i % 2 ? null : Math.round(40 + 50 * sun),
          today_kwh: k === 0 ? 0 : +(kwp * 4.2 * k * dayFrac).toFixed(1),
          total_kwh: Math.round(kwp * 1300 * (1 + i)),
          data_time: new Date().toISOString(),
        });
      }),
    };
  },
};
