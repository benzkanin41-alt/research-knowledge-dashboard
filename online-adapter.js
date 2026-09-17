(function () {
  "use strict";

  const scriptURL = document.currentScript?.src || window.location.href;
  const baseURL = new URL("./", scriptURL);
  const nativeFetch = window.fetch.bind(window);
  let stockIndexPromise = null;

  function normalize(value) {
    return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  }

  async function loadJSON(relativePath) {
    const response = await nativeFetch(new URL(relativePath, baseURL), { cache: "no-store" });
    if (!response.ok) throw new Error(`Static data HTTP ${response.status}`);
    return response.json();
  }

  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  async function stocksForQuery(query) {
    stockIndexPromise ||= loadJSON("data/stocks.json");
    const allStocks = await stockIndexPromise;
    const normalized = normalize(query);
    const filtered = normalized
      ? allStocks.filter((stock) => normalize(stock.search_text).includes(normalized))
      : allStocks.slice();
    filtered.sort((left, right) => {
      const leftSymbol = normalize(left.symbol);
      const rightSymbol = normalize(right.symbol);
      const leftRank = leftSymbol === normalized ? 0 : leftSymbol.startsWith(normalized) ? 1 : 2;
      const rightRank = rightSymbol === normalized ? 0 : rightSymbol.startsWith(normalized) ? 1 : 2;
      return leftRank - rightRank
        || String(right.latest_date || "").localeCompare(String(left.latest_date || ""))
        || String(left.symbol || "").localeCompare(String(right.symbol || ""));
    });
    return filtered.slice(0, 300);
  }

  window.__ONLINE_DASHBOARD__ = { baseURL: baseURL.href, loadJSON };

  window.fetch = async function onlineFetch(input, init = {}) {
    const rawURL = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const url = new URL(rawURL, window.location.origin);
    const method = String(init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();

    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);

    try {
      if (method !== "GET") {
        return jsonResponse({ error: "Online Dashboard เป็น snapshot แบบอ่านอย่างเดียว กรุณาอัปเดต Local แล้วสั่ง Deploy ใหม่" }, 403);
      }
      if (url.pathname === "/api/status") return jsonResponse(await loadJSON("data/status.json"));
      if (url.pathname === "/api/stocks") return jsonResponse(await stocksForQuery(url.searchParams.get("q") || ""));
      if (url.pathname === "/api/review") return jsonResponse([]);

      const detailMatch = url.pathname.match(/^\/api\/stocks\/(\d+)$/);
      if (detailMatch) return jsonResponse(await loadJSON(`data/stocks/${detailMatch[1]}.json`));

      const quoteMatch = url.pathname.match(/^\/api\/quotes\/([A-Za-z0-9.\-]+)$/);
      if (quoteMatch) return jsonResponse(await loadJSON(`data/quotes/q-${encodeURIComponent(quoteMatch[1].toUpperCase())}.json`));

      return jsonResponse({ error: "ไม่พบข้อมูล Online สำหรับ endpoint นี้" }, 404);
    } catch (error) {
      return jsonResponse({ error: error?.message || String(error) }, 500);
    }
  };
})();
