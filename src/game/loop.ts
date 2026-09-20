import { LOOP } from '../config'

/**
 * Fixed-step update loop.
 *
 * The simulation always advances in LOOP.FIXED_DT increments regardless of display
 * refresh rate, so movement speed is identical on a 60 Hz laptop and a 144 Hz monitor.
 * Leftover time carries into the next frame.
 *
 * Note that nothing here touches the audio clock. Frame timing decides *when we look at
 * the world*; every sound is still scheduled against `AudioContext.currentTime`, which
 * is the only clock the audio thread respects.
 */
export class GameLoop {
  private frame = 0
  private previous = 0
  private accumulator = 0
  private running = false

  constructor(
    private readonly step: (dt: number) => void,
    private readonly render: () => void = () => {},
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.previous = performance.now()
    this.accumulator = 0
    this.frame = requestAnimationFrame(this.tick)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.frame)
  }

  get isRunning(): boolean {
    return this.running
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return
    this.frame = requestAnimationFrame(this.tick)

    // Clamped so that returning to a backgrounded tab does not try to simulate the
    // minutes it spent hidden in one frame.
    const elapsed = Math.min((now - this.previous) / 1000, LOOP.MAX_FRAME_TIME)
    this.previous = now
    this.accumulator += elapsed

    while (this.accumulator >= LOOP.FIXED_DT) {
      this.step(LOOP.FIXED_DT)
      this.accumulator -= LOOP.FIXED_DT
    }

    this.render()
  }
}
