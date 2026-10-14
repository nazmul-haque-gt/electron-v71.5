# Update 1.2.1

* **Translate popup: hide arrow.** A new arrow (^) at the left of the popup's buttons hides all the options (Model row and the font / size / background row, plus the Aa button),
  leaving just the translated text and the chat box. Click it again (it points down while hidden) to bring them back. The choice is remembered.

# Update 1.2.0

* **Tabs in the title bar (like a browser).** The separate "PDF Editor" title strip is gone: the tab strip now sits in that space, and the Windows
  minimise / maximise / close buttons float at the right end, coloured to match the tab strip (they follow the light/dark theme). Empty space in the
  tab strip drags the window; double-click it to maximise / restore. Saves one row of screen height.
  (`main.js` titleBarStyle + titleBarOverlay, `set-titlebar-colors` IPC, `html.desktop-titlebar` CSS.)
  Checked with the real Electron 33 on a virtual screen: unit tests 32/32, tab strip and window buttons render in the title bar.

# Update 1.1.0

* `app/final.html` is now the v71 editor (v70 plus **comment names**: a Name box inside the comment toolbar, hidden by the toolbar arrow;
  hovering a pin shows its name above it; names are also stored inside the saved PDF). The desktop-app changes below were re-applied on top of it.
* **Fixed Scan text (OCR) in the desktop app:** the OCR worker was given relative file paths, which are invalid inside a worker started from a blob URL
  ("importScripts ... is invalid"). They are now absolute `app://` URLs (also in `scripts/selftest-page.js`). Found by running the real Electron `--selftest`.
* Added `package-lock.json` (real, resolved versions: electron 33.4.11, electron-builder 25.1.8) so GitHub builds are repeatable (`npm ci`).
* GitHub workflow: caches npm, runs the unit tests, builds installer + portable exe, installs the installer on the runner and checks the "Open with" registry entries,
  and on a `v*` tag publishes a GitHub Release.
* Verified here with the real Electron 33 under a virtual display: `npm test` (32 passed) and `npm run selftest` (9 of 9 checks, including offline OCR).
  The final Windows installer step (NSIS, needs Windows or Wine) could not run here; the workflow's Windows runner does it.

# What changed, and what is untested

## Replaced
| Old | New |
|---|---|
| serve.ps1 (local HTTP server, port 8743) | `main.js`: files served over the private `app://pdfeditor/` scheme (constant origin, so localStorage, fetch, workers and WebAssembly OCR work) |
| launch.vbs + PDFEditor.exe launcher + wscript | one Electron exe; single-instance lock; second launch -> new tab in the running window, window restored if minimized and raised |
| `/__openfile` + `/__savefile` + one-time keys | real file paths: native Open / Save As dialogs, Ctrl+S writes via temp file + rename into the original; only PDFs the user chose can be read/written |
| `/__poll`, `/__handoff`, `/__front` | Electron `second-instance` + IPC |
| `/__img` image proxy | `lib/imageProxy.js`: same rules (http/https, public addresses only, checked on every redirect and at connect time, 6 redirects, 15 s, image/* only, 15 MB) |
| `/__open` (open attachment) | IPC -> temp file -> `shell.openPath` |
| download-vendor-files.ps1 (CDN download at install) | npm packages copied into `app/vendor/` at build time; the installer contains everything |
| install.bat/ps1, uninstall.*, IExpress | electron-builder NSIS installer + portable exe; `build/installer.nsh` registers Open with / Default-apps capability exactly as install.ps1 did |
| Edge `--app` flags | window opens maximized; background throttling / occlusion switches kept so Scan text keeps running behind other windows |

## Changes inside final.html (only these, 5 places)
1. `<script src="electron-bridge.js">` added (gives the app the same `showOpenFilePicker` / `showSaveFilePicker` / drop-handle API it used in Edge, backed by native dialogs and real paths).
2. `isLocalServer()` now means "running in the desktop app" (shows Open instead of Download for attachments).
3. `openLocally()` (attachments) calls the desktop app instead of `/__open`.
4. Pasted-figure downloader calls the desktop app instead of `/__img`.
5. The "Open with" token/polling block is replaced by "desktop app hands over a file path".
Everything else is byte-for-byte unchanged. localStorage keys, the `name|size` tab key, and the PDF save format are untouched.

## Behaviour differences you may notice
* **Settings do not carry over automatically** (different browser profile). See the migration steps in README.
* Closing the window with unsaved changes shows a native "You have unsaved changes - Leave / Stay" box (Edge showed its own generic prompt).
* Attachments of program types (.exe .bat .cmd .ps1 .vbs .js .msi .scr .lnk .jar etc.) are no longer launched from "Open" (the old server would launch anything). Change `BLOCKED_EXT` in `lib/fileio.js` if you disagree.
* Direct fetches from the page are limited by a Content-Security-Policy to the app itself, Google's Gemini API and Google Fonts; remote pictures pasted into comments therefore always go through the desktop downloader.
* Right-click in text boxes shows an Edit menu with spelling suggestions (Electron has no default one). Ctrl+/- / Ctrl+0 browser zoom, F5/Ctrl+R reload and F12 dev tools are re-added.
* The UI fonts (Instrument Sans, Newsreader) are still requested from Google Fonts as before, with system-font fallback offline. Not a function dependency; to make it 100% offline, bundle those two fonts and edit the `<link>` on line 14 of `final.html`.

## Tested (here, Linux, headless Chromium + Node 22; `npm test`, `npm run test:e2e`)
* 32 unit tests: atomic write, refusal of non-PDF data, locked/failed write cleanup, argv parsing, path-traversal guard, MIME (wasm), image downloader (redirects, loops, size, non-image, private/loopback/link-local refusal), and the real `main.js` on a mocked Electron: single-instance lock, queueing until the page is ready, second launch -> new tab / same tab / restore+raise, IPC permission gating (other senders, un-chosen paths), Save As path, drop grant, attachment rules, unsaved-close dialog, permission handler, app:// responses + CSP, settings import.
* 19 browser flows with the shipped `final.html`, `electron-bridge.js`, CSP and `main.js`: open from command line, second launch (new tab, already-open tab), Open button, comment add -> dirty state -> Ctrl+S in place -> file re-checked with pikepdf and pypdf (valid, comment present) -> reopen shows the pin, unsaved-comment blocking (tab switch, tab close, Esc, window close), Ctrl+Shift+S then Ctrl+S goes to the new file and not the original, cancelled dialogs, tab drag reorder, drag-and-drop with in-place save, non-PDF drop, attachment open, pasted web figure embedded through the downloader, closing all tabs, no requests leaving the app, no CSP violations.

## NOT tested (could not be, in this sandbox: no Windows, no Electron binary, no internet)
* **Electron itself and electron-builder / NSIS**: nothing was built or launched. `package.json` build config, `build/installer.nsh`, the app:// scheme registration, preload/contextBridge (incl. `webUtils.getPathForFile` for drops and Uint8Array over IPC), `will-prevent-unload`, window maximize/raise (`setAlwaysOnTop` trick), taskbar identity/pinning, "Open with" registration, installer/uninstaller, portable exe. Package versions (`electron ^33.2.1`, `electron-builder ^25.1.8`, pinned libs) are from memory; no lock file was generated.
* **The shipped pdf.js 3.11.174, tesseract.js, OCR/Scan text, pdf rendering fidelity**: not available offline here. Browser tests used pdfjs-dist 5.x wrapped as a v3 stand-in. `npm run selftest` on your PC checks real pdf.js, pdf-lib and offline OCR in 10 s. Run it first.
* Real Windows file locking (Acrobat holding a file) - simulated only as a failed write; Windows rename-over-open-file semantics are untested.
* Translate/AI (needs your key + internet), highlight/draw/text-tool visuals, Lock - their code is unchanged and not re-verified.
* Drag/drop of an actual Explorer file (synthetic drop used), clipboard permissions in Electron, spell-check menu.
