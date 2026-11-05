/* =====================================================================
 * dashboard.js — full-page UI controller.
 * Workspace (nested folders + file speed dial), Template Studio with the
 * colored click-to-map Excel preview, Queue (Workspace / Speedrun modes),
 * Stats and Settings. All state lives in chrome.storage.local.
 * ===================================================================== */
let S = null;
let currentFolder = null;     // null = workspace root
let pushMode = "workspace";
let ctxTarget = null;
let speedrunTemplateId = "";
let workspaceFileId = "";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (ts) => new Date(ts).toLocaleString();
const send = (m) => new Promise(r => chrome.runtime.sendMessage(m, (res) => {
  // Surface "background not responding" instead of a silent undefined.
  if (chrome.runtime.lastError) r({ ok: false, error: "Extension background did not respond: " + chrome.runtime.lastError.message });
  else r(res);
}));
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2800);
}

/* ---------- Boot ---------- */
(async function init() {
  S = await loadState();
  await upgradeQueuedGender();
  document.documentElement.dataset.theme = S.settings.theme;
  syncSettingsUI();
  renderAll();
  chrome.storage.onChanged.addListener(async (ch) => {
    if (!Object.keys(ch).some(k => ["queue", "logs", "stats", "files", "folders", "templates", "accounts"].includes(k))) return;
    S = await loadState();
    if ($("#modal").hidden) renderAll(); else { renderQueue(); renderLogs(); }
  });
})();
async function upgradeQueuedGender() {
  let changed = false;
  for (const q of S.queue) {
    if (q.category !== "Character Names") {
      if (q.gender) { q.gender = ""; changed = true; }
      continue;
    }
    if (q.gender || !q.raw) continue;
    let parsed = parseGlossaryText(q.raw).valid[0];
    if (!parsed) parsed = parseGlossaryText(`${q.category}: ${q.raw}`).valid[0];
    if (parsed?.gender) {
      q.target = parsed.target; q.notes = parsed.notes; q.gender = parsed.gender; changed = true;
    }
  }
  if (changed) await saveState({ queue: S.queue });
}
function renderAll() { renderWorkspace(); renderTemplates(); renderQueue(); renderLogs(); renderStats(); renderAccountPickers(); }

/* ---------- Navigation ---------- */
$$(".nav").forEach(b => b.onclick = () => {
  $$(".nav").forEach(x => x.classList.remove("active")); b.classList.add("active");
  $$(".view").forEach(v => v.classList.remove("active"));
  $(`#view-${b.dataset.view}`).classList.add("active");
  if (b.dataset.view === "stats") renderStats();
});
$("#themeToggle").onclick = async () => {
  S.settings.theme = S.settings.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = S.settings.theme;
  await saveState({ settings: S.settings }); renderStats();
};

/* =====================================================================
 * WORKSPACE — nested folders + file tiles with custom links
 * ===================================================================== */
function folderPath(id) {
  const out = []; let cur = S.folders.find(f => f.id === id);
  while (cur) { out.unshift(cur); cur = S.folders.find(f => f.id === cur.parentId); }
  return out;
}
function renderWorkspace() {
  const cr = $("#crumbs"); cr.innerHTML = "";
  const root = document.createElement("button"); root.textContent = "Workspace";
  wireFolderDrop(root, null);
  root.onclick = () => { currentFolder = null; renderWorkspace(); }; cr.appendChild(root);
  for (const f of folderPath(currentFolder)) {
    cr.insertAdjacentHTML("beforeend", "<span>›</span>");
    const b = document.createElement("button"); b.textContent = f.name;
    wireFolderDrop(b, f.id);
    b.onclick = () => { currentFolder = f.id; renderWorkspace(); }; cr.appendChild(b);
  }

  const grid = $("#grid"); grid.innerHTML = "";
  const folders = S.folders.filter(f => (f.parentId || null) === currentFolder);
  const files = S.files.filter(f => (f.folderId || null) === currentFolder);

  for (const f of folders) {
    const kids = S.folders.filter(x => x.parentId === f.id).length + S.files.filter(x => x.folderId === f.id).length;
    grid.appendChild(tile({
      logo: f.logoBase64, name: f.name, meta: "Folder", badge: `${kids} item${kids === 1 ? "" : "s"}`,
      onOpen: () => { currentFolder = f.id; renderWorkspace(); },
      onCtx: (x, y) => showCtx(x, y, [
        ["Open", () => { currentFolder = f.id; renderWorkspace(); }],
        ["Move", () => moveItem("folder", f.id)],
        ["Rename / logo", () => folderEditor(f.id)],
        ["Export to ZIP", () => exportZip({ folderId: f.id })],
        ["Delete", () => removeFolder(f.id), true]
      ])
    }));
    wireTileMove(grid.lastElementChild, "folder", f.id);
  }
  for (const f of files) {
    const tpl = S.templates.find(t => t.id === f.templateId);
    grid.appendChild(tile({
      logo: f.logoBase64, name: f.name,
      meta: tpl ? `Template: ${tpl.name}` : "No template",
      badge: f.boundAccountEmail ? f.boundAccountEmail.split("@")[0] : "no account",
      links: f.customLinks || [],
      onOpen: () => fileEditor(f.id),
      onCtx: (x, y) => showCtx(x, y, [
        ["Open sheet in browser", () => send({ type: "OPEN_URL", url: f.targetLiveUrl, email: f.boundAccountEmail })],
        ["Edit file", () => fileEditor(f.id)],
        ["Move", () => moveItem("file", f.id)],
        ["Export to ZIP", () => exportZip({ fileId: f.id })],
        ["Delete", () => removeFile(f.id), true]
      ])
    }));
    wireTileMove(grid.lastElementChild, "file", f.id);
  }
  if (!folders.length && !files.length) grid.insertAdjacentHTML("beforeend", `<div class="empty">Nothing here yet — create a folder or a file.</div>`);
  grid.ondragover = e => { if (e.dataTransfer.types.includes("text/glossary-item")) e.preventDefault(); };
  grid.ondrop = e => {
    e.preventDefault();
    try { const d = JSON.parse(e.dataTransfer.getData("text/glossary-item")); if (d.source !== currentFolder) setItemFolder(d.kind, d.id, currentFolder); } catch {}
  };
}
function tile({ logo, name, meta, badge, links = [], onOpen, onCtx }) {
  const el = document.createElement("div");
  el.className = "tile glass";
  el.innerHTML = `
    <div class="tile-top">${badge ? `<span class="badge">${esc(badge)}</span>` : ""}</div>
    <div class="logo">${logo ? `<img src="${logo}" alt="">` : esc((name || "?").slice(0, 1).toUpperCase())}</div>
    <div class="tile-copy">
      <div class="name" title="${esc(name)}">${esc(name)}</div>
      <div class="meta" title="${esc(meta)}">${esc(meta)}</div>
      ${links.length ? `<div class="links">${links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.title || "link")}</a>`).join("")}</div>` : ""}
    </div>`;
  el.onclick = (e) => { if (e.target.tagName !== "A") onOpen(); };
  el.oncontextmenu = (e) => { e.preventDefault(); onCtx(e.clientX, e.clientY); };
  return el;
}
function wireTileMove(el, kind, id) {
  el.draggable = true;
  el.ondragstart = e => e.dataTransfer.setData("text/glossary-item", JSON.stringify({ kind, id, source: currentFolder }));
  if (kind !== "folder") return;
  wireFolderDrop(el, id);
}
function wireFolderDrop(el, folderId) {
  el.ondragover = e => { if (e.dataTransfer.types.includes("text/glossary-item")) { e.preventDefault(); el.classList.add("drop-target"); } };
  el.ondragleave = () => el.classList.remove("drop-target");
  el.ondrop = e => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove("drop-target");
    try { const d = JSON.parse(e.dataTransfer.getData("text/glossary-item")); if (d.kind !== "folder" || d.id !== folderId) setItemFolder(d.kind, d.id, folderId); } catch {}
  };
}
function moveItem(kind, id) {
  const choices = [{ id: null, name: "Workspace (root)" }, ...S.folders.filter(x => !(kind === "folder" && (x.id === id || folderPath(x.id).some(p => p.id === id))))];
  const menu = choices.map((x, i) => `${i + 1}. ${x.id == null ? x.name : folderPath(x.id).map(p => p.name).join(" / ")}`).join("\n");
  const answer = prompt(`Move to folder (enter number):\n${menu}`);
  if (answer == null) return;
  const chosen = choices[parseInt(answer, 10) - 1];
  if (chosen) setItemFolder(kind, id, chosen.id);
}
async function setItemFolder(kind, id, folderId) {
  if (kind === "folder" && folderId && (folderId === id || folderPath(folderId).some(p => p.id === id))) return toast("A folder cannot be moved inside itself");
  if (kind === "folder") S.folders.find(x => x.id === id).parentId = folderId;
  else S.files.find(x => x.id === id).folderId = folderId;
  await saveState({ folders: S.folders, files: S.files }); renderAll(); toast("Item moved");
}
$("#newFolderBtn").onclick = () => folderEditor(null);
$("#newFileBtn").onclick = () => fileEditor(null);

function showCtx(x, y, items) {
  const m = $("#ctxMenu");
  m.innerHTML = "";
  for (const [label, fn, danger] of items) {
    const b = document.createElement("button");
    b.textContent = label; if (danger) b.className = "danger";
    b.onclick = fn; m.appendChild(b);
  }
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - 215) + "px";
  m.style.top = Math.min(y, innerHeight - items.length * 40 - 20) + "px";
}
document.addEventListener("click", () => { $("#ctxMenu").hidden = true; });

async function removeFolder(id) {
  if (!confirm("Delete this folder and everything inside it?")) return;
  const doomed = new Set([id]);
  let grew = true;
  while (grew) { grew = false; for (const f of S.folders) if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) { doomed.add(f.id); grew = true; } }
  S.folders = S.folders.filter(f => !doomed.has(f.id));
  S.files = S.files.filter(f => !doomed.has(f.folderId));
  await saveState({ folders: S.folders, files: S.files });
  currentFolder = null; renderAll(); toast("Folder deleted");
}
async function removeFile(id) {
  if (!confirm("Delete this file?")) return;
  S.files = S.files.filter(f => f.id !== id);
  delete S.snapshots[id];
  await saveState({ files: S.files, snapshots: S.snapshots });
  renderAll(); toast("File deleted");
}

/* ---------- Modal plumbing ---------- */
function openModal(title, body, mount, actions = "") {
  $("#modalCard").innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><div class="spacer"></div>${actions}<button class="btn" id="mClose">Close</button></div><div class="modal-body">${body}</div>`;
  $("#modal").hidden = false;
  $("#mClose").onclick = closeModal;
  mount?.();
}
function closeModal() { $("#modal").hidden = true; $("#modalCard").innerHTML = ""; renderAll(); }
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });

/* ---------- Logo picker helper ---------- */
function logoField(id, current) {
  return `<div class="field"><label>Logo (stored locally, Base64)</label>
    <div class="logo-pick"><div class="prev" id="${id}Prev">${current ? `<img src="${current}">` : "—"}</div>
      <input type="file" id="${id}File" accept="image/*"><button class="btn ghost" id="${id}Clear">Remove</button></div></div>`;
}
/* A 4 MB photo would be carried in every state read and every .zip export,
   so fit it into 512px first. SVGs pass through untouched. */
async function shrinkImage(file, max = 512) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
  });
  if (file.type === "image/svg+xml") return dataUrl;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && dataUrl.length < 200e3) return dataUrl;
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    const out = cv.toDataURL("image/webp", 0.92);   // keeps transparency
    return out.length < dataUrl.length ? out : dataUrl;
  } catch { return dataUrl; }
}
function wireLogo(id, initial, onChange) {
  let v = initial;
  $(`#${id}File`).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    v = await shrinkImage(f);
    $(`#${id}Prev`).innerHTML = `<img src="${v}">`;
    onChange(v);
  };
  $(`#${id}Clear`).onclick = () => { v = null; $(`#${id}Prev`).textContent = "—"; onChange(null); };
}

/* ---------- Folder editor ---------- */
function folderEditor(id) {
  const f = S.folders.find(x => x.id === id) || { id: null, parentId: currentFolder, name: "", logoBase64: null };
  openModal(id ? "Edit folder" : "New folder", `<div style="max-width:560px">
      <div class="field"><label>Folder name</label><input type="text" id="fName" value="${esc(f.name)}" placeholder="e.g. Volume 3"></div>
      ${logoField("fl", f.logoBase64)}
      <button class="btn primary" id="fSave">Save folder</button></div>`, () => {
    let logo = f.logoBase64;
    wireLogo("fl", logo, v => logo = v);
    $("#fSave").onclick = async () => {
      const name = $("#fName").value.trim(); if (!name) return toast("Name required");
      if (f.id) Object.assign(S.folders.find(x => x.id === f.id), { name, logoBase64: logo });
      else S.folders.push({ id: uid(), parentId: f.parentId || null, name, logoBase64: logo });
      await saveState({ folders: S.folders }); closeModal(); toast("Folder saved");
    };
  });
}

/* =====================================================================
 * TEMPLATE STUDIO (Module 2)
 * ===================================================================== */
function renderTemplates() {
  const g = $("#templateGrid"); g.innerHTML = "";
  for (const t of S.templates) {
    const mapped = Object.keys(t.mappings || {}).length;
    g.appendChild(tile({
      logo: t.logoBase64, name: t.name, meta: `${mapped}/12 categories mapped`,
      badge: S.snapshots[t.id] ? "preview saved" : "no preview",
      onOpen: () => templateEditor(t.id),
      onCtx: (x, y) => showCtx(x, y, [
        ["Edit", () => templateEditor(t.id)],
        ["Export to ZIP", () => exportZip({ templateId: t.id })],
        ["Duplicate", async () => { S.templates.push({ ...structuredClone(t), id: uid(), name: t.name + " copy" }); await saveState({ templates: S.templates }); renderTemplates(); }],
        ["Delete", async () => { if (!confirm("Delete template?")) return; S.templates = S.templates.filter(x => x.id !== t.id); await saveState({ templates: S.templates }); renderTemplates(); }, true]
      ])
    }));
  }
  const add = document.createElement("div");
  add.className = "tile add glass";
  add.innerHTML = `<div class="plus">+</div><div class="name">New template</div>`;
  add.onclick = () => templateEditor(null);
  g.appendChild(add);
}
$("#newTemplateBtn").onclick = () => templateEditor(null);

/* The 12-category mapping grid; `base` shows inherited values as placeholders. */
function mappingGridHtml(mappings, base = null) {
  const head = `<div class="map-head"><span>Category</span>${MAP_FIELDS.map(f => `<span>${f.label}</span>`).join("")}</div>`;
  const rows = CATEGORIES.map(c => {
    const m = mappings?.[c] || {}, b = base?.[c] || {};
    return `<div class="map-row"><label title="${esc(c)}">${esc(c)}</label>` + MAP_FIELDS.map(f => {
      const val = m[f.key] ?? "";
      const ph = b[f.key] != null && b[f.key] !== "" ? String(b[f.key]) : (f.optional ? "—" : "");
      if (f.kind === "sheet") {
        const inheritedSheet = !val && b.sheetName ? b.sheetName : "";
        const emptyLabel = inheritedSheet ? `Template: ${inheritedSheet}` : "Choose sheet…";
        const initialOption = val
          ? `<option value="${esc(val)}">${esc(val)}</option>`
          : `<option value="">${esc(emptyLabel)}</option>`;
        return `<select data-cat="${esc(c)}" data-k="${f.key}" data-sheet-map data-map-value="${esc(val)}" data-map-inherited="${esc(inheritedSheet)}">${initialOption}</select>`;
      }
      const genderDisabled = f.key === "genderCol" && c !== "Character Names";
      return `<input type="${f.kind === "row" ? "number" : "text"}" data-cat="${esc(c)}" data-k="${f.key}"
        value="${esc(val)}" placeholder="${esc(ph)}" ${genderDisabled ? "disabled" : ""} ${f.kind === "col" ? 'maxlength="3"' : 'min="1"'}>`;
    }).join("") + `</div>`;
  }).join("");
  return head + rows;
}
function collectMappings(root = document) {
  const out = {};
  $$("[data-cat]", root).forEach(i => {
    if (i.dataset.k === "genderCol" && i.dataset.cat !== "Character Names") return;
    const v = i.value.trim(); if (!v) return;
    (out[i.dataset.cat] ||= {})[i.dataset.k] = i.dataset.k.endsWith("Col") ? v.toUpperCase() : (i.dataset.k === "sheetName" ? v : parseInt(v, 10));
  });
  return out;
}

function templateEditor(id) {
  const t = S.templates.find(x => x.id === id) || { id: null, name: "", logoBase64: null, targetPreviewUrl: "", mappings: {} };
  const snapKey = t.id || "draft";
  openModal(id ? `Template — ${t.name}` : "New template", `
    <div class="modal-cols">
      <div>
        <div class="field"><label>Template name</label><input type="text" id="tName" value="${esc(t.name)}" placeholder="Standard glossary layout"></div>
        ${logoField("tl", t.logoBase64)}
        <div class="field"><label>Sample Google Sheet URL</label><input type="url" id="tUrl" value="${esc(t.targetPreviewUrl)}" placeholder="https://docs.google.com/spreadsheets/d/..."></div>
        <div class="field"><label>Google account to fetch with</label><select id="tAcct"></select></div>
        <div class="row" style="margin-bottom:16px"><button class="btn" id="tFetch">Fetch preview</button><span class="muted" id="tInfo"></span></div>
        <label class="muted" style="font-size:13px">Mappings — click an input, then click a cell in the preview to fill it.</label>
        <div class="mapping-help">Template tab names are matched by name in the target glossary, so spreadsheet copies with different internal IDs work too.</div>
        <div id="tMap" style="margin-top:8px">${mappingGridHtml(t.mappings)}</div>
        <button class="btn primary" id="tSave" style="margin-top:16px">Save template</button>
      </div>
      <div>
        <div class="arm" id="tArm">No input armed — click a column or row box on the left, then click a cell.</div>
        <div class="sheet-tabs" id="tSheets"></div>
        <div class="xl-wrap" id="tPrev"><div class="empty">Fetch the sample sheet to see it here, with its original cell colours.</div></div>
      </div>
    </div>`, () => {
    let logo = t.logoBase64;
    wireLogo("tl", logo, v => logo = v);
    fillAccountSelect($("#tAcct"));
    armMappingInputs();
    const snap = S.snapshots[snapKey];
    if (snap) { $("#tInfo").textContent = `Saved preview · ${fmt(snap.fetchedAt)}`; renderXlsx(snap, $("#tPrev"), $("#tSheets"), () => collectMappings($("#tMap"))); }

    $("#tFetch").onclick = async (e) => {
      const url = $("#tUrl").value.trim(); if (!url) return toast("Add the sample sheet URL first");
      e.target.disabled = true; e.target.textContent = "Fetching…";
      const r = await send({ type: "FETCH_SNAPSHOT", url, email: $("#tAcct").value });
      e.target.disabled = false; e.target.textContent = "Fetch preview";
      if (!r?.ok) { $("#tInfo").textContent = r?.error || "Fetch failed"; $("#tInfo").style.color = "var(--danger)"; return toast("Download failed — see the message next to the button"); }
      $("#tInfo").style.color = "";
      S.snapshots[snapKey] = r.snapshot;
      $("#tInfo").textContent = `${(r.snapshot.size / 1024).toFixed(0)} KB · just now`;
      renderXlsx(r.snapshot, $("#tPrev"), $("#tSheets"), () => collectMappings($("#tMap")));
    };
    $("#tSave").onclick = async () => {
      const name = $("#tName").value.trim(); if (!name) return toast("Name required");
      const data = { name, logoBase64: logo, targetPreviewUrl: $("#tUrl").value.trim(), mappings: collectMappings($("#tMap")) };
      let tid = t.id;
      if (tid) Object.assign(S.templates.find(x => x.id === tid), data);
      else { tid = uid(); S.templates.push({ id: tid, ...data }); }
      if (S.snapshots.draft) { S.snapshots[tid] = S.snapshots.draft; delete S.snapshots.draft; }
      await saveState({ templates: S.templates, snapshots: S.snapshots });
      closeModal(); toast("Template saved");
    };
  });
}

/* ---------- Click-to-map arming (Module 2.5) ---------- */
let armedInput = null;
function armMappingInputs() {
  $$("[data-cat]").filter(i => i.dataset.k !== "sheetName").forEach(i => i.onfocus = () => {
    $$("[data-cat]").forEach(x => x.classList.remove("armed"));
    i.classList.add("armed"); armedInput = i;
    const f = MAP_FIELDS.find(f => f.key === i.dataset.k);
    const arm = $("#tArm") || $("#xArm");
    if (arm) arm.textContent = `Armed: ${i.dataset.cat} → ${f.label}. Click a cell in the preview.`;
  });
}
function applyCellPick(col, row) {
  if (!armedInput) return toast("Click a mapping box first");
  armedInput.value = armedInput.dataset.k.endsWith("Col") ? col : row;
  armedInput.dispatchEvent(new Event("input", { bubbles: true }));
  highlightMapped();
  toast(`${armedInput.dataset.cat} → ${armedInput.dataset.k} = ${armedInput.value}`);
}

/* =====================================================================
 * COLORED EXCEL PREVIEW (Module 2.2)
 * SheetJS keeps fill colours on cell.s.fgColor when read with cellStyles.
 * ===================================================================== */
let previewCtx = null; // { wb, sheetName, host, getMappings }
function renderXlsx(snapshot, host, tabsEl, getMappings) {
  const wb = XLSX.read(b64ToBuf(snapshot.b64), { type: "array", cellStyles: true });
  tabsEl.innerHTML = "";
  wb.SheetNames.forEach((n, i) => {
    const b = document.createElement("button"); b.className = "btn" + (i === 0 ? " on" : ""); b.textContent = n;
    b.onclick = () => { $$("button", tabsEl).forEach(x => x.classList.remove("on")); b.classList.add("on"); drawSheet(n); };
    tabsEl.appendChild(b);
  });
  previewCtx = { wb, host, getMappings, sheetName: wb.SheetNames[0] };
  $$('[data-sheet-map]').forEach(sel => {
    const current = sel.value || sel.dataset.mapValue;
    const inherited = sel.dataset.mapInherited || "";
    const keepInherited = !current && !!inherited;
    const emptyLabel = inherited ? `Template: ${inherited}` : "Choose sheet…";
    sel.innerHTML = `<option value="">${esc(emptyLabel)}</option>` + wb.SheetNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    const selected = wb.SheetNames.includes(current) ? current : (keepInherited ? "" : wb.SheetNames[0] || "");
    sel.value = selected;
    sel.dataset.mapValue = selected;
    sel.title = selected || emptyLabel;
    sel.onchange = () => { sel.dataset.mapValue = sel.value; sel.title = sel.value; };
  });
  if (wb.SheetNames.length) drawSheet(wb.SheetNames[0]);
  else host.innerHTML = `<div class="empty">This workbook has no visible sheets.</div>`;

  function drawSheet(name) {
    if (!wb.Sheets[name]) return;
    previewCtx.sheetName = name;
    const sheet = wb.Sheets[name];
    const ref = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 30, c: 10 } };
    const rows = Math.max(1, Math.min(ref.e.r + 1, 1500));
    const cols = Math.max(1, Math.min(ref.e.c + 1, 160));
    const colWidth = c => {
      const dim = sheet["!cols"]?.[c];
      return Math.max(32, Math.min(600, dim?.wpx || (dim?.wch ? dim.wch * 7.2 + 5 : 96)));
    };
    const rowHeight = r => {
      const dim = sheet["!rows"]?.[r];
      return Math.max(18, Math.min(400, dim?.hpx || (dim?.hpt ? dim.hpt * 96 / 72 : 24)));
    };
    const mergeAt = new Map(), covered = new Set();
    for (const m of sheet["!merges"] || []) {
      if (m.s.r >= rows || m.s.c >= cols) continue;
      const range = { s: m.s, e: { r: Math.min(m.e.r, rows - 1), c: Math.min(m.e.c, cols - 1) } };
      mergeAt.set(`${m.s.r},${m.s.c}`, range);
      for (let r = m.s.r; r <= range.e.r; r++) for (let c = m.s.c; c <= range.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) covered.add(`${r},${c}`);
      }
    }
    let html = `<table><colgroup><col style="width:48px">`;
    for (let c = 0; c < cols; c++) html += `<col style="width:${colWidth(c)}px">`;
    html += `</colgroup><thead><tr><th class="rn"></th>`;
    for (let c = 0; c < cols; c++) html += `<th data-col="${indexToCol(c)}">${indexToCol(c)}</th>`;
    html += `</tr></thead><tbody>`;
    for (let r = 0; r < rows; r++) {
      html += `<tr style="height:${rowHeight(r)}px"><td class="rn" data-row="${r + 1}">${r + 1}</td>`;
      for (let c = 0; c < cols; c++) {
        if (covered.has(`${r},${c}`)) continue;
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        const merge = mergeAt.get(`${r},${c}`);
        const colspan = merge ? merge.e.c - merge.s.c + 1 : 1;
        const rowspan = merge ? merge.e.r - merge.s.r + 1 : 1;
        const style = cellStyle(cell);
        const value = esc(cell?.w ?? cell?.v ?? "");
        html += `<td class="pick" data-col="${indexToCol(c)}" data-row="${r + 1}"${colspan > 1 ? ` colspan="${colspan}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""}${value ? ` title="${value}"` : ""}${style}>${value}</td>`;
      }
      html += `</tr>`;
    }
    host.innerHTML = html + `</tbody></table>`;
    $$("td.pick, th[data-col], td.rn", host).forEach(td => td.onclick = () => applyCellPick(td.dataset.col || "", td.dataset.row || ""));
    highlightMapped();
  }
}
/* Translate a SheetJS style object into inline CSS so the HTML table mirrors Excel. */
function cellStyle(cell) {
  const s = cell?.s; if (!s) return "";
  const bits = [];
  const fg = s.fgColor?.rgb || s.bgColor?.rgb;
  if (fg && s.patternType !== "none") bits.push(`background:#${String(fg).slice(-6)}`);
  if (s.font?.color?.rgb) bits.push(`color:#${String(s.font.color.rgb).slice(-6)}`);
  if (s.font?.bold) bits.push("font-weight:700");
  if (s.font?.italic) bits.push("font-style:italic");
  if (s.alignment?.horizontal) {
    const align = s.alignment.horizontal === "centerContinuous" ? "center" : s.alignment.horizontal;
    if (["left", "center", "right", "justify"].includes(align)) bits.push(`text-align:${align}`);
  }
  if (["top", "center", "bottom"].includes(s.alignment?.vertical)) bits.push(`vertical-align:${s.alignment.vertical}`);
  return bits.length ? ` style="${bits.join(";")}"` : "";
}
/* Outline every cell that a mapping currently points at. */
function highlightMapped() {
  if (!previewCtx) return;
  const maps = previewCtx.getMappings?.() || {};
  const wanted = new Set();
  for (const m of Object.values(maps)) {
    if (m.sheetName ? m.sheetName !== previewCtx.sheetName : previewCtx.sheetName !== previewCtx.wb.SheetNames[0]) continue;
    for (const col of [m.sourceCol, m.targetCol, m.notesCol, m.genderCol]) {
      if (!col) continue;
      if (m.startRow) wanted.add(`${col}|${m.startRow}`);
      if (m.endRow) wanted.add(`${col}|${m.endRow}`);
    }
  }
  $$("td.pick", previewCtx.host).forEach(td => {
    td.classList.toggle("mapped", wanted.has(`${td.dataset.col}|${td.dataset.row}`));
  });
}

/* =====================================================================
 * FILE EDITOR (Module 3) — template pick, per-file overrides, custom links
 * ===================================================================== */
function fileEditor(id) {
  const f = S.files.find(x => x.id === id) || {
    id: null, folderId: currentFolder, name: "", logoBase64: null, targetLiveUrl: "",
    boundAccountEmail: "", customLinks: [], templateId: "", overriddenMappings: {}
  };
  openModal(id ? `File — ${f.name}` : "New file", `
    <div class="modal-cols">
      <div>
        <div class="field"><label>File name</label><input type="text" id="xName" value="${esc(f.name)}" placeholder="Chapter glossary"></div>
        <div class="field"><label>Live Google Sheet URL</label><input type="url" id="xUrl" value="${esc(f.targetLiveUrl)}" placeholder="https://docs.google.com/spreadsheets/d/..."></div>
        <div class="field"><label>Bound Google account</label><select id="xAcct"></select></div>
        <div class="field"><label>Template</label><select id="xTpl"></select></div>
        ${logoField("xl", f.logoBase64)}
        <div class="field"><label>Custom links (wiki, comic, raws…)</label><div id="xLinks"></div>
          <button class="btn ghost" id="xAddLink" style="align-self:flex-start">Add link</button></div>
        <label class="muted" style="font-size:13px">Overrides — blank means "use the template value" (shown greyed).</label>
        <div class="mapping-help">The selected template's tab names are matched to this file's spreadsheet. You can override a tab here if its name differs.</div>
        <div id="xMap" style="margin-top:8px"></div>
        <div class="row" style="margin-top:16px"><button class="btn primary" id="xSave">Save file</button>
          <button class="btn ghost" id="xOpen">Open sheet</button></div>
      </div>
      <div>
        <div class="arm" id="xArm">No input armed — click a mapping box, then a cell in the preview.</div>
        <div class="row" style="margin-bottom:10px"><button class="btn" id="xFetch">Fetch preview of this sheet</button><span class="muted" id="xInfo"></span></div>
        <div class="sheet-tabs" id="xSheets"></div>
        <div class="xl-wrap" id="xPrev"><div class="empty">Fetch this sheet to map against the real layout.</div></div>
      </div>
    </div>`, () => {
    let logo = f.logoBase64;
    let links = structuredClone(f.customLinks || []);
    wireLogo("xl", logo, v => logo = v);
    fillAccountSelect($("#xAcct"), f.boundAccountEmail);

    const tplSel = $("#xTpl");
    tplSel.innerHTML = `<option value="">No template</option>` + S.templates.map(t => `<option value="${t.id}" ${t.id === f.templateId ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    const drawMap = () => {
      const tpl = S.templates.find(t => t.id === tplSel.value);
      $("#xMap").innerHTML = mappingGridHtml(f.overriddenMappings, tpl?.mappings || {});
      $$("#xMap [data-cat]").forEach(i => i.classList.add("over"));
      armMappingInputs();
      $$("#xMap [data-cat]").forEach(i => i.oninput = highlightMapped);
    };
    tplSel.onchange = drawMap; drawMap();

    const drawLinks = () => {
      $("#xLinks").innerHTML = links.map((l, i) => `<div class="links-edit">
        <input type="text" data-li="${i}" data-lk="title" value="${esc(l.title)}" placeholder="Title">
        <input type="url" data-li="${i}" data-lk="url" value="${esc(l.url)}" placeholder="https://">
        <button class="btn danger" data-lrm="${i}">✕</button></div>`).join("");
      $$("[data-li]").forEach(i => i.oninput = () => links[+i.dataset.li][i.dataset.lk] = i.value);
      $$("[data-lrm]").forEach(b => b.onclick = () => { links.splice(+b.dataset.lrm, 1); drawLinks(); });
    };
    drawLinks();
    $("#xAddLink").onclick = () => { links.push({ title: "", url: "" }); drawLinks(); };

    const snapKey = f.id || "draftfile";
    const snap = S.snapshots[snapKey];
    const getM = () => effectiveMappings(S.templates.find(t => t.id === tplSel.value), collectMappings($("#xMap")));
    if (snap) renderXlsx(snap, $("#xPrev"), $("#xSheets"), getM);

    $("#xFetch").onclick = async (e) => {
      const url = $("#xUrl").value.trim(); if (!url) return toast("Add the sheet URL first");
      e.target.disabled = true; e.target.textContent = "Fetching…";
      const r = await send({ type: "FETCH_SNAPSHOT", url, email: $("#xAcct").value });
      e.target.disabled = false; e.target.textContent = "Fetch preview of this sheet";
      if (!r?.ok) { $("#xInfo").textContent = r?.error || "Fetch failed"; $("#xInfo").style.color = "var(--danger)"; return toast("Download failed — see the message next to the button"); }
      $("#xInfo").style.color = "";
      S.snapshots[snapKey] = r.snapshot;
      $("#xInfo").textContent = `${(r.snapshot.size / 1024).toFixed(0)} KB · just now`;
      renderXlsx(r.snapshot, $("#xPrev"), $("#xSheets"), getM);
    };
    $("#xOpen").onclick = () => send({ type: "OPEN_URL", url: $("#xUrl").value, email: $("#xAcct").value });
    $("#xSave").onclick = async () => {
      const name = $("#xName").value.trim(), url = $("#xUrl").value.trim();
      if (!name || !url) return toast("Name and sheet URL are required");
      const data = {
        name, targetLiveUrl: url, logoBase64: logo, boundAccountEmail: $("#xAcct").value,
        templateId: tplSel.value, overriddenMappings: collectMappings($("#xMap")),
        customLinks: links.filter(l => l.url.trim())
      };
      let fid = f.id;
      if (fid) Object.assign(S.files.find(x => x.id === fid), data);
      else { fid = uid(); S.files.push({ id: fid, folderId: f.folderId || null, ...data }); }
      if (S.snapshots.draftfile) { S.snapshots[fid] = S.snapshots.draftfile; delete S.snapshots.draftfile; }
      await saveState({ files: S.files, snapshots: S.snapshots });
      closeModal(); toast("File saved");
    };
  });
}

/* ---------- Account selects ---------- */
function fillAccountSelect(sel, chosen) {
  sel.innerHTML = S.accounts.length
    ? S.accounts.map(a => `<option value="${esc(a.email)}" ${a.email === chosen ? "selected" : ""}>u/${a.index} — ${esc(a.email)}</option>`).join("")
    : `<option value="">No accounts detected — run Detect in Settings</option>`;
}
function renderAccountPickers() {
  $("#acctHint").textContent = S.accounts.length ? `${S.accounts.length} Google account(s)` : "No account detected";
  fillAccountSelect($("#setAcct"));
  fillAccountSelect($("#srAcct"));
}

/* =====================================================================
 * QUEUE (Module 4)
 * ===================================================================== */
function renderQueue() {
  $("#queueCount").textContent = S.queue.length;
  $("#monitorToggle").checked = !!S.settings.monitor;
  $("#pushFile").innerHTML = `<option value="">${S.files.length ? "Choose a glossary file…" : "No files saved yet"}</option>` +
    S.files.map(f => `<option value="${f.id}">${esc(folderPath(f.folderId).map(x => x.name).join(" / ") || "Workspace")} / ${esc(f.name)}</option>`).join("");
  if (!S.files.some(f => f.id === workspaceFileId)) workspaceFileId = "";
  $("#pushFile").value = workspaceFileId;
  $("#pushFile").onchange = e => { workspaceFileId = e.target.value; };
  $("#srTemplate").innerHTML = S.templates.length
    ? S.templates.map(t => `<option value="${t.id}" ${t.id === speedrunTemplateId ? "selected" : ""}>${esc(t.name)}</option>`).join("")
    : `<option value="">No templates yet</option>`;
  if (!S.templates.some(t => t.id === speedrunTemplateId)) speedrunTemplateId = S.templates[0]?.id || "";
  $("#srTemplate").value = speedrunTemplateId;
  $("#srTemplate").onchange = e => { speedrunTemplateId = e.target.value; };

  const t = $("#queueTable");
  if (!S.queue.length) { t.innerHTML = `<tr><td class="empty">Queue is empty. Copy or paste glossary text.</td></tr>`; return; }
  t.innerHTML = `<tr><th><input type="checkbox" id="qAll" checked></th><th>Category</th><th>Lang</th><th>Source</th><th>Target</th><th>Notes</th><th>Captured</th><th></th></tr>` +
    S.queue.map(q => `<tr>
      <td><input type="checkbox" class="qsel" data-id="${q.id}" checked></td>
      <td>${esc(q.category)}</td><td class="muted">${esc(q.lang || "")}</td>
      <td>${esc(q.source)}</td><td>${esc(q.target)}</td><td>${esc(q.notes)}</td>
      <td class="muted">${fmt(q.timestamp)}</td>
      <td><button class="btn danger" data-del="${q.id}">✕</button></td></tr>`).join("");
  $("#qAll").onchange = e => $$(".qsel").forEach(c => c.checked = e.target.checked);
  $$("[data-del]").forEach(b => b.onclick = async () => {
    S.queue = S.queue.filter(q => q.id !== b.dataset.del);
    await saveState({ queue: S.queue }); renderQueue();
  });
}
$$(".seg button").forEach(b => b.onclick = () => {
  $$(".seg button").forEach(x => x.classList.remove("on")); b.classList.add("on");
  pushMode = b.dataset.mode;
  $("#modeWorkspace").hidden = pushMode !== "workspace";
  $("#modeSpeedrun").hidden = pushMode !== "speedrun";
});
$("#monitorToggle").onchange = async e => { S.settings.monitor = e.target.checked; await saveState({ settings: S.settings }); syncSettingsUI(); };
$("#parseBtn").onclick = async () => {
  const text = $("#pasteBox").value; if (!text.trim()) return;
  const r = await send({ type: "PARSE_TEXT", text, source: "manual paste" });
  S = await loadState(); renderQueue(); renderLogs();
  $("#parseResult").textContent = `Added ${r.added ?? 0}, skipped ${r.skipped ?? 0}. Choose a glossary, then push selected terms.`;
  $("#pasteBox").value = "";
  if (r.added) (pushMode === "workspace" ? $("#pushFile") : $("#srUrl")).focus();
};
$("#clearQueueBtn").onclick = async () => { S.queue = []; await saveState({ queue: [] }); renderQueue(); };

$("#pushBtn").onclick = async (e) => {
  const ids = $$(".qsel:checked").map(c => c.dataset.id);
  if (!ids.length) return toast("Select at least one term");
  const entries = S.queue.filter(q => ids.includes(q.id));
  const isSpeedrun = pushMode === "speedrun";
  let job;
  if (!isSpeedrun) {
    const file = S.files.find(f => f.id === $("#pushFile").value);
    if (!file) return toast("Choose the glossary file you want to use first");
    const tpl = S.templates.find(t => t.id === file.templateId);
    job = { url: file.targetLiveUrl, accountEmail: file.boundAccountEmail, label: file.name,
            mappings: effectiveMappings(tpl, file.overriddenMappings), meta: { fileId: file.id, folderId: file.folderId } };
  } else {
    const url = $("#srUrl").value.trim();
    speedrunTemplateId = $("#srTemplate").value;
    const tpl = S.templates.find(t => t.id === speedrunTemplateId);
    if (!url) return toast("Paste the target sheet URL");
    if (!tpl) return toast("Pick a template");
    job = { url, accountEmail: $("#srAcct").value, label: "Speedrun", mappings: effectiveMappings(tpl, {}), meta: {} };
  }
  if (!Object.keys(job.mappings).length) return toast("That template has no column mappings yet");

  e.target.disabled = true; e.target.textContent = "Pushing…";
  $("#pushHint").textContent = "Working in a background tab — leave this page open.";
  const r = await send({ type: "RUN_PUSH", job, entries });
  e.target.disabled = false; e.target.textContent = "Push selected terms";
  $("#pushHint").textContent = "";
  S = await loadState();
  if (isSpeedrun) speedrunTemplateId = S.templates[0]?.id || "";
  renderAll();
  if (!r?.ok) return toast(r?.error || "Push failed");
  const n = (s) => r.results.filter(x => x.status === s).length;
  const errors = n("error");
  const firstError = r.results.find(x => x.status === "error")?.reason;
  toast(errors
    ? `Added ${n("added")} · ${errors} error(s) left queued${firstError ? `: ${firstError}` : ""}`
    : `Added ${n("added")} · ${n("duplicate")} duplicate · ${n("skipped")} skipped`);
};

/* ---------- Logs ---------- */
function renderLogs() {
  const f = $("#logFilter").value;
  const list = S.logs.filter(l => !f || l.level === f).slice(0, 400);
  $("#logList").innerHTML = list.length
    ? list.map(l => `<li><time>${fmt(l.ts)}</time><span class="lv ${l.level}">${l.level}</span><span>${esc(l.message)}</span></li>`).join("")
    : `<li class="empty">Nothing logged yet.</li>`;
}
$("#logFilter").onchange = renderLogs;
$("#clearLogsBtn").onclick = async () => { S.logs = []; await saveState({ logs: [] }); renderLogs(); };

/* =====================================================================
 * STATS (Chart.js)
 * ===================================================================== */
let chartDate, chartFolder;
function renderStats() {
  const by = (t) => S.stats.filter(s => s.type === t).length;
  $("#kAdded").textContent = by("added"); $("#kDup").textContent = by("duplicate"); $("#kSkip").textContent = by("skipped");
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim(), teal = css.getPropertyValue("--teal").trim();
  Chart.defaults.color = css.getPropertyValue("--muted").trim();
  Chart.defaults.borderColor = css.getPropertyValue("--line").trim();

  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - (13 - i)); return d.toISOString().slice(0, 10); });
  const on = (d, t) => S.stats.filter(s => s.type === t && new Date(s.ts).toISOString().slice(0, 10) === d).length;
  chartDate?.destroy();
  chartDate = new Chart($("#chartDate"), {
    type: "line",
    data: { labels: days.map(d => d.slice(5)), datasets: [
      { label: "Added", data: days.map(d => on(d, "added")), borderColor: teal, backgroundColor: teal + "33", tension: .35, fill: true },
      { label: "Duplicates prevented", data: days.map(d => on(d, "duplicate")), borderColor: accent, backgroundColor: accent + "33", tension: .35, fill: true }] },
    options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });
  chartFolder?.destroy();
  chartFolder = new Chart($("#chartFolder"), {
    type: "bar",
    data: { labels: S.folders.map(f => f.name), datasets: [
      { label: "Added", data: S.folders.map(f => S.stats.filter(s => s.folderId === f.id && s.type === "added").length), backgroundColor: teal },
      { label: "Duplicates", data: S.folders.map(f => S.stats.filter(s => s.folderId === f.id && s.type === "duplicate").length), backgroundColor: accent }] },
    options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } }
  });
}

/* =====================================================================
 * SETTINGS
 * ===================================================================== */
function syncSettingsUI() {
  $("#setMonitor").checked = !!S.settings.monitor;
  $("#setClose").checked = !!S.settings.closeTabAfterFill;
  $("#monitorToggle").checked = !!S.settings.monitor;
}
$("#setMonitor").onchange = async e => { S.settings.monitor = e.target.checked; await saveState({ settings: S.settings }); syncSettingsUI(); };
$("#setClose").onchange = async e => { S.settings.closeTabAfterFill = e.target.checked; await saveState({ settings: S.settings }); };
$("#detectBtn").onclick = async (e) => {
  e.target.disabled = true; e.target.textContent = "Detecting…";
  const r = await send({ type: "DETECT_ACCOUNTS" });
  e.target.disabled = false; e.target.textContent = "Detect accounts";
  S = await loadState(); renderAccountPickers();
  toast(r?.accounts?.length ? `${r.accounts.length} account(s) found` : "No signed-in Google accounts found");
};
$("#wipeBtn").onclick = async () => {
  if (!confirm("Erase every folder, file, template, queue item and log?")) return;
  await chrome.storage.local.clear(); S = await loadState(); renderAll(); toast("All local data erased");
};
$("#exportAllBtn").onclick = () => exportZip({ all: true });

/* =====================================================================
 * MODULE 6 — ZIP EXPORT / MERGE IMPORT
 * ===================================================================== */
async function exportZip(scope) {
  const zip = new JSZip();
  let folders = [], files = [], templates = [], name = "glossary_workspace";

  if (scope.all) { folders = S.folders; files = S.files; templates = S.templates; }
  else if (scope.folderId) {
    const ids = new Set([scope.folderId]);
    let grew = true;
    while (grew) { grew = false; for (const f of S.folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }
    folders = S.folders.filter(f => ids.has(f.id));
    files = S.files.filter(f => ids.has(f.folderId));
    name = S.folders.find(f => f.id === scope.folderId)?.name || "folder";
    templates = S.templates.filter(t => files.some(f => f.templateId === t.id));
  } else if (scope.templateId) {
    const template = S.templates.find(t => t.id === scope.templateId);
    if (!template) return toast("Template not found");
    templates = [template]; name = template.name;
  } else {
    const file = S.files.find(f => f.id === scope.fileId);
    if (!file) return toast("File not found");
    files = [file]; folders = folderPath(file.folderId); name = file.name;
    templates = S.templates.filter(t => t.id === file.templateId);
  }
  const safe = value => String(value || "item").replace(/[<>:"\/\\|?*\x00-\x1f]/g, "_").trim().replace(/[. ]+$/g, "") || "item";
  const folderNames = id => folderPath(id).map(x => safe(x.name));
  const putDefinition = (kind, item, path) => {
    const data = { ...item };
    delete data.logoBase64;
    // Cached workbook downloads stay local for previews and row finding; they
    // are never part of an exported definition or workspace archive.
    delete data.snapshot;
    delete data.snapshotFile;
    delete data.snapshotBase64;
    delete data.snapshotB64;
    const assetPath = path ? `${path}/` : "";
    const logoAsset = item.logoBase64 ? `assets/${kind}/${assetPath}${safe(item.name)}.${imageExt(item.logoBase64)}` : null;
    data.logoAsset = logoAsset;
    zip.file(`${kind}/${path ? path + "/" : ""}${safe(item.name)}.json`, JSON.stringify(data, null, 2));
    if (logoAsset) zip.file(logoAsset, imageBytes(item.logoBase64), { base64: true });
    return data;
  };
  const imageExt = data => /^data:image\/([a-zA-Z0-9.+-]+)/.exec(data)?.[1]?.replace("svg+xml", "svg").replace("jpeg", "jpg") || "png";
  const imageBytes = data => String(data).split(",").pop();
  const manifestFolders = folders.map(f => putDefinition("folders", f, folderNames(f.parentId).concat(safe(f.name)).join("/")));
  const manifestTemplates = templates.map(t => putDefinition("templates", t, ""));
  const manifestFiles = files.map(f => putDefinition("files", f, folderNames(f.folderId).concat(safe(f.name)).join("/")));
  const payload = {
    version: 3, exportedAt: Date.now(), folders: manifestFolders, templates: manifestTemplates, files: manifestFiles,
    settings: S.settings
  };
  zip.file("workspace_data.json", JSON.stringify(payload, null, 2));

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${safe(name)}.zip`;
  a.click(); URL.revokeObjectURL(a.href);
  toast("Exported");
}

$("#importZipBtn").onclick = () => $("#importZipInput").click();
$("#importZipInput").onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return; e.target.value = "";
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const meta = JSON.parse(await zip.file("workspace_data.json").async("string"));
    let nf = 0, nfi = 0, nt = 0;
    const restoreLogo = async item => {
      if (item.logoAsset && zip.file(item.logoAsset)) {
        const b64 = await zip.file(item.logoAsset).async("base64");
        const ext = item.logoAsset.split(".").pop().toLowerCase();
        const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
        item.logoBase64 = `data:${mime};base64,${b64}`;
      }
      delete item.logoAsset;
      return item;
    };

    for (const raw of meta.templates || []) {
      const t = await restoreLogo({ ...raw });
      if (S.templates.some(x => x.id === t.id || x.name === t.name)) continue;
      S.templates.push(t); nt++;
      if (zip.file(`files/${t.id}.xlsx`)) S.snapshots[t.id] = { b64: await zip.file(`files/${t.id}.xlsx`).async("base64"), fetchedAt: Date.now(), size: 0, ext: "xlsx" };
    }
    for (const raw of meta.folders || []) {
      const fo = await restoreLogo({ ...raw });
      if (S.folders.some(x => x.id === fo.id)) continue;
      S.folders.push(fo); nf++;
    }
    for (const raw of meta.files || []) {
      const fi = await restoreLogo({ ...raw });
      const dup = S.files.find(x => x.id === fi.id || (x.folderId === fi.folderId && x.targetLiveUrl === fi.targetLiveUrl));
      if (dup) {
        // merge: fill gaps only, never clobber local edits
        dup.customLinks = [...(dup.customLinks || []), ...((fi.customLinks || []).filter(l => !(dup.customLinks || []).some(d => d.url === l.url)))];
        dup.overriddenMappings = { ...fi.overriddenMappings, ...dup.overriddenMappings };
        dup.templateId ||= fi.templateId; dup.logoBase64 ||= fi.logoBase64; dup.boundAccountEmail ||= fi.boundAccountEmail;
      } else { S.files.push({ ...fi, snapshotFile: undefined }); nfi++; }
      const key = (dup || fi).id;
      if (!S.snapshots[key] && fi.snapshotFile && zip.file(fi.snapshotFile))
        S.snapshots[key] = { b64: await zip.file(fi.snapshotFile).async("base64"), fetchedAt: Date.now(), size: 0, ext: "xlsx" };
    }
    // Re-home anything whose parent didn't come along, so nothing is orphaned.
    const fids = new Set(S.folders.map(f => f.id));
    for (const fo of S.folders) if (fo.parentId && !fids.has(fo.parentId)) fo.parentId = null;
    for (const fi of S.files) if (fi.folderId && !fids.has(fi.folderId)) fi.folderId = null;
    if (meta.settings) S.settings = { ...S.settings, ...meta.settings };
    await saveState({ folders: S.folders, files: S.files, templates: S.templates, snapshots: S.snapshots, ...(meta.settings ? { settings: S.settings } : {}) });
    renderAll(); toast(`Imported ${nf} folder(s), ${nfi} file(s), ${nt} template(s)`);
  } catch (err) { toast("Import failed: " + err.message); }
};
