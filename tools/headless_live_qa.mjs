import { writeFile } from "node:fs/promises";


const targetURL = process.argv[2];
const port = Number(process.argv[3] || 9223);
const screenshotPath = process.argv[4] || "work/live-qa.png";
if (!targetURL) throw new Error("Usage: node headless_live_qa.mjs <url> [port] [screenshot]");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function findTarget() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store" });
      const targets = await response.json();
      const page = targets.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Chrome DevTools target unavailable: ${lastError || "no page target"}`);
}

const target = await findTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const runtimeExceptions = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  } else if (message.method === "Runtime.exceptionThrown") {
    const details = message.params?.exceptionDetails || {};
    runtimeExceptions.push({
      text: details.text || "Runtime exception",
      description: details.exception?.description || "",
      url: details.url || "",
      line: details.lineNumber,
      column: details.columnNumber,
    });
  }
});

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: targetURL });

const expression = `(${async function dashboardQA() {
  const sleepInPage = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitFor = async (predicate, label, timeout = 30000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (predicate()) return;
      await sleepInPage(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  await waitFor(() => document.readyState === "complete", "document load");
  await waitFor(() => document.querySelectorAll("#stock-list .stock-item").length > 0, "stock index");
  await waitFor(() => document.querySelector("#online-snapshot-time")?.textContent.includes("ข้อมูลออนไลน์ ณ"), "snapshot banner");

  const search = document.querySelector("#stock-search");
  search.value = "MTC";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(
    () => [...document.querySelectorAll("#stock-list .stock-item strong")].some((node) => node.textContent.trim() === "MTC"),
    "MTC search result"
  );
  const mtcButton = [...document.querySelectorAll("#stock-list .stock-item")]
    .find((node) => node.querySelector("strong")?.textContent.trim() === "MTC");
  if (!mtcButton) throw new Error("MTC result button not found");
  mtcButton.click();
  await waitFor(
    () => document.querySelector("#stock-symbol")?.textContent.trim() === "MTC"
      && !document.querySelector("#stock-view")?.classList.contains("hidden"),
    "MTC detail"
  );
  await waitFor(() => document.querySelector("#hero-cards .quote-hero"), "MTC quote card");

  const overviewText = document.querySelector("#tab-overview")?.innerText || "";
  const metricsTab = document.querySelector('[data-tab="metrics"]');
  metricsTab.click();
  await waitFor(() => !document.querySelector("#tab-metrics")?.classList.contains("hidden"), "metrics tab");
  await waitFor(() => document.querySelector("#metric-frequency") || document.querySelector("#readable-metrics-root"), "metrics controls");
  await waitFor(() => document.querySelectorAll("#tab-metrics tbody tr").length > 0, "metrics rows");

  const metricTopics = [...document.querySelectorAll("#metric-filters [data-metric]")]
    .map((node) => ({ code: node.dataset.metric, label: node.textContent.trim() }));
  const revenueButton = document.querySelector('#metric-filters [data-metric="revenue"]');
  if (revenueButton) {
    revenueButton.click();
    await sleepInPage(250);
  }
  const metricText = document.querySelector("#tab-metrics")?.innerText || "";

  document.querySelector('[data-tab="knowledge"]').click();
  await waitFor(() => !document.querySelector("#tab-knowledge")?.classList.contains("hidden"), "knowledge tab");
  await waitFor(() => (document.querySelector("#knowledge-timeline")?.innerText || "").trim().length > 100, "knowledge content");
  const knowledgeText = document.querySelector("#tab-knowledge")?.innerText || "";

  document.querySelector('[data-tab="sources"]').click();
  await waitFor(() => !document.querySelector("#tab-sources")?.classList.contains("hidden"), "sources tab");
  await waitFor(() => document.querySelectorAll("#sources-table tbody tr").length > 0, "source rows");
  const sourceHeader = document.querySelector("#sources-table thead th:last-child")?.textContent.trim();

  return {
    title: document.title,
    snapshotBanner: document.querySelector("#online-snapshot-time")?.textContent.trim(),
    updateDisabled: Boolean(document.querySelector("#update-button")?.disabled),
    updateLabel: document.querySelector("#update-button")?.textContent.trim(),
    symbol: document.querySelector("#stock-symbol")?.textContent.trim(),
    quoteCardVisible: Boolean(document.querySelector("#hero-cards .quote-hero")),
    overviewHasSetQuote: overviewText.includes("ราคาล่าสุดจาก SET") || overviewText.includes("ราคาจาก SET"),
    metricFrequencyOptions: document.querySelectorAll("#metric-frequency option").length,
    metricPeriodOptions: document.querySelectorAll("#metric-period option").length,
    metricTopics,
    revenueSelectable: Boolean(revenueButton),
    metricHasBrokerRows: document.querySelectorAll("#tab-metrics tbody tr").length > 0,
    metricTextPresent: metricText.trim().length > 100,
    knowledgeTextPresent: knowledgeText.trim().length > 100,
    sourceRows: document.querySelectorAll("#sources-table tbody tr").length,
    sourceHeader,
    noShaHeader: sourceHeader !== "SHA-256",
  };
}.toString()})()`;

const evaluated = await send("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
if (evaluated.exceptionDetails) {
  throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
}
const result = evaluated.result?.value;
const screenshot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
socket.close();

const failures = [];
for (const [key, value] of Object.entries({
  updateDisabled: result?.updateDisabled,
  quoteCardVisible: result?.quoteCardVisible,
  overviewHasSetQuote: result?.overviewHasSetQuote,
  revenueSelectable: result?.revenueSelectable,
  metricHasBrokerRows: result?.metricHasBrokerRows,
  metricTextPresent: result?.metricTextPresent,
  knowledgeTextPresent: result?.knowledgeTextPresent,
  noShaHeader: result?.noShaHeader,
})) {
  if (!value) failures.push(key);
}
if (result?.symbol !== "MTC") failures.push("symbol=MTC");
if (!(result?.sourceRows > 0)) failures.push("sourceRows");
if (runtimeExceptions.length) failures.push(`runtimeExceptions=${runtimeExceptions.length}`);

console.log(JSON.stringify({
  ok: failures.length === 0,
  url: targetURL,
  result,
  runtimeExceptions,
  failures,
  screenshot: screenshotPath,
}, null, 2));
if (failures.length) process.exitCode = 1;
