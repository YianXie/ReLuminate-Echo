import { CUES, GAME } from "../config";
import { setListenerPose } from "../audio/context";
import type { BinauralSource, SourcePool, SourceVoice } from "../audio/source";
import {
    playCentreTick,
    playCentreTickNow,
    playCollect,
    playCollision,
    playInRange,
    playPing,
} from "../audio/cues";
import { CentreLock, centreTolerance } from "./aim";
import type { DifficultyParameters } from "./difficulty";
import { Player, bearing, wrapAngle, type InputState } from "./player";

/** Anything that occupies a point in the arena and may be voiced by a pooled source. */
export interface Entity {
    x: number;
    y: number;
    source: BinauralSource | null;
}

/** A hazard, plus the hysteresis flag that stops one collision registering repeatedly. */
interface Hazard extends Entity {
    armed: boolean;
}

/** Things main.ts needs to react to. The world plays the sounds; the caller keeps score. */
export interface WorldEvents {
    onTargetCollected?: () => void;
    onHazardHit?: () => void;
}

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/**
 * The arena, the things in it, and the mapping from arena coordinates to audio-world
 * coordinates.
 *
 * Arena space is 2D top-down (+x east, +y north). Audio space is 3D with +y up, so
 * north maps to -z and everything sits on the y = 0 plane. That single conversion lives
 * here; `src/audio/` never sees an arena coordinate and `src/game/` never sees a z.
 */
export class World {
    readonly player = new Player();
    readonly target: Entity = { x: 0, y: 0, source: null };
    readonly hazards: Hazard[] = [];

    /** The nearest wall, voiced as a point source only while the player is close to it. */
    private readonly wall: Entity = { x: 0, y: 0, source: null };

    private parameters: DifficultyParameters | null = null;
    private targetInRange = false;
    private silenced = false;
    private readonly centreLock = new CentreLock();

    constructor(
        private readonly pool: SourcePool,
        private readonly events: WorldEvents = {}
    ) {}

    /** Places the player at the centre facing north, then lays out a fresh round. */
    start(parameters: DifficultyParameters): void {
        this.parameters = parameters;
        this.player.reset();
        this.targetInRange = false;
        this.silenced = false;

        this.pool.releaseAll();
        this.hazards.length = 0;
        this.target.source = null;
        this.wall.source = null;

        this.spawnTarget();
        for (let i = 0; i < parameters.hazardCount; i++) {
            const spot = this.randomSpawnPoint();
            const hazard: Hazard = {
                x: spot.x,
                y: spot.y,
                source: null,
                armed: true,
            };
            hazard.source = this.pool.acquire(hazardVoice());
            this.hazards.push(hazard);
        }
    }

    /** Silences the world without forgetting where anything is. Used while paused. */
    silence(): void {
        if (this.silenced) return;
        this.silenced = true;
        this.pool.releaseAll();
        this.target.source = null;
        this.wall.source = null;
        for (const hazard of this.hazards) hazard.source = null;
    }

    /** Re-voices everything after a pause. */
    resume(): void {
        if (!this.silenced) return;
        this.silenced = false;
        // Coming back from a pause, the player wants to know at once whether they are
        // still on line, not up to a second later.
        this.centreLock.reset();
        this.target.source = this.pool.acquire(targetVoice());
        for (const hazard of this.hazards)
            hazard.source = this.pool.acquire(hazardVoice());
    }

    stop(): void {
        this.silence();
    }

    /** Distance from the player to the beacon, arena units. */
    get distanceToTarget(): number {
        return Math.hypot(
            this.target.x - this.player.x,
            this.target.y - this.player.y
        );
    }

    /**
     * Where the beacon is relative to where the player is looking, degrees.
     * 0 is dead ahead, positive is to the right, +/-180 is directly behind.
     */
    get bearingToTarget(): number {
        const absolute = bearing(
            this.player.x,
            this.player.y,
            this.target.x,
            this.target.y
        );
        return wrapAngle(absolute - this.player.heading) * RAD_TO_DEG;
    }

    get isTargetInRange(): boolean {
        return this.targetInRange;
    }

    /** One fixed simulation step. */
    update(dt: number, input: InputState): void {
        this.player.update(dt, input);

        // Listener first: every source computes its rear shadowing from the pose set here,
        // so updating them in the other order would voice the world one frame stale.
        this.syncListener();
        if (this.silenced) return;

        this.updateTarget(dt);
        this.updateHazards();
        this.updateWall();
        this.pool.update();
    }

    /** (spec) Enter collects the target when in range. Returns false if it was out of range. */
    collect(): boolean {
        if (!this.targetInRange) return false;
        playCollect();
        this.spawnTarget();
        this.events.onTargetCollected?.();
        return true;
    }

    /** (spec) Sonar ping: everything within range answers once. */
    ping(): void {
        playPing();
        for (const entity of this.voicedEntities()) {
            if (!entity.source) continue;
            const distance = Math.hypot(
                entity.x - this.player.x,
                entity.y - this.player.y
            );
            if (distance <= GAME.PING_RADIUS) entity.source.pulseOnce();
        }
    }

    /** Moves the beacon somewhere new and re-points its source at it. */
    spawnTarget(): void {
        this.placeTarget(this.randomSpawnPoint());
    }

    /**
     * Moves the beacon to a scripted spot instead: `bearingDeg` from the way the player is
     * facing right now, positive to the right, and `distance` units away. A spot outside
     * the walls is pulled back inside them, exactly as a random one would be.
     */
    spawnTargetAt(bearingDeg: number, distance: number): void {
        const angle = this.player.heading + bearingDeg * DEG_TO_RAD;
        this.placeTarget(this.pointFromPlayer(angle, distance));
    }

    private placeTarget(spot: { x: number; y: number }): void {
        this.target.x = spot.x;
        this.target.y = spot.y;
        this.targetInRange = false;
        // A different beacon: being aimed at it, even by luck, is news.
        this.centreLock.reset();
        if (!this.target.source)
            this.target.source = this.pool.acquire(targetVoice());
    }

    private updateTarget(dt: number): void {
        const source = this.target.source;
        if (source) source.setPosition(this.target.x, 0, -this.target.y);

        const radius = this.parameters?.collectRadius ?? GAME.COLLECT_RADIUS;
        const distance = this.distanceToTarget;

        // (spec) Centre-lock tick. Whether the player is aimed, and whether they have just
        // become so, is game state and stays here; the cue module only makes the sound.
        const aimed =
            Math.abs(this.bearingToTarget) <=
            centreTolerance(radius, distance);
        const tick = this.centreLock.step(dt, aimed);
        if (tick === "entry") playCentreTickNow();
        else if (tick === "held") playCentreTick();

        const inRange = distance <= radius;
        if (inRange && !this.targetInRange) playInRange();
        this.targetInRange = inRange;
    }

    private updateHazards(): void {
        const radius = this.parameters?.hazardRadius ?? GAME.HAZARD_RADIUS;
        for (const hazard of this.hazards) {
            hazard.source?.setPosition(hazard.x, 0, -hazard.y);

            const distance = Math.hypot(
                hazard.x - this.player.x,
                hazard.y - this.player.y
            );
            if (hazard.armed && distance <= radius) {
                hazard.armed = false;
                playCollision();
                this.events.onHazardHit?.();
            } else if (
                !hazard.armed &&
                distance > radius + GAME.HAZARD_REARM_MARGIN
            ) {
                // Hysteresis: standing inside a hazard must not cost five seconds per frame.
                hazard.armed = true;
            }
        }
    }

    /**
     * Voices the nearest wall as a point source on that wall, level with the player.
     *
     * Only the nearest one is voiced: four permanent wall sources would eat half the HRTF
     * budget to tell the player something they only need when they are about to bump into
     * something. In a corner this means the second wall is silent, which is a deliberate
     * trade rather than an oversight.
     */
    private updateWall(): void {
        const half = GAME.ARENA_SIZE / 2;
        const { x, y } = this.player;
        const options: Array<[number, number, number]> = [
            [half - x, half, y], // east
            [half + x, -half, y], // west
            [half - y, x, half], // north
            [half + y, x, -half], // south
        ];
        let nearest = options[0] as [number, number, number];
        for (const option of options)
            if (option[0] < nearest[0]) nearest = option;

        const [distance, wx, wy] = nearest;
        this.wall.x = wx;
        this.wall.y = wy;

        if (distance <= CUES.WALL.AUDIBLE_DISTANCE) {
            if (!this.wall.source)
                this.wall.source = this.pool.acquire(wallVoice());
            this.wall.source?.setPosition(wx, 0, -wy);
        } else if (this.wall.source) {
            this.pool.release(this.wall.source);
            this.wall.source = null;
        }
    }

    private syncListener(): void {
        const { x, y, heading } = this.player;
        // (spec) forwardX = sin(heading), forwardZ = -cos(heading), upY = 1, everything at y = 0.
        setListenerPose(
            { x, y: 0, z: -y },
            { x: Math.sin(heading), y: 0, z: -Math.cos(heading) }
        );
    }

    private voicedEntities(): Entity[] {
        return [this.target, ...this.hazards, this.wall];
    }

    /**
     * A point inside the arena, far enough from the player to be a real hunt and far
     * enough from everything else that two objects are never voiced from one direction.
     */
    private randomSpawnPoint(): { x: number; y: number } {
        const limit = spawnLimit();
        const minFromPlayer =
            this.parameters?.minSpawnDistance ?? GAME.MIN_SPAWN_DISTANCE;
        // The wall is excluded because it moves with the player; the target is included
        // even when it is the thing being respawned, which keeps a fresh beacon away from
        // the spot the player has just walked to.
        const placed = this.voicedEntities().filter((e) => e !== this.wall);

        for (let attempt = 0; attempt < GAME.SPAWN_ATTEMPTS; attempt++) {
            const x = (Math.random() * 2 - 1) * limit;
            const y = (Math.random() * 2 - 1) * limit;
            if (
                Math.hypot(x - this.player.x, y - this.player.y) < minFromPlayer
            )
                continue;
            if (
                placed.some(
                    (e) =>
                        Math.hypot(x - e.x, y - e.y) <
                        GAME.MIN_ENTITY_SEPARATION
                )
            )
                continue;
            return { x, y };
        }

        // Rejection sampling can in principle fail; fall back to a point on the minimum-distance
        // circle, nudged inside the walls. Never leaves the player without a beacon to find.
        return this.pointFromPlayer(Math.random() * Math.PI * 2, minFromPlayer);
    }

    /** The point `distance` units from the player along a compass angle, kept inside the walls. */
    private pointFromPlayer(
        angle: number,
        distance: number
    ): { x: number; y: number } {
        const limit = spawnLimit();
        return {
            x: clampTo(this.player.x + Math.sin(angle) * distance, limit),
            y: clampTo(this.player.y + Math.cos(angle) * distance, limit),
        };
    }
}

/** Nothing is placed closer to a wall than this, measured from the centre, units. */
function spawnLimit(): number {
    return GAME.ARENA_SIZE / 2 - GAME.WALL_MARGIN * 2;
}

/** (spec) Target: pulsed sine, rate rising with proximity. */
function targetVoice(): SourceVoice {
    return {
        timbre: CUES.TARGET.timbre,
        frequency: CUES.TARGET.frequency,
        gain: CUES.TARGET.gain,
        rolloffFactor: CUES.TARGET.rolloffFactor,
        pulsed: true,
        pulse: {
            rateFar: CUES.TARGET.PULSE_RATE_FAR,
            rateNear: CUES.TARGET.PULSE_RATE_NEAR,
            distanceFar: CUES.TARGET.PULSE_FAR_DISTANCE,
            distanceNear: CUES.TARGET.PULSE_NEAR_DISTANCE,
            length: CUES.TARGET.PULSE_LENGTH,
        },
    };
}

/** (spec) Hazard: continuous low sawtooth hum. */
function hazardVoice(): SourceVoice {
    return {
        timbre: CUES.HAZARD.timbre,
        frequency: CUES.HAZARD.frequency,
        gain: CUES.HAZARD.gain,
        pulsed: false,
    };
}

/** (spec) Wall: filtered noise, capped well below the other voices so it stays background. */
function wallVoice(): SourceVoice {
    return {
        timbre: CUES.WALL.timbre,
        frequency: 0,
        gain: CUES.WALL.gain,
        pulsed: false,
        maxCutoffHz: CUES.WALL.maxCutoffHz,
    };
}

function clampTo(value: number, limit: number): number {
    return value < -limit ? -limit : value > limit ? limit : value;
}
