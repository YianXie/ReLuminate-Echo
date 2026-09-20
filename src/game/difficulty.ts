import { GAME } from '../config'

/**
 * Difficulty parameters in effect for a round.
 *
 * STUB for v0.1. This file exists as an interface and a fixed default so that the rest
 * of the game already asks a difficulty source for its numbers rather than reading
 * `GAME` directly. Adaptation is M5 and deliberately not implemented: adapting on a
 * handful of rounds of telemetry, before the perception work has been validated with
 * real players, would tune the game against noise.
 */
export interface DifficultyParameters {
  hazardCount: number
  roundSeconds: number
  hazardPenalty: number
  collectRadius: number
  hazardRadius: number
  minSpawnDistance: number
}

/** What a round reports back once it ends. Ignored in v0.1. */
export interface RoundOutcome {
  score: number
  hazardHits: number
  durationSeconds: number
}

export interface DifficultyController {
  /** Parameters for the round about to start. */
  next(): DifficultyParameters
  /** Called when a round ends. No-op in v0.1. */
  record(outcome: RoundOutcome): void
}

/** The fixed defaults from `config.ts`. */
export function defaultParameters(): DifficultyParameters {
  return {
    hazardCount: GAME.HAZARD_COUNT,
    roundSeconds: GAME.ROUND_SECONDS,
    hazardPenalty: GAME.HAZARD_PENALTY,
    collectRadius: GAME.COLLECT_RADIUS,
    hazardRadius: GAME.HAZARD_RADIUS,
    minSpawnDistance: GAME.MIN_SPAWN_DISTANCE,
  }
}

export function createDifficulty(): DifficultyController {
  return {
    next: defaultParameters,
    record: () => {
      // v0.1: rounds are not adaptive. See SPEC.md §9.
    },
  }
}
