#!/usr/bin/env python3
"""
upgrade_roads_traffic_props.py
============================================================================
Nâng cấp toàn diện giao thông, mặt đường PBR & tiện ích đường phố trên chuẩn
ESA Copernicus GLO-30 DEM + OpenStreetMap API v0.6 thật của Đà Lạt:

  1. Tái tạo 9 tệp đường bộ RING_0 (`assets/osm_true_roads_hydro/osm_real_roads_T_*.glb`)
     với Texture PBR nhúng sẵn + Normal Map hạt nhựa nóng / đá granite vỉa hè / taluy
     (`wrapS=REPEAT, wrapT=REPEAT`), vạch kẻ vàng/trắng đứt đoạn chuẩn làn xe và
     **vạch ngựa vằn đi bộ (Zebra Crosswalks)** tại các nút giao thông lớn.
  2. Xuất tuyến đường giao thông thật (`api/road-traffic-routes.json`, ~180 KB)
     nối liền mạch các trục arterial/primary/secondary/tertiary bám đúng mặt đường
     Copernicus DEM cho bộ phát giao thông chuyển động `DalatTrafficStreamer`.
  3. Hiệu chỉnh cao độ từng cụm chi tiết (Union-Find 2D XZ) cho toàn bộ thư viện
     `assets/urban_life_props/*.glb` (đèn 5 bóng, xe cổ, xe buýt Phương Trang,
     chợ Đêm, vòm hoa, thuyền vịt) khớp khít 100% mặt đất / mặt đường Copernicus DEM
     (và loại bỏ cụm rơi xuống mặt hồ).
"""

import io
import json
import math
import pathlib
import struct
import sys
import time
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
API_DIR = ROOT / "api"
CACHE = pathlib.Path("/tmp/dalat_real_cache")
sys.path.insert(0, str(ROOT / "scripts"))

from rebuild_real_dalat_core import (
    TILE_SIZE_M,
    HALF_TILE_M,
    CopernicusGlo30Mosaic,
    RealDalatDem,
    MeshBatcher,
    ROAD_CLASS_SPECS,
    compute_vertex_normals,
    densify_xy,
    format_tile_id,
    _pad4,
)


# ============================================================================
# 1. EMBEDDED TILEABLE PBR ROAD / SIDEWALK / TALUY TEXTURES + NORMAL MAPS
# ============================================================================
def _load_or_synth_pbr_rgb(pbr_name: str, fallback_rgb: tuple, size: int = 256) -> np.ndarray:
    fp = ASSETS / "pbr" / pbr_name
    if fp.exists():
        im = Image.open(fp).convert("RGB").resize((size, size), Image.Resampling.LANCZOS)
        return np.asarray(im, dtype=np.float32)
    rng = np.random.default_rng(42)
    base = np.full((size, size, 3), fallback_rgb, dtype=np.float32)
    noise = rng.normal(0.0, 12.0, (size, size, 1)).astype(np.float32)
    return np.clip(base + noise, 0, 255)


def _encode_png(arr_uint8: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr_uint8, mode="RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _encode_jpg(arr_uint8: np.ndarray, quality: int = 86) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr_uint8, mode="RGB").save(buf, format="JPEG", quality=quality, subsampling=1)
    return buf.getvalue()


def _height_to_normal_rgb(height: np.ndarray, strength: float = 2.4) -> np.ndarray:
    h = height.astype(np.float32)
    gx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5 * strength
    gy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5 * strength
    nx, ny, nz = -gx, -gy, np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-8
    rgb = np.stack([
        (nx / ln * 0.5 + 0.5) * 255.0,
        (ny / ln * 0.5 + 0.5) * 255.0,
        (nz / ln * 0.5 + 0.5) * 255.0,
    ], axis=-1)
    return np.clip(rgb, 0, 255).astype(np.uint8)


def build_embedded_road_textures() -> list:
    """Return list of (bytes, mimeType) textures matching PBR road materials."""
    size = 256
    rng = np.random.default_rng(1893)

    # 0 & 1: Hot-mix highland asphalt diffuse & normal (crisp aggregate + gentle tire tracks along U)
    asp_alb = _load_or_synth_pbr_rgb("road_asphalt_albedo.jpg", (76, 80, 88), size)
    # Normalize & lift dynamic range so baseColorFactor shows crisp texture grain (not crushed black)
    lum = asp_alb.mean(axis=2, keepdims=True)
    asp_normed = 82.0 + (asp_alb - lum.mean()) * 1.45 + rng.normal(0.0, 5.5, (size, size, 1))
    # Subtle lane wheel polish bands along V (rows 0..size-1 correspond to cross-road V)
    yy = np.linspace(0.0, 1.0, size, dtype=np.float32)[:, None, None]
    wear = (
        np.exp(-((yy - 0.28) ** 2) / 0.008) + np.exp(-((yy - 0.72) ** 2) / 0.008)
    ) * 10.0
    asp_final = np.clip(asp_normed - wear + rng.normal(0.0, 2.0, (size, size, 3)), 36, 155).astype(np.uint8)
    asp_nrm = _load_or_synth_pbr_rgb("road_asphalt_normal.jpg", (128, 128, 255), size).astype(np.uint8)

    # 2 & 3: Dalat sidewalk granite/terrazzo square paver grid (4x4 beveled tiles + subtle moss joint)
    pav_raw = _load_or_synth_pbr_rgb("granite_paver_albedo.jpg", (142, 140, 134), size)
    pav_gray = pav_raw.mean(axis=2, keepdims=True)
    pav_base = pav_gray * 0.72 + pav_raw * 0.28
    pav_h = np.full((size, size), 0.78, dtype=np.float32)
    step = size // 4
    grout = np.zeros((size, size), dtype=bool)
    for k in range(0, size, step):
        grout[k : k + 3, :] = True
        grout[:, k : k + 3] = True
    # Natural monochrome stone brightness variation per tile (zero RGB rainbow tint!)
    tile_tint = np.ones((size, size, 1), dtype=np.float32)
    for r in range(4):
        for c in range(4):
            jitter = float(rng.uniform(0.91, 1.09))
            tile_tint[r * step : (r + 1) * step, c * step : (c + 1) * step, 0] = jitter
    pav_alb = pav_base * tile_tint
    pav_alb = 114.0 + (pav_alb - pav_alb.mean()) * 0.85
    pav_alb[grout] *= 0.56
    pav_h[grout] = 0.25
    pav_h += (pav_base.mean(axis=2) / 255.0 - 0.5) * 0.22
    pav_alb_u8 = np.clip(pav_alb, 46, 188).astype(np.uint8)
    pav_nrm_u8 = _height_to_normal_rgb(pav_h, strength=2.6)

    # 4 & 5: Split granite taluy stone masonry wall (neutral weathered highland basalt/granite)
    tal_raw = _load_or_synth_pbr_rgb("stone_masonry_albedo.jpg", (92, 95, 98), size)
    tal_gray = tal_raw.mean(axis=2, keepdims=True)
    tal_alb = tal_gray * 0.75 + tal_raw * 0.25
    tal_alb_u8 = np.clip(90.0 + (tal_alb - tal_alb.mean()) * 1.05, 38, 168).astype(np.uint8)
    tal_nrm_u8 = _load_or_synth_pbr_rgb("stone_masonry_normal.jpg", (128, 128, 255), size).astype(np.uint8)

    # 6: Cut granite curbstone (longitudinal cut blocks every 1/3 U)
    curb = pav_base.copy()
    curb = 124.0 + (curb - curb.mean()) * 1.1
    for cx in (0, size // 3, (2 * size) // 3):
        curb[:, cx : cx + 3, :] *= 0.52
    curb_u8 = np.clip(curb, 48, 200).astype(np.uint8)

    return [
        (_encode_jpg(asp_final, 88), "image/jpeg"),   # 0: asphalt albedo
        (_encode_png(asp_nrm), "image/png"),          # 1: asphalt normal
        (_encode_jpg(pav_alb_u8, 88), "image/jpeg"),  # 2: sidewalk paver albedo
        (_encode_png(pav_nrm_u8), "image/png"),       # 3: sidewalk paver normal
        (_encode_jpg(tal_alb_u8, 86), "image/jpeg"),  # 4: taluy stone albedo
        (_encode_png(tal_nrm_u8), "image/png"),       # 5: taluy stone normal
        (_encode_jpg(curb_u8, 86), "image/jpeg"),     # 6: curb & bridge concrete
    ]


def write_road_glb_repeat(out_path: pathlib.Path, primitives_by_node: list, materials: list, images: list) -> int:
    """Export GLB with REPEAT wrapping sampler (10497) so embedded road/paver textures tile sharply per meter."""
    bin_chunks = []
    buffer_views = []
    accessors = []
    meshes = []
    nodes = []
    offset = 0

    def add_bv(raw: bytes, target=None) -> int:
        nonlocal offset
        idx = len(buffer_views)
        bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(raw)}
        if target is not None:
            bv["target"] = target
        buffer_views.append(bv)
        padded = _pad4(raw)
        bin_chunks.append(padded)
        offset += len(padded)
        return idx

    gltf_samplers = [{
        "magFilter": 9729,   # LINEAR
        "minFilter": 9987,   # LINEAR_MIPMAP_LINEAR
        "wrapS": 10497,      # REPEAT
        "wrapT": 10497,      # REPEAT
    }]
    gltf_images = []
    gltf_textures = []
    for img_bytes, mime in images:
        bv_i = add_bv(img_bytes, None)
        img_idx = len(gltf_images)
        gltf_images.append({"bufferView": bv_i, "mimeType": mime})
        gltf_textures.append({"sampler": 0, "source": img_idx})

    for rec in primitives_by_node:
        pos = np.ascontiguousarray(rec["positions"], dtype="<f4")
        nrm = np.ascontiguousarray(rec["normals"], dtype="<f4")
        idx_arr = np.ascontiguousarray(rec["indices"], dtype="<u4")
        if len(pos) == 0 or len(idx_arr) == 0:
            continue

        attrs = {}
        bv_p = add_bv(pos.tobytes(), 34962)
        acc_p = len(accessors)
        accessors.append({
            "bufferView": bv_p,
            "componentType": 5126,
            "count": int(len(pos)),
            "type": "VEC3",
            "min": [float(x) for x in pos.min(axis=0)],
            "max": [float(x) for x in pos.max(axis=0)],
        })
        attrs["POSITION"] = acc_p

        bv_n = add_bv(nrm.tobytes(), 34962)
        acc_n = len(accessors)
        accessors.append({
            "bufferView": bv_n,
            "componentType": 5126,
            "count": int(len(nrm)),
            "type": "VEC3",
        })
        attrs["NORMAL"] = acc_n

        if rec.get("uvs") is not None:
            uvs = np.ascontiguousarray(rec["uvs"], dtype="<f4")
            bv_u = add_bv(uvs.tobytes(), 34962)
            acc_u = len(accessors)
            accessors.append({
                "bufferView": bv_u,
                "componentType": 5126,
                "count": int(len(uvs)),
                "type": "VEC2",
            })
            attrs["TEXCOORD_0"] = acc_u

        bv_i = add_bv(idx_arr.tobytes(), 34963)
        acc_i = len(accessors)
        accessors.append({
            "bufferView": bv_i,
            "componentType": 5125,
            "count": int(len(idx_arr)),
            "type": "SCALAR",
            "min": [int(idx_arr.min())],
            "max": [int(idx_arr.max())],
        })
        mi = len(meshes)
        meshes.append({
            "name": rec["name"],
            "primitives": [{"attributes": attrs, "indices": acc_i, "material": rec["material"]}],
        })
        nodes.append({"name": rec["name"], "mesh": mi})

    bin_blob = b"".join(bin_chunks)
    gltf = {
        "asset": {"version": "2.0", "generator": "Dalat3D-TexturedRoads/3.0"},
        "scene": 0,
        "scenes": [{"name": out_path.stem, "nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(bin_blob)}],
        "images": gltf_images,
        "textures": gltf_textures,
        "samplers": gltf_samplers,
    }
    json_bytes = _pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_blob)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(
        struct.pack("<4sII", b"glTF", 2, total_len)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A)
        + json_bytes
        + struct.pack("<II", len(bin_blob), 0x004E4942)
        + bin_blob
    )
    return out_path.stat().st_size


def add_dashed_strip(batch: MeshBatcher, pts_xyz, right_xy, half_w: float, dy: float, dash_m: float = 3.2, gap_m: float = 3.6):
    """Emit discrete non-overlapping centerline dashes along polyline points without continuous ribbon Z-fighting."""
    if len(pts_xyz) < 2:
        return
    # Resample closely (~0.6m) or walk piecewise linearly along pts_xyz
    seg_s = [0.0]
    for i in range(1, len(pts_xyz)):
        dx = pts_xyz[i][0] - pts_xyz[i - 1][0]
        dz = pts_xyz[i][2] - pts_xyz[i - 1][2]
        seg_s.append(seg_s[-1] + math.hypot(dx, dz))
    total = seg_s[-1]
    if total < dash_m + 1.0:
        return

    def sample_at(s_target: float):
        # binary/linear scan
        for i in range(len(seg_s) - 1):
            if seg_s[i] <= s_target <= seg_s[i + 1] + 1e-6:
                span = max(1e-6, seg_s[i + 1] - seg_s[i])
                t = max(0.0, min(1.0, (s_target - seg_s[i]) / span))
                p0, p1 = pts_xyz[i], pts_xyz[i + 1]
                r0, r1 = right_xy[i], right_xy[i + 1]
                x = p0[0] + (p1[0] - p0[0]) * t
                y = p0[1] + (p1[1] - p0[1]) * t
                yn = p0[2] + (p1[2] - p0[2]) * t
                rx = r0[0] + (r1[0] - r0[0]) * t
                ry = r0[1] + (r1[1] - r0[1]) * t
                ln = math.hypot(rx, ry) + 1e-8
                return (x, y, yn), (rx / ln, ry / ln)
        return pts_xyz[-1], right_xy[-1]

    period = dash_m + gap_m
    s = 1.5
    while s + dash_m < total - 1.5:
        p_a, r_a = sample_at(s)
        p_b, r_b = sample_at(s + dash_m)
        batch.add_ribbon([p_a, p_b], [r_a, r_b], [(-half_w, dy, 0.0), (half_w, dy, 1.0)], uv_u_scale=3.0)
        s += period


def add_crosswalk_at(batch: MeshBatcher, pos_xyz, tangent_xy, road_half_w: float, dy: float = 0.088):
    """Emit crisp white pedestrian zebra crosswalk bars orthogonal to road tangent."""
    tx, ty = tangent_xy
    rx, ry = ty, -tx  # right-hand lateral vector
    cx, cy, cyn = pos_xyz
    zebra_span = max(1.8, road_half_w - 0.75)
    bar_len = 2.6  # crosswalk walking belt length along road axis
    bar_step = 0.86
    bar_half_w = 0.22
    lat = -zebra_span + 0.45
    while lat <= zebra_span - 0.45:
        bx = cx + rx * lat
        byn = cyn + ry * lat
        p0 = (bx - tx * (bar_len * 0.5), cy, byn - ty * (bar_len * 0.5))
        p1 = (bx + tx * (bar_len * 0.5), cy, byn + ty * (bar_len * 0.5))
        batch.add_ribbon([p0, p1], [(rx, ry), (rx, ry)], [(-bar_half_w, dy, 0.0), (bar_half_w, dy, 1.0)], uv_u_scale=2.0)
        lat += bar_step


def rebuild_textured_pbr_roads(osm_data: dict, dem: RealDalatDem):
    """Rebuild all 9 RING_0 road GLBs with real PBR asphalt/paver/taluy textures, dashed markings & crosswalks."""
    roads = osm_data.get("roads", [])
    railways = osm_data.get("railways", [])
    textures = build_embedded_road_textures()

    # Materials with embedded textures + bright baseColorFactor so textures pop cleanly
    road_materials = [
        {
            "name": "Mat_Asphalt_HotMix_Arterial",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "baseColorFactor": [0.92, 0.94, 0.98, 1.0],
                "roughnessFactor": 0.76,
                "metallicFactor": 0.04,
            },
            "normalTexture": {"index": 1, "scale": 1.1},
            "doubleSided": True,
        },
        {
            "name": "Mat_Asphalt_Hillside_Street",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "baseColorFactor": [0.98, 0.98, 1.0, 1.0],
                "roughnessFactor": 0.82,
                "metallicFactor": 0.03,
            },
            "normalTexture": {"index": 1, "scale": 0.9},
            "doubleSided": True,
        },
        {
            "name": "Mat_Granite_Curbstone",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 6},
                "baseColorFactor": [0.76, 0.78, 0.82, 1.0],
                "roughnessFactor": 0.72,
                "metallicFactor": 0.04,
            },
            "normalTexture": {"index": 3, "scale": 0.75},
            "doubleSided": True,
        },
        {
            "name": "Mat_Sidewalk_Terrazzo_Paver",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 2},
                "baseColorFactor": [0.80, 0.78, 0.75, 1.0],
                "roughnessFactor": 0.78,
                "metallicFactor": 0.02,
            },
            "normalTexture": {"index": 3, "scale": 0.95},
            "doubleSided": True,
        },
        {
            "name": "Mat_Dalat_SplitGranite_Taluy",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 4},
                "baseColorFactor": [0.85, 0.86, 0.88, 1.0],
                "roughnessFactor": 0.88,
                "metallicFactor": 0.03,
            },
            "normalTexture": {"index": 5, "scale": 1.15},
            "doubleSided": True,
        },
        {
            "name": "Mat_Thermoplastic_Yellow",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.98, 0.68, 0.04, 1.0],
                "roughnessFactor": 0.44,
                "metallicFactor": 0.02,
            },
            "doubleSided": True,
        },
        {
            "name": "Mat_Thermoplastic_White",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.92, 0.94, 0.96, 1.0],
                "roughnessFactor": 0.46,
                "metallicFactor": 0.02,
            },
            "doubleSided": True,
        },
        {
            "name": "Mat_Bridge_Concrete_Deck",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 6},
                "baseColorFactor": [0.78, 0.80, 0.83, 1.0],
                "roughnessFactor": 0.76,
                "metallicFactor": 0.05,
            },
            "doubleSided": True,
        },
    ]

    # Identify major junctions (degree >= 3 among tier <= 2 ways) for Pedestrian Crosswalks
    node_degree = defaultdict(int)
    for rd in roads:
        hw = rd["highway"]
        if hw not in ROAD_CLASS_SPECS or rd.get("tunnel") in ("yes", "building_passage") or rd.get("area") == "yes":
            continue
        tier = ROAD_CLASS_SPECS[hw][0]
        if tier > 2 or len(rd["pts"]) < 2:
            continue
        for p in rd["pts"]:
            key = (round(p[0], 1), round(p[1], 1))
            node_degree[key] += 1
    major_junctions = {k for k, v in node_degree.items() if v >= 3}

    # Build fast road elevation grid (1500x1500 @ 4m/px over [-3000..+3000]m) & boolean road mask
    road_grid_n = 1500
    road_grid_res = 6000.0 / road_grid_n
    road_elev_grid = np.full((road_grid_n, road_grid_n), np.nan, dtype=np.float32)

    tile_batchers = {format_tile_id(ix, iy): [MeshBatcher() for _ in range(8)] for iy in (-1, 0, 1) for ix in (-1, 0, 1)}
    used_roads = 0
    crosswalk_count = 0

    for rd in roads:
        hw = rd["highway"]
        if hw not in ROAD_CLASS_SPECS:
            continue
        if rd.get("tunnel") in ("yes", "building_passage") or rd.get("area") == "yes":
            continue
        tier, base_w, sw_w, has_yellow, has_white = ROAD_CLASS_SPECS[hw]
        raw_pts = [(p[0], p[1]) for p in rd["pts"]]
        if len(raw_pts) < 2:
            continue

        length = sum(math.hypot(raw_pts[i][0] - raw_pts[i - 1][0], raw_pts[i][1] - raw_pts[i - 1][1]) for i in range(1, len(raw_pts)))
        if tier == 3 and length < 35.0:
            continue
        mid_x = 0.5 * (min(p[0] for p in raw_pts) + max(p[0] for p in raw_pts))
        mid_y = 0.5 * (min(p[1] for p in raw_pts) + max(p[1] for p in raw_pts))
        if abs(mid_x) > 3000.0 or abs(mid_y) > 3000.0:
            continue
        if tier == 4 and (abs(mid_x) > 1050.0 or abs(mid_y) > 1050.0 or length < 20.0):
            continue

        tix = max(-1, min(1, int(math.floor((mid_x + HALF_TILE_M) / TILE_SIZE_M))))
        tiy = max(-1, min(1, int(math.floor((mid_y + HALF_TILE_M) / TILE_SIZE_M))))
        tid = format_tile_id(tix, tiy)

        is_bridge = bool(rd.get("bridge"))
        in_water_pts = sum(1 for p in raw_pts if dem.is_in_water_scalar(p[0], p[1], pad_m=-2.0))
        if in_water_pts > 0 and not is_bridge:
            if in_water_pts >= max(2, int(0.45 * len(raw_pts))):
                continue

        lanes = rd.get("lanes") or 0
        width_m = max(base_w, float(lanes) * 3.3) if lanes else base_w
        hw_half = width_m * 0.5

        pts_2d = densify_xy(raw_pts, max_step_m=7.5)
        n = len(pts_2d)
        if n < 2:
            continue

        right_xy = []
        for i in range(n):
            p0, p1 = pts_2d[max(0, i - 1)], pts_2d[min(n - 1, i + 1)]
            dx, dy = p1[0] - p0[0], p1[1] - p0[1]
            ln = math.hypot(dx, dy) + 1e-8
            right_xy.append((dy / ln, -dx / ln))

        xs_c = np.array([p[0] for p in pts_2d], dtype=np.float64)
        ys_c = np.array([p[1] for p in pts_2d], dtype=np.float64)
        rxs = np.array([r[0] for r in right_xy], dtype=np.float64)
        rys = np.array([r[1] for r in right_xy], dtype=np.float64)

        zc = dem.sample_local_y_np(xs_c, ys_c)
        zl = dem.sample_local_y_np(xs_c - rxs * hw_half, ys_c - rys * hw_half)
        zr = dem.sample_local_y_np(xs_c + rxs * hw_half, ys_c + rys * hw_half)

        tier_lift = {1: 0.25, 2: 0.20, 3: 0.16, 4: 0.12}[tier]
        z_surf = np.maximum(zc, 0.5 * (zc + np.maximum(zl, zr))) + tier_lift

        if not is_bridge:
            near_hxh = np.array([dem.is_in_water_scalar(float(xs_c[i]), float(ys_c[i]), pad_m=6.0) for i in range(n)])
            if np.any(near_hxh):
                z_surf = np.where(near_hxh, np.maximum(z_surf, 1.05), z_surf)
        else:
            z0, z1 = max(float(z_surf[0]), 1.65), max(float(z_surf[-1]), 1.65)
            t_arr = np.linspace(0.0, 1.0, n, dtype=np.float32)
            z_bridge = z0 * (1.0 - t_arr) + z1 * t_arr + 0.35 * np.sin(t_arr * math.pi)
            z_surf = np.maximum(z_bridge, zc + 0.6)

        if n >= 4 and not is_bridge:
            z_sm = z_surf.copy()
            z_sm[1:-1] = 0.25 * z_surf[:-2] + 0.50 * z_surf[1:-1] + 0.25 * z_surf[2:]
            z_surf = np.maximum(z_sm, zc + tier_lift * 0.7)

        # Stamp road deck elevation onto road_elev_grid for props clamping
        for i in range(n):
            val = float(z_surf[i]) + 0.05
            for off in (-hw_half * 0.6, 0.0, hw_half * 0.6):
                gx = xs_c[i] + rxs[i] * off
                gy = ys_c[i] + rys[i] * off
                gc = int((gx + 3000.0) / road_grid_res)
                gr = int((3000.0 - gy) / road_grid_res)
                if 0 <= gc < road_grid_n and 0 <= gr < road_grid_n:
                    cur = road_elev_grid[gr, gc]
                    if np.isnan(cur) or val > cur:
                        road_elev_grid[gr, gc] = val

        center_xyz = [(float(xs_c[i]), float(z_surf[i]), float(ys_c[i])) for i in range(n)]
        batches = tile_batchers[tid]

        if tier == 4:
            batches[3].add_ribbon(center_xyz, right_xy, [(-hw_half, 0.0, 0.0), (hw_half, 0.0, 1.0)], uv_u_scale=3.2)
            batches[4].add_ribbon(center_xyz, right_xy, [(-hw_half - 0.6, -1.2, 0.0), (-hw_half, 0.0, 0.5)], uv_u_scale=3.2)
            batches[4].add_ribbon(center_xyz, right_xy, [(hw_half, 0.0, 0.0), (hw_half + 0.6, -1.2, 0.5)], uv_u_scale=3.2)
        else:
            asphalt_mat = 0 if tier == 1 else 1
            batches[asphalt_mat].add_ribbon(
                center_xyz, right_xy,
                [(-hw_half, 0.0, 0.0), (0.0, 0.05, 0.5), (hw_half, 0.0, 1.0)],
                uv_u_scale=4.5,
            )

            # Crisp dashed centerlines & clean interior white edge stripes (ZERO curb clipping!)
            if not is_bridge:
                if tier == 1 and width_m >= 10.5:
                    # Dashed bright yellow centerline + subtle white edge lines safely inside shoulder
                    add_dashed_strip(batches[5], center_xyz, right_xy, half_w=0.12, dy=0.085, dash_m=3.6, gap_m=3.6)
                    ew = hw_half - 0.55
                    batches[6].add_ribbon(center_xyz, right_xy, [(-ew - 0.12, 0.055, 0.0), (-ew, 0.055, 1.0)], uv_u_scale=4.0)
                    batches[6].add_ribbon(center_xyz, right_xy, [(ew, 0.055, 0.0), (ew + 0.12, 0.055, 1.0)], uv_u_scale=4.0)
                elif tier <= 2 and width_m >= 5.6:
                    # Crisp dashed yellow or white lane markings on secondary / tertiary / residential roads
                    mark_idx = 5 if has_yellow else 6
                    add_dashed_strip(batches[mark_idx], center_xyz, right_xy, half_w=0.10, dy=0.082, dash_m=2.8, gap_m=4.2)

                # Emit pedestrian zebra crosswalks near major road junctions (ways >= 22m long)
                if tier <= 2 and width_m >= 6.8 and length >= 22.0:
                    start_k = (round(raw_pts[0][0], 1), round(raw_pts[0][1], 1))
                    end_k = (round(raw_pts[-1][0], 1), round(raw_pts[-1][1], 1))
                    if start_k in major_junctions and n >= 3:
                        p0, p1 = center_xyz[0], center_xyz[1]
                        dx, dyn = p1[0] - p0[0], p1[2] - p0[2]
                        ln = math.hypot(dx, dyn) + 1e-8
                        tx, ty = dx / ln, dyn / ln
                        step_d = min(5.2, ln * 0.6)
                        px, py, pyn = p0[0] + tx * step_d, p0[1] + (p1[1] - p0[1]) * (step_d / ln), p0[2] + ty * step_d
                        add_crosswalk_at(batches[6], (px, py, pyn), (tx, ty), hw_half, dy=0.084)
                        crosswalk_count += 1
                    if end_k in major_junctions and n >= 3:
                        p0, p1 = center_xyz[-1], center_xyz[-2]
                        dx, dyn = p1[0] - p0[0], p1[2] - p0[2]
                        ln = math.hypot(dx, dyn) + 1e-8
                        tx, ty = dx / ln, dyn / ln
                        step_d = min(5.2, ln * 0.6)
                        px, py, pyn = p0[0] + tx * step_d, p0[1] + (p1[1] - p0[1]) * (step_d / ln), p0[2] + ty * step_d
                        add_crosswalk_at(batches[6], (px, py, pyn), (tx, ty), hw_half, dy=0.084)
                        crosswalk_count += 1

            if is_bridge:
                p_in, p_out = hw_half + 0.1, hw_half + 0.55
                batches[7].add_ribbon(center_xyz, right_xy, [(-p_out, -0.8, 0.0), (-p_out, 1.05, 0.5), (-p_in, 1.05, 0.7), (-p_in, 0.0, 1.0)], uv_u_scale=3.0)
                batches[7].add_ribbon(center_xyz, right_xy, [(p_in, 0.0, 0.0), (p_in, 1.05, 0.3), (p_out, 1.05, 0.5), (p_out, -0.8, 1.0)], uv_u_scale=3.0)
            else:
                curb_w = 0.25
                if sw_w > 0.0:
                    batches[2].add_ribbon(center_xyz, right_xy, [(-hw_half - curb_w, 0.17, 0.0), (-hw_half, 0.17, 0.5), (-hw_half, 0.0, 1.0)], uv_u_scale=2.5)
                    batches[2].add_ribbon(center_xyz, right_xy, [(hw_half, 0.0, 0.0), (hw_half, 0.17, 0.5), (hw_half + curb_w, 0.17, 1.0)], uv_u_scale=2.5)
                    outer_e = hw_half + curb_w + sw_w
                    batches[3].add_ribbon(center_xyz, right_xy, [(-outer_e, 0.15, 0.0), (-hw_half - curb_w, 0.17, 1.0)], uv_u_scale=3.0)
                    batches[3].add_ribbon(center_xyz, right_xy, [(hw_half + curb_w, 0.17, 0.0), (outer_e, 0.15, 1.0)], uv_u_scale=3.0)
                else:
                    outer_e = hw_half
                skirt_drop = -3.4 if tier == 1 else -2.6
                batches[4].add_ribbon(center_xyz, right_xy, [(-outer_e - 1.2, skirt_drop, 0.0), (-outer_e, 0.13 if sw_w > 0 else 0.0, 1.0)], uv_u_scale=3.5)
                batches[4].add_ribbon(center_xyz, right_xy, [(outer_e, 0.13 if sw_w > 0 else 0.0, 0.0), (outer_e + 1.2, skirt_drop, 1.0)], uv_u_scale=3.5)

        used_roads += 1

    # Add Dalat-Trai Mat Historic Railway
    for rw in railways:
        raw_pts = [(p[0], p[1]) for p in rw["pts"]]
        if len(raw_pts) < 2:
            continue
        mid_x = 0.5 * (min(p[0] for p in raw_pts) + max(p[0] for p in raw_pts))
        mid_y = 0.5 * (min(p[1] for p in raw_pts) + max(p[1] for p in raw_pts))
        if abs(mid_x) > 3000.0 or abs(mid_y) > 3000.0:
            continue
        tix = max(-1, min(1, int(math.floor((mid_x + HALF_TILE_M) / TILE_SIZE_M))))
        tiy = max(-1, min(1, int(math.floor((mid_y + HALF_TILE_M) / TILE_SIZE_M))))
        tid = format_tile_id(tix, tiy)
        pts_2d = densify_xy(raw_pts, max_step_m=8.0)
        n = len(pts_2d)
        right_xy = []
        for i in range(n):
            p0, p1 = pts_2d[max(0, i - 1)], pts_2d[min(n - 1, i + 1)]
            dx, dy = p1[0] - p0[0], p1[1] - p0[1]
            ln = math.hypot(dx, dy) + 1e-8
            right_xy.append((dy / ln, -dx / ln))
        xs_c = np.array([p[0] for p in pts_2d], dtype=np.float64)
        ys_c = np.array([p[1] for p in pts_2d], dtype=np.float64)
        zc = dem.sample_local_y_np(xs_c, ys_c) + 0.22
        center_xyz = [(float(xs_c[i]), float(zc[i]), float(ys_c[i])) for i in range(n)]
        batches = tile_batchers[tid]
        batches[4].add_ribbon(center_xyz, right_xy, [(-2.6, -1.6, 0.0), (-1.8, 0.0, 0.3), (1.8, 0.0, 0.7), (2.6, -1.6, 1.0)], uv_u_scale=3.5)
        batches[7].add_ribbon(center_xyz, right_xy, [(-0.62, 0.14, 0.0), (-0.48, 0.14, 1.0)], uv_u_scale=2.0)
        batches[7].add_ribbon(center_xyz, right_xy, [(0.48, 0.14, 0.0), (0.62, 0.14, 1.0)], uv_u_scale=2.0)

    mat_names = [
        "asphalt_primary", "asphalt_local", "granite_curb", "sidewalk_paver",
        "taluy_embankment", "marking_yellow", "marking_white", "bridge_concrete",
    ]
    total_tris = 0
    for tid, batches in sorted(tile_batchers.items()):
        nodes = []
        for mi, b in enumerate(batches):
            fin = b.finalize()
            if fin:
                nodes.append({
                    "name": f"OSM_Roads_{tid}_{mat_names[mi]}",
                    "positions": fin[0],
                    "normals": fin[1],
                    "uvs": fin[2],
                    "indices": fin[3],
                    "material": mi,
                })
                total_tris += len(fin[3]) // 3
        if nodes:
            out_fp = ASSETS / "osm_true_roads_hydro" / f"osm_real_roads_{tid}.glb"
            sz = write_road_glb_repeat(out_fp, nodes, road_materials, textures)
            print(f"[PBR Roads] {out_fp.name}: {len(nodes)} meshes, {sz/1024:.1f} KB", flush=True)

    print(f"[PBR Roads] Rebuilt {used_roads} ways + {crosswalk_count} zebra crosswalks ({total_tris:,} tris)", flush=True)
    return road_elev_grid


# ============================================================================
# 2. EXPORT TRAFFIC CORRIDORS ON EXACT COPERNICUS ROAD ELEVATIONS
# ============================================================================
def build_traffic_routes_json(osm_data: dict, dem: RealDalatDem, road_elev_grid: np.ndarray):
    """Stitch primary/secondary/tertiary drivable corridors inside [-2500..+2500]m for animated vehicles."""
    roads = osm_data.get("roads", [])
    allowed = {"trunk", "primary", "secondary", "tertiary"}

    segs = []
    for rd in roads:
        hw = rd["highway"]
        if hw not in allowed or rd.get("tunnel") in ("yes", "building_passage") or rd.get("area") == "yes":
            continue
        pts = [(float(p[0]), float(p[1])) for p in rd["pts"]]
        if len(pts) < 2:
            continue
        if any(abs(p[0]) > 2600 or abs(p[1]) > 2600 for p in pts):
            continue
        if not rd.get("bridge") and any(dem.is_in_water_scalar(p[0], p[1], pad_m=1.0) for p in pts):
            continue
        tier, base_w, *_ = ROAD_CLASS_SPECS[hw]
        lanes = rd.get("lanes") or 0
        width_m = max(base_w, float(lanes) * 3.3) if lanes else base_w
        length = sum(math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) for i in range(1, len(pts)))
        if length < 12.0:
            continue
        segs.append({
            "hw": hw,
            "tier": tier,
            "half_w": width_m * 0.5,
            "bridge": bool(rd.get("bridge")),
            "pts": pts,
            "used": False,
        })

    # Stitch touching endpoints with smooth forward continuation (< 62 deg turn)
    endpoint_map = defaultdict(list)
    for idx, s in enumerate(segs):
        k0 = (round(s["pts"][0][0], 1), round(s["pts"][0][1], 1))
        k1 = (round(s["pts"][-1][0], 1), round(s["pts"][-1][1], 1))
        endpoint_map[k0].append((idx, False))
        endpoint_map[k1].append((idx, True))

    def dir_vec(p0, p1):
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        ln = math.hypot(dx, dy) + 1e-8
        return dx / ln, dy / ln

    routes_raw = []
    # Prefer major arterial roads first
    order = sorted(range(len(segs)), key=lambda i: (segs[i]["tier"], -len(segs[i]["pts"])))
    for i in order:
        if segs[i]["used"]:
            continue
        segs[i]["used"] = True
        chain = list(segs[i]["pts"])
        hw_w = segs[i]["half_w"]
        tier = segs[i]["tier"]

        # Extend forward
        for _ in range(40):
            end_pt = chain[-1]
            prev_pt = chain[-2]
            dv = dir_vec(prev_pt, end_pt)
            ek = (round(end_pt[0], 1), round(end_pt[1], 1))
            best = None
            best_dot = 0.45  # cos(~63 deg)
            for nxt_idx, reversed_dir in endpoint_map.get(ek, []):
                if segs[nxt_idx]["used"]:
                    continue
                npts = segs[nxt_idx]["pts"][::-1] if reversed_dir else segs[nxt_idx]["pts"]
                nd = dir_vec(npts[0], npts[1])
                dot = dv[0] * nd[0] + dv[1] * nd[1]
                if dot > best_dot:
                    best_dot = dot
                    best = (nxt_idx, npts)
            if not best:
                break
            segs[best[0]]["used"] = True
            hw_w = max(hw_w, segs[best[0]]["half_w"])
            chain.extend(best[1][1:])
            if math.hypot(chain[-1][0] - chain[0][0], chain[-1][1] - chain[0][1]) < 4.0 and len(chain) >= 8:
                break

        # Extend backward
        for _ in range(40):
            st_pt = chain[0]
            nx_pt = chain[1]
            dv_back = dir_vec(nx_pt, st_pt)
            sk = (round(st_pt[0], 1), round(st_pt[1], 1))
            best = None
            best_dot = 0.45
            for nxt_idx, reversed_dir in endpoint_map.get(sk, []):
                if segs[nxt_idx]["used"]:
                    continue
                npts = segs[nxt_idx]["pts"] if reversed_dir else segs[nxt_idx]["pts"][::-1]
                nd = dir_vec(npts[0], npts[1])
                dot = dv_back[0] * nd[0] + dv_back[1] * nd[1]
                if dot > best_dot:
                    best_dot = dot
                    best = (nxt_idx, npts)
            if not best:
                break
            segs[best[0]]["used"] = True
            hw_w = max(hw_w, segs[best[0]]["half_w"])
            chain = best[1][::-1][:-1] + chain

        total_len = sum(math.hypot(chain[k][0] - chain[k - 1][0], chain[k][1] - chain[k - 1][1]) for k in range(1, len(chain)))
        if total_len < 130.0:
            continue
        is_loop = math.hypot(chain[-1][0] - chain[0][0], chain[-1][1] - chain[0][1]) < 15.0
        routes_raw.append((total_len, tier, hw_w, is_loop, chain))

    # Keep top ~140 corridors by length & priority, resample smoothly & stamp Y directly from Copernicus road surface
    routes_raw.sort(key=lambda r: (r[1], -r[0]))
    routes_out = []
    rg_n = road_elev_grid.shape[0]
    rg_res = 6000.0 / rg_n

    for total_len, tier, hw_w, is_loop, chain in routes_raw[:150]:
        pts_d = densify_xy(chain, max_step_m=10.0)
        xs = np.array([p[0] for p in pts_d], dtype=np.float64)
        ys_n = np.array([p[1] for p in pts_d], dtype=np.float64)
        y_dem = dem.sample_local_y_np(xs, ys_n)
        pts_gltf = []
        for k in range(len(pts_d)):
            x, yn = float(xs[k]), float(ys_n[k])
            yg = float(y_dem[k]) + (0.28 if tier == 1 else 0.23)
            gc = int((x + 3000.0) / rg_res)
            gr = int((3000.0 - yn) / rg_res)
            if 0 <= gc < rg_n and 0 <= gr < rg_n:
                rgv = float(road_elev_grid[gr, gc])
                if not math.isnan(rgv):
                    yg = max(yg, rgv + 0.04)
            pts_gltf.append([round(x, 2), round(yg, 2), round(-yn, 2)])
        routes_out.append({
            "tier": int(tier),
            "lane_off": round(max(1.2, min(2.4, hw_w * 0.42)), 2),
            "len": round(total_len, 1),
            "loop": bool(is_loop),
            "pts": pts_gltf,
        })

    out_fp = API_DIR / "road-traffic-routes.json"
    out_fp.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": "1.0.0",
        "source": "OpenStreetMap RING_0 + Copernicus GLO-30 DEM",
        "route_count": len(routes_out),
        "routes": routes_out,
    }
    out_fp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"[Traffic Routes] Exported {len(routes_out)} corridors -> {out_fp.name} ({out_fp.stat().st_size/1024:.1f} KB)", flush=True)


# ============================================================================
# 3. PER-OBJECT CLUSTER RE-CLAMPING FOR ALL 30 `assets/urban_life_props/*.glb`
# ============================================================================
def _extract_accessor_array(j: dict, bin_bytes: bytes, acc_idx: int) -> np.ndarray:
    acc = j["accessors"][acc_idx]
    bv = j["bufferViews"][acc["bufferView"]]
    off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    cnt = acc["count"]
    tmap = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    ncomp = tmap[acc["type"]]
    dmap = {5120: "<i1", 5121: "<u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
    dt = np.dtype(dmap[acc["componentType"]])
    stride = bv.get("byteStride") or (dt.itemsize * ncomp)
    if stride == dt.itemsize * ncomp:
        arr = np.frombuffer(bin_bytes, dtype=dt, count=cnt * ncomp, offset=off).reshape(cnt, ncomp).copy()
    else:
        arr = np.empty((cnt, ncomp), dtype=dt)
        for r in range(cnt):
            arr[r] = np.frombuffer(bin_bytes, dtype=dt, count=ncomp, offset=off + r * stride)
    return arr.squeeze() if ncomp == 1 else arr


def _find(parent, x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def _union(parent, a, b):
    ra, rb = _find(parent, a), _find(parent, b)
    if ra != rb:
        parent[rb] = ra


def reclamp_single_prop_glb(fp: pathlib.Path, dem: RealDalatDem, road_elev_grid: np.ndarray):
    """
    Re-clamp every cohesive 3D object cluster inside `fp` cleanly onto Copernicus DEM
    (+ road elevation lift if intersecting road surface, or lake surface +0.04m for water fleets),
    deleting stray objects dropped accidentally into Lake Ho Xuan Huong.
    """
    raw = fp.read_bytes()
    jlen = struct.unpack_from("<I", raw, 12)[0]
    j = json.loads(raw[20 : 20 + jlen].decode("utf-8"))
    blen = struct.unpack_from("<I", raw, 20 + jlen)[0]
    bin_bytes = raw[28 + jlen : 28 + jlen + blen]

    is_water_fleet = any(k in fp.name for k in ("swan_boats", "floating_floral"))
    is_vehicle_prop = any(k in fp.name for k in ("buses_vintage", "horse_carriages", "convoy", "jeep", "trucks"))

    # Collect per-primitive geometry
    prim_records = []
    sub_islands = []  # list of dicts: {prim_i, verts_idx, cx, cz, min_y, max_y}

    for mi, m in enumerate(j.get("meshes", [])):
        for pi, p in enumerate(m.get("primitives", [])):
            attrs = p["attributes"]
            pos = _extract_accessor_array(j, bin_bytes, attrs["POSITION"]).astype(np.float32)
            nrm = _extract_accessor_array(j, bin_bytes, attrs["NORMAL"]).astype(np.float32) if "NORMAL" in attrs else None
            idx = _extract_accessor_array(j, bin_bytes, p["indices"]).astype(np.int32) if "indices" in p else np.arange(len(pos), dtype=np.int32)
            idx_tri = idx.reshape(-1, 3)

            # Triangle-vertex connectivity within primitive
            nv = len(pos)
            par = list(range(nv))
            # Also weld coincident positions rounded to 2cm
            vkey_first = {}
            for vi in range(nv):
                k = (round(float(pos[vi, 0]) * 50), round(float(pos[vi, 1]) * 50), round(float(pos[vi, 2]) * 50))
                prev = vkey_first.get(k)
                if prev is None:
                    vkey_first[k] = vi
                else:
                    _union(par, prev, vi)
            for a, b, c in idx_tri:
                _union(par, int(a), int(b))
                _union(par, int(a), int(c))

            comp_tris = defaultdict(list)
            for ti, (a, b, c) in enumerate(idx_tri):
                comp_tris[_find(par, int(a))].append(ti)

            rec_id = len(prim_records)
            prim_records.append({
                "name": m.get("name", f"mesh_{mi}"),
                "mat_dict": j["materials"][p["material"]] if "material" in p else {"name": "default"},
                "pos": pos,
                "nrm": nrm,
                "idx_tri": idx_tri,
            })

            for root_v, tri_ids in comp_tris.items():
                t_arr = np.asarray(tri_ids, dtype=np.int32)
                vis = np.unique(idx_tri[t_arr].reshape(-1))
                sub_pos = pos[vis]
                xmin, xmax = float(sub_pos[:, 0].min()), float(sub_pos[:, 0].max())
                ymin, ymax = float(sub_pos[:, 1].min()), float(sub_pos[:, 1].max())
                zmin, zmax = float(sub_pos[:, 2].min()), float(sub_pos[:, 2].max())
                sub_islands.append({
                    "rec_id": rec_id,
                    "tris": t_arr,
                    "vis": vis,
                    "bbox": (xmin, xmax, zmin, zmax),
                    "cx": 0.5 * (xmin + xmax),
                    "cz": 0.5 * (zmin + zmax),
                    "min_y": ymin,
                    "max_y": ymax,
                })

    if not sub_islands:
        return 0, 0

    # Group multi-material sub-islands belonging to the SAME prop (e.g. car body + 4 wheels + chrome) via XZ overlap grid
    n_sub = len(sub_islands)
    gpar = list(range(n_sub))
    cell_sz = 4.0
    pad = 0.65
    grid = defaultdict(list)
    for si, isl in enumerate(sub_islands):
        x0, x1, z0, z1 = isl["bbox"]
        # Guard against huge continent-spanning ribbons accidentally bridging whole city
        if (x1 - x0) > 60.0 or (z1 - z0) > 60.0:
            continue
        c0, c1 = int(math.floor((x0 - pad) / cell_sz)), int(math.floor((x1 + pad) / cell_sz))
        r0, r1 = int(math.floor((z0 - pad) / cell_sz)), int(math.floor((z1 + pad) / cell_sz))
        for gx in range(c0, c1 + 1):
            for gz in range(r0, r1 + 1):
                for other in grid[(gx, gz)]:
                    ox0, ox1, oz0, oz1 = sub_islands[other]["bbox"]
                    if (x0 - pad <= ox1 and x1 + pad >= ox0 and z0 - pad <= oz1 and z1 + pad >= oz0):
                        # Only merge if vertical bounds also near each other (< 18m gap)
                        if abs(isl["min_y"] - sub_islands[other]["min_y"]) < 18.0:
                            _union(gpar, si, other)
                grid[(gx, gz)].append(si)

    groups = defaultdict(list)
    for si in range(n_sub):
        groups[_find(gpar, si)].append(si)

    # Compute exact shift for each cohesive multi-mesh object group
    rg_n = road_elev_grid.shape[0]
    rg_res = 6000.0 / rg_n
    kept_tris_by_rec = defaultdict(list)
    removed_water = 0
    shifted_groups = 0

    for _, members in groups.items():
        gmin_x = min(sub_islands[m]["bbox"][0] for m in members)
        gmax_x = max(sub_islands[m]["bbox"][1] for m in members)
        gmin_z = min(sub_islands[m]["bbox"][2] for m in members)
        gmax_z = max(sub_islands[m]["bbox"][3] for m in members)
        cx = 0.5 * (gmin_x + gmax_x)
        cz = 0.5 * (gmin_z + gmax_z)
        cyn = -cz
        g_min_y = min(sub_islands[m]["min_y"] for m in members)

        # Wide contiguous mesh lines spanning > 60m -> sample per-sub-island individually instead!
        if (gmax_x - gmin_x) > 65.0 or (gmax_z - gmin_z) > 65.0:
            for m in members:
                isl = sub_islands[m]
                ix, icyn = isl["cx"], -isl["cz"]
                in_w = dem.is_in_water_scalar(ix, icyn, pad_m=1.0)
                if in_w and not is_water_fleet:
                    removed_water += 1
                    continue
                target_y = 0.04 if (is_water_fleet and in_w) else dem.sample_local_y_scalar(ix, icyn)
                if not in_w and abs(ix) <= 3000 and abs(icyn) <= 3000:
                    gc, gr = int((ix + 3000.0) / rg_res), int((3000.0 - icyn) / rg_res)
                    if 0 <= gc < rg_n and 0 <= gr < rg_n and not math.isnan(road_elev_grid[gr, gc]):
                        target_y = max(target_y, float(road_elev_grid[gr, gc]))
                dy = target_y - isl["min_y"]
                rec = prim_records[isl["rec_id"]]
                rec["pos"][isl["vis"], 1] += dy
                kept_tris_by_rec[isl["rec_id"]].append(isl["tris"])
                shifted_groups += 1
            continue

        in_w = dem.is_in_water_scalar(cx, cyn, pad_m=1.2)
        if in_w and not is_water_fleet:
            removed_water += 1
            continue

        if is_water_fleet and in_w:
            target_y = 0.04
        else:
            target_y = dem.sample_local_y_scalar(cx, cyn)
            if abs(cx) <= 3000 and abs(cyn) <= 3000:
                gc, gr = int((cx + 3000.0) / rg_res), int((3000.0 - cyn) / rg_res)
                if 0 <= gc < rg_n and 0 <= gr < rg_n and not math.isnan(road_elev_grid[gr, gc]):
                    # Keep cars/lamps on road/sidewalk level flush with surface!
                    r_h = float(road_elev_grid[gr, gc])
                    target_y = max(target_y, r_h if is_vehicle_prop else r_h - 0.04)

        dy = target_y - g_min_y
        # Shift each primitive's unique vertices (note: a vertex is unique per triangle component inside rec_id!)
        for m in members:
            isl = sub_islands[m]
            rec = prim_records[isl["rec_id"]]
            rec["pos"][isl["vis"], 1] += dy
            kept_tris_by_rec[isl["rec_id"]].append(isl["tris"])
        shifted_groups += 1

    # Repack surviving geometry cleanly
    out_prims = []
    out_mats = []
    mat_map = {}
    for rec_id, rec in enumerate(prim_records):
        tri_chunks = kept_tris_by_rec.get(rec_id)
        if not tri_chunks:
            continue
        kept_tri_indices = np.concatenate(tri_chunks)
        sub_tris = rec["idx_tri"][kept_tri_indices]
        used_v, new_flat = np.unique(sub_tris.reshape(-1), return_inverse=True)
        new_pos = rec["pos"][used_v]
        new_idx = new_flat.astype(np.uint32)
        new_nrm = rec["nrm"][used_v] if rec["nrm"] is not None else compute_vertex_normals(new_pos, new_idx)

        mat_d = rec["mat_dict"]
        mkey = json.dumps(mat_d, sort_keys=True)
        if mkey not in mat_map:
            mat_map[mkey] = len(out_mats)
            out_mats.append(mat_d)
        out_prims.append({
            "name": rec["name"],
            "positions": new_pos,
            "normals": new_nrm,
            "indices": new_idx,
            "material": mat_map[mkey],
        })

    if not out_prims:
        return shifted_groups, removed_water

    # Write clean GLB
    from rebuild_real_dalat_core import write_glb
    write_glb(fp, out_prims, out_mats, images=None)
    return shifted_groups, removed_water


def main():
    t0 = time.time()
    cop_dir = CACHE / "copernicus"
    osm_fp = CACHE / "osm_ring0_real.json"
    if not (cop_dir / "N11_E108.tif").exists() or not osm_fp.exists():
        raise FileNotFoundError("Missing /tmp/dalat_real_cache/copernicus or osm_ring0_real.json!")

    cop = CopernicusGlo30Mosaic(cop_dir)
    osm_data = json.loads(osm_fp.read_text(encoding="utf-8"))
    dem = RealDalatDem(cop, osm_data)

    print("\n=== 1. Rebuilding 9 RING_0 Textured PBR Roads + Crosswalks ===")
    road_elev_grid = rebuild_textured_pbr_roads(osm_data, dem)

    print("\n=== 2. Generating Animated Traffic Routes (`api/road-traffic-routes.json`) ===")
    build_traffic_routes_json(osm_data, dem, road_elev_grid)

    print("\n=== 3. Re-clamping 30 Urban Life Props onto Copernicus DEM ===")
    ul_files = sorted((ASSETS / "urban_life_props").glob("*.glb"))
    tot_groups, tot_water = 0, 0
    for fp in ul_files:
        sg, rw = reclamp_single_prop_glb(fp, dem, road_elev_grid)
        tot_groups += sg
        tot_water += rw
        print(f"  {fp.name[:48]:48s}: {sg:4d} clusters reclamped (removed {rw} water collisions)", flush=True)

    print(f"\nDONE in {time.time() - t0:.1f}s | Clusters reclamped={tot_groups}, water purged={tot_water}")


if __name__ == "__main__":
    main()
