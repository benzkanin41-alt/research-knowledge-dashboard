(function () {
  "use strict";

  function renderOnlineSources(sources) {
    const body = document.querySelector("#sources-table tbody");
    if (!body) return;
    body.innerHTML = (sources || []).map((source) => `<tr>
      <td>${shortDate(source.report_date)}</td>
      <td>${escapeHTML(source.name)}<div class="broker-meta">ซ่อน Local path ในเว็บไซต์สาธารณะ</div></td>
      <td>${source.first_line ?? "—"}–${source.last_line ?? "—"}</td>
      <td>${source.item_count ?? 0}</td>
      <td><span class="online-safe-label">เผยแพร่เฉพาะชื่อไฟล์</span></td>
    </tr>`).join("");
  }

  window.__ONLINE_RENDER_SOURCES__ = renderOnlineSources;
  window.renderSources = renderOnlineSources;

  document.addEventListener("DOMContentLoaded", async () => {
    const updateButton = document.querySelector("#update-button");
    if (updateButton) {
      updateButton.disabled = true;
      updateButton.textContent = "อัปเดตผ่าน Local แล้ว Deploy ใหม่";
      updateButton.title = "Online Dashboard เป็น snapshot แบบอ่านอย่างเดียว";
    }

    const sourceHeader = document.querySelector("#sources-table thead th:last-child");
    if (sourceHeader) sourceHeader.textContent = "ข้อมูลสาธารณะ";

    const main = document.querySelector(".main-content");
    const banner = document.createElement("section");
    banner.className = "online-snapshot-banner";
    banner.innerHTML = `<div><strong>Online Dashboard · Read-only snapshot</strong><span id="online-snapshot-time">กำลังอ่านเวลาข้อมูล…</span></div><div class="online-disclaimer">ข้อมูลเพื่อการศึกษา ไม่ใช่คำแนะนำซื้อขายหลักทรัพย์</div>`;
    if (main) main.prepend(banner);

    try {
      const manifest = await window.__ONLINE_DASHBOARD__.loadJSON("data/manifest.json");
      const generated = new Date(manifest.generated_at);
      const shown = Number.isNaN(generated.getTime())
        ? manifest.generated_at
        : new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(generated);
      const label = `ข้อมูลออนไลน์ ณ ${shown} · ${manifest.stock_count.toLocaleString("th-TH")} หุ้น`;
      const timeNode = document.querySelector("#online-snapshot-time");
      if (timeNode) timeNode.textContent = label;
      const updateMessage = document.querySelector("#update-message");
      if (updateMessage) updateMessage.textContent = label;
    } catch (error) {
      const timeNode = document.querySelector("#online-snapshot-time");
      if (timeNode) timeNode.textContent = `อ่านเวลา snapshot ไม่สำเร็จ: ${error.message}`;
    }
  });
})();
