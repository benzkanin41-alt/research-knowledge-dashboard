from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any


VOLATILE_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache"}
VOLATILE_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".log",
    ".tmp",
    ".sqlite-wal",
    ".sqlite-shm",
    ".sqlite-journal",
}


def is_volatile(path: Path) -> bool:
    if any(part in VOLATILE_DIRS for part in path.parts):
        return True
    lowered = path.name.lower()
    return any(lowered.endswith(suffix) for suffix in VOLATILE_SUFFIXES)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def capture(root: Path) -> dict[str, Any]:
    root = root.resolve()
    files: dict[str, dict[str, Any]] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if is_volatile(relative):
            continue
        stat = path.stat()
        files[relative.as_posix()] = {
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
            "sha256": sha256_file(path),
        }
    return {
        "root": str(root),
        "file_count": len(files),
        "files": files,
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def compare(baseline: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    before = baseline["files"]
    after = current["files"]
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed = sorted(
        key
        for key in set(before) & set(after)
        if before[key] != after[key]
    )
    return {
        "ok": not (added or removed or changed),
        "added": added,
        "removed": removed,
        "changed": changed,
        "baseline_file_count": len(before),
        "current_file_count": len(after),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture or compare a read-only integrity manifest.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    capture_parser = subparsers.add_parser("capture")
    capture_parser.add_argument("--root", type=Path, required=True)
    capture_parser.add_argument("--output", type=Path, required=True)

    compare_parser = subparsers.add_parser("compare")
    compare_parser.add_argument("--root", type=Path, required=True)
    compare_parser.add_argument("--baseline", type=Path, required=True)
    compare_parser.add_argument("--output", type=Path)

    args = parser.parse_args()
    if args.command == "capture":
        manifest = capture(args.root)
        write_json(args.output.resolve(), manifest)
        print(json.dumps({"ok": True, "file_count": manifest["file_count"], "output": str(args.output.resolve())}))
        return 0

    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    result = compare(baseline, capture(args.root))
    if args.output:
        write_json(args.output.resolve(), result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
