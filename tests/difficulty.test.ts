import { describe, expect, it } from "vitest";
import { AUDIO, DIFFICULTY, GAME } from "../src/config";
import {
    Staircase,
    createDifficulty,
    levelParameters,
    maxVoicedHazards,
    practiceParameters,
    validateLevels,
    type DifficultyLevel,
    type RoundOutcome,
} from "../src/game/difficulty";

/** Six rows, told apart by hazard count, every one with a ten second budget. */
const LEVELS: readonly DifficultyLevel[] = [0, 1, 2, 3, 4, 5].map((n) => ({
    hazardCount: n,
    collectRadius: 2 - n * 0.1,
    hazardRadius: 1,
    minSpawnDistance: 6,
    acquireBudgetSeconds: 10,
}));

const HIT = 4;
const MISS = 25;

/**
 * A round's outcome from its hunts: seconds per collected beacon, then how long the hunt
 * the clock cut short had been running, if there was one.
 */
function outcome(seconds: number[], cutShortAfter?: number): RoundOutcome {
    return {
        score: seconds.length,
        hazardHits: 0,
        durationSeconds: 60,
        acquisitionSeconds: seconds,
        abandonedHuntSeconds: cutShortAfter === undefined ? [] : [cutShortAfter],
    };
}

function staircase(startLevel: number, options = {}): Staircase {
    return new Staircase({ levels: LEVELS, startLevel, ...options });
}

/** Plays one round with the given hunts and returns the level the NEXT round starts at. */
function after(
    controller: Staircase,
    seconds: number[],
    cutShortAfter?: number
): number {
    controller.record(outcome(seconds, cutShortAfter));
    return controller.next().level;
}

describe("the staircase", () => {
    it("starts at the start level, which the player hears counted from 1", () => {
        expect(staircase(2).next().level).toBe(3);
        expect(staircase(0).next().level).toBe(1);
    });

    it("hands out the parameters of the row it is on", () => {
        const parameters = staircase(3).next();
        expect(parameters.hazardCount).toBe(3);
        expect(parameters.collectRadius).toBeCloseTo(1.7, 12);
        expect(parameters.acquireBudgetSeconds).toBe(10);
        expect(parameters.roundSeconds).toBe(GAME.ROUND_SECONDS);
        expect(parameters.hazardPenalty).toBe(GAME.HAZARD_PENALTY);
    });

    it("steps up one level after two successes in a row", () => {
        const controller = staircase(2);
        controller.next();
        expect(after(controller, [HIT, HIT])).toBe(4);
    });

    it("does not step up on a single success", () => {
        const controller = staircase(2);
        controller.next();
        expect(after(controller, [HIT])).toBe(3);
    });

    it("steps down one level on a single failure", () => {
        const controller = staircase(2);
        controller.next();
        expect(after(controller, [MISS])).toBe(2);
    });

    it("needs the two successes to be consecutive: a failure between them starts the count again", () => {
        const controller = staircase(3);
        controller.next();
        // up? no: hit, miss (down to 2), hit. One success on the books, not two.
        expect(after(controller, [HIT, MISS, HIT])).toBe(3);
    });

    it("starts counting again after each step up", () => {
        const controller = staircase(1);
        controller.next();
        // Three successes are one step and one towards the next, not two steps.
        expect(after(controller, [HIT, HIT, HIT])).toBe(3);
    });

    it("carries a lone success over into the next round", () => {
        const controller = staircase(2);
        controller.next();
        expect(after(controller, [HIT])).toBe(3);
        expect(after(controller, [HIT])).toBe(4);
    });

    it("counts a beacon collected exactly on the budget as a success, and one a moment over as a failure", () => {
        const onTime = staircase(2);
        onTime.next();
        expect(after(onTime, [10, 10])).toBe(4);

        const late = staircase(2);
        late.next();
        expect(after(late, [10.001])).toBe(2);
    });

    it("counts a hunt that had overrun its budget when the clock ran out as a failure, after the collected ones", () => {
        const controller = staircase(2);
        controller.next();
        // Up one for the two hits, back down one for the hunt that was already lost.
        expect(after(controller, [HIT, HIT], MISS)).toBe(3);

        // A player who never found anything: one sixty-second hunt, a failure.
        const idle = staircase(2);
        idle.next();
        expect(after(idle, [], 60)).toBe(2);
    });

    // Nearly every round ends with a hunt in progress, because a new beacon appears the
    // moment one is collected. Scored as a failure regardless, that would end every round
    // on a step down and put the top level out of reach altogether.
    it("ignores a hunt the clock cut short while it was still inside its budget", () => {
        const controller = staircase(2);
        controller.next();
        expect(after(controller, [HIT, HIT], 3)).toBe(4);
        expect(after(controller, [], 10)).toBe(4);
        expect(after(controller, [], 10.001)).toBe(3);
    });

    it("lets a consistently good player reach the top level, and stay there", () => {
        const controller = staircase(2);
        controller.next();
        expect(after(controller, [HIT, HIT, HIT, HIT], 3)).toBe(5);
        expect(after(controller, [HIT, HIT, HIT, HIT], 3)).toBe(6);
        expect(after(controller, [HIT, HIT, HIT, HIT], 3)).toBe(6);
    });

    it("judges every hunt against the budget of the level being played", () => {
        const levels = LEVELS.map((level, index) => ({
            ...level,
            acquireBudgetSeconds: 20 - index * 4,
        }));
        const controller = new Staircase({ levels, startLevel: 4 });
        controller.next();
        // Level 5 allows 4 seconds. Six seconds would pass at level 4, which the
        // staircase reaches after the first miss, but this round is still being played
        // at level 5 and that is the budget that applies to all of it.
        expect(after(controller, [6, 6])).toBe(3);
    });

    it("leaves the level alone after a round in which nothing was hunted", () => {
        const controller = staircase(2);
        controller.next();
        expect(after(controller, [])).toBe(3);
    });
});

describe("the staircase at the ends of the table", () => {
    it("stays on the top level however well the player does", () => {
        const controller = staircase(5);
        controller.next();
        expect(after(controller, [HIT, HIT, HIT, HIT, HIT, HIT])).toBe(6);
        expect(after(controller, [HIT, HIT])).toBe(6);
    });

    it("stays on the bottom level however badly", () => {
        const controller = staircase(0);
        controller.next();
        expect(after(controller, [MISS, MISS, MISS], MISS)).toBe(1);
        expect(after(controller, [MISS])).toBe(1);
    });

    it("does not bank steps taken against the end: one failure at the top is one level down", () => {
        const controller = staircase(5);
        controller.next();
        expect(after(controller, [HIT, HIT, HIT, HIT, MISS])).toBe(5);
    });

    it("climbs off the bottom on the first two successes after a run of failures", () => {
        const controller = staircase(0);
        controller.next();
        expect(after(controller, [MISS, MISS, MISS, HIT, HIT])).toBe(2);
    });
});

describe("the change allowed between rounds", () => {
    it("is capped at two levels up, however many steps the round earned", () => {
        const controller = staircase(0);
        controller.next();
        // Eight successes are four steps.
        expect(after(controller, Array(8).fill(HIT))).toBe(3);
    });

    it("is capped at two levels down", () => {
        const controller = staircase(5);
        controller.next();
        expect(after(controller, Array(5).fill(MISS))).toBe(4);
    });

    it("lets the staircase carry on from the level actually played, not from where it was capped", () => {
        const controller = staircase(5);
        controller.next();
        // Five misses would be level 1. The cap holds the next round at level 4.
        expect(after(controller, Array(5).fill(MISS))).toBe(4);
        // Two good hunts at level 4 earn level 5. They must not be answered with
        // a further drop towards the level the capped staircase had fallen to.
        expect(after(controller, [HIT, HIT])).toBe(5);
    });

    it("moves freely within the cap", () => {
        const controller = staircase(2);
        controller.next();
        expect(after(controller, [HIT, HIT, HIT, HIT])).toBe(5);
        expect(after(controller, [MISS, MISS])).toBe(3);
    });

    it("honours a different cap", () => {
        const controller = staircase(0, { maxLevelChangePerRound: 1 });
        controller.next();
        expect(after(controller, Array(8).fill(HIT))).toBe(2);
    });

    it("rises and then falls over rounds of good play followed by bad", () => {
        const controller = staircase(2);
        const levels = [controller.next().level];
        for (let round = 0; round < 3; round++)
            levels.push(after(controller, [HIT, HIT], 3));
        for (let round = 0; round < 3; round++)
            levels.push(after(controller, [MISS, MISS], MISS));
        expect(levels).toEqual([3, 4, 5, 6, 4, 2, 1]);
    });
});

describe("with adaptation switched off", () => {
    it("plays every round at the start level, whatever happens", () => {
        const controller = staircase(2, { adaptive: false });
        expect(controller.next().level).toBe(3);
        expect(after(controller, Array(8).fill(HIT))).toBe(3);
        expect(after(controller, Array(8).fill(MISS), MISS)).toBe(3);
    });
});

describe("validateLevels", () => {
    const tooMany: DifficultyLevel = {
        hazardCount: maxVoicedHazards() + 1,
        collectRadius: 1,
        hazardRadius: 1,
        minSpawnDistance: 6,
        acquireBudgetSeconds: 10,
    };

    it("accepts the table the game ships with", () => {
        expect(() =>
            validateLevels(DIFFICULTY.LEVELS, DIFFICULTY.START_LEVEL)
        ).not.toThrow();
        expect(() => createDifficulty()).not.toThrow();
    });

    it("leaves one source for the beacon and one for the wall", () => {
        expect(maxVoicedHazards()).toBe(AUDIO.MAX_CONCURRENT_SOURCES - 2);
    });

    it("allows exactly as many hazards as can be voiced", () => {
        const atLimit = { ...tooMany, hazardCount: maxVoicedHazards() };
        expect(() => validateLevels([atLimit], 0)).not.toThrow();
    });

    it("throws on a level with one hazard too many, and says which", () => {
        expect(() => validateLevels([...LEVELS, tooMany], 0)).toThrow(
            /row 6 asks for 7 hazards/
        );
    });

    it("stops the game being created with such a table", () => {
        expect(() =>
            createDifficulty({ levels: [...LEVELS, tooMany], startLevel: 0 })
        ).toThrow(/hazards/);
    });

    it("throws on a hazard count that is not a whole, non-negative number", () => {
        expect(() =>
            validateLevels([{ ...tooMany, hazardCount: -1 }], 0)
        ).toThrow();
        expect(() =>
            validateLevels([{ ...tooMany, hazardCount: 1.5 }], 0)
        ).toThrow();
    });

    it("throws on an empty table, and on a start level that is not one of its rows", () => {
        expect(() => validateLevels([], 0)).toThrow(/empty/);
        expect(() => validateLevels(LEVELS, LEVELS.length)).toThrow(
            /START_LEVEL/
        );
        expect(() => validateLevels(LEVELS, -1)).toThrow(/START_LEVEL/);
        expect(() => validateLevels(LEVELS, 1.5)).toThrow(/START_LEVEL/);
    });
});

describe("the shipped difficulty table", () => {
    it("gets harder with every row", () => {
        const levels = DIFFICULTY.LEVELS;
        for (let i = 1; i < levels.length; i++) {
            const easier = levels[i - 1] as DifficultyLevel;
            const harder = levels[i] as DifficultyLevel;
            expect(harder.hazardCount).toBeGreaterThanOrEqual(easier.hazardCount);
            expect(harder.collectRadius).toBeLessThanOrEqual(easier.collectRadius);
            expect(harder.hazardRadius).toBeGreaterThanOrEqual(easier.hazardRadius);
            expect(harder.minSpawnDistance).toBeGreaterThanOrEqual(
                easier.minSpawnDistance
            );
            expect(harder.acquireBudgetSeconds).toBeLessThanOrEqual(
                easier.acquireBudgetSeconds
            );
        }
    });

    it("keeps the round length and the penalty the same at every level", () => {
        for (let i = 0; i < DIFFICULTY.LEVELS.length; i++) {
            expect(levelParameters(i).roundSeconds).toBe(GAME.ROUND_SECONDS);
            expect(levelParameters(i).hazardPenalty).toBe(GAME.HAZARD_PENALTY);
        }
    });

    it("can always be walked within budget from the minimum spawn distance", () => {
        // A sanity check on the table, not a guarantee: a level whose budget could not be
        // met even by walking dead straight at the nearest possible beacon could only fail.
        for (const level of DIFFICULTY.LEVELS) {
            const walk =
                (level.minSpawnDistance - level.collectRadius) /
                GAME.PLAYER_SPEED;
            expect(walk).toBeLessThan(level.acquireBudgetSeconds);
        }
    });
});

describe("practice parameters", () => {
    it("are off the staircase altogether", () => {
        const parameters = practiceParameters();
        expect(parameters.level).toBe(0);
        expect(parameters.acquireBudgetSeconds).toBe(Infinity);
    });
});

describe("levelParameters", () => {
    it("refuses an index that is not in the table", () => {
        expect(() => levelParameters(99)).toThrow(RangeError);
        expect(() => levelParameters(-1)).toThrow(RangeError);
    });
});
