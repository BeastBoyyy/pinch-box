// MediaPipe selfie segmentation off the main thread (classic worker, same reason as tracker.worker.js). Started only when a box needs it.
//   in : {type:'init', base} | {type:'frame', bitmap, t}
//   out: {type:'ready', delegate} | {type:'error', msg} | {type:'mask', data: Uint8Array (row 0 = top, 255 = person), w, h, inferMs}
let seg = null, lastTs = 0, delegate = '';

async function create(base, d) {
  const fileset = await self.Vision.FilesetResolver.forVisionTasks(base + 'vendor/mediapipe/wasm');
  return self.Vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: base + 'models/selfie_segmenter_landscape.tflite', delegate: d },
    runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
  });
}

self.onmessage = async ev => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      importScripts(m.base + 'vendor/mediapipe/vision_bundle.js');
      try { seg = await create(m.base, 'GPU'); delegate = 'GPU'; }
      catch (e) { seg = await create(m.base, 'CPU'); delegate = 'CPU'; }
      self.postMessage({ type: 'ready', delegate });
    } else if (m.type === 'frame') {
      if (!seg) { m.bitmap.close(); return; }
      const t0 = performance.now();
      lastTs = Math.max(lastTs + 1, Math.round(m.t * 1000) / 1000);
      const r = seg.segmentForVideo(m.bitmap, lastTs);
      m.bitmap.close();
      const masks = r.confidenceMasks, mask = masks[masks.length - 1];   // [background, person]
      const f = mask.getAsFloat32Array(), data = new Uint8Array(f.length);
      for (let i = 0; i < f.length; i++) data[i] = f[i] * 255;
      const w = mask.width, h = mask.height;
      r.close();
      self.postMessage({ type: 'mask', data, w, h, inferMs: performance.now() - t0 }, [data.buffer]);
    }
  } catch (e) { self.postMessage({ type: 'error', msg: String(e && e.message || e) }); }
};
