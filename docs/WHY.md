# "Why did you build this? What is the point? What real-world impact does it have?"

*This is the answer to the question every project gets asked. It has three layers (technical, psychological, philosophical) plus the numbers to quote and answers to the follow-up attacks. Use as much of it as the questioner needs.*

---

## 0. The 60-second spoken answer

> "We built it to answer one concrete engineering question: **can an ordinary laptop and an ordinary webcam give a person a reliable, instant, hands-only interface, running in a browser with nothing to install and no video leaving the device?**
>
> The easy part is getting an AI model to find the hand. Anyone can call a library. The hard part, and the reason this is worth studying, is everything after it: noisy data, deciding what counts as a pinch without flickering, making a box feel *attached* to your fingers instead of floaty, and doing it at the speed of the screen. We solved those one at a time using recordings of our own hands, and we can show you the numbers: the box's worst jump went from 69 pixels to 14, the average error from 6.3 pixels to 4.0, and a bug that made the left hand almost un-pinchable was found by measurement and fixed.
>
> The real-world impact is not the effects. The effects are the *demo*. The impact is a tested, open, reusable pipeline for touchless control, the same pipeline that sits behind hospital screens you cannot touch, accessibility tools, AR headsets and interactive installations, plus the fact that **we now understand, from the inside, how it works.**"

---

## 1. The question behind the question

When someone asks *"why didn't you build something worthwhile?"* they are usually asking one of four things:

| They are really asking | Our answer is in section |
|---|---|
| "Is there a real technical problem here, or did you just call a library?" | 2 (Technical) |
| "Does it matter to actual people?" | 2.4 and 3 (Real-world impact) |
| "What did *you* gain? Why this and not something bigger?" | 4 (Psychological) and 5 (Why not something bigger) |
| "Is this just a toy, or does it mean anything?" | 6 (Philosophical) |

---

## 2. The technical answer: a real engineering problem, with numbers

### 2.1 The problem we chose

> **Build a real-time gesture interface that is accurate, stable and smooth on commodity hardware, in a browser, and prove it with measurements.**

That sentence hides four hard sub-problems. Each one has a number attached to it.

| Sub-problem | Why it is hard | What we did | Measured result |
|---|---|---|---|
| **1. Trust a noisy sensor** | A hand-tracking model outputs jittery, sometimes wrong points. A face, a poster or a glitch can look like a hand | Validation gates: hand size, 18 bone-length checks, jump detection, left/right identity by continuity, ignore a third hand | **0 false locks and 0 left/right swaps** across 50 fake-hand attempts (35 real locks) with injected glitches |
| **2. Decide what a pinch is** | A single threshold flickers at the boundary; people pinch with the hands out of sync; some hands read wrong | Two thresholds (hysteresis), debounce, an armed state, per-user calibration, measure on-screen distance relative to hand size | A recording where only **1** lock was found now yields **9** after fixing one measurement |
| **3. Make the box feel attached** | Smoothing removes shake but adds lag; the fingertips move when you pinch; detection arrives about 25 ms late and at 30 Hz, while the screen refreshes at 144 Hz | Light dedicated fingertip filter, prediction from velocity, continuous display at screen rate, per-hand freeze during pinching | Average error **6.3 px to 4.0 px**; biggest jump between screen frames **69 px to about 14 px** |
| **4. Never be slow** | Heavy effects can starve the tracker or drop frames | Detection on a separate thread, frames dropped (never queued), a quality governor that lowers effect resolution first | Each effect under about 8 ms even on a weak integrated GPU; the governor degrades 12 stacked boxes in cost order (tested) |

### 2.2 Why "just use MediaPipe" is not a fair summary

MediaPipe gives us 21 numbers per hand per frame and nothing more. It does **not**:

- decide if it is really a hand (we gate it),
- keep left and right hands apart (we track identity by continuity, because MediaPipe's own left/right label flips),
- know what a pinch is (we define it, calibrate it and debounce it),
- smooth or predict (we built the filters and the display model),
- draw anything (we wrote a WebGL renderer and 12 shader effects),
- know whether it is working (we built recording, replay and measurement tools).

Counting it honestly: about **4,100 lines** of JavaScript/GLSL we wrote, **39 automated tests**, and **MediaPipe is used for exactly one function call per frame.**

### 2.3 What makes the result trustworthy rather than "it seemed to work"

A claim is only worth something if it can be checked. So we built the means to check it:

- **Fake hands with a known right answer** (`src/synthSession.js`): we can say "this session contains exactly 20 true locks" and count what the system found.
- **Record and replay**: pressing `R` on a real session saves landmark data; `node tools/replay.js file.json` re-runs the whole logic offline and prints jitter, ID switches, dropouts and locks.
- **Real recordings found bugs the fake ones never could.** The left-hand pinch failure only appeared on real hands. That is the scientific method in miniature: a hypothesis, a measurement, a surprise, a fix, a re-measurement.

### 2.4 The real-world impact, stated carefully

We do not claim this exhibit is a product. We claim something narrower, and verifiable:

1. **It is a working, open, tested template for touchless control** of the same shape used in real systems: sensor, validation, filtering, gesture decision, rendering, governor. Replace the "effects" with "scroll the patient's scan", "turn a page while your hands are wet", or "control a slide deck" and the pipeline is unchanged.
2. **It needs no installation, no special hardware and no cloud.** A browser, a webcam, a laptop. That removes the three barriers (cost, setup, privacy) that stop gesture interfaces reaching ordinary users and schools.
3. **It keeps video on the device.** Nothing is uploaded. For anything involving people's faces and homes, that is not a detail; it is the design requirement.
4. **Where touchless input genuinely helps**, honestly listed: places where touching a screen is unhygienic or impractical (clinics, kitchens, workshops), accessibility for people who cannot use a mouse or keyboard comfortably, presentations and installations, and the hand-input layer of AR/VR. These are *applications of the same technique*, not things this exhibit claims to have delivered.

The impact of an exhibit is not measured by how many people it has served yet. It is measured by **what it proves is possible, and how reusable the proof is.** Ours proves the full path from camera to polished interaction can be done by students, in a browser, with measured reliability.

---

## 3. The aim, in one defensible sentence

> **The aim of Pinch-Box is to design, build and rigorously test a real-time hands-only interface on ordinary hardware, and to document what it takes to move from "an AI model that finds a hand" to "an interface people can actually use."**

It is a **research-and-engineering question**, not a product pitch. And it has a clear success test: *Do pinches reliably lock the box, does the box stay on the fingertips, and does it stay smooth?* On our recordings and on our live camera, the answer is yes, and the numbers are above.

---

## 4. The psychological answer: why a *hands-only* interface at all

Three well-established ideas from human-computer interaction explain why this is not an arbitrary choice.

1. **The gulf of execution (Don Norman).** The gap between what a person *intends* and what they must do to the machine (menus, clicks, windows) is the main source of friction in any interface. Framing a region with your hands and pinching *is* the intention: "this part, now". The gap nearly disappears.
2. **Embodied cognition and proprioception.** People always know where their hands are without looking. Using them as the controller recruits a sense we have already trained for a lifetime, so there is almost nothing new to learn. Visitors understand it in seconds, which is the best usability test an exhibit can pass.
3. **Latency decides whether it feels alive.** Interface research has long held that below roughly 100 ms an action feels instantaneous, and well above it the system feels like a separate thing you are operating. Our detection takes about 20 to 25 ms and the box is drawn at screen rate; from pinch to lock we estimate roughly 50 to 80 ms (an estimate from our measurements, not a separate end-to-end measurement). Staying inside that window is what makes it feel like *your* hands rather than *a program*.

There is also a plainer psychological point: **delight is a legitimate engineering goal.** A system people want to use gets used, tested and improved. The ring that turns green, the flash on lock, the stack of effects: these are not decoration, they are feedback, and feedback is how people learn an interface without instructions.

And on the *builders'* side: we learned more from one hard, real, measurable problem than we would have from ten easy ones. The most valuable moment was not the effects; it was the afternoon a graph told us our assumption about 3D hand data was wrong.

---

## 5. "Why didn't you build something more worthwhile?"

This is the sharpest form of the question, so it gets a direct answer in four parts.

**1. Depth before breadth is how real engineering skill forms.** Medical software, accessibility tools and robotics all rest on the same foundations we had to master here: sensing noisy data, filtering it, making state decisions robustly, running in real time, and testing honestly. We chose the version of the problem where we could *finish, measure and understand every layer*. A larger, vaguer project would likely have ended as an unmeasured demo.

**2. A small thing done rigorously is worth more than a big thing done loosely.** "Worthwhile" is not the size of the idea; it is whether it was built and verified. Every result in this document can be re-run by anyone with `npm test` and `node tools/replay.js`.

**3. The skill transfers; the effects are the demo.** The same pipeline would drive a hands-free control for a clean-room, an exhibit for a museum, or an assistive input. Choosing visual effects gave us **instant, visible feedback on every stage**, which made hard problems debuggable. A medical-grade application would have hidden our mistakes; a colourful one displayed them.

**4. It is built to be explained.** An exhibit that visitors can try in ten seconds, and a codebase with a glossary and tests, teaches other students too. Lowering the barrier to computer vision for the next team is itself worthwhile.

---

## 6. The philosophical answer

**On interfaces.** The philosopher Martin Heidegger described tools as most themselves when they are *ready-to-hand*: when you use a hammer you think about the nail, not the hammer. The mouse, the keyboard and the menu are always *present-at-hand*: we think about them. The long direction of interface design is towards the tool disappearing. A pinch needs no learning because the "tool" is your own body. Pinch-Box is a small, concrete experiment in making the interface disappear.

**On magic and understanding.** Arthur C. Clarke observed that sufficiently advanced technology is indistinguishable from magic. Our starting point was exactly that: a video that looked like magic. The project is a deliberate act of *taking the magic apart*: it turns out to be a stack of understandable ideas (geometry, filtering, state machines, shaders), each of which can be learned. Richard Feynman's last blackboard is said to have read *"What I cannot create, I do not understand."* We created it, so we can explain every layer, and that is the opposite of using technology as a black box.

**On learning.** Seymour Papert's idea of *constructionism* is that people learn best by building something they care about that they can show to others. This is exactly that: it is the reason the project is a public exhibit, not an assignment.

**On honesty.** Part of the philosophy of the project is that we *say what we did not measure*: no formal accuracy study on many users, one laptop, one browser family. A claim that states its own limits is stronger than one that does not. That is a habit worth practising early.

---

## 7. Numbers you can quote (all from our own measurements)

| Claim | Number | How it was obtained |
|---|---|---|
| Code written by us | about **4,100 lines** (JS/GLSL, including tests and tools) | line count |
| Automated tests | **39 passing** | `npm test` |
| AI calls per frame | **1** hand-model inference, about **18 to 25 ms** | measured in recordings and benchmarks |
| Effects | **12**, each under about **8 ms** on a weak integrated GPU | `tools/bench.js` |
| False locks in fake-hand tests | **0** (20/20 and 15/15 correct locks, including injected glitches) | `tools/replay.js` |
| Left-hand pinch bug | **1 lock to 9 locks** on the same recording after one measurement fix | real recording |
| Box accuracy | average error **6.3 px to 4.0 px** | real recording, non-causal reference |
| Box smoothness | largest jump between screen frames **69 px to about 14 px** | real recordings, simulated at 144 Hz |
| Drawing rate | the screen's refresh rate (**144 Hz** on our test display) | HUD |
| Installation | **none** (web page + a local file server) | by design |
| Video uploaded | **0 bytes** | by design |

(What we did **not** measure: a formal accuracy percentage over many users and many attempts. We say so, and we explain how to measure it.)

---

## 8. Follow-up questions you will get, with answers

**"So it's just a cool demo?"**
It is a demo of a hard problem, solved and measured. The effects make the engineering visible: if the box shakes, everyone sees it. The deliverable is the reliable interaction underneath.

**"Isn't the real work done by Google's model?"**
The model does one step. The steps that decide whether the interface is usable (validation, pinch decision, smoothing, prediction, rendering, testing) are ours. Ask us what happens when the model returns a bad frame: we have a specific answer for it.

**"Who would actually use this?"**
Anyone who cannot or should not touch a screen, anyone presenting or performing, and any developer who needs a starting point for a gesture interface that already handles noise and timing. The technique, not this exact exhibit, is what has users.

**"Why not use a Kinect, a Leap Motion or a headset?"**
Because the point is that **no special hardware is needed**. A webcam exists on almost every laptop; a dedicated sensor is a cost and a barrier.

**"How do you know it works?"**
Tests with fake data where the answer is known, replays of real recordings of our hands, and a live camera. We also know where it breaks: very fast motion, hands off the edge of the picture, hand-shaped posters.

**"What would make it better?"**
A measured study with many volunteers, automatic per-user calibration, a second-stage fingertip refiner, and more gestures. These are listed in the README.

**"What did you personally learn?"**
That the model is the easy part; that "it feels good" is not a measurement; that real data beats assumptions; and that an interface is finished only when a stranger can use it without being told how.

---

## 9. A closing line, if you want one

> "We did not build this to make effects. We built it to find out what it really takes to turn a machine-learning demo into an interface a stranger can use in ten seconds, and to be able to prove, with numbers, that we got there. The effects are how you can *see* that we did."
