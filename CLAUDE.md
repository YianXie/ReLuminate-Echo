# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ReLuminate Echo: a browser-based, audio-first beacon hunt played on headphones with the monitor off (built for blind and low-vision players, and as a competition entry). Vite + TypeScript, no framework, no game engine. `SPEC.md` is the original build brief. Its scope, constraints and "known pitfalls" (§2, §3, §12, §13) still apply, so read it before adding features. v0.2 added a practice round, adaptive difficulty and a test suite on top of it; the README's Status section lists what changed.

## Commands

```bash
npm install
npm run dev         # Vite dev server
npm run build       # tsc --noEmit && vite build → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run (plain Node, tests/**/*.test.ts)
npm run preview     # serve dist/
```

There is no linter. CI (`.github/workflows/ci.yml`) runs `npm run build` and then `npm test`, so typechecking and the unit tests are the gate; `deploy.yml` only builds. Tests live in `tests/`, not beside the sources, so that `src/audio/` stays copyable on its own. They run under Vitest in a plain Node environment with no jsdom, which works because nothing under test touches the DOM or an `AudioContext` at import time: keep it that way. `World` can be laid out against a stub pool as long as the test never calls `update()`, and `Announcer` runs against a fake `speechSynthesis`. Vitest is pinned to 3.x because 4 and later need Vite 6. `tsconfig.json` is very strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUnused*`), which means type-only imports must use `import type`. Code is formatted Prettier-style (4-space indent, double quotes, semicolons) but there is no formatter config in the repo.

## Hard constraints (from SPEC.md)

- **Zero runtime dependencies.** Vite, TypeScript and Vitest are the only dev dependencies.
- **No audio files.** Every sound is synthesised at runtime from oscillators and a noise buffer.
- **Keyboard first, touch as an equal.** The user asked for phone support after SPEC.md was written, so this overrides its "keyboard only" and "no mobile UI" lines. Pointer handling lives in `src/ui/touch.ts` and nowhere else. Every on-screen button must do exactly what its key does, by calling the same function in `main.ts`, and every spoken line that names a control goes in `src/prompts.ts` in both a keyboard and a touch wording. The touch wording describes buttons by position, so moving a button in `index.html` means changing those words too.
- **Static hosting only.** No backend, no network calls. Telemetry goes to `localStorage` only.
- Call it "binaural audio", never "spatial audio", in comments and UI text.
- **Every tunable number lives in `src/config.ts`.** Don't put magic numbers inline. When a value is a judgement call, add a comment saying what it trades off.
- **`src/audio/` must not import from `src/game/`.** The audio engine is meant to be reusable on its own (the README documents embedding it). Game code calls audio, never the reverse.
- Out of scope unless the user asks: a second game mode, elevation, reverb/occlusion/Doppler, music, a PWA manifest or service worker, device-orientation steering, haptics, new cue sounds, moving hazards, and extra settings beyond speech/volume/contrast.

## Architecture

`src/main.ts` orchestrates everything: input handling, onboarding, round start/end, pause, and settings. It creates the modules below, and nothing else wires them together.

- **Startup gate:** an `AudioContext` starts suspended. The first keydown, or a tap on the touch Start button, calls `onFirstGesture()`, which unlocks speech (`speech.unlock()`, for iOS) and requests a screen wake lock *before* its first `await`, then `resumeAudio()`; only then are `SourcePool`, `World`, the key listeners and `GameLoop` created. Everything downstream assumes the context is running. `resumeAudio()` also sets `navigator.audioSession.type = "playback"` where it exists, so iOS does not mute the game with the silent switch.
- **Input:** keys write `input`, the on-screen buttons write `touch.held`, and `step()` ORs them into what `World` sees. `inputMode` (keyboard or touch) follows whichever was used last and picks the `PROMPTS` set. On a touch screen (`(any-pointer: coarse)`) `main.ts` sets `data-input="touch"` on `<html>`, which shows the fixed control pad and the touch-only page sections; `syncTouchPad()` marks buttons that do nothing in the current phase `aria-disabled` and relabels Pause.
- **Phases:** `game/state.ts` has a `StateMachine` (`idle → onboarding → practice | playing`, `playing ⇄ paused`, everything ends in `roundOver`, which doubles as the ready state between rounds) plus a `Round` (clock, score, ping cooldown, 10-second warning). Onboarding has no separate skip flag: the async step list stops as soon as the phase stops being `onboarding`. From onboarding Space starts practice and T a timed round; from `roundOver` Space starts a timed round and P practice. Practice cannot be paused, so Escape ends it.
- **Practice:** two beacons at scripted bearings (`PRACTICE.BEACONS`, via `World.spawnTargetAt`), no hazards, no clock. "No clock" is `roundSeconds: Infinity` from `practiceParameters()`, so `Round` needs no special case. It is recorded in telemetry with `mode: 'practice'` and never reaches the difficulty controller.
- **Difficulty:** `game/difficulty.ts` is a 1-up/2-down staircase over `DIFFICULTY.LEVELS`. It steps per beacon hunt but a round is played at one level; the next round moves by at most two. `validateLevels()` throws at startup if a level asks for more hazards than `AUDIO.MAX_CONCURRENT_SOURCES - 2`, and `World` refuses to place a hazard it cannot voice: a silent hazard that still collides is the one thing this game must never do.
- **Loop:** `game/loop.ts` runs a fixed-step simulation (`LOOP.FIXED_DT`) with an accumulator, then renders the radar on every rAF frame. The radar (`ui/radar.ts`) only reads the world and exists for sighted viewers of the demo video.
- **World:** `game/world.ts` owns the player, the target and the hazards. It acquires voices from the `SourcePool`, updates the listener pose and source positions each step, and reports collect and hazard events to `main.ts` through callbacks (`WorldEvents`). Whether the player is aimed at the beacon, and whether they have only just become so, is game state in `game/aim.ts` (`centreTolerance`, `CentreLock`); the audio side only makes the tick.
- **Audio engine (`src/audio/`):**
  - `context.ts`: the `AudioContext` singleton, master gain, and the listener wrapper. It feature-detects the legacy Safari `setPosition`/`setOrientation` API once and hides it behind `setListenerPose`. It also holds the `ramp`/`cancelRamps` helpers, including the `cancelAndHoldAtTime` fallback.
  - `source.ts`: `BinauralSource` is osc/noise → gain (envelope + pulse train) → lowpass (distance + rear shadowing) → HRTF `PannerNode`. `SourcePool` holds a fixed set of 8 voices, built up front. `acquire()` can return `null`, and callers must handle that.
  - `math.ts`: the pure functions (`clamp`, `logLerp`, `distanceCutoff`, `rearCutoff`, `pulseRate`), kept apart so they can be tested without an `AudioContext`.
  - `cues.ts`: one-shot cues that are not panned (ping, in-range, collect, collision, centre-lock tick, calibration tones).
  - `speech.ts`: the `speechSynthesis` announcer. Its queue never cuts a line off mid-word, a priority flag flushes pending lines, and a watchdog covers browsers that never fire `end`. `speak()` resolves `false` for a line that was dropped before its turn, which is how onboarding knows to say a step again. Muting silences the voice but keeps the backlog, because `main.ts`'s `announce()` writes the `#status` ARIA live region from the `onStart` callback, as each line starts, not when it is queued. Keep every spoken line under `SPEECH.MAX_UTTERANCE_CHARS`; longer text is split into sentences and queued separately.
- **Coordinates:** the world is 2D (x, y). Audio is placed at `(x, 0, -y)` with y up, and forward is `(sin h, 0, -cos h)`. Set the listener pose **before** updating sources each frame, because rear shadowing is computed from it.
- **Telemetry:** `telemetry.ts` records per-round data (time to acquire, angular error at the walk *onset*, overshoot, hazard hits, pings, mode, difficulty level) to `localStorage` under a versioned key (`TELEMETRY.STORAGE_KEY`, `schemaVersion`). The v0.1 key is deliberately never read, migrated or deleted. `D` downloads it as JSON.

## Audio rules that are easy to break

- Schedule everything against `AudioContext.currentTime`, never wall-clock time or frame counts.
- Per-frame parameter changes go through `setTargetAtTime`/ramps, never `param.value =`, which causes zipper noise.
- `OscillatorNode.start()` can only be called once. Pooled voices start at construction and are gated by gain for the life of the page.
- Never construct a panner mid-round. Keep sources mono.
- Source gain is limited by clipping: HRTF adds about 1.5× on the near ear. To make a sound reach further, lower `rolloffFactor` rather than raising gain (see the README, "How the audio works").

## Deploying

`.github/workflows/deploy.yml` publishes `dist/` to GitHub Pages on every push to `main`, at the custom domain in `public/CNAME` (`play.reluminate-global.org`). Pages must be set to **Source: GitHub Actions**. "Deploy from a branch" serves raw `/src/main.ts`, and the game silently never starts. `vite.config.ts` uses `base: '/'` for the custom domain.
