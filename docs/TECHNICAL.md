# Pinch-Box: technical write-up

*Deep technical reference (parameters, measurements, deviations from the original brief). For the exhibition-friendly overview start with the main [README](../README.md).*

Two-hand pinch-to-lock visual boxes in the browser, no TouchDesigner. A mirrored webcam feed fills the screen; hold both
hands up with thumb and index open and a rectangle stretches between them. **Pinch with both hands** and it locks (short
flourish) and a filter starts running inside it on the live video. Repeat: every lock stacks a new box on top and takes the
next effect (12 effects). Reference: the 10 s TouchDesigner recording — flat crisp boxes, thin white live
outline, sketch / posterize / quadtree / cyanotype / hologram.

Stack: `@mediapipe/tasks-vision` **1.1.1** (HandLandmarker, GPU delegate with CPU fallback, model `hand_landmarker.task`
float16 stored in `models/`) + WebGL2. No build step, plain ES modules.

## Run

```bash
npm install          # playwright (dev tooling only) + the pinned MediaPipe package
npm run setup        # copies the MediaPipe runtime to vendor/ and downloads the model to models/ (app then works offline)
npm start            # http://localhost:8080   (tools/serve.js: correct MIME types + HTTP Range for video)
```

`npx serve` or `python -m http.server` also work. Camera needs `http://localhost` or https.
On a laptop with two GPUs, set the browser to the **high-performance GPU** (Windows: Settings → System → Display → Graphics):
on the test machine hand inference took ~18 ms on the NVIDIA GPU versus ~42 ms on the integrated one.

No camera? `http://localhost:8080/?src=fixtures/sample.mp4` runs a recorded clip through the real tracker, and
`?fake=1` drives the whole pipeline with synthetic hands so locking/stacking can be seen without a camera.

### Keys
| key | action | key | action |
|---|---|---|---|
| `D` | debug panel (raw vs filtered landmarks, gates, confidence, pinch ratio + thresholds, FSM, sliders) | `C` | 3 s calibration |
| `U` | undo last box | `Esc` | clear all |
| `Space` | pause tracking | `R` | record raw tracker output (press again to save JSON) |
| `M` | while recording: mark "I just made a lock attempt" | `S` | hand skeleton |
| `P` | cycle preset of the last box | `F` | fullscreen |

### URL parameters
`src=file.mp4` · `fake=1` · `replay=session.json` · `delegate=cpu|gpu` · `order=10,11,12,1…` (effect order, 1-based) ·
`debug=1` · `skeleton=1` · `effect=N&still=T[&pre=60][&under=1,2][&preset=1]` (render one effect on a fixed video time,
used by the QA loop) · `gov=0` (disable the quality governor) · `track=0` · `qa=1` (hide HUD).

### Calibrate
Press `C`, keep **one hand in view**: for 1.5 s hold it open (thumb and index wide), then for 1.5 s pinch firmly. The medians
become `r_open` / `r_closed`; thresholds are `ON = r_closed + 0.25·(r_open − r_closed)` and `OFF = r_closed + 0.5·(…)`.
Saved in `localStorage`. Uncalibrated defaults: ON 0.30, OFF 0.55 (ratio = thumb-tip↔index-tip distance / hand scale, from
the SMALLER of the image-space and world-space values: on a real recording the world landmarks put a visibly closed left-hand pinch 6-7 cm apart (ratio stuck ≈0.7) while image space read 0.1-0.17).

### Tune the filter
`D` → *Filter tuning*. Casiez procedure: set `beta` to 0, lower `minCutoff` until a still hand stops jittering, then raise
`beta` (×10 steps from 0.0001) until fast motion stops lagging. Two separate parameter sets: **display** (box corners, units px)
and **decision** (pinch ratio) — the decision path is smoothed more and debounced; the display path is light and
latency-compensated. Values persist in `localStorage` (`reset tuning` button clears them). Defaults were chosen with
`test/handTrack.test.js` conditions: still jitter ≈0.45 px at σ=1.2 px sensor noise, lag ≈0.8 frame at 240 px/s.

### Record → replay
`R` to start, make your lock attempts, press `M` after each attempt, `R` again → downloads `pinchbox-session-*.json`
(raw pre-filter landmarks + timestamps + marks). Then, headless:

```bash
node tools/replay.js session.json                 # handTrack → filters → gesture, prints the section-9 metrics
node tools/replay.js session.json --cal 1.45,0.08 # same with calibrated thresholds
node tools/replay.js --synthetic 20 out.json      # a synthetic 20-attempt session with ground truth
node tools/extract-landmarks.js fixtures/sample.mp4 out.json   # run the real model over a video, write a replayable session
```
Metrics: jitter (σ of filtered fingertips over still segments, px and in hand-scales), ID switches, L/R slot swaps, dropouts,
false locks and missed locks (needs ground truth: synthetic sessions carry it, recorded ones use your `M` marks).

### Lighting / camera
Bright, even **front** light; camera at 30+ fps (60 if the camera offers it); keep both hands in the middle of the frame, palms
roughly facing the camera. Poor light and low frame rate are the most common causes of jitter and false detections. Avoid
posters/photos of hands in view (a static hand image is indistinguishable from a hand).

## Architecture

```
index.html
src/main.js            wiring, render loop, keys, record/calibrate
src/camera.js          getUserMedia / video file, requestVideoFrameCallback pump with capture timestamps
src/tracker.worker.js  HandLandmarker in a worker; frames dropped (never queued) while busy
src/handTrack.js  *    identity by continuity, confirmation + coasting, geometry gates, display filters, features
src/filters.js    *    One-Euro, landmark bank, critically-damped spring
src/gesture.js    *    pinch hysteresis, arming, look-back ring, box stack, calibrator
src/render.js          WebGL2: video + history ring, scene, SDF box compositing + flourish, overlays, sRGB+dither blit
src/pipeline.js        per-box targets/state, fades, governor glue      src/governor.js *  quality governor + depth back-off
src/depthProvider.js   shared depth (model or approximate) smoothing    src/depth.worker.js  Depth Anything V2 Small (WebGPU)
src/effects/*.js       the 12 effects (GLSL + params + 3 presets each)   src/hud.js  overlay/sliders
src/synthHand.js, src/synthSession.js *  synthetic hands + sessions with ground truth
test/*.test.js, tools/{replay,qa,e2e,e2e-keys,bench,extract-landmarks,serve,setup}.js
```
`*` = pure logic, no DOM/WebGL, runs in Node (`node --test`, 35 tests).

Pipeline: capture (rVFC timestamp) → ImageBitmap of the **unmirrored** frame → worker → landmarks (image + world) → `HandTracker`
(mirrors x, validates) → `GestureEngine` (events) → `Pipeline` (boxes). The render loop never waits on inference; it reads
a critically-damped spring that follows the latency-compensated live box at display rate.

Hand validation (`handTrack.js`): tracks matched by landmark-centroid distance (never by handedness label); L/R slots by wrist x,
sticky until the order has been reversed 5 frames; 4 frames to confirm, 6 to coast (clamped decaying velocity); gates: hand
scale plausible and ≤25 %/frame change, 18 bone lengths vs hand scale (world landmarks), landmark jump ≤0.6·S **after
velocity prediction** unless it persists 2 frames, wrist ROI; at most 2 tracks, a clearly larger hand evicts a small
(background) one; the two hands' scales must agree within 1.7× for a box to form. Confidence = handedness score × age ×
gate history × coasting.

Gesture (`gesture.js`): lock = both hands pinched (a firm pinch, raw ratio < 0.75·ON, latches on its first frame; borderline ones need 2; no limit on the gap between the two latches, so one pinch may be held while the other hand re-pinches; `windowMs: 150, rearmMode: 'both'` restores the strict simultaneous rule), armed (one hand OFF ≥250 ms; `both` mode: both), both confirmed/not coasting/
confidence ≥ 0.55, box formed (≥8 % of short side), 400 ms refractory. The locked rectangle comes from a 500 ms ring, taken
~120 ms **before the closing motion was first detected** (see deviations).

Rendering: linear-light RGBA16F scene; camera texture is SRGB8 (hardware decode) with mips; 96-frame history ring at half
resolution (`TEXTURE_2D_ARRAY`, filled once per camera frame via `copyTexSubImage3D`); each box renders its effect into its
own target (scaled by the governor), then is composited through a rounded-rect SDF mask (AA edge, soft shadow, hairline
highlight, lock flourish: border flash + sweep + settle + interior flash). Final blit: sRGB + triangular dither.
Governor: GPU timer (rAF fallback) p95 vs 0.8× refresh period; lowers the most expensive box's resolution first, then pass
counts; recovers slowly; never touches the tracker. Depth model starts only when a depth box exists, runs ≤10 Hz and backs
off / pauses as hand inference slows.

## Deviations and decisions (read these)
- **Letterboxed, not cropped.** The canvas takes the camera's aspect ratio, centred, so scene uv = video uv and no hand is ever
  cropped. On a 16:10 screen there are thin bars.
- **Anti-collapse reference time.** "~120 ms before pinch ON was first detected" is implemented as 120 ms before the filtered
  ratio first fell below the OFF threshold (start of the closing motion), because the ON latch lags the motion by the
  3-frame debounce plus filter delay; look-back from the latch left the rectangle partly collapsed in tests.
- **Backdrop = region copy.** Instead of two full-screen ping-pong scenes, each box blits its own region of the scene to a
  backdrop texture (only for effects that sample it, i.e. frosted glass). Same result, a fraction of the bandwidth.
- **History stored sRGB-encoded in RGBA8** and decoded in `hist()` (an sRGB8 array copied from an sRGB framebuffer returned
  un-decoded values on this ANGLE build; manual encode/decode is portable).
- `effect.init(gl)` is `init(gl, ctx)`-shaped but unused; effects get `create/destroy(ctx, box)` for per-box state.
- Classic (not module) tracker worker, because the vendored MediaPipe bundle is a UMD that loads its WASM with `importScripts`.
- Extras not in the brief: scale-ratio gate, larger-hand eviction, calibration persistence, `?fake=1`, `?replay=`, e2e tools.
- Phase 2 (RTMPose-m fingertip refiner) is **not built**; the hook exists: `refine(handCrop, landmarks)` in `handTrack.js`
  (stub returns its input, wired through `cfg.refine`).

## Measured results (and what is NOT verified)

**Unit/integration tests**: `npm test` → 35 pass (One-Euro, gates, label flips, crossing, third hand, bone gate, coasting,
FSM: clean pinch = 1 lock, one hand = 0, flicker ≤1, dropout = 0, hold = no repeat, re-arm timing, 150 ms window, look-back,
min size, low confidence, stack cap/undo, calibration, governor, replay metrics, real-landmark regression).
`node tools/e2e-keys.js` (calibration, record→download→replay, undo/clear, no-camera message) and `node tools/e2e.js`
(fake hands drive the real renderer: locks, stacking, undo, no console errors) pass.

**Section-9 metrics on SYNTHETIC sessions** (generator: `src/synthSession.js`, 30 fps, 1280×720, 1.2 px landmark noise,
0.0015 m world noise, ±0.7 px hand tremor; `tools/replay.js`):

| session | locks (truth) | false | missed | ID switches | L/R swaps | still jitter filtered (raw) |
|---|---|---|---|---|---|---|
| 20 clean attempts | 20 / 20 | 0 | 0 | 0 | 0 | 0.49 px mean, 0.9 px worst (1.39 raw) |
| 30 attempts with label flips, 2 % single-frame 1.1·S jumps, a small third hand, a fake non-hand, one-hand pinches, 10-frame dropouts | 15 / 15 | 0 | 0 | 0 | 0 | 0.47 px (1.40 raw) |

Locked-rectangle error vs the pre-pinch truth: mean ≈6–7 px, max ≈9 px (the synthetic fingertips drift during the closing
motion; look-back removes most of it). Filter lag: ≈0.8 frame at 240 px/s. These numbers show the logic is sound **against my
generator**; they are not a measurement of real-world accuracy.

**Real MediaPipe data**: the 1.5 s reference clip (`fixtures/sample-landmarks.json`, two hands waving, no pinch) replays with
3 spawned tracks, 0 ID/slot switches, 0 phantom locks. Writing this test found and fixed three tracker problems on real data
(wrist off-frame vs ROI, wrist-based matching, jump gate rejecting fast-entering hands).

**NOT verified — the acceptance targets in section 9 are unmeasured on real data.** There was no webcam session with ≥20
recorded real lock attempts, no real pinching hands, and no good-light 30 fps camera session in this environment, so lock
precision/recall ≥99 %, zero non-hand locks on real footage, zero real L/R swaps and real-fingertip jitter < 0.5 px are **not
claimed**. To measure them: record a session (`R`, `M`), `node tools/replay.js file.json`, report the numbers with your
lighting/camera. Known weak spot: a static photo/poster of a hand is not distinguishable from a hand.
Also unverified: Firefox/Safari, a real 60 fps webcam, the depth model on GPUs other than the test machine's.

**Inference** (test machine, headless Edge, sample clip, hand model GPU delegate): 18 ms median / 29 ms p95 on the RTX 4050,
42 ms / 71 ms on the integrated Intel UHD; CPU delegate 46–74 ms. Run `D` and read the HUD on your hardware.

**Render cost per effect, governor off** (`node tools/bench.js`, 1280×720 scene, one box 66 %×76 % of the frame, GPU timer):

| effect | Intel UHD (integrated) GPU ms | RTX 4050 GPU ms (median / p95) |
|---|---|---|
| 1 Edge sketch | 4.5 | 0.28 / 6.7 |
| 2 Slit-scan | 1.8 | 0.09 / 6.6 |
| 3 Moire | 1.8 | 0.29 / 6.7 |
| 4 Pixel sort (32 passes/frame) | 7.5 | 1.9 / 7.1 |
| 5 Frosted glass | 2.8 | 0.43 / 1.4 |
| 6 Data-mosh | 1.9 | 0.27 / 0.8 |
| 7 CRT | 2.9 | 0.45 / 0.9 |
| 8 Depth map | 2.8 | 0.47 / 4.4 |
| 9 Point cloud | 7.1 | 0.90 / 1.0 |
| 10 Quadtree | 1.8 | 0.45 / 6.8 |
| 11 Cyanotype | 4.8 | 0.24 / 6.8 |
| 12 Posterize + split | 4.0 | 0.47 / 6.8 |
| **all 12 stacked** | **29.3** | **1.8 / 2.5** |

The display ran at 144 Hz (6.9 ms frames): every single effect holds the refresh on both GPUs except Pixel sort / Point
cloud on the integrated GPU (occasional misses), and 12 stacked boxes exceed the budget there — the governor then drops box
resolution (verified: scales fall 1.00 → 0.35 in order of cost, ~25 s at 1080p on the iGPU; the tracker is untouched). The
RTX timer values are near the resolution limit of the timer on this hybrid-GPU laptop (median ≪ p95); treat them as
"far below budget", not as precise.

**Visual QA** (`node tools/qa.js` → `qa/fxNN-still.png`, `qa/fxNN-stripK.png`; clip = first 1.5 s of the reference recording
ping-ponged, which already contains the recording's own thin white outline). Verdicts after iteration:

1. **Edge sketch** — thin ink contours + faint hatching on warm paper with grain and a small colour fringe on strong edges; face readable. Matches the reference look.
2. **Slit-scan** — time-offset wipe with two-layer blending, no visible frame stepping; hands smear into ghost trails. Subtle in a still, needs motion (clip is mostly static).
3. **Moire** — two rotating gratings + dot grating, fringes follow the face; AA via `fwidth` (first version faded to flat navy — fixed). Two-tone navy/cream.
4. **Pixel sort** — real odd-even transposition sort, spans visibly melt into streaks in rows; unsorted pixels stay video.
5. **Frosted glass** — dual-Kawase blur of the backdrop (also blurs boxes beneath it), subject reads as a silhouette; rim light, grain, diagonal streak, edge dispersion.
6. **Data-mosh** — block-matched smear of the previous output, I-frame resets and macroblock corruption flashes; corruption moved to the display pass after the first version shredded the picture into speckle.
7. **CRT** — barrel distortion with bezel falloff, scanlines + RGB grille without moiré, bloom, misconvergence, phosphor trails.
8. **Depth map** — Turbo/Viridis/Inferno + AA isolines + fog; with the real Depth Anything V2 Small model edges follow the silhouette (`qa/depth-model-depthmap.png`); the approximate fallback is labelled in the HUD.
9. **Point cloud** — instanced additive points in cyan ribbons, orbiting camera, hand parallax, faint ground grid; closest to the reference hologram. Still slightly dotty at fine scale.
10. **Quadtree** — variance-driven mip descent, crisp 1 px borders, detail on face and hands; close to the reference.
11. **Cyanotype** — Prussian-blue → paper ramp, uneven brush edges, fibres, halation; clean.
12. **Posterize + split** — OKLab 4-level + Bayer dither, saturated chroma, motion-driven RGB split, glow. Ordered dither shows as a checker on flat bright areas; lower with the `dither` slider.

Not looked at: fine timing of the flourish at 60/120 fps (captured as stills only: `qa/flourish-*.png`).

## Real-session findings (pinchbox-session-1792642583839.json, 29 s, 860 frames, 1280×720 @ 30 fps, Integrated Camera)
- Tracking itself was fine (conf ≈1.0, 0 ID/slot switches, inference 22 ms median, unchanged while effect boxes were on screen, so visuals do not disturb tracking: the tracker reads the raw camera frame).
- Two real problems were found and fixed: (1) the LEFT hand's world-landmark pinch ratio stayed ≈0.7 during visible pinches (image ratio 0.1-0.17), so only 1 lock was found; with the image/world minimum the replay finds 9 locks; (2) the right pinch was held for 15 s while the left re-pinched, which the old "both hands must open" re-arm rule ignored.
- No `M` marks were recorded, so precision/recall for this session are not computed.
- Always-on pinch feedback (ring at the thumb/index midpoint turning green when registered + fingertip dots) is drawn above every effect box so effects cannot hide your fingers.
- The sibling project D:\TDMP\portal reached the same conclusion about pinch measurement: image-space fingertip spread / palm size (0.2-0.4 pinched, 0.8-1.2 open).

## Box tracking (how the live box follows your fingers)
- **Anchored to the fingertips.** Default `bbox4`: the box edges are the bounding box of the four fingertips (thumb + index of both hands), so every edge touches a real fingertip. (The first version used the midpoint of each hand's thumb/index pair, which sits about a hand-width away from both tips when the fingers are open.) `box: midpoints` in the debug panel restores that.
- **Light, separate fingertip filter** (`cfg.tip`: One-Euro 3 Hz / beta 0.3, plus a palm-centre track). On a real 30 fps recording this is within ~0.3 px of the raw jitter floor but has about a quarter of the lag of the skeleton filter (box RMS error vs a non-causal reference 4.0 px vs 6.3 px).
- **Shown fingertips chase their target with velocity feed-forward** at display rate: target = filtered tip + velocity × time since its measurement (capture time of the frame being shown + time since it arrived), feed-forward = tip velocity, slow drift dead-zoned (60 px/s). Position is continuous at 144 Hz (no 30 Hz steps), has no lag at constant velocity and a still hand does not creep. Simulated on the two real recordings: max step 9.9-13.7 px per 144 Hz frame (was 35-69 px with the first design), median 0.2-0.9 px.
- **Anti-collapse is per hand and follows the palm.** The moment a hand starts closing (ratio < OFF, or falling faster than 2.5/s) its fingertips are frozen as offsets from its palm centre taken 200 ms earlier, so the box neither collapses nor stays behind if you move a pinched hand; the other hand stays live; edges glide when a hand freezes/unfreezes. The locked rectangle comes from the same look-back (synthetic truth error 1-2 px with `lookBackMs` 200; 120 left ~10 px).
- Tune in `D`: box tip minCutoff/beta, look-ahead gain, follow rate.
