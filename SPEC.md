# ReLuminate — Audio-First Minigame (MVP)
## Build prompt for Claude Code

> **How to use this file:** fill in every `[FILL IN: ...]` marker below, then paste the whole
> document into Claude Code as the opening message, or save it in the repo root as
> `SPEC.md` and tell Claude Code to read it first.

---

## 0. Fill these in before starting

| Field | Value |
|---|---|
| Repo name | `ReLuminate-Echo` |
| Game title (spoken aloud in-game) | `ReLuminate Echo` |
| Deploy target | `play.reluminate-global.org via GitHub Pages` |
| Brand hex — blue | `#2a5190` |
| Brand hex — green | `#9cc383` |
| Brand hex — red/coral | `#d95b52` |
| Hard deadline for a deployed, playable build | `2026-09-24` |

---

## 1. Context

I am building a browser-based, audio-first minigame for ReLuminate, a youth initiative
making games playable by blind and low-vision players. This is a competition submission
(Global Goals Challenge 2026, deadline **30 September 2026**), so the build must be
finished, deployed and demo-ready well before then.

The game will be played on camera **with the monitor switched off**. That single fact
drives every requirement below: it must be fully playable using headphones and a keyboard
alone, with no visual information whatsoever.

The repo is public and MIT-licensed. Code quality matters because reviewers will read it.

---

## 2. Hard constraints

- **Stack:** Vite + TypeScript. No game engine, no React, no UI framework.
- **Runtime dependencies: zero.** Dev dependencies (Vite, TypeScript, linter) only.
- **No audio asset files.** Every sound is synthesised at runtime with the Web Audio API.
  This is deliberate — it removes all asset-licensing risk and makes sound parameters
  tunable at runtime.
- **Binaural audio via `PannerNode` in `HRTF` mode.** Do not use any platform spatial-audio
  API, and never describe this as "spatial audio" in code comments or UI text — the correct
  term is *binaural audio*, and it must work on any ordinary stereo headphones.
- **Keyboard only.** No mouse handlers, no pointer events, no touch-only controls anywhere.
- **Must run from a static file host.** No server, no build-time secrets, no backend.
- **Target:** current Chrome, Firefox and Safari, desktop first.

---

## 3. Scope

### In scope for v0.1 (build this and stop)

1. One minigame: **beacon hunt in a dark arena** (spec in §5).
2. The binaural audio engine (§6).
3. Spoken onboarding, menus and state announcements (§7).
4. A 2D radar view for sighted viewers (§8) — for the demo video, not for gameplay.
5. Telemetry logging to `localStorage` (§9), with an adaptive-difficulty *interface* stubbed
   but not implemented.

### Explicitly out of scope — do not build unless I ask

- Any second game mode or mechanic
- Multiplayer, accounts, login, backend, database
- Any LLM or network API call
- Elevation / vertical positioning (generic HRTFs localise elevation poorly)
- Reverb, occlusion, room simulation, Doppler
- Mobile-specific UI, PWA manifest, service worker
- Music, soundtrack, voice acting
- Animations or visual effects beyond the radar view
- Settings menus beyond the three toggles listed in §7

If you find yourself about to add something not listed in "in scope", stop and ask.

---

## 4. Repo structure

```
/
├── index.html
├── src/
│   ├── main.ts              # bootstrap, resume AudioContext, wire modules
│   ├── audio/
│   │   ├── context.ts       # AudioContext singleton, master gain, listener wrapper
│   │   ├── source.ts        # pooled binaural source (osc → gain → filter → panner)
│   │   ├── cues.ts          # target / hazard / wall / ping / tick sound definitions
│   │   └── speech.ts        # Web Speech API wrapper + announcement queue
│   ├── game/
│   │   ├── state.ts         # game state machine
│   │   ├── world.ts         # arena, entity spawning, collision
│   │   ├── player.ts        # position, heading, movement
│   │   ├── loop.ts          # fixed-step update loop
│   │   └── difficulty.ts    # STUB in v0.1: exported interface + constant defaults
│   ├── ui/
│   │   └── radar.ts         # canvas top-down view (sighted viewers only)
│   ├── telemetry.ts
│   └── config.ts            # ALL tunable constants in one place
├── LICENSE                  # MIT
├── README.md
└── SPEC.md                  # this file
```

**`src/audio/` must not import anything from `src/game/`.** The audio engine has to stand
alone as a reusable module — that separation is part of the project's public story, not just
tidiness. Game code calls into audio; never the reverse.

**Every tunable number lives in `src/config.ts`.** Nothing magic inline. I will be
retuning these by ear during playtests and I need one file to edit.

---

## 5. Game specification

### World

- Top-down 2D arena, `40 × 40` units, walled.
- Player starts at centre, heading north.
- Per round: **1 active target** (a new one spawns on collection) and **N hazards**
  (default 3), all at random positions at least 6 units from the player.

### Controls

| Key | Action |
|---|---|
| `←` / `→` | Rotate in place |
| `↑` | Walk forward |
| `Space` | Sonar ping (pulses nearby objects once) |
| `Enter` | Collect target when in range |
| `Esc` | Pause, speak current score |
| `H` | Repeat controls aloud |

Rotation and movement are held-key continuous, not per-press.

### Loop

1. Round starts, timer counts down from 60s.
2. Target emits a repeating tone from its position.
3. Player rotates until the tone is centred, walks toward it.
4. Within collect radius, a distinct "in range" cue plays; `Enter` collects it,
   score +1, a new target spawns.
5. Walking into a hazard costs 5 seconds and plays a collision cue.
6. At 0s the round ends and the final score is spoken.

### Default constants (put these in `config.ts`, I will tune them)

```ts
ARENA_SIZE        = 40      // units
PLAYER_SPEED      = 3       // units/sec
TURN_SPEED        = 120     // degrees/sec
COLLECT_RADIUS    = 1.5     // units
HAZARD_RADIUS     = 1.2     // units
HAZARD_COUNT      = 3
ROUND_SECONDS     = 60
HAZARD_PENALTY    = 5       // seconds
PING_COOLDOWN     = 1.5     // seconds
CENTRE_TOLERANCE  = 5       // degrees, for the centre-lock tick
```

---

## 6. Audio engine specification

This is the part that decides whether the game works. Build and validate it **first**,
before any game logic.

### Signal chain (one per sound source)

```
OscillatorNode | AudioBufferSourceNode (MONO)
  → GainNode        (envelope)
  → BiquadFilterNode (lowpass: distance + rear shadowing)
  → PannerNode      (HRTF)
  → master GainNode → destination
```

Sources must be **mono**. A stereo buffer into a `PannerNode` triggers downmix behaviour
we do not want.

### PannerNode settings

```ts
panningModel:  'HRTF'
distanceModel: 'inverse'
refDistance:   1
maxDistance:   40
rolloffFactor: 1.4
```

### Listener updates

- Update listener position and orientation once per frame from player state.
- Use `setTargetAtTime(value, ctx.currentTime, 0.02)` on every AudioParam.
  **Never assign `.value` directly per frame** — at 60Hz that produces audible zipper
  artefacts, which sound cheap on a recording.
- **Feature-detect the listener API.** Older Safari lacks `listener.positionX` and needs
  the deprecated `listener.setPosition(x, y, z)` / `setOrientation(...)`. Branch once at
  startup inside a single `setListener()` wrapper; the rest of the codebase must not know
  which path is in use.
- Forward vector from heading: `forwardX = sin(heading)`, `forwardZ = -cos(heading)`,
  `upY = 1`. Keep everything at `y = 0`.

### Redundant cue design

HRTF alone is not sufficient for reliable localisation. Layer all of these:

| Cue | Encodes | Implementation |
|---|---|---|
| Binaural position | Azimuth | `PannerNode` HRTF |
| Loudness + lowpass cutoff | Distance | `rolloffFactor` + filter freq mapped to distance |
| Pulse repetition rate | Proximity | 2 pulses/sec far → 8 pulses/sec near |
| Timbre | Object type | target = sine, hazard = sawtooth, wall = filtered noise |
| Extra rear lowpass | Behind the player | see below |
| Centre-lock tick | "You are aimed correctly" | see below |

**Rear shadowing (mitigates front/back confusion).** Generic HRTFs cause frequent
front/back reversals. Compute the angle between listener-forward and the source direction;
when it exceeds 90°, ramp the source's lowpass cutoff down toward `2000 Hz`, versus
`18000 Hz` when directly ahead. Interpolate smoothly, never step. This imitates the
high-frequency shadowing real pinnae provide and measurably reduces reversals.

**Centre-lock tick.** When the target is within `CENTRE_TOLERANCE` degrees of dead ahead,
play a short, distinct, non-pitched tick (different timbre from everything else). This
gives the player a binary "aimed correctly" signal instead of asking them to judge small
angular differences, which is exactly where generic HRTF performs worst. Rate-limit it so
it does not machine-gun.

### Default sound definitions

```ts
TARGET_FREQ     = 660   // Hz, sine, pulsed
HAZARD_FREQ     = 110   // Hz, sawtooth, continuous low hum
PING_SWEEP      = 300 → 1200 Hz over 120ms, filtered noise
IN_RANGE_CUE    = two-tone rising sine, 200ms
COLLECT_CUE     = three-tone rising arpeggio, 300ms
COLLISION_CUE   = 80 Hz square burst, 250ms
```

### Node lifecycle

- **Pool and reuse panners.** HRTF panning is CPU-expensive; keep concurrent
  `PannerNode`s under ~10.
- An `OscillatorNode` can only be `start()`ed once. Either pool per-source oscillators that
  run continuously and are gated by their gain, or create per-shot and discard after `stop()`.
  Do not attempt to restart a stopped oscillator.
- Schedule everything against `ctx.currentTime`. **Never** `Date.now()`, never frame counts.

---

## 7. Accessibility requirements

Non-negotiable. The player may have no vision and no screen reader configured.

- **Self-voicing.** Use the Web Speech API (`speechSynthesis`) to speak every menu, prompt,
  instruction and state change. Provide a mute toggle for screen-reader users who would
  otherwise get double speech.
- **Announcement queue.** Do not let announcements interrupt each other mid-word; queue
  them, with a `priority` flag that can flush the queue for urgent cues.
- **Spoken onboarding on first load**, in this order:
  1. Welcome and game title
  2. Headphone prompt
  3. Left/right calibration — a tone in the left ear, then the right, then confirm
  4. Controls read aloud
  5. "Press Space to begin"
- **`AudioContext` starts suspended** and needs a user gesture to resume. Make the
  "press any key to begin" screen double as the resume trigger and the headphone check.
- Announce every state change aloud: target collected, hazard hit, 10 seconds remaining,
  round over with final score.
- Three settings only, all keyboard-reachable and spoken: speech on/off, master volume,
  high-contrast visual mode.
- Respect `prefers-reduced-motion` in the radar view.
- Semantic HTML with correct ARIA live regions as a secondary channel for screen readers.

---

## 8. Radar view (for the demo video)

A canvas top-down view showing player position, heading cone, target and hazards. This is
**for sighted viewers watching the recording**, not a gameplay aid — the game must be fully
winnable with it hidden.

- Brand palette from §0.
- High-contrast mode toggle for low-vision players who are not fully blind.
- Keep it simple: circles, a heading cone, a sweep. No particle effects.

---

## 9. Telemetry

Log per round to `localStorage` as JSON, and expose a "download session JSON" key
(`D`) so I can pull the data out for the pitch:

- Time to acquire each target
- Angular error at the moment the player started walking
- Overshoot distance past the target
- Hazard collisions
- Ping usage count
- Final score, round duration, difficulty parameters in effect

No analytics service. No network calls. Nothing leaves the browser.

In v0.1, `difficulty.ts` exports the interface and returns fixed defaults from `config.ts`.
Do not implement adaptation yet.

---

## 10. Build order and acceptance gates

Work through these in order. **Do not start a milestone until the previous gate passes.**

### M1 — Audio engine spike
Listener, one pooled binaural source, player rotation and forward movement, empty arena,
one target tone. No scoring, no hazards, no UI.

> **Gate:** I can put on headphones, close my eyes, and walk to the beacon in under
> 15 seconds, ten times out of ten. If I cannot, we fix perception before adding anything
> else — more features will not rescue a game that cannot be localised.

### M2 — Game loop
Hazards, timer, scoring, collect and collision cues, round start/end, pause.

> **Gate:** a full 60-second round is playable start to finish with the monitor off.

### M3 — Accessibility layer
Speech wrapper, announcement queue, onboarding flow, calibration, settings.

> **Gate:** a first-time player who has never seen the screen can get from page load to
> playing, using only what they hear.

### M4 — Radar + deploy
Canvas view, high-contrast mode, telemetry export, GitHub Pages deploy, README.

> **Gate:** live on the deploy URL, loads and plays on Chrome, Firefox and Safari.

Stop at M4. Adaptive difficulty is M5 and only happens if there is time left.

---

## 11. Definition of done for v0.1

- [ ] Playable end to end with the monitor off
- [ ] Zero runtime dependencies in `package.json`
- [ ] No audio files in the repo
- [ ] No mouse or pointer event handlers anywhere
- [ ] Every tunable constant lives in `config.ts`
- [ ] `src/audio/` imports nothing from `src/game/`
- [ ] Works on Chrome, Firefox and Safari
- [ ] Deployed and reachable at the URL in §0
- [ ] README explains what it is, how to play, and how to embed the audio engine
- [ ] MIT LICENSE present

---

## 12. Known pitfalls — read before writing code

1. `AudioContext` starts suspended; it needs a user gesture to resume.
2. HRTF panners are expensive; pool them, keep under ~10 concurrent.
3. `setTargetAtTime`, not `.value =`, for anything updated per frame.
4. `OscillatorNode.start()` is once-only.
5. Schedule against `ctx.currentTime`, never wall-clock time.
6. Safari needs the deprecated listener API; branch once, hide it behind a wrapper.
7. Sources into a panner must be mono.
8. Front/back confusion and poor elevation discrimination are inherent properties of
   generic HRTFs, not bugs to fix. Design around them: rear shadowing, centre-lock tick,
   and a game where turning is a core mechanic.

---

## 13. Working agreement

- Ask before adding anything outside §3.
- Small commits with clear messages; this repo will be read by competition reviewers.
- Comment the audio engine generously and the game logic sparingly.
- When a tuning value is a judgement call, put it in `config.ts` with a comment saying
  what it trades off, rather than picking silently.
- If a gate in §10 fails, say so plainly instead of moving on.
