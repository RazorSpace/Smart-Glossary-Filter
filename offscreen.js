/* Offscreen clipboard helper. The service worker has no DOM, so every
   clipboard touch happens here: polling for glossary text, staging the value
   a Sheets tab is about to paste, and reading a cell back after a write. */

async function readClip() {
  try { return await navigator.clipboard.readText(); }
  catch {
    const el = document.getElementById("sink");
    el.value = ""; el.focus(); document.execCommand("paste");
    return el.value;
  }
}

async function writeClip(text) {
  const el = document.getElementById("sink");
  el.value = String(text ?? "");
  el.focus(); el.select();
  // execCommand works in an offscreen document, where the async Clipboard
  // API's focus requirement cannot be satisfied.
  if (document.execCommand("copy")) return true;
  try { await navigator.clipboard.writeText(el.value); return true; } catch { return false; }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "OFFSCREEN_POLL") {
    readClip().then(text => { if (text) chrome.runtime.sendMessage({ type: "CLIPBOARD_TEXT", text }).catch(() => {}); });
    return;
  }
  if (msg?.type === "OFFSCREEN_READ") { readClip().then(text => sendResponse({ ok: true, text })); return true; }
  if (msg?.type === "OFFSCREEN_WRITE") { writeClip(msg.text).then(ok => sendResponse({ ok })); return true; }
});
