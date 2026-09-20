import { GAME } from '../config'

/**
 * Which movement keys are held right now. (spec) Rotation and movement are held-key
 * continuous, never per-press.
 */
export interface InputState {
  turnLeft: boolean
  turnRight: boolean
  forward: boolean
}

const DEG_TO_RAD = Math.PI / 180

/**
 * The player's position and heading in the arena.
 *
 * Arena coordinates are top-down: +x east, +y north, origin at the centre. Heading is in
 * radians, 0 = north, increasing clockwise, so pressing right-arrow increases it. The
 * conversion into audio-world coordinates happens in `World`, not here.
 */
export class Player {
  x = 0
  y = 0
  heading = 0
  /** True on any step where the player translated. Telemetry uses it to time acquisitions. */
  isWalking = false

  reset(): void {
    this.x = 0
    this.y = 0
    this.heading = 0
    this.isWalking = false
  }

  update(dt: number, input: InputState): void {
    const turn = (input.turnRight ? 1 : 0) - (input.turnLeft ? 1 : 0)
    if (turn !== 0) {
      this.heading = wrapAngle(this.heading + turn * GAME.TURN_SPEED * DEG_TO_RAD * dt)
    }

    this.isWalking = input.forward
    if (!input.forward) return

    const step = GAME.PLAYER_SPEED * dt
    const limit = GAME.ARENA_SIZE / 2 - GAME.WALL_MARGIN
    this.x = clampTo(this.x + Math.sin(this.heading) * step, limit)
    this.y = clampTo(this.y + Math.cos(this.heading) * step, limit)
  }
}

/** Normalises an angle to (-PI, PI]. */
export function wrapAngle(radians: number): number {
  let a = radians % (Math.PI * 2)
  if (a > Math.PI) a -= Math.PI * 2
  if (a <= -Math.PI) a += Math.PI * 2
  return a
}

/** Compass bearing from one arena point to another, radians, 0 = north. */
export function bearing(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.atan2(toX - fromX, toY - fromY)
}

function clampTo(value: number, limit: number): number {
  return value < -limit ? -limit : value > limit ? limit : value
}
