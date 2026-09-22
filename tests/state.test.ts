import { describe, expect, it } from "vitest";
import { GAME } from "../src/config";
import { levelParameters, practiceParameters } from "../src/game/difficulty";
import { Round, StateMachine, type Phase } from "../src/game/state";

const PHASES: readonly Phase[] = [
    "idle",
    "onboarding",
    "practice",
    "playing",
    "paused",
    "roundOver",
];

/**
 * The transitions the game is meant to allow, written out here by hand rather than read
 * from state.ts: a test that iterated the machine's own table could never disagree with it.
 */
const LEGAL: Record<Phase, readonly Phase[]> = {
    idle: ["onboarding", "playing"],
    onboarding: ["playing", "practice", "idle"],
    practice: ["roundOver"],
    playing: ["paused", "roundOver"],
    paused: ["playing", "roundOver"],
    roundOver: ["playing", "practice", "idle"],
};

/** A legal route from idle to each phase, so the machine can be put anywhere. */
const ROUTE: Record<Phase, readonly Phase[]> = {
    idle: [],
    onboarding: ["onboarding"],
    practice: ["onboarding", "practice"],
    playing: ["playing"],
    paused: ["playing", "paused"],
    roundOver: ["playing", "roundOver"],
};

function machineAt(phase: Phase): StateMachine {
    const machine = new StateMachine();
    for (const step of ROUTE[phase]) expect(machine.enter(step)).toBe(true);
    expect(machine.current).toBe(phase);
    return machine;
}

describe("StateMachine", () => {
    it("starts idle", () => {
        expect(new StateMachine().current).toBe("idle");
    });

    for (const from of PHASES) {
        for (const to of PHASES) {
            const legal = LEGAL[from].includes(to);
            it(`${legal ? "allows" : "rejects"} ${from} -> ${to}`, () => {
                const machine = machineAt(from);
                expect(machine.canEnter(to)).toBe(legal);
                expect(machine.enter(to)).toBe(legal);
                expect(machine.current).toBe(legal ? to : from);
            });
        }
    }

    it("can reach practice from onboarding and from the ready state, and only leaves it for the ready state", () => {
        expect(machineAt("onboarding").enter("practice")).toBe(true);
        expect(machineAt("roundOver").enter("practice")).toBe(true);

        const practice = machineAt("practice");
        expect(practice.enter("paused")).toBe(false);
        expect(practice.enter("playing")).toBe(false);
        expect(practice.enter("roundOver")).toBe(true);
    });

    it("tells listeners about a transition, and not about a refused one", () => {
        const machine = new StateMachine();
        const seen: string[] = [];
        machine.onChange((next, previous) => seen.push(`${previous}>${next}`));

        machine.enter("paused");
        machine.enter("onboarding");
        machine.enter("practice");
        expect(seen).toEqual(["idle>onboarding", "onboarding>practice"]);
    });
});

describe("Round", () => {
    it("counts down from the round length and ends at zero", () => {
        const round = new Round(levelParameters(0));
        expect(round.timeRemaining).toBe(GAME.ROUND_SECONDS);
        expect(round.isOver).toBe(false);

        round.tick(GAME.ROUND_SECONDS - 1);
        expect(round.isOver).toBe(false);
        round.tick(5);
        expect(round.timeRemaining).toBe(0);
        expect(round.isOver).toBe(true);
    });

    it("takes the penalty off the clock, never below zero, and leaves the score alone", () => {
        const round = new Round(levelParameters(0));
        round.collect();
        round.tick(GAME.ROUND_SECONDS - 2);
        round.penalise();

        expect(round.timeRemaining).toBe(0);
        expect(round.isOver).toBe(true);
        expect(round.hazardHits).toBe(1);
        expect(round.score).toBe(1);
    });

    it("starts with the ping ready, then makes the player wait out the cooldown", () => {
        const round = new Round(levelParameters(0));
        expect(round.usePing()).toBe(true);
        expect(round.usePing()).toBe(false);

        round.tick(GAME.PING_COOLDOWN / 2);
        expect(round.usePing()).toBe(false);
        round.tick(GAME.PING_COOLDOWN / 2);
        expect(round.usePing()).toBe(true);
        expect(round.pings).toBe(2);
    });

    it("gives the ten-second warning once, the first time it is asked after the threshold", () => {
        const round = new Round(levelParameters(0));
        round.tick(GAME.ROUND_SECONDS - GAME.WARNING_SECONDS - 1);
        expect(round.takeWarning()).toBe(false);

        round.tick(1);
        expect(round.takeWarning()).toBe(true);
        expect(round.takeWarning()).toBe(false);
        round.tick(5);
        expect(round.takeWarning()).toBe(false);
    });

    it("warns once even when a penalty jumps straight past the threshold", () => {
        const round = new Round(levelParameters(0));
        round.tick(GAME.ROUND_SECONDS - GAME.WARNING_SECONDS - 1);
        round.penalise();
        expect(round.takeWarning()).toBe(true);
        expect(round.takeWarning()).toBe(false);
    });
});

describe("a practice round", () => {
    it("has no hazards and nothing to lose", () => {
        const parameters = practiceParameters();
        expect(parameters.hazardCount).toBe(0);
        expect(parameters.hazardPenalty).toBe(0);
    });

    it("never warns and never ends, however long it runs", () => {
        const round = new Round(practiceParameters());
        for (let minute = 0; minute < 120; minute++) {
            round.tick(60);
            expect(round.takeWarning()).toBe(false);
            expect(round.isOver).toBe(false);
        }
        round.penalise();
        expect(round.isOver).toBe(false);
    });

    it("still scores, and still limits the ping", () => {
        const round = new Round(practiceParameters());
        round.collect();
        expect(round.score).toBe(1);
        expect(round.usePing()).toBe(true);
        expect(round.usePing()).toBe(false);
    });
});
