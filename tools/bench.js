// Per-effect render cost with the governor disabled: GPU time (EXT_disjoint_timer_query) and display fps, plus all 12 stacked.
//   node tools/bench.js [--size 1280x720] [--frames 150]
import { start } from './serve.js';
import { launch } from './browser.js';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const size = arg('size', '1280x720').split('x').map(Number), frames = Number(arg('frames', 150)), port = 8127;
const srv = await start(port);
const browser = await launch();
const rows = [];
const gpuName = async page => page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
let gpu = '';
async function measure(url, label) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.__pinchbox && window.__pinchbox.qa && window.__pinchbox.qa.ready, null, { timeout: 120000 });
  gpu ||= await gpuName(page);
  await page.waitForTimeout(1500); // settle (shader compile, first allocations)
  const r = await page.evaluate(n => new Promise(res => {
    const a = window.__pinchbox, gpuS = [], dts = []; let last = performance.now(), k = 0;
    const tick = () => { const now = performance.now(); dts.push(now - last); last = now; if (a.renderer.gpuSample) { gpuS.push(a.renderer.stats.gpuMs); a.renderer.gpuSample = false; }
      if (++k < n) requestAnimationFrame(tick); else res({ gpuS, dts }); };
    requestAnimationFrame(tick);
  }), frames);
  await page.close();
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const p95 = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] : NaN; };
  rows.push({ label, gpuMedian: med(r.gpuS), gpuP95: p95(r.gpuS), frameMedian: med(r.dts), frameP95: p95(r.dts), errors: errs.length });
  console.log(label.padEnd(28), `gpu median ${med(r.gpuS).toFixed(2)} ms  p95 ${p95(r.gpuS).toFixed(2)} ms | frame median ${med(r.dts).toFixed(1)} ms  p95 ${p95(r.dts).toFixed(1)} ms${errs.length ? '  ERRORS ' + errs[0] : ''}`);
}
await measure(`http://localhost:${port}/index.html?effect=1&gov=0&qa=1&src=fixtures/sample.mp4&under=`, 'baseline (edge, ref only)');
const names = ['Edge sketch', 'Slit-scan', 'Moire', 'Pixel sort', 'Frosted glass', 'Data-mosh', 'CRT', 'Depth map', 'Point cloud', 'Quadtree', 'Cyanotype', 'Posterize+split'];
for (let n = 1; n <= 12; n++) await measure(`http://localhost:${port}/index.html?effect=${n}&gov=0&qa=1&src=fixtures/sample.mp4`, `${n}. ${names[n - 1]}`);
await measure(`http://localhost:${port}/index.html?effect=12&under=1,2,3,4,5,6,7,8,9,10,11&gov=0&qa=1&src=fixtures/sample.mp4`, 'all 12 stacked');
await browser.close(); srv.close();
writeFileSync('qa/bench.json', JSON.stringify({ gpu, size, frames, rows }, null, 1));
console.log('GPU:', gpu);
