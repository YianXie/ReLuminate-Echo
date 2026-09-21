# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ReLuminate Echo: a browser-based, audio-first beacon hunt played on headphones with the monitor off (built for blind and low-vision players, and as a competition entry). Vite + TypeScript, no framework, no game engine. `SPEC.md` is the original build brief. Its scope, constraints and "known pitfalls" (§2, §3, §12, §13) still apply, so read it before adding features.

## Commands

```bash
npm install
npm run dev         # Vite dev server
npm run build       # tsc --noEmit && vite build → dist/
npm run typecheck   # tsc --noEmit
npm run preview     # serve dist/
```

There is no test suite and no linter. CI (`.github/workflows/ci.yml`) runs `npm run build` only, so typechecking is the gate. `tsconfig.json` is very strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUnused*`), which means type-only imports must use `import type`. Code is formatted Prettier-style (4-space indent, double quotes, semicolons) but there is no formatter config in the repo.

## Hard constraints (from SPEC.md)

- **Zero runtime dependencies.** Vite and TypeScript are the only dev dependencies.
- **No audio files.** Every sound is synthesised at runtime from oscillators and a noise buffer.
- **Keyboard only.** No mouse, pointer or touch handlers anywhere.
- **Static hosting only.** No backend, no network calls. Telemetry goes to `localStorage` only.
- Call it "binaural audio", never "spatial audio", in comments and UI text.
- **Every tunable number lives in `src/config.ts`.** Don't put magic numbers inline. When a value is a judgement call, add a comment saying what it trades off.
- **`src/audio/` must not import from `src/game/`.** The audio engine is meant to be reusable on its own (the README documents embedding it). Game code calls audio, never the reverse.
- Out of scope unless the user asks: a second game mode, elevation, reverb/occlusion/Doppler, music, mobile UI/PWA, extra settings beyond speech/volume/contrast, and adaptive difficulty (`difficulty.ts` is a deliberate stub that returns constants).

## Architecture

`src/main.ts` orchestrates everything: input handling, onboarding, round start/end, pause, and settings. It creates the modules below, and nothing else wires them together.

- **Startup gate:** an `AudioContext` starts suspended. The first keydown calls `resumeAudio()`, and only then are `SourcePool`, `World`, the key listeners and `GameLoop` created. Everything downstream assumes the context is running.
- **Phases:** `game/state.ts` has a `StateMachine` (`idle → onboarding → playing ⇄ paused → roundOver`) plus a `Round` (clock, score, ping cooldown, 10-second warning). Onboarding has no separate skip flag: the async step list stops as soon as the phase stops being `onboarding`.
- **Loop:** `game/loop.ts` runs a fixed-step simulation (`LOOP.FIXED_DT`) with an accumulator, then renders the radar on every rAF frame. The radar (`ui/radar.ts`) only reads the world and exists for sighted viewers of the demo video.
- **World:** `game/world.ts` owns the player, the target and the hazards. It acquires voices from the `SourcePool`, updates the listener pose and source positions each step, and reports collect and hazard events to `main.ts` through callbacks (`WorldEvents`).
- **Audio engine (`src/audio/`):**
  - `context.ts`: the `AudioContext` singleton, master gain, and the listener wrapper. It feature-detects the legacy Safari `setPosition`/`setOrientation` API once and hides it behind `setListenerPose`. It also holds the `ramp`/`cancelRamps` helpers, including the `cancelAndHoldAtTime` fallback.
  - `source.ts`: `BinauralSource` is osc/noise → gain (envelope + pulse train) → lowpass (distance + rear shadowing) → HRTF `PannerNode`. `SourcePool` holds a fixed set of 8 voices, built up front. `acquire()` can return `null`, and callers must handle that.
  - `cues.ts`: one-shot cues that are not panned (ping, in-range, collect, collision, centre-lock tick, calibration tones).
  - `speech.ts`: the `speechSynthesis` announcer. Its queue never cuts a line off mid-word, a priority flag flushes pending lines, and a watchdog covers browsers that never fire `end`. `main.ts`'s `announce()` sends the same text to the `#status` ARIA live region.
- **Coordinates:** the world is 2D (x, y). Audio is placed at `(x, 0, -y)` with y up, and forward is `(sin h, 0, -cos h)`. Set the listener pose **before** updating sources each frame, because rear shadowing is computed from it.
- **Telemetry:** `telemetry.ts` records per-round data (time to acquire, angular error when the player started walking, overshoot, hazard hits, pings) to `localStorage`. `D` downloads it as JSON.

## Audio rules that are easy to break

- Schedule everything against `AudioContext.currentTime`, never wall-clock time or frame counts.
- Per-frame parameter changes go through `setTargetAtTime`/ramps, never `param.value =`, which causes zipper noise.
- `OscillatorNode.start()` can only be called once. Pooled voices start at construction and are gated by gain for the life of the page.
- Never construct a panner mid-round. Keep sources mono.
- Source gain is limited by clipping: HRTF adds about 1.5× on the near ear. To make a sound reach further, lower `rolloffFactor` rather than raising gain (see the README, "How the audio works").

## Deploying

`.github/workflows/deploy.yml` publishes `dist/` to GitHub Pages on every push to `main`, at the custom domain in `public/CNAME` (`play.reluminate-global.org`). Pages must be set to **Source: GitHub Actions**. "Deploy from a branch" serves raw `/src/main.ts`, and the game silently never starts. `vite.config.ts` uses `base: '/'` for the custom domain.
