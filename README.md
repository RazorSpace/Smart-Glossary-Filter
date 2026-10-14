# Smart Glossary Filler

A Chrome extension for translators and fan-translation teams. Paste a block of glossary
terms in a fixed format, and it files each term into the right columns of a live Google
Sheet — picking the first empty row, skipping fuzzy duplicates, and respecting per-category
row boundaries.

Everything runs locally. There is no server, no OAuth app, no API key: sheets are read with
the browser's own Google session and written by driving the page the way a person would.

* **Version:** 1.4.0
* **Manifest:** V3
* **Browser:** Chrome (or any Chromium browser with `chrome.debugger` and offscreen documents — Edge, Brave)

---

## Table of contents

* [Why this exists](#why-this-exists)
* [Install](#install)
* [Quick start](#quick-start)
* [Glossary text format](#glossary-text-format)
* [The 12 categories](#the-12-categories)
* [The dashboard](#the-dashboard)
* [How the writer works](#how-the-writer-works)
* [Duplicate detection](#duplicate-detection)
* [Empty-row selection](#empty-row-selection)
* [Permissions](#permissions)
* [Data, privacy and storage](#data-privacy-and-storage)
* [Export and import](#export-and-import)
* [Project layout](#project-layout)
* [Troubleshooting](#troubleshooting)
* [Known limitations](#known-limitations)
* [Development](#development)
* [License](#license)

---

## Why this exists

Translating serialised fiction means maintaining a glossary: every character name, sect,
skill and honorific has to land in a spreadsheet, in the right column group, without
duplicates. Doing that by hand for a few hundred terms per volume is tedious and
error-prone.

The hard part is writing into Google Sheets. Sheets paints its grid on a `<canvas>`, so
there is no cell element to set, and a `ClipboardEvent` constructed in JavaScript carries no
user gesture — Sheets ignores it. This extension therefore does two things:

1. **Reads** the sheet by downloading an `.xlsx` snapshot through your existing Google
   session, and analysing it offline with SheetJS. That is how it knows which rows are empty
   and which terms already exist, without any API quota.
2. **Writes** by driving the real page through the Chrome DevTools Protocol: it puts a cell
   reference in the Name Box, presses a genuine <kbd>Enter</kbd>, stages the value on the
   clipboard, and presses a genuine <kbd>Ctrl</kbd>+<kbd>V</kbd>. Sheets handles the paste
   itself, exactly as it would for a human.

---

## Install

Not on the Chrome Web Store — load it unpacked.

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. The dashboard opens automatically on install. Click the toolbar icon to reopen it.

Be signed in to the Google account that owns the target sheet, in the same browser profile.

> After editing any source file, press the reload icon on the extension's card in
> `chrome://extensions`. The service worker does not hot-reload.

---

## Quick start

1. **Settings → Detect accounts.** The extension probes `docs.google.com/spreadsheets/u/0…7/`
   with your own cookies and lists the Google accounts signed in to this browser. Each one
   maps to a `/u/{n}/` index, which is how the right account is used later.
2. **Template Studio → New template.** Give it a name, optionally a logo, and paste the URL
   of a representative sheet. Click **Fetch preview** — the sheet renders as an HTML table
   with its real fill colours.
3. **Map the columns.** Click a mapping box on the left (for example *Character Names →
   Source col*), then click the matching cell in the preview. The box fills in. Each of the
   12 categories takes up to five values:

   | Field | Meaning |
   | --- | --- |
   | Source col | Column for the original term (e.g. `B`) |
   | Target col | Column for the translation (e.g. `C`) |
   | Notes col | Column for the parenthetical note (e.g. `D`) |
   | Start row | First data row, below your headers (e.g. `3`) |
   | End row | Optional. The push stops rather than writing past it |

4. **Workspace → New file.** Point it at the live sheet, bind a Google account, choose the
   template. Per-file overrides let one sheet differ from the template without editing it.
5. **Queue.** Paste your glossary text and click **Add to queue**, or turn on **Watch
   clipboard** and just copy text anywhere.
6. **Push selected terms.** A small unfocused window opens, fills the cells, and closes.

---

## Glossary text format

One term per line. The category can be a label on the line itself, or a heading above a
block of lines.

```
* Category: - [LANG] "Source" → "Target (Notes)"
```

* `LANG` is a two-letter tag, or several separated by slashes: `[KR]`, `[JP]`, `[KR/CH]`.
* The arrow may be `→`, `⇒`, `->` or `=>`.
* The bullet may be `-`, `–`, `—`, `•` or `*`.
* **Notes** are the last trailing `(...)` or `[...]` group of the target.
* Markdown bold (`**`) and italics (`__`) are stripped before parsing, so AI output pastes
  verbatim.
* Quotes are optional; curly quotes are fine.

### The missing-pair rule

A line with a source but no target — or a target but no source — is **never queued**. It is
skipped and the reason is written to the Activity log. This is deliberate: a half-entry in a
glossary is worse than no entry.

### Examples

```
**1. Character Names**
* Character Name: - [KR] "김철수" → "Kim Cheolsu (protagonist)"
* Character Name: - [KR] "선인(仙人)" → "Immortals"

**12. Other Terms**
* Term: - [KR] "마적" → "Horse thieves"
* Term: - [KR] "빙당" → "Bingdang [Sugar candy]"
- [KR] "무명" → "Nameless"
```

The last line has no label; it inherits **Other Terms** from the heading above it.

### Prompt template

This is the format the parser is built around. Give it to an LLM when extracting terms from
a chapter:

```
**1. Character Names**
* Character Name: - [KR/CH/JP/ID] "Source" → "Translation (Gender)"

**2. Titles/Honorifics**
* Title: - [KR/CH/JP/ID] "Source" → "Translation"

**3. Professions/Ranks**
* Profession/Rank: - [KR/CH/JP/ID] "Source" → "Translation"

**4. Guild Names**
* Guild Name: - [KR/CH/JP/ID] "Source" → "Translation"

**5. Organization Names**
* Org Name: - [KR/CH/JP/ID] "Source" → "Translation"

**6. Place Names**
* Place Name: - [KR/CH/JP/ID] "Source" → "Translation"

**7. Skill Names**
* Skill Name: - [KR/CH/JP/ID] "Source" → "Translation"

**8. Ability Names**
* Ability Name: - [KR/CH/JP/ID] "Source" → "Translation"

**9. Item Names**
* Item Name: - [KR/CH/JP/ID] "Source" → "Translation"

**10. System/Cultivation Levels**
* System/Level Term: - [KR/CH/JP/ID] "Source" → "Translation"

**11. Sound Effects (SFX)**
* SFX: - [KR/CH/JP/ID] "Source" → "Translation"

**12. Other Terms**
* Term: - [KR/CH/JP/ID] "Source" → "Translation"
```

---

## The 12 categories

Mappings, duplicate checks and row boundaries are all per category. The canonical names are
fixed, but labels are matched loosely — singular or plural, numbered, decorated, or any
listed alias.

| # | Category | Labels that resolve to it |
| --- | --- | --- |
| 1 | Character Names | `Character Name`, `Character`, `Char`, `Name`, `Person` |
| 2 | Titles/Honorifics | `Title`, `Honorific` |
| 3 | Professions/Ranks | `Profession/Rank`, `Profession`, `Rank`, `Job`, `Occupation` |
| 4 | Guild Names | `Guild Name`, `Guild` |
| 5 | Organization Names | `Org Name`, `Org`, `Organization`, `Organisation`, `Faction`, `Clan`, `Sect` |
| 6 | Place Names | `Place Name`, `Place`, `Location` |
| 7 | Skill Names | `Skill Name`, `Skill`, `Technique` |
| 8 | Ability Names | `Ability Name`, `Ability` |
| 9 | Item Names | `Item Name`, `Item`, `Object`, `Equipment` |
| 10 | System/Cultivation Levels | `System/Level Term`, `System`, `Cultivation`, `Cultivation Level`, `Level`, `Realm` |
| 11 | Sound Effects (SFX) | `SFX`, `Sound`, `Sound Effect`, `Onomatopoeia` |
| 12 | Other Terms | `Term`, `Other`, `Other Term`, `Misc`, `Miscellaneous`, `General` |

Matching is case-insensitive and ignores punctuation, plurals and leading numbering, so
`12. OTHER TERMS`, `other term` and `Other Terms:` are all the same category. A label that
resolves to none of the 12 is reported as `Unknown category "…"` rather than guessed at.

A heading only switches the category if it genuinely names one of the 12 — ordinary prose
between blocks cannot hijack the lines that follow it.

---

## The dashboard

Opened by clicking the toolbar icon. Six views, light and dark theme.

### Workspace

Nested folders and file tiles. A **file** is one live sheet plus everything needed to write
to it: URL, bound Google account, template, per-file mapping overrides, a logo, and custom
links (wiki, raws, comic). Right-click any tile for open / edit / export / delete.

### Template Studio

Where column mappings live, so a layout is described once and reused by every file. Includes
the colour-accurate sheet preview and click-to-map. Templates can carry a logo image, shown
on the tile.

### Queue

* Paste box for glossary text, with a live count of added and skipped lines.
* **Watch clipboard** — polls the clipboard every 30 seconds and captures anything matching
  the glossary pattern. Also available as a right-click context-menu item on selected text.
* A table of captured terms with per-row checkboxes, so you can push a subset.
* Two push modes: **Workspace** (a saved file) and **Speedrun** (a URL + account + template,
  nothing saved).

### Activity log

Every add, duplicate, skip and error, with timestamps and filters. This is the first place
to look when a push does not do what you expected — failures name the exact cell and reason.
Capped at 2000 entries.

### Stats

Terms added, duplicates prevented and skips, as 14-day trend lines and a per-folder
breakdown (Chart.js). Capped at 20000 events.

### Settings

Account detection, the clipboard watcher toggle, whether to close the sheet window after a
push, full export, and **Erase all local data**.

---

## How the writer works

A push runs entirely in the service worker, [`background.js`](background.js), with the
protocol primitives in [`sheets-driver.js`](sheets-driver.js).

```
1. fetchSnapshot()      download the sheet as .xlsx through the bound /u/{n}/ account
2. XLSX.read()          parse it offline; pick the sheet matching the live tab's name
3. windows.create()     open the live sheet, small and UNFOCUSED
4. sheetsAttach()       chrome.debugger.attach + Emulation.setFocusEmulationEnabled
5. sheetsWaitReady()    wait until the Name Box shows a selection
6. clipboardSelfTest()  confirm the clipboard round-trips before trusting it
   per entry:
7.   similarity()       fuzzy duplicate check against the snapshot
8.   findEmptyRow()     first row where every mapped column is blank
   per cell:
9.     sheetsGotoCell() write the ref into #t-name-box, press a real Enter
10.    clipboardSet()   stage the value via the offscreen document
11.    sheetsPaste()    Ctrl+V through Input.dispatchKeyEvent commands:["paste"]
12.    verify (once)    Ctrl+C the cell back and compare
13. sheetsDetach()      detach, optionally close the window
```

### Why an unfocused window

The push window is created with `focused: false` so it never steals your keyboard or mouse —
you can keep working while it runs. A blurred renderer normally ignores synthetic input, so
the driver enables `Emulation.setFocusEmulationEnabled`, which makes the page behave as if
it were the active window.

### Why Ctrl+V and not typing

`Input.dispatchKeyEvent` with `commands: ["paste"]` invokes the renderer's own edit command.
Sheets performs the paste through its normal handler, so the extension needs no knowledge of
Sheets' internal markup — no hidden input to locate, no edit overlay to watch. Keystroke
typing (`Input.insertText`, falling back to per-character `char` events) is kept as a
secondary path.

### Verification

The **first** write of each push is read back off the grid with <kbd>Ctrl</kbd>+<kbd>C</kbd>
and compared, then the remaining writes run unchecked for speed.

* A value that returns **reformatted** (Sheets coercing a number or date) counts as success,
  and the stored value is logged so you can fix column formatting.
* A cell that returns **empty** means nothing landed. The push switches to keystroke typing,
  retries that cell, and if that is also empty it reports
  `Neither Ctrl+V nor typing put anything into C3`.
* Because an unreadable clipboard would look identical to an empty cell, a round-trip
  self-test runs first. If it fails, the log says so instead of guessing.

The design rule throughout: **never report a write that cannot be observed.**

---

## Duplicate detection

Each incoming term is compared against the existing values in the mapped source *and* target
columns of the offline snapshot, using normalised Levenshtein similarity.

* Normalisation drops case, whitespace, quotes and punctuation.
* Threshold: **0.88** (`DUP_THRESHOLD` in [`shared.js`](shared.js)).
* A hit is logged as `Duplicate skipped: "x" ~ "y" (93%)` and counted in Stats.

The comparison runs against the snapshot taken at the start of the push, plus everything
written during it — so a batch containing the same term twice only writes it once.

---

## Empty-row selection

For each category, `findEmptyRow()` scans from `startRow` for the first row where **every**
mapped column (source, target, notes) is blank, skipping rows already claimed earlier in the
same push. If `endRow` is set and reached, the entry is skipped with
`Range Full — <category> has no empty row before <endRow>`.

This is what lets several categories share one sheet in side-by-side column groups, each
with its own vertical range.

---

## Permissions

| Permission | Why |
| --- | --- |
| `debugger` | The only way to deliver real keystrokes and edit commands to a canvas grid. Chrome shows a *"started debugging this browser"* banner while a push runs; this is unavoidable. |
| `scripting` | Reads the Name Box and the active tab name from the Sheets page. |
| `offscreen` | Gives the service worker a DOM for clipboard access. |
| `clipboardRead` | The clipboard watcher, and reading a cell back to verify a write. |
| `clipboardWrite` | Staging a value before <kbd>Ctrl</kbd>+<kbd>V</kbd>. |
| `storage`, `unlimitedStorage` | Local state, including `.xlsx` snapshots and logo images. |
| `tabs` | Opening and tracking the push window. |
| `alarms` | The 30-second clipboard poll. |
| `contextMenus` | *Capture glossary selection* on right-click. |
| `host_permissions` | `docs.google.com` and `accounts.google.com`, for snapshot downloads and account detection. |

---

## Data, privacy and storage

Nothing is sent anywhere. The only network requests are to `docs.google.com`, to download
your own sheet, using the cookies already in your browser. There is no analytics, no
telemetry and no remote code — the bundled libraries ship inside the extension because MV3
forbids loading scripts from a CDN.

State lives in `chrome.storage.local` under these keys:

```js
templates  { id, name, logoBase64, targetPreviewUrl, mappings: { [category]: { sourceCol, targetCol, notesCol, startRow, endRow } } }
folders    { id, parentId, name, logoBase64 }
files      { id, folderId, name, logoBase64, targetLiveUrl, boundAccountEmail,
             customLinks: [{ title, url }], templateId, overriddenMappings }
queue      { id, category, source, target, notes, timestamp, lang, raw }
snapshots  { [templateId | fileId]: { b64, fetchedAt, size, ext } }   // offline .xlsx
accounts   [{ index, email }]
logs       { id, ts, level, message, … }      // newest first, capped at 2000
stats      { ts, type, fileId, folderId }     // capped at 20000
settings   { theme, monitor, closeTabAfterFill }
```

Logo images are downscaled to fit 512&nbsp;px and re-encoded as WebP before storage, so a
large upload cannot bloat every state read and ZIP export. SVGs pass through untouched.

**Account detection** works by fetching `docs.google.com/spreadsheets/u/{0..7}/` and reading
the e-mail addresses out of the returned HTML. It never sees a password and never leaves
Google's domain, but it is a heuristic — if it mislabels an account, the `/u/{n}/` index is
what actually matters.

---

## Export and import

**Export** (per file, per folder, or everything) produces a `.zip`:

```
workspace_data.json     { version: 2, exportedAt, folders, templates, files }
files/<id>.xlsx         the saved snapshot for each file and template
```

**Import** merges rather than overwrites. Existing templates and folders are left alone;
a file that already exists gains any custom links and mappings it was missing, and local
edits are never clobbered. Anything whose parent folder did not come along is re-homed to
the workspace root instead of being orphaned.

---

## Project layout

```
manifest.json        MV3 manifest
background.js        service worker: snapshots, account detection, row finding,
                     clipboard plumbing, push orchestration
sheets-driver.js     DevTools Protocol primitives: attach, readiness, cell navigation,
                     Ctrl+V / Ctrl+C, keystroke typing
shared.js            categories and aliases, schema defaults, the strict parser,
                     Levenshtein, Google URL helpers, column helpers, mapping merge
offscreen.js         clipboard read/write (the service worker has no DOM)
offscreen.html       host page for the above
dashboard.html       the full-page UI
dashboard.js         UI controller: workspace, studio, queue, stats, settings, ZIP
dashboard.css        glass/blur theme, light and dark
lib/xlsx.full.min.js SheetJS — reads .xlsx with cell styles
lib/jszip.min.js     ZIP export/import
lib/chart.umd.min.js Chart.js — stats
icon16/48/128.png    icons
```

`shared.js` is loaded by both the service worker (`importScripts`) and the dashboard, so it
must stay free of DOM access.

---

## Troubleshooting

Check **Activity log** first. Messages are written to be diagnostic.

| Message | What it means |
| --- | --- |
| `Unknown category "X"` | The label resolves to none of the 12. Add it to `CATEGORY_ALIASES` in `shared.js`, or relabel the line. |
| `Source text MISSING (Target present)` | The missing-pair rule. Fix the line and re-paste. |
| `No mapping for "X"` | That category has no columns in the template or file overrides. This is the most common reason a push adds nothing. |
| `Range Full — X has no empty row before 250` | The category's `endRow` was reached. |
| `Could not move to C3 (Sheets is on A1)` | Name Box navigation failed — usually a protected range or a different tab being active. |
| `Ctrl+V left C3 empty — switching this push to keystrokes` | Paste was blocked; the keystroke fallback took over. Writes continue. |
| `Neither Ctrl+V nor typing put anything into C3` | Both paths failed. Check that the sheet is editable by the bound account. |
| `Clipboard read-back is unavailable` | Writes proceed but cannot be verified this run. |
| `Could not control the sheet tab: no Sheets grid on that tab (it is showing "…")` | The tab is not a loaded spreadsheet — often a sign-in page. |
| `Could not control the sheet tab: Google asked this account to sign in` | Sign in to that account, or pick a different one in Settings. |
| `Sheet download failed … direct: sign-in page` | The snapshot could not be fetched. Confirm the chosen `/u/{n}/` account can open the file. |

**A push adds nothing and logs nothing.** The queue selection was empty, or no category in
the batch has a mapping. Check the checkboxes in the queue table and the template mappings.

**The push window opens but the debugger banner does not appear.** Another debugger client
is attached to that tab — close DevTools on it.

---

## Known limitations

* **Google Sheets is being automated, not called.** There is no public API in use, so the
  writer depends on observable page behaviour: the Name Box (`#t-name-box`) and the
  renderer's paste command. If Google changes either, pushes fail with a specific message in
  the Activity log rather than silently; the fix would be in `sheets-driver.js`.
* **Speed.** Each cell costs a navigation plus a paste — roughly a second or two. A term
  fills up to three cells, so a few hundred terms is a long run. Leave the dashboard open
  while it works.
* **Your clipboard is overwritten during a push,** since values are staged on it. Copy
  anything you need beforehand. The clipboard watcher is paused automatically so it cannot
  re-ingest the extension's own writes.
* **The debugger banner** appears for the duration of every push. That is Chrome's required
  disclosure for `chrome.debugger`.
* **Chromium only.** `chrome.debugger` and offscreen documents have no Firefox or Safari
  equivalent.
* **Multi-tab workbooks:** the sheet to analyse is chosen by matching the live tab's name,
  because an `.xlsx` export carries no `gid`. A workbook with two identically named tabs
  falls back to the first.
* **Values are pasted, not escaped.** A term beginning with `=` or `+` becomes a formula,
  exactly as it would if you typed it.

---

## Development

No build step, no dependencies to install — it is plain ES2020 loaded directly by Chrome.

```bash
# syntax-check everything before reloading
for f in background.js shared.js sheets-driver.js dashboard.js offscreen.js; do node --check "$f"; done
```

```powershell
# PowerShell
foreach ($f in 'background.js','shared.js','sheets-driver.js','dashboard.js','offscreen.js') { node --check $f }
```

The parser is pure and has no Chrome dependencies beyond `uid()`, which makes it easy to
exercise in isolation:

```js
const fs = require("fs");
global.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
(0, eval)(fs.readFileSync("shared.js", "utf8") + `
  const r = parseGlossaryText('* Term: - [KR] "마적" -> "Horse thieves"');
  console.log(r.valid, r.skipped);
`);
```

Debugging tips:

* **Service worker logs:** `chrome://extensions` → *Service worker* link on the extension's
  card. Note that MV3 workers are killed when idle; a push keeps it alive.
* **Dashboard logs:** F12 on the dashboard tab.
* **Verifying Sheets selectors**, if a push starts failing after a Google UI change — run
  this in the console of a sheet tab:

  ```js
  JSON.stringify({
    nameBox:    !!document.querySelector('#t-name-box'),
    cell:         document.querySelector('#t-name-box')?.value,
    formulaBar: !!document.querySelector('#t-formula-bar-input'),
    cellInput:  !!document.querySelector('.cell-input'),
    activeTab:    document.querySelector('.docs-sheet-active-tab')?.textContent?.trim()
  })
  ```

  `nameBox` and `cell` must be present for navigation to work. The others only affect
  write verification and sheet-name matching, and degrade gracefully.