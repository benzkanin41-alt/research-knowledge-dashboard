from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SITE = PROJECT_ROOT / "work" / "site"
FORBIDDEN_KEYS = {
    "source_path",
    "source_directory",
    "session_token",
    "database_path",
    "source_roots",
    "canonical_md",
    "sha256",
    "raw_text",
}
WINDOWS_PATH_RE = re.compile(r"(?i)(?<![A-Za-z0-9])[A-Z]:[\\/]")
UNC_PATH_RE = re.compile(r"\\\\[^\s\\/]+[\\/]")
TOKEN_RE = re.compile(r"(?i)\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_SITE_BYTES = 1024 * 1024 * 1024
TIDLOR_Q2_2026_F45_DATE = "2026-08-13"
TIDLOR_Q2_2026_NET_PROFIT_MILLION = 1533.221
TIDLOR_Q2_2026_ROUNDING_TOLERANCE_MILLION = 1.0


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def walk_json(value: Any, location: str = "$") -> Iterable[tuple[str, Any]]:
    yield location, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from walk_json(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_json(child, f"{location}[{index}]")


def broker_name(item: dict[str, Any]) -> str:
    return str(item.get("analyst") or "").lower()


def target_number(broker: dict[str, Any]) -> float | None:
    target = broker.get("latest_target") or {}
    for key in ("target_low", "target_high", "value", "target"):
        value = target.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


def period_is_q2_2026(group: dict[str, Any]) -> bool:
    return (
        group.get("period_key") == "Q2-2026"
        or (group.get("period_year") == 2026 and group.get("period_quarter") == 2)
        or str(group.get("period_label") or "").upper().replace(" ", "") in {"2Q69", "2Q69F", "2Q26", "2Q26F"}
    )


def validate_known_cases(symbol_to_detail: dict[str, dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    required = ["MTC", "COM7", "JMT", "KLINIQ", "MAGURO"]
    for symbol in required:
        if symbol not in symbol_to_detail:
            errors.append(f"ไม่พบหุ้นตัวอย่าง {symbol}")

    tidlor_symbol = "TIDLOR" if "TIDLOR" in symbol_to_detail else "TIDLR" if "TIDLR" in symbol_to_detail else None
    if not tidlor_symbol:
        errors.append("ไม่พบ TIDLOR/TIDLR")

    mtc = symbol_to_detail.get("MTC")
    if mtc and not any("tisco" in broker_name(item) for item in mtc.get("brokers") or []):
        errors.append("MTC ไม่มี TISCO ใน broker coverage")

    jmt = symbol_to_detail.get("JMT")
    if jmt:
        jmt_q2 = [group for group in jmt.get("metric_groups") or [] if period_is_q2_2026(group)]
        if not any(group.get("rows") for group in jmt_q2):
            errors.append("JMT ไม่มีแถวประมาณการ 2Q69F")

    if tidlor_symbol:
        tidlor = symbol_to_detail[tidlor_symbol]
        tidlor_q2_actual_groups = [
            group
            for group in tidlor.get("metric_groups") or []
            if period_is_q2_2026(group) and group.get("actual")
        ]
        if not tidlor_q2_actual_groups:
            errors.append(f"{tidlor_symbol} ไม่มีผลจริง 2Q69 หลัง SET ประกาศงบแล้ว")
        for group in tidlor_q2_actual_groups:
            actual = group.get("actual") or {}
            actual_date = str(actual.get("date") or "")[:10]
            if actual_date < TIDLOR_Q2_2026_F45_DATE:
                errors.append(f"{tidlor_symbol} ผลจริง 2Q69 มีวันที่ก่อน SET ประกาศงบ: {actual_date or 'ไม่มีวันที่'}")
            if not actual.get("sources") or not actual.get("supporting_sources"):
                errors.append(f"{tidlor_symbol} ผลจริง 2Q69 ไม่มี provenance สนับสนุน")
            if group.get("metric_code") in {"profit", "net_profit"}:
                value = actual.get("value")
                if (
                    not isinstance(value, (int, float))
                    or abs(float(value) - TIDLOR_Q2_2026_NET_PROFIT_MILLION)
                    > TIDLOR_Q2_2026_ROUNDING_TOLERANCE_MILLION
                ):
                    errors.append(f"{tidlor_symbol} กำไรจริง 2Q69 ไม่ตรง SET F45: {value}")

    maguro = symbol_to_detail.get("MAGURO")
    if maguro:
        for broker in maguro.get("brokers") or []:
            if "krungsri" in broker_name(broker):
                value = target_number(broker)
                if value is not None and value <= 5:
                    errors.append(f"MAGURO Krungsri target ผิดปกติ: {value}")

    for symbol in required + ([tidlor_symbol] if tidlor_symbol else []):
        detail = symbol_to_detail.get(symbol)
        if not detail:
            continue
        quote = detail.get("quote") or {}
        if not quote.get("available") or not isinstance(quote.get("last"), (int, float)) or quote.get("last") <= 0:
            errors.append(f"{symbol} ไม่มีราคา SET ที่ใช้ได้")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the static Research Dashboard snapshot.")
    parser.add_argument("--site", type=Path, default=DEFAULT_SITE)
    parser.add_argument("--report", type=Path, default=PROJECT_ROOT / "work" / "validation-report.json")
    args = parser.parse_args()
    site = args.site.resolve()
    errors: list[str] = []
    warnings: list[str] = []

    for required in ("index.html", "app.js", "styles.css", "online-adapter.js", "online-runtime.js", "data/status.json", "data/stocks.json", "data/manifest.json"):
        if not (site / required).is_file():
            errors.append(f"ขาดไฟล์ {required}")

    if errors:
        print(json.dumps({"ok": False, "errors": errors}, ensure_ascii=False))
        return 2

    stocks = load_json(site / "data" / "stocks.json")
    manifest = load_json(site / "data" / "manifest.json")
    status = load_json(site / "data" / "status.json")
    if manifest.get("stock_count") != len(stocks):
        errors.append(f"manifest stock_count {manifest.get('stock_count')} != index {len(stocks)}")
    if status.get("online_snapshot", {}).get("stock_count_with_data") != len(stocks):
        errors.append("status stock_count_with_data ไม่ตรงกับ stocks index")

    ids = [int(item["id"]) for item in stocks]
    symbols = [str(item["symbol"]).upper() for item in stocks]
    if len(ids) != len(set(ids)):
        errors.append("stock id ซ้ำ")
    if len(symbols) != len(set(symbols)):
        errors.append("stock symbol ซ้ำ")

    symbol_to_detail: dict[str, dict[str, Any]] = {}
    for stock in stocks:
        symbol = str(stock["symbol"]).upper()
        detail_path = site / "data" / "stocks" / f"{stock['id']}.json"
        quote_path = site / "data" / "quotes" / f"q-{symbol}.json"
        if not detail_path.is_file():
            errors.append(f"ขาด detail {symbol} id={stock['id']}")
            continue
        if not quote_path.is_file():
            errors.append(f"ขาด quote {symbol}")
        detail = load_json(detail_path)
        symbol_to_detail[symbol] = detail
        if str(detail.get("stock", {}).get("symbol") or "").upper() != symbol:
            errors.append(f"detail symbol ไม่ตรง: {symbol}")
        for location, value in walk_json(detail):
            if isinstance(value, dict):
                forbidden = FORBIDDEN_KEYS.intersection(str(key).lower() for key in value)
                if forbidden:
                    errors.append(f"พบ key ต้องห้าม {sorted(forbidden)} ที่ {symbol}:{location}")
            elif isinstance(value, str) and (WINDOWS_PATH_RE.search(value) or UNC_PATH_RE.search(value) or TOKEN_RE.search(value)):
                errors.append(f"พบ path/token ต้องห้ามที่ {symbol}:{location}")

    for json_path in (site / "data").rglob("*.json"):
        text = json_path.read_text(encoding="utf-8", errors="replace")
        if TOKEN_RE.search(text):
            errors.append(f"privacy scan ไม่ผ่าน: {json_path.relative_to(site)}")

    total_bytes = 0
    largest_file = ("", 0)
    file_count = 0
    for path in site.rglob("*"):
        if not path.is_file():
            continue
        size = path.stat().st_size
        total_bytes += size
        file_count += 1
        if size > largest_file[1]:
            largest_file = (path.relative_to(site).as_posix(), size)
        if size >= MAX_FILE_BYTES:
            errors.append(f"ไฟล์เกิน 100 MiB: {path.relative_to(site)} ({size})")
    if total_bytes >= MAX_SITE_BYTES:
        errors.append(f"เว็บไซต์เกิน 1 GiB: {total_bytes}")

    errors.extend(validate_known_cases(symbol_to_detail))
    foreign = next((symbol for symbol in ("AAPL", "MSFT", "NVDA", "GOOGL", "TSLA") if symbol in symbol_to_detail), None)
    if not foreign:
        warnings.append("ไม่พบหุ้นต่างประเทศตัวอย่างในชุดสัญลักษณ์มาตรฐาน")

    report = {
        "ok": not errors,
        "stock_count": len(stocks),
        "file_count": file_count,
        "site_bytes": total_bytes,
        "largest_file": {"path": largest_file[0], "bytes": largest_file[1]},
        "foreign_sample": foreign,
        "errors": errors,
        "warnings": warnings,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
