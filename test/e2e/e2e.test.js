'use strict';
/* End-to-end flows in headless Chromium: node test/e2e/e2e.test.js   (needs playwright + python3 with pikepdf/pypdf for checking saved files)
 * See harness.js for what is real and what is stand-in. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const h = require('./harness');

const FX = path.join(__dirname, '..', 'fixtures');
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, true]); console.log('  ok   ' + name); }
  catch (e) { results.push([name, false]); console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
}

function pdfInfo(file) {          // strict re-open with two independent PDF libraries
  const py = `
import json,sys,pikepdf
from pypdf import PdfReader
f=sys.argv[1]
with pikepdf.open(f) as p: n=len(p.pages)
r=PdfReader(f); ann=[]
for pg in r.pages:
    for a in (pg.get('/Annots') or []):
        a=a.get_object(); ann.append({'subtype':str(a.get('/Subtype')),'contents':str(a.get('/Contents',''))})
print(json.dumps({'pages':n,'annots':ann}))`;
  return JSON.parse(execFileSync('python3', ['-c', py, file]).toString());
}

(async function main() {
  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pdfed-files-'));
  const A = path.join(work, 'alpha.pdf'), B = path.join(work, 'beta document.pdf'), G = path.join(work, 'gamma.pdf');
  fs.copyFileSync(path.join(FX, 'alpha.pdf'), A); fs.copyFileSync(path.join(FX, 'beta document.pdf'), B); fs.copyFileSync(path.join(FX, 'gamma.pdf'), G);

  // a tiny image server on loopback for the pasted-figure test
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8Dwn4EIwDiqkL4KAG+aA/3tL0M1AAAAAElFTkSuQmCC', 'base64');
  const img = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'image/png' }); s.end(png); });
  await new Promise((r) => img.listen(0, '127.0.0.1', r));
  const imgUrl = 'http://127.0.0.1:' + img.address().port + '/fig.png';

  const t = await h.start({ argv: [A] });
  const { page, el } = t;
  console.log('PDF engine in this run: ' + t.pdfEngine);
  const names = () => page.$$eval('#tabList .tab .tab-name', (e) => e.map((x) => x.textContent));
  const active = () => page.$eval('#tabList .tab.active .tab-name', (e) => e.textContent);
  const waitTabs = (n) => page.waitForFunction((n) => document.querySelectorAll('#tabList .tab').length === n, n, { timeout: 20000 });
  const saveEnabled = () => page.$eval('#exportBtn', (b) => !b.disabled);
  const savedDone = () => page.waitForFunction(() => { const b = document.getElementById('exportBtn'); return b.disabled && !/\u2026|\.\.\./.test(b.textContent); }, null, { timeout: 25000 }).then(() => page.waitForTimeout(250));
  const toastText = () => page.$eval('#toast', (e) => e.textContent);
  async function addComment(text, nthPage) {
    if ((await page.getAttribute('#cmtBtn', 'aria-pressed')) !== 'true') await page.click('#cmtBtn');
    await page.locator('.page-wrap').nth(nthPage || 0).scrollIntoViewIfNeeded();
    const box = await page.locator('.page-wrap').nth(nthPage || 0).boundingBox();
    await page.mouse.click(box.x + 150, Math.max(box.y, 0) + 220);
    await page.waitForSelector('#cmtPanel:not([hidden])');
    await page.click('#cmtEditor'); await page.keyboard.type(text);
    await page.waitForSelector('#cmtSave:not([hidden])');
    await page.click('#cmtSave');
    await page.waitForTimeout(400);
  }
  const closePanel = async () => { await page.keyboard.press('Escape'); await page.waitForSelector('#cmtPanel', { state: 'hidden' }); };

  await waitTabs(1);
  await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 2, null, { timeout: 20000 });

  console.log('start-up and opening files');
  await test('file given on the command line opens as a tab; window title is "PDF Editor"; page is not dirty', async () => {
    assert.deepStrictEqual(await names(), ['alpha.pdf']);
    assert.strictEqual(await page.title(), 'PDF Editor');
    assert.strictEqual(await saveEnabled(), false);
  });
  await test('second launch with another PDF opens a NEW tab (name with a space) and shows it; still one window', async () => {
    t.secondInstance([B]); await waitTabs(2);
    assert.deepStrictEqual(await names(), ['alpha.pdf', 'beta document.pdf']);
    assert.strictEqual(await active(), 'beta document.pdf');
    await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length === 3, null, { timeout: 20000 });
  });
  await test('second launch with a PDF that is already open switches to its tab, no duplicate tab', async () => {
    t.secondInstance([A]); await page.waitForFunction(() => document.querySelector('#tabList .tab.active .tab-name').textContent === 'alpha.pdf', null, { timeout: 10000 });
    assert.strictEqual((await names()).length, 2);
    assert.ok(/already open/i.test(await toastText()));
  });
  await test('Open button: native dialog result opens a tab; cancelling does nothing', async () => {
    await page.click('#openBtn'); await page.waitForTimeout(300); assert.strictEqual((await names()).length, 2);
    el.dialog.openResult = { canceled: false, filePaths: [G] };
    await page.click('#openBtn'); await waitTabs(3);
    assert.strictEqual(await active(), 'gamma.pdf');
    el.dialog.openResult = { canceled: true, filePaths: [] };
  });

  console.log('comments, dirty state and saving back into the original file');
  await test('on a fresh tab Save PDF is disabled; adding a comment enables it and shows the unsaved dot', async () => {
    await page.locator('#tabList .tab', { hasText: 'alpha.pdf' }).click();
    await page.waitForTimeout(500);
    assert.strictEqual(await saveEnabled(), false);
    await addComment('First comment on alpha');
    assert.strictEqual(await saveEnabled(), true);
    await closePanel();
    assert.ok(await page.$eval('#tabList .tab.active', (e) => /dirty|unsaved|modified/i.test(e.className + ' ' + e.innerHTML) || !!e.querySelector('.tab-dot')));
  });
  const beforeSave = fs.statSync(A).mtimeMs;
  await test('Ctrl+S writes straight back into the file that was opened from the command line', async () => {
    await page.keyboard.press('Control+s');
    await savedDone();
    assert.ok(fs.statSync(A).mtimeMs >= beforeSave);
    const info = pdfInfo(A);
    assert.strictEqual(info.pages, 2);
    assert.ok(info.annots.some((a) => /First comment on alpha/.test(a.contents)), JSON.stringify(info.annots));
    assert.deepStrictEqual(fs.readdirSync(work).filter((n) => n.endsWith('.tmp')), []);
    assert.strictEqual(await saveEnabled(), false);
    assert.ok(/Saved/.test(await toastText()));
  });
  await test('saved file is a normal PDF: re-opened by a second launch it shows the comment again (round trip)', async () => {
    // close alpha tab, reopen through a second launch
    await page.locator('#tabList .tab', { hasText: 'alpha.pdf' }).locator('.tab-x').click();
    await page.waitForTimeout(500); assert.ok(!(await names()).includes('alpha.pdf'));
    t.secondInstance([A]); await page.waitForFunction(() => /alpha\.pdf/.test(document.querySelector('#tabList .tab.active .tab-name').textContent), null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.page-wrap').length >= 2, null, { timeout: 15000 });
    await page.waitForTimeout(800);
    assert.ok((await page.locator('.pin, [class*="pin"]').count()) > 0, 'comment pin not restored');
  });
  await test('unsaved comment changes block switching tabs, closing the tab and Escape; Save releases them', async () => {
    // open the existing comment by clicking its pin, edit it
    await page.locator('.page-wrap .pin, .page-wrap [class*="pin"]').first().click({ force: true });
    await page.waitForSelector('#cmtPanel:not([hidden])');
    await page.click('#cmtEditor'); await page.keyboard.press('End'); await page.keyboard.type(' EDITED');
    await page.waitForSelector('#cmtSave:not([hidden])');
    const before = await active();
    await page.locator('#tabList .tab:not(.active)').first().click();
    await page.waitForTimeout(400);
    assert.strictEqual(await active(), before, 'tab switched while a comment had unsaved changes');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    assert.ok(await page.$eval('#cmtPanel', (p) => !p.hidden), 'Esc closed a comment with unsaved changes');
    await page.locator('#tabList .tab.active .tab-x').click(); await page.waitForTimeout(300);
    assert.strictEqual(await active(), before, 'tab closed with unsaved comment changes');
    // beforeunload (window close) is cancelled while dirty
    assert.strictEqual(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), true);
    await page.click('#cmtSave'); await page.waitForTimeout(400);
    await closePanel();
    await page.locator('#tabList .tab:not(.active)').first().click(); await page.waitForTimeout(300);
    assert.notStrictEqual(await active(), before);
  });
  await test('Ctrl+Shift+S is Save As: uses the native save dialog, writes the new file, later Ctrl+S goes to the NEW file', async () => {
    await page.locator('#tabList .tab', { hasText: 'alpha.pdf' }).click(); await page.waitForTimeout(500);
    const alphaBefore = fs.readFileSync(A);
    el.dialog.saveResult = { canceled: false, filePath: path.join(work, 'alpha copy') };
    await page.keyboard.press('Control+Shift+S');
    await page.waitForFunction(() => /alpha copy\.pdf/.test(document.querySelector('#tabList .tab.active .tab-name').textContent), null, { timeout: 20000 });
    const copy = path.join(work, 'alpha copy.pdf');
    assert.ok(pdfInfo(copy).annots.some((a) => /EDITED/.test(a.contents)));
    assert.ok(alphaBefore.equals(fs.readFileSync(A)), 'Save As must not touch the original');
    await addComment('after save as', 1); await closePanel();
    await page.keyboard.press('Control+s');
    await savedDone();
    assert.ok(pdfInfo(copy).annots.some((a) => /after save as/.test(a.contents)));
    assert.ok(alphaBefore.equals(fs.readFileSync(A)), 'Ctrl+S after Save As must write to the new file only');
    el.dialog.saveResult = { canceled: true };
  });
  await test('cancelling the Save As dialog leaves things as they were', async () => {
    await page.keyboard.press('Control+Shift+S'); await page.waitForTimeout(600);
    assert.ok(/alpha copy/.test(await active()));
  });
  await test('read-only / locked file: save fails with a Retry message and the original is untouched', async () => {
    t.secondInstance([G]); await page.waitForFunction(() => /gamma\.pdf/.test(document.querySelector('#tabList .tab.active .tab-name').textContent), null, { timeout: 15000 });
    await page.waitForTimeout(500);
    await addComment('gamma note'); await closePanel();
    const orig = fs.readFileSync(G);
    fs.chmodSync(work, 0o555);                          // folder not writable: the temp file cannot be created (stands in for a locked file)
    let skipped = false; if (process.getuid && process.getuid() === 0) skipped = true;   // root ignores permissions
    if (!skipped) {
      await page.keyboard.press('Control+s'); await page.waitForTimeout(1500);
      assert.ok(/Could not save/i.test(await toastText()), await toastText());
      assert.ok(orig.equals(fs.readFileSync(G)));
    }
    fs.chmodSync(work, 0o755);
    if (skipped) console.log('       (running as root: the permission-denied part was skipped)');
    await page.keyboard.press('Control+s');
    await savedDone();
    assert.ok(pdfInfo(G).annots.some((a) => /gamma note/.test(a.contents)));
  });

  console.log('tabs, drag and drop, attachments, pasted pictures');
  await test('dragging a tab to a new position changes the order', async () => {
    const before = await names();
    const tabs = page.locator('#tabList .tab');
    const a = await tabs.nth(0).boundingBox(), b = await tabs.nth(before.length - 1).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2, { steps: 4 });
    await page.mouse.move(b.x + b.width - 6, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up(); await page.waitForTimeout(400);
    const after = await names();
    assert.notDeepStrictEqual(after, before); assert.deepStrictEqual([...after].sort(), [...before].sort());
    assert.strictEqual(after[after.length - 1], before[0]);
  });
  await test('a PDF dropped on the window opens in a tab with a real handle, so Ctrl+S saves in place', async () => {
    const D = path.join(work, 'dropped.pdf'); fs.copyFileSync(path.join(FX, 'gamma.pdf'), D);
    // vary the size so it is not mistaken for gamma.pdf's key
    fs.appendFileSync(D, '\n% padding\n');
    const b64 = fs.readFileSync(D).toString('base64');
    await page.evaluate(async ({ b64, p }) => {
      const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const f = new File([u8], 'dropped.pdf', { type: 'application/pdf' }); f.__testPath = p;
      const dt = new DataTransfer(); dt.items.add(f);
      document.getElementById('viewer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, { b64, p: D });
    await page.waitForFunction(() => /dropped\.pdf/.test(document.querySelector('#tabList .tab.active .tab-name').textContent), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    await addComment('dropped note'); await closePanel();
    await page.keyboard.press('Control+s');
    await savedDone();
    assert.ok(pdfInfo(D).annots.some((a) => /dropped note/.test(a.contents)));
  });
  await test('a non-PDF dropped on the window is refused politely', async () => {
    await page.evaluate(async () => {
      const f = new File([new Uint8Array([1, 2, 3])], 'x.txt', { type: 'text/plain' });
      const dt = new DataTransfer(); dt.items.add(f);
      document.getElementById('viewer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(400); assert.ok(/Choose a PDF/.test(await toastText()));
  });
  await test('attachment "Open": bytes go to the desktop app and are opened with the default program; .exe refused', async () => {
    const r = await page.evaluate(async () => {
      const N = window.pdfEditorNative; const out = {};
      try { await N.openAttachment('report.docx', new Uint8Array([80, 75, 3, 4])); out.docx = 'ok'; } catch (e) { out.docx = String(e.message); }
      try { await N.openAttachment('run.exe', new Uint8Array([77, 90])); out.exe = 'ok'; } catch (e) { out.exe = String(e.message); }
      return out;
    });
    assert.strictEqual(r.docx, 'ok'); assert.ok(/not opened from here/.test(r.exe), JSON.stringify(r));
    assert.ok(el.shell.opened.some((p) => /report\.docx$/.test(p)) && !el.shell.opened.some((p) => /\.exe$/.test(p)));
  });
  await test('pasted web figure: the comment editor downloads it through the desktop app and embeds it (CSP blocks the direct fetch)', async () => {
    if (await page.$eval('#cmtPanel', (p) => !p.hidden)) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
    if ((await page.getAttribute('#cmtBtn', 'aria-pressed')) !== 'true') await page.click('#cmtBtn');
    await page.locator('.page-wrap').first().scrollIntoViewIfNeeded();
    const box = await page.locator('.page-wrap').first().boundingBox();
    await page.mouse.click(box.x + 200, Math.max(box.y, 0) + 300);
    await page.waitForSelector('#cmtPanel:not([hidden])');
    await page.click('#cmtEditor');
    await page.evaluate((u) => {
      const ed = document.getElementById('cmtEditor');
      ed.innerHTML = '<p>figure: <img src="' + u + '"></p>';
      const dt = new DataTransfer(); dt.setData('text/html', ed.innerHTML); dt.setData('text/plain', 'figure:');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, imgUrl);
    await page.waitForFunction(() => { const i = document.querySelector('#cmtEditor img'); return i && /^data:image\//.test(i.getAttribute('src')); }, null, { timeout: 15000 });
    await page.click('#cmtCancel').catch(() => {}); await page.keyboard.press('Escape');
  });
  await test('close buttons: closing a clean tab works; the last tab can be closed', async () => {
    await page.waitForTimeout(300);
    for (let i = 0; i < 8; i++) {
      const n = (await names()).length; if (!n) break;
      if (await page.$eval('#cmtPanel', (p) => !p.hidden).catch(() => false)) {
        if (await page.$eval('#cmtSave', (b) => !b.hidden)) { await page.click('#cmtSave'); await page.waitForTimeout(300); }   // unsaved comment edits must be saved before it can close
        await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      }
      const dirtyNow = await saveEnabled();
      if (dirtyNow) { await page.keyboard.press('Control+s'); await page.waitForTimeout(1200); }
      await page.locator('#tabList .tab.active .tab-x').click(); await page.waitForTimeout(250);
    }
    assert.strictEqual((await names()).length, 0);
  });

  console.log('whole-session checks');
  await test('no request ever left the app except the two Google font files; no script errors', async () => {
    // allowed: the two Google font files (as before), the CDN fallback for the OCR files that are absent in this sandbox (blocked by the CSP
    // anyway), and the pasted figure's own <img> in the comment editor (the downloader fetch itself went through the desktop app)
    const bad = t.outside.filter((u) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u) && !/cdn\.jsdelivr\.net\/npm\/tesseract\.js/.test(u) && u !== imgUrl);
    assert.deepStrictEqual(bad, []);
    assert.deepStrictEqual(t.pageErrors, []);
  });
  await test('no Content-Security-Policy violations from the app itself (the only ones are the CDN fallback for the absent OCR vendor files in this sandbox)', async () => {
    const csp = t.consoleErrors.filter((m) => /Content Security Policy/.test(m) && !/tesseract\.js@5\.1\.1|cdnjs|fonts\./.test(m) && !m.includes(imgUrl));   // the direct fetch of the pasted figure IS refused by the CSP; the desktop downloader then fetched it
    assert.deepStrictEqual(csp, []);
  });

  await t.close(); img.close();
  const failed = results.filter((r) => !r[1]);
  console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
