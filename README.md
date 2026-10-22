# Pinch-Box

### Draw a box in the air with your hands. Pinch to lock it. Watch your own video turn into art.

*A real-time, hands-only creative tool that runs entirely in a web browser: no controller, no mouse, no cloud.*

> **Team / school / class / year:** `[fill in before the exhibition]`
> **Exhibit status:** working on a laptop webcam, tuned on real recordings of our own hands.

---

## Contents

1. [The project in 30 seconds](#1-the-project-in-30-seconds)
2. [What you can do with it (for visitors)](#2-what-you-can-do-with-it-for-visitors)
3. [Why we built it](#3-why-we-built-it)
4. [What it teaches us](#4-what-it-teaches-us)
5. [How it works, step by step](#5-how-it-works-step-by-step)
6. [Architecture](#6-architecture)
7. [The 12 effects, explained simply](#7-the-12-effects-explained-simply)
8. [Problems we hit and how we solved them](#8-problems-we-hit-and-how-we-solved-them)
9. [What we measured (and what we did not)](#9-what-we-measured-and-what-we-did-not)
10. [Running it](#10-running-it)
11. [Exhibition guide: setup, demo script, Q&A](#11-exhibition-guide-setup-demo-script-qa)
12. [Troubleshooting](#12-troubleshooting)
13. [Privacy](#13-privacy)
14. [Limits and honest caveats](#14-limits-and-honest-caveats)
15. [Where this idea goes next](#15-where-this-idea-goes-next)
16. [Project layout](#16-project-layout)
17. [Glossary](#17-glossary)
18. [Credits and licences](#18-credits-and-licences)

---

## 1. The project in 30 seconds

You stand in front of a webcam and hold both hands up with thumb and index finger open. A **rectangle appears between your hands** and follows your fingertips. When you **pinch with both hands**, the rectangle **locks in place** and an **effect starts running inside it on the live video** (an ink drawing, a TV glitch, a 3D point cloud, ...). Do it again and a **new box stacks on top**, each with the next effect. You can build a layered artwork of up to 12 effects using nothing but your hands.

| | |
|---|---|
| **Input** | Your hands, seen by an ordinary webcam |
| **Output** | Your own live video with up to 12 stacked, GPU-rendered effects |
| **Runs on** | A normal laptop in Chrome or Edge. It is a web page; Node.js is only needed to start the small local server |
| **Artificial intelligence used** | A hand-landmark model (Google MediaPipe) finds 21 points on each hand; an optional depth model (Depth Anything V2 Small) feeds two effects |
| **Everything else** | Written by us: hand validation, smoothing, gesture logic, box tracking, a WebGL renderer and 12 shader effects |
| **Size** | About 4,100 lines of JavaScript/GLSL and 39 automated tests |

---

## 2. What you can do with it (for visitors)

1. **Stand about one metre from the screen** with light in front of you (not behind you).
2. Raise **both hands**, palms toward the camera, **thumb and index finger spread open** (like two "L" shapes). A thin white rectangle appears and follows your fingertips.
3. **Pinch** thumb-to-index with **both hands**. The box flashes and locks, and the first effect starts inside it.
4. Open your hands, move them somewhere else and **pinch again** for a second box on top, with the next effect.

| Key | What it does | Key | What it does |
|---|---|---|---|
| `U` | undo the last box | `Esc` | clear everything |
| `D` | **debug panel**: shows what the computer "sees" | `S` | draw the hand skeleton |
| `C` | calibrate the pinch to your hand | `F` | fullscreen |
| `Space` | pause hand tracking | `P` | next preset of the last box |
| `R` | record a session (press again to save) | `M` | mark a lock attempt while recording |

A small **ring** appears between each hand's thumb and index tip. It shrinks as you close your fingers and turns **green** when the computer has registered the pinch. It is drawn on top of every effect, so you always get feedback even when an effect hides your fingers.

---

## 3. Why we built it

**The spark.** We saw a short screen recording of a TouchDesigner project (a professional visual-programming tool): a person holds up two hands, a box stretches between them, a pinch locks it, and a different filter lives in each box. It looked like magic. We wanted to find out *what is actually behind the magic*, and whether we could rebuild it ourselves **without** that software, so that it would run on any laptop with just a browser.

**The goals we set ourselves, in priority order:**

1. **Tracking must be accurate and stable.** The box has to stick to your fingertips and never lock by accident. A cool effect is worthless if the interface feels unreliable.
2. **It must be smooth.** The picture is drawn at the screen's refresh rate (60 to 144 times a second) and must never wait for the slower hand-detection step.
3. **The effects must look good**, but if the computer gets overloaded, effect quality is lowered *before* tracking or smoothness suffer.

**The point of the project** is not only the demo. It is an exercise in building something **real-time, interactive and measurable**, and in learning, by hitting real problems, how computer vision, signal processing, graphics and software testing fit together. Section 4 lists exactly what it teaches.

> **Asked "what is the point / what is the real-world impact?"** Read [`docs/WHY.md`](docs/WHY.md): a layered answer (technical, psychological, philosophical) with the numbers to quote and replies to the hard follow-up questions.

---

## 4. What it teaches us

Each row names an idea, what it means in this project, and the file to open if you want to see the code.

| Idea | What it means here | Where |
|---|---|---|
| **Machine learning inside a product** | A neural network does *one* job (finds 21 points per hand). Everything around it is ordinary engineering. Knowing where AI helps and where it does not is the lesson | `src/tracker.worker.js` |
| **Computer vision geometry** | The camera image is mirrored for display but must **not** be mirrored for the model. Distances must be measured relative to the hand's own size, or a far hand and a near hand would behave differently | `src/handTrack.js` |
| **Not trusting noisy data** | The model sometimes returns garbage (a face, a poster, a glitch). We treat its output as *evidence*, not truth, and check it: size, bone lengths, sudden jumps, identity tracking | `src/handTrack.js` |
| **Signal processing** | Every measurement jitters by about 1 pixel. Smooth too much and the box lags (feels "floaty"); too little and it shakes. We used the **One-Euro filter**, which smooths slow motion and lets fast motion through | `src/filters.js` |
| **State machines and hysteresis** | "Is the hand pinching?" cannot be a single `if`: it would flicker at the threshold. We use two thresholds (ON and OFF), debouncing, an "armed" state and a refractory period | `src/gesture.js` |
| **Latency and real-time systems** | The camera runs at 30 frames per second, the screen at up to 144. Detection takes about 25 ms. We drop frames instead of queueing them, run detection on another thread, and let the display *predict* where your fingers are now | `src/main.js`, `src/camera.js` |
| **Computer graphics and the GPU** | Every effect is a small GPU program (a *shader*) running on millions of pixels at once. Linear-light colour, off-screen buffers, a history of the last 96 frames, compositing | `src/render.js`, `src/effects/` |
| **Performance engineering** | A *governor* watches frame times and lowers effect resolution, most expensive box first, when the machine struggles. It never touches tracking | `src/governor.js`, `src/pipeline.js` |
| **Testing and measurement** | We generate fake hands with a known right answer, replay real recordings of our own hands, and report numbers (jitter, lag, false locks) instead of "it feels good" | `test/`, `tools/replay.js` |
| **Debugging from real data** | Real recordings showed problems that no simulation predicted (Section 8). The lesson: record real sessions early | `tools/replay.js` |
| **Human factors** | People pinch with their hands out of sync, move while pinched, and cannot see their fingers under an effect. The design had to forgive this and give clear feedback | `src/gesture.js`, feedback ring in `src/render.js` |
| **Privacy by design** | Video is processed on the device; nothing is uploaded (Section 13) | whole project |
| **Building on open source, with credit** | MediaPipe and an open depth model do the hard AI parts, and we credit them (Section 18) | |

---

## 5. How it works, step by step

Think of the program as a relay race. A frame of video passes through these stations, about 30 times a second:

```
 webcam frame
     |
     v
 1. FIND THE HANDS      a neural network (MediaPipe) marks 21 points on every hand
     |                  (wrist, each knuckle, each fingertip)
     v
 2. CHECK THE ANSWER    is it really a hand? right size? bones the right length?
     |                  is it the same hand as last frame? (identity by continuity)
     v
 3. SMOOTH THE TIPS     a light filter on the 4 fingertips that make the box
     |
     v
 4. READ THE GESTURE    thumb-to-index distance / hand size = the "pinch ratio"
     |                  small = pinched.  Both hands pinched  ->  LOCK
     v
 5. DRAW                (a separate loop, 60 to 144 times a second)
                        video -> each locked box runs its effect on the GPU, stacked
                        -> live box follows your fingertips -> feedback ring on top
```

**The pinch ratio** is the heart of the gesture. We measure the distance between thumb tip and index tip *in units of the hand's own size*. An open "L" hand gives roughly 0.7 to 1.3; a pinch gives roughly 0.1 to 0.2. Because it is relative to hand size, it works the same for a child's or an adult's hand, near or far.

**Why the box does not collapse when you pinch.** Closing your fingers moves the very fingertips the box is attached to. So the moment a hand starts closing, the box *remembers* where that hand's fingertips were just before (relative to the palm, so it still follows if you move your hand) and ignores the collapse. The locked rectangle is taken from about 200 ms *before* the pinch began.

---

## 6. Architecture

### 6.1 The big picture

```
+------------------------------ browser tab -----------------------------+
|                                                                        |
|  camera.js --frame--> tracker.worker.js  (background thread)           |
|  (30 fps)             MediaPipe HandLandmarker, GPU delegate           |
|     |                     | 21 image + 21 world points per hand        |
|     |                     v                                            |
|     |               handTrack.js    validate, identity, gates,           |
|     |                     |         light fingertip filters            |
|     |                     v                                            |
|     |               gesture.js      pinch ratio, hysteresis,           |
|     |                     |         look-back, box stack, lock         |
|     |                     v                                            |
|     +---video--->  main.js  render loop (every display refresh)        |
|                        |                                               |
|            pipeline.js | render.js -- 12 shader effects (GPU)          |
|            governor.js v                                               |
|                    <canvas>  +  hud.js (numbers, sliders)              |
|                                                                        |
|  depth.worker.js  (only while a depth effect is in use)                |
+------------------------------------------------------------------------+
```

### 6.2 Design rules we followed

- **Detection never blocks drawing.** Detection runs in a *worker* (another thread). If it is busy, new camera frames are *dropped*, never queued, because queueing creates lag and dropping does not.
- **Pure logic is separated from the screen.** `filters.js`, `handTrack.js`, `gesture.js` and `governor.js` contain no browser or graphics code, so they run in plain Node.js and can be unit-tested and replayed from recordings.
- **Two signal paths for two jobs.** The *display* path (box corners) is lightly smoothed and predicts forward. The *decision* path (is it a pinch?) is smoothed more and uses hysteresis. A jittery decision causes false locks; a laggy display feels broken. They must not share settings.
- **Nothing is allocated in the render loop**, so the browser's garbage collector never causes a stutter.
- **Everything is measurable.** The debug panel shows live numbers; sessions can be recorded and replayed offline.

### 6.3 The modules

| File | Job |
|---|---|
| `src/camera.js` | Opens the webcam (or a video file) and timestamps every frame |
| `src/tracker.worker.js` | Runs the MediaPipe model off the main thread |
| `src/handTrack.js` | Validates detections, keeps hand identity (left/right) by continuity, filters fingertips, computes the pinch ratio |
| `src/filters.js` | One-Euro filter and helpers |
| `src/gesture.js` | The gesture state machine, per-hand pinch freeze, box stack, calibration |
| `src/render.js` | WebGL2 renderer: camera texture, 96-frame history, box compositing, flourish, overlays |
| `src/pipeline.js`, `src/governor.js` | Per-box GPU targets; the quality governor |
| `src/effects/*.js` | The 12 effects (GLSL shader + parameters + 3 presets each) |
| `src/depthProvider.js`, `src/depth.worker.js` | Shared depth map: AI model, or an approximate fallback |
| `src/hud.js`, `src/main.js` | Debug panel; wiring and the render loop |
| `src/synthHand.js`, `src/synthSession.js` | Fake hands and fake sessions with known truth, for tests |
| `tools/` | Local server, replay/measurement, visual QA, end-to-end tests, benchmark |

### 6.4 How a box is drawn

1. The camera frame is uploaded to the GPU once per frame and also copied into a ring buffer of the last 96 frames (some effects look back in time).
2. For each locked box, in order, its effect shader renders into the box's own off-screen image.
3. That image is composited onto everything beneath it through a rounded-rectangle mask with a soft edge, shadow, and the lock flourish animation.
4. Boxes can see what is below them (the frosted-glass box blurs the boxes beneath it).
5. Last: the live outline, the feedback ring, then a colour conversion with dithering to avoid banding.

A deeper technical write-up with parameters and measurements is in [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

---

## 7. The 12 effects, explained simply

Every effect runs on the GPU and is written from scratch for this project. Locks pick them in this order (the order can be changed).

| # | Effect | What you see | The idea behind it |
|---|---|---|---|
| 1 | **Edge sketch** | Your face as an ink drawing on paper | Finds where brightness changes sharply (edges) at two scales and draws them as lines, with faint hatching and a colour fringe |
| 2 | **Slit-scan** | Your movement smears into flowing ribbons | Each pixel shows a *different moment in time* from the last 96 frames; two frames are blended so there are no steps |
| 3 | **Moire** | Rippling interference patterns that follow your face | Overlays fine line patterns at slightly different angles; where they beat against each other, waves appear |
| 4 | **Pixel sorting** | Bright areas melt into streaks | A real sorting algorithm (odd-even transposition) runs on the GPU and sorts pixels by brightness inside bands |
| 5 | **Frosted glass** | A pane of etched glass; you are a soft silhouette behind it | Blurs *everything beneath the box* (including earlier boxes), with grain, a shiny rim and a light streak |
| 6 | **Data-mosh** | Digital glitch: parts of the picture smear and freeze | Imitates broken video compression: finds motion in 8x8 blocks and drags the *old* picture along instead of showing the new one, until a "keyframe" resets it |
| 7 | **CRT** | An old curved TV | Barrel distortion, scanlines, RGB phosphor mask, glow, colour bleed, afterglow |
| 8 | **Depth map** | You in rainbow colours by distance | An AI model estimates how far each pixel is; mapped to colours with contour lines and fog |
| 9 | **Point cloud** | A glowing 3D hologram made of thousands of dots | Uses the same depth to place points in 3D, seen by a gently orbiting camera that reacts to your hands |
| 10 | **Quadtree pixelation** | Big blocks where nothing happens, tiny blocks around your face and hands | Splits the picture into squares and keeps splitting only where there is detail |
| 11 | **Cyanotype** | A blue-and-white sun-print photograph | Maps brightness to a Prussian-blue-to-paper ramp with paper fibres and uneven brush edges |
| 12 | **Posterize + split** | Flat poster colours with red/green/blue ghosts | Reduces to 4 levels with an ordered dither; the colour channels drift apart *more when you move fast* |

Each effect has sliders (press `D`) and three presets (`P`). Screenshots of every effect are in `qa/`.

---

## 8. Problems we hit and how we solved them

These are the real stories of the project, and the best things to tell visitors: each one is something a simulation did not predict and real recordings revealed.

### 8.1 "The right hand pinches, the left hand does not"
**Symptom:** locks almost never happened. **Investigation:** we recorded our own hands and replayed the recording. For the left hand the model said thumb and index tips were 6 to 7 cm apart *in depth* while on screen they were clearly touching. MediaPipe's 3D ("world") estimate was wrong for that pose, but its on-screen positions were right. **Fix:** measure the pinch from the on-screen distance (taking the smaller of the 2D and 3D values). Locks found in the same recording went from 1 to 9. **Lesson:** do not trust a clever measurement just because it is "more 3D"; check it against real data.

### 8.2 "The box feels floaty and drifts away from my fingers"
**Causes found and fixed:**
1. The box corners were the *midpoint* between thumb and index tips, about a hand-width away from both when the fingers are open. Now the box edges touch the four real fingertips.
2. The filter that removed jitter also added lag. A still hand only jitters about 1 pixel, so heavy smoothing was mostly harm. A separate, light filter now handles the four box-making fingertips; on a real recording it cut the average error from 6.3 px to 4.0 px.
3. The display moved in 30-per-second steps. The shown fingertips now move continuously at screen rate, steered by the measured finger velocity.
4. When you started to pinch, the box snapped back to where it was. Now each hand freezes relative to its palm.
5. After a detection gap, a stale speed kept pushing the box. The speed now decays during gaps and the catch-up speed is capped.

On our recordings the biggest jump of the box between two screen frames went from **69 px to about 14 px**.

### 8.3 "I held one pinch and re-pinched with the other hand, nothing happened"
The first rule needed *both* hands to open between locks. Real users keep one hand pinched. One hand opening for a quarter of a second is now enough to re-arm (a switch restores the strict rule).

### 8.4 "Effects hide my fingers, so I cannot tell if the pinch worked"
We confirmed tracking is not affected by effects: it reads the raw camera image, and inference time stayed about the same with or without effect boxes on screen. The real problem was *feedback*, so we added the always-on ring.

### 8.5 A false lock from a hand that "re-appears already pinched"
A hand that drops out and returns closed could complete a lock. A pinch now only counts if that hand was seen **open** first.

### 8.6 Other things worth mentioning
- A "third hand" in the background is ignored: at most two hands are tracked, a clearly larger hand replaces a small one, and the two hands' sizes must agree.
- An old saved calibration from before the fix gave wrong thresholds; calibrations are now versioned.
- Shader compilation could stall the first lock of an effect; all effects are now pre-compiled at start-up.
- The 96-frame video history is stored as plain 8-bit data with manual colour encoding, because the "automatic" format returned wrong colours on one graphics driver.

---

## 9. What we measured (and what we did not)

We tried to be scientific. Numbers below are from our own laptop (Windows 11, NVIDIA RTX 4050 plus Intel UHD graphics, Edge). Full tables are in [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

| What | Result |
|---|---|
| Automated tests | **39 pass** (filters, gates, gesture rules, governor, replay metrics, a regression test on real hand data) |
| Hand model speed | about **18 ms** per frame on the NVIDIA GPU; 22 to 25 ms in real sessions; 42 ms on the integrated GPU |
| Camera | 30 frames per second, 1280x720 |
| Drawing | at the screen's refresh rate (144 Hz on our test screen) |
| Effect cost | each effect under about 8 ms on the weak integrated GPU; all 12 stacked is more than that GPU can hold, so the governor lowers box resolution (tested) |
| Fake-hand tests (known truth) | 20 of 20 and 15 of 15 locks, **0 false locks**, 0 left/right swaps, including injected glitches |
| Real recordings of our hands | used to find and fix the problems in Section 8; after the fixes it worked on the live camera |
| Box smoothness | largest jump between screen frames reduced from 69 px to about 14 px on our recordings |

**What we did not measure:** a formal accuracy figure on real hands. A proper test would be 20 or more deliberate attempts with a mark after each (the `R` and `M` keys do this) followed by `node tools/replay.js file.json`. Our judgement that it works well comes from using it, not from that statistic. We also did not test other browsers, a 60 fps webcam, or many different people's hands.

---

## 10. Running it

You need **Node.js** (a recent version) and **Chrome or Edge**.

```bash
npm install        # one time: installs the pinned MediaPipe package + test tooling
npm run setup      # one time: copies MediaPipe to vendor/ and downloads the hand model to models/
npm start          # starts the local server
```

Open **http://localhost:8080** and allow the camera.

After setup, **hand tracking works with no internet**. The *depth model* (effects 8 and 9) is downloaded from the internet the first time it is needed (a few tens of MB) and then cached. Without internet those two effects use an *approximate* depth and say so in the corner of the screen.

| URL | Purpose |
|---|---|
| `/?debug=1` | open with the debug panel |
| `/?src=fixtures/sample.mp4` | run a video file instead of the camera |
| `/?fake=1` | **no camera needed**: synthetic hands drive everything (a good backup demo) |
| `/?effect=5` | show one effect on its own |

### What is not in the git repository

To keep the repository small and free of other people's media, these are **generated or supplied locally**:

| Folder | What | How to get it |
|---|---|---|
| `vendor/`, `models/` | MediaPipe runtime, hand model, depth model and its runtime | `npm install` then `npm run setup` (downloads them) |
| `fixtures/` | A short test video (`fixtures/sample.mp4`) used by `?src=`, `?fake=1` demo mode, the QA tool and one regression test | Put any short video of a person at `fixtures/sample.mp4`. Without it the demo mode and `tools/qa.js` need your own `--src`, and the real-landmark regression test is skipped |
| `qa/` | Screenshots of every effect, benchmark output | `node tools/qa.js`, `node tools/bench.js` |
| `dist/` | The Windows exe | `npm run dist` |

### The plug-and-run desktop app (Windows .exe)

For the exhibition you do not need Node.js, a browser or an internet connection: **`Pinch-Box.exe`** is a single file that contains the app, a private Chromium window, the hand model **and** the depth model.

- Copy it to any Windows 10/11 64-bit PC with a webcam and double-click (about 5 seconds to open). `Pinch-Box-small.exe` is the same app compressed (about 120 MB, opens in about 10 seconds).
- It forces the **fastest GPU** (on laptops with two graphics chips it uses the discrete one), is **locked to the monitor's refresh rate** (60/75/120/144/165 Hz, re-measured if you move the window to another screen) and lowers effect quality before it ever lets tracking or smoothness suffer.
- `Pinch-Box.exe --demo` runs with synthetic hands (no camera). If no camera is found, press Enter for the same demo.
- Windows may show a SmartScreen warning because the exe is not code-signed: *More info > Run anyway*.
- Build it yourself: `npm install`, `npm run setup`, `npm run dist` (output in `dist/`). Run it from source with `npm run app`. `npm run selftest` writes GPU / refresh-rate / fps facts to `qa/selftest.json`.

Tools:

```bash
npm test                              # 39 automated tests
node tools/replay.js session.json     # measure a recorded session
node tools/qa.js                      # screenshot all 12 effects into qa/
node tools/bench.js                   # GPU cost per effect
node tools/e2e.js                     # end-to-end run with synthetic hands
```

---

## 11. Exhibition guide: setup, demo script, Q&A

### 11.1 What to bring
- A laptop with a webcam (an external USB webcam at 30+ fps is even better) and, ideally, a **dedicated GPU**.
- An **external monitor or TV** so visitors can see the screen while standing back.
- Chrome or Edge, up to date, and Node.js installed.
- A plain background. Light **in front of** the person, not behind.

### 11.2 Setting up (15 minutes before opening)
1. Set the browser to use the **high-performance GPU** (Windows: *Settings > System > Display > Graphics*, add Edge/Chrome, choose *High performance*). On our laptop this made hand detection 2 to 3 times faster.
2. Run `npm start`, open `http://localhost:8080/?debug=1`, allow the camera.
3. Check the top line of the debug panel: **capture at least 25 fps** and **inference under about 30 ms**.
4. Stand one metre away with both hands in view. If pinches feel off, press **`C`** and follow the two prompts (hold a hand open for 1.5 s, then pinch firmly for 1.5 s).
5. Press `D` to hide the panel and `F` for fullscreen.
6. Keep **`/?fake=1`** ready in a second tab as a no-camera backup.
7. Do not aim the camera at a crowd or at posters of hands.

### 11.3 A 30-second pitch
> "This is **Pinch-Box**. You make a frame with your hands, pinch, and the frame locks and applies an effect to your live video. Repeat to stack effects. It runs in a web browser with just a webcam. A neural network finds the 21 points on each hand; everything else (the gesture logic, the smoothing, the box tracking, the 3D graphics and all 12 effects) we wrote ourselves."

### 11.4 A 3-minute walk-through
1. **Let them try it** (30 s). Ask for two open "L" hands, then a pinch. The ring turns green.
2. **Press `S`:** "These are the 21 points the AI finds on each hand."
3. **Press `D`:** "This is the computer's view: pinch ratio, confidence, and whether each hand is trusted. When it says *lock ready*, a pinch will lock." Show the numbers changing as someone pinches.
4. **Show two contrasting effects:** Edge sketch (#1) and Point cloud (#9). "The point cloud is made from a depth map estimated by a second AI model from a single ordinary camera."
5. **Tell one problem story** from Section 8: the left-hand story (8.1) or the floaty box (8.2).
6. **Finish with:** "The real work was not the AI. It was filtering noise, deciding what counts as a pinch, and testing with real recordings."

### 11.5 Tailoring it to the visitor
- **Younger visitors:** let them play; the ring and the flash are the reward.
- **Teachers:** talk about testing, measuring, and fixing real bugs from recordings.
- **Technical visitors:** open `D`, then show `docs/TECHNICAL.md`, the replay tool and the tests.

### 11.6 Likely questions and honest answers

**Is this AI?**
Partly. A neural network (MediaPipe) finds hand points, and a second model estimates depth for two effects. The gesture recognition, tracking, smoothing and graphics are ordinary algorithms we wrote.

**Did you train the AI?**
No. We used Google's pre-trained MediaPipe model and an open depth model. Our work was everything around them, which is most of what makes the interface usable.

**Does it record me or send my video anywhere?**
No. Processing is on the laptop. The only thing that touches the internet is the optional first-time download of the depth model. Recording only happens if someone presses `R`, and it saves hand landmark numbers (not video) to a file on the computer.

**Why a web browser?**
Nothing to install for the user, it runs on any laptop, the browser gives direct access to the camera and the GPU, and the video never has to leave the device.

**How accurate is it?**
We tuned it using recordings of our own hands and tests with fake hands where the right answer is known. We have not run a formal accuracy study with many users, and we say so (Section 9).

**How can it work out depth from one camera?**
It cannot measure real distance. A trained model *estimates* which things are nearer than others from visual clues (size, perspective, shading). It gives relative depth, not centimetres.

**Why does the box not follow my fingers at the exact moment I pinch?**
Pinching moves the fingertips the box is attached to, so we freeze each hand's fingertips (relative to the palm) at the start of the closing motion. Otherwise the box would collapse every time you lock.

**What happens with two people?**
Only two hands are tracked. Other hands are ignored, and the two hands' sizes must be similar so a distant stranger's hand does not make a box with yours.

**Does it work in the dark or with gloves?**
Poorly in the dark (the model needs to see the hand). Plain gloves are usually fine; very busy backgrounds can confuse it.

**Why 12 effects?**
Each shows a different graphics idea: edge detection, time sampling, interference, sorting, blur, video compression, display physics, depth, 3D points, adaptive subdivision, tone mapping and quantisation.

**What was the hardest part?**
Making the box feel *attached*: a balance between jitter, lag and prediction that we could only get right by recording real sessions and measuring.

**What would you do next?**
See Section 15.

---

## 12. Troubleshooting

| Problem | Likely cause and fix |
|---|---|
| "Camera permission was denied" | Click the camera icon in the address bar, allow it, reload |
| "No camera was found" / "in use by another application" | Plug the camera in or close other apps using it (Zoom, Teams) |
| Banner says the hand model failed to load | Run `npm run setup` once (needs internet to fetch the model), then reload |
| Banner: "GPU delegate failed ... using CPU" | Works but slower; update graphics drivers and use Chrome or Edge |
| Pinches rarely register | Press `D` and watch **pinch r** for each hand. Use `C` to calibrate. Add front light |
| Box jumps or disappears | Keep both hands inside the frame (not off the bottom edge); avoid very fast moves |
| Debug line says `NOT LOCKING: ...` | It names the exact reason (waiting for a pinch, hand not trusted, box too small, not armed, ...) |
| Picture is choppy | Press `D` and read the render fps. Make sure the browser uses the dedicated GPU; the governor also lowers box resolution |
| Depth effects look "approximate" | No internet for the first-time depth model download; connect once and reload |
| Everything feels wrong | Press `D`, click **reset tuning**, then `C` to calibrate again |

---

## 13. Privacy

- The camera image is processed **only inside your browser on your own computer**. No server receives video. The local server only hands the web page its files.
- The hand model is stored on disk in `models/`. The depth model, if used, is fetched from public hosting once and cached by the browser; no video is sent when it downloads.
- **Recording is opt-in.** Pressing `R` saves hand *landmark numbers* (21 points per hand with timestamps), **not the video**, to a file you download.
- `fixtures/sample.mp4` is a short clip cut from the reference recording that inspired the project and contains a real person. It is used only for testing. **Remove or replace it before publishing the project anywhere public.**

---

## 14. Limits and honest caveats

- Works best with front lighting and a plain background; palms toward the camera, both hands inside the frame.
- Hand-shaped **photos or posters** look like hands to the model.
- Fast movements can drop detection for a few frames; the box smooths over it but cannot see through it.
- A hand leaving the picture (for example off the bottom edge) cannot be tracked.
- Tested with our own hands and a few recordings, on one laptop and the Chrome/Edge browser family. Other users, browsers and cameras are untested.
- Depth is **relative**, not metric, and is only as good as the model's guess.
- Not built: an optional second-stage fingertip refiner (the hook for it exists in `handTrack.js`).
- The "99 %" accuracy figure from our original brief is a target we did not formally measure on real data (Section 9).

---

## 15. Where this idea goes next

- **Touchless interfaces:** kiosks, hospitals or kitchens where touching a screen is inconvenient or unhygienic.
- **Accessibility:** alternatives to mouse and keyboard for people who cannot use them.
- **AR/VR and installations:** the same pipeline (find hands, stabilise, read the gesture, draw) underlies hand input in headsets and interactive art.
- **Creative tools:** let a photographer or VJ pick a region and a look with their hands instead of menus.
- **Improvements we would try:** a second-stage fingertip refiner; learning the pinch thresholds per user automatically; two-person mode; more gestures (swipe to change effect); saved presets for exhibitions; a measured accuracy study with many volunteers.

---

## 16. Project layout

```
pinch-box/
|-- index.html              the page
|-- src/                    the app (see Section 6.3)
|   `-- effects/            the 12 effects
|-- test/                   39 automated tests (node --test)
|-- tools/                  server, setup, replay, QA, e2e, benchmark
|-- docs/TECHNICAL.md       deep technical write-up and measurements
|-- models/                 hand_landmarker.task (downloaded by setup)
|-- vendor/mediapipe/       MediaPipe runtime (copied by setup)
|-- fixtures/               test video + recorded hand landmarks
`-- qa/                     screenshots of every effect, benchmark results
```

---

## 17. Glossary

| Word | Meaning |
|---|---|
| **Landmark** | A named point on the hand (for example "index fingertip"). MediaPipe finds 21 per hand |
| **Inference** | Running a trained neural network on new data (one camera frame) to get an answer |
| **Frame** | One still image of the video. 30 per second from the camera, up to 144 per second drawn |
| **Latency** | The delay between something happening and seeing the result |
| **Jitter** | Tiny random shaking of a measurement even when nothing moves |
| **Filter (smoothing)** | A formula that removes jitter, at the cost of some lag |
| **One-Euro filter** | A filter that smooths slow motion heavily and fast motion lightly |
| **Hysteresis** | Using two thresholds (turn ON low, turn OFF high) so a state does not flicker |
| **State machine** | A program that is always in one named state (idle, pinching, locked, ...) and moves between states by rules |
| **GPU** | The graphics chip, which runs thousands of small calculations at once |
| **Shader** | A tiny program that runs on the GPU for every pixel |
| **WebGL** | The browser's way to use the GPU for graphics |
| **Worker** | A background thread in the browser so slow work does not freeze the page |
| **Depth map** | An image where each pixel's value says how near or far that spot is |
| **Governor** | Our component that lowers effect quality when the computer is overloaded |
| **Calibration** | A 3-second step that teaches the program what an open and a pinched hand look like for *you* |

---

## 18. Credits and licences

**Built with**
- **MediaPipe Tasks Vision** (Google, Apache-2.0): hand landmark detection (v1.1.1, model `hand_landmarker.task`).
- **Depth Anything V2 Small** (Apache-2.0), run in the browser with **Transformers.js** (Hugging Face, Apache-2.0): depth for effects 8 and 9. (The larger Depth Anything checkpoints are non-commercial and were deliberately not used.)
- **Playwright** (Microsoft, Apache-2.0): used only for our automated tests and screenshots.

**Ideas and published methods we implemented**
- The **One-Euro filter**: Casiez, Roussel and Vogel, *"1 Euro Filter: a simple speed-based low-pass filter for noisy input in interactive systems"*, CHI 2012.
- **OKLab** colour space (Bjorn Ottosson); **Turbo, Viridis and Inferno** colour maps (polynomial approximations).
- **Dual-Kawase blur** (frosted glass), **odd-even transposition sort** (pixel sorting), **block matching / sum of absolute differences** (data-mosh), **quadtree subdivision**, **Bayer ordered dithering**.

**Inspiration**
- A TouchDesigner screen recording showing two-hand box locking, which we recreated from scratch in a browser. No code or assets from that project are used apart from the short test clip described in Section 13.

**Our own work:** hand validation and tracking logic, filtering and prediction, the gesture state machine, per-hand pinch freeze, the box-tracking display, the WebGL renderer, all 12 effect shaders, the quality governor, and the testing, recording and replay tools.

**Team:** `[names]`  ·  **Teacher / mentor:** `[name]`  ·  **School / class:** `[name]`  ·  **Year:** `[year]`
