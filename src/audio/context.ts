/**
 * The AudioContext singleton, the master gain, and the listener wrapper.
 *
 * This module is the ONLY place in the codebase allowed to know which listener API the
 * browser implements. Current browsers expose the listener as AudioParams
 * (`listener.positionX` and friends), which can be ramped; older Safari only has the
 * deprecated `setPosition()` / `setOrientation()` methods, which cannot. We branch once
 * at startup and hide the difference behind `setListenerPose()`. Nothing downstream
 * needs to care, and nothing downstream is allowed to find out.
 *
 * Everything here is scheduled against `ctx.currentTime`. Wall-clock time (`Date.now`,
 * frame counters) is never used for audio: the audio thread runs on its own clock and
 * drifts from the render loop within seconds.
 */

import { AUDIO } from '../config'

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface ListenerPose {
  /** Listener position in audio-world coordinates (metres/units, y is up). */
  position: Vec3
  /** Unit vector the listener faces. */
  forward: Vec3
}

let ctx: AudioContext | null = null
let master: GainNode | null = null
let noise: AudioBuffer | null = null

/**
 * Applies a pose to the real listener. Assigned once, at context creation, to whichever
 * of the two implementations the browser supports.
 */
let applyPose: (pose: ListenerPose) => void = () => {}

/**
 * The pose most recently handed to `setListenerPose`. Sources read this to work out how
 * far off-axis they are, which is what drives rear shadowing. Kept here rather than
 * re-read from the AudioListener because the smoothed AudioParam values lag by design.
 */
const currentPose: ListenerPose = {
  position: { x: 0, y: 0, z: 0 },
  forward: { x: 0, y: 0, z: -1 },
}

/** True when the browser only has the deprecated listener API. Exposed for diagnostics. */
let usingLegacyListener = false

/**
 * Creates the context on first use. It will be `suspended` until a user gesture calls
 * `resumeAudio()`; that is a browser autoplay rule, not something we can design around.
 */
export function audioContext(): AudioContext {
  if (ctx) return ctx

  const Ctor = window.AudioContext ?? window.webkitAudioContext
  if (!Ctor) throw new Error('Web Audio API is not available in this browser.')
  ctx = new Ctor({ latencyHint: 'interactive' })

  master = ctx.createGain()
  master.gain.value = AUDIO.MASTER_VOLUME_DEFAULT
  master.connect(ctx.destination)

  configureListener(ctx)
  return ctx
}

/** The master gain every sound in the game passes through. */
export function masterGain(): GainNode {
  audioContext()
  return master as GainNode
}

/** 0..1. Applied smoothly so a volume change is never a click. */
export function setMasterVolume(volume: number): void {
  const now = audioContext().currentTime
  masterGain().gain.setTargetAtTime(clamp(volume, 0, 1), now, AUDIO.PARAM_SMOOTHING)
}

export function masterVolume(): number {
  return masterGain().gain.value
}

/** Resolves once the context is running. Must be called from a user-gesture handler. */
export async function resumeAudio(): Promise<void> {
  const c = audioContext()
  if (c.state !== 'running') await c.resume()
}

export function isAudioRunning(): boolean {
  return ctx !== null && ctx.state === 'running'
}

export function isUsingLegacyListener(): boolean {
  return usingLegacyListener
}

/**
 * White noise, generated once and shared. Mono, because a stereo buffer fed to a
 * PannerNode triggers downmix behaviour that undoes the HRTF work.
 */
export function noiseBuffer(): AudioBuffer {
  const c = audioContext()
  if (noise) return noise

  const length = Math.floor(c.sampleRate * AUDIO.NOISE_BUFFER_SECONDS)
  const buffer = c.createBuffer(1, length, c.sampleRate)
  const data = buffer.getChannelData(0)
  // Deterministic PRNG rather than Math.random: identical noise every run makes A/B
  // tuning of the wall and tick cues repeatable.
  let seed = 0x2545f491
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    data[i] = (seed >>> 0) / 0xffffffff * 2 - 1
  }
  noise = buffer
  return buffer
}

/**
 * Updates the listener once per frame.
 *
 * `up` is fixed at +y and every source sits at y = 0: SPEC.md rules out elevation
 * because generic HRTFs localise it poorly, so the whole game lives on a plane.
 */
export function setListenerPose(position: Vec3, forward: Vec3): void {
  currentPose.position.x = position.x
  currentPose.position.y = position.y
  currentPose.position.z = position.z
  currentPose.forward.x = forward.x
  currentPose.forward.y = forward.y
  currentPose.forward.z = forward.z
  applyPose(currentPose)
}

/** The pose as last set. Read by sources; never mutate the returned object. */
export function listenerPose(): Readonly<ListenerPose> {
  return currentPose
}

function configureListener(c: AudioContext): void {
  const listener = c.listener

  if ('positionX' in listener && listener.positionX) {
    // Modern path: the listener is a set of AudioParams, so it can be ramped. At 60 Hz,
    // assigning `.value` directly would step the HRTF convolution and zipper audibly.
    usingLegacyListener = false
    applyPose = (pose) => {
      const t = c.currentTime
      const tc = AUDIO.PARAM_SMOOTHING
      listener.positionX.setTargetAtTime(pose.position.x, t, tc)
      listener.positionY.setTargetAtTime(pose.position.y, t, tc)
      listener.positionZ.setTargetAtTime(pose.position.z, t, tc)
      listener.forwardX.setTargetAtTime(pose.forward.x, t, tc)
      listener.forwardY.setTargetAtTime(pose.forward.y, t, tc)
      listener.forwardZ.setTargetAtTime(pose.forward.z, t, tc)
      listener.upX.setTargetAtTime(0, t, tc)
      listener.upY.setTargetAtTime(1, t, tc)
      listener.upZ.setTargetAtTime(0, t, tc)
    }
    return
  }

  // Legacy path (older Safari). These setters are instantaneous, so the smoothing the
  // modern path gets for free has to be absent here. In practice the player turns slowly
  // enough relative to the frame rate that it is tolerable, and the alternative is no
  // binaural audio at all on those builds.
  usingLegacyListener = true
  const legacy = listener as unknown as {
    setPosition(x: number, y: number, z: number): void
    setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void
  }
  applyPose = (pose) => {
    legacy.setPosition(pose.position.x, pose.position.y, pose.position.z)
    legacy.setOrientation(pose.forward.x, pose.forward.y, pose.forward.z, 0, 1, 0)
  }
}

/**
 * Smooths a per-frame parameter change. (spec) Always this, never `param.value = x`.
 */
export function ramp(param: AudioParam, value: number, timeConstant = AUDIO.PARAM_SMOOTHING): void {
  param.setTargetAtTime(value, audioContext().currentTime, timeConstant)
}

/**
 * Clears scheduled automation without leaving a discontinuity.
 *
 * `cancelScheduledValues` alone snaps the param back to whatever value was last *set*,
 * which in the middle of a ramp is a click. `cancelAndHoldAtTime` is the correct call but
 * is not universally implemented, so fall back to pinning the current value by hand.
 */
export function cancelRamps(param: AudioParam, when: number): void {
  const holdable = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => void }
  if (typeof holdable.cancelAndHoldAtTime === 'function') {
    holdable.cancelAndHoldAtTime(when)
  } else {
    const held = param.value
    param.cancelScheduledValues(when)
    param.setValueAtTime(held, when)
  }
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Interpolates between two frequencies geometrically. Pitch and filter cutoff are
 * perceived logarithmically, so a linear sweep from 18 kHz to 2 kHz spends almost all of
 * its travel in a range the ear treats as identical.
 */
export function logLerp(from: number, to: number, t: number): number {
  return from * Math.pow(to / from, clamp(t, 0, 1))
}
