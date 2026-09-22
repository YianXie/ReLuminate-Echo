/**
 * The arithmetic of the audio engine: every mapping from geometry to a filter cutoff or a
 * pulse rate, with no AudioContext in sight.
 *
 * Kept apart from `context.ts` and `source.ts` so that the numbers the player's ears
 * depend on can be tested in plain Node. Nothing here touches a node, a clock or the DOM.
 *
 * Like the rest of `src/audio/`, this imports nothing from `src/game/`.
 */

import { AUDIO } from "../config";

/** How a pulsed voice's repetition rate follows distance. Rates in pulses/sec, distances in units. */
export interface PulseRateMap {
    rateFar: number;
    rateNear: number;
    distanceFar: number;
    distanceNear: number;
}

export function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

/**
 * Interpolates between two frequencies geometrically. Pitch and filter cutoff are
 * perceived logarithmically, so a linear sweep from 18 kHz to 2 kHz spends almost all of
 * its travel in a range the ear treats as identical.
 */
export function logLerp(from: number, to: number, t: number): number {
    return from * Math.pow(to / from, clamp(t, 0, 1));
}

/** Distance -> lowpass cutoff. Far sources lose their highs, as they would in air. */
export function distanceCutoff(distance: number): number {
    const t = clamp(distance / AUDIO.PANNER.maxDistance, 0, 1);
    return logLerp(AUDIO.FILTER_NEAR_HZ, AUDIO.FILTER_FAR_HZ, t);
}

/**
 * Off-axis angle -> lowpass cutoff. This is the front/back disambiguation cue.
 *
 * `(1 - cos) / 2` maps dead-ahead to 0 and directly-behind to 1, smoothly and with no
 * trigonometry. Raising it to REAR_SHADOW_CURVE keeps the front hemisphere bright and
 * concentrates the shadowing behind the 90-degree line, which is where SPEC.md asks for
 * it and where generic HRTFs actually fail.
 */
export function rearCutoff(cosAngle: number): number {
    const t = Math.pow((1 - cosAngle) / 2, AUDIO.REAR_SHADOW_CURVE);
    return logLerp(AUDIO.REAR_FRONT_HZ, AUDIO.REAR_BEHIND_HZ, t);
}

/** Distance -> pulses per second, linear and clamped at both ends. */
export function pulseRate(distance: number, map: PulseRateMap): number {
    const span = map.distanceFar - map.distanceNear;
    const t = span <= 0 ? 0 : clamp((distance - map.distanceNear) / span, 0, 1);
    return map.rateNear + (map.rateFar - map.rateNear) * t;
}
