// Tự sinh bởi tools/convert_profiles.py — nguồn: github.com/davidrapan/ha-solarman (MIT)
import p0 from "./afore_2mppt.json";
import p1 from "./afore_BNTxxxKTL-2mppt.json";
import p2 from "./afore_hybrid.json";
import p3 from "./anenji_hybrid.json";
import p4 from "./astro-energy_micro.json";
import p5 from "./chint_cps-scetl.json";
import p6 from "./deye_hybrid.json";
import p7 from "./deye_micro.json";
import p8 from "./deye_p3.json";
import p9 from "./deye_string.json";
import p10 from "./hinen_hybrid.json";
import p11 from "./invt_xd-tl.json";
import p12 from "./kstar_hybrid.json";
import p13 from "./maxge_string.json";
import p14 from "./megarevo_r-3h.json";
import p15 from "./pylontech_force.json";
import p16 from "./renon_ifl.json";
import p17 from "./sofar_g3.json";
import p18 from "./sofar_g3hyd.json";
import p19 from "./sofar_hybrid.json";
import p20 from "./sofar_string.json";
import p21 from "./solarman_dtsd422-d3.json";
import p22 from "./solis_1p-5g.json";
import p23 from "./solis_3p-4g.json";
import p24 from "./solis_3p-5g.json";
import p25 from "./solis_hybrid.json";
import p26 from "./solis_s6-gr1p.json";
import p27 from "./srne_asf.json";
import p28 from "./swatten_sih-th.json";
import p29 from "./tsun_tsol-ms.json";
export const PROFILES = {
  "afore_2mppt": p0,
  "afore_BNTxxxKTL-2mppt": p1,
  "afore_hybrid": p2,
  "anenji_hybrid": p3,
  "astro-energy_micro": p4,
  "chint_cps-scetl": p5,
  "deye_hybrid": p6,
  "deye_micro": p7,
  "deye_p3": p8,
  "deye_string": p9,
  "hinen_hybrid": p10,
  "invt_xd-tl": p11,
  "kstar_hybrid": p12,
  "maxge_string": p13,
  "megarevo_r-3h": p14,
  "pylontech_force": p15,
  "renon_ifl": p16,
  "sofar_g3": p17,
  "sofar_g3hyd": p18,
  "sofar_hybrid": p19,
  "sofar_string": p20,
  "solarman_dtsd422-d3": p21,
  "solis_1p-5g": p22,
  "solis_3p-4g": p23,
  "solis_3p-5g": p24,
  "solis_hybrid": p25,
  "solis_s6-gr1p": p26,
  "srne_asf": p27,
  "swatten_sih-th": p28,
  "tsun_tsol-ms": p29,
};
export const PROFILE_LIST = [{"id": "afore_2mppt", "label": "Afore 2mppt", "manufacturer": "Afore"}, {"id": "afore_BNTxxxKTL-2mppt", "label": "Afore BNTxxxKTL-2mppt", "manufacturer": "Afore"}, {"id": "afore_hybrid", "label": "Afore Hybrid", "manufacturer": "Afore"}, {"id": "anenji_hybrid", "label": "Anenji Hybrid", "manufacturer": "ANENJI"}, {"id": "astro-energy_micro", "label": "Astro-Energy micro", "manufacturer": "Astro-Energy"}, {"id": "chint_cps-scetl", "label": "CHINT cps-scetl", "manufacturer": "CHINT"}, {"id": "deye_hybrid", "label": "Deye Hybrid 1 pha (SG01/SG02/SG03 LP1)", "manufacturer": "Deye"}, {"id": "deye_micro", "label": "Deye Micro inverter", "manufacturer": "Deye"}, {"id": "deye_p3", "label": "Deye Hybrid 3 pha (SG04LP3 / SG01HP3 / SG02HP3)", "manufacturer": "Deye"}, {"id": "deye_string", "label": "Deye hòa lưới (SUN-xK-G)", "manufacturer": "Deye"}, {"id": "hinen_hybrid", "label": "Hinen hybrid", "manufacturer": "Hinen"}, {"id": "invt_xd-tl", "label": "Invt xd-tl", "manufacturer": "Invt"}, {"id": "kstar_hybrid", "label": "Kstar Hybrid", "manufacturer": "KSTAR"}, {"id": "maxge_string", "label": "Maxge string", "manufacturer": "Maxge"}, {"id": "megarevo_r-3h", "label": "Megarevo R-3H", "manufacturer": "Megarevo"}, {"id": "pylontech_force", "label": "Pylontech Force H1/H2/H3 (pin cao áp)", "manufacturer": "Pylontech"}, {"id": "renon_ifl", "label": "Renon ifl", "manufacturer": "Renon"}, {"id": "sofar_g3", "label": "Sofar KTLX G3", "manufacturer": "Sofar"}, {"id": "sofar_g3hyd", "label": "Sofar HYD G3", "manufacturer": "Sofar"}, {"id": "sofar_hybrid", "label": "Sofar Hybrid (ME3000SP…)", "manufacturer": "Sofar"}, {"id": "sofar_string", "label": "Sofar hòa lưới", "manufacturer": "Sofar"}, {"id": "solarman_dtsd422-d3", "label": "Solarman dtsd422-d3", "manufacturer": "Solarman"}, {"id": "solis_1p-5g", "label": "Solis hòa lưới 1 pha 5G", "manufacturer": "Solis"}, {"id": "solis_3p-4g", "label": "Solis hòa lưới 3 pha 4G", "manufacturer": "Solis"}, {"id": "solis_3p-5g", "label": "Solis hòa lưới 3 pha 5G", "manufacturer": "Solis"}, {"id": "solis_hybrid", "label": "Solis Hybrid 1 pha (RHI-xK-48ES-5G)", "manufacturer": "Solis"}, {"id": "solis_s6-gr1p", "label": "Solis S6 hòa lưới 1 pha", "manufacturer": "Solis"}, {"id": "srne_asf", "label": "SRNE ASF / ASP Hybrid", "manufacturer": "SRNE"}, {"id": "swatten_sih-th", "label": "Swatten sih-th", "manufacturer": "Swatten"}, {"id": "tsun_tsol-ms", "label": "Tsun tsol-ms", "manufacturer": "Tsun"}];
