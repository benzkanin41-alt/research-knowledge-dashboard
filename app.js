const state = {
  status: null,
  token: null,
  stocks: [],
  currentId: null,
  detail: null,
  metricFilter: "all",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHTML = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

function shortDate(value) {
  if (!value) return "—";
  const [y, m, d] = value.split("-");
  return `${d}/${m}/${y}`;
}

function formatNumber(value, maximumFractionDigits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits }).format(Number(value));
}

function targetText(target) {
  if (!target) return "ไม่มี Target";
  const currency = target.target_currency || "";
  const low = formatNumber(target.target_low);
  const high = formatNumber(target.target_high);
  return target.target_low === target.target_high ? `${currency} ${low}`.trim() : `${currency} ${low}–${high}`.trim();
}

function metricValue(row) {
  const prefix = row.currency ? `${row.currency} ` : "";
  const suffix = row.scale === "million" ? " ล้าน" : row.scale === "percent" ? "%" : "";
  const value = row.value_low === row.value_high
    ? formatNumber(row.value_low)
    : `${formatNumber(row.value_low)}–${formatNumber(row.value_high)}`;
  return `${prefix}${value}${suffix}`;
}

function sourceExcerpt(value, max = 420) {
  const normalized = String(value || "").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function loadStatus() {
  state.status = await fetchJSON("/api/status");
  state.token = state.status.session_token;
  const counts = state.status.counts;
  $("#database-summary").innerHTML = [
    ["หุ้น", counts.stocks], ["ไฟล์ MD", counts.files], ["องค์ความรู้", counts.knowledge],
    ["Target/Rating", counts.ratings], ["ตัวเลข", counts.metrics],
  ].map(([label, value]) => `<span class="summary-pill"><strong>${formatNumber(value, 0)}</strong> ${label}</span>`).join("");
  const last = state.status.last_run;
  $("#update-message").textContent = last
    ? `${last.status === "success" ? "อัปเดตล่าสุด" : "สถานะล่าสุด"}: ${last.finished_at || last.started_at}`
    : "ยังไม่เคยอัปเดต";
}

async function loadStocks(query = "") {
  state.stocks = await fetchJSON(`/api/stocks?q=${encodeURIComponent(query)}`);
  $("#stock-count").textContent = `พบ ${formatNumber(state.stocks.length, 0)} หุ้น`;
  const list = $("#stock-list");
  list.innerHTML = state.stocks.map((stock) => `
    <button class="stock-item ${stock.id === state.currentId ? "active" : ""}" data-stock-id="${stock.id}">
      <strong>${escapeHTML(stock.symbol)}</strong>
      <time>${shortDate(stock.latest_date)}</time>
      <small>${escapeHTML(stock.display_name === stock.symbol ? `${stock.knowledge_count} รายการ` : stock.display_name)}</small>
    </button>`).join("") || `<div class="muted compact">ไม่พบหุ้นที่ค้นหา</div>`;
  $$(".stock-item").forEach((button) => button.addEventListener("click", () => selectStock(Number(button.dataset.stockId))));
}

async function selectStock(stockId) {
  state.currentId = stockId;
  state.detail = await fetchJSON(`/api/stocks/${stockId}?limit=1000`);
  $("#empty-state").classList.add("hidden");
  $("#stock-view").classList.remove("hidden");
  renderStock();
  await loadStocks($("#stock-search").value.trim());
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderStock() {
  const { stock, aliases, coverage, brokers, metrics, comparisons, knowledge, sources } = state.detail;
  $("#stock-symbol").textContent = stock.symbol;
  $("#stock-name").textContent = stock.display_name === stock.symbol ? "" : stock.display_name;
  $("#stock-aliases").textContent = aliases.map((item) => item.alias).filter((value, idx, array) => array.indexOf(value) === idx).slice(0, 8).join(" · ");
  $("#coverage-badges").innerHTML = `
    <span class="badge">${coverage.file_count || 0} ไฟล์</span>
    <span class="badge">${coverage.item_count || 0} รายการ</span>
    <span class="badge">${shortDate(coverage.first_date)} → ${shortDate(coverage.latest_date)}</span>`;

  const ratingCounts = { BUY: 0, NEUTRAL: 0, SELL: 0 };
  brokers.forEach((broker) => {
    const norm = broker.latest_rating?.rating_norm;
    if (norm in ratingCounts) ratingCounts[norm] += 1;
  });
  const targets = brokers.filter((broker) => broker.latest_target);
  const targetValues = targets.map((broker) => (broker.latest_target.target_low + broker.latest_target.target_high) / 2);
  const latestActual = metrics.find((row) => row.observation_type === "actual");
  $("#hero-cards").innerHTML = [
    ["ข้อมูลล่าสุด", shortDate(coverage.latest_date), `${coverage.file_count || 0} วัน/ไฟล์ที่เกี่ยวข้อง`],
    ["สำนักที่ติดตาม", formatNumber(brokers.length, 0), `${targets.length} สำนักมี Target`],
    ["Rating เชิงบวก", formatNumber(ratingCounts.BUY, 0), `Neutral ${ratingCounts.NEUTRAL} · Sell ${ratingCounts.SELL}`],
    ["ผลจริงล่าสุด", latestActual ? `${latestActual.period_raw} ${metricValue(latestActual)}` : "ยังไม่พบตัวเลขจับคู่", latestActual?.metric_code || "จาก MD เท่านั้น"],
  ].map(([label, value, note]) => `<div class="hero-card"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong><small>${escapeHTML(note)}</small></div>`).join("");

  renderTargetChart(targets, targetValues);
  renderRatingMix(ratingCounts);
  renderBrokerCards(brokers);
  renderTimeline(knowledge.slice(0, 8), $("#recent-knowledge"));
  renderMetrics(metrics, comparisons);
  renderKnowledgeFilters(knowledge);
  renderKnowledge();
  renderSources(sources);
}

function renderTargetChart(targets, values) {
  const el = $("#target-chart");
  if (!targets.length) {
    el.innerHTML = `<p class="muted">ยังไม่พบ Target Price ที่ผูกกับสำนักได้อย่างชัดเจน</p>`;
    return;
  }
  const currencies = [...new Set(targets.map((item) => item.latest_target.target_currency || "ไม่ระบุ"))];
  if (currencies.length > 1) {
    el.innerHTML = `<p class="muted compact">มีหลายสกุลเงิน จึงแยกแสดงเป็นตารางเพื่อไม่เปรียบเทียบข้ามสกุล</p>` + targets.map((item) =>
      `<div class="mix-row"><span>${escapeHTML(item.analyst)}</span><div class="mix-bar"><div class="mix-fill BUY" style="width:70%"></div></div><strong>${escapeHTML(targetText(item.latest_target))}</strong></div>`
    ).join("");
    return;
  }
  const sorted = targets.slice().sort((a, b) => ((a.latest_target.target_low + a.latest_target.target_high) - (b.latest_target.target_low + b.latest_target.target_high)));
  const mids = sorted.map((item) => (item.latest_target.target_low + item.latest_target.target_high) / 2);
  const min = Math.min(...mids) * .92;
  const max = Math.max(...mids) * 1.08 || 1;
  const width = 720, left = 150, right = 70, rowHeight = 34, height = Math.max(210, sorted.length * rowHeight + 42);
  const x = (value) => left + ((value - min) / (max - min || 1)) * (width - left - right);
  const lines = sorted.map((item, idx) => {
    const y = 28 + idx * rowHeight;
    const target = item.latest_target;
    const lowX = x(target.target_low), highX = x(target.target_high), mid = (lowX + highX) / 2;
    return `<text x="0" y="${y + 4}" class="chart-label">${escapeHTML(item.analyst.slice(0, 20))}</text>
      <line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="#e6eaed"/>
      <line x1="${lowX}" x2="${highX}" y1="${y}" y2="${y}" stroke="#dcae55" stroke-width="8" stroke-linecap="round"/>
      <circle cx="${mid}" cy="${y}" r="5" fill="#183b50"/>
      <text x="${Math.min(highX + 9, width - 55)}" y="${y + 4}" class="chart-value">${escapeHTML(targetText(target))}</text>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Target price ล่าสุดรายสำนัก">${lines}</svg>`;
}

function renderRatingMix(counts) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  $("#rating-mix").innerHTML = total ? Object.entries(counts).map(([rating, count]) => `
    <div class="mix-row"><span>${rating}</span><div class="mix-bar"><div class="mix-fill ${rating}" style="width:${count / total * 100}%"></div></div><strong>${count}</strong></div>`).join("")
    : `<p class="muted">ยังไม่มี Rating ที่ระบุสำนักได้</p>`;
}

function renderBrokerCards(brokers) {
  const el = $("#broker-cards");
  el.innerHTML = brokers.map((broker) => {
    const target = broker.latest_target;
    const rating = broker.latest_rating;
    const ratingNorm = rating?.rating_norm || "NA";
    const targetDate = target?.report_date ? `Target ณ ${shortDate(target.report_date)}` : "";
    const ratingDate = rating?.report_date ? `Rating ณ ${shortDate(rating.report_date)}` : "";
    const history = broker.history.map((item) => `<div class="history-row"><strong>${shortDate(item.report_date)}</strong> · ${escapeHTML(item.rating_norm || "—")} · ${escapeHTML(item.target_low !== null ? `${item.target_currency || ""} ${formatNumber(item.target_low)}${item.target_high !== item.target_low ? `–${formatNumber(item.target_high)}` : ""}` : "ไม่มี Target")}<div class="broker-meta">${escapeHTML(sourceExcerpt(item.source_text, 150))}</div></div>`).join("");
    return `<article class="broker-card">
      <div class="broker-top"><h3>${escapeHTML(broker.analyst)}</h3><span class="rating ${ratingNorm}">${escapeHTML(ratingNorm === "NA" ? "ไม่ระบุ" : ratingNorm)}</span></div>
      <div class="broker-target">${escapeHTML(targetText(target))}</div>
      <div class="broker-meta">${escapeHTML([targetDate, ratingDate].filter(Boolean).join(" · ") || "ยังไม่มีวันที่")}</div>
      <div class="source-copy">${escapeHTML(sourceExcerpt(target?.source_text || rating?.source_text || "", 220))}</div>
      ${history ? `<details><summary>ประวัติย้อนหลัง ${broker.history.length} รายการ</summary>${history}</details>` : ""}
    </article>`;
  }).join("") || `<article class="panel"><p class="muted">ยังไม่พบ Target Price/Rating ที่ระบุสำนักได้</p></article>`;
}

function renderMetrics(metrics, comparisons) {
  const available = ["all", ...new Set(metrics.map((row) => row.metric_code))];
  $("#metric-filters").innerHTML = available.map((code) => `<button class="chip ${state.metricFilter === code ? "active" : ""}" data-metric="${escapeHTML(code)}">${code === "all" ? "ทั้งหมด" : escapeHTML(code)}</button>`).join("");
  $$("[data-metric]").forEach((button) => button.addEventListener("click", () => {
    state.metricFilter = button.dataset.metric;
    renderMetrics(state.detail.metrics, state.detail.comparisons);
  }));
  const visible = state.metricFilter === "all" ? metrics : metrics.filter((row) => row.metric_code === state.metricFilter);
  $("#metrics-table tbody").innerHTML = visible.map((row) => `<tr>
    <td>${escapeHTML(row.period_raw)}</td><td>${escapeHTML(row.metric_code)}</td><td>${escapeHTML(row.observation_type)}</td>
    <td>${escapeHTML(row.analyst || "ไม่ระบุสำนัก")}</td><td class="numeric">${escapeHTML(metricValue(row))}</td>
    <td>${shortDate(row.report_date)}</td><td>${escapeHTML(sourceExcerpt(row.source_text, 170))}<div class="broker-meta">${escapeHTML(row.source_name)}:${row.line_start}</div></td>
  </tr>`).join("") || `<tr><td colspan="7" class="muted">ยังไม่พบตัวเลขที่ผ่านกติกาจับหน่วยและงวด</td></tr>`;
  $("#comparison-list").innerHTML = comparisons.map((row) => {
    const positive = row.delta >= 0;
    const suffix = row.scale === "percent" ? " จุด" : row.scale === "million" ? " ล้าน" : "";
    return `<div class="comparison-row"><div><strong>${escapeHTML(row.period_raw)} · ${escapeHTML(row.metric_code)}</strong><div class="broker-meta">${escapeHTML(row.analyst)} · คาด ${shortDate(row.estimate_date)} · จริง ${shortDate(row.actual_date)}</div></div>
      <div>คาด <strong>${formatNumber(row.estimate)}</strong></div><div>จริง <strong>${formatNumber(row.actual)}</strong></div>
      <div class="${positive ? "delta-positive" : "delta-negative"}"><strong>${positive ? "+" : ""}${formatNumber(row.delta)}${suffix}</strong><br><small>${row.delta_pct === null ? "—" : `${row.delta_pct >= 0 ? "+" : ""}${formatNumber(row.delta_pct)}%`}</small></div></div>`;
  }).join("") || `<p class="muted">ยังไม่มี estimate และ actual ที่งวด นิยาม หน่วย และสกุลเงินตรงกัน</p>`;
}

function renderKnowledgeFilters(knowledge) {
  const types = [...new Set(knowledge.map((item) => item.item_type))].sort();
  const current = $("#knowledge-type").value;
  $("#knowledge-type").innerHTML = `<option value="">ทั้งหมด</option>` + types.map((type) => `<option value="${escapeHTML(type)}">${escapeHTML(type)}</option>`).join("");
  $("#knowledge-type").value = types.includes(current) ? current : "";
}

function renderKnowledge() {
  const type = $("#knowledge-type").value;
  const query = $("#knowledge-search").value.trim().toLowerCase();
  const sort = $("#knowledge-sort").value;
  let items = state.detail.knowledge.filter((item) => (!type || item.item_type === type) && (!query || `${item.heading} ${item.content}`.toLowerCase().includes(query)));
  items = items.slice().sort((a, b) => sort === "asc" ? a.report_date.localeCompare(b.report_date) : b.report_date.localeCompare(a.report_date));
  renderTimeline(items, $("#knowledge-timeline"));
}

function renderTimeline(items, element) {
  element.innerHTML = items.map((item) => {
    const citations = (item.cited_sources || []).map((source) => `<span class="citation-chip">${escapeHTML(source)}</span>`).join("");
    return `<article class="timeline-item">
      <div><div class="timeline-date">${shortDate(item.report_date)}</div><span class="timeline-type">${escapeHTML(item.item_type)}</span></div>
      <div><h3>${escapeHTML(item.heading || "รายละเอียด")}</h3>
        <div class="source-copy">${escapeHTML(item.content)}</div>
        ${citations ? `<div class="citation-chips">${citations}</div>` : ""}
        <div class="source-note">${escapeHTML(item.source_name)} · บรรทัด ${item.line_start}–${item.line_end} · confidence ${formatNumber(item.confidence * 100, 0)}%</div>
      </div></article>`;
  }).join("") || `<article class="panel"><p class="muted">ไม่พบรายละเอียดตามตัวกรอง</p></article>`;
}

function renderSources(sources) {
  $("#sources-table tbody").innerHTML = sources.map((source) => `<tr><td>${shortDate(source.report_date)}</td><td>${escapeHTML(source.name)}<div class="broker-meta">${escapeHTML(source.path)}</div></td><td>${source.first_line}–${source.last_line}</td><td>${source.item_count}</td><td><code>${escapeHTML(source.sha256.slice(0, 16))}…</code></td></tr>`).join("");
}

function activateTab(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $$(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
  $(`#tab-${name}`).classList.remove("hidden");
}

async function openUpdateCenter(message = "") {
  const review = await fetchJSON("/api/review");
  const last = state.status?.last_run;
  $("#update-detail").innerHTML = `<p>${escapeHTML(message || last?.message || "พร้อมอัปเดต")}</p>${last ? `<div class="summary-strip"><span class="summary-pill">ใหม่ ${last.files_new}</span><span class="summary-pill">เปลี่ยน ${last.files_changed}</span><span class="summary-pill">ไม่เปลี่ยน ${last.files_unchanged}</span><span class="summary-pill">Target/Rating +${last.ratings_added}</span></div>` : ""}`;
  $("#review-list").innerHTML = review.map((item) => `<div class="review-item"><strong>${shortDate(item.report_date)} · ${escapeHTML(item.category)} · ${escapeHTML(item.source_name || "")}:${item.line_start}</strong><div>${escapeHTML(item.reason)}</div><div class="source-copy">${escapeHTML(item.source_text)}</div></div>`).join("") || `<p class="muted">ไม่มีรายการค้างตรวจ</p>`;
  $("#update-dialog").showModal();
}

async function runUpdate() {
  const button = $("#update-button");
  button.disabled = true;
  button.textContent = "กำลังอัปเดต…";
  try {
    const job = await fetchJSON("/api/update", { method: "POST", headers: { "X-Local-Dashboard-Token": state.token } });
    let status;
    do {
      await new Promise((resolve) => setTimeout(resolve, 550));
      status = await fetchJSON(`/api/jobs/${job.job_id}`);
      $("#update-message").textContent = status.status === "running" ? "กำลังสแกนไฟล์ใหม่และตรวจข้อมูล…" : status.status;
    } while (["queued", "running"].includes(status.status));
    if (status.status !== "success") throw new Error(status.error || "อัปเดตไม่สำเร็จ");
    await loadStatus();
    await loadStocks($("#stock-search").value.trim());
    if (state.currentId) await selectStock(state.currentId);
    await openUpdateCenter(status.result.message);
  } catch (error) {
    $("#update-message").textContent = `ล้มเหลว: ${error.message}`;
    await openUpdateCenter(`อัปเดตไม่สำเร็จ: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "อัปเดตจากไฟล์ MD";
  }
}

async function init() {
  try {
    await loadStatus();
    await loadStocks();
  } catch (error) {
    $("#update-message").textContent = `เปิดฐานข้อมูลไม่ได้: ${error.message}`;
  }
  let timer;
  $("#stock-search").addEventListener("input", (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => loadStocks(event.target.value.trim()), 180);
  });
  $("#update-button").addEventListener("click", runUpdate);
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));
  $$('[data-jump="knowledge"]').forEach((button) => button.addEventListener("click", () => activateTab("knowledge")));
  $("#knowledge-type").addEventListener("change", renderKnowledge);
  $("#knowledge-search").addEventListener("input", renderKnowledge);
  $("#knowledge-sort").addEventListener("change", renderKnowledge);
}

document.addEventListener("DOMContentLoaded", init);


/* Readable period-by-period estimates, actuals, stock-only notes and SET price. */

const metricThai = { revenue: "รายได้", net_profit: "กำไรสุทธิ", core_profit: "กำไรปกติ", gpm: "GPM", npm: "NPM" };

function quoteTime(quote) {
  const raw = quote?.market_datetime || quote?.statistics_as_of || quote?.fetched_at;
  if (!raw) return "ไม่พบเวลาข้อมูล";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function signedNumber(value, digits = 2) {
  if (value === null || value === undefined) return "—";
  return `${value > 0 ? "+" : ""}${formatNumber(value, digits)}`;
}

function metricDisplay(value, group) {
  if (value === null || value === undefined) return "—";
  return group.scale === "percent" ? `${formatNumber(value)}%` : `${formatNumber(value)} ล้าน`;
}

function upsideText(target, quote) {
  if (!quote?.available || !quote.last || !target || (target.target_currency && target.target_currency !== "THB")) return "";
  const midpoint = (target.target_low + target.target_high) / 2;
  const upside = (midpoint / quote.last - 1) * 100;
  return `${upside >= 0 ? "อัพไซด์" : "ดาวน์ไซด์"} ${signedNumber(upside, 1)}%`;
}

function renderQuoteHero() {
  const quote = state.detail.quote;
  const hero = $("#hero-cards");
  if (!hero) return;
  const card = quote?.available
    ? `<div class="hero-card quote-hero"><span>ราคาล่าสุดจาก SET</span><strong>${formatNumber(quote.last)} บาท</strong><small class="${(quote.change || 0) >= 0 ? "delta-positive" : "delta-negative"}">${signedNumber(quote.change)} (${signedNumber(quote.percent_change)}%)</small><small>${escapeHTML(quoteTime(quote))}${quote.stale ? " · ข้อมูลสำรอง" : ""}</small><a href="${escapeHTML(quote.source_url)}" target="_blank" rel="noopener noreferrer">เปิดหน้าราคา SET ↗</a></div>`
    : `<div class="hero-card quote-hero unavailable"><span>ราคาจาก SET</span><strong>ไม่มีข้อมูล</strong><small>${escapeHTML(quote?.error || "หุ้นนี้อาจไม่ได้จดทะเบียนใน SET")}</small></div>`;
  hero.insertAdjacentHTML("afterbegin", card);
}

const readableBaseRenderStock = renderStock;
renderStock = function renderStockReadable() {
  readableBaseRenderStock();
  renderQuoteHero();
  const recentHeading = document.querySelector("#tab-overview #recent-knowledge")?.closest(".panel")?.querySelector("h2");
  if (recentHeading) recentHeading.textContent = `รายละเอียดล่าสุดเฉพาะ ${state.detail.stock.symbol} และอุตสาหกรรม`;
};

renderTargetChart = function renderTargetChartReadable(targets) {
  const el = $("#target-chart");
  const quote = state.detail.quote;
  if (!targets.length) {
    el.innerHTML = `<p class="muted">ยังไม่พบ Target Price ที่ผูกกับสำนักได้อย่างชัดเจน</p>`;
    return;
  }
  const currencies = [...new Set(targets.map((item) => item.latest_target.target_currency || "ไม่ระบุ"))];
  if (currencies.length > 1) {
    el.innerHTML = `<p class="muted compact">มีหลายสกุลเงิน จึงไม่เปรียบเทียบข้ามสกุล</p>` + targets.map((item) => {
      const upside = upsideText(item.latest_target, quote);
      return `<div class="target-list-row"><span>${escapeHTML(item.analyst)}</span><strong>${escapeHTML(targetText(item.latest_target))}</strong><small>${escapeHTML(upside || "สกุลเงินไม่ตรงกับราคา SET")}</small></div>`;
    }).join("");
    return;
  }
  const sorted = targets.slice().sort((a, b) => ((a.latest_target.target_low + a.latest_target.target_high) - (b.latest_target.target_low + b.latest_target.target_high)));
  const mids = sorted.map((item) => (item.latest_target.target_low + item.latest_target.target_high) / 2);
  const comparableQuote = quote?.available && (!currencies[0] || currencies[0] === "THB" || currencies[0] === "ไม่ระบุ") ? quote.last : null;
  const allValues = comparableQuote ? [...mids, comparableQuote] : mids;
  const min = Math.min(...allValues) * .90, max = Math.max(...allValues) * 1.10 || 1;
  const width = 920, left = 190, right = 190, rowHeight = 38, height = Math.max(230, sorted.length * rowHeight + 70);
  const x = (value) => left + ((value - min) / (max - min || 1)) * (width - left - right);
  const lines = sorted.map((item, idx) => {
    const y = 46 + idx * rowHeight, target = item.latest_target;
    const lowX = x(target.target_low), highX = x(target.target_high), mid = (lowX + highX) / 2;
    const upside = upsideText(target, quote);
    return `<text x="0" y="${y + 4}" class="chart-label">${escapeHTML(item.analyst.slice(0, 25))}</text><line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="#e6eaed"/><line x1="${lowX}" x2="${highX}" y1="${y}" y2="${y}" stroke="#dcae55" stroke-width="8" stroke-linecap="round"/><circle cx="${mid}" cy="${y}" r="5" fill="#183b50"/><text x="${Math.min(highX + 9, width - right + 10)}" y="${y + 4}" class="chart-value">${escapeHTML(targetText(target))}${upside ? ` · ${escapeHTML(upside)}` : ""}</text>`;
  }).join("");
  const priceLine = comparableQuote ? `<line x1="${x(comparableQuote)}" x2="${x(comparableQuote)}" y1="18" y2="${height - 14}" stroke="#b94646" stroke-width="2" stroke-dasharray="5 5"/><text x="${Math.min(x(comparableQuote) + 7, width - 150)}" y="19" class="current-price-label">ราคาล่าสุด ${formatNumber(comparableQuote)}</text>` : "";
  el.innerHTML = `<div class="chart-source-note">● Target แต่ละสำนัก <span>┆ ราคาล่าสุดจาก SET</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Target price ล่าสุดรายสำนักเทียบราคาล่าสุด SET">${priceLine}${lines}</svg>`;
};

renderBrokerCards = function renderBrokerCardsReadable(brokers) {
  const quote = state.detail.quote, el = $("#broker-cards");
  el.innerHTML = brokers.map((broker) => {
    const target = broker.latest_target, rating = broker.latest_rating, ratingNorm = rating?.rating_norm || "NA";
    const upside = upsideText(target, quote), targetDate = target?.report_date ? `Target ณ ${shortDate(target.report_date)}` : "", ratingDate = rating?.report_date ? `Rating ณ ${shortDate(rating.report_date)}` : "";
    const history = broker.history.map((item) => `<div class="history-row"><strong>${shortDate(item.report_date)}</strong> · ${escapeHTML(item.rating_norm || "—")} · ${escapeHTML(item.target_low !== null ? `${item.target_currency || ""} ${formatNumber(item.target_low)}${item.target_high !== item.target_low ? `–${formatNumber(item.target_high)}` : ""}` : "ไม่มี Target")}<div class="broker-meta">${escapeHTML(sourceExcerpt(item.source_text, 150))}</div></div>`).join("");
    return `<article class="broker-card"><div class="broker-top"><h3>${escapeHTML(broker.analyst)}</h3><span class="rating ${ratingNorm}">${escapeHTML(ratingNorm === "NA" ? "ไม่ระบุ" : ratingNorm)}</span></div><div class="broker-target">${escapeHTML(targetText(target))}</div>${upside ? `<div class="upside-badge ${upside.includes("ดาวน์ไซด์") ? "negative" : "positive"}">${escapeHTML(upside)} จากราคา SET ${formatNumber(quote.last)}</div>` : ""}<div class="broker-meta">${escapeHTML([targetDate, ratingDate].filter(Boolean).join(" · ") || "ยังไม่มีวันที่")}</div><div class="source-copy">${escapeHTML(sourceExcerpt(target?.source_text || rating?.source_text || "", 220))}</div>${history ? `<details><summary>ประวัติย้อนหลัง ${broker.history.length} รายการ</summary>${history}</details>` : ""}</article>`;
  }).join("") || `<article class="panel"><p class="muted">ยังไม่พบ Target Price/Rating ที่ระบุสำนักได้</p></article>`;
};

function comparisonCell(row, group) {
  if (row.actual === null || row.actual === undefined) return `<span class="awaiting-pill">รอผลจริง</span>`;
  const positive = row.delta >= 0;
  return `<strong class="${positive ? "delta-positive" : "delta-negative"}">${signedNumber(row.delta)}${group.scale === "percent" ? " จุด" : " ล้าน"}</strong><small>${row.delta_pct === null ? "" : `${signedNumber(row.delta_pct)}% เทียบคาด`}</small>`;
}

function renderMetricGroup(group, index) {
  const actual = group.actual;
  const summary = group.estimate_count ? `ค่ากลาง ${metricDisplay(group.estimate_median, group)} · ช่วง ${metricDisplay(group.estimate_min, group)}–${metricDisplay(group.estimate_max, group)}` : "ไม่พบประมาณการที่จับคู่สำนักและงวดได้";
  const rows = group.rows.length ? group.rows.map((row) => `<tr><td><strong>${escapeHTML(row.analyst)}</strong><small>${shortDate(row.estimate_date)}</small></td><td class="numeric estimate-value">${metricDisplay(row.estimate, group)}</td><td class="numeric actual-value">${actual ? metricDisplay(actual.value, group) : `<span class="awaiting-pill">ยังไม่ประกาศ</span>`}</td><td class="numeric compare-value">${comparisonCell(row, group)}</td><td class="reason-cell"><div>${escapeHTML(row.reason)}</div><small>ที่มา: ${escapeHTML(row.source_name || "ไม่ระบุไฟล์")}${row.source_line ? ` · บรรทัด ${row.source_line}` : ""}</small></td></tr>`).join("") : `<tr><td colspan="5" class="empty-period">${actual ? `พบผลจริง ${metricDisplay(actual.value, group)} แต่ไม่พบประมาณการก่อนผลที่ผ่านเกณฑ์` : "ยังไม่พบข้อมูลที่จับคู่ได้"}</td></tr>`;
  return `<details class="metric-period" ${index < 3 ? "open" : ""}><summary><span><strong>${escapeHTML(group.period_label)}</strong> · ${escapeHTML(group.metric_label)}</span><span class="period-summary">${escapeHTML(summary)}</span><span class="status-pill ${group.status}">${group.status === "reported" ? "มีผลจริงแล้ว" : "รอผลจริง"}</span></summary><div class="actual-banner ${group.status}">${actual ? `<strong>ผลจริง ${metricDisplay(actual.value, group)}</strong><span>ประกาศ/บทวิเคราะห์วันที่ ${shortDate(actual.date)} · ยืนยันจาก ${actual.supporting_sources || 1} แหล่ง</span>` : `<strong>ผลประกอบการงวดนี้ยังไม่พบในฐานข้อมูล</strong><span>เมื่อมีไฟล์ใหม่ ระบบจะเติมผลจริงและคำนวณส่วนต่างให้ในตารางเดิม</span>`}</div><div class="readable-table-wrap"><table class="estimate-table"><caption>${escapeHTML(group.period_label)} — ${escapeHTML(group.metric_label)} หน่วย ${escapeHTML(group.unit_label)}</caption><thead><tr><th scope="col">สำนัก / วันที่คาด</th><th scope="col">ประมาณการ</th><th scope="col">ผลจริง</th><th scope="col">คลาดเคลื่อน</th><th scope="col">เหตุผลและสมมติฐาน</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

renderMetrics = function renderMetricsReadable() {
  const groups = state.detail.metric_groups || [];
  const available = ["revenue", "net_profit", "core_profit", "gpm", "npm"].filter((code) => groups.some((group) => group.metric_code === code));
  if (!available.includes(state.metricFilter)) state.metricFilter = available.includes("net_profit") ? "net_profit" : (available[0] || "revenue");
  $("#metric-filters").innerHTML = available.map((code) => `<button class="chip ${state.metricFilter === code ? "active" : ""}" data-metric="${code}">${metricThai[code]}</button>`).join("");
  $$('[data-metric]').forEach((button) => button.addEventListener("click", () => { state.metricFilter = button.dataset.metric; renderMetrics(); }));
  let root = $("#readable-metrics-root");
  if (!root) { const wrap = document.querySelector("#tab-metrics .table-wrap"); wrap.innerHTML = `<div id="readable-metrics-root"></div>`; root = $("#readable-metrics-root"); }
  const visible = groups.filter((group) => group.metric_code === state.metricFilter);
  root.innerHTML = `<div class="metric-explainer"><strong>อ่านทีละงวดและเทียบทีละสำนัก</strong><span>ระบบแสดงเฉพาะตัวเลขที่จับคู่หัวตาราง–งวด–หน่วยได้ และไม่ใช้แถว YoY/QoQ เป็นรายได้หรือกำไร</span></div>${visible.map(renderMetricGroup).join("") || `<p class="muted">ยังไม่พบข้อมูลที่ผ่านเกณฑ์สำหรับ ${escapeHTML(metricThai[state.metricFilter] || state.metricFilter)}</p>`}`;
  $("#comparison-list").innerHTML = `<div class="comparison-guide"><strong>วิธีอ่าน “คลาดเคลื่อน”</strong><span>ผลจริง − ประมาณการ; ค่าเป็นบวกหมายถึงผลจริงสูงกว่าคาด ส่วนค่าเป็นลบหมายถึงต่ำกว่าคาด</span></div>`;
};

const readableBaseRenderTimeline = renderTimeline;
renderTimeline = function renderTimelineScoped(items, element) {
  readableBaseRenderTimeline(items, element);
  element.querySelectorAll(".timeline-item").forEach((card, index) => {
    const label = items[index]?.scope_label;
    if (!label) return;
    const type = card.querySelector(".timeline-type");
    if (type) type.insertAdjacentHTML("afterend", `<span class="scope-badge">${escapeHTML(label)}</span>`);
  });
};


/* Final small runtime corrections loaded after readable-dashboard.js. */
quoteTime = function quoteTimeAsOf(quote) {
  if (quote?.statistics_as_of) {
    const date = new Date(quote.statistics_as_of);
    if (!Number.isNaN(date.getTime())) return `ข้อมูลการซื้อขาย ณ ${new Intl.DateTimeFormat("th-TH", { dateStyle: "medium" }).format(date)}`;
  }
  const raw = quote?.market_datetime || quote?.fetched_at;
  if (!raw) return "ไม่พบเวลาข้อมูล";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : `อัปเดตหน้า SET ${new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
};



// Fast stock selection, asynchronous SET quotes, period-first estimate tables.
const v4DetailCache = new Map();
let v4SelectionSequence = 0;

function renderStockSkeleton(stockId) {
  const stock = state.stocks.find((item) => item.id === stockId);
  $("#empty-state").classList.add("hidden");
  $("#stock-view").classList.remove("hidden");
  $("#stock-symbol").textContent = stock?.symbol || "กำลังเปิด…";
  $("#stock-name").textContent = stock?.display_name && stock.display_name !== stock.symbol ? stock.display_name : "";
  $("#coverage-badges").innerHTML = `<span class="badge loading-badge">กำลังเตรียมข้อมูลในเครื่อง…</span>`;
  $("#hero-cards").innerHTML = [1, 2, 3, 4].map(() => `<div class="hero-card skeleton-card"><span></span><strong></strong><small></small></div>`).join("");
}

selectStock = async function selectStockV4(stockId) {
  const sequence = ++v4SelectionSequence;
  state.currentId = stockId;
  renderStockSkeleton(stockId);
  const stock = state.stocks.find((item) => item.id === stockId);
  const symbol = stock?.symbol;
  const quotePromise = symbol ? fetchJSON(`/api/quotes/${encodeURIComponent(symbol)}`).catch((error) => ({ available: false, error: error.message })) : Promise.resolve(null);
  try {
    let detail = v4DetailCache.get(stockId);
    if (!detail) {
      detail = await fetchJSON(`/api/stocks/${stockId}?limit=1000`);
      v4DetailCache.set(stockId, detail);
    }
    if (sequence !== v4SelectionSequence) return;
    state.detail = detail;
    state.periodKind = state.periodKind || "quarter";
    state.periodKey = null;
    renderStock();
    loadStocks($("#stock-search").value.trim()).catch(() => {});
    window.scrollTo({ top: 0, behavior: "auto" });
    const quote = await quotePromise;
    if (sequence !== v4SelectionSequence || !state.detail) return;
    state.detail.quote = quote;
    renderQuoteHero();
    const targets = state.detail.brokers.filter((broker) => broker.latest_target);
    renderTargetChart(targets);
    renderBrokerCards(state.detail.brokers);
  } catch (error) {
    if (sequence !== v4SelectionSequence) return;
    $("#coverage-badges").innerHTML = `<span class="badge error-badge">เปิดข้อมูลไม่สำเร็จ: ${escapeHTML(error.message)}</span>`;
  }
};

renderQuoteHero = function renderQuoteHeroV4() {
  const quote = state.detail?.quote;
  const hero = $("#hero-cards");
  if (!hero) return;
  hero.querySelectorAll(".quote-hero").forEach((item) => item.remove());
  let card;
  if (quote?.loading) {
    card = `<div class="hero-card quote-hero skeleton-card"><span>ราคาจาก SET</span><strong>กำลังโหลด…</strong><small>ข้อมูลหุ้นในเครื่องแสดงได้โดยไม่ต้องรอราคา</small></div>`;
  } else if (quote?.available) {
    const isClose = quote.price_basis === "prior_close";
    const label = isClose ? "ราคาปิดล่าสุดจาก SET" : "ราคาล่าสุดจาก SET";
    const movement = quote.change === null || quote.change === undefined ? "" : `<small class="${(quote.change || 0) >= 0 ? "delta-positive" : "delta-negative"}">${signedNumber(quote.change)} (${signedNumber(quote.percent_change)}%)</small>`;
    card = `<div class="hero-card quote-hero"><span>${label}</span><strong>${formatNumber(quote.last)} บาท</strong>${movement}<small>${escapeHTML(quoteTime(quote))}${quote.stale ? " · ข้อมูลสำรอง" : ""}</small><a href="${escapeHTML(quote.source_url)}" target="_blank" rel="noopener noreferrer">เปิดหน้าราคา SET ↗</a></div>`;
  } else {
    card = `<div class="hero-card quote-hero unavailable"><span>ราคาจาก SET</span><strong>ไม่มีข้อมูล</strong><small>${escapeHTML(quote?.error || "หุ้นนี้อาจไม่ได้จดทะเบียนใน SET")}</small></div>`;
  }
  hero.insertAdjacentHTML("afterbegin", card);
};

function groupFrequency(group) {
  return group.period_kind === "year" || Number(group.period_quarter) === 5 ? "year" : "quarter";
}

function metricRowsTable(group) {
  const actual = group.actual;
  if (!group.rows.length) return `<tr><td colspan="6" class="empty-period">${actual ? `มีผลจริง ${metricDisplay(actual.value, group)} แต่ไม่พบประมาณการก่อนงบที่ผ่านเกณฑ์` : "ยังไม่พบประมาณการที่จับคู่สำนักและงวดได้"}</td></tr>`;
  return group.rows.map((row) => {
    const rank = actual ? `<span class="rank-badge">${row.accuracy_rank}</span>` : "—";
    return `<tr><td class="rank-cell">${rank}</td><td><strong>${escapeHTML(row.analyst)}</strong><small>ประมาณการ ณ ${shortDate(row.estimate_date)}</small></td><td class="numeric estimate-value">${metricDisplay(row.estimate, group)}</td><td class="numeric actual-value">${actual ? metricDisplay(actual.value, group) : `<span class="awaiting-pill">ยังไม่ออก</span>`}</td><td class="numeric compare-value">${comparisonCell(row, group)}</td><td class="reason-cell"><div>${escapeHTML(row.reason)}</div><small>ที่มา: ${escapeHTML(row.source_name || "ไม่ระบุไฟล์")}${row.source_line ? ` · บรรทัด ${row.source_line}` : ""}</small></td></tr>`;
  }).join("");
}

function renderSelectedMetricGroup(group) {
  if (!group) return `<div class="empty-selection"><strong>ไม่พบข้อมูลสำหรับตัวเลือกนี้</strong><span>ลองเลือกหัวข้อหรืองวดอื่น</span></div>`;
  const actual = group.actual;
  const reasons = actual?.reasons?.length ? `<ul>${actual.reasons.map((reason) => `<li>${escapeHTML(reason)}</li>`).join("")}</ul>` : "";
  const actualPanel = actual
    ? `<section class="actual-detail reported"><div class="actual-head"><div><span>ผลประกอบการจริง</span><strong>${metricDisplay(actual.value, group)}</strong></div><div><span>วันที่บทวิเคราะห์รายงาน</span><strong>${shortDate(actual.date)}</strong></div><div><span>หลักฐานยืนยัน</span><strong>${actual.supporting_sources || 1} แหล่ง</strong></div></div><h4>เหตุผลของผลจริง (รวมหลายบทวิเคราะห์และตัดข้อความซ้ำ)</h4>${reasons}</section>`
    : `<section class="actual-detail awaiting"><strong>ผลประกอบการจริง: ยังไม่ออก หรือยังไม่มีบทวิเคราะห์ผลจริงในฐานข้อมูล</strong><span>เมื่อกดอัปเดตหลังมีรายงานใหม่ ระบบจะเติมผลจริง เหตุผล และอันดับความแม่นยำในงวดเดิม</span></section>`;
  const summary = group.estimate_count ? `ทุกสำนัก ${group.estimate_count} แห่ง · ค่ากลาง ${metricDisplay(group.estimate_median, group)} · ช่วง ${metricDisplay(group.estimate_min, group)}–${metricDisplay(group.estimate_max, group)}` : "ยังไม่มีประมาณการจากสำนักที่ระบุชื่อได้";
  return `<div class="selected-period-title"><div><span>${escapeHTML(group.period_label)}</span><h3>${escapeHTML(group.metric_label)}</h3></div><strong>${escapeHTML(summary)}</strong></div>${actualPanel}<div class="readable-table-wrap"><table class="estimate-table v4-estimate-table"><caption>${escapeHTML(group.period_label)} — ${escapeHTML(group.metric_label)} หน่วย ${escapeHTML(group.unit_label)}</caption><thead><tr><th>อันดับใกล้เคียง</th><th>สำนัก / วันที่คาด</th><th>ประมาณการ</th><th>ผลจริง</th><th>คลาดเคลื่อน</th><th>เหตุผลและสมมติฐาน</th></tr></thead><tbody>${metricRowsTable(group)}</tbody></table></div>`;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function accuracyData(groups, margin = false) {
  const byBroker = new Map();
  groups.filter((group) => Boolean(group.actual) && (margin ? ["gpm", "npm"].includes(group.metric_code) : ["revenue", "net_profit", "core_profit"].includes(group.metric_code))).forEach((group) => {
    const minimum = Math.min(...group.rows.map((row) => row.absolute_error ?? Infinity));
    group.rows.forEach((row) => {
      const item = byBroker.get(row.analyst) || { analyst: row.analyst, errors: [], wins: 0, samples: [] };
      const error = margin ? row.absolute_error : row.absolute_error_pct;
      if (error !== null && error !== undefined && Number.isFinite(error)) {
        item.errors.push(error);
        if (Math.abs(row.absolute_error - minimum) < 1e-9) item.wins += 1;
        item.samples.push(`${group.period_label} ${group.metric_label}`);
      }
      byBroker.set(row.analyst, item);
    });
  });
  return [...byBroker.values()].map((item) => ({ ...item, median: median(item.errors), average: item.errors.reduce((sum, value) => sum + value, 0) / item.errors.length })).sort((a, b) => a.median - b.median || b.errors.length - a.errors.length);
}

function accuracyTable(items, margin = false) {
  if (!items.length) return `<p class="muted">ยังมีคู่ประมาณการ–ผลจริงไม่พอสำหรับจัดอันดับ</p>`;
  return `<div class="accuracy-table-wrap"><table class="accuracy-table"><thead><tr><th>อันดับ</th><th>สำนัก</th><th>งวดที่เทียบได้</th><th>${margin ? "Median error (จุด)" : "Median error (%)"}</th><th>เฉลี่ย</th><th>ใกล้ที่สุดกี่งวด</th></tr></thead><tbody>${items.map((item, index) => `<tr><td><span class="rank-badge">${index + 1}</span></td><td><strong>${escapeHTML(item.analyst)}</strong><small>${escapeHTML(item.samples.slice(0, 3).join(" · "))}</small></td><td>${item.errors.length}</td><td>${formatNumber(item.median, 2)}${margin ? " จุด" : "%"}</td><td>${formatNumber(item.average, 2)}${margin ? " จุด" : "%"}</td><td>${item.wins}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderAccuracyRanking(groups) {
  const money = accuracyData(groups, false);
  const margin = accuracyData(groups, true);
  $("#comparison-list").innerHTML = `<section class="accuracy-section"><div class="section-heading-row"><div><span class="eyebrow">FORECAST ACCURACY</span><h3>สำนักไหนประมาณการใกล้ผลจริงที่สุด</h3></div><small>คำนวณเฉพาะงวดที่มีทั้งประมาณการก่อนประกาศและผลจริง · ตัวอย่างน้อยควรตีความด้วยความระมัดระวัง</small></div><h4>รายได้และกำไร — เรียงจาก Median absolute error ต่ำสุด</h4>${accuracyTable(money, false)}${margin.length ? `<h4>GPM / NPM — คลาดเคลื่อนเป็นจุดเปอร์เซ็นต์</h4>${accuracyTable(margin, true)}` : ""}</section>`;
}

renderMetrics = function renderMetricsV4() {
  const groups = state.detail.metric_groups || [];
  const frequencies = ["quarter", "year"].filter((kind) => groups.some((group) => groupFrequency(group) === kind));
  if (!frequencies.includes(state.periodKind)) state.periodKind = frequencies.includes("quarter") ? "quarter" : (frequencies[0] || "quarter");
  const frequencyGroups = groups.filter((group) => groupFrequency(group) === state.periodKind);
  const periodMap = new Map();
  frequencyGroups.forEach((group) => { if (!periodMap.has(group.period_key)) periodMap.set(group.period_key, group.period_label.replace(/F$/, "")); });
  const periods = [...periodMap.entries()];
  if (!state.periodKey || !periodMap.has(state.periodKey)) state.periodKey = periods[0]?.[0] || null;
  const periodGroups = frequencyGroups.filter((group) => group.period_key === state.periodKey);
  const availableMetrics = ["revenue", "net_profit", "core_profit", "gpm", "npm"].filter((code) => periodGroups.some((group) => group.metric_code === code));
  if (!availableMetrics.includes(state.metricFilter)) state.metricFilter = availableMetrics.includes("net_profit") ? "net_profit" : (availableMetrics[0] || "revenue");

  $("#metric-filters").innerHTML = `<div class="period-control"><label>มุมมอง<select id="metric-frequency">${frequencies.map((kind) => `<option value="${kind}" ${kind === state.periodKind ? "selected" : ""}>${kind === "quarter" ? "รายไตรมาส" : "รายปี"}</option>`).join("")}</select></label><label>เลือกงวด<select id="metric-period">${periods.map(([key, label]) => `<option value="${escapeHTML(key)}" ${key === state.periodKey ? "selected" : ""}>${escapeHTML(label)}</option>`).join("")}</select></label></div><div class="metric-topic-control"><span>เลือกหัวข้อ</span>${availableMetrics.map((code) => `<button class="chip ${state.metricFilter === code ? "active" : ""}" data-metric="${code}">${metricThai[code]}</button>`).join("")}</div>`;
  $("#metric-frequency")?.addEventListener("change", (event) => { state.periodKind = event.target.value; state.periodKey = null; renderMetrics(); });
  $("#metric-period")?.addEventListener("change", (event) => { state.periodKey = event.target.value; renderMetrics(); });
  $$('[data-metric]').forEach((button) => button.addEventListener("click", () => { state.metricFilter = button.dataset.metric; renderMetrics(); }));
  let root = $("#readable-metrics-root");
  if (!root) { const wrap = document.querySelector("#tab-metrics .table-wrap"); wrap.innerHTML = `<div id="readable-metrics-root"></div>`; root = $("#readable-metrics-root"); }
  const selected = periodGroups.find((group) => group.metric_code === state.metricFilter);
  root.innerHTML = `<div class="metric-explainer"><strong>เลือกงวด → เลือกหัวข้อ → เทียบทุกสำนักในตารางเดียว</strong><span>ใช้เฉพาะตัวเลขที่จับคู่งวด หน่วย และสำนักได้ พร้อมตัดแถว YoY/QoQ และรายการซ้ำ</span></div>${renderSelectedMetricGroup(selected)}`;
  renderAccuracyRanking(groups);
};

const v4BaseRunUpdate = runUpdate;
runUpdate = async function runUpdateV4() {
  v4DetailCache.clear();
  await v4BaseRunUpdate();
};



// Keep the three core topics visible for every company and every selected period.
renderMetrics = function renderMetricsAllCompanyV8() {
  const groups = state.detail.metric_groups || [];
  const frequencies = ["quarter", "year"].filter((kind) => groups.some((group) => groupFrequency(group) === kind));
  if (!frequencies.includes(state.periodKind)) state.periodKind = frequencies.includes("quarter") ? "quarter" : (frequencies[0] || "quarter");
  const frequencyGroups = groups.filter((group) => groupFrequency(group) === state.periodKind);
  const periodMap = new Map();
  frequencyGroups.forEach((group) => {
    if (!periodMap.has(group.period_key)) periodMap.set(group.period_key, group.period_label.replace(/F$/, ""));
  });
  const periods = [...periodMap.entries()];
  if (!state.periodKey || !periodMap.has(state.periodKey)) state.periodKey = periods[0]?.[0] || null;
  const periodGroups = frequencyGroups.filter((group) => group.period_key === state.periodKey);
  const coreMetrics = ["revenue", "net_profit", "core_profit"];
  const marginMetrics = ["gpm", "npm"].filter((code) => periodGroups.some((group) => group.metric_code === code));
  const availableMetrics = [...coreMetrics, ...marginMetrics];
  if (!availableMetrics.includes(state.metricFilter)) state.metricFilter = "net_profit";

  const frequencyOptions = frequencies.length ? frequencies : ["quarter", "year"];
  $("#metric-filters").innerHTML = `<div class="period-control"><label>มุมมอง<select id="metric-frequency">${frequencyOptions.map((kind) => `<option value="${kind}" ${kind === state.periodKind ? "selected" : ""}>${kind === "quarter" ? "รายไตรมาส" : "รายปี"}</option>`).join("")}</select></label><label>เลือกงวด<select id="metric-period">${periods.map(([key, label]) => `<option value="${escapeHTML(key)}" ${key === state.periodKey ? "selected" : ""}>${escapeHTML(label)}</option>`).join("")}</select></label></div><div class="metric-topic-control"><span>เลือกหัวข้อ</span>${availableMetrics.map((code) => `<button class="chip ${state.metricFilter === code ? "active" : ""}" data-metric="${code}">${metricThai[code]}</button>`).join("")}</div>`;
  $("#metric-frequency")?.addEventListener("change", (event) => { state.periodKind = event.target.value; state.periodKey = null; renderMetrics(); });
  $("#metric-period")?.addEventListener("change", (event) => { state.periodKey = event.target.value; renderMetrics(); });
  $$('[data-metric]').forEach((button) => button.addEventListener("click", () => { state.metricFilter = button.dataset.metric; renderMetrics(); }));

  let root = $("#readable-metrics-root");
  if (!root) {
    const wrap = document.querySelector("#tab-metrics .table-wrap");
    wrap.innerHTML = `<div id="readable-metrics-root"></div>`;
    root = $("#readable-metrics-root");
  }
  const selected = periodGroups.find((group) => group.metric_code === state.metricFilter);
  const empty = `<div class="empty-selection"><strong>ยังไม่พบตัวเลข ${escapeHTML(metricThai[state.metricFilter])} ของงวดนี้ในบทวิเคราะห์ต้นฉบับ</strong><span>ระบบตรวจทุกสำนักที่ cover บริษัทแล้ว แต่จะแสดงเฉพาะสำนักที่ระบุตัวเลขของหัวข้อนี้อย่างชัดเจน ไม่เดาหรือแปลงจากตัวเลขอื่น</span></div>`;
  root.innerHTML = `<div class="metric-explainer"><strong>เลือกงวด → เลือกรายได้/กำไร → เทียบทุกสำนักที่มีตัวเลข</strong><span>หัวข้อรายได้ กำไรสุทธิ และกำไรปกติแสดงให้กดเสมอ; หากสำนักพูดถึงแนวโน้มแต่ไม่ได้ให้ตัวเลข จะไม่สร้างตัวเลขขึ้นเอง</span></div>${selected ? renderSelectedMetricGroup(selected) : empty}`;
  renderAccuracyRanking(groups);
};


// Row-level currency support for brokers that publish the same revenue metric in different currencies.
metricDisplay = function metricDisplayV13(value, item = {}) {
  if (value === null || value === undefined) return "—";
  if (item.scale === "percent") return `${formatNumber(value)}%`;
  const currency = item.currency ? `${item.currency} ` : "";
  return `${currency}${formatNumber(value)} ล้าน`;
};

metricRowsTable = function metricRowsTableV13(group) {
  const actual = group.actual;
  if (!group.rows.length) return `<tr><td colspan="6" class="empty-period">${actual ? `มีผลจริง ${metricDisplay(actual.value, actual)} แต่ไม่พบประมาณการก่อนงบที่ผ่านเกณฑ์` : "ยังไม่พบประมาณการที่จับคู่สำนักและงวดได้"}</td></tr>`;
  return group.rows.map((row) => {
    const rank = actual && row.accuracy_rank ? `<span class="rank-badge">${row.accuracy_rank}</span>` : "—";
    const actualCell = actual ? metricDisplay(actual.value, actual) : `<span class="awaiting-pill">ยังไม่ออก</span>`;
    const compare = actual && row.comparable_to_actual === false
      ? `<span class="muted">ต่างสกุลเงิน<br>ไม่คำนวณ</span>`
      : comparisonCell(row, { ...group, currency: row.currency || group.currency, scale: row.scale || group.scale });
    return `<tr><td class="rank-cell">${rank}</td><td><strong>${escapeHTML(row.analyst)}</strong><small>ประมาณการ ณ ${shortDate(row.estimate_date)}</small></td><td class="numeric estimate-value">${metricDisplay(row.estimate, row)}</td><td class="numeric actual-value">${actualCell}</td><td class="numeric compare-value">${compare}</td><td class="reason-cell"><div>${escapeHTML(row.reason)}</div><small>ที่มา: ${escapeHTML(row.source_name || "ไม่ระบุไฟล์")}${row.source_line ? ` · บรรทัด ${row.source_line}` : ""}</small></td></tr>`;
  }).join("");
};

renderSelectedMetricGroup = function renderSelectedMetricGroupV13(group) {
  if (!group) return `<div class="empty-selection"><strong>ไม่พบข้อมูลสำหรับตัวเลือกนี้</strong><span>ลองเลือกหัวข้อหรืองวดอื่น</span></div>`;
  const actual = group.actual;
  const reasons = actual?.reasons?.length ? `<ul>${actual.reasons.map((reason) => `<li>${escapeHTML(reason)}</li>`).join("")}</ul>` : "";
  const actualPanel = actual
    ? `<section class="actual-detail reported"><div class="actual-head"><div><span>ผลประกอบการจริง</span><strong>${metricDisplay(actual.value, actual)}</strong></div><div><span>วันที่บทวิเคราะห์รายงาน</span><strong>${shortDate(actual.date)}</strong></div><div><span>หลักฐานยืนยัน</span><strong>${actual.supporting_sources || 1} แหล่ง</strong></div></div><h4>เหตุผลของผลจริง (รวมหลายบทวิเคราะห์และตัดข้อความซ้ำ)</h4>${reasons}</section>`
    : `<section class="actual-detail awaiting"><strong>ผลประกอบการจริง: ยังไม่ออก หรือยังไม่มีบทวิเคราะห์ผลจริงในฐานข้อมูล</strong><span>เมื่อกดอัปเดตหลังมีรายงานใหม่ ระบบจะเติมผลจริง เหตุผล และอันดับความแม่นยำในงวดเดิม</span></section>`;
  const summary = !group.estimate_count
    ? "ยังไม่มีประมาณการจากสำนักที่ระบุชื่อได้"
    : group.mixed_currency
      ? `ทุกสำนัก ${group.estimate_count} แห่ง · แสดงหน่วยตามต้นฉบับของแต่ละสำนัก จึงไม่รวมค่ากลางข้ามสกุลเงิน`
      : `ทุกสำนัก ${group.estimate_count} แห่ง · ค่ากลาง ${metricDisplay(group.estimate_median, group)} · ช่วง ${metricDisplay(group.estimate_min, group)}–${metricDisplay(group.estimate_max, group)}`;
  return `<div class="selected-period-title"><div><span>${escapeHTML(group.period_label)}</span><h3>${escapeHTML(group.metric_label)}</h3></div><strong>${escapeHTML(summary)}</strong></div>${actualPanel}<div class="readable-table-wrap"><table class="estimate-table v4-estimate-table"><caption>${escapeHTML(group.period_label)} — ${escapeHTML(group.metric_label)} · ${escapeHTML(group.unit_label)}</caption><thead><tr><th>อันดับใกล้เคียง</th><th>สำนัก / วันที่คาด</th><th>ประมาณการ</th><th>ผลจริง</th><th>คลาดเคลื่อน</th><th>เหตุผลและสมมติฐาน</th></tr></thead><tbody>${metricRowsTable(group)}</tbody></table></div>`;
};


// v27: complete profit view plus reports that mention the period without a usable number.
metricThai.profit = "กำไร (สุทธิ/ปกติ)";

renderMetrics = function renderMetricsV27() {
  const groups = state.detail.metric_groups || [];
  const frequencies = ["quarter", "year"].filter((kind) => groups.some((group) => groupFrequency(group) === kind));
  if (!frequencies.includes(state.periodKind)) state.periodKind = frequencies.includes("quarter") ? "quarter" : (frequencies[0] || "quarter");
  const frequencyGroups = groups.filter((group) => groupFrequency(group) === state.periodKind);
  const periodMap = new Map();
  frequencyGroups.forEach((group) => {
    if (!periodMap.has(group.period_key)) periodMap.set(group.period_key, group.period_label.replace(/F$/, ""));
  });
  const periods = [...periodMap.entries()];
  if (!state.periodKey || !periodMap.has(state.periodKey)) state.periodKey = periods[0]?.[0] || null;
  const periodGroups = frequencyGroups.filter((group) => group.period_key === state.periodKey);
  const coreMetrics = ["revenue", "profit", "net_profit", "core_profit"];
  const marginMetrics = ["gpm", "npm"].filter((code) => periodGroups.some((group) => group.metric_code === code));
  const availableMetrics = [...coreMetrics, ...marginMetrics];
  if (!availableMetrics.includes(state.metricFilter)) state.metricFilter = "profit";

  const frequencyOptions = frequencies.length ? frequencies : ["quarter", "year"];
  $("#metric-filters").innerHTML = `<div class="period-control"><label>มุมมอง<select id="metric-frequency">${frequencyOptions.map((kind) => `<option value="${kind}" ${kind === state.periodKind ? "selected" : ""}>${kind === "quarter" ? "รายไตรมาส" : "รายปี"}</option>`).join("")}</select></label><label>เลือกงวด<select id="metric-period">${periods.map(([key, label]) => `<option value="${escapeHTML(key)}" ${key === state.periodKey ? "selected" : ""}>${escapeHTML(label)}</option>`).join("")}</select></label></div><div class="metric-topic-control"><span>เลือกหัวข้อ</span>${availableMetrics.map((code) => `<button class="chip ${state.metricFilter === code ? "active" : ""}" data-metric="${code}">${metricThai[code]}</button>`).join("")}</div>`;
  $("#metric-frequency")?.addEventListener("change", (event) => { state.periodKind = event.target.value; state.periodKey = null; renderMetrics(); });
  $("#metric-period")?.addEventListener("change", (event) => { state.periodKey = event.target.value; renderMetrics(); });
  $$('[data-metric]').forEach((button) => button.addEventListener("click", () => { state.metricFilter = button.dataset.metric; renderMetrics(); }));

  let root = $("#readable-metrics-root");
  if (!root) {
    const wrap = document.querySelector("#tab-metrics .table-wrap");
    wrap.innerHTML = `<div id="readable-metrics-root"></div>`;
    root = $("#readable-metrics-root");
  }
  const selected = periodGroups.find((group) => group.metric_code === state.metricFilter);
  const empty = `<div class="empty-selection"><strong>ยังไม่พบตัวเลข ${escapeHTML(metricThai[state.metricFilter])} ของงวดนี้ในบทวิเคราะห์ต้นฉบับ</strong><span>ระบบไม่สร้างตัวเลขจากข้อความเชิงแนวโน้ม แต่จะแสดงรายชื่อสำนักที่กล่าวถึงงวดนี้ไว้แยกต่างหากเมื่อมีข้อมูล</span></div>`;
  root.innerHTML = `<div class="metric-explainer"><strong>เลือกงวด → เลือกรายได้/กำไร → เทียบทุกสำนักที่มีตัวเลข</strong><span>ปุ่ม “กำไร (สุทธิ/ปกติ)” รวมรายชื่อสำนักให้ครบในหน้าเดียว และระบุชนิดกำไรของแต่ละแถวเพื่อไม่ให้เทียบผิดนิยาม</span></div>${selected ? renderSelectedMetricGroup(selected) : empty}`;
  renderAccuracyRanking(groups);
};

metricRowsTable = function metricRowsTableV27(group) {
  const actual = group.actual;
  if (!group.rows.length) return `<tr><td colspan="6" class="empty-period">${actual ? `มีผลจริง ${metricDisplay(actual.value, actual)} แต่ไม่พบประมาณการก่อนงบที่ผ่านเกณฑ์` : "ยังไม่พบประมาณการที่จับคู่สำนักและงวดได้"}</td></tr>`;
  return group.rows.map((row) => {
    const rank = actual && row.accuracy_rank ? `<span class="rank-badge">${row.accuracy_rank}</span>` : "—";
    const actualCell = actual ? metricDisplay(actual.value, actual) : `<span class="awaiting-pill">ยังไม่ออก</span>`;
    const compare = actual && row.comparable_to_actual === false
      ? `<span class="muted">คนละนิยาม/สกุลเงิน<br>ไม่คำนวณอันดับ</span>`
      : comparisonCell(row, { ...group, currency: row.currency || group.currency, scale: row.scale || group.scale });
    const type = row.profit_type ? `<small><span class="awaiting-pill">${escapeHTML(row.profit_type)}</span></small>` : "";
    const alternate = row.alternate_profit ? `<small>อีกนิยามในรายงาน: ${escapeHTML(row.alternate_profit.type)} ${metricDisplay(row.alternate_profit.value, row.alternate_profit)}</small>` : "";
    return `<tr><td class="rank-cell">${rank}</td><td><strong>${escapeHTML(row.analyst)}</strong>${type}<small>ประมาณการ ณ ${shortDate(row.estimate_date)}</small></td><td class="numeric estimate-value">${metricDisplay(row.estimate, row)}${alternate}</td><td class="numeric actual-value">${actualCell}</td><td class="numeric compare-value">${compare}</td><td class="reason-cell"><div>${escapeHTML(row.reason)}</div><small>ที่มา: ${escapeHTML(row.source_name || "ไม่ระบุไฟล์")}${row.source_line ? ` · บรรทัด ${row.source_line}` : ""}</small></td></tr>`;
  }).join("");
};

renderSelectedMetricGroup = function renderSelectedMetricGroupV27(group) {
  if (!group) return `<div class="empty-selection"><strong>ไม่พบข้อมูลสำหรับตัวเลือกนี้</strong><span>ลองเลือกหัวข้อหรืองวดอื่น</span></div>`;
  const actual = group.actual;
  const reasons = actual?.reasons?.length ? `<ul>${actual.reasons.map((reason) => `<li>${escapeHTML(reason)}</li>`).join("")}</ul>` : "";
  const actualType = actual?.profit_type ? ` (${escapeHTML(actual.profit_type)})` : "";
  const actualPanel = actual
    ? `<section class="actual-detail reported"><div class="actual-head"><div><span>ผลประกอบการจริง${actualType}</span><strong>${metricDisplay(actual.value, actual)}</strong></div><div><span>วันที่บทวิเคราะห์รายงาน</span><strong>${shortDate(actual.date)}</strong></div><div><span>หลักฐานยืนยัน</span><strong>${actual.supporting_sources || 1} แหล่ง</strong></div></div><h4>เหตุผลของผลจริง (รวมหลายบทวิเคราะห์และตัดข้อความซ้ำ)</h4>${reasons}</section>`
    : `<section class="actual-detail awaiting"><strong>ผลประกอบการจริง: ยังไม่ออก หรือยังไม่มีบทวิเคราะห์ผลจริงในฐานข้อมูล</strong><span>เมื่อกดอัปเดตหลังมีรายงานใหม่ ระบบจะเติมผลจริง เหตุผล และอันดับความแม่นยำในงวดเดิม</span></section>`;
  const summary = !group.estimate_count
    ? "ยังไม่มีประมาณการจากสำนักที่ระบุชื่อได้"
    : group.mixed_currency || group.mixed_profit_definitions
      ? `ทุกสำนักที่มีตัวเลข ${group.estimate_count} แห่ง · ตารางระบุหน่วยและนิยามกำไรแยกรายสำนัก`
      : `ทุกสำนักที่มีตัวเลข ${group.estimate_count} แห่ง · ค่ากลาง ${metricDisplay(group.estimate_median, group)} · ช่วง ${metricDisplay(group.estimate_min, group)}–${metricDisplay(group.estimate_max, group)}`;
  const missing = group.covered_without_number || [];
  const missingPanel = missing.length
    ? `<section class="actual-detail awaiting"><strong>กล่าวถึงงวดนี้ แต่ไม่ระบุตัวเลขที่ใช้เทียบได้: ${missing.length} สำนัก</strong><ul>${missing.map((item) => `<li><strong>${escapeHTML(item.analyst)}</strong> (${shortDate(item.date)}) — ${escapeHTML(item.reason)}</li>`).join("")}</ul><span>ส่วนนี้อธิบายว่าทำไมจำนวนสำนักในหน้า Overview อาจมากกว่าจำนวนแถวประมาณการ โดยระบบจะไม่เดาตัวเลขแทนสำนัก</span></section>`
    : "";
  return `<div class="selected-period-title"><div><span>${escapeHTML(group.period_label)}</span><h3>${escapeHTML(group.metric_label)}</h3></div><strong>${escapeHTML(summary)}</strong></div>${actualPanel}<div class="readable-table-wrap"><table class="estimate-table v4-estimate-table"><caption>${escapeHTML(group.period_label)} — ${escapeHTML(group.metric_label)} · ${escapeHTML(group.unit_label)}</caption><thead><tr><th>อันดับใกล้เคียง</th><th>สำนัก / วันที่คาด</th><th>ประมาณการ</th><th>ผลจริง</th><th>คลาดเคลื่อน</th><th>เหตุผลและสมมติฐาน</th></tr></thead><tbody>${metricRowsTable(group)}</tbody></table></div>${missingPanel}`;
};


// v52: keep forecast evidence separate from result evidence and render large histories lazily.

function v52EstimateText(row, group) {
  const low = Number(row.estimate_low ?? row.estimate);
  const high = Number(row.estimate_high ?? row.estimate);
  if (Number.isFinite(low) && Number.isFinite(high) && Math.abs(high - low) > 1e-9) {
    const highText = metricDisplay(high, row);
    const highWithoutCurrency = highText.replace(/^\S+\s+/, "");
    return `${metricDisplay(low, row)}–${highWithoutCurrency}`;
  }
  return metricDisplay(row.estimate, row);
}

metricRowsTable = function metricRowsTableV52(group) {
  const actual = group.actual;
  if (!group.rows.length) {
    return `<tr><td colspan="6" class="empty-period">${actual ? `มีผลจริง ${metricDisplay(actual.value, actual)} แต่ยังไม่พบประมาณการก่อนงบออกที่ตรวจสอบได้` : "ยังไม่พบตัวเลขประมาณการของงวดนี้"}</td></tr>`;
  }
  return group.rows.map((row) => {
    const rank = actual && row.accuracy_rank ? `<span class="rank-badge">${row.accuracy_rank}</span>` : "—";
    const actualCell = actual ? metricDisplay(actual.value, actual) : `<span class="awaiting-pill">ยังไม่ออก</span>`;
    const compare = actual && row.comparable_to_actual === false
      ? `<span class="muted">คนละนิยามกำไร<br>ไม่จัดอันดับ</span>`
      : comparisonCell(row, { ...group, currency: row.currency || group.currency, scale: row.scale || group.scale });
    const type = row.profit_type ? `<small><span class="awaiting-pill">${escapeHTML(row.profit_type)}</span></small>` : "";
    const alternate = row.alternate_profit
      ? `<small>ตัวเลขกำไรอีกนิยามในรายงาน: ${escapeHTML(row.alternate_profit.type)} ${metricDisplay(row.alternate_profit.value, row.alternate_profit)}</small>`
      : "";
    const reason = row.forecast_reason || row.reason || "บทวิเคราะห์ระบุตัวเลข แต่ไม่ได้แยกเหตุผลของประมาณการงวดนี้ไว้อย่างชัดเจน";
    return `<tr><td class="rank-cell">${rank}</td><td><strong>${escapeHTML(row.analyst)}</strong>${type}<small>ประมาณการ ณ ${shortDate(row.estimate_date)}</small></td><td class="numeric estimate-value">${v52EstimateText(row, group)}${alternate}</td><td class="numeric actual-value">${actualCell}</td><td class="numeric compare-value">${compare}</td><td class="reason-cell"><div>${escapeHTML(reason)}</div><small>ที่มา: ${escapeHTML(row.source_name || "ไม่พบชื่อไฟล์")}${row.source_line ? ` · บรรทัด ${row.source_line}` : ""}</small></td></tr>`;
  }).join("");
};

let v52KnowledgeLimit = 80;
let v52DeferredStockId = null;
let v52KnowledgeHydrated = false;
let v52SourcesHydrated = false;

const v52RenderKnowledgeFilters = renderKnowledgeFilters;
const v52RenderSources = (...args) => (window.__ONLINE_RENDER_SOURCES__ || renderSources)(...args);

renderKnowledge = function renderKnowledgeV52() {
  if (!state.detail) return;
  const type = $("#knowledge-type").value;
  const query = $("#knowledge-search").value.trim().toLowerCase();
  const sort = $("#knowledge-sort").value;
  let items = state.detail.knowledge.filter((item) => (!type || item.item_type === type) && (!query || `${item.heading} ${item.content}`.toLowerCase().includes(query)));
  items = items.slice().sort((a, b) => sort === "oldest" ? a.report_date.localeCompare(b.report_date) : b.report_date.localeCompare(a.report_date));
  const visible = items.slice(0, v52KnowledgeLimit);
  renderTimeline(visible, $("#knowledge-timeline"));
  if (visible.length < items.length) {
    $("#knowledge-timeline").insertAdjacentHTML("beforeend", `<div class="panel v52-more-wrap"><button id="v52-knowledge-more" class="secondary-button">แสดงเพิ่มอีก ${Math.min(80, items.length - visible.length)} รายการ</button><small>แสดงแล้ว ${visible.length} จาก ${items.length} รายการ</small></div>`);
    $("#v52-knowledge-more").addEventListener("click", () => { v52KnowledgeLimit += 80; renderKnowledge(); });
  }
};

function v52HydrateTab(name) {
  if (!state.detail || state.currentId !== v52DeferredStockId) return;
  if (name === "knowledge" && !v52KnowledgeHydrated) {
    v52KnowledgeHydrated = true;
    v52RenderKnowledgeFilters(state.detail.knowledge);
    renderKnowledge();
  }
  if (name === "sources" && !v52SourcesHydrated) {
    v52SourcesHydrated = true;
    v52RenderSources(state.detail.sources);
  }
}

const v52BaseRenderStock = renderStock;
renderStock = function renderStockV52Fast() {
  v52DeferredStockId = state.currentId;
  v52KnowledgeHydrated = false;
  v52SourcesHydrated = false;
  v52KnowledgeLimit = 80;
  const fullFilters = renderKnowledgeFilters;
  const fullKnowledge = renderKnowledge;
  const fullSources = renderSources;
  renderKnowledgeFilters = () => {};
  renderKnowledge = () => {};
  renderSources = () => {};
  try {
    v52BaseRenderStock();
  } finally {
    renderKnowledgeFilters = fullFilters;
    renderKnowledge = fullKnowledge;
    renderSources = fullSources;
  }
  const active = document.querySelector(".tab.active")?.dataset.tab || "overview";
  requestAnimationFrame(() => v52HydrateTab(active));
};

const v52BaseActivateTab = activateTab;
activateTab = function activateTabV52(name) {
  v52BaseActivateTab(name);
  requestAnimationFrame(() => v52HydrateTab(name));
};

const v52BaseRunUpdate = runUpdate;
runUpdate = async function runUpdateV52() {
  v4DetailCache.clear();
  return v52BaseRunUpdate();
};
