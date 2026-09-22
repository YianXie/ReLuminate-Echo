import { describe, expect, it } from "vitest";
import { AUDIO, CUES } from "../src/config";
import {
    clamp,
    distanceCutoff,
    logLerp,
    pulseRate,
    rearCutoff,
    type PulseRateMap,
} from "../src/audio/math";

/** The beacon's own map, so these tests follow the config rather than a copy of it. */
const BEACON: PulseRateMap = {
    rateFar: CUES.TARGET.PULSE_RATE_FAR,
    rateNear: CUES.TARGET.PULSE_RATE_NEAR,
    distanceFar: CUES.TARGET.PULSE_FAR_DISTANCE,
    distanceNear: CUES.TARGET.PULSE_NEAR_DISTANCE,
};

/** Evenly spaced samples across [from, to], both ends included. */
function sweep(from: number, to: number, steps = 50): number[] {
    return Array.from(
        { length: steps + 1 },
        (_, i) => from + ((to - from) * i) / steps
    );
}

function expectStrictlyFalling(values: number[]): void {
    for (let i = 1; i < values.length; i++)
        expect(values[i]).toBeLessThan(values[i - 1] as number);
}

describe("clamp", () => {
    it("passes a value inside the range through, and pins one outside it", () => {
        expect(clamp(0.4, 0, 1)).toBe(0.4);
        expect(clamp(-3, 0, 1)).toBe(0);
        expect(clamp(7, 0, 1)).toBe(1);
        expect(clamp(0, 0, 1)).toBe(0);
        expect(clamp(1, 0, 1)).toBe(1);
    });
});

describe("logLerp", () => {
    it("returns the endpoints at 0 and 1", () => {
        expect(logLerp(18000, 2000, 0)).toBe(18000);
        expect(logLerp(18000, 2000, 1)).toBeCloseTo(2000, 9);
    });

    it("is geometric: halfway is the geometric mean, not the average", () => {
        expect(logLerp(18000, 2000, 0.5)).toBeCloseTo(6000, 9);
        expect(logLerp(100, 10000, 0.5)).toBeCloseTo(1000, 9);
    });

    it("clamps t, so it can never leave the range it was given", () => {
        expect(logLerp(18000, 2000, -2)).toBe(18000);
        expect(logLerp(18000, 2000, 5)).toBeCloseTo(2000, 9);
    });

    it("moves one way only, in whichever direction the endpoints run", () => {
        expectStrictlyFalling(sweep(0, 1).map((t) => logLerp(18000, 2000, t)));
        expectStrictlyFalling(
            sweep(0, 1).map((t) => -logLerp(2000, 18000, t))
        );
    });
});

describe("distanceCutoff", () => {
    it("is fully open on top of the listener", () => {
        expect(distanceCutoff(0)).toBe(AUDIO.FILTER_NEAR_HZ);
    });

    it("reaches the far cutoff at the panner's maximum distance and holds it beyond", () => {
        const max = AUDIO.PANNER.maxDistance;
        expect(distanceCutoff(max)).toBeCloseTo(AUDIO.FILTER_FAR_HZ, 9);
        expect(distanceCutoff(max * 3)).toBeCloseTo(AUDIO.FILTER_FAR_HZ, 9);
    });

    it("only ever gets duller with distance", () => {
        expectStrictlyFalling(
            sweep(0, AUDIO.PANNER.maxDistance).map(distanceCutoff)
        );
    });
});

describe("rearCutoff", () => {
    it("is fully open dead ahead", () => {
        expect(rearCutoff(1)).toBe(AUDIO.REAR_FRONT_HZ);
    });

    it("is fully shadowed directly behind", () => {
        expect(rearCutoff(-1)).toBeCloseTo(AUDIO.REAR_BEHIND_HZ, 9);
    });

    it("closes steadily as the source moves from ahead, round the side, to behind", () => {
        const cosines = sweep(0, Math.PI, 90).map(Math.cos);
        expectStrictlyFalling(cosines.map(rearCutoff));
    });

    it("keeps most of the shadowing for the rear half", () => {
        // At the side, less than half of the (logarithmic) travel has been used.
        const halfway = logLerp(AUDIO.REAR_FRONT_HZ, AUDIO.REAR_BEHIND_HZ, 0.5);
        expect(rearCutoff(0)).toBeGreaterThan(halfway);
    });

    it("is the same on the left as on the right: only the angle off axis matters", () => {
        // cos is even, so a source 60 degrees left and one 60 degrees right share a cosine.
        expect(rearCutoff(Math.cos(-1))).toBe(rearCutoff(Math.cos(1)));
    });
});

describe("pulseRate", () => {
    it("is the near rate at the near distance and anywhere inside it", () => {
        expect(pulseRate(BEACON.distanceNear, BEACON)).toBe(BEACON.rateNear);
        expect(pulseRate(0, BEACON)).toBe(BEACON.rateNear);
    });

    it("is the far rate at the far distance and anywhere beyond it", () => {
        expect(pulseRate(BEACON.distanceFar, BEACON)).toBeCloseTo(
            BEACON.rateFar,
            9
        );
        expect(pulseRate(BEACON.distanceFar * 4, BEACON)).toBeCloseTo(
            BEACON.rateFar,
            9
        );
    });

    it("is linear in between", () => {
        const middle = (BEACON.distanceNear + BEACON.distanceFar) / 2;
        expect(pulseRate(middle, BEACON)).toBeCloseTo(
            (BEACON.rateNear + BEACON.rateFar) / 2,
            9
        );
    });

    it("speeds up all the way in as the player closes on the beacon", () => {
        const approaching = sweep(BEACON.distanceFar, BEACON.distanceNear);
        expectStrictlyFalling(approaching.map((d) => -pulseRate(d, BEACON)));
    });

    it("falls back to the near rate for a map with no span, rather than dividing by zero", () => {
        const flat: PulseRateMap = { ...BEACON, distanceFar: 5, distanceNear: 5 };
        const inverted: PulseRateMap = { ...BEACON, distanceFar: 2, distanceNear: 9 };
        for (const distance of [0, 5, 50]) {
            expect(pulseRate(distance, flat)).toBe(BEACON.rateNear);
            expect(pulseRate(distance, inverted)).toBe(BEACON.rateNear);
        }
    });
});
