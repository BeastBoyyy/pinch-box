// MediaPipe HandLandmarker inference off the main thread. Classic worker (importScripts) so the
// vendored UMD bundle can load its own WASM loader.
//   in : {type:'init', base, cfg, delegate:'GPU'|'CPU'} | {type:'frame', bitmap, t} | {type:'cfg', cfg}
//   out: {type:'ready', delegate} | {type:'error', msg} | {type:'result', t, w, h, inferMs, hands:[{lm,world,label,score}]}
let landmarker = null, lastTs = 0, cfg = { minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.6 };
let delegate = '';

async function create(base, d) {
  const fileset = await self.Vision.FilesetResolver.forVisionTasks(base + 'vendor/mediapipe/wasm');
  return self.Vision.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: base + 'models/hand_landmarker.task', delegate: d },
    runningMode: 'VIDEO', numHands: 2, ...cfg,
  });
}

async function init(base, pref) {
  importScripts(base + 'vendor/mediapipe/vision_bundle.js');
  if (pref === 'CPU') { landmarker = await create(base, 'CPU'); delegate = 'CPU'; }
  else {
    try { landmarker = await create(base, 'GPU'); delegate = 'GPU'; }
    catch (e) { // GPU delegate unavailable: retry on CPU and say so
      self.postMessage({ type: 'warn', msg: 'GPU delegate failed (' + (e && e.message || e) + '); using CPU' });
      landmarker = await create(base, 'CPU'); delegate = 'CPU';
    }
  }
  // warm-up: 10 dummy inferences so the first real frames are not slow
  const c = new OffscreenCanvas(256, 256);
  c.getContext('2d').fillRect(0, 0, 256, 256);
  for (let i = 0; i < 10; i++) landmarker.detectForVideo(c, ++lastTs);
  self.postMessage({ type: 'ready', delegate });
}

self.onmessage = async ev => {
  const m = ev.data;
  try {
    if (m.type === 'init') { if (m.cfg) cfg = { ...cfg, ...m.cfg }; await init(m.base, m.delegate); }
    else if (m.type === 'cfg') { cfg = { ...cfg, ...m.cfg }; if (landmarker) await landmarker.setOptions(cfg); }
    else if (m.type === 'frame') {
      if (!landmarker) { m.bitmap.close(); return; }
      const t0 = performance.now();
      lastTs = Math.max(lastTs + 1, Math.round(m.t * 1000) / 1000); // strictly increasing
      const r = landmarker.detectForVideo(m.bitmap, lastTs);
      const inferMs = performance.now() - t0;
      const w = m.bitmap.width, h = m.bitmap.height;
      m.bitmap.close();
      const hands = [], transfer = [];
      for (let i = 0; i < r.landmarks.length; i++) {
        const lm = new Float32Array(63), world = new Float32Array(63);
        for (let j = 0; j < 21; j++) {
          const p = r.landmarks[i][j], q = r.worldLandmarks[i][j];
          lm[j * 3] = p.x; lm[j * 3 + 1] = p.y; lm[j * 3 + 2] = p.z;
          world[j * 3] = q.x; world[j * 3 + 1] = q.y; world[j * 3 + 2] = q.z;
        }
        const cat = (r.handedness[i] || r.handednesses?.[i] || [])[0] || {};
        hands.push({ lm, world, label: cat.categoryName || '', score: cat.score ?? 1 });
        transfer.push(lm.buffer, world.buffer);
      }
      self.postMessage({ type: 'result', t: m.t, w, h, inferMs, hands }, transfer);
    }
  } catch (e) { self.postMessage({ type: 'error', msg: String(e && e.message || e) }); }
};
