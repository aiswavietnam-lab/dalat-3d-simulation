#!/usr/bin/env python3
"""
Đồng bộ tự động tài nguyên 3D Đà Lạt (GLB, JSON, địa danh, rừng thông, nhà dân, đường phố)
từ Google Drive lên GitHub Pages.
- Hỗ trợ 2 chế độ truy cập Drive:
  1) `gdrive` CLI (mặc định trên Antigravity Cloud VM)
  2) Google Drive API v3 (trên GitHub Actions qua GOOGLE_SERVICE_ACCOUNT_JSON,
     GDRIVE_OAUTH_REFRESH_TOKEN + GDRIVE_CLIENT_ID + GDRIVE_CLIENT_SECRET, hoặc GDRIVE_API_KEY)
- Bảo vệ giao diện điện thoại, bộ vật liệu PBR Poly Haven & bộ render Realtime trên GitHub:
  mặc định KHÔNG ghi đè `index.html`, `css/`, `js/` trừ khi bật `--sync-viewer`.
- Tự động khử trùng lặp các tile đời cũ bị phủ bởi bản mới (`satellite_dem_tiles`,
  `osm_true_buildings`, `vegetation`) và bỏ qua `heightmap_*.json` không dùng trên web để giữ
  dung lượng GitHub Pages tối ưu.
"""
import argparse
import base64
import concurrent.futures
import datetime
import json
import math
import os
import pathlib
import re
import shutil
import struct
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
STATE_FILE = ROOT / "scripts" / "drive_state.json"
TILE_ID_REGEX = re.compile(r"(T_[EW]\d{2}_[NS]\d{2})")

DATA_FILES = {
    "data/world_ui_specs/camera_presets_dalat.json": ("1728JaLRrZa2Kbfj8NTPNlfn2-e_a269e", "camera_presets_dalat.json"),
    "data/references/dalat_core_seeds.json": ("1QG08-I2jFXWTZlTfhaASzRP7GXoWWuDX", "dalat_core_seeds.json"),
    "state/TILE_GRID_SPEC.json": ("14D9jOHsfcd7crFzHAjM1D9p_y2MQmnnx", "TILE_GRID_SPEC.json"),
}

ASSET_FOLDERS = [
    ("satellite_dem_tiles", "1bkiDPZCvLzXcA4mGWEN1GJD4lXBz7snw"),
    ("terrain_tiles", "1Mmw2MAvM4zWSD9_pB8_n-xNEWQ0snEVD"),
    ("terrain_tiles_ring1_ext", "1fpxtzfrQ5fqls0qBxEX-Jn2Yo9TVyKsc"),
    ("terrain_tiles_ring2", "1cZJQ4S_m5PLxE3MNmx1z-hvBzNnfrfrW"),
    ("water_bodies", "1p-r7PeKDLPtU8IM3yy_iWM5ODCYNAOxY"),
    ("natural_wonders_pbr", "1O9tp9DRNOYfjx8EI4aAzA4KraRMiP5Kd"),
    ("vegetation", "1HaRb4wLyLkHKjQAnaTVHllWkysgr1kRg"),
    ("vegetation_expanded", "1RYnBkMNngZ-q17uzzLvsDswuDaTbF5fe"),
    ("hero_landmarks_ultra", "1YbzG2s6cijkl2AX-Kh-FbRZT5Ddd1z4A"),
    ("landmarks", "14Ra-AgsC1Ajtao86wx0lvcCCEHm_Fbf-"),
    ("french_villas", "1woX_LL92dQBM68nMoA9VlUhTZZOk1W0p"),
    ("tourism_complexes", "1WA_quOOVBG3mHfyi-4u_vm23m0SeJcWp"),
    ("agri_landscapes", "1Bwv0bDJBaPWFC_8Ft1qsVigQwjzJXTl7"),
    ("ring3_districts_ultra", "1vKSwnoYKAWUveniP-nb5AegV82J-jTOZ"),
    ("osm_true_buildings", "1ES9NV3JXMcXgbjyvIHWkjBRvBew9XbRb"),
    ("building_tiles", "1FiUTNcGW3Wl7IGfuGTw_zO3Oh1cxvPVa"),
    ("urban_wards_tiles", "1fMPnbX4XHalKxba7Af1kvYbm3U10klBZ"),
    ("osm_true_roads_hydro", "1Dl-n2z0j1mH3InryZca8UYN2iWAYZamm"),
    ("infrastructure_buildings", "1wcjuRNhHP2tv8iMyvglrpU9Pnrgz_jSR"),
    ("transport_infra", "1jLBfgW1T0qWs74MXUpI6n8Tu_kpIwGt0"),
    ("urban_life_props", "1E23-McKgvU0lgftjvMqqisLNFnLfGi5H"),
    ("sourced_library/urban_props", "1MVMVQ2hnBzRTZOSHwNK-UgyKT2a_mguI"),
    ("sourced_library/landmarks", "1P8wAefoQejAOMJtii7XUHFWfJk4fWiC2"),
    ("sourced_library/vegetation", "1zk2zhxbW28LJXWdehk0Qa5GFy6eLMHCC"),
    ("scene", "1RJnTMKFXkoiLEVm4ZYVD5HPyAgi8K04c"),
]

WEB_VIEWER_FOLDERS = [
    ("", "1ozm11VMa2dmK99lVvnjKv-HAeQhbjpJD", (".html",)),
    ("css", "1jLKnM9RnDtq6iw165y8GvR-1Dra1I2SF", (".css",)),
    ("js", "1OItlg-st_cgkb464_Emk8_8dWJUVSwbL", (".js",)),
    ("js/vendor", "1uGmnngKr_ls5uaIp4yKEXuiN27M9aPan", (".js",)),
]

# Nhóm ưu tiên khử trùng lặp theo Tile ID (thư mục đứng trước thắng thư mục đứng sau)
DEDUPE_PRIORITY_GROUPS = [
    (["satellite_dem_tiles", "terrain_tiles", "terrain_tiles_ring1_ext", "terrain_tiles_ring2"], (".glb", ".gltf"), None),
    (["osm_true_buildings", "building_tiles", "urban_wards_tiles"], (".glb", ".gltf"), None),
    (["vegetation", "vegetation_expanded"], (".json",), lambda n: n.startswith("instances_")),
]


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


class DriveClient:
    def __init__(self):
        self.mode = None
        self.access_token = None
        self.api_key = None

        if shutil.which("gdrive"):
            self.mode = "cli"
            return

        sa_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
        if sa_json:
            self.access_token = self._token_from_service_account(json.loads(sa_json))
            self.mode = "api"
            return

        rt = os.environ.get("GDRIVE_OAUTH_REFRESH_TOKEN", "").strip()
        cid = os.environ.get("GDRIVE_CLIENT_ID", "").strip()
        csec = os.environ.get("GDRIVE_CLIENT_SECRET", "").strip()
        if rt and cid and csec:
            self.access_token = self._token_from_refresh(rt, cid, csec)
            self.mode = "api"
            return

        api_key = os.environ.get("GDRIVE_API_KEY", "").strip()
        if api_key:
            self.api_key = api_key
            self.mode = "api"
            return

        raise RuntimeError(
            "Không tìm thấy `gdrive` CLI hoặc Secret Google Drive "
            "(GOOGLE_SERVICE_ACCOUNT_JSON / GDRIVE_OAUTH_REFRESH_TOKEN / GDRIVE_API_KEY)."
        )

    def _token_from_service_account(self, sa: dict) -> str:
        now = int(time.time())
        header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64url(
            json.dumps(
                {
                    "iss": sa["client_email"],
                    "scope": "https://www.googleapis.com/auth/drive.readonly",
                    "aud": sa.get("token_uri", "https://oauth2.googleapis.com/token"),
                    "iat": now,
                    "exp": now + 3600,
                },
                separators=(",", ":"),
            ).encode()
        )
        signing_input = f"{header}.{payload}".encode("ascii")
        with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as tf:
            tf.write(sa["private_key"])
            key_path = tf.name
        try:
            sig = subprocess.check_output(
                ["openssl", "dgst", "-sha256", "-sign", key_path],
                input=signing_input,
            )
        finally:
            try:
                os.unlink(key_path)
            except OSError:
                pass
        assertion = f"{header}.{payload}.{_b64url(sig)}"
        body = urllib.parse.urlencode(
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            sa.get("token_uri", "https://oauth2.googleapis.com/token"),
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))["access_token"]

    def _token_from_refresh(self, refresh_token: str, client_id: str, client_secret: str) -> str:
        body = urllib.parse.urlencode(
            {
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            "https://oauth2.googleapis.com/token",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))["access_token"]

    def _api_headers(self):
        return {"Authorization": f"Bearer {self.access_token}"} if self.access_token else {}

    def list_folder(self, fid: str, exts=(".glb", ".gltf", ".json")) -> dict:
        if self.mode == "cli":
            out = subprocess.check_output(["gdrive", "readonly", "ls", fid, "--json"], text=True)
            data = json.loads(out)
            items = data.get("files", []) if isinstance(data, dict) else data
        else:
            items = []
            page_token = None
            while True:
                params = {
                    "q": f"'{fid}' in parents and trashed = false",
                    "fields": "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
                    "pageSize": "1000",
                    "supportsAllDrives": "true",
                    "includeItemsFromAllDrives": "true",
                }
                if self.api_key:
                    params["key"] = self.api_key
                if page_token:
                    params["pageToken"] = page_token
                url = "https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode(params)
                req = urllib.request.Request(url, headers=self._api_headers())
                with urllib.request.urlopen(req, timeout=30) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                items.extend(payload.get("files", []))
                page_token = payload.get("nextPageToken")
                if not page_token:
                    break

        best = {}
        for it in items:
            fn = it.get("name", "")
            if it.get("mimeType") == "application/vnd.google-apps.folder":
                continue
            if fn.startswith("_") or fn == "dalat_master_scene.glb":
                continue
            if not fn.endswith(exts):
                continue
            if fn not in best or it.get("modifiedTime", "") > best[fn].get("modifiedTime", ""):
                best[fn] = it
        return best

    def download(self, file_id: str, dest: pathlib.Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".tmp")
        try:
            if self.mode == "cli":
                subprocess.check_call(
                    ["gdrive", "readonly", "download", file_id, "--out", str(tmp)],
                    stdout=subprocess.DEVNULL,
                )
            else:
                params = {"alt": "media", "supportsAllDrives": "true"}
                if self.api_key:
                    params["key"] = self.api_key
                url = f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(file_id)}?" + urllib.parse.urlencode(params)
                req = urllib.request.Request(url, headers=self._api_headers())
                with urllib.request.urlopen(req, timeout=180) as resp, tmp.open("wb") as out_f:
                    shutil.copyfileobj(resp, out_f)
            tmp.replace(dest)
        except Exception:
            if tmp.exists():
                tmp.unlink()
            raise


def is_valid_glb(path: pathlib.Path) -> bool:
    if not path.exists() or path.stat().st_size < 20:
        return False
    with path.open("rb") as f:
        head = f.read(12)
    magic, version, length = struct.unpack("<4sII", head)
    return magic == b"glTF" and version == 2 and length <= path.stat().st_size + 4


def scan_dir(subdir, exts, name_filter=None):
    d = ASSETS / subdir
    items = []
    if not d.exists():
        return items
    for f in sorted(d.iterdir(), key=lambda p: p.name):
        if not f.is_file() or f.name.startswith("_"):
            continue
        if f.suffix.lower() not in exts:
            continue
        if name_filter and not name_filter(f.name):
            continue
        m = TILE_ID_REGEX.search(f.name)
        items.append({
            "id": f.stem,
            "filename": f.name,
            "ext": f.suffix.lower(),
            "tile_id": m.group(1) if m else None,
            "url": f"./assets/{subdir}/{urllib.parse.quote(f.name)}",
            "size_bytes": f.stat().st_size,
        })
    return items


def dedupe_by_tile(items):
    seen = set()
    out = []
    for it in items:
        tid = it.get("tile_id")
        if tid:
            if tid in seen:
                continue
            seen.add(tid)
        out.append(it)
    return out


def tile_dist_key(it):
    tid = it.get("tile_id")
    if not tid:
        return (0, 0)
    m = re.match(r"T_([EW])(\d{2})_([NS])(\d{2})", tid)
    if not m:
        return (1, 999)
    ix = int(m.group(2)) * (1 if m.group(1) == "E" else -1)
    iy = int(m.group(4)) * (1 if m.group(3) == "N" else -1)
    return (0, ix * ix + iy * iy)


def compute_shadowed_paths(folder_cache: dict) -> set[str]:
    """Xác định các file bị phủ bởi tầng ưu tiên cao hơn hoặc heightmap không dùng trên web."""
    fid_by_sub = dict(ASSET_FOLDERS)
    shadowed = set()

    for subdirs, exts, pred in DEDUPE_PRIORITY_GROUPS:
        seen_tids = set()
        for sub in subdirs:
            fid = fid_by_sub.get(sub)
            if not fid or fid not in folder_cache:
                continue
            for fn in sorted(folder_cache[fid].keys()):
                if not fn.lower().endswith(exts):
                    continue
                if pred and not pred(fn):
                    continue
                m = TILE_ID_REGEX.search(fn)
                if not m:
                    continue
                tid = m.group(1)
                if tid in seen_tids:
                    shadowed.add(f"assets/{sub}/{fn}")
                else:
                    seen_tids.add(tid)

    # heightmap_*.json chỉ dùng trong pipeline Python offline, trình xem WebGL không tải
    for sub in ("satellite_dem_tiles", "terrain_tiles", "terrain_tiles_ring1_ext", "terrain_tiles_ring2"):
        fid = fid_by_sub.get(sub)
        if fid and fid in folder_cache:
            for fn in folder_cache[fid].keys():
                if fn.startswith("heightmap_") and fn.endswith(".json"):
                    shadowed.add(f"assets/{sub}/{fn}")

    return shadowed


def prune_shadowed_local_files(shadowed_paths: set[str]) -> int:
    removed = 0
    for rel in sorted(shadowed_paths):
        p = ROOT / rel
        if p.exists() and p.is_file():
            p.unlink()
            removed += 1
    # Dọn thêm heightmap_*.json cũ tồn dư trên ổ đĩa nếu có
    for sub in ("satellite_dem_tiles", "terrain_tiles", "terrain_tiles_ring1_ext", "terrain_tiles_ring2"):
        d = ASSETS / sub
        if d.exists():
            for p in d.glob("heightmap_*.json"):
                p.unlink()
                removed += 1
    return removed


def read_glb_bbox_center(path: pathlib.Path):
    """Fast glTF 2.0 JSON-chunk bounding-box center reader (world X, Y, Z)."""
    try:
        with path.open("rb") as f:
            hdr = f.read(12)
            if len(hdr) < 12 or hdr[:4] != b"glTF":
                return None
            jlen, _ = struct.unpack("<II", f.read(8))
            j = json.loads(f.read(jlen).decode("utf-8"))
        accs = j.get("accessors", [])
        meshes = j.get("meshes", [])
        nodes = j.get("nodes", [])
        scenes = j.get("scenes", [])
        roots = scenes[j.get("scene", 0)].get("nodes", []) if scenes else list(range(len(nodes)))
        mins = [1e18, 1e18, 1e18]
        maxs = [-1e18, -1e18, -1e18]

        def visit(ni, ox, oy, oz):
            n = nodes[ni]
            if "matrix" in n:
                m = n["matrix"]
                nx, ny, nz = ox + m[12], oy + m[13], oz + m[14]
            else:
                t = n.get("translation", [0.0, 0.0, 0.0])
                nx, ny, nz = ox + t[0], oy + t[1], oz + t[2]
            if "mesh" in n:
                for prim in meshes[n["mesh"]].get("primitives", []):
                    pi = prim.get("attributes", {}).get("POSITION")
                    if pi is not None and "min" in accs[pi] and "max" in accs[pi]:
                        a = accs[pi]
                        for i, o in enumerate((nx, ny, nz)):
                            mins[i] = min(mins[i], o + a["min"][i])
                            maxs[i] = max(maxs[i], o + a["max"][i])
            for c in n.get("children", []):
                visit(c, nx, ny, nz)

        for r in roots:
            visit(r, 0.0, 0.0, 0.0)
        if mins[0] > 1e17:
            return None
        return (
            0.5 * (mins[0] + maxs[0]),
            0.5 * (mins[1] + maxs[1]),
            0.5 * (mins[2] + maxs[2]),
            maxs[0] - mins[0],
            maxs[2] - mins[2],
        )
    except Exception:
        return None


def xy_to_tile_id(x_m: float, y_north_m: float) -> str:
    ix = int(math.floor((x_m + 1000.0) / 2000.0))
    iy = int(math.floor((y_north_m + 1000.0) / 2000.0))
    ew = "W" if ix < 0 else "E"
    ns = "S" if iy < 0 else "N"
    return f"T_{ew}{abs(ix):02d}_{ns}{abs(iy):02d}"


def load_all_placement_manifests():
    """Load placement coordinates & metadata from ALL 4 landmark/villa/complex manifests."""
    catalog = {}
    replaced_slot4_ids = set()
    specs = [
        (ASSETS / "landmarks/landmarks_manifest.json", "landmarks"),
        (ASSETS / "hero_landmarks_ultra/hero_landmarks_manifest.json", "landmarks_ultra"),
        (ASSETS / "french_villas/french_villas_manifest.json", "villas"),
        (ASSETS / "tourism_complexes/tourism_complexes_manifest.json", "complexes"),
    ]
    for fp, list_key in specs:
        if not fp.exists():
            continue
        try:
            doc = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        for entry in doc.get(list_key, []):
            eid = entry.get("id")
            if not eid:
                continue
            gpos = entry.get("gltf_position")
            if not (isinstance(gpos, list) and len(gpos) == 3):
                if entry.get("x_m") is not None and entry.get("y_m") is not None:
                    gpos = [float(entry["x_m"]), float(entry.get("z_local_m", 0.0)), -float(entry["y_m"])]
                elif entry.get("lat") is not None and entry.get("lon") is not None:
                    xm = (float(entry["lon"]) - 108.445259) * 108911.0
                    ym = (float(entry["lat"]) - 11.940419) * 111319.49
                    zl = float(entry.get("elev_msl_m", 1478.0)) - 1478.0
                    gpos = [round(xm, 3), round(zl, 3), round(-ym, 3)]
            tid = entry.get("tile_id")
            if not tid and isinstance(gpos, list) and len(gpos) == 3:
                tid = xy_to_tile_id(float(gpos[0]), -float(gpos[2]))
            catalog[eid] = {
                "id": eid,
                "name_vi": entry.get("name_vi") or eid,
                "name_en": entry.get("name_en") or "",
                "tile_id": tid,
                "gltf_position": gpos,
                "rotation_y_rad": float(entry.get("rotation_y_rad", 0.0) or 0.0),
                "architectural_style": entry.get("architectural_style") or "",
                "year_completed": str(entry.get("year_completed") or ""),
                "description_vi": entry.get("description_vi") or "",
                "replaces_slot4_id": entry.get("replaces_slot4_id"),
                "is_french_villa": list_key == "villas",
            }
            rep = entry.get("replaces_slot4_id")
            if rep:
                replaced_slot4_ids.add(rep)
    return catalog, replaced_slot4_ids


def rebuild_world_index():
    import math as _math
    globals()["math"] = _math

    # 1. Terrain tiles (+ seamless 60km Copernicus GLO-30 horizon backdrop first!)
    raw_terrain = dedupe_by_tile(
        scan_dir("satellite_dem_tiles", {".glb", ".gltf"})
        + scan_dir("terrain_tiles", {".glb", ".gltf"})
        + scan_dir("terrain_tiles_ring1_ext", {".glb", ".gltf"})
        + scan_dir("terrain_tiles_ring2", {".glb", ".gltf"})
    )
    backdrop_items = []
    tiled_terrain = []
    for it in raw_terrain:
        if "backdrop" in it["filename"].lower():
            it["is_backdrop"] = True
            it["tile_id"] = "T_E00_N00"
            backdrop_items.append(it)
        else:
            tiled_terrain.append(it)
    terrain_glb = backdrop_items + sorted(tiled_terrain, key=tile_dist_key)

    terrain_hm = sorted(dedupe_by_tile(
        scan_dir("satellite_dem_tiles", {".json"}, lambda n: n.startswith("heightmap_"))
        + scan_dir("terrain_tiles", {".json"}, lambda n: n.startswith("heightmap_"))
        + scan_dir("terrain_tiles_ring1_ext", {".json"}, lambda n: n.startswith("heightmap_"))
        + scan_dir("terrain_tiles_ring2", {".json"}, lambda n: n.startswith("heightmap_"))
    ), key=tile_dist_key)

    # 2. Water bodies (with exact tile_id from GLB bbox center; drop superseded RING_0 old lake GLBs)
    superseded_ring0_water = {
        "water_ho_chien_thang.glb",
        "water_ho_da_thien.glb",
        "water_ho_van_kiep.glb",
        "water_ho_me_linh.glb",
        "water_ho_hoang_van_thu.glb",
        "water_ho_dai_hoc.glb",
        "water_ho_nha_may_nuoc.glb",
    }
    raw_water = scan_dir("water_bodies", {".glb", ".gltf"}) + scan_dir("natural_wonders_pbr", {".glb", ".gltf"})
    water_glb = []
    for it in raw_water:
        fn = it["filename"]
        if fn in superseded_ring0_water and (ASSETS / "water_bodies" / "water_ring0_osm_lakes.glb").exists():
            continue
        p = ROOT / urllib.parse.unquote(it["url"].lstrip("./"))
        bb = read_glb_bbox_center(p)
        if fn == "water_ho_xuan_huong.glb" or fn == "water_ring0_osm_lakes.glb":
            it["tile_id"] = "T_E00_N00"
        elif bb:
            it["tile_id"] = xy_to_tile_id(bb[0], -bb[2])
        water_glb.append(it)

    veg_models = scan_dir("vegetation", {".glb", ".gltf"}) + scan_dir("vegetation_expanded", {".glb", ".gltf"})
    veg_instances = sorted(dedupe_by_tile(
        scan_dir("vegetation", {".json"}, lambda n: n.startswith("instances_"))
        + scan_dir("vegetation_expanded", {".json"}, lambda n: n.startswith("instances_"))
    ), key=tile_dist_key)

    # 3. Landmarks + Hero Ultra + French Villas + Tourism Complexes (ALL 4 manifests merged, deduped, ZERO origin pile-ups!)
    manifest_catalog, replaced_slot4_ids = load_all_placement_manifests()
    raw_landmarks = (
        scan_dir("hero_landmarks_ultra", {".glb", ".gltf"})
        + scan_dir("landmarks", {".glb", ".gltf"})
        + scan_dir("french_villas", {".glb", ".gltf"})
        + scan_dir("tourism_complexes", {".glb", ".gltf"})
        + scan_dir("agri_landscapes", {".glb", ".gltf"})
        + scan_dir("ring3_districts_ultra", {".glb", ".gltf"})
    )
    # Include sourced_library landmarks only if not already replaced by hero_landmarks_ultra
    raw_landmarks += scan_dir("sourced_library/landmarks", {".glb", ".gltf"})

    superseded_tourism_ids = {
        "tc_03_chua_linh_phuoc_ve_chai_complex",       # superseded by ultra_lm_16_chua_linh_phuoc
        "tc_04_domaine_de_marie_and_cam_ly_churches",  # superseded by ultra_lm_10_domaine_de_marie & ultra_lm_26_nha_tho_cam_ly
        "tc_05_vuon_hoa_tp_and_thung_lung_tinh_yeu",   # superseded by ultra_lm_14_vuon_hoa_tp (fixed OSM coords) & ultra_lm_17_thung_lung_tinh_yeu
    }
    landmarks_glb = []
    seen_lm_ids = set()
    quarantined_origin = 0
    for it in raw_landmarks:
        lm_id = it["id"]
        if lm_id in seen_lm_ids or lm_id in superseded_tourism_ids:
            continue
        # Skip old Slot-4 landmark when replaced by Ultra-LOD0 hero landmark!
        if lm_id in replaced_slot4_ids and not it["url"].startswith("./assets/hero_landmarks_ultra/"):
            continue
        meta = manifest_catalog.get(lm_id)
        p = ROOT / urllib.parse.unquote(it["url"].lstrip("./"))
        bb = read_glb_bbox_center(p)
        is_local_pivot = bb is not None and _math.hypot(bb[0], bb[2]) < 160.0 and max(bb[3], bb[4]) < 450.0

        if meta and isinstance(meta.get("gltf_position"), list) and len(meta["gltf_position"]) == 3:
            gp = meta["gltf_position"]
            # World-baked multi-site complexes (tc_02, tc_06..tc_10) have gp=[0,0,0] and non-local world bbox
            is_world_baked = (not is_local_pivot) and _math.hypot(float(gp[0]), float(gp[2])) < 1.0
            it["gltf_position"] = [0.0, 0.0, 0.0] if is_world_baked else gp
            it["rotation_y_rad"] = 0.0 if is_world_baked else meta.get("rotation_y_rad", 0.0)
            it["name_vi"] = meta.get("name_vi") or lm_id
            it["name_en"] = meta.get("name_en") or ""
            if is_world_baked and bb:
                it["tile_id"] = xy_to_tile_id(bb[0], -bb[2])
            else:
                it["tile_id"] = meta.get("tile_id") or xy_to_tile_id(float(gp[0]), -float(gp[2]))
            it["is_french_villa"] = bool(meta.get("is_french_villa", False))
            if meta.get("architectural_style"):
                it["architectural_style"] = meta["architectural_style"]
            if meta.get("description_vi"):
                it["description_vi"] = meta["description_vi"]
        elif is_local_pivot:
            # HARD GUARD: never allow an unplaced local-pivot building to dump at (0,0,0) in Ho Xuan Huong!
            quarantined_origin += 1
            continue
        elif bb:
            # Already in world coordinates -> compute exact real tile_id from GLB world center!
            it["tile_id"] = it.get("tile_id") or xy_to_tile_id(bb[0], -bb[2])

        seen_lm_ids.add(lm_id)
        landmarks_glb.append(it)

    if quarantined_origin:
        print(f"[WORLD-INDEX] Quarantined {quarantined_origin} unplaced local-origin GLBs (protected Ho Xuan Huong).", flush=True)

    props = []
    if (ASSETS / "sourced_library/urban_props/prop_01_hxh_pedal_duck_boat.glb").exists():
        for i, (gx, gy, gz, ry) in enumerate([
            (-520.0, 0.08, -75.0, 0.6), (-485.0, 0.08, -92.0, 1.9), (-445.0, 0.08, -62.0, -0.8),
            (-110.0, 0.08, 15.0, 2.4), (-65.0, 0.08, 35.0, -1.2), (180.0, 0.08, -30.0, 0.9),
        ], 1):
            props.append({"id": f"hxh_duck_boat_{i}", "url": "./assets/sourced_library/urban_props/prop_01_hxh_pedal_duck_boat.glb", "gltf_position": [gx, gy, gz], "rotation_y_rad": ry})

    # 4. Real OpenStreetMap 3D Roads ONLY (purge legacy fake synthetic/spline roads & misplaced lake overlays!)
    roads_glb = sorted(
        scan_dir("osm_true_roads_hydro", {".glb", ".gltf"}, lambda n: n.startswith("osm_real_roads_")),
        key=tile_dist_key,
    )
    # Also allow localized verified non-RING_0 mountain passes (outside 3km core) with exact bbox tile_id
    for it in scan_dir("transport_infra", {".glb", ".gltf"}):
        fn = it["filename"]
        if any(skip in fn for skip in ("ke_ho_lan_can_da", "taluy_da_che_xanh", "cau_ong_dao", "vong_xoay_dai_phun_nuoc")):
            continue
        p = ROOT / urllib.parse.unquote(it["url"].lstrip("./"))
        bb = read_glb_bbox_center(p)
        if bb and _math.hypot(bb[0], bb[2]) > 3400.0:
            it["tile_id"] = xy_to_tile_id(bb[0], -bb[2])
            roads_glb.append(it)

    # 5. Buildings (deduplicated by tile, osm_true_buildings wins over legacy building_tiles)
    buildings_glb = sorted(dedupe_by_tile(
        scan_dir("osm_true_buildings", {".glb", ".gltf"})
        + scan_dir("building_tiles", {".glb", ".gltf"})
        + scan_dir("urban_wards_tiles", {".glb", ".gltf"})
    ), key=tile_dist_key)

    total_glb = len(terrain_glb) + len(water_glb) + len(veg_models) + len(landmarks_glb) + len(roads_glb) + len(buildings_glb)
    discovered = sorted({it["tile_id"] for lst in [terrain_glb, terrain_hm, veg_instances, buildings_glb, landmarks_glb, roads_glb] for it in lst if it.get("tile_id")})
    world_index = {
        "schema_version": "2.0.0",
        "project": "DALAT_3D_SIMULATION",
        "dem_source": "ESA Copernicus GLO-30 DEM + Official OSM API v0.6 + Esri World Imagery",
        "static_build": True,
        "has_real_assets": total_glb > 0 or len(veg_instances) > 0,
        "total_glb_count": total_glb,
        "discovered_tile_ids": discovered,
        "refs": {
            "master_scene_glb_url": None,
            "camera_presets_url": "./data/world_ui_specs/camera_presets_dalat.json",
            "core_seeds_url": "./data/references/dalat_core_seeds.json",
            "tile_grid_spec_url": "./state/TILE_GRID_SPEC.json",
        },
        "counts": {
            "terrain_tiles": len(terrain_glb),
            "heightmaps": len(terrain_hm),
            "water_bodies": len(water_glb),
            "vegetation_models": len(veg_models),
            "vegetation_instances": len(veg_instances),
            "landmarks": len(landmarks_glb),
            "lakeside_props": len(props),
            "roads_infrastructure": len(roads_glb),
            "building_tiles": len(buildings_glb),
        },
        "layers": {
            "terrain": terrain_glb,
            "heightmaps": terrain_hm,
            "water": water_glb,
            "vegetation_models": veg_models,
            "vegetation_instances": veg_instances,
            "landmarks": landmarks_glb,
            "props": props,
            "roads": roads_glb,
            "buildings": buildings_glb,
        },
    }
    (ROOT / "api").mkdir(exist_ok=True)
    (ROOT / "api/world-index.json").write_text(json.dumps(world_index, ensure_ascii=False, indent=2), encoding="utf-8")
    return world_index


def append_step_summary(lines: list[str]) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--init-baseline", action="store_true")
    parser.add_argument("--push", action="store_true")
    parser.add_argument("--sync-viewer", action="store_true", help="Cho phép đồng bộ cả web_viewer HTML/CSS/JS từ Drive")
    parser.add_argument("--no-prune", action="store_true", help="Không dọn các tile cũ bị phủ bởi bản mới hơn")
    parser.add_argument("--rebuild-index-only", action="store_true", help="Chỉ xây dựng lại api/world-index.json từ thư mục assets cục bộ")
    args = parser.parse_args()

    if args.rebuild_index_only:
        wi = rebuild_world_index()
        print(
            f"[DALAT SYNC] Rebuilt api/world-index.json: {wi['total_glb_count']} GLBs, "
            f"{len(wi['discovered_tile_ids'])} discovered tiles, counts={wi['counts']}",
            flush=True,
        )
        return 0

    try:
        client = DriveClient()
    except RuntimeError as exc:
        msg = f"[DALAT SYNC] Bỏ qua: {exc}"
        print(msg, flush=True)
        append_step_summary(["### Dalat 3D Sync — Chưa cấu hình thông tin xác thực Google Drive", f"- {exc}"])
        return 1 if os.environ.get("REQUIRE_DRIVE_AUTH") == "1" else 0

    old_state = json.loads(STATE_FILE.read_text(encoding="utf-8")) if STATE_FILE.exists() else {}
    new_state = {}
    targets = {}

    # Bảo vệ các tệp lõi chuẩn ESA Copernicus GLO-30 & OSM API v0.6 khỏi bị ghi đè bởi dữ liệu lỗi từ Drive
    protected_core_tids = {
        f"T_{'W' if ix < 0 else 'E'}{abs(ix):02d}_{'S' if iy < 0 else 'N'}{abs(iy):02d}"
        for iy in range(-2, 3) for ix in range(-2, 3)
    }
    ring0_tids = {
        f"T_{'W' if ix < 0 else 'E'}{abs(ix):02d}_{'S' if iy < 0 else 'N'}{abs(iy):02d}"
        for iy in (-1, 0, 1) for ix in (-1, 0, 1)
    }
    protected_paths = (
        {f"assets/satellite_dem_tiles/{p.name}" for p in (ASSETS / "satellite_dem_tiles").glob("terrain_real_*.glb")}
        | {"assets/satellite_dem_tiles/terrain_backdrop_dalat_60km.glb"}
        | {"assets/water_bodies/water_ho_xuan_huong.glb", "assets/water_bodies/water_ring0_osm_lakes.glb"}
        | {f"assets/osm_true_roads_hydro/osm_real_roads_{tid}.glb" for tid in ring0_tids}
        | {f"assets/osm_true_buildings/osm_buildings_{tid}.glb" for tid in ring0_tids}
        | {f"assets/vegetation/instances_{tid}.json" for tid in ring0_tids}
    )

    folder_jobs = {v[0]: (".glb", ".gltf", ".json") for v in DATA_FILES.values()}
    for _, fid in ASSET_FOLDERS:
        folder_jobs[fid] = (".glb", ".gltf", ".json")
    if args.sync_viewer:
        for _, fid, exts in WEB_VIEWER_FOLDERS:
            folder_jobs[fid] = exts

    folder_cache = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        futs = {fid: ex.submit(client.list_folder, fid, exts) for fid, exts in folder_jobs.items()}
        for fid, fut in futs.items():
            folder_cache[fid] = fut.result()

    shadowed = set() if args.no_prune else compute_shadowed_paths(folder_cache)

    for rel_path, (fid, drive_name) in DATA_FILES.items():
        if drive_name in folder_cache[fid]:
            targets[rel_path] = folder_cache[fid][drive_name]
    for subdir, fid in ASSET_FOLDERS:
        for fn, it in folder_cache[fid].items():
            rel = f"assets/{subdir}/{fn}"
            if rel in shadowed or (rel in protected_paths and (ROOT / rel).exists()):
                continue
            targets[rel] = it
    if args.sync_viewer:
        for subdir, fid, _ in WEB_VIEWER_FOLDERS:
            for fn, it in folder_cache[fid].items():
                rel = f"{subdir}/{fn}" if subdir else fn
                targets[rel] = it

    changed = []
    for rel_path, it in sorted(targets.items()):
        sig = {"id": it["id"], "modifiedTime": it.get("modifiedTime", ""), "size": str(it.get("size", ""))}
        new_state[rel_path] = sig
        local_file = ROOT / rel_path
        if args.init_baseline and local_file.exists():
            continue
        if old_state.get(rel_path) != sig or not local_file.exists():
            changed.append((rel_path, it["id"]))

    print(
        f"[DALAT SYNC] Backend={client.mode} | Active targets={len(targets)} (shadowed/skipped={len(shadowed)}) | Changed/new={len(changed)}",
        flush=True,
    )
    for rel_path, _ in changed[:20]:
        print(f"  -> {rel_path}", flush=True)
    if len(changed) > 20:
        print(f"  ... and {len(changed) - 20} more", flush=True)

    applied = []
    skipped = []
    pruned = 0

    if not args.dry_run and changed:
        def dl(item):
            rel_path, fid = item
            dest = ROOT / rel_path
            with tempfile.TemporaryDirectory() as td:
                tmp_path = pathlib.Path(td) / dest.name
                client.download(fid, tmp_path)
                if rel_path.endswith(".glb") and not is_valid_glb(tmp_path):
                    return (rel_path, False, "invalid glTF 2.0 header")
                if rel_path.endswith(".json"):
                    json.loads(tmp_path.read_text(encoding="utf-8"))
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(tmp_path), str(dest))
                return (rel_path, True, "ok")

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            for rel_path, ok, note in ex.map(dl, changed):
                if ok:
                    applied.append(rel_path)
                else:
                    skipped.append((rel_path, note))
                    if rel_path in old_state:
                        new_state[rel_path] = old_state[rel_path]
                    print(f"  [WARN] Skipped {rel_path}: {note}", flush=True)

    if not args.dry_run:
        if not args.no_prune:
            pruned = prune_shadowed_local_files(shadowed)
            if pruned:
                print(f"[DALAT SYNC] Pruned {pruned} shadowed/unused local files.", flush=True)
        world_index = rebuild_world_index()
        STATE_FILE.write_text(json.dumps(new_state, ensure_ascii=False, indent=2), encoding="utf-8")
        print(
            f"[DALAT SYNC] Rebuilt api/world-index.json: {world_index['total_glb_count']} GLBs, "
            f"{len(world_index['discovered_tile_ids'])} discovered tiles.",
            flush=True,
        )
        append_step_summary([
            f"### Dalat 3D Simulation — Drive Sync ({datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')})",
            f"- Backend: `{client.mode}` | Applied: **{len(applied)}** | Pruned shadowed: **{pruned}** | Skipped: **{len(skipped)}**",
            f"- World Index: **{world_index['total_glb_count']}** GLB | **{len(world_index['discovered_tile_ids'])}** Tile 3D",
        ])

    if args.push and not args.dry_run:
        st = subprocess.check_output(["git", "status", "--porcelain"], cwd=str(ROOT), text=True).strip()
        if st:
            subprocess.check_call(["git", "add", "-A"], cwd=str(ROOT))
            subprocess.check_call(
                ["git", "commit", "-m", f"chore(sync): update {len(applied)} Dalat 3D assets from Google Drive"],
                cwd=str(ROOT),
            )
            subprocess.check_call(["git", "push", "origin", "main"], cwd=str(ROOT))
            print("[DALAT SYNC] Pushed updates to GitHub Pages.", flush=True)
        else:
            print("[DALAT SYNC] No changes to push.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
