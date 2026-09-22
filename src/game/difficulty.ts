import { AUDIO, DIFFICULTY, GAME } from "../config";

/**
 * Where a round's numbers come from. The rest of the game asks here rather than reading
 * `GAME` directly, so that the rules in effect are always one object, recorded whole in
 * telemetry.
 *
 * Timed rounds are adaptive: see `Staircase`, and DIFFICULTY in config.ts for the method
 * and the table it climbs. The practice round has parameters of its own.
 */
export interface DifficultyParameters {
    /**
     * The level as the player hears it: 1 is the easiest row of DIFFICULTY.LEVELS. 0 means
     * the round is not on the staircase at all, which is the practice round.
     */
    level: number;
    hazardCount: number;
    roundSeconds: number;
    hazardPenalty: number;
    collectRadius: number;
    hazardRadius: number;
    minSpawnDistance: number;
    /** A beacon collected within this many seconds is a success as far as the staircase is concerned. */
    acquireBudgetSeconds: number;
}

/** One row of DIFFICULTY.LEVELS: everything about a round that varies with difficulty. */
export interface DifficultyLevel {
    hazardCount: number;
    collectRadius: number;
    hazardRadius: number;
    minSpawnDistance: number;
    acquireBudgetSeconds: number;
}

/** What a timed round reports back once it ends. */
export interface RoundOutcome {
    score: number;
    hazardHits: number;
    durationSeconds: number;
    /** How long each collected beacon took, seconds, in the order they were collected. */
    acquisitionSeconds: readonly number[];
    /** How long each hunt still running when the clock ran out had been going, seconds. */
    abandonedHuntSeconds: readonly number[];
}

export interface DifficultyController {
    /** Parameters for the round about to start. */
    next(): DifficultyParameters;
    /** Called when a timed round ends. Practice rounds are never reported. */
    record(outcome: RoundOutcome): void;
}

/** Everything `Staircase` reads from config, overridable so that it can be tested against a small table. */
export interface StaircaseOptions {
    levels?: readonly DifficultyLevel[];
    /** Index into `levels`, counting from 0. */
    startLevel?: number;
    adaptive?: boolean;
    successesToStepUp?: number;
    maxLevelChangePerRound?: number;
    /** Most hazards any level may ask for. Defaults to what the source pool can voice. */
    maxHazards?: number;
}

/** The most hazards a round can voice: the pool, less the beacon's source and the wall's. */
export function maxVoicedHazards(): number {
    return AUDIO.MAX_CONCURRENT_SOURCES - DIFFICULTY.NON_HAZARD_SOURCES;
}

/**
 * Refuses a table the game could not play fairly.
 *
 * The rule that matters is the hazard count. Every hazard needs a pooled source to be
 * heard. One that is asked for beyond the pool's size would be silent and still cost the
 * player five seconds to walk into, which is the most unfair thing this game could do to
 * someone who cannot see it. So this throws, at startup, rather than letting a round begin.
 */
export function validateLevels(
    levels: readonly DifficultyLevel[],
    startLevel: number,
    maxHazards: number = maxVoicedHazards()
): void {
    if (levels.length === 0)
        throw new Error("DIFFICULTY.LEVELS is empty: there is no round to play.");
    if (
        !Number.isInteger(startLevel) ||
        startLevel < 0 ||
        startLevel >= levels.length
    )
        throw new Error(
            `DIFFICULTY.START_LEVEL is ${startLevel}, which is not a row of a ` +
                `${levels.length}-row LEVELS table (rows count from 0).`
        );

    levels.forEach((level, index) => {
        const count = level.hazardCount;
        if (!Number.isInteger(count) || count < 0 || count > maxHazards)
            throw new Error(
                `DIFFICULTY.LEVELS row ${index} asks for ${count} hazards. The most ` +
                    `that can be voiced is ${maxHazards}: the source pool, less one ` +
                    `for the beacon and one for the wall. A hazard with no source is ` +
                    `silent and still collides.`
            );
    });
}

/**
 * Round parameters for one row of the table. `index` counts from 0; the `level` in the
 * result counts from 1, because that is the number the player is told.
 */
export function levelParameters(
    index: number,
    levels: readonly DifficultyLevel[] = DIFFICULTY.LEVELS
): DifficultyParameters {
    const level = levels[index];
    if (!level)
        throw new RangeError(`No difficulty level at index ${index}.`);
    return {
        level: index + 1,
        hazardCount: level.hazardCount,
        // Fixed across levels so that a score means the same thing in every round.
        roundSeconds: GAME.ROUND_SECONDS,
        hazardPenalty: GAME.HAZARD_PENALTY,
        collectRadius: level.collectRadius,
        hazardRadius: level.hazardRadius,
        minSpawnDistance: level.minSpawnDistance,
        acquireBudgetSeconds: level.acquireBudgetSeconds,
    };
}

/**
 * The practice round: no hazards, no clock, nothing to lose. It comes from here so that
 * this file stays the single source of round parameters.
 *
 * "No timer" is a round of infinite length, which needs no special case anywhere: a
 * `Round` built from it never warns and never ends. There is no time budget either,
 * because practice is not on the staircase. JSON has no Infinity, so telemetry stores
 * both as null.
 */
export function practiceParameters(): DifficultyParameters {
    return {
        level: 0,
        hazardCount: 0,
        roundSeconds: Infinity,
        hazardPenalty: 0,
        collectRadius: GAME.COLLECT_RADIUS,
        hazardRadius: GAME.HAZARD_RADIUS,
        minSpawnDistance: GAME.MIN_SPAWN_DISTANCE,
        acquireBudgetSeconds: Infinity,
    };
}

/**
 * The 1-up / 2-down staircase.
 *
 * The unit is one beacon hunt. A beacon collected within the time budget of the level
 * being played is a success; a hunt that ran past that budget is a failure, whether the
 * beacon was collected late or never. SUCCESSES_TO_STEP_UP successes in a row move one
 * level up and any failure moves one level down, so the staircase can move several times
 * within a round. The round itself does not change under the player: the new level is
 * applied when the next round starts, and by at most MAX_LEVEL_CHANGE_PER_ROUND from the
 * last one.
 *
 * A hunt the clock cut short while it was still inside its budget counts as neither. A new
 * beacon appears the moment one is collected, so nearly every round ends with a hunt in
 * progress; scoring that as a failure regardless would end every round on a step down,
 * leave the top level unreachable, and settle the game somewhere easier than intended.
 */
export class Staircase implements DifficultyController {
    private readonly levels: readonly DifficultyLevel[];
    private readonly adaptive: boolean;
    private readonly successesToStepUp: number;
    private readonly maxLevelChangePerRound: number;

    /** Where the staircase stands, as an index into `levels`. Moves hunt by hunt. */
    private position: number;
    /** The row the latest round was started at. Null until the first round. */
    private applied: number | null = null;
    /** Successes in a row since the last step in either direction. */
    private streak = 0;

    constructor(options: StaircaseOptions = {}) {
        this.levels = options.levels ?? DIFFICULTY.LEVELS;
        const startLevel = options.startLevel ?? DIFFICULTY.START_LEVEL;
        validateLevels(this.levels, startLevel, options.maxHazards);

        this.adaptive = options.adaptive ?? DIFFICULTY.ADAPTIVE;
        this.successesToStepUp =
            options.successesToStepUp ?? DIFFICULTY.SUCCESSES_TO_STEP_UP;
        this.maxLevelChangePerRound =
            options.maxLevelChangePerRound ??
            DIFFICULTY.MAX_LEVEL_CHANGE_PER_ROUND;
        this.position = startLevel;
    }

    next(): DifficultyParameters {
        if (this.applied === null) {
            this.applied = this.position;
        } else {
            const cap = this.maxLevelChangePerRound;
            this.applied = Math.min(
                this.applied + cap,
                Math.max(this.applied - cap, this.position)
            );
        }
        // The staircase carries on from the level actually being played. Left where it
        // was after being capped, it would go on judging hunts at one level while
        // stepping from another, and two good hunts could be answered with an easier round.
        this.position = this.applied;
        return levelParameters(this.applied, this.levels);
    }

    record(outcome: RoundOutcome): void {
        if (!this.adaptive || this.applied === null) return;
        const budget = this.levels[this.applied]?.acquireBudgetSeconds;
        if (budget === undefined) return;

        for (const seconds of outcome.acquisitionSeconds)
            this.step(seconds <= budget);
        // Only a hunt that had already overrun is evidence; see the class comment.
        for (const seconds of outcome.abandonedHuntSeconds)
            if (seconds > budget) this.step(false);
    }

    private step(success: boolean): void {
        if (!success) {
            this.streak = 0;
            this.position = Math.max(0, this.position - 1);
            return;
        }
        this.streak += 1;
        if (this.streak < this.successesToStepUp) return;
        this.streak = 0;
        this.position = Math.min(this.levels.length - 1, this.position + 1);
    }
}

/**
 * The game's difficulty controller. Throws if DIFFICULTY.LEVELS is not playable, which
 * at the top of main.ts means the game does not start.
 */
export function createDifficulty(
    options: StaircaseOptions = {}
): DifficultyController {
    return new Staircase(options);
}
