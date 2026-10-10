/* AI tools on the dashboard: summary, chapters, translation, repurposing and SRT/VTT/TXT export.
   Everything the AI returns is inserted with textContent (never innerHTML). */
(function () {
  const panel = document.getElementById("aiPanel");
  if (!panel) return;
  const $ = (id) => document.getElementById(id);
  const resultEl = $("aiResult"), quotaEl = $("aiQuota"), langSel = $("aiLang"), fmtSel = $("aiFormat"), useTr = $("aiUseTranslated");
  let reel = null, lastResult = "", translatedLang = "";

  function show(text, isErr) {
    resultEl.textContent = text;
    resultEl.className = "ai-result show" + (isErr ? " err" : "");
    $("aiCopy").style.display = isErr ? "none" : "inline-flex";
    lastResult = isErr ? "" : text;
  }

  function setBusy(btn, busy) { btn.disabled = busy; btn.classList.toggle("busy", busy); }

  async function loadOptions() {
    try {
      const r = await fetch("/ai/options"); const d = await r.json();
      if (!d.success) return;
      langSel.innerHTML = ""; d.languages.forEach(l => langSel.add(new Option(l, l)));
      fmtSel.innerHTML = ""; d.formats.forEach(f => fmtSel.add(new Option(f.label, f.id)));
      quotaEl.textContent = `${Math.max(0, d.aiLimit - d.aiUsed)}/${d.aiLimit} AI actions left today`;
    } catch (e) {}
  }

  function format(action, result) {
    if (action === "chapters") return result.map(c => `${c.time || "--:--"} ${c.title}`).join("\n");
    if (action === "translate") return result.text || "";
    return String(result || "");
  }

  async function run(action, btn) {
    if (!reel) return show("Create or open a transcript first.", true);
    const body = {};
    if (action === "translate") body.language = langSel.value;
    if (action === "repurpose") body.format = fmtSel.value;
    setBusy(btn, true); show("Working…");
    try {
      const res = await fetch(`/ai/transcript/${reel.id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!d.success) { show(d.error || "Something went wrong.", true); return; }
      show(format(action, d.result));
      if (action === "translate") { translatedLang = d.language; useTr.disabled = false; $("aiTrLabel").textContent = `Use ${d.language} translation`; }
      loadOptions();
    } catch (e) { show("Network error. Please try again.", true); }
    finally { setBusy(btn, false); }
  }

  panel.querySelectorAll("[data-ai]").forEach(btn => btn.addEventListener("click", () => run(btn.dataset.ai, btn)));

  async function download(ext) {
    if (!reel) return;
    const lang = useTr.checked && translatedLang ? `?lang=${encodeURIComponent(translatedLang)}` : "";
    try {
      const res = await fetch(`/transcript/${reel.id}/export.${ext}${lang}`);
      if (!res.ok) { const d = await res.json().catch(() => ({})); show(d.error || "Export failed.", true); return; }
      const blob = await res.blob();
      const name = (res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || `transcript.${ext}`;
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { show("Export failed. Please try again.", true); }
  }
  panel.querySelectorAll("[data-export]").forEach(b => b.addEventListener("click", () => download(b.dataset.export)));

  $("aiCopy").addEventListener("click", () => {
    if (!lastResult) return;
    navigator.clipboard.writeText(lastResult).then(() => { const b = $("aiCopy"); const o = b.textContent; b.textContent = "Copied"; setTimeout(() => (b.textContent = o), 1800); });
  });

  // Called by dashboard.js whenever the visible transcript changes.
  window.rsSetReel = function (r) {
    reel = r && r.id ? r : null;
    panel.style.display = reel ? "block" : "none";
    resultEl.className = "ai-result"; translatedLang = ""; useTr.checked = false; useTr.disabled = true; $("aiTrLabel").textContent = "Use translation";
    $("aiNoSeg").style.display = reel && reel.hasSegments === false ? "block" : "none";
  };
  if (window.rsCurrentReel) window.rsSetReel(window.rsCurrentReel);
  loadOptions();
})();
