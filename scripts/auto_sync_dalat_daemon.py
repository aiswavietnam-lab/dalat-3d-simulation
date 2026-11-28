#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
auto_sync_dalat_daemon.py — Trình đồng bộ ngầm tự động Google Drive -> GitHub Pages cho DALAT_3D_SIMULATION.

Hoạt động an toàn 100% ở chế độ nền (pythonw.exe + CREATE_NO_WINDOW):
1. Khóa độc quyền tiến trình (msvcrt) tại D:\\MAA\\OUTPUT\\02_NHAT_KY_HE_THONG_AI\\dalat_auto_sync\\sync.lock
   để tránh hai lượt chạy đồng thời.
2. Tự dò ổ Google Drive for Desktop đang mount (G:, I:, H:, F:, E:, D:) chứa DALAT_3D_SIMULATION.
3. Kiểm tra an toàn trước khi đồng bộ/đẩy: nếu repo đang có thay đổi chưa commit ở mã nguồn web
   (index.html, css/, js/, scripts/, .github/), chỉ đồng bộ asset cục bộ và KHÔNG tự động commit/push.
4. Chạy `sync_from_drive.py --sync-mode web_curated --pbr-buildings-scope core25` ẩn hoàn toàn.
5. Nếu có thay đổi mới thuộc `assets/`, `api/`, `data/`, tự động `git add`, `git commit`,
   `git pull --rebase --autostash origin main`, và `git push origin main` để GitHub Pages tự build web mới.
"""
import argparse
import datetime
import json
import os
import pathlib
import subprocess
import sys

if os.name == "nt":
    import msvcrt

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SYNC_SCRIPT = REPO_ROOT / "scripts" / "sync_from_drive.py"
LOG_DIR = pathlib.Path(r"D:\MAA\OUTPUT\02_NHAT_KY_HE_THONG_AI\dalat_auto_sync")
LOG_FILE = LOG_DIR / "dalat_auto_sync.log"
STATUS_FILE = LOG_DIR / "last_run_status.json"
LOCK_FILE = LOG_DIR / "sync.lock"

DRIVE_SUBPATH = pathlib.Path("My Drive") / "02 JOB" / "02 WORKING" / "VIBE CODE" / "DALAT_3D_SIMULATION"
CODE_PREFIXES = ("index.html", "css/", "js/", "scripts/", ".github/", ".gitignore")
ASSET_PREFIXES = ("assets/", "api/", "data/")
MAX_LOG_BYTES = 2 * 1024 * 1024
ICT_TZ = datetime.timezone(datetime.timedelta(hours=7))

NO_WIN_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _now_ict() -> str:
    return datetime.datetime.now(ICT_TZ).strftime("%Y-%m-%d %H:%M:%S+07:00")


def _rotate_log_if_needed() -> None:
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > MAX_LOG_BYTES:
            bak = LOG_FILE.with_suffix(".log.bak")
            if bak.exists():
                bak.unlink()
            LOG_FILE.replace(bak)
    except OSError:
        pass


def _log(msg: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    _rotate_log_if_needed()
    line = f"[{_now_ict()}] {msg}"
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def _write_status(status: str, detail: str, changed_assets: int = 0, commit_sha: str = "") -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "updated_at_ict": _now_ict(),
        "status": status,
        "detail": detail,
        "changed_assets": changed_assets,
        "commit_sha": commit_sha,
    }
    STATUS_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _discover_drive_root() -> pathlib.Path | None:
    for drv in ("G", "I", "H", "F", "E", "D"):
        cand = pathlib.Path(f"{drv}:/") / DRIVE_SUBPATH
        if cand.exists() and (cand / "00_STATE").exists():
            return cand
    return None


def _run_quiet(cmd: list[str], cwd: pathlib.Path, timeout: int = 900) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["GIT_TERMINAL_PROMPT"] = "0"
    return subprocess.run(
        cmd,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=NO_WIN_FLAGS,
        env=env,
    )


def _git_status_paths() -> list[tuple[str, str]]:
    res = _run_quiet(["git", "status", "--porcelain", "-uall"], REPO_ROOT, timeout=60)
    if res.returncode != 0:
        raise RuntimeError(f"git status failed: {res.stderr.strip()}")
    items = []
    for raw in res.stdout.splitlines():
        if len(raw) < 4:
            continue
        code = raw[:2]
        path_part = raw[3:].strip()
        if " -> " in path_part:
            path_part = path_part.split(" -> ", 1)[1].strip()
        path_part = path_part.strip('"')
        items.append((code, path_part.replace("\\", "/")))
    return items


def _acquire_lock():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fp = open(LOCK_FILE, "a+", encoding="utf-8")
    if os.name == "nt":
        try:
            msvcrt.locking(fp.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            fp.close()
            return None
    fp.seek(0)
    fp.truncate(0)
    fp.write(f"pid={os.getpid()} started={_now_ict()}\n")
    fp.flush()
    return fp


def _release_lock(fp) -> None:
    if fp is None:
        return
    try:
        if os.name == "nt":
            fp.seek(0)
            msvcrt.locking(fp.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    try:
        fp.close()
    except OSError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Đồng bộ thử không đẩy commit")
    args = parser.parse_args()

    lock_fp = _acquire_lock()
    if lock_fp is None:
        _log("[SKIP] Đã có một tiến trình auto_sync_dalat_daemon khác đang chạy.")
        return 0

    try:
        drive_root = _discover_drive_root()
        if drive_root is None:
            msg = "Google Drive for Desktop chưa gắn ổ DALAT_3D_SIMULATION."
            _log(f"[SKIP] {msg}")
            _write_status("SKIPPED_NO_DRIVE", msg)
            return 0

        pre_status = _git_status_paths()
        dirty_code_files = [p for _, p in pre_status if p.startswith(CODE_PREFIXES)]
        if dirty_code_files:
            _log(f"[WARN] Phát hiện mã nguồn web chưa commit ({dirty_code_files[:5]}), sẽ đồng bộ asset nhưng KHÔNG tự commit/push.")

        py_exe = pathlib.Path(sys.executable)
        if py_exe.name.lower() == "pythonw.exe":
            py_console = py_exe.with_name("python.exe")
            py_cmd = str(py_console if py_console.exists() else py_exe)
        else:
            py_cmd = str(py_exe)

        cmd = [
            py_cmd,
            "-X",
            "utf8",
            str(SYNC_SCRIPT),
            "--sync-mode",
            "web_curated",
            "--pbr-buildings-scope",
            "core25",
            "--local-drive-root",
            str(drive_root),
        ]
        _log(f"[START] Chạy sync_from_drive.py (drive_root={drive_root})")
        sync_res = _run_quiet(cmd, REPO_ROOT, timeout=900)
        for line in (sync_res.stdout or "").splitlines():
            if line.strip():
                _log(f"  | {line.strip()}")
        if sync_res.returncode != 0:
            err = (sync_res.stderr or sync_res.stdout or "").strip()[-400:]
            _log(f"[ERROR] sync_from_drive.py lỗi (code={sync_res.returncode}): {err}")
            _write_status("SYNC_ERROR", err)
            return sync_res.returncode

        post_status = _git_status_paths()
        asset_changes = [p for _, p in post_status if p.startswith(ASSET_PREFIXES)]

        if args.dry_run:
            _log(f"[DRY_RUN] Hoàn tất đồng bộ cục bộ. Số asset thay đổi: {len(asset_changes)}")
            _write_status("DRY_RUN_OK", f"{len(asset_changes)} asset files changed", changed_assets=len(asset_changes))
            return 0

        if dirty_code_files:
            msg = f"Đã đồng bộ cục bộ ({len(asset_changes)} asset), tạm hoãn git push vì có mã nguồn chưa commit: {dirty_code_files[:3]}"
            _log(f"[HOLD_PUSH] {msg}")
            _write_status("HOLD_DIRTY_CODE", msg, changed_assets=len(asset_changes))
            return 0

        if not asset_changes:
            _log("[OK] Không có asset 3D mới hoặc thay đổi cần đẩy lên GitHub.")
            _write_status("NO_CHANGES", "No new or updated assets from Drive.", changed_assets=0)
            return 0

        # Chỉ stage đúng 3 thư mục tài sản 3D & chỉ mục để giữ sạch nhánh main
        add_res = _run_quiet(["git", "add", "-A", "--", "assets", "api", "data"], REPO_ROOT, timeout=120)
        if add_res.returncode != 0:
            raise RuntimeError(f"git add failed: {add_res.stderr.strip()}")

        diff_res = _run_quiet(["git", "diff", "--cached", "--quiet"], REPO_ROOT, timeout=30)
        if diff_res.returncode == 0:
            _log("[OK] Không có thay đổi nào sau git add.")
            _write_status("NO_CHANGES", "Nothing staged after git add.", changed_assets=0)
            return 0

        ts_label = datetime.datetime.now(ICT_TZ).strftime("%Y-%m-%d %H:%M ICT")
        commit_msg = f"chore(auto-sync): update {len(asset_changes)} Dalat 3D assets from Drive ({ts_label})"
        commit_res = _run_quiet(["git", "commit", "-m", commit_msg], REPO_ROOT, timeout=120)
        if commit_res.returncode != 0:
            raise RuntimeError(f"git commit failed: {commit_res.stderr.strip() or commit_res.stdout.strip()}")

        pull_res = _run_quiet(["git", "pull", "--rebase", "--autostash", "origin", "main"], REPO_ROOT, timeout=180)
        if pull_res.returncode != 0:
            raise RuntimeError(f"git pull --rebase failed: {pull_res.stderr.strip() or pull_res.stdout.strip()}")

        push_res = _run_quiet(["git", "push", "origin", "main"], REPO_ROOT, timeout=600)
        if push_res.returncode != 0:
            raise RuntimeError(f"git push failed: {push_res.stderr.strip() or push_res.stdout.strip()}")

        sha_res = _run_quiet(["git", "rev-parse", "HEAD"], REPO_ROOT, timeout=15)
        sha = (sha_res.stdout or "").strip()
        _log(f"[PUSHED] Đã đẩy {len(asset_changes)} file lên origin/main -> {sha}")
        _write_status("PUSHED_OK", commit_msg, changed_assets=len(asset_changes), commit_sha=sha)
        return 0
    except Exception as exc:
        _log(f"[EXCEPTION] {exc}")
        _write_status("ERROR", str(exc))
        return 1
    finally:
        _release_lock(lock_fp)


if __name__ == "__main__":
    raise SystemExit(main())
