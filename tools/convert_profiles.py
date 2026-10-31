#!/usr/bin/env python3
"""Chuyển định nghĩa thanh ghi (YAML) của dự án ha-solarman (MIT, © David Rapan & Contributors)
sang JSON gọn để Worker giải mã dữ liệu Modbus của inverter.

Dùng: python3 tools/convert_profiles.py <thư mục inverter_definitions> src/profiles
"""
import json, os, sys, yaml

DROP = {"icon", "state_class", "description", "friendly_name", "hidden", "persistent",
        "ensure_increasing", "via_device", "name_lookup", "options"}

LABELS = {
    "deye_hybrid": "Deye Hybrid 1 pha (SG01/SG02/SG03 LP1)",
    "deye_p3": "Deye Hybrid 3 pha (SG04LP3 / SG01HP3 / SG02HP3)",
    "deye_string": "Deye hòa lưới (SUN-xK-G)",
    "deye_micro": "Deye Micro inverter",
    "solis_hybrid": "Solis Hybrid 1 pha (RHI-xK-48ES-5G)",
    "solis_1p-5g": "Solis hòa lưới 1 pha 5G",
    "solis_3p-4g": "Solis hòa lưới 3 pha 4G",
    "solis_3p-5g": "Solis hòa lưới 3 pha 5G",
    "solis_s6-gr1p": "Solis S6 hòa lưới 1 pha",
    "srne_asf": "SRNE ASF / ASP Hybrid",
    "sofar_g3hyd": "Sofar HYD G3",
    "sofar_hybrid": "Sofar Hybrid (ME3000SP…)",
    "sofar_g3": "Sofar KTLX G3",
    "sofar_string": "Sofar hòa lưới",
    "afore_hybrid": "Afore Hybrid",
    "kstar_hybrid": "Kstar Hybrid",
    "anenji_hybrid": "Anenji Hybrid",
    "megarevo_r-3h": "Megarevo R-3H",
    "pylontech_force": "Pylontech Force H1/H2/H3 (pin cao áp)",
}


def clean(o):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k in DROP:
                continue
            if k is True:
                k = "on"
            elif k is False:
                k = "off"
            out[str(k)] = clean(v)
        return out
    if isinstance(o, list):
        return [clean(x) for x in o]
    return o


def main(src, dst):
    os.makedirs(dst, exist_ok=True)
    index = []
    for fn in sorted(os.listdir(src)):
        if not fn.endswith(".yaml"):
            continue
        pid = fn[:-5]
        with open(os.path.join(src, fn), encoding="utf-8") as f:
            y = yaml.safe_load(f)
        info = y.get("info") or {}
        prof = clean({
            "id": pid,
            "manufacturer": info.get("manufacturer") or pid.split("_")[0].capitalize(),
            "model": info.get("model"),
            "default": y.get("default") or {},
            "requests": y.get("requests"),
            "requests_fine_control": "requests_fine_control" in y,
            "parameters": y.get("parameters") or [],
        })
        prof["label"] = LABELS.get(pid, f'{prof["manufacturer"]} {pid.split("_", 1)[-1]}')
        with open(os.path.join(dst, pid + ".json"), "w", encoding="utf-8") as f:
            json.dump(prof, f, ensure_ascii=False, separators=(",", ":"))
        index.append({"id": pid, "label": prof["label"], "manufacturer": prof["manufacturer"]})
    with open(os.path.join(dst, "index.js"), "w", encoding="utf-8") as f:
        f.write("// Tự sinh bởi tools/convert_profiles.py — nguồn: github.com/davidrapan/ha-solarman (MIT)\n")
        for i, p in enumerate(index):
            f.write(f'import p{i} from "./{p["id"]}.json";\n')
        f.write("export const PROFILES = {\n")
        for i, p in enumerate(index):
            f.write(f'  "{p["id"]}": p{i},\n')
        f.write("};\n")
        f.write("export const PROFILE_LIST = " + json.dumps(index, ensure_ascii=False) + ";\n")
    print(f"{len(index)} profiles -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
