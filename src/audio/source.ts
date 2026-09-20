/**
 * The pooled binaural source: one positioned, continuously-voiced object in the world.
 *
 * Signal chain, exactly as SPEC.md §6 specifies:
 *
 *     OscillatorNode ──► oscGain ─┐
 *                                 ├──► envGain ──► BiquadFilter ──► Panner ──► master
 *     AudioBufferSource ► noiseGain ┘   (envelope)   (lowpass:        (HRTF)
 *      (mono white noise)                            distance +
 *                                                    rear shadow)
 *
 * Two design decisions worth spelling out, because both are consequences of Web Audio
 * rules that are easy to get wrong:
 *
 * 1. `OscillatorNode.start()` can only be called once, ever. So each source starts its
 *    oscillator at construction and leaves it running for the lifetime of the page,
 *    gated to silence by `envGain`. A source is "off" when its envelope is at zero, not
 *    when its oscillator is stopped — there is no way back from stopped.
 *
 * 2. Both the oscillator and the noise buffer are wired up permanently and crossfaded by
 *    `oscGain`/`noiseGain`. This keeps every source in the pool structurally identical,
 *    so a source that voiced a target last round can voice a wall this round without
 *    rebuilding a PannerNode. HRTF panners are the expensive part; we allocate
 *    AUDIO.MAX_CONCURRENT_SOURCES of them up front and never create another.
 *
 * This file imports nothing from `src/game/`. The audio engine has to stand alone.
 */

import { AUDIO } from '../config'
import {
  audioContext,
  masterGain,
  noiseBuffer,
  listenerPose,
  ramp,
  cancelRamps,
  clamp,
  logLerp,
} from './context'

/** Oscillator shapes plus white noise. (spec) target = sine, hazard = sawtooth, wall = noise. */
export type Timbre = OscillatorType | 'noise'

export interface SourceVoice {
  timbre: Timbre
  /** Ignored when `timbre` is 'noise'. */
  frequency: number
  /** Level before distance attenuation, 0..1. */
  gain: number
  /**
   * Pulsed sources re-trigger their envelope at a rate driven by how close they are;
   * continuous sources hold a steady level. (spec) Pulse rate encodes proximity.
   */
  pulsed: boolean
  /** Pulse rate mapping, required when `pulsed`. Rates in pulses/sec, distances in units. */
  pulse?: {
    rateFar: number
    rateNear: number
    distanceFar: number
    distanceNear: number
    length: number
  }
  /**
   * Caps the lowpass cutoff, Hz. Used by the wall voice to keep white noise from being
   * a full-spectrum hiss. Distance and rear shadowing still apply on top.
   */
  maxCutoffHz?: number
}

export class BinauralSource {
  private readonly panner: PannerNode
  private readonly filter: BiquadFilterNode
  private readonly envGain: GainNode
  private readonly osc: OscillatorNode
  private readonly oscGain: GainNode
  private readonly noiseGain: GainNode

  /** Assigned once; hides the deprecated PannerNode.setPosition path the same way the listener does. */
  private readonly applyPosition: (x: number, y: number, z: number) => void

  private voice: SourceVoice | null = null
  private readonly position = { x: 0, y: 0, z: 0 }
  /** Distance to the listener as of the last update, units. Read by the pool for diagnostics. */
  private distance = 0
  /** Next scheduled pulse, on the AudioContext clock. */
  private nextPulseTime = 0

  constructor() {
    const ctx = audioContext()

    this.panner = ctx.createPanner()
    this.panner.panningModel = AUDIO.PANNER.panningModel
    this.panner.distanceModel = AUDIO.PANNER.distanceModel
    this.panner.refDistance = AUDIO.PANNER.refDistance
    this.panner.maxDistance = AUDIO.PANNER.maxDistance
    this.panner.rolloffFactor = AUDIO.PANNER.rolloffFactor
    this.panner.connect(masterGain())

    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = AUDIO.FILTER_NEAR_HZ
    // Flat: this filter is a distance/shadowing model, not a resonant effect.
    this.filter.Q.value = AUDIO.FILTER_Q
    this.filter.connect(this.panner)

    this.envGain = ctx.createGain()
    this.envGain.gain.value = 0
    this.envGain.connect(this.filter)

    this.oscGain = ctx.createGain()
    this.oscGain.gain.value = 1
    this.oscGain.connect(this.envGain)

    this.noiseGain = ctx.createGain()
    this.noiseGain.gain.value = 0
    this.noiseGain.connect(this.envGain)

    this.osc = ctx.createOscillator()
    this.osc.type = 'sine'
    this.osc.frequency.value = 440
    this.osc.connect(this.oscGain)
    this.osc.start()

    const noise = ctx.createBufferSource()
    noise.buffer = noiseBuffer()
    noise.loop = true
    noise.connect(this.noiseGain)
    noise.start()

    this.applyPosition = makePositionSetter(this.panner)
  }

  get isFree(): boolean {
    return this.voice === null
  }

  /** Distance to the listener as of the last `update()`, units. */
  get distanceToListener(): number {
    return this.distance
  }

  /** Takes this source out of the free pool and starts voicing it. */
  acquire(voice: SourceVoice): void {
    const ctx = audioContext()
    const now = ctx.currentTime
    this.voice = voice

    const wantsNoise = voice.timbre === 'noise'
    if (voice.timbre !== 'noise') {
      this.osc.type = voice.timbre
      this.osc.frequency.setTargetAtTime(voice.frequency, now, AUDIO.PARAM_SMOOTHING)
    }
    this.oscGain.gain.setTargetAtTime(wantsNoise ? 0 : 1, now, AUDIO.TIMBRE_FADE)
    this.noiseGain.gain.setTargetAtTime(wantsNoise ? 1 : 0, now, AUDIO.TIMBRE_FADE)

    cancelRamps(this.envGain.gain, now)
    if (voice.pulsed) {
      this.envGain.gain.setValueAtTime(0, now)
      this.nextPulseTime = now
    } else {
      this.envGain.gain.setTargetAtTime(voice.gain, now, AUDIO.VOICE_FADE)
    }
  }

  /** Silences the source and returns it to the pool. The oscillator keeps running. */
  release(): void {
    if (!this.voice) return
    const now = audioContext().currentTime
    cancelRamps(this.envGain.gain, now)
    this.envGain.gain.setTargetAtTime(0, now, AUDIO.VOICE_FADE)
    this.voice = null
  }

  /** World position, audio coordinates. Applied on the next `update()`. */
  setPosition(x: number, y: number, z: number): void {
    this.position.x = x
    this.position.y = y
    this.position.z = z
  }

  /** Retunes a live voice without re-acquiring it. */
  setFrequency(hz: number): void {
    if (!this.voice || this.voice.timbre === 'noise') return
    this.voice.frequency = hz
    ramp(this.osc.frequency, hz)
  }

  /**
   * One immediate accent, outside the normal rate. Used by the sonar ping, which is
   * exactly "make everything nearby announce itself once".
   *
   * A pulsed voice gets an extra pulse. A continuous voice cannot: its envelope would
   * be left at zero and the hum would never come back, so it swells and settles instead.
   */
  pulseOnce(): void {
    const voice = this.voice
    if (!voice) return
    const now = audioContext().currentTime
    const length = Math.min(
      voice.pulse?.length ?? AUDIO.DEFAULT_PULSE_LENGTH,
      AUDIO.PULSE_ONCE_MAX_LENGTH,
    )

    if (!voice.pulsed) {
      const gain = this.envGain.gain
      cancelRamps(gain, now)
      gain.linearRampToValueAtTime(
        voice.gain * AUDIO.PULSE_ONCE_BOOST,
        now + length * AUDIO.PULSE_ONCE_BOOST_ATTACK_RATIO,
      )
      gain.linearRampToValueAtTime(voice.gain, now + length)
      return
    }

    this.emitPulse(now, length)
    // Push the scheduled pulse train past this one so the two do not overlap.
    this.nextPulseTime = Math.max(this.nextPulseTime, now + length * AUDIO.PULSE_ONCE_SPACING)
  }

  /**
   * Called once per frame, after the listener pose has been updated.
   *
   * Recomputes the two cues this node is responsible for — the lowpass cutoff (distance
   * plus rear shadowing) and the pulse schedule — then hands the position to the panner.
   */
  update(): void {
    const voice = this.voice
    if (!voice) return

    const ctx = audioContext()
    const now = ctx.currentTime
    const pose = listenerPose()

    this.applyPosition(this.position.x, this.position.y, this.position.z)

    const dx = this.position.x - pose.position.x
    const dy = this.position.y - pose.position.y
    const dz = this.position.z - pose.position.z
    const distance = Math.hypot(dx, dy, dz)
    this.distance = distance

    // cos of the angle between "where the listener is looking" and "where this source is".
    // +1 is dead ahead, 0 is directly beside, -1 is directly behind.
    const cosAngle =
      distance < 1e-6
        ? 1
        : clamp((dx * pose.forward.x + dy * pose.forward.y + dz * pose.forward.z) / distance, -1, 1)

    let cutoff = Math.min(distanceCutoff(distance), rearCutoff(cosAngle))
    if (voice.maxCutoffHz !== undefined) cutoff = Math.min(cutoff, voice.maxCutoffHz)
    ramp(this.filter.frequency, cutoff)

    if (voice.pulsed) this.schedulePulses(now, distance, voice)
  }

  /**
   * Fills the lookahead window with pulse envelopes.
   *
   * The pulse rate is sampled per pulse from the distance at scheduling time, so a
   * source the player is walking towards speeds up smoothly without any of it being
   * driven by frame timing.
   */
  private schedulePulses(now: number, distance: number, voice: SourceVoice): void {
    const map = voice.pulse
    if (!map) return

    const horizon = now + AUDIO.SCHEDULE_LOOKAHEAD
    // If the tab was backgrounded the schedule can fall far behind; resync rather than
    // burning a loop emitting hundreds of pulses into the past.
    if (this.nextPulseTime < now) this.nextPulseTime = now

    let guard = 0
    while (this.nextPulseTime < horizon && guard++ < AUDIO.MAX_PULSES_PER_UPDATE) {
      const t = this.nextPulseTime
      const rate = pulseRate(distance, map)
      const period = 1 / rate
      // Never let a pulse run into the next one; see AUDIO.PULSE_DUTY.
      const length = Math.min(map.length, period * AUDIO.PULSE_DUTY)
      this.emitPulse(t, length)
      this.nextPulseTime = t + period
    }
  }

  /** One attack/decay envelope on the shared gain node. */
  private emitPulse(at: number, length: number): void {
    const voice = this.voice
    if (!voice) return
    const gain = this.envGain.gain
    const attack = Math.min(AUDIO.PULSE_ATTACK, length * AUDIO.PULSE_ATTACK_MAX_RATIO)
    gain.setValueAtTime(0, at)
    gain.linearRampToValueAtTime(voice.gain, at + attack)
    gain.linearRampToValueAtTime(0, at + length)
  }
}

/**
 * Fixed-size pool of binaural sources.
 *
 * Every panner is built at construction time. `acquire` returning null is a real
 * possibility the caller must handle — it means the game asked for more simultaneous
 * sounds than the HRTF budget allows, and the right answer is to drop the least
 * important one, not to allocate another panner.
 */
export class SourcePool {
  private readonly sources: BinauralSource[]

  constructor(size: number = AUDIO.MAX_CONCURRENT_SOURCES) {
    this.sources = Array.from({ length: size }, () => new BinauralSource())
  }

  get size(): number {
    return this.sources.length
  }

  get activeCount(): number {
    return this.sources.reduce((n, s) => n + (s.isFree ? 0 : 1), 0)
  }

  acquire(voice: SourceVoice): BinauralSource | null {
    const free = this.sources.find((s) => s.isFree)
    if (!free) return null
    free.acquire(voice)
    return free
  }

  release(source: BinauralSource | null): void {
    source?.release()
  }

  /** Call once per frame, after the listener pose is set. */
  update(): void {
    for (const source of this.sources) source.update()
  }

  releaseAll(): void {
    for (const source of this.sources) source.release()
  }
}

/** Distance -> lowpass cutoff. Far sources lose their highs, as they would in air. */
function distanceCutoff(distance: number): number {
  const t = clamp(distance / AUDIO.PANNER.maxDistance, 0, 1)
  return logLerp(AUDIO.FILTER_NEAR_HZ, AUDIO.FILTER_FAR_HZ, t)
}

/**
 * Off-axis angle -> lowpass cutoff. This is the front/back disambiguation cue.
 *
 * `(1 - cos) / 2` maps dead-ahead to 0 and directly-behind to 1, smoothly and with no
 * trigonometry. Raising it to REAR_SHADOW_CURVE keeps the front hemisphere bright and
 * concentrates the shadowing behind the 90-degree line, which is where SPEC.md asks for
 * it and where generic HRTFs actually fail.
 */
function rearCutoff(cosAngle: number): number {
  const t = Math.pow((1 - cosAngle) / 2, AUDIO.REAR_SHADOW_CURVE)
  return logLerp(AUDIO.REAR_FRONT_HZ, AUDIO.REAR_BEHIND_HZ, t)
}

/** Distance -> pulses per second, linear and clamped at both ends. */
function pulseRate(distance: number, map: NonNullable<SourceVoice['pulse']>): number {
  const span = map.distanceFar - map.distanceNear
  const t = span <= 0 ? 0 : clamp((distance - map.distanceNear) / span, 0, 1)
  return map.rateNear + (map.rateFar - map.rateNear) * t
}

/**
 * Older Safari exposes PannerNode position as setters rather than AudioParams, exactly
 * as it does for the listener. Branch once per node, never per frame.
 */
function makePositionSetter(panner: PannerNode): (x: number, y: number, z: number) => void {
  if ('positionX' in panner && panner.positionX) {
    return (x, y, z) => {
      const t = audioContext().currentTime
      const tc = AUDIO.PARAM_SMOOTHING
      panner.positionX.setTargetAtTime(x, t, tc)
      panner.positionY.setTargetAtTime(y, t, tc)
      panner.positionZ.setTargetAtTime(z, t, tc)
    }
  }
  const legacy = panner as unknown as { setPosition(x: number, y: number, z: number): void }
  return (x, y, z) => legacy.setPosition(x, y, z)
}
