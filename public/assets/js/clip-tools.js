/* Clip tools: AI score/hook/hashtags on clip cards, direct video upload, clip editor and scheduler.
   All server/AI text is escaped before it touches innerHTML. */
(function () {
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = new Map(); // "historyId:idx" -> clip

  function toast(msg) {
    let t = document.querySelector(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
  }

  const captionFor = (c) => [c.description, (c.hashtags || []).map(h => "#" + h).join(" ")].filter(Boolean).join("\n\n");

  // HTML snippet rendered inside each clip card (live results + history).
  window.rsClipExtras = function (clip, historyId, idx, compact) {
    if (!historyId) return "";
    store.set(`${historyId}:${idx}`, clip);
    const s = clip.score;
    const cls = s == null ? "" : s >= 80 ? "hot" : s >= 65 ? "good" : s >= 45 ? "mid" : "low";
    const score = s == null ? "" : `<span class="pill ${cls}" title="AI virality score">🔥 ${esc(s)}/100</span>`;
    const attrs = `data-hid="${esc(historyId)}" data-idx="${esc(idx)}"`;
    const meta = compact ? "" : `
      ${score ? `<div class="frame-meta">${score} ${esc(clip.scoreNote || "")}</div>` : ""}
      ${clip.hook ? `<div class="frame-hook">“${esc(clip.hook)}”</div>` : ""}
      ${(clip.hashtags || []).length ? `<div class="frame-tags">${clip.hashtags.map(h => "#" + esc(h)).join(" ")}</div>` : ""}`;
    return `${meta}<div class="frame-actions">
      ${compact && score ? score : ""}
      <button type="button" data-act="copy" ${attrs}>Copy caption</button>
      <button type="button" data-act="edit" ${attrs}>Edit</button>
      <button type="button" data-act="schedule" ${attrs}>Schedule</button></div>`;
  };

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const clip = store.get(`${b.dataset.hid}:${b.dataset.idx}`); if (!clip) return;
    const ref = { hid: b.dataset.hid, idx: Number(b.dataset.idx), clip };
    if (b.dataset.act === "copy") {
      const text = captionFor(clip) || clip.title || "";
      navigator.clipboard.writeText(text).then(() => toast("Caption copied"), () => toast("Couldn't copy"));
    } else if (b.dataset.act === "edit") openEditor(ref);
    else if (b.dataset.act === "schedule") openScheduler(ref);
  });

  // ───────── modal helper ─────────
  function modal(html) {
    const bg = document.createElement("div"); bg.className = "rs-modal-bg";
    bg.innerHTML = `<div class="rs-modal" role="dialog" aria-modal="true">${html}</div>`;
    const close = () => bg.remove();
    bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
    document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
    document.body.appendChild(bg);
    bg.querySelectorAll("[data-close]").forEach(x => x.addEventListener("click", close));
    return { el: bg.firstElementChild, close };
  }
  const msg = (m, text, kind) => { const el = m.el.querySelector(".rs-msg"); el.textContent = text; el.className = "rs-msg " + (kind || ""); };

  function refreshHistory() {
    try { if (typeof loadClipHistory === "function") { clipHistoryLoaded = false; if (clipHistoryOpen) { loadClipHistory(); clipHistoryLoaded = true; } } } catch (e) {}
  }

  // ───────── clip editor ─────────
  function openEditor({ hid, idx, clip }) {
    const dur = Math.max(3, Math.round((clip.duration || 30) * 10) / 10);
    const m = modal(`
      <h3>Edit clip</h3><span class="m">${esc(clip.title || "Clip")} · ${esc(dur)}s — creates a new clip, the original stays</span>
      <div class="rs-field"><label>Trim (seconds)</label>
        <div class="rs-row"><input id="edStart" type="number" min="0" max="${dur - 3}" step="0.1" value="0"><input id="edEnd" type="number" min="3" max="${dur}" step="0.1" value="${dur}"></div></div>
      <label class="rs-check"><input type="checkbox" id="edFrame"> Change framing</label>
      <div id="edFrameBox" style="display:none">
        <div class="rs-field"><label>Aspect ratio</label><select id="edAspect"><option>9:16</option><option>1:1</option><option>4:5</option><option>16:9</option></select></div>
        <div class="rs-field"><label>Focus point: <span id="edFocusVal">50</span>% from left</label><input class="rs-range" id="edFocus" type="range" min="0" max="100" value="50"></div>
        <div class="ai-note">Framing needs the original caption-free video. It re-renders from the source.</div>
      </div>
      <label class="rs-check"><input type="checkbox" id="edBrand"> Apply my brand kit (logo)</label>
      <div class="rs-msg"></div>
      <div class="rs-foot"><button class="btn out" data-close>Cancel</button><button class="btn" id="edGo">Create edited clip</button></div>`);
    const q = (id) => m.el.querySelector("#" + id);
    q("edFrame").addEventListener("change", (e) => (q("edFrameBox").style.display = e.target.checked ? "block" : "none"));
    q("edFocus").addEventListener("input", (e) => (q("edFocusVal").textContent = e.target.value));
    q("edGo").addEventListener("click", async () => {
      const body = { startSec: Number(q("edStart").value), endSec: Number(q("edEnd").value) };
      if (q("edFrame").checked) { body.aspectRatio = q("edAspect").value; body.focusX = Number(q("edFocus").value); }
      if (q("edBrand").checked) body.applyBrand = true;
      const btn = q("edGo"); btn.disabled = true; msg(m, "Rendering… this can take a minute.");
      try {
        const r = await fetch(`/clips/${hid}/${idx}/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await r.json();
        if (!d.success) { msg(m, d.error || "Edit failed.", "err"); btn.disabled = false; return; }
        msg(m, "Done! Your edited clip is in the history list below.", "ok");
        refreshHistory(); setTimeout(m.close, 1400);
      } catch (e) { msg(m, "Network error. Please try again.", "err"); btn.disabled = false; }
    });
  }

  // ───────── scheduler ─────────
  async function openScheduler({ hid, idx, clip }) {
    let info;
    try { info = await (await fetch("/schedule")).json(); } catch (e) { return toast("Couldn't load scheduler"); }
    if (!info.success) return toast(info.error || "Please log in");
    if (!info.allowed) return toast(`Scheduling needs the ${info.planRequired} plan or above`);
    const soon = new Date(Date.now() + 60 * 60 * 1000); soon.setMinutes(0, 0, 0);
    const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const m = modal(`
      <h3>Schedule a post</h3><span class="m">${esc(clip.title || "Clip")} — we'll email you the caption and a download link at that time.</span>
      <div class="rs-field"><label>Platform</label><select id="scPlat">${info.platforms.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("")}</select></div>
      <div class="rs-field"><label>When</label><input id="scWhen" type="datetime-local" value="${local}"></div>
      <div class="rs-field"><label>Caption</label><textarea id="scCap" maxlength="2200">${esc(captionFor(clip))}</textarea></div>
      <div class="ai-note">Clips are stored for 24 hours, so pick a time within that window. Download last — a downloaded clip is removed 5 minutes later.</div>
      <div class="rs-msg"></div>
      <div class="rs-foot"><button class="btn out" data-close>Cancel</button><button class="btn" id="scGo">Schedule</button></div>`);
    const q = (id) => m.el.querySelector("#" + id);
    q("scGo").addEventListener("click", async () => {
      const when = new Date(q("scWhen").value);
      if (isNaN(when)) return msg(m, "Choose a date and time.", "err");
      q("scGo").disabled = true;
      try {
        const r = await fetch("/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ historyId: hid, clipIndex: idx, platform: q("scPlat").value, scheduledAt: when.toISOString(), caption: q("scCap").value }) });
        const d = await r.json();
        if (!d.success) { msg(m, d.error || "Couldn't schedule.", "err"); q("scGo").disabled = false; return; }
        msg(m, "Scheduled ✓ You can manage it in Studio → Schedule.", "ok"); setTimeout(m.close, 1400);
      } catch (e) { msg(m, "Network error.", "err"); q("scGo").disabled = false; }
    });
  }

  // ───────── direct upload (browser → S3) ─────────
  const upBtn = document.getElementById("rsUploadBtn"), upFile = document.getElementById("rsUploadFile");
  if (upBtn && upFile) {
    const nameEl = document.getElementById("rsUploadName"), bar = document.getElementById("rsUploadBar"), clr = document.getElementById("rsUploadClear");
    window.rsClearUpload = () => { window.rsUpload = null; nameEl.textContent = ""; clr.style.display = "none"; bar.style.display = "none"; upFile.value = ""; };
    clr.addEventListener("click", window.rsClearUpload);
    upBtn.addEventListener("click", () => upFile.click());
    upFile.addEventListener("change", async () => {
      const f = upFile.files[0]; if (!f) return;
      nameEl.textContent = "Preparing upload…"; bar.style.display = "block"; bar.firstElementChild.style.width = "0";
      try {
        const r = await fetch("/upload-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: f.name, size: f.size }) });
        const d = await r.json();
        if (!d.success) { nameEl.textContent = d.error || "Upload not allowed."; bar.style.display = "none"; return; }
        await new Promise((resolve, reject) => {
          const x = new XMLHttpRequest(); x.open("PUT", d.uploadUrl);
          Object.entries(d.headers || {}).forEach(([k, v]) => x.setRequestHeader(k, v));
          x.upload.onprogress = (ev) => { if (ev.lengthComputable) { const p = Math.round(ev.loaded / ev.total * 100); bar.firstElementChild.style.width = p + "%"; nameEl.textContent = `Uploading ${f.name} — ${p}%`; } };
          x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error("Upload failed (" + x.status + ")")));
          x.onerror = () => reject(new Error("Upload failed. Check your connection."));
          x.send(f);
        });
        window.rsUpload = { key: d.sourceKey, name: f.name };
        document.getElementById("clipUrl").value = "";
        nameEl.textContent = `✓ ${f.name} ready — pick captions and hit Generate`; clr.style.display = "inline-flex"; bar.style.display = "none";
      } catch (e) { nameEl.textContent = e.message || "Upload failed."; bar.style.display = "none"; window.rsUpload = null; }
    });
  }
})();
