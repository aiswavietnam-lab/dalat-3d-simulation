#!/usr/bin/env python3
"""
audit_landmarks_local_plan.py — Kiểm Tra Chiếu Bằng Cục Bộ Công Trình Nổi Bật & Tự Động Căn Chỉnh (Slot 27 & Slot 29)

Tính năng:
  - `--mode audit --batch <BATCH>`:
      Nạp đầy đủ 4 manifest (Hero Landmarks Ultra, Landmarks, French Villas, Tourism Complexes),
      tải ảnh vệ tinh Google Satellite Z19 cục bộ (tự mở rộng khung nếu phát hiện công trình lệch xa),
      tải đối chứng đa giác OSM Building / Road / Water từ Official OSM API v0.6 (không dùng Overpass),
      chiếu hình bao 3D thực tế (dày đặc tới 9,000 tam giác/công trình) lên ảnh vệ tinh để đo:
        1) `dx_m`, `dy_north_m`: Độ lệch tâm mô hình 3D thực tế so với dấu chân công trình trên OSM/vệ tinh
        2) `heading_diff_deg` & `footprint_iou`: Độ lệch hướng trục chính & mức độ trùng khớp hình bao (IoU)
        3) `water_overlap_pct` & `road_overlap_pct`: Tỷ lệ tràn xuống mặt hồ hoặc lấn lòng đường chính
      Xuất Contact Sheet 8 khung (2400x1260) & phiếu lỗi `landmark_plan_fix_ticket_<BATCH>.json`.
  - `--mode fix --ticket <TICKET_JSON>`:
      Dành cho Slot 29 (`ĐÀ LẠT - 28`): tự động căn chỉnh `gltf_position`, `lat/lon`, `tile_id`,
      tối ưu `rotation_y_rad` theo IoU thực tế (chỉ xoay nếu cải thiện rõ rệt IoU với đa giác OSM),
      tái khóa cao độ theo ESA Copernicus GLO-30 DEM, kiểm tra an toàn mặt nước/lòng đường,
      xuất Contact Sheet Trước/Sau & phiếu `applied_landmark_fix_<BATCH>.json`.
"""

import argparse
import concurrent.futures
import datetime
import json
import math
import pathlib
import sys
import time
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image, ImageDraw

def _detect_root() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve().parent
    for cand in (pathlib.Path.cwd(), here, here.parent, pathlib.Path("/home/antigravity/dalat-3d-simulation")):
        if (cand / "assets").exists():
            return cand
    return pathlib.Path.cwd()


ROOT = _detect_root()
ASSETS = ROOT / "assets"
CACHE_DIR = pathlib.Path("/tmp/dalat_real_cache")
CACHE_G = CACHE_DIR / "google"
CACHE_G.mkdir(parents=True, exist_ok=True)
OSM_LM_CACHE = CACHE_DIR / "osm_buildings_v2.json"

LAT0 = 11.940419
LON0 = 108.445259
MLAT = 111319.49
MLON = 108911.0

for _p in (str(pathlib.Path(__file__).resolve().parent), str(ROOT / "scripts")):
    if _p not in sys.path:
        sys.path.insert(0, _p)
import audit_urban_plan_vs_satellite as _urban_mod
from audit_urban_plan_vs_satellite import (
    CopernicusDemSampler,
    load_osm_masks_for_sector,
    read_glb_tris_xz,
    xy_to_px,
)


def local_to_latlon(x_m: float, y_north_m: float):
    return LAT0 + y_north_m / MLAT, LON0 + x_m / MLON


def latlon_to_local(lat: float, lon: float):
    return (lon - LON0) * MLON, (lat - LAT0) * MLAT


def xy_to_tile_id(x_m: float, y_north_m: float) -> str:
    ix = int(math.floor((x_m + 1000.0) / 2000.0))
    iy = int(math.floor((y_north_m + 1000.0) / 2000.0))
    ew = "W" if ix < 0 else "E"
    ns = "S" if iy < 0 else "N"
    return f"T_{ew}{abs(ix):02d}_{ns}{abs(iy):02d}"


def vi_norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower().replace("đ", "d"))
    return " ".join("".join(ch for ch in s if unicodedata.category(ch) != "Mn").replace("_", " ").replace("-", " ").split())


# Known alias tokens bridging 3D manifest names/IDs with real OSM building names in Đà Lạt
LANDMARK_OSM_ALIASES = {
    "ultra_lm_03_nha_tho_con_ga": ["nha tho chanh toa", "con ga"],
    "lm_03_nha_tho_con_ga": ["nha tho chanh toa", "con ga"],
    "ultra_lm_05_cho_da_lat_hoa_binh": ["cho da lat moi", "cho dem da lat"],
    "ultra_lm_08_dinh_2_bao_dai": ["dinh toan quyen", "dinh ii", "dinh 2"],
    "lm_08_dinh_2_bao_dai": ["dinh toan quyen", "dinh ii", "dinh 2"],
    "ultra_lm_12_dalat_palace_heritage": ["dalat palace hotel", "dalat palace"],
    "lm_12_dalat_palace_heritage": ["dalat palace hotel", "dalat palace"],
    "ultra_lm_34_chua_linh_son": ["chua linh son"],
    "lm_34_chua_linh_son": ["chua linh son"],
    "lm_49_rap_hoa_binh_khu_hoa_binh": ["rap hat hoa binh"],
    "ultra_lm_02_ga_da_lat": ["ga da lat", "dalat railway station"],
    "ultra_lm_07_dinh_3_bao_dai": ["dinh iii", "dinh 3", "dinh bao dai"],
    "ultra_lm_09_dinh_1_bao_dai": ["dinh i", "dinh 1", "king 1 palace"],
    "ultra_lm_10_domaine_de_marie": ["domaine de marie", "mai anh"],
    "ultra_lm_11_dai_hoc_da_lat": ["dai hoc da lat"],
    "ultra_lm_13_khach_san_du_parc": ["du parc", "mercure"],
    "ultra_lm_14_vuon_hoa_tp": ["vuon hoa"],
    "ultra_lm_15_thien_vien_truc_lam": ["thien vien truc lam", "truc lam"],
    "ultra_lm_16_chua_linh_phuoc": ["linh phuoc", "chua ve chai"],
    "ultra_lm_26_nha_tho_cam_ly": ["nha tho cam ly"],
    "ultra_lm_27_thich_ca_phat_dai": ["thich ca phat dai"],
    "ultra_lm_28_biet_thu_hang_nga": ["crazy house", "hang nga"],
    "ultra_lm_32_chua_tau_thien_vuong": ["thien vuong co sat", "chua tau"],
}

# Plazas / water-island complexes whose geometry spans yards/lakes rather than 1 rectangular building footprint
PLAZA_OR_WATER_EXCEPTIONS = {
    "ultra_lm_01_quang_truong_lam_vien",
    "lm_01_quang_truong_lam_vien",
    "ultra_lm_05_cho_da_lat_hoa_binh",
    "lm_05_cho_da_lat_hoa_binh",
    "ultra_lm_06_nha_hang_thuy_ta",
    "lm_06_nha_hang_thuy_ta",
}


def deg2num_float(lat_deg: float, lon_deg: float, zoom: int):
    lr = math.radians(lat_deg)
    n = float(2 ** zoom)
    return (lon_deg + 180.0) / 360.0 * n, (1.0 - math.asinh(math.tan(lr)) / math.pi) / 2.0 * n


def fetch_google_local(cx_m: float, cy_north_m: float, half_span_m: float, zoom: int = 19, out_px: int = 580) -> Image.Image:
    min_x, max_x = cx_m - half_span_m, cx_m + half_span_m
    min_y, max_y = cy_north_m - half_span_m, cy_north_m + half_span_m
    north, west = local_to_latlon(min_x, max_y)
    south, east = local_to_latlon(max_x, min_y)
    x0, y0 = deg2num_float(north, west, zoom)
    x1, y1 = deg2num_float(south, east, zoom)
    tx0, tx1 = int(math.floor(x0)), int(math.floor(x1))
    ty0, ty1 = int(math.floor(y0)), int(math.floor(y1))

    missing = [(zoom, tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)
               if not (CACHE_G / f"{zoom}_{tx}_{ty}.jpg").exists()]
    if missing:
        def dl(job):
            z, tx, ty = job
            fp = CACHE_G / f"{z}_{tx}_{ty}.jpg"
            u = f"https://mt{(tx+ty)%4}.google.com/vt/lyrs=s&x={tx}&y={ty}&z={z}"
            for a in range(3):
                try:
                    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=10) as r:
                        fp.write_bytes(r.read())
                    return True
                except Exception:
                    time.sleep(0.25 * (a + 1))
            return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(dl, missing))

    mw, mh = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
    canvas = Image.new("RGB", (mw, mh), (40, 60, 40))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            fp = CACHE_G / f"{zoom}_{tx}_{ty}.jpg"
            if fp.exists():
                try:
                    canvas.paste(Image.open(fp).convert("RGB"), ((tx - tx0) * 256, (ty - ty0) * 256))
                except Exception:
                    pass
    px0, py0 = (x0 - tx0) * 256.0, (y0 - ty0) * 256.0
    px1, py1 = (x1 - tx0) * 256.0, (y1 - ty0) * 256.0
    return canvas.transform((out_px, out_px), Image.Transform.EXTENT, (px0, py0, px1, py1), resample=Image.Resampling.BICUBIC)


def _poly_area(pts):
    if len(pts) < 3:
        return 0.0
    arr = np.asarray(pts, dtype=np.float64)
    return 0.5 * abs(float(np.dot(arr[:, 0], np.roll(arr[:, 1], 1)) - np.dot(arr[:, 1], np.roll(arr[:, 0], 1))))


def fetch_osm_buildings_ring0():
    """Fetches & caches Official OSM API v0.6 building footprints + landmark tags across core [-2500..+2500]m."""
    if OSM_LM_CACHE.exists():
        return json.loads(OSM_LM_CACHE.read_text(encoding="utf-8"))
    cells = []
    edges = [-2400, -1200, 0, 1200, 2400]
    for i in range(len(edges) - 1):
        for j in range(len(edges) - 1):
            cells.append((edges[i], edges[i + 1], edges[j], edges[j + 1]))

    bldgs = []
    seen = set()
    for x0, x1, y0, y1 in cells:
        slat, wlon = local_to_latlon(x0, y0)
        nlat, elon = local_to_latlon(x1, y1)
        url = f"https://api.openstreetmap.org/api/0.6/map?bbox={wlon:.5f},{slat:.5f},{elon:.5f},{nlat:.5f}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Dalat3D-LandmarkAudit/1.1"})
            with urllib.request.urlopen(req, timeout=25) as r:
                root = ET.fromstring(r.read())
            nodes = {n.attrib["id"]: (float(n.attrib["lat"]), float(n.attrib["lon"])) for n in root.findall("node")}
            for w in root.findall("way"):
                wid = w.attrib["id"]
                if wid in seen:
                    continue
                tags = {t.attrib["k"]: t.attrib["v"] for t in w.findall("tag")}
                is_b = "building" in tags
                if not is_b and "historic" not in tags and "tourism" not in tags and "amenity" not in tags:
                    continue
                pts = [latlon_to_local(*nodes[nd.attrib["ref"]]) for nd in w.findall("nd") if nd.attrib["ref"] in nodes]
                if len(pts) < 3:
                    continue
                area = round(_poly_area(pts), 1)
                # Skip giant campus/district landuse parcels (> 22,000 m2) unless explicitly building
                if (not is_b) and area > 18000.0:
                    continue
                seen.add(wid)
                arr = np.array(pts, dtype=np.float32)
                cx, cy = float(arr[:, 0].mean()), float(arr[:, 1].mean())
                bldgs.append({
                    "osm_id": wid,
                    "name": tags.get("name", ""),
                    "name_norm": vi_norm(tags.get("name", "")),
                    "is_building": is_b,
                    "area_m2": area,
                    "pts": pts,
                    "cx": cx,
                    "cy": cy,
                })
        except Exception as exc:
            print(f"[OSM Fetch Warn] cell {(x0,x1,y0,y1)}: {exc}", flush=True)
    OSM_LM_CACHE.write_text(json.dumps(bldgs, ensure_ascii=False), encoding="utf-8")
    print(f"[OSM Core Buildings v2] Cached {len(bldgs)} polygons from Official OSM API v0.6", flush=True)
    return bldgs


def ensure_osm_around_point(cx_m: float, cy_m: float, osm_bldgs: list):
    """Fetches OSM buildings around outer Ring-1/2 landmarks if none cached nearby."""
    if any(abs(b["cx"] - cx_m) < 250 and abs(b["cy"] - cy_m) < 250 for b in osm_bldgs):
        return
    slat, wlon = local_to_latlon(cx_m - 420.0, cy_m - 420.0)
    nlat, elon = local_to_latlon(cx_m + 420.0, cy_m + 420.0)
    url = f"https://api.openstreetmap.org/api/0.6/map?bbox={wlon:.5f},{slat:.5f},{elon:.5f},{nlat:.5f}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Dalat3D-LandmarkAudit/1.1"})
        with urllib.request.urlopen(req, timeout=20) as r:
            root = ET.fromstring(r.read())
        nodes = {n.attrib["id"]: (float(n.attrib["lat"]), float(n.attrib["lon"])) for n in root.findall("node")}
        seen = {b["osm_id"] for b in osm_bldgs}
        added = 0
        for w in root.findall("way"):
            wid = w.attrib["id"]
            if wid in seen:
                continue
            tags = {t.attrib["k"]: t.attrib["v"] for t in w.findall("tag")}
            is_b = "building" in tags
            if not is_b and "historic" not in tags:
                continue
            pts = [latlon_to_local(*nodes[nd.attrib["ref"]]) for nd in w.findall("nd") if nd.attrib["ref"] in nodes]
            if len(pts) < 3:
                continue
            area = round(_poly_area(pts), 1)
            if (not is_b) and area > 18000.0:
                continue
            arr = np.array(pts, dtype=np.float32)
            osm_bldgs.append({
                "osm_id": wid,
                "name": tags.get("name", ""),
                "name_norm": vi_norm(tags.get("name", "")),
                "is_building": is_b,
                "area_m2": area,
                "pts": pts,
                "cx": float(arr[:, 0].mean()),
                "cy": float(arr[:, 1].mean()),
            })
            added += 1
        if added:
            OSM_LM_CACHE.write_text(json.dumps(osm_bldgs, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        print(f"[OSM Local Fetch Warn] ({cx_m:.0f},{cy_m:.0f}): {exc}", flush=True)


def principal_angle_and_elongation(pts_xy: np.ndarray):
    if len(pts_xy) < 3:
        return 0.0, 1.0
    centered = pts_xy - pts_xy.mean(axis=0, keepdims=True)
    cov = np.cov(centered.T)
    eigvals, eigvecs = np.linalg.eigh(cov)
    order = np.argsort(eigvals)
    lmin, lmax = max(1e-6, float(eigvals[order[0]])), max(1e-6, float(eigvals[order[1]]))
    major = eigvecs[:, int(order[1])]
    ang = math.degrees(math.atan2(float(major[1]), float(major[0]))) % 180.0
    elong = math.sqrt(lmax / lmin)
    return ang, elong


def compute_footprint_iou(tris: np.ndarray, osm_pts: list, min_x: float, max_x: float, min_y: float, max_y: float, size_px: int = 256) -> float:
    if not len(tris) or len(osm_pts) < 3:
        return 0.0
    m3d = Image.new("L", (size_px, size_px), 0)
    d3d = ImageDraw.Draw(m3d)
    step = max(1, len(tris) // 4500)
    for t in tris[::step]:
        d3d.polygon([xy_to_px(float(t[k, 0]), float(t[k, 1]), min_x, max_x, min_y, max_y, size_px) for k in range(3)], fill=255)
    mosm = Image.new("L", (size_px, size_px), 0)
    dosm = ImageDraw.Draw(mosm)
    dosm.polygon([xy_to_px(p[0], p[1], min_x, max_x, min_y, max_y, size_px) for p in osm_pts], fill=255)
    a3 = np.asarray(m3d, dtype=np.uint8) > 127
    ao = np.asarray(mosm, dtype=np.uint8) > 127
    union = int(np.logical_or(a3, ao).sum())
    if union == 0:
        return 0.0
    return float(np.logical_and(a3, ao).sum()) / union


def match_osm_ground_truth(lm: dict, mesh_cx: float, mesh_cy: float, glb_area_est: float, osm_bldgs: list):
    """
    2-Tier OSM Ground Truth Matcher:
      Tier 1: Exact name/alias match within 850m (catches misplaced landmarks 100..500m away!).
      Tier 2: Nearest size-compatible building polygon within 95m (skips random tiny kiosks).
    Returns (best_osm_or_None, match_tier_str).
    """
    lmid = lm["id"]
    if lmid in PLAZA_OR_WATER_EXCEPTIONS:
        return None, "PLAZA_OR_WATER_EXEMPT"

    aliases = LANDMARK_OSM_ALIASES.get(lmid, [])
    nm_vi = vi_norm(lm.get("name_vi", "").split("(")[0].replace("Ultra-LOD0", ""))
    # Build meaningful tokens for Tier-1 name search
    search_tokens = list(aliases)
    if len(nm_vi) >= 6:
        search_tokens.append(nm_vi)

    # Special CĐSP main building match: large curved block around campus (>800 m2) if exact name is parcel
    if "cdsp" in lmid.lower() or "su pham" in nm_vi:
        cands = [
            b for b in osm_bldgs
            if b["is_building"] and b["area_m2"] >= 700.0 and math.hypot(b["cx"] - mesh_cx, b["cy"] - mesh_cy) <= 180.0
        ]
        if cands:
            cands.sort(key=lambda b: math.hypot(b["cx"] - mesh_cx, b["cy"] - mesh_cy) - 0.03 * b["area_m2"])
            return cands[0], "TIER1_EXACT_COMPOUND"

    best_t1 = None
    best_t1_d = 9999.0
    for ob in osm_bldgs:
        on = ob.get("name_norm", "")
        if not on:
            continue
        d = math.hypot(ob["cx"] - mesh_cx, ob["cy"] - mesh_cy)
        if d > 850.0:
            continue
        if any(tok in on or on in tok for tok in search_tokens if len(tok) >= 5):
            # Prefer real building polygons over general parcel tags
            eff_d = d - (120.0 if ob["is_building"] else 0.0)
            if eff_d < best_t1_d:
                best_t1_d = eff_d
                best_t1 = ob
    if best_t1 is not None:
        return best_t1, "TIER1_EXACT_NAME"

    # Tier 2: Local geometric footprint match within 95m filtering out tiny kiosks
    min_req_area = max(65.0, min(650.0, glb_area_est * 0.22))
    best_t2 = None
    best_t2_score = 9999.0
    for ob in osm_bldgs:
        if not ob["is_building"] or ob["area_m2"] < min_req_area:
            continue
        d = math.hypot(ob["cx"] - mesh_cx, ob["cy"] - mesh_cy)
        if d > 95.0:
            continue
        score = d - 12.0 * math.log1p(ob["area_m2"] / 100.0)
        if score < best_t2_score:
            best_t2_score = score
            best_t2 = ob
    return best_t2, ("TIER2_GEOMETRY" if best_t2 else "UNMATCHED")


def _load_all_landmarks_portable():
    return _urban_mod._load_landmarks_list()


def build_all_batches():
    all_lms = _load_all_landmarks_portable()
    hero_t0 = [lm for lm in all_lms if not lm.get("is_french_villa") and lm["url"].startswith("./assets/hero_landmarks_ultra/") and lm.get("tile_id") == "T_E00_N00"]
    hero_other = [lm for lm in all_lms if not lm.get("is_french_villa") and lm["url"].startswith("./assets/hero_landmarks_ultra/") and lm.get("tile_id") != "T_E00_N00"]
    std_lms = [lm for lm in all_lms if not lm.get("is_french_villa") and not lm["url"].startswith("./assets/hero_landmarks_ultra/") and "tc_" not in lm["id"]]
    villas = [lm for lm in all_lms if lm.get("is_french_villa")]
    complexes = [lm for lm in all_lms if "tc_" in lm["id"]]

    batches = {}
    for bi in range(0, max(1, (len(hero_t0) + 7) // 8)):
        suffix = "" if bi == 0 else f"_P{bi+1}"
        key = "B01_HERO_T_E00_N00" if bi == 0 else f"B01_HERO_T_E00_N00_P{bi+1}"
        batches[key] = hero_t0[bi * 8 : (bi + 1) * 8]
    for bi in range(0, max(1, (len(hero_other) + 7) // 8)):
        batches[f"B02_HERO_OUTER_{bi+1:02d}"] = hero_other[bi * 8 : (bi + 1) * 8]
    for bi in range(0, max(1, (len(std_lms) + 7) // 8)):
        batches[f"B03_LANDMARKS_{bi+1:02d}"] = std_lms[bi * 8 : (bi + 1) * 8]
    for bi in range(0, max(1, (len(villas) + 7) // 8)):
        batches[f"B04_VILLAS_{bi+1:02d}"] = villas[bi * 8 : (bi + 1) * 8]
    for bi in range(0, max(1, (len(complexes) + 7) // 8)):
        batches[f"B05_TOURISM_{bi+1:02d}"] = complexes[bi * 8 : (bi + 1) * 8]
    return batches


def select_batch_landmarks(batch_name: str):
    batches = build_all_batches()
    if batch_name in batches:
        return batches[batch_name]
    if batch_name == "B02_HERO_RING0":
        return batches.get("B02_HERO_OUTER_01", [])
    raise ValueError(f"Unknown batch '{batch_name}'. Valid examples: {list(batches.keys())[:10]}")


def _render_landmark_panel(lm, osm_bldgs, water_mask, road_core_mask, draw_target_arrow=True):
    gp = lm.get("gltf_position") or [0, 0, 0]
    gp_x, gp_y = float(gp[0]), -float(gp[2])
    rot = float(lm.get("rotation_y_rad", 0.0) or 0.0)
    lfp = ROOT / lm["url"].lstrip("./")

    tris = read_glb_tris_xz(lfp, offset_xyz=gp, rot_y_rad=rot) if lfp.exists() else np.zeros((0, 3, 2))
    if len(tris):
        pts_flat = tris.reshape(-1, 2)
        mesh_cx, mesh_cy = float(pts_flat[:, 0].mean()), float(pts_flat[:, 1].mean())
        w_span = float(pts_flat[:, 0].max() - pts_flat[:, 0].min())
        h_span = float(pts_flat[:, 1].max() - pts_flat[:, 1].min())
        glb_area_est = max(100.0, w_span * h_span * 0.55)
        base_span = min(220.0, max(75.0, max(w_span, h_span) * 0.85))
    else:
        mesh_cx, mesh_cy, glb_area_est, base_span = gp_x, gp_y, 200.0, 100.0

    ensure_osm_around_point(mesh_cx, mesh_cy, osm_bldgs)
    best_osm, match_tier = match_osm_ground_truth(lm, mesh_cx, mesh_cy, glb_area_est, osm_bldgs)

    # Expand map view automatically if misplaced landmark is far from its Tier-1 OSM target!
    view_cx, view_cy, span = mesh_cx, mesh_cy, base_span
    dist_to_osm = None
    dx_m, dy_m, d_ang, iou_val = 0.0, 0.0, 0.0, 0.0
    if best_osm:
        dist_to_osm = round(math.hypot(best_osm["cx"] - mesh_cx, best_osm["cy"] - mesh_cy), 2)
        dx_m = round(mesh_cx - best_osm["cx"], 2)
        dy_m = round(mesh_cy - best_osm["cy"], 2)
        if dist_to_osm > base_span * 0.65:
            view_cx = 0.5 * (mesh_cx + best_osm["cx"])
            view_cy = 0.5 * (mesh_cy + best_osm["cy"])
            span = min(460.0, max(base_span, dist_to_osm * 0.72 + 75.0))

    zoom = 19 if span <= 220.0 else 18
    tile_img = fetch_google_local(view_cx, view_cy, span, zoom=zoom, out_px=580).convert("RGBA")
    ov = Image.new("RGBA", (580, 580), (0, 0, 0, 0))
    dr = ImageDraw.Draw(ov)

    min_x, max_x = view_cx - span, view_cx + span
    min_y, max_y = view_cy - span, view_cy + span

    # Draw surrounding OSM buildings in crisp emerald green
    for ob in osm_bldgs:
        if abs(ob["cx"] - view_cx) <= span + 80 and abs(ob["cy"] - view_cy) <= span + 80:
            pxs = [xy_to_px(p[0], p[1], min_x, max_x, min_y, max_y, 580) for p in ob["pts"]]
            if len(pxs) >= 3:
                dr.polygon(pxs, outline=(34, 197, 94, 210))

    # Draw dense 3D footprint triangles & sample water/road carriageway intrusions
    water_hits, road_hits, sample_cnt = 0, 0, 0
    if len(tris):
        step = max(1, len(tris) // 9000)
        sub = tris[::step]
        sample_cnt = len(sub)
        for t in sub:
            pxs = [xy_to_px(float(t[k, 0]), float(t[k, 1]), min_x, max_x, min_y, max_y, 580) for k in range(3)]
            dr.polygon(pxs, fill=(217, 70, 239, 130), outline=(250, 232, 255, 145))
            txm, tym = float(t[:, 0].mean()), float(t[:, 1].mean())
            if -3000 <= txm <= 3000 and -3000 <= tym <= 3000:
                ux = max(0, min(2999, int((txm + 3000.0) / 6000.0 * 3000)))
                vy = max(0, min(2999, int((3000.0 - tym) / 6000.0 * 3000)))
                if water_mask[vy, ux]:
                    water_hits += 1
                if road_core_mask[vy, ux]:
                    road_hits += 1

    water_pct = round(water_hits * 100.0 / max(1, sample_cnt), 1)
    road_pct = round(road_hits * 100.0 / max(1, sample_cnt), 1)

    if best_osm and len(tris):
        a_3d, e_3d = principal_angle_and_elongation(tris.reshape(-1, 2))
        a_osm, e_osm = principal_angle_and_elongation(np.array(best_osm["pts"], dtype=np.float32))
        if min(e_3d, e_osm) >= 1.28:
            diff = abs(a_3d - a_osm) % 180.0
            d_ang = round(min(diff, 180.0 - diff), 1)
        iou_val = round(compute_footprint_iou(tris, best_osm["pts"], min_x, max_x, min_y, max_y), 3)

    is_exempt = lm["id"] in PLAZA_OR_WATER_EXCEPTIONS
    is_thuy_ta = "thuy_ta" in lm["id"].lower()

    status = "OK"
    fix_action = "NONE"
    is_villa = bool(lm.get("is_french_villa"))
    if match_tier == "TIER1_EXACT_NAME" and dist_to_osm is not None and dist_to_osm > 25.0:
        status = "NEEDS_FIX"
        fix_action = "RELOCATE_TO_OSM_TARGET"
    elif (not is_thuy_ta and water_pct > 5.0) or (not is_exempt and road_pct > 15.0):
        status = "NEEDS_FIX"
        fix_action = "RESOLVE_WATER_ROAD_COLLISION" if best_osm is None else "RELOCATE_TO_OSM_TARGET"
    elif best_osm and dist_to_osm is not None and match_tier == "TIER1_EXACT_COMPOUND" and dist_to_osm > 18.0 and iou_val < 0.25:
        status = "NEEDS_FIX"
        fix_action = "RELOCATE_TO_OSM_TARGET"
    elif best_osm and is_villa and match_tier == "TIER2_GEOMETRY" and 16.0 < dist_to_osm <= 45.0 and iou_val < 0.22:
        status = "NEEDS_FIX"
        fix_action = "RELOCATE_TO_OSM_TARGET"
    elif best_osm and ((dist_to_osm is not None and dist_to_osm > 9.0) or (iou_val < 0.28 and d_ang > 22.0)):
        status = "MINOR_OFFSET"

    # Highlight OSM target & draw correction vector arrow if displaced
    if best_osm:
        tpxs = [xy_to_px(p[0], p[1], min_x, max_x, min_y, max_y, 580) for p in best_osm["pts"]]
        if len(tpxs) >= 3:
            dr.polygon(tpxs, fill=(6, 182, 212, 55), outline=(34, 211, 238, 255))
        tu, tv = xy_to_px(best_osm["cx"], best_osm["cy"], min_x, max_x, min_y, max_y, 580)
        dr.ellipse((tu - 11, tv - 11, tu + 11, tv + 11), outline=(34, 211, 238, 255), width=3)
        if draw_target_arrow and dist_to_osm and dist_to_osm > 12.0:
            cu, cv = xy_to_px(mesh_cx, mesh_cy, min_x, max_x, min_y, max_y, 580)
            dr.line((cu, cv, tu, tv), fill=(250, 204, 21, 255), width=3)

    cu, cv = xy_to_px(mesh_cx, mesh_cy, min_x, max_x, min_y, max_y, 580)
    dr.line((cu - 12, cv, cu + 12, cv), fill=(255, 255, 255, 255), width=2)
    dr.line((cu, cv - 12, cu, cv + 12), fill=(255, 255, 255, 255), width=2)

    comp = Image.alpha_composite(tile_img, ov).convert("RGB")
    record = {
        "id": lm["id"],
        "name_vi": lm.get("name_vi", ""),
        "status": status,
        "fix_action": fix_action,
        "match_tier": match_tier,
        "dx_m": dx_m,
        "dy_north_m": dy_m,
        "dist_to_osm_m": dist_to_osm,
        "heading_diff_deg": d_ang,
        "footprint_iou": iou_val,
        "water_overlap_pct": water_pct,
        "road_overlap_pct": road_pct,
        "matched_osm_name": best_osm["name"] if best_osm else "",
        "matched_osm_id": best_osm["osm_id"] if best_osm else "",
        "current_mesh_center_m": [round(mesh_cx, 2), round(mesh_cy, 2)],
        "target_osm_center_m": [round(best_osm["cx"], 2), round(best_osm["cy"], 2)] if best_osm else None,
        "recommended_shift_m": [round(best_osm["cx"] - mesh_cx, 2), round(best_osm["cy"] - mesh_cy, 2)] if best_osm else None,
    }
    return comp, record


def run_audit(batch_name: str, out_img: pathlib.Path, out_ticket: pathlib.Path):
    lms = select_batch_landmarks(batch_name)
    osm_bldgs = fetch_osm_buildings_ring0()
    water_mask, _, _, road_core_mask = load_osm_masks_for_sector(-3000.0, 3000.0, -3000.0, 3000.0, 3000)

    sheet = Image.new("RGB", (2400, 1260), (15, 23, 42))
    sdraw = ImageDraw.Draw(sheet)
    sdraw.text((20, 14), f"DALAT 3D LOCAL LANDMARK ORTHOGRAPHIC PLAN AUDIT | BATCH={batch_name} ({len(lms)} landmarks vs Google Z19 + Official OSM)", fill=(52, 211, 153))

    records = []
    for idx, lm in enumerate(lms[:8]):
        comp, rec = _render_landmark_panel(lm, osm_bldgs, water_mask, road_core_mask)
        col_i, row_i = idx % 4, idx // 4
        ox, oy = 15 + col_i * 595, 46 + row_i * 604
        sheet.paste(comp, (ox, oy))
        badge_col = (16, 185, 129) if rec["status"] == "OK" else ((245, 158, 11) if rec["status"] == "MINOR_OFFSET" else (239, 68, 68))
        sdraw.rectangle((ox, oy, ox + 580, oy + 46), fill=(15, 23, 42))
        sdraw.text((ox + 8, oy + 4), f"{lm['id'][:37]} [{rec['status']}]", fill=badge_col)
        sdraw.text((ox + 8, oy + 24), f"d=({rec['dx_m']:+.0f},{rec['dy_north_m']:+.0f})m IoU={rec['footprint_iou']:.2f} dR={rec['heading_diff_deg']}° W={rec['water_overlap_pct']}% R={rec['road_overlap_pct']}%", fill=(226, 232, 240))
        records.append(rec)

    out_img.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_img, format="JPEG", quality=92, optimize=True)
    ticket = {
        "schema_version": "1.1.0",
        "slot": 27,
        "target_fixer_slot": 29,
        "batch": batch_name,
        "audited_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "items": records,
        "needs_fix_ids": [r["id"] for r in records if r["status"] == "NEEDS_FIX"],
        "contact_sheet": out_img.name,
    }
    out_ticket.parent.mkdir(parents=True, exist_ok=True)
    out_ticket.write_text(json.dumps(ticket, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[LandmarkLocalAudit] {batch_name}: audited {len(records)} landmarks, needs_fix={ticket['needs_fix_ids']}")
    return ticket


def run_fix(ticket_path: pathlib.Path, out_img: pathlib.Path, out_report: pathlib.Path):
    """Slot 29 Auto-Fixer: translates misplaced landmarks onto verified OSM footprints & optimizes yaw by raster IoU."""
    ticket = json.loads(ticket_path.read_text(encoding="utf-8"))
    batch_name = ticket["batch"]
    osm_bldgs = fetch_osm_buildings_ring0()
    water_mask, _, _, road_core_mask = load_osm_masks_for_sector(-3000.0, 3000.0, -3000.0, 3000.0, 3000)
    dem = CopernicusDemSampler()

    manifest_specs = [
        (ASSETS / "hero_landmarks_ultra/hero_landmarks_manifest.json", "landmarks_ultra"),
        (ASSETS / "landmarks/landmarks_manifest.json", "landmarks"),
        (ASSETS / "french_villas/french_villas_manifest.json", "villas"),
        (ASSETS / "tourism_complexes/tourism_complexes_manifest.json", "complexes"),
    ]
    loaded_manifests = []
    entry_index = {}
    for fp, list_key in manifest_specs:
        if not fp.exists():
            continue
        doc = json.loads(fp.read_text(encoding="utf-8"))
        loaded_manifests.append((fp, list_key, doc, [False]))
        for entry in doc.get(list_key, []):
            if entry.get("id"):
                entry_index[entry["id"]] = (fp, doc, entry, loaded_manifests[-1][3])

    wi_map = {lm["id"]: lm for lm in _load_all_landmarks_portable()}

    applied_fixes = []
    before_panels = {}
    for item in ticket.get("items", []):
        lmid = item["id"]
        if item.get("status") != "NEEDS_FIX" or not item.get("recommended_shift_m"):
            continue
        if lmid not in entry_index or lmid not in wi_map:
            continue
        wm = wi_map[lmid]
        before_comp, _ = _render_landmark_panel(wm, osm_bldgs, water_mask, road_core_mask)
        before_panels[lmid] = before_comp

        mfp, doc, entry, dirty_flag = entry_index[lmid]
        gp = entry.get("gltf_position") or wm.get("gltf_position") or [0.0, 0.0, 0.0]
        cur_rot = float(entry.get("rotation_y_rad", wm.get("rotation_y_rad", 0.0)) or 0.0)
        shift_x, shift_y_north = item["recommended_shift_m"]

        new_x = round(float(gp[0]) + shift_x, 3)
        new_y_north = round(-float(gp[2]) + shift_y_north, 3)

        # Safety check: never move a non-water landmark into Ho Xuan Huong lake!
        if "thuy_ta" not in lmid.lower() and -3000 <= new_x <= 3000 and -3000 <= new_y_north <= 3000:
            ux = max(0, min(2999, int((new_x + 3000.0) / 6000.0 * 3000)))
            vy = max(0, min(2999, int((3000.0 - new_y_north) / 6000.0 * 3000)))
            if water_mask[vy, ux]:
                continue

        # Test whether rotating improves footprint IoU against matched OSM polygon
        new_rot = cur_rot
        target_ob = next((b for b in osm_bldgs if b["osm_id"] == item.get("matched_osm_id")), None)
        lfp = ROOT / wm["url"].lstrip("./")
        if target_ob and lfp.exists() and len(target_ob["pts"]) >= 3:
            new_gp_tmp = [new_x, float(gp[1]), -new_y_north]
            span_test = max(70.0, item.get("dist_to_osm_m") or 70.0)
            span_test = min(140.0, max(70.0, span_test))
            bx0, bx1 = new_x - 85.0, new_x + 85.0
            by0, by1 = new_y_north - 85.0, new_y_north + 85.0
            base_tris = read_glb_tris_xz(lfp, offset_xyz=new_gp_tmp, rot_y_rad=cur_rot)
            best_iou = compute_footprint_iou(base_tris, target_ob["pts"], bx0, bx1, by0, by1, 192)
            a_osm, _ = principal_angle_and_elongation(np.array(target_ob["pts"], dtype=np.float32))
            a_3d, _ = principal_angle_and_elongation(base_tris.reshape(-1, 2))
            d_deg = ((a_osm - a_3d + 90.0) % 180.0) - 90.0
            for cand_rad in [cur_rot + math.radians(d_deg), cur_rot - math.radians(d_deg), cur_rot + math.radians(d_deg) + math.pi, cur_rot - math.radians(d_deg) + math.pi]:
                ctris = read_glb_tris_xz(lfp, offset_xyz=new_gp_tmp, rot_y_rad=cand_rad)
                ciou = compute_footprint_iou(ctris, target_ob["pts"], bx0, bx1, by0, by1, 192)
                if ciou > best_iou + 0.08:
                    best_iou = ciou
                    new_rot = round(cand_rad, 6)

        new_z_local = round(dem.sample_local_y(new_x, new_y_north, default_y=float(gp[1])), 3)
        new_lat, new_lon = local_to_latlon(new_x, new_y_north)
        new_tid = xy_to_tile_id(new_x, new_y_north)
        new_gp = [new_x, new_z_local, -new_y_north]

        entry["gltf_position"] = new_gp
        entry["rotation_y_rad"] = new_rot
        entry["tile_id"] = new_tid
        entry["lat"] = round(new_lat, 7)
        entry["lon"] = round(new_lon, 7)
        if "x_m" in entry:
            entry["x_m"] = new_x
        if "y_m" in entry:
            entry["y_m"] = new_y_north
        if "z_local_m" in entry:
            entry["z_local_m"] = new_z_local
        if "elev_msl_m" in entry:
            entry["elev_msl_m"] = round(1478.0 + new_z_local, 2)
        entry["plan_audit_fixed_by"] = "slot29"
        dirty_flag[0] = True

        # Update working copy for After visualization
        wm["gltf_position"] = new_gp
        wm["rotation_y_rad"] = new_rot
        wm["tile_id"] = new_tid
        applied_fixes.append({
            "id": lmid,
            "manifest": str(mfp.relative_to(ROOT)),
            "old_gltf_position": gp,
            "new_gltf_position": new_gp,
            "old_rot_rad": cur_rot,
            "new_rot_rad": new_rot,
            "shift_m": [shift_x, shift_y_north],
            "matched_osm_name": item.get("matched_osm_name", ""),
        })

    for fp, _, doc, dirty in loaded_manifests:
        if dirty[0]:
            fp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")

    # Render Before / After comparison contact sheet (up to 4 fixed items: top=Before, bottom=After)
    sheet = Image.new("RGB", (2400, 1260), (15, 23, 42))
    sdraw = ImageDraw.Draw(sheet)
    sdraw.text((20, 14), f"SLOT-29 BEFORE/AFTER LANDMARK ALIGNMENT | BATCH={batch_name} | Fixed={len(applied_fixes)} landmarks (Copernicus DEM + OSM Verified)", fill=(52, 211, 153))
    for i, fx in enumerate(applied_fixes[:4]):
        lmid = fx["id"]
        ox = 15 + i * 595
        sheet.paste(before_panels[lmid], (ox, 46))
        sdraw.rectangle((ox, 46, ox + 580, 76), fill=(15, 23, 42))
        sdraw.text((ox + 8, 52), f"BEFORE: {lmid[:36]}", fill=(248, 113, 113))
        after_comp, after_rec = _render_landmark_panel(wi_map[lmid], osm_bldgs, water_mask, road_core_mask, draw_target_arrow=False)
        sheet.paste(after_comp, (ox, 650))
        sdraw.rectangle((ox, 650, ox + 580, 680), fill=(15, 23, 42))
        sdraw.text((ox + 8, 656), f"AFTER: {lmid[:36]} [{after_rec['status']}] d={after_rec['dist_to_osm_m']}m IoU={after_rec['footprint_iou']}", fill=(52, 211, 153))

    out_img.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_img, format="JPEG", quality=92, optimize=True)

    report = {
        "schema_version": "1.1.0",
        "slot": 29,
        "source_audit_slot": 27,
        "batch": batch_name,
        "applied_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "fixed_count": len(applied_fixes),
        "fixes": applied_fixes,
        "contact_sheet": out_img.name,
    }
    out_report.parent.mkdir(parents=True, exist_ok=True)
    out_report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[LandmarkLocalFix] {batch_name}: applied {len(applied_fixes)} verified manifest fixes -> {[f['id'] for f in applied_fixes]}")
    return report


def main():
    global ROOT, ASSETS
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="")
    ap.add_argument("--mode", choices=["audit", "fix", "audit_and_fix"], default="audit")
    ap.add_argument("--batch", default="B01_HERO_T_E00_N00")
    ap.add_argument("--list-batches", action="store_true")
    ap.add_argument("--out-img", default="/tmp/dalat_real_cache/qa_landmark_local_test.jpg")
    ap.add_argument("--out-ticket", default="/tmp/dalat_real_cache/landmark_plan_fix_ticket_test.json")
    ap.add_argument("--out-fix-img", default="")
    ap.add_argument("--ticket", default="")
    ap.add_argument("--out-report", default="")
    args = ap.parse_args()
    if args.root:
        ROOT = pathlib.Path(args.root).resolve()
        ASSETS = ROOT / "assets"
        _urban_mod.ROOT = ROOT
        _urban_mod.ASSETS = ASSETS

    if args.list_batches:
        bs = build_all_batches()
        for k, v in bs.items():
            print(f"{k}: {len(v)} items")
        return

    if args.mode in ("audit", "audit_and_fix"):
        tpath = pathlib.Path(args.out_ticket)
        ticket = run_audit(args.batch, pathlib.Path(args.out_img), tpath)
        if args.mode == "audit_and_fix":
            if ticket.get("needs_fix_ids"):
                fix_img = pathlib.Path(args.out_fix_img) if args.out_fix_img else pathlib.Path(args.out_img).with_name(f"qa_landmark_fix_{args.batch}.jpg")
                out_report = pathlib.Path(args.out_report) if args.out_report else tpath.parent / f"applied_landmark_fix_{args.batch}.json"
                run_fix(tpath, fix_img, out_report)
            else:
                print(f"[LandmarkLocalFix] {args.batch}: needs_fix_ids=[] -> skipping fix")
    else:
        tpath = pathlib.Path(args.ticket)
        ticket = json.loads(tpath.read_text(encoding="utf-8"))
        out_report = pathlib.Path(args.out_report) if args.out_report else tpath.parent / f"applied_landmark_fix_{ticket['batch']}.json"
        run_fix(tpath, pathlib.Path(args.out_img), out_report)


if __name__ == "__main__":
    main()
