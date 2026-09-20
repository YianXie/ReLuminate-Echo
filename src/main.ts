/**
 * Bootstrap: resume the AudioContext on a user gesture, then wire input -> world -> audio.
 *
 * (spec) An AudioContext starts suspended and only a user gesture can resume it. The
 * "press any key to begin" prompt exists to satisfy that rule; it doubles as the moment
 * the player confirms their headphones are on.
 */

import { isUsingLegacyListener, resumeAudio } from './audio/context'
import { SourcePool } from './audio/source'
import { GameLoop } from './game/loop'
import { World } from './game/world'
import type { InputState } from './game/player'

const status = requireElement('status')

/** Keys we own. Swallowing their defaults stops arrows and space scrolling the page. */
const HANDLED_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Enter'])

const input: InputState = { turnLeft: false, turnRight: false, forward: false }

let world: World | null = null
let loop: GameLoop | null = null

window.addEventListener('keydown', onFirstKey, { once: true })

/** The gesture that unlocks audio. Everything downstream assumes a running context. */
async function onFirstKey(): Promise<void> {
  try {
    await resumeAudio()
  } catch (error) {
    say(`Audio could not start: ${(error as Error).message}`)
    return
  }

  const pool = new SourcePool()
  world = new World(pool)
  world.start()

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', releaseAllKeys)

  loop = new GameLoop((dt) => world?.update(dt, input))
  loop.start()

  say(
    'Beacon active. Turn until the pulse is centred and the tick starts, then walk forward. ' +
      'Press Enter at the beacon for a new one.' +
      (isUsingLegacyListener() ? ' (Using this browser’s legacy listener API.)' : ''),
  )
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.repeat) return
  if (HANDLED_KEYS.has(event.key)) event.preventDefault()

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
    case 'Enter':
      // M1 test harness: re-roll the beacon so an acquisition run can be repeated
      // without reloading the page. Scoring arrives with the game loop in M2.
      if (world?.isTargetInRange) world.spawnTarget()
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

/** A key held while the window loses focus never reports keyup, so clear the lot. */
function releaseAllKeys(): void {
  input.turnLeft = false
  input.turnRight = false
  input.forward = false
}

function say(message: string): void {
  status.textContent = message
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing required element #${id}`)
  return element
}
