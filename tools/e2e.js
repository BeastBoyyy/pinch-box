// End-to-end smoke: synthetic hands (?fake=1) drive the real pipeline in headless Edge/Chrome; checks locks, stacking, undo, errors.
//   node tools/e2e.js [--locks 3] [--port 8126]
import { start } from './serve.js';
import { launch } from './browser.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const want = Number(arg('locks', 3)), port = Number(arg('port', 8126));
const srv = await start(port);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto(`http://localhost:${port}/index.html?fake=1&debug=1`);
await page.waitForFunction(() => window.__pinchbox && window.__pinchbox.ready, null, { timeout: 60000 });
let shots = 0, lastN = -1;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  const st = await page.evaluate(() => { const a = window.__pinchbox; return { n: a.gesture.boxes.length, live: a.gesture.live.visible, state: a.gesture.state, count: a.gesture.count, fps: a.renderer.stats.renderFps }; });
  if (st.n !== lastN) { lastN = st.n; await page.waitForTimeout(500); await page.screenshot({ path: `qa/e2e-${String(shots++).padStart(2, '0')}-boxes${st.n}.png` }); console.log('boxes', st.n, 'state', st.state, 'render fps', st.fps.toFixed(1)); }
  if (st.n >= want) break;
  await page.waitForTimeout(400);
}
const hud = await page.evaluate(() => document.querySelector('.hud-line').textContent);
console.log('HUD:', hud);
await page.keyboard.press('u'); await page.waitForTimeout(800);
console.log('after undo boxes', await page.evaluate(() => window.__pinchbox.gesture.boxes.length));
await page.keyboard.press('Escape'); await page.waitForTimeout(800);
console.log('after clear boxes', await page.evaluate(() => window.__pinchbox.gesture.boxes.length), 'runtime list', await page.evaluate(() => window.__pinchbox.pipeline.list.length));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close(); srv.close();
process.exit(errors.length ? 1 : 0);
