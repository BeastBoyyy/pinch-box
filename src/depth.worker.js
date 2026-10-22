// Optional monocular depth: Depth Anything V2 SMALL (24.8M params, Apache-2.0) via transformers.js on WebGPU.
// The Base/Large/Giant checkpoints are CC-BY-NC and are deliberately NOT used.
// Started by main.js only when a depth-dependent box exists; paced by depthInterval() so it never competes with tracking.
const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const MODEL = 'onnx-community/depth-anything-v2-small';
let pipe = null, RawImage = null, lo = null, hi = null;

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      if (!('gpu' in navigator)) throw new Error('WebGPU is not available');
      // everything is bundled locally when `npm run setup` has run (works offline); otherwise fall back to the CDN / Hugging Face hub
      const base = m.base, has = async u => { try { return (await fetch(u, { method: 'HEAD' })).ok; } catch (e) { return false; } };
      const local = !!base && await has(base + 'vendor/transformers/transformers.min.js') && await has(base + 'models/depth-anything-v2-small/onnx/model_q4f16.onnx');
      const tf = await import(local ? base + 'vendor/transformers/transformers.min.js' : CDN);
      RawImage = tf.RawImage;
      if (local) {
        tf.env.allowRemoteModels = false; tf.env.allowLocalModels = true; tf.env.localModelPath = base + 'models/';
        tf.env.backends.onnx.wasm.wasmPaths = { mjs: base + 'vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs', wasm: base + 'vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm' };
      } else tf.env.allowLocalModels = false;
      pipe = await tf.pipeline('depth-estimation', local ? 'depth-anything-v2-small' : MODEL, {
        device: 'webgpu', dtype: 'q4f16',
        progress_callback: p => self.postMessage({ type: 'progress', status: p.status, file: p.file, progress: p.progress }),
      });
      if (typeof pipe.processor !== 'function') { // seen in the worker with the self-contained bundle: load the image processor explicitly
        pipe.processor = await tf.AutoProcessor.from_pretrained(local ? 'depth-anything-v2-small' : MODEL);
      }
      self.postMessage({ type: 'ready', model: MODEL, local });
    } else if (m.type === 'frame') {
      const { bitmap } = m, w = bitmap.width, h = bitmap.height;
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bitmap, 0, 0); bitmap.close();
      const px = g.getImageData(0, 0, w, h);
      const out = await pipe(new RawImage(px.data, w, h, 4));
      const t = out.predicted_depth, dims = t.dims, oh = dims[dims.length - 2], ow = dims[dims.length - 1];
      const src = t.data, n = ow * oh, data = new Float32Array(n);
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < n; i++) { const v = src[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      lo = lo === null ? mn : lo + 0.2 * (mn - lo); hi = hi === null ? mx : hi + 0.2 * (mx - hi); // slow range tracking: no per-frame flicker
      const k = 1 / Math.max(1e-6, hi - lo);
      for (let i = 0; i < n; i++) data[i] = Math.min(1, Math.max(0, (src[i] - lo) * k)); // relative inverse depth, 1 = near
      self.postMessage({ type: 'depth', data, w: ow, h: oh }, [data.buffer]);
    }
  } catch (err) { self.postMessage({ type: 'error', msg: String(err && err.message || err) + ' | proc=' + typeof (pipe && pipe.processor) + ' ' + (pipe && pipe.processor && (pipe.processor.constructor && pipe.processor.constructor.name) + ' keys=' + Object.keys(pipe.processor).slice(0, 12).join(',')) + ' | ' + String(err && err.stack).slice(0, 300) }); }
};
