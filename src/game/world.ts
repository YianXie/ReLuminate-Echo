import { CUES, GAME } from '../config'
import { setListenerPose } from '../audio/context'
import type { BinauralSource, SourcePool } from '../audio/source'
import { playCentreTick, playInRange } from '../audio/cues'
import { Player, bearing, wrapAngle, type InputState } from './player'

/** Anything that occupies a point in the arena and may be voiced by a pooled source. */
export interface Entity {
  x: number
  y: number
  source: BinauralSource | null
}

const RAD_TO_DEG = 180 / Math.PI

/**
 * The arena, the things in it, and the mapping from arena coordinates to audio-world
 * coordinates.
 *
 * Arena space is 2D top-down (+x east, +y north). Audio space is 3D with +y up, so
 * north maps to -z and everything sits on the y = 0 plane. That single conversion lives
 * here; `src/audio/` never sees an arena coordinate and `src/game/` never sees a z.
 */
export class World {
  readonly player = new Player()
  readonly target: Entity = { x: 0, y: 0, source: null }

  /** True while the player is inside the collect radius. Edge-triggered, for the cue. */
  private targetInRange = false

  constructor(private readonly pool: SourcePool) {}

  /** Places the player at the centre facing north and spawns a fresh beacon. */
  start(): void {
    this.player.reset()
    this.targetInRange = false
    this.spawnTarget()
  }

  stop(): void {
    this.pool.release(this.target.source)
    this.target.source = null
  }

  /** Distance from the player to the beacon, arena units. */
  get distanceToTarget(): number {
    return Math.hypot(this.target.x - this.player.x, this.target.y - this.player.y)
  }

  /**
   * Where the beacon is relative to where the player is looking, degrees.
   * 0 is dead ahead, positive is to the right, +/-180 is directly behind.
   */
  get bearingToTarget(): number {
    const absolute = bearing(this.player.x, this.player.y, this.target.x, this.target.y)
    return wrapAngle(absolute - this.player.heading) * RAD_TO_DEG
  }

  get isTargetInRange(): boolean {
    return this.targetInRange
  }

  /** One fixed simulation step. */
  update(dt: number, input: InputState): void {
    this.player.update(dt, input)

    // Listener first: every source computes its rear shadowing from the pose set here,
    // so updating them in the other order would voice the world one frame stale.
    this.syncListener()
    this.updateTarget()
    this.pool.update()
  }

  /** Moves the beacon somewhere new and re-points its source at it. */
  spawnTarget(): void {
    const spot = this.randomSpawnPoint()
    this.target.x = spot.x
    this.target.y = spot.y
    this.targetInRange = false

    if (!this.target.source) {
      this.target.source = this.pool.acquire({
        timbre: CUES.TARGET.timbre,
        frequency: CUES.TARGET.frequency,
        gain: CUES.TARGET.gain,
        pulsed: true,
        pulse: {
          rateFar: CUES.TARGET.PULSE_RATE_FAR,
          rateNear: CUES.TARGET.PULSE_RATE_NEAR,
          distanceFar: CUES.TARGET.PULSE_FAR_DISTANCE,
          distanceNear: CUES.TARGET.PULSE_NEAR_DISTANCE,
          length: CUES.TARGET.PULSE_LENGTH,
        },
      })
    }
  }

  private updateTarget(): void {
    const source = this.target.source
    if (source) source.setPosition(this.target.x, 0, -this.target.y)

    const distance = this.distanceToTarget

    // (spec) Centre-lock tick. Called every frame the player is on axis; the cue module
    // owns the rate limit so the game does not have to track tick timing.
    if (Math.abs(this.bearingToTarget) <= GAME.CENTRE_TOLERANCE) playCentreTick()

    const inRange = distance <= GAME.COLLECT_RADIUS
    if (inRange && !this.targetInRange) playInRange()
    this.targetInRange = inRange
  }

  private syncListener(): void {
    const { x, y, heading } = this.player
    // (spec) forwardX = sin(heading), forwardZ = -cos(heading), upY = 1, everything at y = 0.
    setListenerPose(
      { x, y: 0, z: -y },
      { x: Math.sin(heading), y: 0, z: -Math.cos(heading) },
    )
  }

  /** A point inside the arena at least MIN_SPAWN_DISTANCE from the player. */
  private randomSpawnPoint(): { x: number; y: number } {
    const limit = GAME.ARENA_SIZE / 2 - GAME.WALL_MARGIN * 2
    for (let attempt = 0; attempt < 64; attempt++) {
      const x = (Math.random() * 2 - 1) * limit
      const y = (Math.random() * 2 - 1) * limit
      if (Math.hypot(x - this.player.x, y - this.player.y) >= GAME.MIN_SPAWN_DISTANCE) {
        return { x, y }
      }
    }
    // Rejection sampling can in principle fail; fall back to a point on the minimum-distance
    // circle, nudged inside the walls. Never leaves the player without a beacon to find.
    const angle = Math.random() * Math.PI * 2
    return {
      x: clampTo(this.player.x + Math.sin(angle) * GAME.MIN_SPAWN_DISTANCE, limit),
      y: clampTo(this.player.y + Math.cos(angle) * GAME.MIN_SPAWN_DISTANCE, limit),
    }
  }
}

function clampTo(value: number, limit: number): number {
  return value < -limit ? -limit : value > limit ? limit : value
}
