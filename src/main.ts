/**
 * Bootstrap: resume the AudioContext on a user gesture, then wire input, state and world.
 *
 * (spec) An AudioContext starts suspended and only a user gesture can resume it. The
 * "press any key to begin" prompt exists to satisfy that rule; it doubles as the moment
 * the player confirms their headphones are on.
 */

import { resumeAudio } from './audio/context'
import { SourcePool } from './audio/source'
import { GameLoop } from './game/loop'
import { World } from './game/world'
import { Round, StateMachine } from './game/state'
import { createDifficulty } from './game/difficulty'
import type { InputState } from './game/player'

const status = requireElement('status')

/** (spec) The full control list, in one place so every channel reads the same words. */
const CONTROLS =
  'Left and right arrows turn. Up arrow walks forward. Space sends a sonar ping. ' +
  'Enter collects the beacon when you are on it. Escape pauses and reads your score. ' +
  'H repeats these controls.'

/** Keys we own. Swallowing their defaults stops arrows and space scrolling the page. */
const HANDLED_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', ' ', 'Enter', 'Escape'])

const input: InputState = { turnLeft: false, turnRight: false, forward: false }

const machine = new StateMachine()
const difficulty = createDifficulty()

let pool: SourcePool | null = null
let world: World | null = null
let round: Round | null = null
let loop: GameLoop | null = null
/** True when the current pause was forced by the page being hidden, not by the player. */
let pausedByVisibility = false

waitForFirstKey()

function waitForFirstKey(): void {
  window.addEventListener('keydown', onFirstKey, { once: true })
}

/** The gesture that unlocks audio. Everything downstream assumes a running context. */
async function onFirstKey(): Promise<void> {
  try {
    await resumeAudio()
  } catch (error) {
    // Listen again rather than stranding the player: a refused resume is usually a
    // transient autoplay decision, and the next keypress is another chance at a gesture.
    announce(`Audio could not start: ${(error as Error).message} Press any key to retry.`)
    waitForFirstKey()
    return
  }

  pool = new SourcePool()
  world = new World(pool, {
    onTargetCollected: () => {
      round?.collect()
      announce(`Beacon collected. Score ${round?.score ?? 0}.`)
    },
    onHazardHit: () => {
      round?.penalise()
      announce(`Hazard. Five seconds lost.`)
    },
  })

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', releaseAllKeys)
  document.addEventListener('visibilitychange', onVisibilityChange)

  loop = new GameLoop(step)
  loop.start()
  startRound()
}

function startRound(): void {
  if (!world) return
  const parameters = difficulty.next()
  round = new Round(parameters)
  world.start(parameters)
  machine.enter('playing')
  announce(`Round started. ${parameters.roundSeconds} seconds. Find the beacon.`)
}

function endRound(): void {
  if (!round || !world) return
  machine.enter('roundOver')
  world.stop()
  difficulty.record({
    score: round.score,
    hazardHits: round.hazardHits,
    durationSeconds: round.elapsed,
  })
  const plural = round.score === 1 ? 'beacon' : 'beacons'
  announce(`Round over. You found ${round.score} ${plural}. Press Space to play again.`)
}

/** One fixed simulation step. */
function step(dt: number): void {
  if (!machine.is('playing') || !world || !round) return

  world.update(dt, input)
  round.tick(dt)

  if (round.takeWarning()) announce('Ten seconds remaining.')
  if (round.isOver) endRound()
}

function onKeyDown(event: KeyboardEvent): void {
  if (HANDLED_KEYS.has(event.key)) event.preventDefault()
  if (event.repeat) return

  switch (event.key) {
    case 'ArrowLeft':
      input.turnLeft = true
      break
    case 'ArrowRight':
      input.turnRight = true
      break
    case 'ArrowUp':
      input.forward = true
      break
    case ' ':
      onSpace()
      break
    case 'Enter':
      if (machine.is('playing')) world?.collect()
      break
    case 'Escape':
      togglePause()
      break
    case 'h':
    case 'H':
      announce(CONTROLS)
      break
    default:
      break
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (HANDLED_KEYS.has(event.key)) event.preventDefault()
  switch (event.key) {
    case 'ArrowLeft':
      input.turnLeft = false
      break
    case 'ArrowRight':
      input.turnRight = false
      break
    case 'ArrowUp':
      input.forward = false
      break
    default:
      break
  }
}

/** (spec) Space is the sonar ping in play, and the restart in the round-over state. */
function onSpace(): void {
  if (machine.is('roundOver')) {
    startRound()
    return
  }
  if (!machine.is('playing') || !round || !world) return
  if (round.usePing()) world.ping()
}

/** (spec) Escape pauses and speaks the current score. */
function togglePause(): void {
  if (machine.is('playing')) pause()
  else if (machine.is('paused')) unpause()
}

function pause(): void {
  if (!round || !world || !machine.enter('paused')) return
  releaseAllKeys()
  world.silence()
  const seconds = Math.ceil(round.timeRemaining)
  announce(`Paused. Score ${round.score}. ${seconds} seconds left. Escape to resume.`)
}

function unpause(): void {
  if (!world || !machine.enter('playing')) return
  world.resume()
  announce('Resumed.')
}

/**
 * A backgrounded page has its animation frames throttled or stopped altogether, which
 * would leave the round crawling or frozen while the beacon carried on sounding.
 * Pausing outright is both honest and what the player would expect. Resuming on return
 * is deliberate: an auto-pause the player did not ask for should not need undoing.
 *
 * This reacts to transitions only. A page that is hidden before the player ever presses
 * a key cannot have been played in the first place, and trusting `document.hidden` as a
 * proxy for "frames have stopped" is not safe: embedded web views report hidden while
 * still painting at full rate.
 */
function onVisibilityChange(): void {
  if (document.hidden) {
    if (machine.is('playing')) {
      pausedByVisibility = true
      pause()
    }
  } else if (pausedByVisibility) {
    pausedByVisibility = false
    unpause()
  }
}

/** A key held while the window loses focus never reports keyup, so clear the lot. */
function releaseAllKeys(): void {
  input.turnLeft = false
  input.turnRight = false
  input.forward = false
}

/**
 * The single announcement channel. In M3 this also routes to speech synthesis; for now
 * it writes to the ARIA live region, which is the secondary channel SPEC.md §7 asks for.
 */
function announce(message: string): void {
  status.textContent = message
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing required element #${id}`)
  return element
}
