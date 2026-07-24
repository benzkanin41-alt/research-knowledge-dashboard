from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def fetch(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "ResearchDashboardLiveQA/1.0", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_json(url: str) -> Any:
    return json.loads(fetch(url).decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the deployed GitHub Pages snapshot.")
    parser.add_argument("--url", default="https://benzkanin41-alt.github.io/research-knowledge-dashboard/")
    parser.add_argument("--expected-digest")
    parser.add_argument("--wait-seconds", type=int, default=600)
    args = parser.parse_args()
    base = args.url.rstrip("/") + "/"
    deadline = time.time() + args.wait_seconds
    last_error = ""
    while time.time() < deadline:
        try:
            manifest = fetch_json(base + "data/manifest.json?ts=" + str(int(time.time())))
            if args.expected_digest and manifest.get("content_digest") != args.expected_digest:
                raise RuntimeError("manifest ยังเป็น snapshot เก่า")
            stocks = fetch_json(base + "data/stocks.json")
            index = fetch(base).decode("utf-8")
            if "online-adapter.js" not in index or "Online snapshot" not in index:
                raise RuntimeError("index ไม่มี Online runtime")
            if manifest.get("stock_count") != len(stocks):
                raise RuntimeError("จำนวนหุ้นบนเว็บไม่ตรง manifest")
            symbols = {str(item["symbol"]).upper(): item for item in stocks}
            checked: list[str] = []
            for symbol in ("MTC", "COM7", "JMT", "TIDLOR", "TIDLR", "KLINIQ", "MAGURO", "AAPL", "NVDA"):
                stock = symbols.get(symbol)
                if not stock or symbol in {"TIDLOR", "TIDLR"} and any(value in checked for value in ("TIDLOR", "TIDLR")):
                    continue
                detail = fetch_json(base + f"data/stocks/{stock['id']}.json")
                if str(detail.get("stock", {}).get("symbol") or "").upper() != symbol:
                    raise RuntimeError(f"detail ไม่ตรงสำหรับ {symbol}")
                checked.append(symbol)
            print(json.dumps({"ok": True, "url": base, "manifest": manifest, "stocks": len(stocks), "checked": checked}, ensure_ascii=False))
            return 0
        except (urllib.error.URLError, json.JSONDecodeError, RuntimeError) as exc:
            last_error = str(exc)
            time.sleep(10)
    print(json.dumps({"ok": False, "url": base, "error": last_error}, ensure_ascii=False))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
