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

// ---- person segmentation model -------------------------------------------------------------------------------------------
const SEG_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite';
const seg = join(root, 'models', 'selfie_segmenter_landscape.tflite');
if (existsSync(seg) && statSync(seg).size > 1e5) {
  console.log('segmentation model already present');
} else {
  const r = await fetch(SEG_URL);
  if (!r.ok) throw new Error(`segmentation model download failed: HTTP ${r.status}`);
  writeFileSync(seg, Buffer.from(await r.arrayBuffer()));
  console.log('downloaded model ->', seg, statSync(seg).size, 'bytes');
}
