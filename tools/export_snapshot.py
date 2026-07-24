from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_ROOT = PROJECT_ROOT / "site_template"
DEFAULT_OUTPUT = PROJECT_ROOT / "work" / "site"
DROP_KEYS = {
    "source_path",
    "source_directory",
    "session_token",
    "database_path",
    "source_roots",
    "canonical_md",
    "sha256",
    "raw_text",
}
WINDOWS_PATH_RE = re.compile(r"(?i)(?<![A-Za-z0-9])(?:[A-Z]:[\\/])[^\r\n\]\[(){}<>\"']+")
UNC_PATH_RE = re.compile(r"\\\\[^\s\\/]+[\\/][^\r\n\]\[(){}<>\"']+")
TOKEN_RE = re.compile(r"(?i)\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")


def compact_json(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8")


def write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def write_json(path: Path, payload: Any) -> None:
    write_bytes(path, compact_json(payload))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def readonly_connection(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    return connection


def assert_idle_database(path: Path) -> dict[str, Any] | None:
    with readonly_connection(path) as database:
        running = database.execute(
            "SELECT id,started_at,status FROM import_runs WHERE status IN ('queued','running') ORDER BY id DESC"
        ).fetchall()
        if running:
            raise RuntimeError(f"พบ import ที่กำลังทำงาน: {[dict(row) for row in running]}")
        latest = database.execute("SELECT * FROM import_runs ORDER BY id DESC LIMIT 1").fetchone()
        return dict(latest) if latest else None


def backup_database(source_path: Path, destination_path: Path) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    source = readonly_connection(source_path)
    destination = sqlite3.connect(destination_path)
    try:
        source.backup(destination, pages=16384)
        check = destination.execute("PRAGMA integrity_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"SQLite snapshot integrity_check ไม่ผ่าน: {check}")
    finally:
        destination.close()
        source.close()


def copy_runtime(local_root: Path, runtime_root: Path) -> None:
    runtime_root.mkdir(parents=True, exist_ok=True)
    for source in local_root.glob("*.py"):
        shutil.copy2(source, runtime_root / source.name)
    shutil.copy2(local_root / "config.json", runtime_root / "config.json")
    shutil.copytree(local_root / "web", runtime_root / "web", dirs_exist_ok=True)


def start_snapshot_server(runtime_root: Path, snapshot_db: Path):
    sys.path.insert(0, str(runtime_root))
    importlib.invalidate_caches()
    importlib.import_module("dashboard_final_user")
    server = importlib.import_module("server")
    resolved_server_db = Path(server.DB_PATH).resolve()
    if resolved_server_db != snapshot_db.resolve():
        raise RuntimeError(f"Runtime ใช้ฐานผิดไฟล์: {resolved_server_db} != {snapshot_db.resolve()}")
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.DashboardHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True, name="snapshot-runtime")
    thread.start()
    host, port = httpd.server_address
    return httpd, thread, f"http://{host}:{port}"


def fetch_bytes(url: str, timeout: int = 180) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "ResearchDashboardSnapshot/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_json(url: str, timeout: int = 180) -> Any:
    return json.loads(fetch_bytes(url, timeout=timeout).decode("utf-8"))


def fetch_json_with_retry(url: str, timeout: int = 180, attempts: int = 4) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fetch_json(url, timeout=timeout)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt >= attempts:
                break
            time.sleep(min(2 ** (attempt - 1), 4))
    raise RuntimeError(
        f"Snapshot API failed after {attempts} attempts: {url}: {last_error}"
    ) from last_error


def sanitize_string(value: str) -> str:
    value = WINDOWS_PATH_RE.sub("[local path hidden]", value)
    value = UNC_PATH_RE.sub("[local path hidden]", value)
    value = TOKEN_RE.sub("[secret hidden]", value)
    return value


def sanitize_payload(value: Any) -> Any:
    if isinstance(value, dict):
        clean: dict[str, Any] = {}
        for key, item in value.items():
            if str(key).lower() in DROP_KEYS:
                continue
            if str(key).lower() == "path" and isinstance(item, str) and (WINDOWS_PATH_RE.search(item) or UNC_PATH_RE.search(item)):
                continue
            clean[key] = sanitize_payload(item)
        return clean
    if isinstance(value, list):
        return [sanitize_payload(item) for item in value]
    if isinstance(value, str):
        return sanitize_string(value)
    return value


def active_stock_index(snapshot_db: Path) -> list[dict[str, Any]]:
    with sqlite3.connect(snapshot_db) as database:
        database.row_factory = sqlite3.Row
        rows = database.execute(
            """
            SELECT s.id,s.symbol,s.display_name,s.market,
                   COUNT(DISTINCT k.source_document_id) source_count,
                   MAX(k.report_date) latest_date,
                   COUNT(DISTINCT k.id) knowledge_count
            FROM stocks s
            JOIN knowledge_items k ON k.stock_id=s.id
            JOIN source_documents d ON d.id=k.source_document_id AND d.active=1
            GROUP BY s.id
            HAVING COUNT(DISTINCT k.id)>0
            ORDER BY latest_date DESC,s.symbol
            """
        ).fetchall()
        alias_rows = database.execute("SELECT stock_id,alias FROM stock_aliases ORDER BY LENGTH(alias) DESC").fetchall()
    aliases: dict[int, list[str]] = {}
    for row in alias_rows:
        aliases.setdefault(int(row["stock_id"]), []).append(str(row["alias"]))
    result: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["aliases"] = aliases.get(int(item["id"]), [])
        item["search_text"] = " ".join(
            [str(item.get("symbol") or ""), str(item.get("display_name") or ""), *item["aliases"]]
        )
        result.append(item)
    return result


def transform_index(index_html: str) -> str:
    index_html = index_html.replace('href="/styles.css"', 'href="./styles.css"')
    index_html = index_html.replace('src="/app.js"', 'src="./app.js"')
    index_html = index_html.replace("Local dashboard", "Online snapshot")
    head_additions = (
        '\n  <meta name="robots" content="noindex,nofollow">'
        '\n  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'self\'; frame-ancestors \'none\'">'
        '\n  <link rel="stylesheet" href="./online.css">\n'
    )
    index_html = index_html.replace("</head>", f"{head_additions}</head>")
    script = '<script src="./app.js" defer></script>'
    replacement = (
        '<script src="./online-adapter.js"></script>\n'
        '  <script src="./app.js" defer></script>\n'
        '  <script src="./online-runtime.js" defer></script>'
    )
    if script not in index_html:
        raise RuntimeError("ไม่พบ app.js script tag ใน index ที่ render แล้ว")
    return index_html.replace(script, replacement)


def prepare_output(output: Path) -> None:
    output = output.resolve()
    project = PROJECT_ROOT.resolve()
    if project not in output.parents or output == project:
        raise RuntimeError(f"ปฏิเสธการล้าง output นอกโครงการ Online: {output}")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)


def file_digest_summary(site_root: Path) -> tuple[int, int, str, int]:
    records: list[str] = []
    total_bytes = 0
    largest = 0
    count = 0
    for path in sorted(site_root.rglob("*")):
        if not path.is_file() or path.name == "manifest.json":
            continue
        size = path.stat().st_size
        total_bytes += size
        largest = max(largest, size)
        count += 1
        records.append(f"{path.relative_to(site_root).as_posix()}:{sha256_file(path)}")
    digest = hashlib.sha256("\n".join(records).encode("utf-8")).hexdigest()
    return count, total_bytes, digest, largest


def main() -> int:
    parser = argparse.ArgumentParser(description="Export a read-only static snapshot of the local Research Dashboard.")
    parser.add_argument("--local-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    local_root = args.local_root.resolve()
    output = args.output.resolve()
    if not (local_root / "dashboard_final_user.py").exists():
        raise FileNotFoundError(f"ไม่พบ Local Dashboard entrypoint: {local_root}")
    source_db = local_root / "data" / "research_dashboard_release.sqlite"
    if not source_db.exists():
        raise FileNotFoundError(f"ไม่พบ release database: {source_db}")
    if local_root == output or local_root in output.parents:
        raise RuntimeError("Output ต้องแยกจาก Local Dashboard")

    latest_run = assert_idle_database(source_db)
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    prepare_output(output)
    report: dict[str, Any] = {
        "generated_at": generated_at,
        "latest_import_run": latest_run,
        "stocks": 0,
        "parity_failures": [],
        "quote_available": 0,
        "quote_unavailable": 0,
    }

    with tempfile.TemporaryDirectory(prefix="research-dashboard-publish-") as temporary:
        temporary_root = Path(temporary)
        runtime_root = temporary_root / "runtime"
        copy_runtime(local_root, runtime_root)
        snapshot_db = runtime_root / "data" / "research_dashboard_release.sqlite"
        print("[1/5] กำลังสร้าง SQLite snapshot แบบ read-only...", flush=True)
        backup_database(source_db, snapshot_db)
        print("[2/5] กำลังเปิด runtime จากสำเนาชั่วคราว...", flush=True)
        httpd, thread, base_url = start_snapshot_server(runtime_root, snapshot_db)
        try:
            status_source = fetch_json(f"{base_url}/api/status")
            status = sanitize_payload(status_source)
            stocks = active_stock_index(snapshot_db)
            report["stocks"] = len(stocks)

            index_html = fetch_bytes(f"{base_url}/").decode("utf-8")
            app_js = fetch_bytes(f"{base_url}/app.js")
            styles_css = fetch_bytes(f"{base_url}/styles.css")
            write_bytes(output / "index.html", transform_index(index_html).encode("utf-8"))
            write_bytes(output / "app.js", app_js)
            write_bytes(output / "styles.css", styles_css)
            for name in ("online-adapter.js", "online-runtime.js", "online.css"):
                shutil.copy2(TEMPLATE_ROOT / name, output / name)
            write_bytes(output / ".nojekyll", b"")

            status["online_snapshot"] = {
                "generated_at": generated_at,
                "read_only": True,
                "stock_count_with_data": len(stocks),
                "quote_policy": "ราคาจาก SET ณ เวลา Deploy; หุ้นที่ไม่มีราคา SET จะแสดงว่าไม่พบราคา",
            }
            write_json(output / "data" / "status.json", status)
            write_json(output / "data" / "stocks.json", stocks)

            print(f"[3/5] กำลัง export รายละเอียด {len(stocks)} หุ้นและราคา SET...", flush=True)

            def load_stock(stock: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, int]]:
                source = fetch_json_with_retry(
                    f"{base_url}/api/stocks/{stock['id']}?limit=1000", timeout=300, attempts=4
                )
                if int(source.get("stock", {}).get("id", -1)) != int(stock["id"]):
                    raise RuntimeError(f"Stock payload id ไม่ตรง: {stock['symbol']}")
                counts = {
                    key: len(source.get(key) or [])
                    for key in ("brokers", "metrics", "comparisons", "knowledge", "sources", "metric_groups")
                }
                clean = sanitize_payload(source)
                clean_counts = {
                    key: len(clean.get(key) or [])
                    for key in ("brokers", "metrics", "comparisons", "knowledge", "sources", "metric_groups")
                }
                if counts != clean_counts:
                    raise RuntimeError(f"Sanitizer ทำจำนวนรายการเปลี่ยน: {stock['symbol']} {counts} != {clean_counts}")
                quote = clean.get("quote") or {}
                if quote.get("loading") or not quote.get("fetched_at"):
                    quote_url = (
                        f"{base_url}/api/quotes/"
                        f"{urllib.parse.quote(str(stock['symbol']), safe='')}"
                    )
                    quote = sanitize_payload(fetch_json_with_retry(quote_url, timeout=90, attempts=3))
                    clean["quote"] = quote
                if not quote:
                    quote = {
                        "available": False,
                        "symbol": stock["symbol"],
                        "source_name": "ตลาดหลักทรัพย์แห่งประเทศไทย (SET)",
                        "fetched_at": generated_at,
                        "error": "ไม่พบราคาใน snapshot",
                    }
                    clean["quote"] = quote
                return clean, quote, counts

            completed = 0
            with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
                future_map = {executor.submit(load_stock, stock): stock for stock in stocks}
                for future in concurrent.futures.as_completed(future_map):
                    stock = future_map[future]
                    try:
                        detail, quote, counts = future.result()
                    except Exception as exc:
                        report["parity_failures"].append({"id": stock["id"], "symbol": stock["symbol"], "error": str(exc)})
                        continue
                    write_json(output / "data" / "stocks" / f"{stock['id']}.json", detail)
                    write_json(output / "data" / "quotes" / f"q-{stock['symbol']}.json", quote)
                    if quote.get("available"):
                        report["quote_available"] += 1
                    else:
                        report["quote_unavailable"] += 1
                    completed += 1
                    if completed % 25 == 0 or completed == len(stocks):
                        print(f"  export แล้ว {completed}/{len(stocks)} หุ้น", flush=True)

            if report["parity_failures"]:
                raise RuntimeError(f"Export ไม่ครบ {len(report['parity_failures'])} หุ้น: {report['parity_failures'][:5]}")

            print("[4/5] กำลังสร้าง manifest และตรวจขนาด...", flush=True)
            write_bytes(output / "404.html", transform_index(index_html).encode("utf-8"))
            file_count, total_bytes, content_digest, largest_file = file_digest_summary(output)
            manifest = {
                "schema_version": 1,
                "generated_at": generated_at,
                "source_release": status.get("daily_ingest_release") or status.get("quality_policy", {}).get("release"),
                "stock_count": len(stocks),
                "file_count": file_count + 1,
                "site_bytes": total_bytes,
                "largest_file_bytes": largest_file,
                "content_digest": content_digest,
                "read_only": True,
                "quote_source": "ตลาดหลักทรัพย์แห่งประเทศไทย (SET)",
                "quote_snapshot_at": generated_at,
            }
            write_json(output / "data" / "manifest.json", manifest)
            report["manifest"] = manifest
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=10)

    print("[5/5] สร้าง Online snapshot สำเร็จ", flush=True)
    report_path = PROJECT_ROOT / "work" / "export-report.json"
    write_json(report_path, report)
    print(json.dumps({"ok": True, "site": str(output), "report": str(report_path), **report}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
