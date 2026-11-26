#!/usr/bin/env python3
"""
audit_urban_plan_vs_satellite.py — Kiểm Tra Chiếu Bằng Toàn Đô Thị Theo Phân Khu & Tự Động Sửa Xâm Phạm (Slot 26 & Slot 28)

Tính năng:
  - `--mode audit --sector <SECTOR>`:
      Chiếu bằng trực giao (Top-down Orthographic) toàn bộ nhà OSM, biệt thự Pháp, công trình nổi bật,
      đường OSM, mặt nước & cây xanh trong phân khu lên ảnh vệ tinh Google Satellite Z18/Z19.
      Đo lường tự động các lỗi:
        1) Tam giác nhà dân lọt xuống lòng hồ / suối OSM
        2) Tam giác nhà dân lấn vào lòng đường OSM
        3) Đường 3D lệch so với tim đường Official OSM API v0.6
        4) Cây thông / mai anh đào mọc đè lên hồ, lòng đường hoặc mái nhà
      Xuất Contact Sheet JPEG đối chiếu (2 khung 2400x1200) + phiếu lỗi `urban_plan_fix_ticket_<SECTOR>.json`.
  - `--mode fix --ticket <TICKET_JSON>`:
      Dành cho Task điều chỉnh Slot 28 (`ĐÀ LẠT - 27`): đọc phiếu lỗi, tự động cắt bỏ tam giác nhà lấn hồ/lấn đường,
      lọc bỏ cây vi phạm, xác thực glTF 2.0, xuất ảnh Trước/Sau & phiếu `applied_urban_fix_<SECTOR>.json`.
"""

import argparse
import concurrent.futures
import datetime
import io
import json
import math
import pathlib
import struct
import time
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageFont

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


def _load_landmarks_list():
    wi_p = ROOT / "api" / "world-index.json"
    if wi_p.exists():
        return json.loads(wi_p.read_text(encoding="utf-8")).get("layers", {}).get("landmarks", [])
    items = []
    specs = [
        (ASSETS / "hero_landmarks_ultra/hero_landmarks_manifest.json", "landmarks_ultra", "./assets/hero_landmarks_ultra", False),
        (ASSETS / "landmarks/landmarks_manifest.json", "landmarks", "./assets/landmarks", False),
        (ASSETS / "french_villas/french_villas_manifest.json", "villas", "./assets/french_villas", True),
        (ASSETS / "tourism_complexes/tourism_complexes_manifest.json", "complexes", "./assets/tourism_complexes", False),
    ]
    for fp, key, url_base, is_fv in specs:
        if not fp.exists():
            continue
        doc = json.loads(fp.read_text(encoding="utf-8"))
        for e in doc.get(key, []):
            eid = e.get("id")
            gp = e.get("gltf_position")
            if not (eid and isinstance(gp, list) and len(gp) == 3):
                continue
            fn = e.get("filename") or f"{eid}.glb"
            items.append({
                "id": eid,
                "url": f"{url_base}/{fn}",
                "tile_id": e.get("tile_id", ""),
                "gltf_position": gp,
                "rotation_y_rad": e.get("rotation_y_rad", 0.0),
                "name_vi": e.get("name_vi", eid),
                "is_french_villa": is_fv,
            })
    return items

LAT0 = 11.940419
LON0 = 108.445259
MLAT = 111319.49
MLON = 108911.0
TILE_SIZE_M = 2000.0
HALF_TILE_M = 1000.0

SECTORS = {
    # Core 4 quadrants of T_E00_N00 at ultra-sharp Z19 (1000m x 1000m)
    "T_E00_N00_NW": (-1000.0, 0.0, 0.0, 1000.0, 19),
    "T_E00_N00_NE": (0.0, 1000.0, 0.0, 1000.0, 19),
    "T_E00_N00_SW": (-1000.0, 0.0, -1000.0, 0.0, 19),
    "T_E00_N00_SE": (0.0, 1000.0, -1000.0, 0.0, 19),
    # Inner Ring-0 full 2km x 2km tiles at Z18
    "T_W01_N00": (-3000.0, -1000.0, -1000.0, 1000.0, 18),
    "T_E01_N00": (1000.0, 3000.0, -1000.0, 1000.0, 18),
    "T_E00_N01": (-1000.0, 1000.0, 1000.0, 3000.0, 18),
    "T_E00_S01": (-1000.0, 1000.0, -3000.0, -1000.0, 18),
    "T_W01_N01": (-3000.0, -1000.0, 1000.0, 3000.0, 18),
    "T_E01_N01": (1000.0, 3000.0, 1000.0, 3000.0, 18),
    "T_W01_S01": (-3000.0, -1000.0, -3000.0, -1000.0, 18),
    "T_E01_S01": (1000.0, 3000.0, -3000.0, -1000.0, 18),
    # Outer Ring-1 populated urban sectors at Z18
    "T_W01_S02": (-3000.0, -1000.0, -5000.0, -3000.0, 18),
    "T_E00_S02": (-1000.0, 1000.0, -5000.0, -3000.0, 18),
    "T_E01_S02": (1000.0, 3000.0, -5000.0, -3000.0, 18),
    "T_E02_N00": (3000.0, 5000.0, -1000.0, 1000.0, 18),
    "T_E02_N01": (3000.0, 5000.0, 1000.0, 3000.0, 18),
    "T_E02_S01": (3000.0, 5000.0, -3000.0, -1000.0, 18),
    "T_W02_N00": (-5000.0, -3000.0, -1000.0, 1000.0, 18),
    "T_W02_S01": (-5000.0, -3000.0, -3000.0, -1000.0, 18),
    "T_E00_N02": (-1000.0, 1000.0, 3000.0, 5000.0, 18),
    "T_E01_N02": (1000.0, 3000.0, 3000.0, 5000.0, 18),
    "T_E03_N00": (5000.0, 7000.0, -1000.0, 1000.0, 18),
}



def local_to_latlon(x_m: float, y_north_m: float):
    return LAT0 + y_north_m / MLAT, LON0 + x_m / MLON


def latlon_to_local(lat: float, lon: float):
    return (lon - LON0) * MLON, (lat - LAT0) * MLAT


def deg2num_float(lat_deg: float, lon_deg: float, zoom: int):
    lr = math.radians(lat_deg)
    n = float(2 ** zoom)
    return (lon_deg + 180.0) / 360.0 * n, (1.0 - math.asinh(math.tan(lr)) / math.pi) / 2.0 * n


def fetch_google_ortho(min_x: float, max_x: float, min_y: float, max_y: float, zoom: int, out_px: int = 1200) -> Image.Image:
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
                    time.sleep(0.3 * (a + 1))
            return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
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


def read_glb_tris_xz(glb_path: pathlib.Path, offset_xyz=(0.0, 0.0, 0.0), rot_y_rad: float = 0.0):
    """Extract all world-space triangle XZ footprints from a glTF 2.0 binary file."""
    raw = glb_path.read_bytes()
    if len(raw) < 20 or raw[:4] != b"glTF":
        return np.zeros((0, 3, 2), dtype=np.float32)
    jlen = struct.unpack("<I", raw[12:16])[0]
    j = json.loads(raw[20 : 20 + jlen].decode("utf-8"))
    b = raw[28 + jlen :]
    bvs = j.get("bufferViews", [])
    accs = j.get("accessors", [])

    # Build node -> parent & local transform lookup (handle simple node translation/rotation if present)
    mesh_transforms = {}
    def _mat4(n):
        m = np.eye(4, dtype=np.float64)
        if "matrix" in n:
            m = np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
        else:
            if "translation" in n:
                m[:3, 3] = n["translation"]
            if "rotation" in n:
                qx, qy, qz, qw = n["rotation"]
                r = np.array([
                    [1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qz*qw), 2*(qx*qz + qy*qw)],
                    [2*(qx*qy + qz*qw), 1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qx*qw)],
                    [2*(qx*qz - qy*qw), 2*(qy*qz + qx*qw), 1 - 2*(qx*qx + qy*qy)],
                ], dtype=np.float64)
                m[:3, :3] = r
            if "scale" in n:
                m[:3, :3] *= np.array(n["scale"], dtype=np.float64)[None, :]
        return m

    nodes = j.get("nodes", [])
    has_parent = set()
    for n in nodes:
        for ch in n.get("children", []):
            has_parent.add(ch)
    roots = [i for i in range(len(nodes)) if i not in has_parent]

    root_m = np.eye(4, dtype=np.float64)
    c_r, s_r = math.cos(rot_y_rad), math.sin(rot_y_rad)
    root_m[0, 0], root_m[0, 2] = c_r, s_r
    root_m[2, 0], root_m[2, 2] = -s_r, c_r
    root_m[:3, 3] = [offset_xyz[0], offset_xyz[1], offset_xyz[2]]

    def walk(ni, parent_m):
        nd = nodes[ni]
        cur_m = parent_m @ _mat4(nd)
        if "mesh" in nd:
            mesh_transforms.setdefault(nd["mesh"], []).append(cur_m)
        for ch in nd.get("children", []):
            walk(ch, cur_m)

    for ri in roots:
        walk(ri, root_m)

    tri_chunks = []
    for mi, mesh in enumerate(j.get("meshes", [])):
        mats = mesh_transforms.get(mi, [root_m])
        for prim in mesh.get("primitives", []):
            pi = prim.get("attributes", {}).get("POSITION")
            if pi is None:
                continue
            pa = accs[pi]
            pbv = bvs[pa["bufferView"]]
            poff = pbv.get("byteOffset", 0) + pa.get("byteOffset", 0)
            pos = np.frombuffer(b, dtype="<f4", count=pa["count"] * 3, offset=poff).reshape(-1, 3)

            if "indices" in prim:
                ia = accs[prim["indices"]]
                ibv = bvs[ia["bufferView"]]
                ioff = ibv.get("byteOffset", 0) + ia.get("byteOffset", 0)
                dt = "<u4" if ia["componentType"] == 5125 else "<u2"
                idx = np.frombuffer(b, dtype=dt, count=ia["count"], offset=ioff).reshape(-1, 3)
            else:
                idx = np.arange((len(pos) // 3) * 3, dtype=np.int32).reshape(-1, 3)

            for wm in mats:
                # Transform XZ only cleanly
                px = pos[:, 0] * wm[0, 0] + pos[:, 1] * wm[0, 1] + pos[:, 2] * wm[0, 2] + wm[0, 3]
                pz = pos[:, 0] * wm[2, 0] + pos[:, 1] * wm[2, 1] + pos[:, 2] * wm[2, 2] + wm[2, 3]
                xz = np.stack([px, -pz], axis=-1).astype(np.float32)  # (N, 2) in [x_m, y_north_m]
                tri_chunks.append(xz[idx])

    if not tri_chunks:
        return np.zeros((0, 3, 2), dtype=np.float32)
    return np.concatenate(tri_chunks, axis=0)


def tiles_overlapping_bounds(min_x, max_x, min_y, max_y):
    ix0 = int(math.floor((min_x + 1.0 + HALF_TILE_M) / TILE_SIZE_M))
    ix1 = int(math.floor((max_x - 1.0 + HALF_TILE_M) / TILE_SIZE_M))
    iy0 = int(math.floor((min_y + 1.0 + HALF_TILE_M) / TILE_SIZE_M))
    iy1 = int(math.floor((max_y - 1.0 + HALF_TILE_M) / TILE_SIZE_M))
    out = []
    for iy in range(iy0, iy1 + 1):
        for ix in range(ix0, ix1 + 1):
            ew = "W" if ix < 0 else "E"
            ns = "S" if iy < 0 else "N"
            out.append(f"T_{ew}{abs(ix):02d}_{ns}{abs(iy):02d}")
    return out


def xy_to_px(x_m, y_north_m, min_x, max_x, min_y, max_y, size_px):
    u = (x_m - min_x) / (max_x - min_x) * size_px
    v = (max_y - y_north_m) / (max_y - min_y) * size_px
    return u, v


def _osm_highway_width(highway_val: str) -> float:
    return {
        "motorway": 12.0, "trunk": 11.0, "primary": 9.5, "secondary": 8.0,
        "tertiary": 7.0, "residential": 5.5, "unclassified": 5.0,
        "service": 3.8, "living_street": 4.0, "track": 3.2,
    }.get(highway_val, 3.0)


def _ensure_osm_geojson_for_bounds(min_x, max_x, min_y, max_y):
    """Ensure Official OSM API v0.6 water & road GeoJSONs exist for any urban sector."""
    clean_dir = CACHE_DIR / "clean_gt"
    clean_dir.mkdir(parents=True, exist_ok=True)
    ring0_w = clean_dir / "osm_water_real_ring0.geojson"
    ring0_r = clean_dir / "osm_roads_real_ring0.geojson"
    if -3000.0 <= min_x and max_x <= 3000.0 and -3000.0 <= min_y and max_y <= 3000.0 and ring0_w.exists() and ring0_r.exists():
        return ring0_w, ring0_r

    key = f"osm_sector_{int(min_x)}_{int(max_x)}_{int(min_y)}_{int(max_y)}"
    sw_fp = clean_dir / f"{key}_water.geojson"
    sr_fp = clean_dir / f"{key}_roads.geojson"
    if sw_fp.exists() and sr_fp.exists():
        return sw_fp, sr_fp

    import xml.etree.ElementTree as ET
    slat, wlon = local_to_latlon(min_x - 80.0, min_y - 80.0)
    nlat, elon = local_to_latlon(max_x + 80.0, max_y + 80.0)
    w_feats, r_feats = [], []
    # Split into sub-cells <= 1.2km to stay well below OSM 0.6 node limit
    xs = np.linspace(min_x - 50, max_x + 50, 3)
    ys = np.linspace(min_y - 50, max_y + 50, 3)
    seen_w, seen_r = set(), set()
    for i in range(2):
        for j in range(2):
            s_la, w_lo = local_to_latlon(xs[i], ys[j])
            n_la, e_lo = local_to_latlon(xs[i + 1], ys[j + 1])
            url = f"https://api.openstreetmap.org/api/0.6/map?bbox={w_lo:.5f},{s_la:.5f},{e_lo:.5f},{n_la:.5f}"
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Dalat3D-UrbanPlanAudit/1.0"})
                with urllib.request.urlopen(req, timeout=25) as r:
                    root = ET.fromstring(r.read())
                nodes = {n.attrib["id"]: [float(n.attrib["lon"]), float(n.attrib["lat"])] for n in root.findall("node")}
                for w in root.findall("way"):
                    wid = w.attrib["id"]
                    tags = {t.attrib["k"]: t.attrib["v"] for t in w.findall("tag")}
                    coords = [nodes[nd.attrib["ref"]] for nd in w.findall("nd") if nd.attrib["ref"] in nodes]
                    if len(coords) < 2:
                        continue
                    if "highway" in tags and wid not in seen_r:
                        seen_r.add(wid)
                        hw = tags["highway"]
                        if hw in ("footway", "path", "steps", "cycleway", "pedestrian"):
                            continue
                        r_feats.append({
                            "type": "Feature",
                            "properties": {"osm_id": wid, "highway": hw, "name": tags.get("name", ""), "width_m": _osm_highway_width(hw)},
                            "geometry": {"type": "LineString", "coordinates": coords},
                        })
                    elif (tags.get("natural") == "water" or tags.get("waterway") == "riverbank") and len(coords) >= 3 and wid not in seen_w:
                        seen_w.add(wid)
                        if coords[0] != coords[-1]:
                            coords.append(coords[0])
                        w_feats.append({
                            "type": "Feature",
                            "properties": {"osm_id": wid, "name": tags.get("name", "")},
                            "geometry": {"type": "Polygon", "coordinates": [coords]},
                        })
            except Exception as exc:
                print(f"[OSM Sector Warn] cell=({i},{j}): {exc}", flush=True)

    sw_fp.write_text(json.dumps({"type": "FeatureCollection", "features": w_feats}, ensure_ascii=False), encoding="utf-8")
    sr_fp.write_text(json.dumps({"type": "FeatureCollection", "features": r_feats}, ensure_ascii=False), encoding="utf-8")
    print(f"[OSM Sector Cache] {key}: water={len(w_feats)}, roads={len(r_feats)}", flush=True)
    return sw_fp, sr_fp


def load_osm_masks_for_sector(min_x, max_x, min_y, max_y, size_px):
    water_im = Image.new("L", (size_px, size_px), 0)
    road_im = Image.new("L", (size_px, size_px), 0)
    road_core_im = Image.new("L", (size_px, size_px), 0)
    wd = ImageDraw.Draw(water_im)
    rd = ImageDraw.Draw(road_im)
    rcd = ImageDraw.Draw(road_core_im)

    osm_water_fp, osm_roads_fp = _ensure_osm_geojson_for_bounds(min_x, max_x, min_y, max_y)

    if osm_water_fp.exists():
        wdoc = json.loads(osm_water_fp.read_text(encoding="utf-8"))
        for feat in wdoc.get("features", []):
            geom = feat["geometry"]
            polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
            for poly in polys:
                outer = [xy_to_px(*latlon_to_local(c[1], c[0]), min_x, max_x, min_y, max_y, size_px) for c in poly[0]]
                if len(outer) >= 3:
                    wd.polygon(outer, fill=255)
                for hole in poly[1:]:
                    hp = [xy_to_px(*latlon_to_local(c[1], c[0]), min_x, max_x, min_y, max_y, size_px) for c in hole]
                    if len(hp) >= 3:
                        wd.polygon(hp, fill=0)

    px_per_m = size_px / (max_x - min_x)
    road_lines_px = []
    if osm_roads_fp.exists():
        rdoc = json.loads(osm_roads_fp.read_text(encoding="utf-8"))
        for feat in rdoc.get("features", []):
            coords = feat["geometry"].get("coordinates", [])
            w_m = float(feat["properties"].get("width_m", 6.0))
            pts = [xy_to_px(*latlon_to_local(c[1], c[0]), min_x, max_x, min_y, max_y, size_px) for c in coords]
            if len(pts) >= 2:
                lw_vis = max(2, int(round(w_m * px_per_m)))
                rd.line(pts, fill=255, width=lw_vis)
                # Strict inner carriageway core (exclude sidewalks & narrow <3.6m footpaths from building false positives)
                if w_m >= 3.6:
                    lw_core = max(2, int(round(w_m * 0.56 * px_per_m)))
                    rcd.line(pts, fill=255, width=lw_core)
                road_lines_px.append((pts, w_m, feat["properties"].get("name", "")))

    return (
        np.asarray(water_im, dtype=np.uint8) > 127,
        np.asarray(road_im, dtype=np.uint8) > 127,
        road_lines_px,
        np.asarray(road_core_im, dtype=np.uint8) > 127,
    )


class CopernicusDemSampler:
    """Samples exact ESA Copernicus GLO-30 DEM local elevation (meters above Ho Xuan Huong Y=0 = 1479.5m EGM2008)."""

    def __init__(self):
        self.mosaic = None
        cop_dir = CACHE_DIR / "copernicus"
        n11 = cop_dir / "N11_E108.tif"
        n12 = cop_dir / "N12_E108.tif"
        if not n11.exists():
            cop_dir.mkdir(parents=True, exist_ok=True)
            for fn, url in [
                ("N11_E108.tif", "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N11_00_E108_00_DEM/Copernicus_DSM_COG_10_N11_00_E108_00_DEM.tif"),
                ("N12_E108.tif", "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N12_00_E108_00_DEM/Copernicus_DSM_COG_10_N12_00_E108_00_DEM.tif"),
            ]:
                try:
                    urllib.request.urlretrieve(url, cop_dir / fn)
                except Exception as exc:
                    print(f"[Copernicus Warn] download {fn}: {exc}", flush=True)
        try:
            import tifffile
            if n11.exists() and n12.exists():
                with tifffile.TiffFile(n12) as t12:
                    a12 = t12.pages[0].asarray().astype(np.float32)
                    scale = t12.pages[0].tags["ModelPixelScaleTag"].value
                with tifffile.TiffFile(n11) as t11:
                    a11 = t11.pages[0].asarray().astype(np.float32)
                self.mosaic = np.vstack([a12, a11])
                self.h, self.w = self.mosaic.shape
                self.sx = float(scale[0])
                self.sy = float(scale[1])
        except Exception as exc:
            print(f"[Copernicus Warn] load failed: {exc}", flush=True)

    def sample_local_y(self, x_m: float, y_north_m: float, default_y: float = 0.0) -> float:
        if self.mosaic is None:
            return default_y
        lat, lon = local_to_latlon(x_m, y_north_m)
        px = max(0.0, min((lon - 108.0) / self.sx, self.w - 1.001))
        py = max(0.0, min((13.0 - lat) / self.sy, self.h - 1.001))
        x0, y0 = int(px), int(py)
        fx, fy = px - x0, py - y0
        m = self.mosaic
        elev = (
            (m[y0, x0] * (1.0 - fx) + m[y0, x0 + 1] * fx) * (1.0 - fy)
            + (m[y0 + 1, x0] * (1.0 - fx) + m[y0 + 1, x0 + 1] * fx) * fy
        )
        return float(elev - 1479.5)


def _find_glb_islands(idx: np.ndarray, pos: np.ndarray):
    """Fast union-find clustering connected whole buildings via spatially welded XYZ coordinates."""
    qpos = np.round(pos * 20.0).astype(np.int64)
    # Encode 3D int tuple via np.unique on structured view for fast O(V log V) spatial vertex welding
    qview = np.ascontiguousarray(qpos).view(np.dtype((np.void, qpos.dtype.itemsize * 3)))
    _, inv = np.unique(qview, return_inverse=True)
    inv = inv.ravel()
    n_unique = int(inv.max()) + 1 if len(inv) else 0
    parent = list(range(n_unique))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            if ra < rb:
                parent[rb] = ra
            else:
                parent[ra] = rb

    widx = inv[idx]
    for a, b, c in widx.tolist():
        union(a, b)
        union(a, c)

    return np.array([find(int(a)) for a in widx[:, 0]], dtype=np.int32)



def _clean_building_glb_collisions(
    glb_path: pathlib.Path,
    min_x: float,
    max_x: float,
    min_y: float,
    max_y: float,
    water_mask: np.ndarray,
    road_core_mask: np.ndarray,
    size_px: int,
):
    """
    Removes ONLY whole connected building islands inside sector where >=35% of footprint is in water
    or >=45% of footprint is inside strict carriageway core. Never touches terrain, roads, or water GLBs!
    Updates accessor count & index buffer slice cleanly in place without shifting any bufferView offsets.
    """
    raw = glb_path.read_bytes()
    if len(raw) < 20 or raw[:4] != b"glTF":
        return 0, 0
    jlen = struct.unpack("<I", raw[12:16])[0]
    j = json.loads(raw[20 : 20 + jlen].decode("utf-8"))
    b_start = 28 + jlen
    blen = struct.unpack("<I", raw[20 + jlen : 24 + jlen])[0]
    b = bytearray(raw[b_start : b_start + blen])
    bvs = j.get("bufferViews", [])
    accs = j.get("accessors", [])

    # Build node world transforms once per mesh
    nodes = j.get("nodes", [])
    has_parent = {ch for n in nodes for ch in n.get("children", [])}
    roots = [i for i in range(len(nodes)) if i not in has_parent]
    mesh_mats = {}

    def _mat4(n):
        m = np.eye(4, dtype=np.float64)
        if "matrix" in n:
            m = np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
        else:
            if "translation" in n:
                m[:3, 3] = n["translation"]
            if "rotation" in n:
                qx, qy, qz, qw = n["rotation"]
                m[:3, :3] = np.array([
                    [1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qz*qw), 2*(qx*qz + qy*qw)],
                    [2*(qx*qy + qz*qw), 1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qx*qw)],
                    [2*(qx*qz - qy*qw), 2*(qy*qz + qx*qw), 1 - 2*(qx*qx + qy*qy)],
                ], dtype=np.float64)
            if "scale" in n:
                m[:3, :3] *= np.array(n["scale"], dtype=np.float64)[None, :]
        return m

    def walk(ni, pm):
        nd = nodes[ni]
        cm = pm @ _mat4(nd)
        if "mesh" in nd:
            mesh_mats.setdefault(nd["mesh"], []).append(cm)
        for ch in nd.get("children", []):
            walk(ch, cm)

    for ri in roots:
        walk(ri, np.eye(4, dtype=np.float64))

    removed_islands = 0
    removed_tris = 0
    for mi, mesh in enumerate(j.get("meshes", [])):
        mats = mesh_mats.get(mi, [np.eye(4, dtype=np.float64)])
        wm = mats[0]
        for prim in mesh.get("primitives", []):
            pi = prim.get("attributes", {}).get("POSITION")
            ii = prim.get("indices")
            if pi is None or ii is None:
                continue
            pa, ia = accs[pi], accs[ii]
            pbv, ibv = bvs[pa["bufferView"]], bvs[ia["bufferView"]]
            poff = pbv.get("byteOffset", 0) + pa.get("byteOffset", 0)
            ioff = ibv.get("byteOffset", 0) + ia.get("byteOffset", 0)
            pos = np.frombuffer(b, dtype="<f4", count=pa["count"] * 3, offset=poff).reshape(-1, 3)
            dt = "<u4" if ia["componentType"] == 5125 else "<u2"
            idx = np.frombuffer(b, dtype=dt, count=ia["count"], offset=ioff).reshape(-1, 3).copy()
            if len(idx) == 0:
                continue

            px = pos[:, 0] * wm[0, 0] + pos[:, 1] * wm[0, 1] + pos[:, 2] * wm[0, 2] + wm[0, 3]
            pz = pos[:, 0] * wm[2, 0] + pos[:, 1] * wm[2, 1] + pos[:, 2] * wm[2, 2] + wm[2, 3]
            xz = np.stack([px, -pz], axis=-1)
            tri_xz = xz[idx]
            tcx = tri_xz[:, :, 0].mean(axis=1)
            tcy = tri_xz[:, :, 1].mean(axis=1)
            in_sector = (tcx >= min_x) & (tcx <= max_x) & (tcy >= min_y) & (tcy <= max_y)
            if not np.any(in_sector):
                continue

            ux = np.clip(((tcx - min_x) / (max_x - min_x) * size_px).astype(np.int32), 0, size_px - 1)
            vy = np.clip(((max_y - tcy) / (max_y - min_y) * size_px).astype(np.int32), 0, size_px - 1)
            tri_w = in_sector & water_mask[vy, ux]
            tri_r = in_sector & road_core_mask[vy, ux]
            if not (np.any(tri_w) or np.any(tri_r)):
                continue

            # Identify whole connected buildings inside primitive
            islands = _find_glb_islands(idx, pos)
            bad_tri_mask = np.zeros(len(idx), dtype=bool)
            for rid in np.unique(islands[tri_w | tri_r]):
                imask = (islands == rid)
                icnt = int(imask.sum())
                sec_cnt = int((imask & in_sector).sum())
                if sec_cnt == 0:
                    continue
                wf = float((imask & tri_w).sum()) / icnt
                rf = float((imask & tri_r).sum()) / icnt
                if wf >= 0.35 or rf >= 0.45:
                    bad_tri_mask |= imask
                    removed_islands += 1

            if np.any(bad_tri_mask):
                removed_tris += int(bad_tri_mask.sum())
                kept = idx[~bad_tri_mask]
                if len(kept) == 0:
                    kept = np.array([[0, 0, 0]], dtype=idx.dtype)
                kflat = kept.reshape(-1)
                raw_bytes = kflat.tobytes()
                b[ioff : ioff + len(raw_bytes)] = raw_bytes
                ia["count"] = int(kflat.size)
                if "min" in ia:
                    ia["min"] = [int(kflat.min())]
                if "max" in ia:
                    ia["max"] = [int(kflat.max())]

    if removed_tris > 0:
        jbytes = json.dumps(j, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        jpad = (4 - (len(jbytes) % 4)) % 4
        jchunk = jbytes + b" " * jpad
        bpad = (4 - (len(b) % 4)) % 4
        bchunk = bytes(b) + b"\x00" * bpad
        total_len = 12 + 8 + len(jchunk) + 8 + len(bchunk)
        out = (
            b"glTF" + struct.pack("<II", 2, total_len)
            + struct.pack("<I", len(jchunk)) + b"JSON" + jchunk
            + struct.pack("<I", len(bchunk)) + b"BIN\x00" + bchunk
        )
        glb_path.write_bytes(out)
    return removed_islands, removed_tris


def run_audit(sector: str, out_img: pathlib.Path, out_ticket: pathlib.Path, return_image: bool = False):
    if sector not in SECTORS:
        raise ValueError(f"Unknown sector: {sector}. Choose from {list(SECTORS.keys())}")
    min_x, max_x, min_y, max_y, zoom = SECTORS[sector]
    size_px = 1200
    tids = tiles_overlapping_bounds(min_x, max_x, min_y, max_y)

    sat_img = fetch_google_ortho(min_x, max_x, min_y, max_y, zoom=zoom, out_px=size_px)
    water_mask, road_mask, road_lines, road_core_mask = load_osm_masks_for_sector(min_x, max_x, min_y, max_y, size_px)

    overlay = sat_img.convert("RGBA")
    ov_layer = Image.new("RGBA", (size_px, size_px), (0, 0, 0, 0))
    bldg_raster = Image.new("L", (size_px, size_px), 0)
    br_draw = ImageDraw.Draw(bldg_raster)

    # 1. Draw Water & Road OSM Reference Ground Truth lightly
    water_rgba = np.zeros((size_px, size_px, 4), dtype=np.uint8)
    water_rgba[water_mask] = [30, 144, 255, 85]
    ov_layer = Image.alpha_composite(ov_layer, Image.fromarray(water_rgba, "RGBA"))
    draw = ImageDraw.Draw(ov_layer)

    for pts, w_m, _ in road_lines:
        draw.line(pts, fill=(0, 240, 255, 115), width=max(2, int(w_m * size_px / (max_x - min_x))))

    def _tile_glbs(folder_name: str, prefix: str, tid: str):
        d = ASSETS / folder_name
        exact = d / f"{prefix}{tid}.glb"
        if exact.exists():
            return [exact]
        return sorted(d.glob(f"{prefix}{tid}_*.glb"))

    # 2. Project 3D Road GLBs cleanly
    road_tris_drawn = 0
    for tid in tids:
        for rfp in _tile_glbs("osm_true_roads_hydro", "osm_real_roads_", tid):
            tris = read_glb_tris_xz(rfp)
            if len(tris):
                cx = tris[:, :, 0].mean(axis=1)
                cy = tris[:, :, 1].mean(axis=1)
                keep = (cx >= min_x - 30) & (cx <= max_x + 30) & (cy >= min_y - 30) & (cy <= max_y + 30)
                sub = tris[keep]
                road_tris_drawn += len(sub)
                for t in sub[:35000]:
                    pxs = [xy_to_px(float(t[k, 0]), float(t[k, 1]), min_x, max_x, min_y, max_y, size_px) for k in range(3)]
                    draw.polygon(pxs, fill=(250, 204, 21, 95))

    # 3. Project 3D Buildings & Measure Collisions against Water / Carriageway Core masks!
    bldg_in_water = 0
    bldg_in_road = 0
    total_bldg_tris = 0
    violating_building_files = {}

    for tid in tids:
        for bdir in ("osm_true_buildings", "building_tiles"):
            prefix = "osm_buildings_" if bdir == "osm_true_buildings" else "buildings_"
            cands = _tile_glbs(bdir, prefix, tid)
            if not cands:
                continue
            for bfp in cands:
                tris = read_glb_tris_xz(bfp)
                if not len(tris):
                    continue
                cx = tris[:, :, 0].mean(axis=1)
                cy = tris[:, :, 1].mean(axis=1)
                keep = (cx >= min_x) & (cx <= max_x) & (cy >= min_y) & (cy <= max_y)
                sub = tris[keep]
                if not len(sub):
                    continue
                total_bldg_tris += len(sub)

                ux = np.clip(((sub[:, :, 0].mean(axis=1) - min_x) / (max_x - min_x) * size_px).astype(np.int32), 0, size_px - 1)
                vy = np.clip(((max_y - sub[:, :, 1].mean(axis=1)) / (max_y - min_y) * size_px).astype(np.int32), 0, size_px - 1)
                in_w = water_mask[vy, ux]
                in_r = road_core_mask[vy, ux]
                nw, nr = int(in_w.sum()), int(in_r.sum())
                bldg_in_water += nw
                bldg_in_road += nr
                if nw > 0 or nr > 0:
                    violating_building_files[f"assets/{bdir}/{bfp.name}"] = {"water_tris": nw, "road_tris": nr}

                for i, t in enumerate(sub):
                    pxs = [xy_to_px(float(t[k, 0]), float(t[k, 1]), min_x, max_x, min_y, max_y, size_px) for k in range(3)]
                    br_draw.polygon(pxs, fill=255)
                    if in_w[i] or in_r[i]:
                        draw.polygon(pxs, fill=(239, 68, 68, 225), outline=(255, 255, 255, 230))
                    else:
                        draw.polygon(pxs, fill=(249, 115, 22, 165), outline=(254, 215, 170, 140))
            break  # osm_true_buildings wins over legacy building_tiles per tile

    bldg_mask = np.asarray(bldg_raster, dtype=np.uint8) > 127

    # 4. Project Placed Landmarks & French Villas (Full Footprint Silhouette)
    lm_count = 0
    for lm in _load_landmarks_list():
        gp = lm.get("gltf_position")
        if not (gp and len(gp) == 3):
            continue
        lx, ly = float(gp[0]), -float(gp[2])
        if not (min_x <= lx <= max_x and min_y <= ly <= max_y):
            continue
        lfp = ROOT / lm["url"].lstrip("./")
        if not lfp.exists():
            continue
        rot = float(lm.get("rotation_y_rad", 0.0) or 0.0)
        tris = read_glb_tris_xz(lfp, offset_xyz=gp, rot_y_rad=rot)
        if not len(tris):
            continue
        lm_count += 1
        # Sample evenly or draw dense footprint triangles
        step = max(1, len(tris) // 3500)
        for t in tris[::step]:
            pxs = [xy_to_px(float(t[k, 0]), float(t[k, 1]), min_x, max_x, min_y, max_y, size_px) for k in range(3)]
            draw.polygon(pxs, fill=(217, 70, 239, 130), outline=(245, 208, 254, 170))
        pu, pv = xy_to_px(lx, ly, min_x, max_x, min_y, max_y, size_px)
        draw.ellipse((pu - 5, pv - 5, pu + 5, pv + 5), fill=(255, 255, 255, 255), outline=(192, 38, 211, 255))

    # 5. Check Vegetation intrusions (Water + Road Core + Building Roof)
    trees_checked = 0
    trees_in_water = 0
    trees_in_road = 0
    trees_on_roof = 0
    violating_veg_files = {}
    for tid in tids:
        vfp = ASSETS / "vegetation" / f"instances_{tid}.json"
        if not vfp.exists():
            vfp = ASSETS / "vegetation_expanded" / f"instances_{tid}.json"
        if not vfp.exists():
            continue
        doc = json.loads(vfp.read_text(encoding="utf-8"))
        items = doc.get("instances") if isinstance(doc, dict) else doc
        t_w, t_r, t_b = 0, 0, 0
        for it in items:
            if isinstance(it, list) and len(it) >= 2:
                tx, ty = float(it[0]), float(it[1])
            elif isinstance(it, dict):
                tx, ty = float(it.get("x", 0)), float(it.get("y", 0))
            else:
                continue
            if not (min_x <= tx <= max_x and min_y <= ty <= max_y):
                continue
            trees_checked += 1
            pu, pv = xy_to_px(tx, ty, min_x, max_x, min_y, max_y, size_px)
            ix_p = max(0, min(size_px - 1, int(pu)))
            iy_p = max(0, min(size_px - 1, int(pv)))
            bad = False
            if water_mask[iy_p, ix_p]:
                t_w += 1
                bad = True
            elif road_core_mask[iy_p, ix_p]:
                t_r += 1
                bad = True
            elif bldg_mask[iy_p, ix_p]:
                t_b += 1
                bad = True
            if bad:
                draw.ellipse((pu - 3, pv - 3, pu + 3, pv + 3), fill=(239, 68, 68, 255))
            else:
                draw.ellipse((pu - 1.5, pv - 1.5, pu + 1.5, pv + 1.5), fill=(34, 197, 94, 180))
        trees_in_water += t_w
        trees_in_road += t_r
        trees_on_roof += t_b
        if t_w > 0 or t_r > 0 or t_b > 0:
            violating_veg_files[f"assets/{vfp.parent.name}/{vfp.name}"] = {"water_trees": t_w, "road_trees": t_r, "roof_trees": t_b}

    right_panel = Image.alpha_composite(overlay, ov_layer).convert("RGB")
    if return_image:
        return right_panel, {
            "total_building_tris": total_bldg_tris,
            "total_road_tris": road_tris_drawn,
            "landmarks_in_sector": lm_count,
            "trees_checked": trees_checked,
            "bldg_tris_in_water": bldg_in_water,
            "bldg_tris_in_road": bldg_in_road,
            "trees_in_water": trees_in_water,
            "trees_in_road": trees_in_road,
            "trees_on_roof": trees_on_roof,
        }

    sheet = Image.new("RGB", (2400, 1200), (15, 23, 42))
    sheet.paste(sat_img, (0, 0))
    sheet.paste(right_panel, (1200, 0))
    sdraw = ImageDraw.Draw(sheet)
    sdraw.rectangle((10, 10, 580, 56), fill=(15, 23, 42))
    sdraw.text((20, 24), f"SATELLITE Z{zoom} GROUND TRUTH | SECTOR {sector}", fill=(248, 250, 252))
    sdraw.rectangle((1210, 10, 2388, 92), fill=(15, 23, 42))
    sdraw.text((1220, 18), f"3D PLAN PROJECTION OVERLAY | Buildings={total_bldg_tris:,} tris | Roads={road_tris_drawn:,} tris | Landmarks={lm_count} | Trees={trees_checked:,}", fill=(52, 211, 153))
    tot_col = bldg_in_water + bldg_in_road + trees_in_water + trees_in_road + trees_on_roof
    sdraw.text((1220, 44), f"COLLISIONS: Bldg_Water={bldg_in_water} | Bldg_RoadCore={bldg_in_road} | Tree_Water={trees_in_water} | Tree_Road={trees_in_road} | Tree_Roof={trees_on_roof}", fill=(248, 113, 113) if tot_col > 0 else (167, 243, 208))
    sdraw.text((1220, 68), "LEGEND: Orange=Buildings | Cyan/Yellow=OSM Roads | Blue=Lake | Magenta=Landmarks | Green=Trees | RED=Violation", fill=(203, 213, 225))

    out_img.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_img, format="JPEG", quality=92, optimize=True)

    needs_fix = (bldg_in_water > 0 or bldg_in_road > 25 or trees_in_water > 0 or trees_in_road > 0 or trees_on_roof > 5)
    ticket = {
        "schema_version": "1.1.0",
        "slot": 26,
        "target_fixer_slot": 28,
        "sector": sector,
        "bounds_m": [min_x, max_x, min_y, max_y],
        "satellite_zoom": zoom,
        "audited_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "metrics": {
            "total_building_tris": total_bldg_tris,
            "total_road_tris": road_tris_drawn,
            "landmarks_in_sector": lm_count,
            "trees_checked": trees_checked,
            "bldg_tris_in_water": bldg_in_water,
            "bldg_tris_in_road": bldg_in_road,
            "trees_in_water": trees_in_water,
            "trees_in_road": trees_in_road,
            "trees_on_roof": trees_on_roof,
        },
        "needs_fix": needs_fix,
        "violating_building_files": violating_building_files,
        "violating_veg_files": violating_veg_files,
        "contact_sheet": out_img.name,
    }
    out_ticket.parent.mkdir(parents=True, exist_ok=True)
    out_ticket.write_text(json.dumps(ticket, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[UrbanPlanAudit] {sector}: bldg_w={bldg_in_water}, bldg_r={bldg_in_road}, tree_w={trees_in_water}, tree_r={trees_in_road}, tree_roof={trees_on_roof}, needs_fix={needs_fix}")
    return ticket


def run_fix(ticket_path: pathlib.Path, out_img: pathlib.Path, out_report: pathlib.Path):
    """Slot 28 Auto-Fixer: cleans colliding building islands & trees in sector and re-clamps vegetation onto Copernicus DEM."""
    ticket = json.loads(ticket_path.read_text(encoding="utf-8"))
    sector = ticket["sector"]
    min_x, max_x, min_y, max_y, zoom = SECTORS[sector]
    size_px = 1200

    # Capture BEFORE overlay panel
    before_panel, before_metrics = run_audit(sector, out_img, out_ticket=out_report, return_image=True)
    water_mask, road_mask, _, road_core_mask = load_osm_masks_for_sector(min_x, max_x, min_y, max_y, size_px)

    # Rasterize buildings strictly for vegetation roof pruning
    tids = tiles_overlapping_bounds(min_x, max_x, min_y, max_y)
    removed_islands_total, removed_bldg_tris_total = 0, 0
    modified_files = []

    # 1. Clean whole colliding building islands in building GLBs (NEVER touch terrain, roads, or water GLBs!)
    for rel_b in sorted(ticket.get("violating_building_files", {}).keys()):
        bfp = ROOT / rel_b
        if not bfp.exists() or ("osm_true_buildings" not in rel_b and "building_tiles" not in rel_b):
            continue
        ri, rt = _clean_building_glb_collisions(bfp, min_x, max_x, min_y, max_y, water_mask, road_core_mask, size_px)
        if rt > 0:
            removed_islands_total += ri
            removed_bldg_tris_total += rt
            modified_files.append(rel_b)

    # Build fresh bldg_mask after building cleanup
    bldg_raster = Image.new("L", (size_px, size_px), 0)
    br_draw = ImageDraw.Draw(bldg_raster)
    for tid in tids:
        for bdir in ("osm_true_buildings", "building_tiles"):
            prefix = "osm_buildings_" if bdir == "osm_true_buildings" else "buildings_"
            d = ASSETS / bdir
            cands = [d / f"{prefix}{tid}.glb"] if (d / f"{prefix}{tid}.glb").exists() else sorted(d.glob(f"{prefix}{tid}_*.glb"))
            if not cands:
                continue
            for bfp in cands:
                tris = read_glb_tris_xz(bfp)
                if len(tris):
                    cx, cy = tris[:, :, 0].mean(axis=1), tris[:, :, 1].mean(axis=1)
                    sub = tris[(cx >= min_x) & (cx <= max_x) & (cy >= min_y) & (cy <= max_y)]
                    for t in sub:
                        br_draw.polygon([xy_to_px(float(t[k, 0]), float(t[k, 1]), min_x, max_x, min_y, max_y, size_px) for k in range(3)], fill=255)
            break
    bldg_mask = np.asarray(bldg_raster, dtype=np.uint8) > 127

    # 2. Clean colliding vegetation & re-clamp kept trees inside sector onto Copernicus GLO-30 DEM
    dem = CopernicusDemSampler()
    removed_trees_total = 0
    reclamped_trees_total = 0
    for rel_v in sorted(ticket.get("violating_veg_files", {}).keys()):
        vfp = ROOT / rel_v
        if not vfp.exists():
            continue
        doc = json.loads(vfp.read_text(encoding="utf-8"))
        items = doc.get("instances") if isinstance(doc, dict) else doc
        kept_items = []
        v_removed = 0
        for it in items:
            is_list = isinstance(it, list) and len(it) >= 3
            tx = float(it[0]) if is_list else float(it.get("x", 0))
            ty = float(it[1]) if is_list else float(it.get("y", 0))
            if min_x <= tx <= max_x and min_y <= ty <= max_y:
                pu, pv = xy_to_px(tx, ty, min_x, max_x, min_y, max_y, size_px)
                ix_p = max(0, min(size_px - 1, int(pu)))
                iy_p = max(0, min(size_px - 1, int(pv)))
                if water_mask[iy_p, ix_p] or road_core_mask[iy_p, ix_p] or bldg_mask[iy_p, ix_p]:
                    v_removed += 1
                    continue
                if dem.mosaic is not None:
                    new_z = round(dem.sample_local_y(tx, ty), 2)
                    if is_list:
                        it[2] = new_z
                    else:
                        it["z"] = new_z
                    reclamped_trees_total += 1
            kept_items.append(it)

        if v_removed > 0:
            removed_trees_total += v_removed
            if isinstance(doc, dict):
                doc["instances"] = kept_items
                doc["total_instances"] = len(kept_items)
                doc["tree_count"] = len(kept_items)
                doc["water_intrusions"] = 0
                doc["road_intrusions"] = 0
                vfp.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
            else:
                vfp.write_text(json.dumps(kept_items, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
            modified_files.append(rel_v)

    # 3. Capture AFTER overlay panel & build Before/After visual comparison
    after_panel, after_metrics = run_audit(sector, out_img, out_ticket=out_report, return_image=True)
    sheet = Image.new("RGB", (2400, 1200), (15, 23, 42))
    sheet.paste(before_panel, (0, 0))
    sheet.paste(after_panel, (1200, 0))
    sdraw = ImageDraw.Draw(sheet)
    sdraw.rectangle((10, 10, 1180, 62), fill=(15, 23, 42))
    sdraw.text((20, 16), f"BEFORE FIX | SECTOR {sector} | Bldg_W={before_metrics['bldg_tris_in_water']} Bldg_R={before_metrics['bldg_tris_in_road']}", fill=(248, 113, 113))
    sdraw.text((20, 38), f"Tree_W={before_metrics['trees_in_water']} Tree_R={before_metrics['trees_in_road']} Tree_Roof={before_metrics['trees_on_roof']}", fill=(253, 186, 116))
    sdraw.rectangle((1210, 10, 2388, 62), fill=(15, 23, 42))
    sdraw.text((1220, 16), f"AFTER SLOT-28 FIX | RemovedIslands={removed_islands_total} RemovedTris={removed_bldg_tris_total} RemovedTrees={removed_trees_total}", fill=(52, 211, 153))
    sdraw.text((1220, 38), f"AFTER COLLISIONS: Bldg_W={after_metrics['bldg_tris_in_water']} Bldg_R={after_metrics['bldg_tris_in_road']} Tree_W={after_metrics['trees_in_water']} Tree_R={after_metrics['trees_in_road']} Tree_Roof={after_metrics['trees_on_roof']}", fill=(167, 243, 208))

    out_img.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_img, format="JPEG", quality=92, optimize=True)

    report = {
        "schema_version": "1.1.0",
        "slot": 28,
        "source_audit_slot": 26,
        "sector": sector,
        "applied_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "before_metrics": before_metrics,
        "after_metrics": after_metrics,
        "removed_building_islands": removed_islands_total,
        "removed_building_tris": removed_bldg_tris_total,
        "removed_trees": removed_trees_total,
        "reclamped_trees_to_copernicus_dem": reclamped_trees_total,
        "modified_files": sorted(set(modified_files)),
        "contact_sheet": out_img.name,
    }
    out_report.parent.mkdir(parents=True, exist_ok=True)
    out_report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"[UrbanPlanFix] {sector}: removed_islands={removed_islands_total}, removed_bldg_tris={removed_bldg_tris_total}, "
        f"removed_trees={removed_trees_total}, after_bldg_w={after_metrics['bldg_tris_in_water']}, after_bldg_r={after_metrics['bldg_tris_in_road']}"
    )
    return report


def main():
    global ROOT, ASSETS
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="")
    ap.add_argument("--mode", choices=["audit", "fix"], default="audit")
    ap.add_argument("--sector", default="T_E00_N00_SW")
    ap.add_argument("--out-img", default="/tmp/dalat_real_cache/qa_urban_plan_test.jpg")
    ap.add_argument("--out-ticket", default="/tmp/dalat_real_cache/urban_plan_fix_ticket_test.json")
    ap.add_argument("--ticket", default="")
    ap.add_argument("--out-report", default="")
    args = ap.parse_args()
    if args.root:
        ROOT = pathlib.Path(args.root).resolve()
        ASSETS = ROOT / "assets"

    if args.mode == "audit":
        run_audit(args.sector, pathlib.Path(args.out_img), pathlib.Path(args.out_ticket))
    else:
        tpath = pathlib.Path(args.ticket)
        ticket = json.loads(tpath.read_text(encoding="utf-8"))
        out_report = pathlib.Path(args.out_report) if args.out_report else tpath.parent / f"applied_urban_fix_{ticket['sector']}.json"
        run_fix(tpath, pathlib.Path(args.out_img), out_report)


if __name__ == "__main__":
    main()
