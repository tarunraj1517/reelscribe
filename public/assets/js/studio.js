/* Studio: brand kit, team, schedule, API keys & webhooks. */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);
function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600); }
async function api(path, method = "GET", body) {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { window.location.href = "/login.html?next=/studio.html"; throw new Error("login"); }
  return res.json();
}
const lock = (plan, what) => `<div class="lock-card"><b>${esc(what)} is on the ${esc(plan)} plan</b>Upgrade to unlock it. <a style="color:var(--acc);font-weight:600" href="/pricing.html">View plans →</a></div>`;
const fmt = (d) => d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

/* ── identity / drawer ── */
function openDrawer() { $("drawer").classList.add("active"); $("drawerOverlay").classList.add("active"); }
function closeDrawer() { $("drawer").classList.remove("active"); $("drawerOverlay").classList.remove("active"); }
async function logout() { try { await fetch("/logout", { method: "POST" }); } catch (e) {} localStorage.removeItem("userEmail"); window.location.href = "/"; }
(async () => {
  try {
    const me = await (await fetch("/me")).json();
    if (!me.loggedIn) { window.location.href = "/login.html?next=/studio.html"; return; }
    $("drawerName").textContent = me.email.split("@")[0]; $("drawerEmail").textContent = me.email; $("drawerAvatar").textContent = me.email[0].toUpperCase();
    const p = await (await fetch("/user-plan")).json();
    if (p.success) { const n = p.plan[0].toUpperCase() + p.plan.slice(1); $("drawerPlan").textContent = n; $("navPlanBadge").textContent = n; }
  } catch (e) {}
})();

/* ── tabs ── */
function showTab(name) {
  document.querySelectorAll(".studio-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".studio-pane").forEach(p => p.classList.toggle("active", p.id === "pane-" + name));
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}
$("studioTabs").addEventListener("click", (e) => { const b = e.target.closest(".studio-tab"); if (b) showTab(b.dataset.tab); });

/* ── Brand kit ── */
async function loadBrand() {
  const d = await api("/brand-kit"); const k = d.kit || {}; const tk = d.teamKit;
  let html = "";
  if (tk && !d.allowed) html += `<div class="lock-card"><b>Using ${esc(tk.teamName)}'s brand kit</b>Your clips automatically get your team's logo and colours.</div>`;
  if (!d.allowed) { $("brandBody").innerHTML = html + lock(d.planRequired, "Brand kit"); return; }
  html += `<div class="kv"><label>Brand name</label><input class="field-input" id="bkName" maxlength="60" value="${esc(k.brandName)}">
    <label>Handle</label><input class="field-input" id="bkHandle" maxlength="40" placeholder="@yourbrand" value="${esc(k.handle)}">
    <label>Primary colour</label><input class="swatch-in" type="color" id="bkPrimary" value="${esc(k.primaryColor || "#8b5cf6")}">
    <label>Accent colour</label><input class="swatch-in" type="color" id="bkAccent" value="${esc(k.accentColor || "#ec4899")}">
    <label>Font</label><input class="field-input" id="bkFont" maxlength="40" placeholder="e.g. Poppins" value="${esc(k.fontName)}">
    <label>Outro text</label><input class="field-input" id="bkOutro" maxlength="80" placeholder="Follow for more" value="${esc(k.outroText)}">
    <label>Logo</label><div style="display:flex;gap:14px;align-items:center"><div class="logo-prev" id="bkPrev">${k.logoUrl ? `<img alt="logo" src="${esc(k.logoUrl)}">` : "No logo"}</div>
      <div><input type="file" id="bkFile" accept="image/png,image/jpeg,image/webp" hidden><button class="opt-btn" id="bkPick">Upload logo</button> <button class="opt-btn" id="bkDel" ${k.logoUrl ? "" : "style='display:none'"}>Remove</button><div class="ai-note">PNG, JPG or WebP · max 2 MB</div></div></div>
    <label>Logo position</label><select id="bkPos" class="field-input">${["top-left", "top-right", "bottom-left", "bottom-right"].map(p => `<option ${k.logoPosition === p || (!k.logoPosition && p === "top-right") ? "selected" : ""}>${p}</option>`).join("")}</select>
    <label>Show logo</label><label class="rs-check"><input type="checkbox" id="bkOn" ${k.logoEnabled === false ? "" : "checked"}> Add my logo to new clips</label></div>
    <button class="btn" id="bkSave" style="margin-top:12px">Save brand kit</button><div class="status-msg" id="bkMsg"></div>
    <div class="ai-note">Your brand kit is also applied to every active member of your team. Logo overlay on new clips needs the render-service update in docs/EC2-UPGRADE.md.</div>`;
  $("brandBody").innerHTML = html;
  $("bkPick").onclick = () => $("bkFile").click();
  $("bkFile").onchange = async () => {
    const f = $("bkFile").files[0]; if (!f) return; const fd = new FormData(); fd.append("logo", f);
    const r = await (await fetch("/brand-kit/logo", { method: "POST", body: fd })).json();
    if (!r.success) return toast(r.error || "Upload failed");
    $("bkPrev").innerHTML = `<img alt="logo" src="${esc(r.logoUrl)}">`; $("bkDel").style.display = "inline-block"; toast("Logo uploaded");
  };
  $("bkDel").onclick = async () => { await api("/brand-kit/logo", "DELETE"); $("bkPrev").textContent = "No logo"; $("bkDel").style.display = "none"; };
  $("bkSave").onclick = async () => {
    const r = await api("/brand-kit", "PUT", { brandName: $("bkName").value, handle: $("bkHandle").value, primaryColor: $("bkPrimary").value, accentColor: $("bkAccent").value, fontName: $("bkFont").value, outroText: $("bkOutro").value, logoPosition: $("bkPos").value, logoEnabled: $("bkOn").checked });
    $("bkMsg").className = "status-msg " + (r.success ? "ok" : "err"); $("bkMsg").textContent = r.success ? "Saved ✓" : r.error;
  };
}

/* ── Team ── */
async function loadTeam() {
  const d = await api("/team"); let h = "";
  d.invites.forEach(i => { h += `<div class="lock-card"><b>Invitation: ${esc(i.name)}</b>${esc(i.ownerEmail)} invited you. <button class="opt-btn" data-accept="${esc(i.teamId)}">Accept</button> <button class="opt-btn" data-decline="${esc(i.teamId)}">Decline</button></div>`; });
  if (!d.team) {
    h += d.canCreate ? `<b>Create your team</b><div class="ai-note">Invite up to ${d.seats} members. They share your brand kit.</div><div class="row2" style="margin-top:12px"><input class="field-input" id="tmName" maxlength="60" placeholder="Team name"><button class="otp-send-btn" id="tmCreate">Create</button></div>` : lock(d.planRequired, "Team workspace");
  } else if (d.role === "owner") {
    h += `<div class="tc-head"><div class="tc-title">${esc(d.team.name)}</div><span class="m">${d.team.members.length}/${d.seats} seats</span></div>`;
    h += d.team.members.map(m => `<div class="list-row"><div>${esc(m.email)}<small>${esc(m.status)}</small></div><button class="opt-btn" data-remove="${esc(m.email)}">Remove</button></div>`).join("") || `<div class="tc-empty">No members yet.</div>`;
    h += `<div class="row2" style="margin-top:14px"><input class="field-input" id="tmEmail" type="email" placeholder="teammate@email.com"><button class="otp-send-btn" id="tmInvite">Invite</button></div><div class="status-msg" id="tmMsg"></div>
      <button class="opt-btn" id="tmClips">Last 24h team activity</button><div id="tmClipList"></div><div style="margin-top:18px"><button class="opt-btn" id="tmDisband">Delete team</button></div>`;
  } else {
    h += `<b>${esc(d.team.name)}</b><div class="ai-note">Owner: ${esc(d.team.ownerEmail)} · You use the team's brand kit on your clips.</div><button class="opt-btn" id="tmLeave" style="margin-top:12px">Leave team</button>`;
  }
  $("teamBody").innerHTML = h || "Nothing here yet.";
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on("tmCreate", async () => { const r = await api("/team", "POST", { name: $("tmName").value }); r.success ? loadTeam() : toast(r.error); });
  on("tmInvite", async () => { const r = await api("/team/invite", "POST", { email: $("tmEmail").value }); if (r.success) loadTeam(); else { $("tmMsg").className = "status-msg err"; $("tmMsg").textContent = r.error; } });
  on("tmLeave", async () => { await api("/team/leave", "POST"); loadTeam(); });
  on("tmDisband", async () => { if (confirm("Delete this team?")) { await api("/team", "DELETE"); loadTeam(); } });
  on("tmClips", async () => {
    const r = await api("/team/clips"); const el = $("tmClipList");
    el.innerHTML = !r.success || !r.jobs.length ? `<div class="tc-empty">No team activity in the last 24 hours.</div>` : r.jobs.map(j => `<div class="list-row"><div>${esc(j.title)}<small>${esc(j.member)} · ${esc(fmt(j.createdAt))}</small></div><span class="pill">${esc(j.clips)} clips · top ${esc(j.topScore)}</span></div>`).join("");
  });
  document.querySelectorAll("[data-remove]").forEach(b => b.onclick = async () => { await api("/team/members/" + encodeURIComponent(b.dataset.remove), "DELETE"); loadTeam(); });
  document.querySelectorAll("[data-accept]").forEach(b => b.onclick = async () => { const r = await api("/team/accept", "POST", { teamId: b.dataset.accept }); r.success ? loadTeam() : toast(r.error); });
  document.querySelectorAll("[data-decline]").forEach(b => b.onclick = async () => { await api("/team/decline", "POST", { teamId: b.dataset.decline }); loadTeam(); });
}

/* ── Schedule ── */
async function loadSchedule() {
  const d = await api("/schedule");
  if (!d.allowed) { $("scheduleBody").innerHTML = lock(d.planRequired, "Post scheduler"); return; }
  $("scheduleBody").innerHTML = `<div class="tc-title">Scheduled posts</div><div class="ai-note">Schedule from any clip on the Clips page. At the scheduled time we email you the caption and a download link.</div>` +
    (d.posts.length ? d.posts.map(p => `<div class="list-row"><div>${esc(p.clipTitle)}<small>${esc(p.platformLabel)} · ${esc(fmt(p.scheduledAt))} · ${esc(p.status)}${p.error ? " — " + esc(p.error) : ""}</small></div>${p.status === "scheduled" ? `<button class="opt-btn" data-cancel="${esc(p.id)}">Cancel</button>` : ""}</div>`).join("") : `<div class="tc-empty">Nothing scheduled yet.</div>`);
  document.querySelectorAll("[data-cancel]").forEach(b => b.onclick = async () => { await api("/schedule/" + b.dataset.cancel, "DELETE"); loadSchedule(); });
}

/* ── API keys + webhooks ── */
async function loadApi() {
  const [k, w] = await Promise.all([api("/developer/keys"), api("/developer/webhook")]);
  if (!k.allowed) { $("apiBody").innerHTML = lock(k.planRequired, "API access and webhooks"); $("hookBody").style.display = "none"; return; }
  $("hookBody").style.display = "block";
  $("apiBody").innerHTML = `<div class="tc-head"><div class="tc-title">API keys</div><button class="opt-btn" id="keyNew">Create key</button></div><div id="keySecret"></div>` +
    (k.keys.length ? k.keys.map(x => `<div class="list-row"><div>${esc(x.name)} <span class="mono">${esc(x.prefix)}…</span><small>Created ${esc(fmt(x.createdAt))} · last used ${esc(fmt(x.lastUsedAt))}</small></div><button class="opt-btn" data-revoke="${esc(x.id)}">Revoke</button></div>`).join("") : `<div class="tc-empty">No keys yet.</div>`);
  $("keyNew").onclick = async () => {
    const r = await api("/developer/keys", "POST", { name: prompt("Name this key", "My key") || "My key" });
    if (!r.success) return toast(r.error);
    await loadApi(); $("keySecret").innerHTML = `<div class="secret-box">Copy your key now — it won't be shown again:<br><b>${esc(r.key)}</b></div>`;
  };
  document.querySelectorAll("[data-revoke]").forEach(b => b.onclick = async () => { if (confirm("Revoke this key?")) { await api("/developer/keys/" + b.dataset.revoke, "DELETE"); loadApi(); } });

  const h = w.webhook;
  $("hookBody").innerHTML = `<div class="tc-title">Webhook</div><div class="ai-note">We POST signed JSON when a clip or transcript finishes. Verify with HMAC-SHA256 of <span class="mono">timestamp.body</span> using your secret.</div>
    <div id="hookSecret"></div>
    <div class="row2" style="margin-top:12px"><input class="field-input" id="hkUrl" placeholder="https://your-server.com/webhook" value="${esc(h?.url || "")}"><button class="otp-send-btn" id="hkSave">${h ? "Update" : "Save"}</button></div>
    <div class="opt-value">${w.events.map(e => `<label class="rs-check"><input type="checkbox" class="hkEv" value="${esc(e)}" ${!h || h.events.includes(e) ? "checked" : ""}> ${esc(e)}</label>`).join("")}</div>
    ${h ? `<div class="ai-note">Secret ${esc(h.secretPreview)} · last delivery ${esc(fmt(h.lastDeliveryAt))} (status ${esc(h.lastStatus ?? "—")}) · ${h.active ? "active" : "disabled after repeated failures"}</div>
    <div style="margin-top:10px;display:flex;gap:8px"><button class="opt-btn" id="hkTest">Send test</button><button class="opt-btn" id="hkRotate">Rotate secret</button><button class="opt-btn" id="hkDel">Delete</button></div>` : ""}
    <div class="status-msg" id="hkMsg"></div>`;
  $("hkSave").onclick = async () => {
    const r = await api("/developer/webhook", "PUT", { url: $("hkUrl").value, events: [...document.querySelectorAll(".hkEv:checked")].map(x => x.value) });
    if (!r.success) { $("hkMsg").className = "status-msg err"; $("hkMsg").textContent = r.error; return; }
    await loadApi(); if (r.secret) $("hookSecret").innerHTML = `<div class="secret-box">Signing secret (shown once): <b>${esc(r.secret)}</b></div>`;
  };
  if (h) {
    $("hkTest").onclick = async () => { const r = await api("/developer/webhook/test", "POST"); toast(r.delivered ? "Delivered ✓" : "Delivery failed — check your endpoint"); loadApi(); };
    $("hkRotate").onclick = async () => { const r = await api("/developer/webhook/rotate-secret", "POST"); if (r.success) $("hookSecret").innerHTML = `<div class="secret-box">New secret (shown once): <b>${esc(r.secret)}</b></div>`; };
    $("hkDel").onclick = async () => { if (confirm("Delete webhook?")) { await api("/developer/webhook", "DELETE"); loadApi(); } };
  }
}

loadBrand(); loadTeam(); loadSchedule(); loadApi();
if (location.hash) showTab(location.hash.slice(1));
