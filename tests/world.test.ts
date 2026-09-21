import { describe, expect, it } from "vitest";
import { GAME, PRACTICE } from "../src/config";
import type { SourcePool } from "../src/audio/source";
import { practiceParameters } from "../src/game/difficulty";
import { World } from "../src/game/world";

/**
 * A pool with nothing in it. Placement is pure geometry, so the world can be laid out in
 * plain Node as long as nothing calls `update()`, which is where the sounds are made.
 */
const SILENT_POOL = {
    acquire: () => null,
    release: () => {},
    releaseAll: () => {},
    update: () => {},
} as unknown as SourcePool;

const DEG = Math.PI / 180;
/** Nothing spawns beyond this, measured from the centre. */
const LIMIT = GAME.ARENA_SIZE / 2 - GAME.WALL_MARGIN * 2;

function practiceWorld(): World {
    const world = new World(SILENT_POOL);
    world.start(practiceParameters());
    return world;
}

describe("World.spawnTargetAt", () => {
    it("puts a positive bearing to the player's right", () => {
        const world = practiceWorld();
        world.spawnTargetAt(90, 10);

        // Facing north from the centre, right is east.
        expect(world.target.x).toBeCloseTo(10, 10);
        expect(world.target.y).toBeCloseTo(0, 10);
        expect(world.bearingToTarget).toBeCloseTo(90, 10);
        expect(world.distanceToTarget).toBeCloseTo(10, 10);
    });

    it("puts a negative bearing to the left, and past 90 degrees behind", () => {
        const world = practiceWorld();
        world.spawnTargetAt(-135, 10);

        expect(world.target.x).toBeLessThan(0);
        expect(world.target.y).toBeLessThan(0);
        expect(world.bearingToTarget).toBeCloseTo(-135, 10);
    });

    it("measures the bearing from where the player is facing at that moment, not from north", () => {
        const world = practiceWorld();
        world.player.x = 3;
        world.player.y = -2;
        world.player.heading = 90 * DEG;
        world.spawnTargetAt(-135, 10);

        expect(world.bearingToTarget).toBeCloseTo(-135, 10);
        expect(world.distanceToTarget).toBeCloseTo(10, 10);
        // Facing east, behind-left is north-west.
        expect(world.target.x).toBeLessThan(world.player.x);
        expect(world.target.y).toBeGreaterThan(world.player.y);
    });

    it("pulls a spot beyond the wall back inside it, as a random spawn would be", () => {
        const world = practiceWorld();
        world.player.x = 15;
        world.spawnTargetAt(90, 10);

        expect(world.target.x).toBe(LIMIT);
        expect(world.target.y).toBeCloseTo(0, 10);
    });

    it("starts a fresh hunt: the new beacon is never already in range", () => {
        const world = practiceWorld();
        world.spawnTargetAt(0, 10);
        expect(world.isTargetInRange).toBe(false);
    });
});

describe("the practice script", () => {
    it("opens with a beacon to the right, because the spoken instruction says so", () => {
        const [first] = PRACTICE.BEACONS;
        expect(first.bearingDeg).toBeGreaterThan(0);
        expect(first.bearingDeg).toBeLessThan(180);
    });

    it("keeps every beacon inside the walls with room to spare when played from the centre", () => {
        const world = practiceWorld();
        for (const beacon of PRACTICE.BEACONS) {
            world.spawnTargetAt(beacon.bearingDeg, beacon.distance);
            // Not clamped, so the player walks the distance the script promises.
            expect(world.distanceToTarget).toBeCloseTo(beacon.distance, 10);

            // Walk onto it and face the way they came, as a player who turned and walked would.
            const heading = Math.atan2(
                world.target.x - world.player.x,
                world.target.y - world.player.y
            );
            world.player.x = world.target.x;
            world.player.y = world.target.y;
            world.player.heading = heading;
        }
    });
});
