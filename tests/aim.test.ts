import { describe, expect, it } from "vitest";
import { CUES, GAME, LOOP } from "../src/config";
import { CentreLock, centreTolerance, type CentreTick } from "../src/game/aim";

const DT = LOOP.FIXED_DT;
const RADIUS = 1.5;

describe("centreTolerance", () => {
    it("is the fixed tolerance across most of the arena", () => {
        expect(centreTolerance(RADIUS, 28)).toBe(GAME.CENTRE_TOLERANCE);
        expect(centreTolerance(RADIUS, 18)).toBe(GAME.CENTRE_TOLERANCE);
    });

    it("widens to the angle the collect radius covers once that is larger", () => {
        // atan(1.5 / 3) is 26.57 degrees: the figure the fixed 5 degree cone was losing to.
        expect(centreTolerance(RADIUS, 3)).toBeCloseTo(26.565, 3);
        expect(centreTolerance(RADIUS, RADIUS)).toBeCloseTo(45, 10);
    });

    it("takes over exactly where the two are equal", () => {
        const crossover =
            RADIUS / Math.tan((GAME.CENTRE_TOLERANCE * Math.PI) / 180);
        expect(centreTolerance(RADIUS, crossover * 1.01)).toBe(
            GAME.CENTRE_TOLERANCE
        );
        expect(centreTolerance(RADIUS, crossover * 0.99)).toBeGreaterThan(
            GAME.CENTRE_TOLERANCE
        );
    });

    it("never narrows as the player closes in", () => {
        let previous = 0;
        for (let distance = 28; distance >= 0; distance -= 0.25) {
            const tolerance = centreTolerance(RADIUS, distance);
            expect(tolerance).toBeGreaterThanOrEqual(previous);
            previous = tolerance;
        }
    });

    it("is a finite 90 degrees standing on the beacon", () => {
        expect(centreTolerance(RADIUS, 0)).toBe(90);
    });

    it("scales with the collect radius in effect", () => {
        expect(centreTolerance(2, 4)).toBeGreaterThan(centreTolerance(1.2, 4));
    });
});

/** Runs the lock for `seconds` with the aim held constant and returns every step's verdict. */
function hold(
    lock: CentreLock,
    seconds: number,
    aimed: boolean,
    mode: "continuous" | "edge"
): CentreTick[] {
    const ticks: CentreTick[] = [];
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) ticks.push(lock.step(DT, aimed, mode));
    return ticks;
}

function count(ticks: CentreTick[], kind: CentreTick): number {
    return ticks.filter((tick) => tick === kind).length;
}

describe("CentreLock in edge mode", () => {
    it("is silent while the player is off axis", () => {
        const ticks = hold(new CentreLock(), 2, false, "edge");
        expect(count(ticks, "none")).toBe(ticks.length);
    });

    it("ticks once, at once, on entering the window", () => {
        const lock = new CentreLock();
        hold(lock, 0.5, false, "edge");
        expect(lock.step(DT, true, "edge")).toBe("entry");
        expect(lock.step(DT, true, "edge")).toBe("none");
    });

    it("then repeats only every EDGE_REPEAT_INTERVAL while held", () => {
        const lock = new CentreLock();
        const interval = CUES.CENTRE_TICK.EDGE_REPEAT_INTERVAL;
        const ticks = hold(lock, interval * 3.5, true, "edge");

        expect(ticks[0]).toBe("entry");
        expect(count(ticks, "entry")).toBe(1);
        expect(count(ticks, "held")).toBe(3);

        const gaps = ticks
            .map((tick, index) => (tick === "none" ? -1 : index))
            .filter((index) => index >= 0)
            .map((index, i, all) => (i === 0 ? 0 : index - (all[i - 1] ?? 0)))
            .slice(1);
        // Accumulated floating-point steps may land a frame late, never early.
        for (const gap of gaps) {
            expect(gap * DT).toBeGreaterThanOrEqual(interval - 1e-9);
            expect(gap * DT).toBeLessThan(interval + 2 * DT);
        }
    });

    it("ticks immediately on re-entry, however recently it last ticked", () => {
        const lock = new CentreLock();
        expect(lock.step(DT, true, "edge")).toBe("entry");
        expect(lock.step(DT, false, "edge")).toBe("none");
        expect(lock.step(DT, true, "edge")).toBe("entry");
    });

    it("starts the repeat interval again from each entry", () => {
        const lock = new CentreLock();
        const interval = CUES.CENTRE_TICK.EDGE_REPEAT_INTERVAL;
        hold(lock, interval * 0.9, true, "edge");
        lock.step(DT, false, "edge");
        const ticks = hold(lock, interval * 0.9, true, "edge");
        expect(ticks[0]).toBe("entry");
        expect(count(ticks, "held")).toBe(0);
    });

    it("treats the first aimed step after a reset as an entry", () => {
        const lock = new CentreLock();
        hold(lock, 0.3, true, "edge");
        lock.reset();
        expect(lock.step(DT, true, "edge")).toBe("entry");
    });
});

describe("CentreLock in continuous mode", () => {
    it("asks for the rate-limited tick on every aimed step, as v0.1 did", () => {
        const lock = new CentreLock();
        const ticks = hold(lock, 1, true, "continuous");
        expect(count(ticks, "held")).toBe(ticks.length);
        expect(lock.step(DT, false, "continuous")).toBe("none");
        expect(lock.step(DT, true, "continuous")).toBe("held");
    });
});
