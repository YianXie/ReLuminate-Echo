/**
 * Per-round telemetry, written to `localStorage` and exportable as JSON.
 *
 * (spec) Nothing leaves the browser. There is no analytics service and no network call
 * anywhere in this file; the export is a Blob the player downloads themselves.
 *
 * The recorder is fed plain numbers rather than the `World` object so that what is being
 * measured stays obvious at the call site, and so that adding a measurement never means
 * reaching further into the game's internals.
 */

import { TELEMETRY } from "./config";
import type { DifficultyParameters } from "./game/difficulty";

/** One hunt: from a beacon appearing to the player collecting it. */
export interface AcquisitionRecord {
    /** 1 for the first beacon of the round. */
    index: number;
    /** (spec) Time to acquire this target, seconds. */
    secondsToAcquire: number;
    /**
     * (spec) Angular error at the moment the player started walking, degrees, absolute.
     * This is the headline perception number: it says how well the binaural cues alone
     * let someone point at a sound before they had any distance feedback to correct with.
     * Null if the player collected the beacon without ever walking.
     */
    angularErrorAtWalkStart: number | null;
    /** Closest the player got to the beacon during the hunt, units. */
    closestApproach: number;
    /**
     * (spec) How far past the beacon the player carried on before coming back, units.
     * Measured as the furthest they got after their closest approach. Zero when they
     * walked straight to it and stopped.
     */
    overshootDistance: number;
}

export interface RoundRecord {
    /** ISO timestamp of when the round started. */
    startedAt: string;
    score: number;
    /** (spec) Hazard collisions. */
    hazardHits: number;
    /** (spec) Ping usage count. */
    pings: number;
    /** (spec) Round duration, seconds of play. */
    durationSeconds: number;
    /** (spec) The difficulty parameters in effect. Fixed in v0.1; recorded anyway. */
    difficulty: DifficultyParameters;
    acquisitions: AcquisitionRecord[];
    /** Beacons that were still being hunted when the clock ran out. Not counted above. */
    abandonedAcquisitions: number;
}

/** A frame's worth of the player's relationship to the current beacon. */
export interface TelemetrySample {
    distanceToTarget: number;
    /** Degrees, signed, 0 = dead ahead. */
    bearingToTarget: number;
    isWalking: boolean;
}

interface Hunt {
    elapsed: number;
    angularErrorAtWalkStart: number | null;
    closestApproach: number;
    /** Furthest from the beacon since the closest approach. */
    furthestSinceClosest: number;
    /** Overshoot is only measured once the player has actually been near the beacon. */
    armed: boolean;
}

export class TelemetryRecorder {
    private difficulty: DifficultyParameters | null = null;
    private startedAt = "";
    private elapsed = 0;
    private pings = 0;
    private hazardHits = 0;
    private acquisitions: AcquisitionRecord[] = [];
    private hunt: Hunt | null = null;

    beginRound(difficulty: DifficultyParameters): void {
        this.difficulty = difficulty;
        this.startedAt = new Date().toISOString();
        this.elapsed = 0;
        this.pings = 0;
        this.hazardHits = 0;
        this.acquisitions = [];
        this.hunt = newHunt();
    }

    /** Called once per simulation step, after the world has moved. */
    sample(dt: number, sample: TelemetrySample): void {
        const hunt = this.hunt;
        if (!hunt) return;

        this.elapsed += dt;
        hunt.elapsed += dt;

        // (spec) The angle the player was off by when they committed to a direction. Captured
        // on the first step they walk, because after that the distance cues start correcting
        // them and the number stops being about localisation.
        if (hunt.angularErrorAtWalkStart === null && sample.isWalking) {
            hunt.angularErrorAtWalkStart = Math.abs(sample.bearingToTarget);
        }

        const distance = sample.distanceToTarget;
        if (distance < hunt.closestApproach) {
            hunt.closestApproach = distance;
            hunt.furthestSinceClosest = distance;
            if (!this.difficulty) return;
            if (
                distance <=
                this.difficulty.collectRadius *
                    TELEMETRY.OVERSHOOT_ARMING_RADIUS
            ) {
                hunt.armed = true;
            }
        } else if (hunt.armed && distance > hunt.furthestSinceClosest) {
            hunt.furthestSinceClosest = distance;
        }
    }

    recordPing(): void {
        this.pings += 1;
    }

    recordHazardHit(): void {
        this.hazardHits += 1;
    }

    /** Closes the current hunt and opens the next one. */
    recordCollect(): void {
        const hunt = this.hunt;
        if (!hunt) return;
        this.acquisitions.push({
            index: this.acquisitions.length + 1,
            secondsToAcquire: round3(hunt.elapsed),
            angularErrorAtWalkStart:
                hunt.angularErrorAtWalkStart === null
                    ? null
                    : round3(hunt.angularErrorAtWalkStart),
            closestApproach: round3(
                hunt.closestApproach === Infinity ? 0 : hunt.closestApproach
            ),
            overshootDistance: round3(
                Math.max(0, hunt.furthestSinceClosest - hunt.closestApproach)
            ),
        });
        this.hunt = newHunt();
    }

    /** Finalises the round, appends it to storage and returns it. */
    endRound(score: number): RoundRecord {
        const record: RoundRecord = {
            startedAt: this.startedAt,
            score,
            hazardHits: this.hazardHits,
            pings: this.pings,
            durationSeconds: round3(this.elapsed),
            difficulty: this.difficulty ?? ({} as DifficultyParameters),
            acquisitions: this.acquisitions,
            abandonedAcquisitions: this.hunt && this.hunt.elapsed > 0 ? 1 : 0,
        };
        this.hunt = null;
        append(record);
        return record;
    }
}

/** Every round recorded in this browser, oldest first. */
export function loadSessions(): RoundRecord[] {
    try {
        const raw = window.localStorage.getItem(TELEMETRY.STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as RoundRecord[]) : [];
    } catch {
        // Private browsing, a full quota or hand-edited JSON. Telemetry is a nice-to-have;
        // it must never be the reason the game will not start.
        return [];
    }
}

export function clearSessions(): void {
    try {
        window.localStorage.removeItem(TELEMETRY.STORAGE_KEY);
    } catch {
        // See loadSessions.
    }
}

/**
 * (spec) The D key. Hands the player a JSON file of everything recorded so far.
 *
 * The synthetic click is the standard download idiom, not a mouse interaction: there is
 * no pointer event listener anywhere in this project, and this path is reached only from
 * a keypress.
 */
export function downloadSessions(): number {
    const sessions = loadSessions();
    const blob = new Blob([JSON.stringify({ sessions }, null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `reluminate-echo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking immediately can race the download in some browsers; a tick is enough.
    const REVOKE_DELAY_MS = 1000;
    window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    return sessions.length;
}

function append(record: RoundRecord): void {
    try {
        const sessions = loadSessions();
        sessions.push(record);
        const trimmed = sessions.slice(-TELEMETRY.MAX_ROUNDS_STORED);
        window.localStorage.setItem(
            TELEMETRY.STORAGE_KEY,
            JSON.stringify(trimmed)
        );
    } catch {
        // See loadSessions.
    }
}

function newHunt(): Hunt {
    return {
        elapsed: 0,
        angularErrorAtWalkStart: null,
        closestApproach: Infinity,
        furthestSinceClosest: 0,
        armed: false,
    };
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
