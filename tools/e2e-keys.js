// Drives the keyboard features in a real page: calibration (C), recording (R + M) -> download -> replay, undo, no-camera message.
import { start } from './serve.js';
import { launch } from './browser.js';
import { readFileSync } from 'node:fs';
import { analyze } from '../tools/replay.js';

const srv = await start(8133);
const browser = await launch();
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8133/index.html?src=fixtures/sample.mp4&track=0');
await page.waitForFunction(() => window.__pinchbox && window.__pinchbox.ready);

// --- calibration: feed synthetic frames in real time (open hand 1.6 s, then firm pinch) ---
await page.keyboard.press('c');
const cal = await page.evaluate(async () => {
  const { detection } = await import('/src/synthSession.js'); const { makeRng } = await import('/src/synthHand.js');
  const a = window.__pinchbox, rng = makeRng(3), t0 = performance.now(); let k = 0;
  const msgs = new Set();
  while (performance.now() - t0 < 3400) {
    const el = (performance.now() - t0) / 1000, o = el < 1.6 ? 1 : 0.04;
    const d = detection({ sx: 600, sy: 400, S: 100, o, flip: false, W: 1280, H: 720, noise: 0.8, world: 0.001, rng, score: 0.9 });
    a.onResult({ t: performance.now(), w: 1280, h: 720, inferMs: 12, hands: [{ ...d, lm: Float32Array.from(d.lm), world: Float32Array.from(d.world) }] });
    msgs.add(document.querySelector('.hud-msg').textContent);
    await new Promise(r => setTimeout(r, 33)); k++;
  }
  await new Promise(r => setTimeout(r, 400));
  return { result: a.calibrator.result, msgs: [...msgs], rOn: a.gesture.rOn, rOff: a.gesture.rOff, saved: localStorage.getItem('pinchbox.calibration') };
});
console.log('calibration', JSON.stringify(cal));
ok(cal.result && cal.result.rOpen > 1.3 && cal.result.rClosed < 0.1, 'calibration measured open ~1.49 and closed ~0.0');
ok(Math.abs(cal.rOn - (cal.result.rClosed + 0.25 * (cal.result.rOpen - cal.result.rClosed))) < 1e-6, 'thresholds derived from calibration');
ok(!!cal.saved, 'calibration persisted to localStorage');
ok(cal.msgs.some(m => /OPEN/i.test(m)) && cal.msgs.some(m => /PINCH/i.test(m)), 'prompted open then pinch');

// --- recording: R, feed a synthetic two-hand session with M marks, R -> JSON download -> replay in Node ---
await page.keyboard.press('r');
await page.evaluate(async () => {
  const { makeSession, toFloat } = await import('/src/synthSession.js');
  const s = makeSession({ W: 1280, H: 720, attempts: 3, seed: 21, startMs: 0 });
  const fr = toFloat(s.frames), a = window.__pinchbox, base = performance.now() - fr[0].t;
  window.__truth = s.truth.locks.map(l => l.t0 + base);
  for (const f of fr) { a.onResult({ ...f, t: base + f.t }); }
  window.__marks = [];
});
await page.evaluate(() => { for (const t of window.__truth) window.__pinchbox.hud && 0; });
for (let i = 0; i < 3; i++) await page.keyboard.press('m'); // marks (times are "now": recorded as marks)
const dl = page.waitForEvent('download');
await page.keyboard.press('r');
const file = await (await dl).path();
const rec = JSON.parse(readFileSync(file, 'utf8'));
ok(rec.frames.length > 300 && Array.isArray(rec.marks) && rec.marks.length === 3, `recording has ${rec.frames.length} frames and ${rec.marks.length} marks`);
const rep = analyze({ frames: rec.frames });
ok(rep.locks.length === 3, `replay of the recording found ${rep.locks.length} locks (expected 3)`);

// --- undo / clear ---
const before = await page.evaluate(() => window.__pinchbox.gesture.boxes.length);
await page.keyboard.press('u');
ok((await page.evaluate(() => window.__pinchbox.gesture.boxes.length)) === Math.max(0, before - 1), 'U removes the last box');
await page.keyboard.press('Escape');
ok((await page.evaluate(() => window.__pinchbox.gesture.boxes.length)) === 0, 'Esc clears all boxes');
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors[0] : ''));
await page.close();

// --- no camera: friendly message (headless has no webcam) ---
const p2 = await browser.newPage({ viewport: { width: 1000, height: 600 } });
await p2.goto('http://localhost:8133/index.html');
await p2.waitForSelector('.hud-msg:not([hidden])', { timeout: 20000 });
const msg = await p2.locator('.hud-msg').textContent();
console.log('no-camera message:', msg);
ok(/camera/i.test(msg), 'visible plain message when no camera is available');
await browser.close(); srv.close();
