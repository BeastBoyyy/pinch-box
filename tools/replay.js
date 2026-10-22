// Headless replay: recorded (or synthetic) tracker output -> handTrack -> gesture, with section-9 metrics.
//   node tools/replay.js session.json [--cal ro,rc]
//   node tools/replay.js --synthetic [attempts] [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { HandTracker } from '../src/handTrack.js';
import { GestureEngine } from '../src/gesture.js';
import { makeSession, toFloat } from '../src/synthSession.js';

const mean = a => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : NaN);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((p, c) => p + (c - m) ** 2, 0) / a.length); };
/** std dev after removing a linear trend, so slow drift of a "still" hand does not count as jitter */
const detrendedSd = ys => {
  const n = ys.length, mx = (n - 1) / 2, my = mean(ys);
  let sxy = 0, sxx = 0; ys.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) ** 2; });
  const k = sxx ? sxy / sxx : 0;
  return sd(ys.map((y, i) => y - (my + k * (i - mx))));
};

export function analyze(session, { tracker = {}, gesture = {}, thresholds = null } = {}) {
  const frames = toFloat(session.frames);
  const tr = new HandTracker(tracker), g = new GestureEngine(gesture);
  if (thresholds) g.setThresholds(thresholds);
  const locks = [];
  const seg = { L: [], R: [] };
  const slotId = { L: null, R: null };
  let idSwitches = 0;
  for (const fr of frames) {
    const f = tr.update(fr);
    for (const e of g.update(f)) if (e.type === 'lock') locks.push({ t: fr.t, rect: e.box.rect });
    for (const k of ['L', 'R']) {
      const t = f[k];
      if (!t || !t.confirmed) continue;
      // a slot changing id while the old track is still alive is an identity switch
      if (slotId[k] !== null && slotId[k] !== t.id && f.tracks.some(x => x.id === slotId[k])) idSwitches++;
      slotId[k] = t.id;
      seg[k].push({ t: fr.t, x4: t.lm[12], y4: t.lm[13], x8: t.lm[24], y8: t.lm[25], rx8: t.raw[24], ry8: t.raw[25],
        rx4: t.raw[12], ry4: t.raw[13], S: t.S, id: t.id, held: t.gates.reason !== '' || t.coasting });
    }
  }
  // still segments: >=15 consecutive samples of one track with both fingertips moving < 12 px/s over 5 frames
  const stillStats = [];
  for (const k of ['L', 'R']) {
    const a = seg[k]; let run = [];
    const flush = () => {
      if (run.length >= 15) {
        const S = mean(run.map(r => r.S));
        const j = f => Math.max(detrendedSd(run.map(r => r[f + 'x8'])), detrendedSd(run.map(r => r[f + 'y8'])), detrendedSd(run.map(r => r[f + 'x4'])), detrendedSd(run.map(r => r[f + 'y4'])));
        stillStats.push({ S, filtPx: j(''), rawPx: j('r') });
      }
      run = [];
    };
    for (let i = 0; i < a.length; i++) {
      const p = a[i], q = a[i - 5];
      const dt = q ? (p.t - q.t) / 1000 : 1;
      const still = q && q.id === p.id && !p.held && Math.hypot(p.x8 - q.x8, p.y8 - q.y8) / dt < 12 && Math.hypot(p.x4 - q.x4, p.y4 - q.y4) / dt < 12;
      if (still && (!run.length || run[run.length - 1].id === p.id)) run.push(p); else { flush(); if (still) run.push(p); }
    }
    flush();
  }
  const jitter = {
    segments: stillStats.length,
    filteredPx: mean(stillStats.map(s => s.filtPx)), rawPx: mean(stillStats.map(s => s.rawPx)),
    filteredInS: mean(stillStats.map(s => s.filtPx / s.S)), maxFilteredPx: Math.max(0, ...stillStats.map(s => s.filtPx)),
  };

  // lock accuracy against ground truth (synthetic "truth", or "marks" pressed with M while recording)
  let truth = session.truth;
  if (!truth && session.marks) truth = { locks: session.marks.map(m => ({ t0: m - 1500, t1: m + 300 })), noLocks: [] };
  const acc = { locks: locks.length };
  if (truth) {
    const used = new Set(); let tp = 0, missed = 0;
    const windows = truth.locks.map(w => ({ ...w }));
    for (const w of windows) {
      const i = locks.findIndex((l, j) => !used.has(j) && l.t >= w.t0 && l.t <= w.t1);
      if (i >= 0) { used.add(i); tp++; w.hit = locks[i]; } else missed++;
    }
    Object.assign(acc, { truthLocks: windows.length, matched: tp, missed, falseLocks: locks.length - tp,
      precision: locks.length ? tp / locks.length : 1, recall: windows.length ? tp / windows.length : 1 });
    const errs = windows.filter(w => w.hit && w.rect).map(w => Math.max(Math.abs(w.hit.rect.x0 - w.rect.x0), Math.abs(w.hit.rect.y0 - w.rect.y0), Math.abs(w.hit.rect.x1 - w.rect.x1), Math.abs(w.hit.rect.y1 - w.rect.y1)));
    if (errs.length) acc.rectErrPx = { mean: mean(errs), max: Math.max(...errs) };
  }
  const s = tr.stats;
  return { frames: frames.length, durationS: (frames.at(-1).t - frames[0].t) / 1000, locks, accuracy: acc, jitter,
    idSwitches, slotSwaps: s.slotSwaps, dropouts: s.droppedConfirmed, tracksSpawned: s.spawns, gateRejects: s.gate, ignoredThirdHands: s.ignored };
}

export function formatReport(r) {
  const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
  const a = r.accuracy;
  return [
    `frames ${r.frames}  duration ${f(r.durationS, 1)} s`,
    `locks ${a.locks}` + (a.truthLocks !== undefined
      ? `  truth ${a.truthLocks}  matched ${a.matched}  missed ${a.missed}  false ${a.falseLocks}  precision ${f(a.precision * 100, 1)}%  recall ${f(a.recall * 100, 1)}%`
      : '  (no ground truth in file: add "truth" or press M while recording)'),
    a.rectErrPx ? `locked-rectangle error vs truth: mean ${f(a.rectErrPx.mean, 1)} px, max ${f(a.rectErrPx.max, 1)} px` : '',
    `still-hand fingertip jitter (${r.jitter.segments} segments): filtered ${f(r.jitter.filteredPx)} px (${f(r.jitter.filteredInS, 4)} S, worst ${f(r.jitter.maxFilteredPx)} px)  raw ${f(r.jitter.rawPx)} px`,
    `ID switches ${r.idSwitches}  L/R slot swaps ${r.slotSwaps}  confirmed-track dropouts ${r.dropouts}  tracks spawned ${r.tracksSpawned}`,
    `gate rejections ${JSON.stringify(r.gateRejects)}  third-hand detections ignored ${r.ignoredThirdHands}`,
  ].filter(Boolean).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let session;
  if (args[0] === '--synthetic') {
    session = makeSession({ attempts: Number(args[1]) || 20, kinds: ['lock', 'lock', 'oneHand', 'lock', 'dropout'],
      glitch: { labelFlip: true, jumpProb: 0.01, thirdHand: true, fakeObject: true } });
    if (args[2]) writeFileSync(args[2], JSON.stringify(session));
  } else session = JSON.parse(readFileSync(args[0], 'utf8'));
  const ci = args.indexOf('--cal');
  const th = ci >= 0 ? (([a, b]) => ({ rOpen: +a, rClosed: +b }))(args[ci + 1].split(',')) : null;
  console.log(formatReport(analyze(session, { thresholds: th })));
}
