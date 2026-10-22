// node tools/extract-landmarks.js <video under project root> <out.json> [fps]
// Runs the real HandLandmarker over a video in headless Edge/Chrome and writes a replayable session.
import { writeFileSync } from 'node:fs';
import { start } from './serve.js';
import { launch } from './browser.js';

const [src, out, fps = '30'] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node tools/extract-landmarks.js fixtures/sample.mp4 out.json [fps]'); process.exit(1); }
const srv = await start(8124);
const browser = await launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto('http://localhost:8124/qa/extract.html');
const session = await page.evaluate(([s, f]) => window.extract('../' + s, f), [src, Number(fps)]);
writeFileSync(out, JSON.stringify(session));
console.log(`wrote ${out}: ${session.frames.length} frames, ${session.frames.filter(f => f.hands.length).length} with hands`);
await browser.close(); srv.close();
