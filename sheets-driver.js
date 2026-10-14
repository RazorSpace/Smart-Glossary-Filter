/* =====================================================================
 * sheets-driver.js — the only code that writes into a LIVE Google Sheet.
 *
 * Sheets paints its grid on a <canvas>: there is no <input> to set, and a
 * ClipboardEvent built in JS carries no user gesture, so Sheets drops it.
 * What does work is driving the renderer through the DevTools Protocol
 * (the "debugger" permission):
 *   1. put the cell reference into the Name Box and press a REAL Enter,
 *   2. let Sheets move its own selection,
 *   3. insert the text the way an IME would, then Enter to commit.
 * Called from background.js › runPush(). Loaded via importScripts.
 * ===================================================================== */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- chrome.debugger, promisified (callback form works on every
     Chrome build, and lastError becomes a real throw we can report) ---------- */
function dbgAttach(tabId) {
  return new Promise((resolve, reject) => chrome.debugger.attach({ tabId }, "1.3", () => {
    const e = chrome.runtime.lastError;
    e ? reject(new Error(e.message)) : resolve();
  }));
}
function dbgSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
    const e = chrome.runtime.lastError;
    e ? reject(new Error(`${method}: ${e.message}`)) : resolve(res);
  }));
}
function sheetsDetach(tabId) {
  return new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
}

/* Run a function in the page and get its return value back. The Name Box and
   the formula bar are ordinary DOM, so the isolated world can read them.
   Falls back to the protocol — we are attached anyway — if chrome.scripting
   is refused for this tab. */
async function inPage(tabId, func, args = []) {
  try {
    const [hit] = await chrome.scripting.executeScript({ target: { tabId }, args, func });
    return hit?.result;
  } catch (scriptingErr) {
    const res = await dbgSend(tabId, "Runtime.evaluate", {
      expression: `(${func.toString()}).apply(null, ${JSON.stringify(args)})`,
      returnByValue: true, awaitPromise: true
    }).catch(() => { throw scriptingErr; });
    if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || "page evaluation failed");
    return res?.result?.value;
  }
}

/* ---------- Attach ---------- */
async function sheetsAttach(tabId) {
  try { await dbgAttach(tabId); }
  catch (err) { if (!/already attached/i.test(err.message)) throw err; }
  /* The push window is deliberately created UNFOCUSED so it never steals the
     keyboard — but a blurred renderer swallows key events. Focus emulation
     makes the page behave as if it were the active window anyway. */
  await dbgSend(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  return true;
}

/* ---------- Readiness ----------
 * The grid is usable once the Name Box is showing a selection. Nothing else
 * is required: Sheets owns its own focus from there on.
 * Returns { ok } or { ok:false, why } — `why` goes straight into the error
 * the dashboard shows, so a future break says what was actually missing. */
function sheetsProbe(tabId) {
  return inPage(tabId, () => {
    const nb = document.querySelector("#t-name-box");
    return {
      url: location.href,
      title: document.title,
      nameBox: !!nb,
      cell: nb?.value || "",
      signin: /accounts\.google\.com|ServiceLogin/.test(location.href)
    };
  });
}

async function sheetsWaitReady(tabId, timeout = 45000) {
  const t0 = Date.now();
  let last = null, err = null;
  while (Date.now() - t0 < timeout) {
    try { last = await sheetsProbe(tabId); err = null; }
    catch (e) { err = e.message; }
    if (last?.signin) return { ok: false, why: "Google asked this account to sign in" };
    if (last?.nameBox && last.cell) return { ok: true, at: last.cell };
    await sleep(400);
  }
  const why = err ? `the page could not be inspected (${err})`
    : !last ? "the page never answered"
    : !last.nameBox ? `no Sheets grid on that tab (it is showing "${String(last.title).slice(0, 60)}")`
    : "the grid loaded but never took a cell selection";
  return { ok: false, why };
}

const sheetsNameBox = (tabId) =>
  inPage(tabId, () => (document.querySelector("#t-name-box")?.value || "").trim().toUpperCase());

/* Name of the tab currently open at the bottom of the grid — the .xlsx copy
   has no gid, so this is how we know which sheet we are really typing into. */
const sheetsActiveTabName = (tabId) => inPage(tabId, () => {
  const tab = document.querySelector(".docs-sheet-active-tab");
  const name = tab?.querySelector(".docs-sheet-tab-name") || tab;
  return name?.textContent?.trim() || null;
});

/* While a cell is being edited, Sheets mirrors the text into the cell overlay
   and into the formula bar. Either one proves our keystrokes landed. */
const sheetsEditorText = (tabId) => inPage(tabId, () => ({
  cell: document.querySelector(".cell-input")?.innerText ?? null,
  bar: document.querySelector("#t-formula-bar-input")?.innerText ?? null
}));

/* ---------- Keys ---------- */
const KEYS = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", vk: 27, text: "" }
};
async function sheetsPressKey(tabId, name) {
  const k = KEYS[name];
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  const typed = k.text ? { text: k.text, unmodifiedText: k.text } : {};
  await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...base, ...typed });
  await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/* =====================================================================
 * Move the selection to one cell. Returns where Sheets actually ended up,
 * so the caller can refuse to type when the jump missed.
 * ===================================================================== */
async function sheetsGotoCell(tabId, cell) {
  const want = String(cell).toUpperCase();
  // A merged cell reports its whole range ("A1:D1") — still the right landing.
  const landed = (at) => at === want || at.startsWith(want + ":");

  for (let attempt = 0; attempt < 2; attempt++) {
    // Sheets' Enter handler reads the Name Box's .value, so writing the
    // reference in directly is enough — no per-character typing needed.
    const focused = await inPage(tabId, (ref) => {
      const nb = document.querySelector("#t-name-box");
      if (!nb) return false;
      nb.focus();
      nb.value = ref;
      nb.dispatchEvent(new Event("input", { bubbles: true }));
      return document.activeElement === nb;
    }, [want]);
    if (!focused) throw new Error("Sheets' Name Box is not available on this tab");

    await sheetsPressKey(tabId, "Enter");

    // Sheets scrolls and re-renders before the Name Box catches up.
    for (let i = 0; i < 20; i++) {
      const at = await sheetsNameBox(tabId);
      if (landed(at)) return want;
      await sleep(100);
    }
  }
  const at = await sheetsNameBox(tabId);
  return landed(at) ? want : at;
}

/* =====================================================================
 * Clipboard keystrokes — Ctrl+V / Ctrl+C handed to the renderer's own edit
 * pipeline via the `commands` field, which is the path a human keystroke
 * takes. Sheets then does the paste itself, so we depend on none of its
 * internal markup: no hidden input to find, no edit overlay to watch.
 * ===================================================================== */
async function sheetsEditCommand(tabId, command) {
  const spec = command === "paste" ? { key: "v", code: "KeyV", vk: 86 } : { key: "c", code: "KeyC", vk: 67 };
  const base = {
    key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk, modifiers: 2 /* Ctrl */
  };
  try { await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, commands: [command] }); }
  catch { await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }); }
  await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(200);
}
const sheetsPaste = (tabId) => sheetsEditCommand(tabId, "paste");
const sheetsCopy = (tabId) => sheetsEditCommand(tabId, "copy");

/* =====================================================================
 * Keystroke fallback: type one value into the selected cell and commit it.
 * Never throws on a failed edit — the caller reads the cell back off the
 * grid to decide whether anything actually landed.
 * ===================================================================== */
async function sheetsTypeValue(tabId, value) {
  // Tabs and newlines would spill the value into neighbouring cells.
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (!text) return false;
  const want = text.replace(/\s+/g, "");

  // Pass 1 — one IME-style insert. Fast, and correct for Korean/Chinese/
  // Japanese text, which per-character key events mangle.
  const inserted = await dbgSend(tabId, "Input.insertText", { text }).then(() => true, () => false);
  await sleep(90);

  /* Only a visible, EMPTY editor proves nothing landed; if Sheets' overlay
     isn't where we look for it, don't retype on a guess. */
  const seen = await sheetsEditorText(tabId).catch(() => null);
  const visible = seen && (seen.cell != null || seen.bar != null);
  const shows = visible && [seen.cell, seen.bar].some(v => v != null && v.replace(/\s+/g, "").includes(want));

  if (!inserted || (visible && !shows)) {
    // Pass 2 — drop the half-open editor and send real character keys.
    await sheetsPressKey(tabId, "Escape");
    await sleep(60);
    for (const ch of [...text]) {
      await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
      await sleep(12);
    }
    await sleep(120);
  }

  await sheetsPressKey(tabId, "Enter"); // commit
  await sleep(150);
  return true;
}
