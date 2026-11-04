"""Build the Firefox extension's zip for signing: dist/subtitle-sync-firefox-<version>.zip

    python tools/package_firefox.py

Paths in the zip always use forward slashes, as Mozilla requires (Windows PowerShell 5.1's
Compress-Archive writes backslashes). tests/ is left out, and the build fails if a file the extension
refers to is missing from the zip.
"""
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
EXT_DIR = REPO / "firefox-extension"
DIST_DIR = REPO / "dist"
RUNTIME_SUFFIXES = {".js", ".json", ".html", ".css", ".svg", ".png"}
LEFT_OUT_DIRS = {"tests", "__pycache__"}
FIXED_TIME = (2000, 1, 1, 0, 0, 0)  # so the same files give the same zip


class PackageError(Exception):
    pass


def read_manifest(ext_dir=EXT_DIR):
    return json.loads((ext_dir / "manifest.json").read_text(encoding="utf-8"))


def read_version(manifest):
    version = manifest.get("version", "")
    # Mozilla's rule: 1 to 4 numbers separated by dots, without leading zeros
    if not re.fullmatch(r"(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){0,3}", version):
        raise PackageError(f'manifest.json version "{version}" isn\'t valid: use up to 4 numbers separated by dots, like 0.2.1')
    return version


def runtime_files(ext_dir=EXT_DIR):
    """(files to ship as forward-slash paths, files left out)"""
    keep, skipped = [], []
    for path in sorted(p for p in ext_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(ext_dir).as_posix()
        parts = rel.split("/")
        if set(parts[:-1]) & LEFT_OUT_DIRS or any(x.startswith(".") for x in parts) or path.suffix.lower() not in RUNTIME_SUFFIXES:
            skipped.append(rel)
        else:
            keep.append(rel)
    return keep, skipped


def manifest_references(manifest):
    refs = list(manifest.get("background", {}).get("scripts", []))
    for entry in manifest.get("content_scripts", []):
        refs += entry.get("js", []) + entry.get("css", [])
    action = manifest.get("action", {})
    if action.get("default_popup"):
        refs.append(action["default_popup"])
    icon = action.get("default_icon")
    refs += list(icon.values()) if isinstance(icon, dict) else [icon] if icon else []
    refs += list(manifest.get("icons", {}).values())
    return refs


def missing_references(names, ext_dir=EXT_DIR):
    """Files named by the manifest, or by a shipped page or script, that aren't in the zip."""
    present = set(names)
    missing = [f"manifest.json -> {r}" for r in manifest_references(read_manifest(ext_dir)) if r not in present]
    patterns = {
        ".html": r"""(?:src|href)\s*=\s*["']([^"'#?:]+)["']""",
        ".js": r"""(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}/[^"']+)["']""",
    }
    for name in names:
        pattern = patterns.get(Path(name).suffix)
        if not pattern:
            continue
        for ref in re.findall(pattern, (ext_dir / name).read_text(encoding="utf-8")):
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), ref))
            if target not in present:
                missing.append(f"{name} -> {ref}")
    return missing


def build(ext_dir=EXT_DIR, dist_dir=DIST_DIR):
    """Build and check the zip. Returns (zip path, version, names, skipped)."""
    version = read_version(read_manifest(ext_dir))
    names, skipped = runtime_files(ext_dir)
    missing = missing_references(names, ext_dir)
    if missing:
        raise PackageError("The extension refers to files that wouldn't be in the zip:\n  " + "\n  ".join(missing))
    dist_dir.mkdir(parents=True, exist_ok=True)
    out = dist_dir / f"subtitle-sync-firefox-{version}.zip"
    tmp = out.with_suffix(".zip.tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name in names:
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, (ext_dir / name).read_bytes())
    tmp.replace(out)
    check_zip(out, names)
    return out, version, names, skipped


def check_zip(path, expected):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        # as stored in the zip's directory, because Python's namelist shows backslashes as slashes
        raw = [i.orig_filename for i in z.infolist()]
        if z.testzip() is not None:
            raise PackageError(f"{path} is damaged")
    if any("\\" in n for n in raw):
        raise PackageError(f"{path} has backslashes in its paths")
    if "manifest.json" not in names:
        raise PackageError(f"{path} has no manifest.json at its top level")
    if any(n.startswith("tests/") for n in names):
        raise PackageError(f"{path} contains tests")
    if names != list(expected):
        raise PackageError(f"{path} doesn't hold the expected files")


def main():
    try:
        out, version, names, skipped = build()
    except PackageError as err:
        print(f"Couldn't build the package: {err}", file=sys.stderr)
        return 1
    print(f"Built {out} (version {version}, {len(names)} files, {out.stat().st_size // 1024} KB)")
    print("Checked: manifest.json at the top, forward slashes only, no tests, every referenced file present.")
    if skipped:
        print(f"Left out: {', '.join(skipped)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
