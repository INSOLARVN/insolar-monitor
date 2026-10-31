// SolaX Cloud User Monitoring API — tokenId miễn phí trong SolaxCloud > Service > API
// Mỗi trạm = 1 số Registration No. (in trên dongle Pocket WiFi/LAN/4G). Giới hạn 10 lần/phút.
import { fetchJson, station, num, isoFromAny, statusFromTime } from "./util.js";

const STATUS = { 100: "online", 101: "online", 102: "online", 103: "alarm", 104: "alarm", 105: "online", 106: "online", 107: "online", 108: "online", 109: "online", 110: "online", 111: "online", 112: "online", 113: "online" };

export default {
  brand: "solax",
  label: "SolaX Cloud",
  fields: [
    { key: "token_id", label: "Token ID", type: "password" },
    { key: "sns", label: "Registration No. của dongle (cách nhau dấu phẩy)", placeholder: "SXXXXXXXXX, SYYYYYYYYY" },
    { key: "api_url", label: "API URL", placeholder: "https://www.solaxcloud.com", optional: true },
  ],
  help: "SolaxCloud > Service > Third-party ecosystem (API) → copy Token ID. Số Registration No. in trên dongle, không phải số serial biến tần.",

  async fetchStations(creds) {
    const base = (creds.api_url || "https://www.solaxcloud.com").replace(/\/$/, "");
    const sns = String(creds.sns || "").split(/[,\s;]+/).filter(Boolean).slice(0, 9);
    const out = [];
    let okCount = 0, lastErr = "";
    for (const sn of sns) {
      const r = await fetchJson(`${base}/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${encodeURIComponent(creds.token_id)}&sn=${encodeURIComponent(sn)}`);
      if (!r.success || !r.result) {
        lastErr = r.exception || r.message || "không có dữ liệu";
        out.push(station({ ext_id: sn, name: `SolaX ${sn}`, status: "offline" }));
        continue;
      }
      okCount++;
      const x = r.result;
      const t = isoFromAny(x.uploadTime);
      const pv = [x.powerdc1, x.powerdc2, x.powerdc3, x.powerdc4].map(num).filter((v) => v !== null);
      out.push(station({
        ext_id: sn,
        name: `SolaX ${x.inverterSN || sn}`,
        status: statusFromTime(t, STATUS[x.inverterStatus] || "online"),
        pv_power_w: pv.length ? pv.reduce((a, b) => a + b, 0) : x.acpower,
        grid_power_w: x.feedinpower,
        battery_soc: x.soc,
        today_kwh: x.yieldtoday,
        total_kwh: x.yieldtotal,
        data_time: t,
      }));
    }
    if (!okCount) throw new Error(`SolaX: ${lastErr}`);
    return { stations: out };
  },

  async fetchDetail(creds, _c, sn) {
    const base = (creds.api_url || "https://www.solaxcloud.com").replace(/\/$/, "");
    const r = await fetchJson(`${base}/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${encodeURIComponent(creds.token_id)}&sn=${encodeURIComponent(sn)}`);
    if (!r.success || !r.result) throw new Error("SolaX: " + (r.exception || "không có dữ liệu"));
    const x = r.result;
    const L = (name, value, unit) => ({ name, value, unit });
    const list = [
      L("Total DC Power", x.acpower, "W"), L("Daily Production", x.yieldtoday, "kWh"), L("Total Production", x.yieldtotal, "kWh"),
      L("Grid Power", x.feedinpower == null ? null : -x.feedinpower, "W"), L("SOC", x.soc, "%"), L("Battery Power", x.batPower == null ? null : -x.batPower, "W"),
      L("PV1 Power", x.powerdc1, "W"), L("PV2 Power", x.powerdc2, "W"), L("PV3 Power", x.powerdc3, "W"), L("PV4 Power", x.powerdc4, "W"),
      L("Total Grid Export", x.feedinenergy, "kWh"), L("Total Grid Import", x.consumeenergy, "kWh"), L("EPS Power L1", x.peps1, "W"),
    ].filter((i) => i.value !== null && i.value !== undefined);
    return { list, serial: x.inverterSN || sn, time: x.uploadTime };
  },
};
