#!/usr/bin/env python3
"""
upgrade_satellite_sharpness.py — Nâng Cấp Độ Nét Ảnh Vệ Tinh Tối Đa Toàn Diện (Google Satellite + 4:4:4 Chroma + UnsharpMask + Quad-Tile 4K)

Chiến lược tối ưu độ nét mà vẫn giữ bộ nhớ WebGL an toàn & dung lượng kho GitHub Pages gọn nhẹ:
  1. Lõi trung tâm T_E00_N00 (Hồ Xuân Hương, Lâm Viên, Chợ, Đồi Cù, CĐSP, Con Gà):
     - Chia lưới Copernicus DEM 257x257 thành 2x2 phân khu liền mép (0.0000mm khe hở),
       mỗi phân khu mang ảnh vệ tinh Google Satellite Z19 nén Lanczos3 -> 2048x2048 (tổng 4096x4096 = 0.49m/px!),
       nén JPEG chuẩn 4:4:4 (subsampling=0, không nhòe màu mái/đường) + bộ lọc tăng nét quang học UnsharpMask.
  2. 8 ô RING_0 xung quanh (6x6km đô thị trung tâm): Nâng từ 1024px Esri Z16 -> 2048x2048 Google Satellite Z18 (nét gấp 4 lần).
  3. 16 ô 5x5 & 24 ô RING_1 (14x14km: Tuyền Lâm, Thung Lũng Tình Yêu, Thái Phiên, Vạn Thành, Trại Mát, Suối Vàng):
     Nâng từ 1024px Esri -> 2048x2048 Google Satellite Z17 (nét gấp 4 lần).
  4. 67 ô RING_2+ (30x30km ngoại vi): Đồng nhất nguồn Google Satellite Z16 (1024x1024 4:4:4) xóa triệt để vết ghép khác màu Esri/Google.
  5. Nền chân trời 60km x 60km (terrain_backdrop_dalat_60km.glb): Chia 2x2 x 2048x2048 (= 4096x4096) Google Satellite Z13 (nét gấp 7 lần).
"""

import concurrent.futures
import io
import json
import math
import pathlib
import re
import struct
import time

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

ROOT = pathlib.Path("/home/antigravity/dalat-3d-simulation")
SAT_DIR = ROOT / "assets" / "satellite_dem_tiles"
CACHE_G = pathlib.Path("/tmp/dalat_real_cache/google")
CACHE_G.mkdir(parents=True, exist_ok=True)

LAT0 = 11.940419
LON0 = 108.445259
MLAT = 111319.49
MLON = 108911.0
TILE_SIZE_M = 2000.0
HALF_TILE_M = 1000.0


def format_tile_id(ix: int, iy: int) -> str:
    ew = "W" if ix < 0 else "E"
    ns = "S" if iy < 0 else "N"
    return f"T_{ew}{abs(ix):02d}_{ns}{abs(iy):02d}"


def tile_bounds(ix: int, iy: int):
    cx, cy = ix * TILE_SIZE_M, iy * TILE_SIZE_M
    return cx - HALF_TILE_M, cx + HALF_TILE_M, cy - HALF_TILE_M, cy + HALF_TILE_M


def local_to_latlon(x_m, y_north_m):
    return LAT0 + y_north_m / MLAT, LON0 + x_m / MLON


def deg2num_float_np(lat_deg, lon_deg, zoom: int):
    lat_rad = np.radians(lat_deg)
    n = float(2 ** zoom)
    xt = (lon_deg + 180.0) / 360.0 * n
    yt = (1.0 - np.arcsinh(np.tan(lat_rad)) / math.pi) / 2.0 * n
    return xt, yt


def deg2num_float(lat_deg: float, lon_deg: float, zoom: int):
    lat_rad = math.radians(lat_deg)
    n = float(2 ** zoom)
    xt = (lon_deg + 180.0) / 360.0 * n
    yt = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return xt, yt


def tile_range_for_bounds(min_x: float, max_x: float, min_y: float, max_y: float, zoom: int):
    north, west = local_to_latlon(min_x, max_y)
    south, east = local_to_latlon(max_x, min_y)
    x0, y0 = deg2num_float(north, west, zoom)
    x1, y1 = deg2num_float(south, east, zoom)
    return int(math.floor(x0)), int(math.floor(x1)), int(math.floor(y0)), int(math.floor(y1))


def collect_needed_tiles(tile_specs):
    needed = set()
    for min_x, max_x, min_y, max_y, zoom in tile_specs:
        tx0, tx1, ty0, ty1 = tile_range_for_bounds(min_x, max_x, min_y, max_y, zoom)
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                needed.add((zoom, tx, ty))
    return sorted(needed)


def _download_one(job):
    zoom, tx, ty = job
    fp = CACHE_G / f"{zoom}_{tx}_{ty}.jpg"
    if fp.exists() and fp.stat().st_size > 400:
        return True
    shard = (tx + ty) % 4
    url = f"https://mt{shard}.google.com/vt/lyrs=s&x={tx}&y={ty}&z={zoom}"
    for attempt in range(4):
        try:
            import urllib.request
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"},
            )
            with urllib.request.urlopen(req, timeout=14) as r:
                b = r.read()
            if len(b) > 200:
                fp.write_bytes(b)
                return True
        except Exception:
            time.sleep(0.35 * (attempt + 1))
    return False


def ensure_tiles_cached(jobs):
    missing = [j for j in jobs if not (CACHE_G / f"{j[0]}_{j[1]}_{j[2]}.jpg").exists()]
    print(f"[GoogleSat Cache] Total needed={len(jobs)}, already cached={len(jobs)-len(missing)}, downloading={len(missing)}...", flush=True)
    if not missing:
        return
    t0 = time.time()
    ok = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
        for i, res in enumerate(ex.map(_download_one, missing), 1):
            if res:
                ok += 1
            if i % 500 == 0 or i == len(missing):
                print(f"  downloaded {i}/{len(missing)} (ok={ok}) in {time.time()-t0:.1f}s", flush=True)


def build_google_texture_for_bounds(
    min_x: float, max_x: float, min_y: float, max_y: float,
    zoom: int, out_size: int, sharpen_pct: int = 58, quality: int = 86
) -> bytes:
    """
    Stitches Google Satellite tiles at exact Mercator bounds and warps smoothly
    into rectilinear UV space (u=[0..1], v=[0..1]) matching tile corners sub-meter.
    Uses Lanczos/Bilinear supersampling + optical UnsharpMask + 4:4:4 chroma JPEG.
    """
    tx_min, tx_max, ty_min, ty_max = tile_range_for_bounds(min_x, max_x, min_y, max_y, zoom)
    mw = (tx_max - tx_min + 1) * 256
    mh = (ty_max - ty_min + 1) * 256
    canvas = np.full((mh, mw, 3), (44, 68, 42), dtype=np.uint8)

    for ty in range(ty_min, ty_max + 1):
        for tx in range(tx_min, tx_max + 1):
            fp = CACHE_G / f"{zoom}_{tx}_{ty}.jpg"
            if fp.exists():
                try:
                    im = Image.open(fp).convert("RGB")
                    arr = np.asarray(im, dtype=np.uint8)
                    r0 = (ty - ty_min) * 256
                    c0 = (tx - tx_min) * 256
                    canvas[r0 : r0 + 256, c0 : c0 + 256] = arr
                except Exception:
                    pass

    # If native resolution is much higher than out_size (e.g. z19 on 1km quadrant = ~3400px -> 2048px),
    # resample with PIL LANCZOS on the geographic crop to prevent aliasing shimmer!
    north, west = local_to_latlon(min_x, max_y)
    south, east = local_to_latlon(max_x, min_y)
    fx0, fy0 = deg2num_float(north, west, zoom)
    fx1, fy1 = deg2num_float(south, east, zoom)
    px0 = (fx0 - tx_min) * 256.0
    py0 = (fy0 - ty_min) * 256.0
    px1 = (fx1 - tx_min) * 256.0
    py1 = (fy1 - ty_min) * 256.0

    src_im = Image.fromarray(canvas, mode="RGB")
    span_px = abs(px1 - px0)
    if span_px > out_size * 1.25:
        mid_sz = min(4096, out_size * 2)
        im_out = src_im.transform(
            (mid_sz, mid_sz),
            Image.Transform.EXTENT,
            (px0, py0, px1, py1),
            resample=Image.Resampling.BICUBIC,
        ).resize((out_size, out_size), Image.Resampling.LANCZOS)
    else:
        im_out = src_im.transform(
            (out_size, out_size),
            Image.Transform.EXTENT,
            (px0, py0, px1, py1),
            resample=Image.Resampling.BICUBIC,
        )
    im_out = ImageEnhance.Contrast(im_out).enhance(1.04)
    im_out = ImageEnhance.Color(im_out).enhance(1.06)
    if sharpen_pct > 0:
        im_out = im_out.filter(ImageFilter.UnsharpMask(radius=0.85, percent=sharpen_pct, threshold=3))

    buf = io.BytesIO()
    im_out.save(buf, format="JPEG", quality=quality, subsampling=0, optimize=True)
    return buf.getvalue()


def _pad4(b: bytes, fill: bytes = b"\x00") -> bytes:
    rem = len(b) % 4
    return b + (fill * (4 - rem) if rem else b"")


def write_glb_multi_prim(out_path: pathlib.Path, primitives_list: list, materials: list, images: list):
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

    gltf_samplers = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
    gltf_images = []
    gltf_textures = []
    for img_bytes, mime in images:
        bv_i = add_bv(img_bytes, None)
        img_idx = len(gltf_images)
        gltf_images.append({"bufferView": bv_i, "mimeType": mime})
        gltf_textures.append({"sampler": 0, "source": img_idx})

    for rec in primitives_list:
        pos = np.ascontiguousarray(rec["positions"], dtype="<f4")
        nrm = np.ascontiguousarray(rec["normals"], dtype="<f4")
        uvs = np.ascontiguousarray(rec["uvs"], dtype="<f4")
        idx_arr = np.ascontiguousarray(rec["indices"], dtype="<u4")
        if len(pos) == 0 or len(idx_arr) == 0:
            continue

        bv_p = add_bv(pos.tobytes(), 34962)
        acc_p = len(accessors)
        accessors.append({
            "bufferView": bv_p, "componentType": 5126, "count": int(len(pos)), "type": "VEC3",
            "min": [float(x) for x in pos.min(axis=0)], "max": [float(x) for x in pos.max(axis=0)],
        })

        bv_n = add_bv(nrm.tobytes(), 34962)
        acc_n = len(accessors)
        accessors.append({"bufferView": bv_n, "componentType": 5126, "count": int(len(nrm)), "type": "VEC3"})

        bv_u = add_bv(uvs.tobytes(), 34962)
        acc_u = len(accessors)
        accessors.append({"bufferView": bv_u, "componentType": 5126, "count": int(len(uvs)), "type": "VEC2"})

        bv_i = add_bv(idx_arr.tobytes(), 34963)
        acc_i = len(accessors)
        accessors.append({
            "bufferView": bv_i, "componentType": 5125, "count": int(len(idx_arr)), "type": "SCALAR",
            "min": [int(idx_arr.min())], "max": [int(idx_arr.max())],
        })

        mi = len(meshes)
        meshes.append({
            "name": rec["name"],
            "primitives": [{"attributes": {"POSITION": acc_p, "NORMAL": acc_n, "TEXCOORD_0": acc_u}, "indices": acc_i, "material": rec["material"]}],
        })
        nodes.append({"name": rec["name"], "mesh": mi})

    bin_blob = b"".join(bin_chunks)
    gltf = {
        "asset": {"version": "2.0", "generator": "Dalat3D-UltraHdSatellite/3.0"},
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
    header = struct.pack("<4sII", b"glTF", 2, total_len)
    j_hdr = struct.pack("<II", len(json_bytes), 0x4E4F534A)
    b_hdr = struct.pack("<II", len(bin_blob), 0x004E4942)
    out_path.write_bytes(header + j_hdr + json_bytes + b_hdr + bin_blob)
    return out_path.stat().st_size


def split_grid_to_2x2_quad_glb(src_fp: pathlib.Path, ix: int, iy: int, zoom: int, quad_tex_size: int, quality: int, sharpen_pct: int):
    """
    Splits an existing single-mesh (n x n) terrain GLB cleanly into 2x2 seamless quadrants
    sharing exact border vertices (0.0000mm seam), each textured at quad_tex_size x quad_tex_size!
    For n=257 (T_E00_N00): 4 quadrants of 129x129 -> 4 x 2048x2048 = 4096x4096 (0.49 m/px)!
    """
    raw = src_fp.read_bytes()
    jlen = struct.unpack("<I", raw[12:16])[0]
    j = json.loads(raw[20 : 20 + jlen].decode("utf-8"))
    b = raw[28 + jlen :]
    prim = j["meshes"][0]["primitives"][0]
    pa = j["accessors"][prim["attributes"]["POSITION"]]
    na = j["accessors"][prim["attributes"]["NORMAL"]]
    pbv = j["bufferViews"][pa["bufferView"]]
    nbv = j["bufferViews"][na["bufferView"]]
    cnt = pa["count"]
    n = int(round(math.sqrt(cnt)))
    if n * n != cnt or (n - 1) % 2 != 0:
        raise ValueError(f"Expected odd square vertex grid, got cnt={cnt}")

    pos = np.frombuffer(b[pbv.get("byteOffset", 0) + pa.get("byteOffset", 0) : pbv.get("byteOffset", 0) + pa.get("byteOffset", 0) + cnt * 12], dtype="<f4").reshape(n, n, 3).copy()
    nrm = np.frombuffer(b[nbv.get("byteOffset", 0) + na.get("byteOffset", 0) : nbv.get("byteOffset", 0) + na.get("byteOffset", 0) + cnt * 12], dtype="<f4").reshape(n, n, 3).copy()

    half_i = (n - 1) // 2
    qn = half_i + 1
    min_x, max_x, min_y, max_y = tile_bounds(ix, iy)
    mid_x = 0.5 * (min_x + max_x)
    mid_y = 0.5 * (min_y + max_y)
    tid = format_tile_id(ix, iy)

    # Quadrant order: (row_slice, col_slice, qmin_x, qmax_x, qmin_y, qmax_y, tag)
    # Note row 0 = North (+max_y), row n-1 = South (+min_y)
    quads = [
        (slice(0, qn), slice(0, qn), min_x, mid_x, mid_y, max_y, "NW"),
        (slice(0, qn), slice(half_i, n), mid_x, max_x, mid_y, max_y, "NE"),
        (slice(half_i, n), slice(0, qn), min_x, mid_x, min_y, mid_y, "SW"),
        (slice(half_i, n), slice(half_i, n), mid_x, max_x, min_y, mid_y, "SE"),
    ]

    r_idx = np.arange(qn - 1, dtype=np.uint32)[:, None]
    c_idx = np.arange(qn - 1, dtype=np.uint32)[None, :]
    v00 = r_idx * qn + c_idx
    v10 = v00 + 1
    v01 = (r_idx + 1) * qn + c_idx
    v11 = v01 + 1
    q_indices = np.stack([v00, v01, v10, v10, v01, v11], axis=-1).reshape(-1)

    u = np.linspace(0.0, 1.0, qn, dtype=np.float32)
    v = np.linspace(0.0, 1.0, qn, dtype=np.float32)
    uu, vv = np.meshgrid(u, v)
    q_uvs = np.stack([uu, vv], axis=-1).reshape(-1, 2)

    prims = []
    mats = []
    imgs = []
    for qi, (rs, cs, qmin_x, qmax_x, qmin_y, qmax_y, tag) in enumerate(quads):
        qpos = pos[rs, cs, :].reshape(-1, 3)
        qnrm = nrm[rs, cs, :].reshape(-1, 3)
        jpg = build_google_texture_for_bounds(qmin_x, qmax_x, qmin_y, qmax_y, zoom=zoom, out_size=quad_tex_size, sharpen_pct=sharpen_pct, quality=quality)
        imgs.append((jpg, "image/jpeg"))
        mats.append({
            "name": f"Mat_TerrainReal_{tid}_{tag}",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": qi},
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "roughnessFactor": 0.96,
                "metallicFactor": 0.0,
            },
            "doubleSided": False,
        })
        prims.append({
            "name": f"TerrainReal_{tid}_{tag}",
            "positions": qpos,
            "normals": qnrm,
            "uvs": q_uvs,
            "indices": q_indices,
            "material": qi,
        })

    return write_glb_multi_prim(src_fp, prims, mats, imgs)


def replace_single_image_glb(src_fp: pathlib.Path, ix: int, iy: int, zoom: int, out_size: int, quality: int, sharpen_pct: int):
    """
    Preserves 100% of existing geometry/heights inside a single-image terrain GLB
    and replaces its embedded JPEG with a sharper Google Satellite texture!
    """
    min_x, max_x, min_y, max_y = tile_bounds(ix, iy)
    new_jpg = build_google_texture_for_bounds(min_x, max_x, min_y, max_y, zoom=zoom, out_size=out_size, sharpen_pct=sharpen_pct, quality=quality)

    raw = src_fp.read_bytes()
    jlen = struct.unpack("<I", raw[12:16])[0]
    j = json.loads(raw[20 : 20 + jlen].decode("utf-8"))
    b = raw[28 + jlen :]

    imgs = j.get("images", [])
    if not imgs:
        return src_fp.stat().st_size

    img_bv_idx = imgs[0].get("bufferView")
    # Rebuild binary buffer replacing only image bufferView payload + updating all bufferView offsets
    new_chunks = []
    new_offset = 0
    for bvi, bv in enumerate(j["bufferViews"]):
        if bvi == img_bv_idx:
            chunk = new_jpg
        else:
            start = bv.get("byteOffset", 0)
            chunk = b[start : start + bv["byteLength"]]
        bv["byteOffset"] = new_offset
        bv["byteLength"] = len(chunk)
        padded = _pad4(chunk)
        new_chunks.append(padded)
        new_offset += len(padded)

    imgs[0]["mimeType"] = "image/jpeg"
    j["buffers"][0]["byteLength"] = new_offset
    for mat in j.get("materials", []):
        pbr = mat.get("pbrMetallicRoughness", {})
        pbr["roughnessFactor"] = 0.96
        pbr["metallicFactor"] = 0.0

    new_bin = b"".join(new_chunks)
    new_jbytes = _pad4(json.dumps(j, separators=(",", ":")).encode("utf-8"), b" ")
    total_len = 12 + 8 + len(new_jbytes) + 8 + len(new_bin)
    out_bytes = (
        struct.pack("<4sII", b"glTF", 2, total_len)
        + struct.pack("<II", len(new_jbytes), 0x4E4F534A)
        + new_jbytes
        + struct.pack("<II", len(new_bin), 0x004E4942)
        + new_bin
    )
    src_fp.write_bytes(out_bytes)
    return len(out_bytes)


def upgrade_backdrop_60km_4k(src_fp: pathlib.Path, zoom: int = 13, quad_tex_size: int = 2048):
    """
    Splits the 60km x 60km highland backdrop (161x161 vertices, inner core hole preserved!)
    into 2x2 seamless quadrants x 2048x2048 (4096x4096 total) using Google Satellite Z13!
    """
    raw = src_fp.read_bytes()
    jlen = struct.unpack("<I", raw[12:16])[0]
    j = json.loads(raw[20 : 20 + jlen].decode("utf-8"))
    b = raw[28 + jlen :]

    prim = j["meshes"][0]["primitives"][0]
    pa = j["accessors"][prim["attributes"]["POSITION"]]
    na = j["accessors"][prim["attributes"]["NORMAL"]]
    ia = j["accessors"][prim["indices"]]
    pbv = j["bufferViews"][pa["bufferView"]]
    nbv = j["bufferViews"][na["bufferView"]]
    ibv = j["bufferViews"][ia["bufferView"]]

    cnt = pa["count"]
    n = int(round(math.sqrt(cnt)))  # 161
    pos = np.frombuffer(b[pbv.get("byteOffset", 0) + pa.get("byteOffset", 0) : pbv.get("byteOffset", 0) + pa.get("byteOffset", 0) + cnt * 12], dtype="<f4").reshape(n, n, 3).copy()
    nrm = np.frombuffer(b[nbv.get("byteOffset", 0) + na.get("byteOffset", 0) : nbv.get("byteOffset", 0) + na.get("byteOffset", 0) + cnt * 12], dtype="<f4").reshape(n, n, 3).copy()
    orig_tris = np.frombuffer(b[ibv.get("byteOffset", 0) + ia.get("byteOffset", 0) : ibv.get("byteOffset", 0) + ia.get("byteOffset", 0) + ia["count"] * 4], dtype="<u4").reshape(-1, 3).copy()

    # Track kept quads directly from original upper-left triangles (v00, v01, v10)
    kept_quad_mask = np.zeros((n - 1, n - 1), dtype=bool)
    is_ul = (orig_tris[:, 1] == orig_tris[:, 0] + n) & (orig_tris[:, 2] == orig_tris[:, 0] + 1)
    v00_kept = orig_tris[is_ul, 0]
    kept_quad_mask[v00_kept // n, v00_kept % n] = True

    span = 60000.0
    half = span / 2.0
    half_i = (n - 1) // 2
    qn = half_i + 1
    quads = [
        (slice(0, qn), slice(0, qn), 0, half_i, 0, half_i, -half, 0.0, 0.0, half, "NW"),
        (slice(0, qn), slice(half_i, n), 0, half_i, half_i, n - 1, 0.0, half, 0.0, half, "NE"),
        (slice(half_i, n), slice(0, qn), half_i, n - 1, 0, half_i, -half, 0.0, -half, 0.0, "SW"),
        (slice(half_i, n), slice(half_i, n), half_i, n - 1, half_i, n - 1, 0.0, half, -half, 0.0, "SE"),
    ]

    u = np.linspace(0.0, 1.0, qn, dtype=np.float32)
    v = np.linspace(0.0, 1.0, qn, dtype=np.float32)
    uu, vv = np.meshgrid(u, v)
    q_uvs = np.stack([uu, vv], axis=-1).reshape(-1, 2)
    r_idx = np.arange(qn - 1, dtype=np.uint32)[:, None]
    c_idx = np.arange(qn - 1, dtype=np.uint32)[None, :]

    prims, mats, imgs = [], [], []
    for qi, (rs, cs, r0, r1, c0, c1, qmin_x, qmax_x, qmin_y, qmax_y, tag) in enumerate(quads):
        qmask = kept_quad_mask[r0:r1, c0:c1]
        v00 = (r_idx * qn + c_idx)[qmask]
        v10 = v00 + 1
        v01 = v00 + qn
        v11 = v01 + 1
        q_indices = np.stack([v00, v01, v10, v10, v01, v11], axis=-1).reshape(-1)
        jpg = build_google_texture_for_bounds(qmin_x, qmax_x, qmin_y, qmax_y, zoom=zoom, out_size=quad_tex_size, sharpen_pct=45, quality=84)
        imgs.append((jpg, "image/jpeg"))
        mats.append({
            "name": f"Mat_Dalat_Highland_Backdrop_60km_{tag}",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": qi},
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "roughnessFactor": 0.96,
                "metallicFactor": 0.0,
            },
            "doubleSided": False,
        })
        prims.append({
            "name": f"Dalat_Highland_Backdrop_60km_{tag}",
            "positions": pos[rs, cs, :].reshape(-1, 3),
            "normals": nrm[rs, cs, :].reshape(-1, 3),
            "uvs": q_uvs,
            "indices": q_indices,
            "material": qi,
        })

    return write_glb_multi_prim(src_fp, prims, mats, imgs)


def main():
    t0 = time.time()
    # Discover all terrain_real_T_*.glb tiles
    tile_entries = []
    for fp in sorted(SAT_DIR.glob("terrain_real_T_*.glb")):
        m = re.match(r"terrain_real_T_([EW])(\d{2})_([NS])(\d{2})\.glb$", fp.name)
        if not m:
            continue
        ix = -int(m.group(2)) if m.group(1) == "W" else int(m.group(2))
        iy = -int(m.group(4)) if m.group(3) == "S" else int(m.group(4))
        dist_r = max(abs(ix), abs(iy))
        tile_entries.append((dist_r, ix, iy, fp))

    # Build download plan across ALL rings + 60km backdrop
    bound_specs = [(-30000.0, 30000.0, -30000.0, 30000.0, 13)]
    for dist_r, ix, iy, _ in tile_entries:
        min_x, max_x, min_y, max_y = tile_bounds(ix, iy)
        if ix == 0 and iy == 0:
            z = 19
        elif dist_r <= 1:
            z = 18
        elif dist_r <= 3:
            z = 17
        else:
            z = 16
        bound_specs.append((min_x, max_x, min_y, max_y, z))

    all_jobs = collect_needed_tiles(bound_specs)
    ensure_tiles_cached(all_jobs)

    print("\n=== Upgrading 60km Backdrop to 4096x4096 (2x2 x 2048px Google Z13) ===", flush=True)
    bd_fp = SAT_DIR / "terrain_backdrop_dalat_60km.glb"
    bd_sz = upgrade_backdrop_60km_4k(bd_fp, zoom=13, quad_tex_size=2048)
    print(f"  terrain_backdrop_dalat_60km.glb -> {bd_sz/1024:.0f} KB", flush=True)

    print("\n=== Upgrading 116 Terrain Tiles to Google Satellite 4:4:4 UnsharpMask ===", flush=True)
    for idx, (dist_r, ix, iy, fp) in enumerate(tile_entries, 1):
        if ix == 0 and iy == 0:
            sz = split_grid_to_2x2_quad_glb(fp, ix, iy, zoom=19, quad_tex_size=2048, quality=86, sharpen_pct=58)
            tag = "2x2x2048px (4096px Z19)"
        elif dist_r <= 1:
            sz = replace_single_image_glb(fp, ix, iy, zoom=18, out_size=2048, quality=85, sharpen_pct=55)
            tag = "2048px (Z18)"
        elif dist_r <= 3:
            sz = replace_single_image_glb(fp, ix, iy, zoom=17, out_size=2048, quality=83, sharpen_pct=50)
            tag = "2048px (Z17)"
        else:
            sz = replace_single_image_glb(fp, ix, iy, zoom=16, out_size=1024, quality=82, sharpen_pct=45)
            tag = "1024px (Z16)"
        if idx <= 10 or idx % 20 == 0 or idx == len(tile_entries):
            print(f"  [{idx:3d}/{len(tile_entries)}] {fp.name:30s} -> {tag:22s} | {sz/1024:6.0f} KB", flush=True)

    print(f"\n=== SATELLITE UPGRADE COMPLETED IN {time.time()-t0:.1f}s! ===", flush=True)


if __name__ == "__main__":
    main()
