import { describe, expect, it } from "vitest";
import { LOOP, TELEMETRY } from "../src/config";
import { defaultParameters } from "../src/game/difficulty";
import { TelemetryRecorder, type TelemetrySample } from "../src/telemetry";

/**
 * The recorder swallows `localStorage` failures, so it runs in plain Node: `endRound()`
 * fails to persist, says nothing, and still returns the record. Everything here goes
 * through its public methods only.
 */

const DT = LOOP.FIXED_DT;

function standing(distance: number, bearing: number): TelemetrySample {
    return {
        distanceToTarget: distance,
        bearingToTarget: bearing,
        isWalking: false,
    };
}

function walking(distance: number, bearing: number): TelemetrySample {
    return {
        distanceToTarget: distance,
        bearingToTarget: bearing,
        isWalking: true,
    };
}

function feed(recorder: TelemetryRecorder, samples: TelemetrySample[]): void {
    for (const sample of samples) recorder.sample(DT, sample);
}

/** Distances from `from` to `to` inclusive, both endpoints exact. */
function distances(from: number, to: number, steps = 40): number[] {
    const path: number[] = [];
    for (let i = 0; i < steps; i++)
        path.push(from + ((to - from) * i) / steps);
    path.push(to);
    return path;
}

function begin(): TelemetryRecorder {
    const recorder = new TelemetryRecorder();
    recorder.beginRound(defaultParameters(), "timed");
    return recorder;
}

describe("round records", () => {
    it("are stamped with the schema version and the mode they were played in", () => {
        const recorder = new TelemetryRecorder();

        recorder.beginRound(defaultParameters(), "practice");
        const practice = recorder.endRound(0);
        expect(practice.schemaVersion).toBe(TELEMETRY.SCHEMA_VERSION);
        expect(practice.mode).toBe("practice");

        recorder.beginRound(defaultParameters(), "timed");
        expect(recorder.endRound(0).mode).toBe("timed");
    });

    it("are kept apart from the rounds recorded before the fixes", () => {
        expect(TELEMETRY.SCHEMA_VERSION).toBe(2);
        expect(TELEMETRY.STORAGE_KEY).toBe("reluminate-echo.sessions.v2");
    });

    it("count a hunt still running at the end as abandoned, not acquired", () => {
        const recorder = begin();
        feed(recorder, [standing(8, 0), walking(7.95, 0)]);
        recorder.recordCollect();
        feed(recorder, [walking(9, 50)]);

        const record = recorder.endRound(1);
        expect(record.acquisitions).toHaveLength(1);
        expect(record.abandonedAcquisitions).toBe(1);
    });
});

describe("angular error at walk start", () => {
    it("is captured on the step the player starts walking", () => {
        const recorder = begin();
        feed(recorder, [
            standing(8, 40),
            standing(8, -4),
            walking(7.95, -4),
            walking(1, -2),
        ]);
        recorder.recordCollect();

        const record = recorder.endRound(1);
        expect(record.acquisitions[0]?.angularErrorAtWalkStart).toBe(4);
    });

    // Regression: the up arrow still held when Enter collects used to make the first step
    // of the next hunt look like a decision to walk, recording the bearing to a beacon
    // that had only just spawned somewhere random.
    it("does not treat a walk key held through a collection as an onset", () => {
        const recorder = begin();
        feed(recorder, [standing(8, -4), walking(7.95, -4), walking(1, -2)]);
        recorder.recordCollect();
        // Hunt two. The key never came up, and the new beacon is behind and to the right.
        feed(recorder, [walking(12, 137), walking(11.9, 137)]);
        recorder.recordCollect();

        const record = recorder.endRound(2);
        expect(record.acquisitions[0]?.angularErrorAtWalkStart).toBe(4);
        expect(record.acquisitions[1]?.angularErrorAtWalkStart).toBeNull();
    });

    it("stays null across three collections walked through without a release", () => {
        const recorder = begin();
        feed(recorder, [standing(8, 3), walking(7.95, 3)]);
        recorder.recordCollect();
        for (const spawnBearing of [137, -92, 61]) {
            feed(recorder, [walking(9, spawnBearing), walking(1, 0)]);
            recorder.recordCollect();
        }

        const record = recorder.endRound(4);
        expect(
            record.acquisitions.map((a) => a.angularErrorAtWalkStart)
        ).toEqual([3, null, null, null]);
    });

    it("captures a genuine onset after the held key is released", () => {
        const recorder = begin();
        feed(recorder, [standing(8, -4), walking(7.95, -4)]);
        recorder.recordCollect();
        // Still walking as the beacon respawns at 137 degrees; then the player stops,
        // turns until it is 6 degrees off, and sets off again.
        feed(recorder, [
            walking(12, 137),
            standing(12, 137),
            standing(12, 6),
            walking(11.95, 6),
        ]);
        recorder.recordCollect();

        const record = recorder.endRound(2);
        expect(record.acquisitions[1]?.angularErrorAtWalkStart).toBe(6);
    });

    // Same noise, different door: the key can already be down when the round begins,
    // before the player has heard anything to aim at.
    it("does not treat a walk key held into the round as an onset", () => {
        const recorder = begin();
        feed(recorder, [walking(9, 118), walking(8.95, 118)]);
        recorder.recordCollect();

        const record = recorder.endRound(1);
        expect(record.acquisitions[0]?.angularErrorAtWalkStart).toBeNull();
    });

    it("starts each round with no memory of the last one's walking", () => {
        const recorder = begin();
        feed(recorder, [standing(8, 2), walking(7.95, 2)]);
        recorder.endRound(0);

        recorder.beginRound(defaultParameters(), "timed");
        feed(recorder, [standing(8, 21), walking(7.95, 21)]);
        recorder.recordCollect();

        const record = recorder.endRound(1);
        expect(record.acquisitions[0]?.angularErrorAtWalkStart).toBe(21);
    });
});

describe("overshoot distance", () => {
    it("is zero for a straight walk that stops on the beacon", () => {
        const recorder = begin();
        feed(
            recorder,
            distances(10, 1).map((d) => walking(d, 0))
        );
        recorder.recordCollect();

        const record = recorder.endRound(1);
        expect(record.acquisitions[0]?.overshootDistance).toBe(0);
        expect(record.acquisitions[0]?.closestApproach).toBe(1);
    });

    it("measures how far past the beacon the player carried on", () => {
        const recorder = begin();
        feed(
            recorder,
            [
                ...distances(10, 1),
                ...distances(1, 3),
                ...distances(3, 1.2),
            ].map((d) => walking(d, 0))
        );
        recorder.recordCollect();

        const record = recorder.endRound(1);
        expect(record.acquisitions[0]?.overshootDistance).toBe(2);
    });

    // Regression: coming back closer than the earlier closest approach used to reset the
    // measurement, reporting zero for exactly the hunts that overshot the most.
    it("survives the player coming back closer than they were before", () => {
        const recorder = begin();
        feed(
            recorder,
            [
                ...distances(10, 1),
                ...distances(1, 5),
                ...distances(5, 0.8),
            ].map((d) => walking(d, 0))
        );
        recorder.recordCollect();

        const record = recorder.endRound(1);
        expect(record.acquisitions[0]?.overshootDistance).toBe(4);
        expect(record.acquisitions[0]?.closestApproach).toBe(0.8);
    });

    it("reports the largest of several overshoots", () => {
        const recorder = begin();
        feed(
            recorder,
            [
                ...distances(10, 1),
                ...distances(1, 5),
                ...distances(5, 0.8),
                ...distances(0.8, 2.8),
                ...distances(2.8, 0.5),
            ].map((d) => walking(d, 0))
        );
        recorder.recordCollect();

        const record = recorder.endRound(1);
        expect(record.acquisitions[0]?.overshootDistance).toBe(4);
    });

    it("ignores wandering that never came near the beacon", () => {
        const recorder = begin();
        feed(
            recorder,
            [...distances(20, 12), ...distances(12, 25)].map((d) =>
                walking(d, 90)
            )
        );
        recorder.recordCollect();

        const record = recorder.endRound(1);
        expect(record.acquisitions[0]?.overshootDistance).toBe(0);
    });

    it("does not carry an overshoot into the next hunt", () => {
        const recorder = begin();
        feed(
            recorder,
            [
                ...distances(10, 1),
                ...distances(1, 5),
                ...distances(5, 0.8),
            ].map((d) => walking(d, 0))
        );
        recorder.recordCollect();
        feed(
            recorder,
            distances(9, 1).map((d) => walking(d, 0))
        );
        recorder.recordCollect();

        const record = recorder.endRound(2);
        expect(record.acquisitions[1]?.overshootDistance).toBe(0);
    });
});
