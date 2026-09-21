/**
 * One-shot cues: the sounds that happen *to* the player rather than sounds that exist
 * at a place in the world.
 *
 * These are deliberately NOT panned. A collect cue or a collision cue is feedback about
 * the player's own state, and putting it through an HRTF would both waste a panner from
 * the pool and imply a direction that does not mean anything. Positional objects — the
 * beacon, hazards, walls — go through `BinauralSource` instead.
 *
 * Each cue builds its nodes, schedules its whole envelope against `ctx.currentTime`, and
 * tears itself down in `onended`. Per-shot construction is the correct pattern here:
 * an OscillatorNode cannot be restarted once stopped, and these are short and infrequent
 * enough that allocation cost does not matter.
 */

import { AUDIO, CUES } from "../config";
import { audioContext, masterGain, noiseBuffer } from "./context";

/** Last centre-lock tick, on the AudioContext clock. Drives the rate limit. */
let lastCentreTick = -Infinity;

/**
 * (spec) Sonar ping: filtered noise sweeping 300 -> 1200 Hz over 120 ms.
 *
 * The rising sweep is the player's own emitter going out; the objects that answer it do
 * so through their own binaural sources, which is what makes the ping directional.
 */
export function playPing(): void {
    const ctx = audioContext();
    const now = ctx.currentTime;
    const { fromHz, toHz, duration, gain, q, attack } = CUES.PING;

    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer();

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = q;
    band.frequency.setValueAtTime(fromHz, now);
    band.frequency.exponentialRampToValueAtTime(toHz, now + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + attack);
    env.gain.exponentialRampToValueAtTime(AUDIO.SILENCE_FLOOR, now + duration);

    source.connect(band).connect(env).connect(masterGain());
    source.start(now);
    source.stop(now + duration + AUDIO.CUE_TAIL);
    source.onended = () => disconnect(source, band, env);
}

/** (spec) "In range" — two-tone rising sine, 200 ms. */
export function playInRange(): void {
    playToneSequence(CUES.IN_RANGE);
}

/** (spec) "Collected" — three-tone rising arpeggio, 300 ms. */
export function playCollect(): void {
    playToneSequence(CUES.COLLECT);
}

/** (spec) Hazard struck — 80 Hz square burst, 250 ms. */
export function playCollision(): void {
    const ctx = audioContext();
    const now = ctx.currentTime;
    const { frequency, duration, gain, attack, lowpassHz } = CUES.COLLISION;

    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(frequency, now);

    // A square wave at 80 Hz is mostly harmonics; rolling them off keeps it a thud rather
    // than a buzz, which matters when it fires unexpectedly into headphones.
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.setValueAtTime(lowpassHz, now);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + attack);
    env.gain.exponentialRampToValueAtTime(AUDIO.SILENCE_FLOOR, now + duration);

    osc.connect(lowpass).connect(env).connect(masterGain());
    osc.start(now);
    osc.stop(now + duration + AUDIO.CUE_TAIL);
    osc.onended = () => disconnect(osc, lowpass, env);
}

/**
 * (spec) Centre-lock tick: "you are aimed correctly".
 *
 * Non-pitched on purpose. The player is already tracking a 660 Hz sine; a second tone
 * would have to be judged relative to the first, and judging small differences is
 * precisely what generic HRTFs are bad at. A click is a binary signal instead.
 *
 * Rate-limited here rather than at the call site so the game loop can call it every
 * frame it is on target without thinking about it.
 */
export function playCentreTick(): void {
    const ctx = audioContext();
    const now = ctx.currentTime;
    if (now - lastCentreTick < CUES.CENTRE_TICK.MIN_INTERVAL) return;
    lastCentreTick = now;

    const { duration, filterHz, gain, q, attackRatio } = CUES.CENTRE_TICK;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer();

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = q;
    band.frequency.setValueAtTime(filterHz, now);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + duration * attackRatio);
    env.gain.linearRampToValueAtTime(0, now + duration);

    source.connect(band).connect(env).connect(masterGain());
    source.start(now);
    source.stop(now + duration + AUDIO.CUE_TAIL);
    source.onended = () => disconnect(source, band, env);
}

/** Lets the countdown of a fresh round start from a clean slate. */
export function resetCentreTick(): void {
    lastCentreTick = -Infinity;
}

/**
 * A calibration tone in one ear only, used during onboarding to confirm the player has
 * their headphones on the right way round.
 *
 * Routed through a ChannelMerger with the signal on a single input, which is a hard,
 * unambiguous pan. A PannerNode placed to the side would leak into the other ear by
 * design — correct for the world, useless for "is this your left?".
 *
 * Resolves when the tone has finished, so onboarding can sequence left then right.
 */
export function playCalibrationTone(side: "left" | "right"): Promise<void> {
    const ctx = audioContext();
    const now = ctx.currentTime;
    const { frequency, duration, gain, attack, release } = CUES.CALIBRATION;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(frequency, now);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + attack);
    env.gain.setValueAtTime(gain, now + duration - release);
    env.gain.linearRampToValueAtTime(0, now + duration);

    const merger = ctx.createChannelMerger(2);
    osc.connect(env);
    env.connect(merger, 0, side === "left" ? 0 : 1);
    merger.connect(masterGain());

    osc.start(now);
    osc.stop(now + duration + AUDIO.CUE_TAIL);

    return new Promise((resolve) => {
        osc.onended = () => {
            disconnect(osc, env, merger);
            resolve();
        };
    });
}

/** Shape of the rising two- and three-note cues. */
interface ToneSequence {
    readonly tones: readonly number[];
    readonly duration: number;
    readonly gain: number;
    readonly attack: number;
    readonly overlap: number;
}

/** Shared implementation for the rising two- and three-note cues. Always sine. */
function playToneSequence({
    tones,
    duration,
    gain,
    attack,
    overlap,
}: ToneSequence): void {
    const ctx = audioContext();
    const now = ctx.currentTime;
    const step = duration / tones.length;
    // Notes overlap slightly so the arpeggio reads as one gesture, not separate blips.
    const noteLength = step * overlap;

    tones.forEach((frequency, index) => {
        const at = now + index * step;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(frequency, at);

        const env = ctx.createGain();
        env.gain.setValueAtTime(0, at);
        env.gain.linearRampToValueAtTime(gain, at + attack);
        env.gain.exponentialRampToValueAtTime(
            AUDIO.SILENCE_FLOOR,
            at + noteLength
        );

        osc.connect(env).connect(masterGain());
        osc.start(at);
        osc.stop(at + noteLength + AUDIO.CUE_TAIL);
        osc.onended = () => disconnect(osc, env);
    });
}

function disconnect(...nodes: AudioNode[]): void {
    for (const node of nodes) node.disconnect();
}
