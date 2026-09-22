# ReLuminate Echo

[![CI](https://github.com/YianXie/ReLuminate-Echo/actions/workflows/ci.yml/badge.svg)](https://github.com/YianXie/ReLuminate-Echo/actions/workflows/ci.yml)

An audio-first beacon hunt. You are dropped into a dark 40×40 arena with a beacon
somewhere in it, a few hazards humming away, and sixty seconds. You find the beacon by
turning until it sounds like it is in front of you, then walking. When you collect it,
another one appears somewhere else. The better you do, the harder the next round gets.

There is nothing to look at. The game is designed to be played on headphones with the
monitor switched off, and it was built that way on purpose: it is a
[ReLuminate](https://reluminate-global.org) project, and ReLuminate makes games that
blind and low-vision players can actually play rather than games that merely have an
accessibility menu.

**Play it: [play.reluminate-global.org](https://play.reluminate-global.org)**

---

## How to play

Put on headphones. Stereo headphones — any pair. Speakers will not work, because the
direction cues are binaural and depend on each ear hearing its own signal.

Press any key. The game introduces itself out loud, plays a tone in your left ear and
then your right so you can check your headphones are the right way round, and reads you
the controls. Space skips all of that at any point.

Space then starts a short practice: two beacons, no clock and no hazards, with the first
one talked through. After it, Space starts a timed round of sixty seconds. T goes
straight to a timed round instead.

| Key | Action |
|---|---|
| <kbd>←</kbd> / <kbd>→</kbd> | Turn left and right |
| <kbd>↑</kbd> | Walk forward |
| <kbd>Space</kbd> | Sonar ping — everything nearby answers once. Also starts practice from the introduction, and a timed round after that |
| <kbd>Enter</kbd> | Collect the beacon when you are on it |
| <kbd>Esc</kbd> | Pause and hear your score. In practice, end the practice |
| <kbd>P</kbd> | Start a practice round, before or between rounds |
| <kbd>T</kbd> | Start a timed round, before or between rounds |
| <kbd>H</kbd> | Repeat the controls |

| Setting | Key |
|---|---|
| Speech on/off | <kbd>S</kbd> |
| Volume | <kbd>-</kbd> / <kbd>=</kbd> |
| High contrast visuals | <kbd>C</kbd> |
| Download your session data | <kbd>D</kbd> |

Turn speech off if you already run a screen reader — otherwise you will hear every
announcement twice, once from us and once from your own software. The live region on the
page carries the same words either way.

### Learning to hear it

Turning is the core skill. A generic head-related transfer function — which is what any
browser gives you — is good at telling left from right and bad at telling front from
back. So the game is built around turning rather than around standing still and judging:

- **Sweep, don't stare.** Rotate until the beacon sounds centred.
- **Listen for the tick.** A short, dry click means you are aimed at the beacon: within
  five degrees from across the arena, and a wider window as you close in, so it does not
  cut out on the final approach. It clicks the moment you come on line and about once a
  second while you stay there. It is a yes/no signal, so you never have to judge a small
  angle.
- **Count the pulses.** The beacon pulses twice a second from across the arena and eight
  times a second when you are on top of it. If the pulses slow down, you are walking the
  wrong way.
- **The low hum is a hazard.** Walking into one costs you five seconds.
- **The hiss is a wall.** You are about to run out of arena.

---

## Running it locally

Node 18 or newer.

```bash
npm install
npm run dev
```

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typechecks, then bundles to `dist/` |
| `npm run preview` | Serves the built bundle |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests, Vitest in plain Node |

**There are no runtime dependencies and no audio files.** Every sound in the game is
synthesised in the browser at load time from oscillators and a noise buffer. That was a
deliberate constraint: it removes all asset-licensing risk, it keeps the bundle around
13 kB gzipped, and it means every sound parameter is a number in one file that can be
retuned by ear between playtests.

Vite, TypeScript and Vitest are the only dev dependencies.

---

## How the audio works

The short version: each object in the world owns a chain of Web Audio nodes ending in an
HRTF panner, and the game moves the listener around them once per frame.

```
OscillatorNode | AudioBufferSourceNode (mono)
  → GainNode          envelope, and the pulse train
  → BiquadFilterNode  lowpass: distance rolloff + rear shadowing
  → PannerNode        HRTF
  → master GainNode → destination
```

HRTF alone is not enough to play a game by, so position is encoded several times over
and the redundancy is the point:

| Cue | Tells you | How |
|---|---|---|
| Binaural rendering | Which way it is | `PannerNode` in `HRTF` mode |
| Loudness and brightness | How far it is | Distance rolloff plus a lowpass that closes with distance |
| Pulse rate | How close you are | 2 per second far, 8 per second near |
| Timbre | What it is | Beacon = sine, hazard = sawtooth, wall = filtered noise |
| Rear shadowing | That it is behind you | Extra lowpass as a source moves off-axis |
| Centre-lock tick | That you are aimed at it | A dry click inside five degrees, or inside the beacon's own width once that is wider |

Two things are worth knowing if you are reading the code.

**Rear shadowing does not help on the beacon, and that is expected.** Real ear shape
shadows high frequencies coming from behind, so the engine imitates it by closing the
lowpass as a source moves off-axis. Measured in Chrome, that is worth 11 dB on the
sawtooth hazard and 14 dB on the noise wall — and 0 dB on the beacon, because a 660 Hz
sine has no energy above 2.5 kHz for the filter to remove. Front/back on the beacon is
carried by the centre-lock tick and the pulse rate instead. The cue stack is redundant
precisely so that one cue being inapplicable is not fatal.

**Source gain is capped by clipping, not by taste.** The distance model holds gain at 1.0
inside `refDistance`, and a generic HRTF adds roughly 1.5× on the near ear when a source
is off to one side. Measured at the master bus, a beacon at gain 1.0 peaked at 1.49 with
the volume up — well past the destination's ±1 clamp, and still over it at the default
volume. So the beacon runs at 0.6 and gets its reach from a gentler `rolloffFactor`
instead: lowering rolloff lifts the far field and leaves the near field untouched, which
is the only way to make something easier to hear across a room when the near end is
already at full scale. That is worth 4–6 dB everywhere the hunting actually happens, for
about 2 dB of the loudness-as-distance cue — affordable because pulse rate carries
proximity anyway.

**Nothing is scheduled against wall-clock time.** Every envelope, sweep and pulse is
scheduled against `AudioContext.currentTime`. The audio thread runs on its own clock and
drifts away from `requestAnimationFrame` within seconds, and pulses scheduled from frame
timing audibly stutter. Frame timing decides only when the game looks at the world.

Other things the code is careful about, all of which are easy to get wrong:

- `OscillatorNode.start()` can only be called once ever, so pooled sources start their
  oscillator at construction and gate it with an envelope for the lifetime of the page.
- HRTF panners are expensive, so there is a fixed pool of eight and no panner is ever
  constructed mid-round.
- Anything updated per frame goes through `setTargetAtTime`, never `param.value = x`,
  which at 60 Hz produces audible zipper noise.
- Sources feeding a panner are mono. A stereo buffer triggers downmix behaviour that
  undoes the HRTF work.
- Older Safari has no `listener.positionX` and needs the deprecated
  `setPosition()`/`setOrientation()`. The branch happens once, at startup, inside a
  single wrapper.

---

## Using the audio engine in your own project

`src/audio/` is self-contained and imports nothing from `src/game/`. That separation is
enforced by hand and worth keeping: the engine is the reusable part. Copy the folder and
`src/config.ts` into your project and you have binaural positional audio with no
dependencies.

```ts
import { resumeAudio, setListenerPose } from './audio/context'
import { SourcePool } from './audio/source'

// AudioContext starts suspended; this must be called from a user gesture.
await resumeAudio()

const pool = new SourcePool()          // eight pooled HRTF voices

const beacon = pool.acquire({
  timbre: 'sine',
  frequency: 660,
  gain: 0.6,
  rolloffFactor: 0.4,                   // gentler than the shared default; see below
  pulsed: true,                         // pulse rate rises as the listener closes in
  pulse: { rateFar: 2, rateNear: 8, distanceFar: 28, distanceNear: 1.5, length: 0.12 },
})

// Once per frame: place the listener first, then the sources, then update the pool.
setListenerPose(
  { x: player.x, y: 0, z: -player.y },                                   // y is up
  { x: Math.sin(player.heading), y: 0, z: -Math.cos(player.heading) },   // unit forward
)
beacon?.setPosition(target.x, 0, -target.y)
pool.update()
```

Order matters: sources compute their rear shadowing from the listener pose, so setting
the pose after updating them voices the world a frame stale. `acquire()` returns `null`
when the pool is exhausted — that is a real case to handle, and the right answer is to
drop the least important sound rather than allocate a ninth panner.

`src/audio/speech.ts` is independent of the rest and useful on its own: it is a
`speechSynthesis` wrapper with a queue that will not cut a line off mid-word, a priority
flag that drops pending lines, and a watchdog for browsers that forget to fire `end`.

---

## Layout

```
src/
├── main.ts              bootstrap, input, round orchestration
├── config.ts            every tunable number in the project
├── telemetry.ts         per-round measurements, localStorage only
├── audio/
│   ├── context.ts       AudioContext singleton, master gain, listener wrapper
│   ├── source.ts        pooled binaural source
│   ├── math.ts          the pure arithmetic: cutoffs and pulse rate from geometry
│   ├── cues.ts          one-shot, unpanned cues
│   └── speech.ts        Web Speech wrapper and announcement queue
├── game/
│   ├── state.ts         phase machine, round clock and score
│   ├── world.ts         arena, spawning, collision
│   ├── player.ts        position and heading
│   ├── aim.ts           centre-lock tolerance, and entering and leaving it
│   ├── loop.ts          fixed-step update loop
│   └── difficulty.ts    round parameters: the adaptive staircase, and practice
└── ui/
    └── radar.ts         canvas view, for sighted viewers only
tests/                   Vitest, plain Node, no DOM
```

Every tunable number lives in `src/config.ts`, with a comment on the ones that are
judgement calls saying what they trade off. Tuning an audio game is done by ear, and the
person doing it should not have to go looking.

---

## Difficulty

Timed rounds adapt with a 1-up / 2-down staircase, the standard psychophysics procedure:
two beacons in a row found within the level's time budget step the difficulty up one
level, and one miss steps it down one. That settles where you succeed about 71% of the
time. There are six levels, from no hazards and a generous collect radius to five hazards
and a tight one; the level is spoken at the start of each round.

The staircase moves beacon by beacon, but a round is played at one level from start to
finish, because changing the hazard layout under a player who cannot see it would be
unfair. The next round moves by at most two levels. A hunt the clock cuts short only
counts against you if it had already run past its budget. Round length and the hazard
penalty never change, so scores stay comparable. Nothing is remembered between page
loads, and practice rounds never count.

`DIFFICULTY.ADAPTIVE` in `src/config.ts` switches it off for controlled testing. The
table is checked at startup: no level may ask for more hazards than the source pool can
voice, because a hazard with no sound would still cost five seconds to walk into.

---

## Telemetry

Pressing <kbd>D</kbd> downloads a JSON file of every round played in this browser. Per
round it records the time to acquire each beacon, the angular error at the moment you
started walking, how far past the beacon you overshot, hazard collisions, ping count,
final score, whether it was a practice or a timed round, and the difficulty parameters
in effect, level included.

The angular error is the interesting one: it is how far off you were when you committed
to a direction, before any distance feedback could correct you, which is as close as this
gets to measuring whether the binaural cues actually work. It is taken only when you
*start* walking. A hunt you walk into with the key still held from the last one records
nothing, because you never chose a direction for it.

Records carry `schemaVersion: 2` and live under the `reluminate-echo.sessions.v2` key.
v0.1 measured the walk-start angle and the overshoot wrongly, so its rounds are kept
apart: the old key is never read, migrated or deleted.

It is stored in `localStorage` and nowhere else. There is no analytics service and no
network call anywhere in the codebase.

---

## Accessibility

- The game speaks for itself through the Web Speech API, so it works with no screen
  reader configured at all.
- Announcements are queued and never interrupt each other mid-word. Long ones are split
  into sentences, because some browser voices give up partway through a long utterance.
- During a round it says almost nothing: the score after a collection, "Hazard." after a
  collision. Speech competes with the sound you are trying to localise, and the cues
  already carry the news.
- A practice round with no clock and no hazards comes first, with the first beacon
  talked through.
- Keyboard only. There is no mouse or pointer event handler anywhere in the project.
- The same announcements go to an ARIA live region for players using their own screen
  reader with our speech muted, paced so the region is not overwritten faster than a
  screen reader can read it.
- High-contrast mode, and the radar sweep stops animating under
  `prefers-reduced-motion`.

---

## Status

v0.2. One game mode, a practice round, and adaptive difficulty.

What changed since v0.1:

- **Two telemetry bugs fixed.** The walk-start angle was being taken from a freshly
  spawned beacon whenever the walk key was held through a collection, and overshoot was
  erased when the player came back closer than before. Both have regression tests, and
  the corrected data is stored under a new key.
- **The centre-lock tick** widens with proximity, so it no longer cuts out on the final
  approach, and ticks on arrival and then about once a second rather than continuously
  (`CUES.CENTRE_TICK.MODE`).
- **Speech**: long announcements are split into sentences, and a round says far less
  (`SPEECH.IN_ROUND_VERBOSITY`).
- **First impressions**: the welcome says Space skips it, a practice round comes first,
  and a phone or tablet is told the game needs a keyboard instead of being left looking
  at a page that does nothing.
- **Adaptive difficulty**, described above. The v0.1 caution still stands: the staircase
  has been tested as arithmetic, not yet tuned against real players, and the level table
  is a first guess. `DIFFICULTY.ADAPTIVE` turns it off.
- **Unit tests** (Vitest, plain Node) for the telemetry, the speech queue, the audio
  arithmetic, the state machine and the staircase. CI runs them after the build.

### Cross-browser check

Targets current Chrome, Firefox and Safari on desktop. This table is filled in by hand,
with headphones, on the deployed build. v0.2 has so far been driven end to end in Chrome
only, by script, which shows that it runs and says nothing about how it sounds. Real
Firefox and Safari runs are still outstanding, as they were for v0.1.

| Check | Chrome | Firefox | Safari |
|---|---|---|---|
| Audio starts on first keypress | not yet run | not yet run | not yet run |
| Left/right calibration correct | not yet run | not yet run | not yet run |
| Beacon locatable blindfolded (SPEC.md M1 gate) | not yet run | not yet run | not yet run |
| Front/back distinguishable when turning | not yet run | not yet run | not yet run |
| Every spoken line completes | not yet run | not yet run | not yet run |
| No clicks or zipper noise when turning | not yet run | not yet run | not yet run |
| Practice round completes | not yet run | not yet run | not yet run |
| Telemetry download works (<kbd>D</kbd>) | not yet run | not yet run | not yet run |

Firefox's HRTF implementation differs from Chrome's. If front/back discrimination is
noticeably worse there, that is a finding to report, not a reason to retune the shared
constants for one browser.

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to
`main`. Pages must be set to **Settings → Pages → Source: GitHub Actions**, and the
custom domain comes from `public/CNAME`, which Vite copies into `dist/`.

**Pages must not be set to "Deploy from a branch".** A branch build serves the repository
root, so `index.html` asks for `/src/main.ts` — raw TypeScript, which GitHub serves as
`video/mp2t` because of the extension, and which browsers refuse to execute as a module.
The page renders, the game never starts, and nothing in the build logs says so.

`vite.config.ts` sets `base: '/'`, which is correct for a custom domain. If you ever
serve it from `yianxie.github.io/ReLuminate-Echo/` instead, change that to
`/ReLuminate-Echo/` or every asset will 404.

## Licence

MIT. See [LICENSE](LICENSE).
