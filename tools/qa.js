// Visual QA: renders every effect (a still frame + a 4-frame motion strip) in headless Edge/Chrome and writes qa/*.png.
//   node tools/qa.js [--effects 1,2,3] [--still 1.0] [--src fixtures/sample.mp4] [--only still|strip] [--port 8125]
// Software WebGL is slow: judge looks, not fps.
import { mkdirSync, writeFileSync } from 'node:fs';
import { start } from './serve.js';
import { launch } from './browser.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port', 8125));
const effects = (arg('effects', '1,2,3,4,5,6,7,8,9,10,11,12')).split(',').map(Number);
const still = arg('still', '1.0'), src = arg('src', 'fixtures/sample.mp4'), only = arg('only', '');
const extra = arg('extra', '');   // extra url params, e.g. "under=10"
const size = arg('size', '1280x720').split('x').map(Number);
mkdirSync('qa', { recursive: true });
const srv = await start(port);
const browser = await launch();
const results = [];
for (const n of effects) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const shot = async name => { await page.locator('#c').screenshot({ path: `qa/${name}.png` }); };
  try {
    if (only !== 'strip') {
      await page.goto(`http://localhost:${port}/index.html?effect=${n}&still=${still}&qa=1&src=${src}${extra ? '&' + extra : ''}`);
      await page.waitForFunction(() => window.__pinchbox && window.__pinchbox.qa && window.__pinchbox.qa.ready, null, { timeout: 180000 });
      await shot(`fx${String(n).padStart(2, '0')}-still`);
    }
    if (only !== 'still') {
      await page.goto(`http://localhost:${port}/index.html?effect=${n}&qa=1&src=${src}${extra ? '&' + extra : ''}`);
      await page.waitForFunction(() => window.__pinchbox && window.__pinchbox.qa && window.__pinchbox.qa.ready, null, { timeout: 180000 });
      for (let i = 0; i < 4; i++) { await shot(`fx${String(n).padStart(2, '0')}-strip${i}`); await page.waitForTimeout(650); }
    }
    results.push({ n, errors });
  } catch (e) { results.push({ n, errors: [...errors, 'QA failure: ' + e.message] }); }
  await page.close();
}
await browser.close(); srv.close();
for (const r of results) console.log(`effect ${r.n}: ${r.errors.length ? 'ERRORS\n  ' + r.errors.slice(0, 6).join('\n  ') : 'ok (no console errors)'}`);
writeFileSync('qa/last-run.json', JSON.stringify(results, null, 1));
