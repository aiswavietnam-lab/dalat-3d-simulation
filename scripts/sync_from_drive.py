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


def rebuild_world_index():
    terrain_glb = sorted(dedupe_by_tile(
        scan_dir("satellite_dem_tiles", {".glb", ".gltf"})
        + scan_dir("terrain_tiles", {".glb", ".gltf"})
        + scan_dir("terrain_tiles_ring1_ext", {".glb", ".gltf"})
        + scan_dir("terrain_tiles_ring2", {".glb", ".gltf"})
    ), key=tile_dist_key)
    terrain_hm = sorted(dedupe_by_tile(
        scan_dir("satellite_dem_tiles", {".json"}, lambda n: n.startswith("heightmap_"))
        + scan_dir("terrain_tiles", {".json"}, lambda n: n.startswith("heightmap_"))
        + scan_dir("terrain_tiles_ring1_ext", {".json"}, lambda n: n.startswith("heightmap_"))
        + scan_dir("terrain_tiles_ring2", {".json"}, lambda n: n.startswith("heightmap_"))
    ), key=tile_dist_key)
    water_glb = scan_dir("water_bodies", {".glb", ".gltf"}) + scan_dir("natural_wonders_pbr", {".glb", ".gltf"})
    veg_models = scan_dir("vegetation", {".glb", ".gltf"}) + scan_dir("vegetation_expanded", {".glb", ".gltf"})
    veg_instances = sorted(dedupe_by_tile(
        scan_dir("vegetation", {".json"}, lambda n: n.startswith("instances_"))
        + scan_dir("vegetation_expanded", {".json"}, lambda n: n.startswith("instances_"))
    ), key=tile_dist_key)
    raw_landmarks = (
        scan_dir("hero_landmarks_ultra", {".glb", ".gltf"})
        + scan_dir("landmarks", {".glb", ".gltf"})
        + scan_dir("french_villas", {".glb", ".gltf"})
        + scan_dir("tourism_complexes", {".glb", ".gltf"})
        + scan_dir("agri_landscapes", {".glb", ".gltf"})
        + scan_dir("ring3_districts_ultra", {".glb", ".gltf"})
    )
    scene_idx_path = ASSETS / "scene" / "world_index.json"
    landmarks_glb = raw_landmarks
    if scene_idx_path.exists():
        sidx = json.loads(scene_idx_path.read_text(encoding="utf-8"))
        slms = sidx.get("layers", {}).get("landmarks", [])
        if slms:
            known = {x["id"] for x in slms}
            extra = [x for x in raw_landmarks if x["id"] not in known]
            mapped = []
            for lm in slms:
                rel = str(lm.get("path", "")).replace("02_ASSETS_3D/", "", 1)
                parts = "/".join(urllib.parse.quote(p) for p in rel.split("/"))
                lm_id = lm["id"]
                mapped.append({
                    "id": lm_id,
                    "name_vi": lm.get("name_vi") or lm_id,
                    "filename": pathlib.Path(lm.get("path", f"{lm_id}.glb")).name,
                    "ext": ".glb",
                    "tile_id": lm.get("tile_id") or "T_E00_N00",
                    "source_tier": lm.get("source_tier") or "slot4_detailed",
                    "url": f"./assets/{parts}",
                    "size_bytes": lm.get("size_bytes", 0),
                    "placement": lm.get("placement"),
                })
            landmarks_glb = mapped + extra
    props = []
    if (ASSETS / "sourced_library/urban_props/prop_01_hxh_pedal_duck_boat.glb").exists():
        for i, (gx, gy, gz, ry) in enumerate([
            (-520.0, 0.08, -75.0, 0.6), (-485.0, 0.08, -92.0, 1.9), (-445.0, 0.08, -62.0, -0.8),
            (-110.0, 0.08, 15.0, 2.4), (-65.0, 0.08, 35.0, -1.2), (180.0, 0.08, -30.0, 0.9),
        ], 1):
            props.append({"id": f"hxh_duck_boat_{i}", "url": "./assets/sourced_library/urban_props/prop_01_hxh_pedal_duck_boat.glb", "gltf_position": [gx, gy, gz], "rotation_y_rad": ry})
    if (ASSETS / "sourced_library/urban_props/prop_03_lakeside_wooden_pier.glb").exists():
        props.append({"id": "hxh_thuy_ta_pier", "url": "./assets/sourced_library/urban_props/prop_03_lakeside_wooden_pier.glb", "gltf_position": [-555.0, 0.05, -88.0], "rotation_y_rad": -1.8})
    roads_glb = (
        scan_dir("osm_true_roads_hydro", {".glb", ".gltf"})
        + scan_dir("infrastructure_buildings", {".glb", ".gltf"})
        + scan_dir("transport_infra", {".glb", ".gltf"})
        + scan_dir("urban_life_props", {".glb", ".gltf"})
    )
    buildings_glb = sorted(dedupe_by_tile(
        scan_dir("osm_true_buildings", {".glb", ".gltf"})
        + scan_dir("building_tiles", {".glb", ".gltf"})
        + scan_dir("urban_wards_tiles", {".glb", ".gltf"})
    ), key=tile_dist_key)
    total_glb = len(terrain_glb) + len(water_glb) + len(veg_models) + len(landmarks_glb) + len(roads_glb) + len(buildings_glb)
    discovered = sorted({it["tile_id"] for lst in [terrain_glb, terrain_hm, veg_instances, buildings_glb, landmarks_glb] for it in lst if it.get("tile_id")})
    world_index = {
        "schema_version": "1.1.0",
        "project": "DALAT_3D_SIMULATION",
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
    args = parser.parse_args()

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
            if rel in shadowed:
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
