import { describe, expect, it } from "vitest";
import { GAME } from "../src/config";
import { Player, bearing, wrapAngle } from "../src/game/player";

const PI = Math.PI;
const IDLE = { turnLeft: false, turnRight: false, forward: false };

describe("wrapAngle", () => {
    it("leaves an angle already in range alone", () => {
        for (const angle of [0, 1, -1, 3, -3]) expect(wrapAngle(angle)).toBe(angle);
    });

    it("keeps +PI and sends -PI to +PI: the range is (-PI, PI]", () => {
        expect(wrapAngle(PI)).toBe(PI);
        expect(wrapAngle(-PI)).toBe(PI);
    });

    it("wraps a little past PI round to just above -PI, and the mirror image", () => {
        expect(wrapAngle(PI + 0.1)).toBeCloseTo(-PI + 0.1, 12);
        expect(wrapAngle(-PI - 0.1)).toBeCloseTo(PI - 0.1, 12);
    });

    it("removes any number of whole turns", () => {
        expect(wrapAngle(2 * PI)).toBeCloseTo(0, 12);
        expect(wrapAngle(-2 * PI)).toBeCloseTo(0, 12);
        expect(wrapAngle(7 * 2 * PI + 0.5)).toBeCloseTo(0.5, 9);
        expect(wrapAngle(-7 * 2 * PI - 0.5)).toBeCloseTo(-0.5, 9);
    });

    it("always lands in (-PI, PI] and on the same direction it was given", () => {
        for (let angle = -25; angle <= 25; angle += 0.37) {
            const wrapped = wrapAngle(angle);
            expect(wrapped).toBeGreaterThan(-PI);
            expect(wrapped).toBeLessThanOrEqual(PI);
            expect(Math.sin(wrapped)).toBeCloseTo(Math.sin(angle), 9);
            expect(Math.cos(wrapped)).toBeCloseTo(Math.cos(angle), 9);
        }
    });
});

describe("bearing", () => {
    it("is 0 for due north and grows clockwise", () => {
        expect(bearing(0, 0, 0, 5)).toBe(0);
        expect(bearing(0, 0, 5, 0)).toBeCloseTo(PI / 2, 12);
        expect(bearing(0, 0, -5, 0)).toBeCloseTo(-PI / 2, 12);
        expect(bearing(0, 0, 5, 5)).toBeCloseTo(PI / 4, 12);
    });

    it("is +PI for due south, the closed end of the range", () => {
        expect(bearing(0, 0, 0, -5)).toBe(PI);
    });

    it("flips sign either side of due south", () => {
        expect(bearing(0, 0, 0.001, -5)).toBeGreaterThan(0);
        expect(bearing(0, 0, -0.001, -5)).toBeLessThan(0);
    });

    it("depends on where the two points are relative to each other, not on where they are", () => {
        expect(bearing(3, -2, 8, -2)).toBeCloseTo(bearing(0, 0, 5, 0), 12);
    });

    it("gives a relative bearing that wraps the short way round", () => {
        // Facing just west of south, a beacon just east of south is a small turn to the
        // left, not most of a turn to the right.
        const heading = wrapAngle(PI + 0.1);
        const toBeacon = bearing(0, 0, 0.5, -5);
        expect(Math.abs(wrapAngle(toBeacon - heading))).toBeLessThan(0.3);
    });
});

describe("Player", () => {
    it("turns right with the right arrow, at TURN_SPEED", () => {
        const player = new Player();
        player.update(0.5, { ...IDLE, turnRight: true });
        expect(player.heading).toBeCloseTo((GAME.TURN_SPEED * 0.5 * PI) / 180, 12);
        expect(player.isWalking).toBe(false);
    });

    it("walks the way it is facing, at PLAYER_SPEED", () => {
        const player = new Player();
        player.heading = PI / 2;
        player.update(1, { ...IDLE, forward: true });
        expect(player.x).toBeCloseTo(GAME.PLAYER_SPEED, 12);
        expect(player.y).toBeCloseTo(0, 12);
        expect(player.isWalking).toBe(true);
    });

    it("stops at the wall margin instead of leaving the arena", () => {
        const player = new Player();
        for (let i = 0; i < 60; i++) player.update(1, { ...IDLE, forward: true });
        expect(player.y).toBe(GAME.ARENA_SIZE / 2 - GAME.WALL_MARGIN);
    });
});
