// Wires camera -> tracker worker -> handTrack -> gesture -> pipeline -> renderer. Owns the render loop.
// URL params: src=file.mp4  fake=1 (synthetic hands)  replay=file.json  effect=N  under=N,M  still=T  pre=frames  order=3,1,2
//             debug=1  skeleton=1  qa=1
import { Renderer } from './render.js';
import { Pipeline } from './pipeline.js';
import { DepthProvider } from './depthProvider.js';
import { Camera, CameraError } from './camera.js';
import { HandTracker, DEFAULTS as TRACK_DEFAULTS } from './handTrack.js';
import { GestureEngine, GESTURE_DEFAULTS, Calibrator } from './gesture.js';
import { Hud, loadTuning, saveTuning } from './hud.js';
import { ordered, ALL } from './effects/index.js';
import { applyPreset } from './effects/util.js';
import { depthInterval, refreshPeriod } from './governor.js';
import { makeSession, toFloat } from './synthSession.js';

const q = new URLSearchParams(location.search);
const hud = new Hud(document.getElementById('hud'));
const canvas = document.getElementById('c'), video = document.getElementById('v');
const BASE = new URL('./', location.href).href;
const now = () => performance.now();

const app = window.__pinchbox = { hud, q };
const S = app.S = { // mutable app state read by the HUD
  paused: false, delegate: '', inferMs: 0, latencyMs: 0, busy: false, busySince: 0, workerReady: false,
  recording: null, marks: [], calibrating: null, lastResult: null, depthBusy: false, depthReady: false, depthState: 'idle', lastDepthSend: 0,
  hands: { count: 0, lm: [null, null], rawCount: 0, raw: [null, null] }, skeleton: q.get('skeleton') === '1',
};

async function main() {
  // ---- renderer -------------------------------------------------------------------------------
  let renderer;
  try { renderer = new Renderer(canvas); } catch (e) { hud.fatal(e.message || 'WebGL2 is not available.'); throw e; }
  if (renderer.notices.length) hud.message(renderer.notices.join(' '), 'warn', 8000);
  const effects = ordered(q.get('order') ? q.get('order').split(',').map(Number) : null);
  const pipeline = new Pipeline(renderer, effects);
  pipeline.gov.enabled = q.get('gov') !== '0';
  renderer.depth = new DepthProvider(renderer);
  Object.assign(app, { renderer, pipeline, effects });

  // ---- logic modules with saved tuning ---------------------------------------------------------
  const tuning = loadTuning() || {};
  const tracker = new HandTracker({ display: { ...TRACK_DEFAULTS.display, ...(tuning.display || {}) }, tip: { ...TRACK_DEFAULTS.tip, ...(tuning.tip || {}) } });
  const gesture = new GestureEngine({ effectCount: effects.length, decision: { ...GESTURE_DEFAULTS.decision, ...(tuning.decision || {}) },
    lookBackMs: tuning.lookBackMs ?? GESTURE_DEFAULTS.lookBackMs,  minConf: tuning.minConf ?? GESTURE_DEFAULTS.minConf,
    boxMode: tuning.boxMode ?? GESTURE_DEFAULTS.boxMode, lookGain: tuning.lookGain ?? GESTURE_DEFAULTS.lookGain, followOmega: tuning.followOmega ?? GESTURE_DEFAULTS.followOmega });
  let calibrated = false;
  // calibration v2 = image-space pinch ratio; older saved calibrations used world-space ratios and would give wrong thresholds
  try { const c = JSON.parse(localStorage.getItem('pinchbox.calibration') || 'null'); if (c && c.v === 2) { gesture.setThresholds(c); calibrated = true; } else if (c) localStorage.removeItem('pinchbox.calibration'); } catch (e) { /* none */ }
  const calibrator = new Calibrator();
  Object.assign(app, { tracker, gesture, calibrator });

  // ---- camera ---------------------------------------------------------------------------------
  const camera = new Camera(video);
  const fake = q.get('fake') === '1', replay = q.get('replay');
  const src = q.get('src') || ((fake || replay) ? 'fixtures/sample.mp4' : null);
  let cam;
  try { cam = await camera.open(src); }
  catch (e) {
    hud.fatal((e instanceof CameraError ? e.message : 'Camera error: ' + (e && e.message)) + '  Press Enter for demo mode (synthetic hands, no camera needed).');
    addEventListener('keydown', ev => { if (ev.key === 'Enter') location.search = '?fake=1'; });
    throw e;
  }
  app.camera = camera;

  const layout = () => {
    const changed = renderer.resize(video.videoWidth, video.videoHeight, window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    if (changed) pipeline.reallocAll();
  };
  layout(); addEventListener('resize', layout);

  // ---- tracker worker ---------------------------------------------------------------------------
  let worker = null;
  const useWorker = !fake && !replay && q.get('track') !== '0' && q.get('qa') !== '1';
  if (useWorker) {
    hud.message('Loading hand model…', 'info');
    try { worker = new Worker(new URL('tracker.worker.js', import.meta.url)); }
    catch (e) { hud.message('Could not start the tracker worker: ' + e.message, 'error'); }
    if (worker) {
      worker.onmessage = ev => {
        const m = ev.data;
        if (m.type === 'ready') { S.workerReady = true; S.delegate = m.delegate; hud.message(m.delegate === 'CPU' ? 'Hand tracking running on the CPU (GPU delegate unavailable) - expect lower fps.' : 'Raise both hands, thumb and index open.', m.delegate === 'CPU' ? 'warn' : 'info', 6000); }
        else if (m.type === 'warn') hud.message(m.msg, 'warn', 9000);
        else if (m.type === 'error') { S.busy = false; if (!S.workerReady) hud.message('Hand model failed to load: ' + m.msg, 'error'); else console.warn('tracker error', m.msg); }
        else if (m.type === 'result') { S.busy = false; onResult(m); }
      };
      worker.onerror = e => hud.message('Tracker worker crashed: ' + (e.message || 'unknown error'), 'error');
      worker.postMessage({ type: 'init', base: BASE, cfg: tuning.mp || undefined, delegate: (q.get('delegate') || '').toUpperCase() || undefined });
    }
  } else { S.workerReady = true; S.delegate = fake ? 'synthetic' : replay ? 'replay' : 'off'; }

  // ---- depth worker (lazy) ----------------------------------------------------------------------
  let dworker = null;
  const startDepth = () => {
    if (dworker || S.depthState === 'failed') return;
    S.depthState = 'loading';
    try { dworker = new Worker(new URL('depth.worker.js', import.meta.url), { type: 'module' }); } catch (e) { S.depthState = 'failed'; return; }
    dworker.onmessage = ev => {
      const m = ev.data;
      if (m.type === 'ready') { S.depthReady = true; S.depthState = 'ready'; hud.message('', 'info'); }
      else if (m.type === 'progress') { if (m.status === 'progress' && m.progress != null && !S.depthReady) hud.message(`Loading depth model… ${Math.round(m.progress)}%  (using approximate depth meanwhile)`, 'info'); }
      else if (m.type === 'depth') { S.depthBusy = false; renderer.depth.setModelDepth(m.data, m.w, m.h); }
      else if (m.type === 'error') { S.depthBusy = false; console.warn('depth worker error:', m.msg); if (!S.depthReady) { S.depthState = 'failed'; hud.message('Depth model unavailable (' + m.msg + '); using approximate depth.', 'warn', 8000); } }
    };
    dworker.postMessage({ type: 'init', base: BASE });
  };

  // ---- frame pump -------------------------------------------------------------------------------
  const sendToDepth = t => {
    if (!pipeline.needsDepth || !S.depthReady || S.depthBusy) return;
    if (t - S.lastDepthSend < depthInterval(S.inferMs)) return;
    S.lastDepthSend = t; S.depthBusy = true;
    const vw = video.videoWidth, vh = video.videoHeight, k = 384 / Math.max(vw, vh);
    createImageBitmap(video, { resizeWidth: Math.round(vw * k), resizeHeight: Math.round(vh * k) })
      .then(bm => dworker.postMessage({ type: 'frame', bitmap: bm }, [bm])).catch(() => { S.depthBusy = false; });
  };
  camera.start((t, v) => {
    S.vidT = t; S.vidArr = now();                       // capture time of the frame that is about to be shown, and when it arrived
    renderer.onCameraFrame();
    if (pipeline.needsDepth) { if (!dworker) startDepth(); sendToDepth(now()); }
    if (!worker || !S.workerReady || S.paused) return;
    if (S.busy && now() - S.busySince < 3000) return; // drop frames while inference is busy: never queue
    S.busy = true; S.busySince = now();
    createImageBitmap(v).then(bm => worker.postMessage({ type: 'frame', bitmap: bm, t }, [bm])).catch(() => { S.busy = false; });
  });

  // ---- tracker results -> logic ------------------------------------------------------------------
  const toast = (s, ms = 1600) => hud.message(s, 'info', ms);
  function applyEvents(events) {
    for (const e of events) {
      if (e.type === 'lock') { const b = pipeline.add(e.box, S.lastResult.w, S.lastResult.h, now()); toast(`Locked: ${b.effect.name}`); if (hud.debugOn) refreshEffectPanel(); }
      else if (e.type === 'remove') pipeline.remove(e.box.id, now());
    }
  }
  function onResult(res) {
    const tNow = now();
    S.inferMs += 0.2 * ((res.inferMs ?? 0) - S.inferMs);
    S.latencyMs += 0.2 * (tNow - res.t - S.latencyMs);
    if (S.recording) S.recording.frames.push({ t: res.t, w: res.w, h: res.h, inferMs: res.inferMs,
      hands: res.hands.map(h => ({ lm: Array.from(h.lm), world: Array.from(h.world), label: h.label, score: h.score })) });
    S.lastResult = res;
    const f = tracker.update(res);
    S.lastTracks = f;
    const events = gesture.update(f);
    applyEvents(events);
    // overlays + parallax + depth blobs from the confirmed tracks
    const H = S.hands; H.count = 0; H.rawCount = 0;
    let cx = 0, cy = 0, n = 0;
    const blobs = renderer.depth.blobs; blobs.fill(0);
    for (const tr of f.tracks) {
      if (!tr.confirmed) continue;
      H.lm[H.count++] = tr.lm; H.raw[H.rawCount++] = tr.raw;
      const x = tr.c[0] / res.w, y = tr.c[1] / res.h; cx += x; cy += y; n++;
      const o = (n - 1) * 4; if (o < 8) { blobs[o] = x; blobs[o + 1] = 1 - y; blobs[o + 2] = tr.S * 1.4 / res.w; blobs[o + 3] = 1; }
    }
    if (n) { app.parallaxTarget[0] = cx / n * 2 - 1; app.parallaxTarget[1] = 1 - (cy / n) * 2; } else { app.parallaxTarget[0] = 0; app.parallaxTarget[1] = 0; }
    // calibration
    if (calibrator.active) {
      let best = null; for (const tr of f.tracks) if (tr.confirmed && !tr.coasting && (!best || tr.conf > best.conf)) best = tr;
      if (best) calibrator.feed(tNow, best.pinchRaw);
      calibrator.feed(tNow, NaN);
    }
  }
  app.parallaxTarget = [0, 0];
  app.onResult = onResult;

  // ---- synthetic / replayed hands (no camera hands needed) ----------------------------------------
  let feed = null;
  if (fake) {
    const W = video.videoWidth, Hh = video.videoHeight;
    const sess = makeSession({ W, H: Hh, S: Hh * 0.13, attempts: 12, seed: 7, noise: 0.8, startMs: 0 });
    feed = { frames: toFloat(sess.frames), t0: 0, i: 0, loopMs: sess.frames[sess.frames.length - 1].t + 500 };
    app.session = sess;
  } else if (replay) {
    const sess = await (await fetch(replay)).json();
    feed = { frames: toFloat(sess.frames), t0: sess.frames[0].t, i: 0, loopMs: sess.frames.at(-1).t - sess.frames[0].t + 300 };
  }
  let feedStart = now();
  const pumpFeed = tNow => {
    if (!feed || S.paused) return;
    const el = tNow - feedStart;
    while (feed.i < feed.frames.length && feed.frames[feed.i].t - feed.t0 <= el) {
      const fr = feed.frames[feed.i++];
      onResult({ ...fr, t: feedStart + (fr.t - feed.t0) });
    }
    if (feed.i >= feed.frames.length && el > feed.loopMs) { feed.i = 0; feedStart = tNow; gesture.clear().forEach(b => pipeline.remove(b.id, tNow)); }
  };

  // ---- keys ---------------------------------------------------------------------------------------
  const refreshEffectPanel = () => {
    const b = pipeline.last();
    hud.showEffectParams(b, (k, v) => { b.params[k] = v; }, i => { applyPreset(b, i); refreshEffectPanel(); });
  };
  const buildTuning = c => {
    const add = (label, min, max, step, get, set) => hud.slider(c, label, min, max, step, get(), v => { set(v); persist(); });
    const persist = () => saveTuning({ display: tracker.cfg.display, decision: gesture.cfg.decision, lookBackMs: gesture.cfg.lookBackMs, minConf: gesture.cfg.minConf, tip: tracker.cfg.tip, boxMode: gesture.cfg.boxMode, lookGain: gesture.cfg.lookGain, followOmega: gesture.cfg.followOmega, mp: tuning.mp });
    const disp = tracker.cfg.display, dec = gesture.cfg.decision;
    hud.slider(c, 'display minCutoff (Hz)', 0.1, 5, 0.05, disp.minCutoff, v => { tracker.setDisplayParams({ ...tracker.cfg.display, minCutoff: v }); persist(); });
    hud.slider(c, 'display beta', 0, 0.2, 0.001, disp.beta, v => { tracker.setDisplayParams({ ...tracker.cfg.display, beta: v }); persist(); });
    hud.slider(c, 'display dCutoff', 0.2, 5, 0.05, disp.dCutoff, v => { tracker.setDisplayParams({ ...tracker.cfg.display, dCutoff: v }); persist(); });
    hud.slider(c, 'box tip minCutoff (Hz)', 0.5, 12, 0.1, tracker.cfg.tip.minCutoff, v => { tracker.setTipParams({ minCutoff: v }); persist(); });
    hud.slider(c, 'box tip beta', 0, 2, 0.01, tracker.cfg.tip.beta, v => { tracker.setTipParams({ beta: v }); persist(); });
    add('box look-ahead gain', 0, 1.5, 0.05, () => gesture.cfg.lookGain, v => { gesture.cfg.lookGain = v; });
    add('box follow rate (rad/s)', 8, 120, 1, () => gesture.cfg.followOmega, v => { gesture.cfg.followOmega = v; });
    hud.slider(c, 'decision minCutoff (Hz)', 0.1, 5, 0.05, dec.minCutoff, v => { gesture.setDecisionParams({ ...gesture.cfg.decision, minCutoff: v }); persist(); });
    hud.slider(c, 'decision beta', 0, 2, 0.01, dec.beta, v => { gesture.setDecisionParams({ ...gesture.cfg.decision, beta: v }); persist(); });
    add('look-back (ms)', 0, 400, 5, () => gesture.cfg.lookBackMs, v => { gesture.cfg.lookBackMs = v; });
    add('min confidence', 0.2, 0.95, 0.01, () => gesture.cfg.minConf, v => { gesture.cfg.minConf = v; });
    const row = document.createElement('div'); row.className = 'btnrow'; c.appendChild(row);
    const mk = (t, fn) => { const b = document.createElement('button'); b.textContent = t; b.onclick = fn; row.appendChild(b); };
    mk('re-arm: ' + gesture.cfg.rearmMode, function () { gesture.cfg.rearmMode = gesture.cfg.rearmMode === 'either' ? 'both' : 'either'; this.textContent = 're-arm: ' + gesture.cfg.rearmMode; });
    mk('box: ' + gesture.cfg.boxMode, function () { gesture.cfg.boxMode = gesture.cfg.boxMode === 'midpoints' ? 'bbox4' : 'midpoints'; this.textContent = 'box: ' + gesture.cfg.boxMode; });
    mk('reset tuning', () => { try { localStorage.removeItem('pinchbox.tuning'); } catch (e) { /* */ } location.reload(); });
  };
  hud.setTuningBuilder(buildTuning);

  const startRecording = () => { S.recording = { frames: [], t0: now() }; S.marks = []; toast('Recording tracker output… press R again to save, M to mark a lock attempt', 3000); };
  const stopRecording = () => {
    const rec = S.recording; S.recording = null;
    const session = { meta: { created: new Date().toISOString(), camera: camera.settings, ua: navigator.userAgent, display: tracker.cfg.display, decision: gesture.cfg.decision,
      thresholds: { rOn: gesture.rOn, rOff: gesture.rOff } }, frames: rec.frames, marks: S.marks.slice() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(session)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `pinchbox-session-${Date.now()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`Saved ${rec.frames.length} frames. Replay: node tools/replay.js <file>`, 4000);
  };
  const startCalibration = () => {
    if (calibrator.active) return;
    calibrator.start(now());
    const tick = () => {
      const ph = calibrator.phase(now());
      if (ph === 'open') hud.message('Calibrating (1/2): hold ONE hand open - thumb and index wide apart', 'info');
      else if (ph === 'pinch') hud.message('Calibrating (2/2): PINCH firmly, thumb to index', 'info');
      else {
        if (!calibrator.done) calibrator.feed(now(), NaN); // flush at 3 s
        if (calibrator.result) {
          gesture.setThresholds(calibrator.result); calibrated = true;
          try { localStorage.setItem('pinchbox.calibration', JSON.stringify({ ...calibrator.result, v: 2 })); } catch (e) { /* */ }
          hud.message(`Calibrated: open ${calibrator.result.rOpen.toFixed(2)}, pinched ${calibrator.result.rClosed.toFixed(2)}`, 'info', 3500);
        } else hud.message('Calibration failed: ' + (calibrator.error || 'no data'), 'warn', 5000);
        calibrator.t0 = null; return;
      }
      setTimeout(tick, 120);
    };
    tick();
  };
  addEventListener('keydown', e => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'd') { if (hud.toggleDebug()) { refreshEffectPanel(); S.skeleton = true; } }
    else if (k === 'c') startCalibration();
    else if (k === 'u') { const b = gesture.undo(); if (b) pipeline.remove(b.id, now()); }
    else if (e.key === 'Escape') gesture.clear().forEach(b => pipeline.remove(b.id, now()));
    else if (k === ' ') { S.paused = !S.paused; e.preventDefault(); }
    else if (k === 'r') S.recording ? stopRecording() : startRecording();
    else if (k === 'm' && S.recording) { S.marks.push(now()); toast('Marked lock attempt', 800); }
    else if (k === 's') S.skeleton = !S.skeleton;
    else if (k === 'p') { const b = pipeline.last(); if (b) { applyPreset(b, (b.preset + 1) % 3); if (hud.debugOn) refreshEffectPanel(); } }
    else if (k === 'f') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
  });

  // ---- HUD state --------------------------------------------------------------------------------
  hud.getState = () => {
    const hands = [];
    for (const tr of tracker.tracks) { const h = gesture.hand[tr.slot] || {}; hands.push({ slot: tr.slot, id: tr.id, confirmed: tr.confirmed, conf: tr.conf, S: tr.S, gate: tr.gates.reason, coasting: tr.coasting, rRaw: tr.pinchRaw, r: h.r, on: h.on }); }
    return { refreshHz: S.refreshHz, captureFps: camera.fps, inferMs: S.inferMs, latencyMs: S.latencyMs, renderFps: renderer.stats.renderFps, gpuMs: renderer.stats.gpuMs, delegate: S.delegate,
      boxes: pipeline.list.filter(b => !b.removing).length, paused: S.paused, recording: S.recording ? S.recording.frames.length : 0,
      depthMode: pipeline.needsDepth ? renderer.depth.mode : '',
      cam: `${cam.width}x${cam.height} @ ${Math.round(cam.frameRate)} fps  ${cam.label || ''}`, scene: `${renderer.sceneW}x${renderer.sceneH}  ${renderer.caps.floatRT ? 'RGBA16F' : 'RGBA8'}  timer ${renderer.timerExt ? 'GPU' : 'rAF'}`,
      p95: pipeline.gov.p95(), budget: pipeline.gov.budgetMs, passLevel: pipeline.gov.passLevel,
      fsm: gesture.state, armed: gesture.armed, blocker: gesture.blocker, rOn: gesture.rOn, rOff: gesture.rOff, calibrated, hands, st: tracker.stats,
      boxList: pipeline.list.map(b => ({ id: b.id, name: b.effect.name, scale: b.scale })) };
  };

  // ---- QA / demo boxes -------------------------------------------------------------------------
  const qaEffect = q.get('effect');
  const qa = app.qa = { ready: !qaEffect, frames: 0 };
  if (qaEffect) {
    const W = video.videoWidth, Hh = video.videoHeight;
    const mkBox = (idx, r, id) => pipeline.add({ id, effectIndex: idx, rect: { x0: r[0] * W, y0: r[1] * Hh, x1: r[2] * W, y1: r[3] * Hh } }, W, Hh, now() - 5000);
    // `under` boxes go first so stacking-aware effects (frosted glass) have something to see
    const under = (q.get('under') || '').split(',').filter(Boolean).map(Number);
    under.forEach((u, i) => mkBox(Math.max(0, effects.indexOf(ALL[u - 1])), [0.08 + 0.05 * i, 0.1, 0.55 + 0.05 * i, 0.9], 100 + i));
    const eff = ALL[Number(qaEffect) - 1];
    const box = mkBox(Math.max(0, effects.indexOf(eff)), under.length ? [0.38, 0.14, 0.92, 0.86] : [0.17, 0.12, 0.83, 0.88], 1);
    if (q.get('preset')) applyPreset(box, Number(q.get('preset')));
  }
  app.qaStill = q.get('still') !== null;

  // ---- render loop -------------------------------------------------------------------------------
  const live = { visible: false, formed: false, pulse: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
  const fb = { count: 0, mx: [0, 0], my: [0, 0], tx: [0, 0], ty: [0, 0], ix: [0, 0], iy: [0, 0], close: [0, 0], on: [false, false] };
  const view = { video, boxes: pipeline.list, live, hands: S.hands, feedback: q.get('qa') === '1' ? null : fb, nowMs: 0, needsDepth: false };
  const fbSlots = ['L', 'R'];
  const updateFeedback = () => { // always-on pinch feedback, drawn over every box so effects can never hide it
    let n = 0;
    for (let k = 0; k < 2; k++) {
      const tr = S.lastTracks && S.lastTracks[fbSlots[k]];
      if (!tr || !tr.confirmed) continue;
      const lm = tr.lm, h = gesture.hand[fbSlots[k]];
      const tp = tr.tips;
      fb.tx[n] = tp[0]; fb.ty[n] = tp[1]; fb.ix[n] = tp[2]; fb.iy[n] = tp[3];
      fb.mx[n] = (tp[0] + tp[2]) / 2; fb.my[n] = (tp[1] + tp[3]) / 2;
      const r = Math.min(h.r ?? 9, h.rRaw ?? 9);
      fb.close[n] = Math.max(0, Math.min(1, (gesture.rOff - r) / (gesture.rOff - gesture.rOn))); fb.on[n] = !!h.on; n++;
    }
    fb.count = n;
  };
  // pre-compile every effect (one per frame) so the first lock of any effect never stalls on shader compilation
  const warmQueue = q.get('nowarm') ? [] : effects.map((_, i) => i); let warmBox = null;
  let last = now(), t0 = last, nDt = 0; const dts = new Float32Array(240); let dtN = 0, dtI = 0;
  let framesSinceCfg = 0;
  const loop = ts => {
    requestAnimationFrame(loop);
    const tNow = ts || now();
    const dt = Math.min(0.1, Math.max(0.0005, (tNow - last) / 1000)); last = tNow;
    pumpFeed(tNow);
    // refresh-rate aware governor budget (measured once from the first frames)
    // display refresh follows the monitor the window is on (it can change if the window is dragged to another screen): re-estimated every ~2 s
    dts[dtI] = dt * 1000; dtI = (dtI + 1) % 240; if (dtN < 240) dtN++;
    if (dtN >= 90 && (++nDt % 120 === 0 || !S.refreshHz)) {
      const period = refreshPeriod(Array.from(dts.subarray(0, dtN))); S.refreshHz = 1000 / period;
      pipeline.gov.budgetMs = renderer.timerExt ? Math.max(3, period * 0.8) : period * 1.25 + 1;
    }
    // live box: shown fingertips chase (filtered tips + velocity x time-to-now) with velocity feed-forward, evaluated every display frame
    const tPred = (S.vidT || tNow) + (tNow - (S.vidArr || tNow));
    const lv = gesture.displayTarget(tPred, dt);
    live.visible = lv.visible && !!S.lastResult; live.formed = lv.formed;
    if (live.visible) {
      live.x0 = lv.x0e; live.y0 = lv.y0e; live.x1 = lv.x1e; live.y1 = lv.y1e;
      live.pulse = gesture.state === 'PINCHING' ? 0.5 + 0.5 * Math.sin(tNow * 0.014) : 0;
    }
    const k = 1 - Math.exp(-dt * 5);
    renderer.hand.x += (app.parallaxTarget[0] - renderer.hand.x) * k; renderer.hand.y += (app.parallaxTarget[1] - renderer.hand.y) * k;
    view.nowMs = tNow; view.needsDepth = pipeline.needsDepth;
    if (view.feedback) updateFeedback();
    S.hands.visible = S.skeleton || hud.debugOn;
    const hv = S.hands; const hc = hv.count, rc = hv.rawCount;
    if (!S.skeleton && !hud.debugOn) { hv.count = 0; hv.rawCount = 0; } else if (!hud.debugOn) hv.rawCount = 0;
    if (warmBox) { pipeline.discard(warmBox); warmBox = null; }
    if (warmQueue.length && renderer.tex.video && video.readyState >= 2 && !qaEffect) {
      const i = warmQueue.shift(), eff = effects[i];
      if (eff.needsDepth) renderer.depth.update(renderer, dt, true);
      warmBox = pipeline.warm(i, S.lastResult ? S.lastResult.w : video.videoWidth, video.videoHeight);
    }
    renderer.frame(view, dt, app.qaStill ? 3.7 : (tNow - t0) / 1000);
    hv.count = hc; hv.rawCount = rc;
    pipeline.update(tNow, renderer.timerExt && renderer.stats.gpuMs > 0 ? renderer.stats.gpuMs : dt * 1000);
    if (qa) qa.frames++;
    if (qaEffect && !qa.busy && qa.frames > 8) qa.ready = true;
  };
  requestAnimationFrame(loop);
  if (qaEffect && q.get('still') !== null) {
    // freeze on a time stamp, pre-rolling history so slit-scan / data-mosh / posterize have frames to read
    qa.ready = false; qa.busy = true;
    video.pause();
    const T = Number(q.get('still')), pre = Number(q.get('pre') ?? 60), fps = 30;
    for (let i = pre; i >= 0; i--) {
      video.currentTime = Math.max(0, T - i / fps);
      await new Promise(r => { video.onseeked = r; });
      await new Promise(r => requestAnimationFrame(r));
      renderer.onCameraFrame();
      await new Promise(r => requestAnimationFrame(r));
    }
    qa.busy = false; qa.frames = 0;
  }
  if (q.get('debug') === '1') { hud.toggleDebug(); refreshEffectPanel(); }
  if (q.get('qa') === '1') { hud.help.hidden = true; hud.line.hidden = true; hud.message(''); }
  app.ready = true;
}

main().catch(e => { console.error(e); if (!document.querySelector('.hud-msg:not([hidden])')) hud.fatal(String(e && e.message || e)); });
