/* =====================================================================
 * background.js — MV3 service worker.
 *  - opens the full-page dashboard
 *  - detects signed-in Google accounts locally (no OAuth/APIs)
 *  - fetches .xlsx snapshots through the bound account
 *  - finds the first empty row with start/end boundaries (SheetJS)
 *  - drives the Sheets "canvas hack": #range=A10 navigation + paste event
 *  - clipboard monitor via an offscreen document
 * ===================================================================== */
importScripts("lib/xlsx.full.min.js", "shared.js", "sheets-driver.js");

/* ---------- Dashboard ---------- */
chrome.action.onClicked.addListener(() => openDashboard());
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "gf-capture", title: "Capture glossary selection", contexts: ["selection"] });
  openDashboard();
});
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "gf-capture" && info.selectionText) await captureText(info.selectionText, "context menu");
});
async function openDashboard() {
  const url = chrome.runtime.getURL("dashboard.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing) chrome.tabs.update(existing.id, { active: true });
  else chrome.tabs.create({ url });
}

/* =====================================================================
 * Google account detection — probe /u/{i}/ with the browser's own cookies.
 * ===================================================================== */
async function detectGoogleAccounts() {
  const found = [];
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(`https://docs.google.com/spreadsheets/u/${i}/`, { credentials: "include", redirect: "follow" });
      if (res.url.includes("accounts.google.com/ServiceLogin")) { if (i === 0) break; continue; }
      const html = await res.text();
      const counts = {};
      for (const m of html.matchAll(/["'>]([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})["'<]/g)) {
        const e = m[1];
        if (/noreply|no-reply|example\.|googlegroups|sentry|@google\.com$/i.test(e)) continue;
        counts[e] = (counts[e] || 0) + 1;
      }
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (best) found.push({ index: i, email: best[0] });
      else if (res.ok) found.push({ index: i, email: `Account ${i}` });
    } catch { /* index unavailable */ }
  }
  await chrome.storage.local.set({ accounts: found });
  if (!found.length) await addLog("error", "No signed-in Google accounts detected.");
  return found;
}
const accountIndexFor = async (email) => {
  const { accounts = [] } = await chrome.storage.local.get("accounts");
  return accounts.find(a => a.email === email)?.index ?? 0;
};

/* =====================================================================
 * Offline snapshot fetch (.xlsx) through the bound account.
 * ===================================================================== */
async function fetchSnapshot({ url, accountIndex, email }) {
  const idx = accountIndex ?? (email ? await accountIndexFor(email) : 0);
  const p = parseGoogleUrl(String(url || "").trim());
  if (!p) throw new Error("That link isn't a Google Sheets or Docs link (it should contain /d/<id>).");
  const fmtx = p.kind === "spreadsheets" ? "xlsx" : "docx";
  const gid = p.kind === "spreadsheets" ? "" : (p.gid ? `&gid=${p.gid}` : "");
  const tried = [];

  /* ---- Strategy 1: direct download from the service worker ---- */
  const candidates = [
    exportUrl(url, idx),
    `https://docs.google.com/${p.kind}/d/${p.id}/export?format=${fmtx}${gid}&authuser=${idx}`,
    `https://docs.google.com/${p.kind}/d/${p.id}/export?format=${fmtx}${gid}`
  ];
  for (const ex of candidates) {
    try {
      const res = await fetch(ex, { credentials: "include", redirect: "follow" });
      const type = res.headers.get("content-type") || "";
      if (!res.ok) { tried.push(`direct ${res.status}`); continue; }
      if (type.includes("text/html")) { tried.push("direct: sign-in page"); continue; }
      const buf = await res.arrayBuffer();
      return { b64: bufToB64(buf), fetchedAt: Date.now(), size: buf.byteLength, ext: fmtx };
    } catch (e) { tried.push(`direct: ${e.message}`); }
  }

  /* ---- Strategy 2: download from INSIDE a docs.google.com tab ----
   * The page is first-party for Google, so your login cookies always apply,
   * whatever this browser's cookie settings are. Runs in a background tab. */
  if (p.kind === "spreadsheets") {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: accountUrl(url, idx), active: false });
      await waitTabComplete(tab.id, 30000);
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        // Keep the complete workbook so mappings can safely target any tab.
        args: [p.id, null, idx],
        func: async (id, gid, idx) => {
          const toB64 = (buf) => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
          const errs = [];
          const g = gid ? `&gid=${gid}` : "";
          // a) real .xlsx export (keeps colours)
          for (const u of [`/spreadsheets/u/${idx}/d/${id}/export?format=xlsx${g}`, `/spreadsheets/d/${id}/export?format=xlsx${g}`]) {
            try {
              const r = await fetch(u, { credentials: "include" });
              const t = r.headers.get("content-type") || "";
              if (r.ok && !t.includes("text/html")) return { kind: "xlsx", b64: toB64(await r.arrayBuffer()) };
              errs.push(`tab xlsx ${r.status}`);
            } catch (e) { errs.push(`tab xlsx: ${e.message}`); }
          }
          // b) same-origin CSV feed (no redirect; values only, no colours)
          try {
            const r = await fetch(`/spreadsheets/u/${idx}/d/${id}/gviz/tq?tqx=out:csv${g}`, { credentials: "include" });
            const t = r.headers.get("content-type") || "";
            if (r.ok && !t.includes("text/html")) return { kind: "csv", text: await r.text() };
            errs.push(`tab csv ${r.status}`);
          } catch (e) { errs.push(`tab csv: ${e.message}`); }
          return { errs, title: document.title, url: location.href };
        }
      });
      if (result?.kind === "xlsx") {
        const buf = b64ToBuf(result.b64);
        return { b64: result.b64, fetchedAt: Date.now(), size: buf.byteLength, ext: "xlsx" };
      }
      if (result?.kind === "csv") {
        // Turn the CSV into a real .xlsx so the rest of the app works unchanged.
        const wb = XLSX.read(result.text, { type: "string", raw: true });
        const out = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
        await addLog("info", "Sheet downloaded as plain values (no cell colours) — Google blocked the full export.");
        return { b64: out, fetchedAt: Date.now(), size: Math.round(out.length * 0.75), ext: "xlsx", valuesOnly: true };
      }
      if (result?.errs) tried.push(...result.errs);
      if (result?.url && /accounts\.google\.com|ServiceLogin/.test(result.url)) tried.push("tab: Google asked to sign in");
    } catch (e) { tried.push(`tab: ${e.message}`); }
    finally { if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {}); }
  }

  const detail = tried.join(" · ");
  await addLog("error", `Sheet download failed for ${url} — ${detail}`);
  throw new Error(`Couldn't download the sheet. Details: ${detail}. Check that the chosen account (u/${idx}) can open this file.`);
}

function waitTabComplete(tabId, timeout) {
  return new Promise((resolve) => {
    const t = setTimeout(done, timeout);
    function done() { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); setTimeout(resolve, 1500); }
    function l(id, info) { if (id === tabId && info.status === "complete") done(); }
    chrome.tabs.onUpdated.addListener(l);
  });
}

/* =====================================================================
 * MODULE 5.2 — first completely empty row within boundaries.
 * "Empty" = every mapped column (source/target/notes) is blank on that row.
 * Returns { row } or { full: true } when endRow is exceeded.
 * ===================================================================== */
function findEmptyRow(sheet, map, taken = new Set()) {
  const cols = [map.sourceCol, map.targetCol, map.notesCol, map.genderCol].filter(Boolean).map(colToIndex).filter(i => i >= 0);
  if (!cols.length) return { error: "No columns mapped" };
  const start = Math.max(1, parseInt(map.startRow, 10) || 1);
  const end = map.endRow ? parseInt(map.endRow, 10) : null;
  const ref = sheet?.["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { e: { r: start } };
  const limit = Math.max(ref.e.r + 2, start) + 500;

  for (let r = start; r <= limit; r++) {
    if (end && r > end) return { full: true };
    if (taken.has(r)) continue;
    const blank = cols.every(c => {
      const cell = sheet?.[XLSX.utils.encode_cell({ r: r - 1, c })];
      return !cell || (!cell.f && String(cell.w ?? cell.v ?? "").trim() === "");
    });
    if (blank) return { row: r };
  }
  return { full: true };
}

/* Existing values in a column, used for fuzzy duplicate detection. */
function columnValues(sheet, col, startRow) {
  const ci = colToIndex(col);
  if (ci < 0 || !sheet?.["!ref"]) return [];
  const ref = XLSX.utils.decode_range(sheet["!ref"]);
  const out = [];
  for (let r = Math.max(1, startRow || 1) - 1; r <= ref.e.r; r++) {
    const cell = sheet[XLSX.utils.encode_cell({ r, c: ci })];
    const v = String(cell?.w ?? cell?.v ?? "").trim();
    if (v) out.push({ row: r + 1, value: v });
  }
  return out;
}

/* =====================================================================
 * Writing one cell.
 * A real Ctrl+V is the primary path: the clipboard is staged in the
 * offscreen document, then the renderer pastes it exactly as it would for a
 * human. Keystroke typing is the fallback.
 * The downloaded workbook snapshot is checked by cell coordinates before
 * writing begins. The write phase only visits reserved cells and pastes.
 * ===================================================================== */
async function clipboardSet(text) {
  if (!await ensureOffscreen()) return false;
  const r = await chrome.runtime.sendMessage({ type: "OFFSCREEN_WRITE", text }).catch(() => null);
  return !!r?.ok;
}
async function writeCell(tabId, cell, value, state) {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (!text) return { ok: false, reason: "empty value" };
  const at = await sheetsGotoCell(tabId, cell);
  if (at !== cell) return { ok: false, reason: `Could not move to ${cell} (Sheets is on ${at || "?"})` };
  const firstPaste = !!state.firstPaste;
  state.firstPaste = false;
  // Let the first selection and clipboard update settle once per push. Later
  // cells go straight from their mapped coordinate to paste.
  if (firstPaste) await new Promise(r => setTimeout(r, 180));
  if (state.mode === "paste") {
    if (await clipboardSet(text)) {
      if (firstPaste) await new Promise(r => setTimeout(r, 100));
      await sheetsPaste(tabId);
      return { ok: true };
    }
    state.mode = "type";
    await addLog("info", "Could not stage the clipboard — using keystrokes instead.");
  }
  await sheetsTypeValue(tabId, text);
  return { ok: true };
}

/* =====================================================================
 * MODULE 5 — push a batch of queue entries into a live sheet.
 * job = { url, accountEmail, mappings, label }
 * ===================================================================== */
async function runPush(job, entries) {
  const idx = await accountIndexFor(job.accountEmail);
  const snap = await fetchSnapshot({ url: job.url, accountIndex: idx });
  const wb = XLSX.read(b64ToBuf(snap.b64), { type: "array" });
  const p = parseGoogleUrl(job.url);

  // Pick the sheet matching ?gid= when we can, else the first one.
  let sheetName = wb.SheetNames[0];
  if (p?.gid && wb.Workbook?.Sheets) {
    const hit = wb.Workbook.Sheets.findIndex(s => String(s.sheetId ?? "") === String(p.gid));
    if (hit >= 0 && wb.SheetNames[hit]) sheetName = wb.SheetNames[hit];
  }

  // Open the live sheet in its own small, UNFOCUSED window so it renders
  // properly but never steals your mouse or keyboard.
  const win = await chrome.windows.create({ url: accountUrl(job.url, idx), focused: false, width: 1100, height: 760, left: 40, top: 40 });
  const tab = win.tabs[0];
  await waitTabComplete(tab.id, 40000);
  try {
    await sheetsAttach(tab.id);
    const ready = await sheetsWaitReady(tab.id);
    if (!ready.ok) throw new Error(ready.why);
  }
  catch (err) {
    await sheetsDetach(tab.id);
    chrome.windows.remove(win.id).catch(() => {});
    throw new Error(`Could not control the sheet tab: ${err.message}.`);
  }

  const results = [];
  const takenByCat = {};
  const byCat = {};
  /* Phase 1 checks/reserves destinations from the workbook snapshot only.
     Phase 2 navigates to reserved cells and writes values. */
  const pendingWrites = [];
  await chrome.storage.session.set({ pushing: true }); // don't re-read our own staging
  const writeState = { mode: "paste", firstPaste: true };
  for (const e of entries) (byCat[e.category] ||= []).push(e);

  for (const [category, list] of Object.entries(byCat)) {
    const map = job.mappings?.[category];
    if (!map?.sourceCol && !map?.targetCol) {
      list.forEach(e => results.push({ id: e.id, source: e.source, status: "skipped", reason: `No mapping for "${category}"` }));
      continue;
    }
    const categorySheetName = map.sheetName || sheetName;
    const sheet = wb.Sheets[categorySheetName];
    if (!sheet) {
      list.forEach(e => results.push({ id: e.id, source: e.source, status: "skipped", reason: `Sheet tab "${categorySheetName}" is not in the workbook snapshot` }));
      continue;
    }
    const sheetIndex = wb.SheetNames.indexOf(categorySheetName);
    // The template contributes the tab name only. Resolve the live gid from
    // this selected target workbook so copied spreadsheets can use new IDs.
    const categorySheetId = sheetIndex >= 0 ? wb.Workbook?.Sheets?.[sheetIndex]?.sheetId : null;
    const taken = (takenByCat[category] ||= new Set());
    const existingSrc = columnValues(sheet, map.sourceCol, map.startRow);
    const existingTgt = columnValues(sheet, map.targetCol, map.startRow);

    for (const e of list) {
      // --- fuzzy duplicate check against the offline snapshot ---
      let best = null;
      for (const x of existingSrc) { const s = similarity(e.source, x.value); if (!best || s > best.score) best = { score: s, value: x.value }; }
      for (const x of existingTgt) { const s = similarity(e.target, x.value); if (!best || s > best.score) best = { score: s, value: x.value }; }
      if (best && best.score >= DUP_THRESHOLD) {
        results.push({ id: e.id, source: e.source, status: "duplicate", match: best.value, score: best.score });
        continue;
      }

      // Pick an empty destination using the downloaded workbook's numbered
      // cell coordinates. No live cell inspection is done during the push.
      const spot = findEmptyRow(sheet, map, taken);
      if (spot.full) {
        results.push({ id: e.id, source: e.source, status: "skipped", reason: `Range Full — ${category} has no empty row before ${map.endRow}` });
        continue;
      }
      if (spot.error) {
        results.push({ id: e.id, source: e.source, status: "skipped", reason: spot.error });
        continue;
      }
      const row = spot.row;
      taken.add(row);

      // Reserve this row in the in-memory workbook so later entries select
      // the next empty numbered row. Pasting starts only after this pass.
      existingSrc.push({ row, value: e.source });
      existingTgt.push({ row, value: e.target });
      for (const [col, value] of [
        [map.sourceCol, e.source], [map.targetCol, e.target],
        [map.genderCol, e.gender], [map.notesCol, e.notes]
      ]) {
        if (col && value) sheet[XLSX.utils.encode_cell({ r: row - 1, c: colToIndex(col) })] = { t: "s", v: value };
      }
      pendingWrites.push({ map, sheet, sheetName: categorySheetName, sheetId: categorySheetId, entry: e, row });
    }
  }

  // Phase 2: no cell checks here. All target rows were selected from the
  // snapshot and reserved above; now visit each destination and paste.
  for (const plan of pendingWrites) {
    const { map, sheet, sheetName: targetSheetName, sheetId, entry: e, row } = plan;
    try { await sheetsSelectTab(tab.id, targetSheetName, sheetId); }
    catch (err) {
      results.push({ id: e.id, source: e.source, status: "error", reason: err.message });
      continue;
    }
    const writes = [
      [map.sourceCol, e.source],
      [map.targetCol, e.target],
      [map.genderCol, e.gender],
      [map.notesCol, e.notes]
    ].filter(([c, v]) => c && v);
    let wrote = 0, note = "";
    for (const [col, value] of writes) {
      const cell = `${String(col).toUpperCase()}${row}`;
      try {
        const r = await writeCell(tab.id, cell, value, writeState);
        if (!r.ok) { note = r.reason; continue; }
        wrote++;
        sheet[XLSX.utils.encode_cell({ r: row - 1, c: colToIndex(col) })] = { t: "s", v: value };
      } catch (err) { note = `Writing ${cell} failed: ${err.message}`; }
    }
    if (wrote && !note) {
      results.push({ id: e.id, source: e.source, target: e.target, status: "added", cell: `${String(map.sourceCol || map.targetCol).toUpperCase()}${row}` });
    } else {
      results.push({ id: e.id, source: e.source, status: "error", reason: note || "Paste failed" });
    }
  }

  const { settings = DEFAULT_STATE.settings } = await chrome.storage.local.get("settings");
  await new Promise(r => setTimeout(r, 2500)); // let Sheets save the edits
  await sheetsDetach(tab.id);
  await chrome.storage.session.remove("pushing");
  const hasSkipped = results.some(r => r.status !== "added" && r.status !== "duplicate");
  if (settings.closeTabAfterFill && !hasSkipped) chrome.windows.remove(win.id).catch(() => {});

  // Log + stats + drop processed entries from the queue.
  for (const r of results) {
    if (r.status === "added") { await addLog("ok", `Added "${r.source}" → "${r.target}" at ${r.cell} (${job.label})`, job.meta); await addStat("added", job.meta); }
    else if (r.status === "duplicate") { await addLog("dup", `Duplicate skipped: "${r.source}" ~ "${r.match}" (${Math.round(r.score * 100)}%)`, job.meta); await addStat("duplicate", job.meta); }
    else if (r.status === "error") { await addLog("error", `Could not safely push "${r.source}": ${r.reason} (${job.label})`, job.meta); await addStat("error", job.meta); }
    else { await addLog("skip", `Skipped "${r.source}": ${r.reason}`, job.meta); await addStat("skipped", job.meta); }
  }
  const done = new Set(results.filter(r => r.status !== "error").map(r => r.id));
  const { queue = [] } = await chrome.storage.local.get("queue");
  await chrome.storage.local.set({ queue: queue.filter(e => !done.has(e.id)) });
  return results;
}

/* =====================================================================
 * Clipboard monitor (offscreen document + alarm).
 * ===================================================================== */
async function ensureOffscreen() {
  if (await chrome.offscreen?.hasDocument?.()) return true;
  try {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "Watch the clipboard for glossary-formatted text." });
    return true;
  } catch { return false; }
}
chrome.alarms?.create?.("gf-clipboard", { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(async (a) => {
  if (a.name !== "gf-clipboard") return;
  const { settings = DEFAULT_STATE.settings } = await chrome.storage.local.get("settings");
  if (!settings.monitor) return;
  // A push stages values on the clipboard; don't read our own writes back.
  const { pushing } = await chrome.storage.session.get("pushing");
  if (pushing) return;
  if (await ensureOffscreen()) chrome.runtime.sendMessage({ type: "OFFSCREEN_POLL" }).catch(() => {});
});

async function captureText(text, source) {
  const { valid, skipped } = parseGlossaryText(text);
  const { queue = [] } = await chrome.storage.local.get("queue");
  const seen = new Set(queue.map(q => q.raw));
  const fresh = valid.filter(v => !seen.has(v.raw));
  if (fresh.length) await chrome.storage.local.set({ queue: [...fresh, ...queue] });
  for (const s of skipped) await addLog("skip", `Skipped (${source}): ${s.reason} — ${s.raw.slice(0, 160)}`);
  if (fresh.length) await addLog("ok", `Captured ${fresh.length} term(s) from ${source}.`);
  return { added: fresh.length, skipped: skipped.length };
}

/* ---------- Message router ---------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "DETECT_ACCOUNTS": return sendResponse({ ok: true, accounts: await detectGoogleAccounts() });
        case "FETCH_SNAPSHOT":  return sendResponse({ ok: true, snapshot: await fetchSnapshot(msg) });
        case "PARSE_TEXT":      return sendResponse({ ok: true, ...await captureText(msg.text, msg.source || "manual paste") });
        case "RUN_PUSH":
          try { return sendResponse({ ok: true, results: await runPush(msg.job, msg.entries) }); }
          finally { await chrome.storage.session.remove("pushing"); }

        case "OPEN_URL":        chrome.tabs.create({ url: accountUrl(msg.url, await accountIndexFor(msg.email)) }); return sendResponse({ ok: true });
        case "CLIPBOARD_TEXT": {
          const { lastClip } = await chrome.storage.session.get("lastClip");
          if (msg.text && msg.text !== lastClip && LOOKS_LIKE_GLOSSARY.test(msg.text)) {
            await chrome.storage.session.set({ lastClip: msg.text });
            await captureText(msg.text, "clipboard");
          }
          return sendResponse({ ok: true });
        }
        default: return sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (e) { await addLog("error", e.message); sendResponse({ ok: false, error: e.message }); }
  })();
  return true;
});
