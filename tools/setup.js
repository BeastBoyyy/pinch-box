// Copies the pinned MediaPipe runtime into vendor/ and downloads the hand model into models/ so the app runs offline.
import { cpSync, mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const dst = join(root, 'vendor', 'mediapipe');
mkdirSync(dst, { recursive: true });
for (const f of ['vision_bundle.mjs', 'vision_bundle.js']) cpSync(join(pkg, f), join(dst, f));
cpSync(join(pkg, 'wasm'), join(dst, 'wasm'), { recursive: true });
console.log('copied MediaPipe runtime ->', dst);

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const model = join(root, 'models', 'hand_landmarker.task');
if (existsSync(model) && statSync(model).size > 1e6) {
  console.log('model already present');
} else {
  mkdirSync(dirname(model), { recursive: true });
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error(`model download failed: HTTP ${r.status}`);
  writeFileSync(model, Buffer.from(await r.arrayBuffer()));
  console.log('downloaded model ->', model, statSync(model).size, 'bytes');
}

// ---- depth model + runtime, so the depth effects also work with no internet -----------------------------------------------
const tf = join(root, 'node_modules', '@huggingface', 'transformers', 'dist'), ort = join(root, 'node_modules', 'onnxruntime-web', 'dist');
if (existsSync(tf)) {
  const vt = join(root, 'vendor', 'transformers');
  mkdirSync(vt, { recursive: true });
  cpSync(join(tf, 'transformers.min.js'), join(vt, 'transformers.min.js'));   // self-contained ESM bundle (onnxruntime inlined)
  for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) cpSync(join(ort, f), join(vt, f));
  console.log('copied transformers.js + onnxruntime-web (WebGPU) ->', vt);
}
const DEPTH = 'depth-anything-v2-small';
const depthDir = join(root, 'models', DEPTH);
for (const f of ['config.json', 'preprocessor_config.json', 'onnx/model_q4f16.onnx']) {
  const dst2 = join(depthDir, f);
  if (existsSync(dst2) && statSync(dst2).size > 100) continue;
  mkdirSync(dirname(dst2), { recursive: true });
  const r = await fetch(`https://huggingface.co/onnx-community/${DEPTH}/resolve/main/${f}`);
  if (!r.ok) { console.warn(`depth model file ${f}: HTTP ${r.status} (depth effects will use the online model or the approximation)`); continue; }
  writeFileSync(dst2, Buffer.from(await r.arrayBuffer()));
  console.log('downloaded', f, statSync(dst2).size, 'bytes');
}
