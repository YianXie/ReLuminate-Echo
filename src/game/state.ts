import { GAME } from '../config'
import type { DifficultyParameters } from './difficulty'

/**
 * Where the game is. Every phase change is also something the player is told about, so
 * this machine is the single place a screen-free player's mental model is kept in sync
 * with the program's.
 */
export type Phase = 'idle' | 'onboarding' | 'playing' | 'paused' | 'roundOver'

const ALLOWED: Record<Phase, readonly Phase[]> = {
  idle: ['onboarding', 'playing'],
  onboarding: ['playing', 'idle'],
  playing: ['paused', 'roundOver'],
  paused: ['playing', 'roundOver'],
  roundOver: ['playing', 'idle'],
}

export type PhaseListener = (next: Phase, previous: Phase) => void

export class StateMachine {
  private phase: Phase = 'idle'
  private readonly listeners = new Set<PhaseListener>()

  get current(): Phase {
    return this.phase
  }

  is(...phases: Phase[]): boolean {
    return phases.includes(this.phase)
  }

  canEnter(next: Phase): boolean {
    return ALLOWED[this.phase].includes(next)
  }

  /** Returns false and does nothing if the transition is not legal. */
  enter(next: Phase): boolean {
    if (next === this.phase || !this.canEnter(next)) return false
    const previous = this.phase
    this.phase = next
    for (const listener of this.listeners) listener(next, previous)
    return true
  }

  onChange(listener: PhaseListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/**
 * The scoreboard and clock for one round.
 *
 * Time is accumulated from the fixed simulation step, not read from a wall clock, so a
 * dropped frame costs the player nothing and the round is reproducible from a replay of
 * its inputs. (Audio, separately, is always scheduled against `AudioContext.currentTime`.)
 */
export class Round {
  score = 0
  hazardHits = 0
  pings = 0
  timeRemaining: number
  elapsed = 0

  /** Seconds since the last ping, for the cooldown. Starts ready. */
  private sincePing: number = GAME.PING_COOLDOWN
  private warned = false

  constructor(readonly parameters: DifficultyParameters) {
    this.timeRemaining = parameters.roundSeconds
  }

  get isOver(): boolean {
    return this.timeRemaining <= 0
  }

  get canPing(): boolean {
    return this.sincePing >= GAME.PING_COOLDOWN
  }

  /**
   * True the first time the round crosses the low-time threshold, false ever after.
   * A method rather than a getter because reading it consumes the warning.
   */
  takeWarning(): boolean {
    if (this.warned || this.timeRemaining > GAME.WARNING_SECONDS) return false
    this.warned = true
    return true
  }

  tick(dt: number): void {
    this.elapsed += dt
    this.sincePing += dt
    this.timeRemaining = Math.max(0, this.timeRemaining - dt)
  }

  collect(): void {
    this.score += 1
  }

  /** (spec) A hazard costs seconds, not points. */
  penalise(): void {
    this.hazardHits += 1
    this.timeRemaining = Math.max(0, this.timeRemaining - this.parameters.hazardPenalty)
  }

  usePing(): boolean {
    if (!this.canPing) return false
    this.sincePing = 0
    this.pings += 1
    return true
  }
}
