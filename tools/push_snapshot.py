from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SITE = PROJECT_ROOT / "work" / "site"


def run(command: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, check=check, text=True, capture_output=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Replace the generated snapshot branch safely.")
    parser.add_argument("--site", type=Path, default=DEFAULT_SITE)
    parser.add_argument("--remote", default="https://github.com/benzkanin41-alt/research-knowledge-dashboard.git")
    args = parser.parse_args()
    site = args.site.resolve()
    if not (site / "data" / "manifest.json").is_file():
        raise FileNotFoundError(f"ไม่พบ validated snapshot: {site}")

    manifest = json.loads((site / "data" / "manifest.json").read_text(encoding="utf-8"))
    message = f"Deploy snapshot {manifest['generated_at']}"
    with tempfile.TemporaryDirectory(prefix="research-dashboard-snapshot-git-") as temporary:
        checkout = Path(temporary) / "snapshot"
        shutil.copytree(site, checkout)
        run(["git", "init", "-b", "snapshot"], checkout)
        run(["git", "config", "user.name", "Codex Dashboard Publisher"], checkout)
        run(["git", "config", "user.email", "benzkanin41-alt@users.noreply.github.com"], checkout)
        run(["git", "add", "-A"], checkout)
        run(["git", "commit", "-m", message], checkout)
        commit = run(["git", "rev-parse", "HEAD"], checkout).stdout.strip()
        run(["git", "remote", "add", "origin", args.remote], checkout)
        remote = run(["git", "ls-remote", "--heads", "origin", "snapshot"], checkout, check=False)
        old_sha = remote.stdout.split()[0] if remote.returncode == 0 and remote.stdout.strip() else ""
        push = ["git", "push", "origin", "HEAD:refs/heads/snapshot"]
        if old_sha:
            push.append(f"--force-with-lease=refs/heads/snapshot:{old_sha}")
        run(push, checkout)
    print(json.dumps({"ok": True, "branch": "snapshot", "commit": commit, "previous_commit": old_sha or None}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
