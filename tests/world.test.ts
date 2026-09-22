import { afterEach, describe, expect, it, vi } from "vitest";
import { GAME, PRACTICE } from "../src/config";
import type { SourcePool } from "../src/audio/source";
import { levelParameters, practiceParameters } from "../src/game/difficulty";
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

/**
 * A pool that can voice `size` things and no more. The sources are empty stand-ins: all
 * the world does with one outside update() is hold it and hand it back.
 */
function poolOf(size: number): SourcePool {
    let inUse = 0;
    return {
        acquire: () => (inUse < size ? { id: ++inUse } : null),
        release: () => {},
        releaseAll: () => {
            inUse = 0;
        },
        update: () => {},
    } as unknown as SourcePool;
}

describe("hazards the pool cannot voice", () => {
    afterEach(() => vi.restoreAllMocks());

    it("places every hazard when there is a source for each", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const world = new World(poolOf(8));
        world.start({ ...levelParameters(0), hazardCount: 5 });

        expect(world.hazards).toHaveLength(5);
        expect(world.hazards.every((hazard) => hazard.source)).toBe(true);
        expect(error).not.toHaveBeenCalled();
    });

    it("leaves out any hazard it has no source for, and says so loudly", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        // One source goes to the beacon, leaving three for five hazards.
        const world = new World(poolOf(4));
        world.start({ ...levelParameters(0), hazardCount: 5 });

        expect(world.hazards).toHaveLength(3);
        expect(world.hazards.every((hazard) => hazard.source)).toBe(true);
        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0]?.[0])).toMatch(/2 hazard/);
    });

    it("applies the same rule when the world is voiced again after a pause", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        let size = 8;
        let inUse = 0;
        const shrinking = {
            acquire: () => (inUse < size ? { id: ++inUse } : null),
            release: () => {},
            releaseAll: () => {
                inUse = 0;
            },
            update: () => {},
        } as unknown as SourcePool;

        const world = new World(shrinking);
        world.start({ ...levelParameters(0), hazardCount: 4 });
        expect(world.hazards).toHaveLength(4);

        world.silence();
        size = 3;
        world.resume();

        // Beacon first, then two hazards. The two with no voice are gone, not silent.
        expect(world.hazards).toHaveLength(2);
        expect(world.hazards.every((hazard) => hazard.source)).toBe(true);
        expect(error).toHaveBeenCalledTimes(1);
    });
});
