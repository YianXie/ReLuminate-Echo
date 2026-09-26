import { describe, expect, it } from "vitest";
import { SPEECH } from "../src/config";
import { PROMPTS, type Prompts } from "../src/prompts";

/** Every spoken line in a set, with the longest score and seconds the game fills in. */
function lines(prompts: Prompts): string[] {
    return [
        prompts.welcome,
        ...prompts.movement,
        ...prompts.controls,
        ...prompts.settings,
        prompts.onboardingEnd,
        prompts.practiceFirst,
        prompts.practiceDone,
        `Round over. You found 100 beacons. ${prompts.playAgain}`,
        `Paused. Score 100. 60 seconds left. ${prompts.resume}`,
    ];
}

describe("spoken prompts", () => {
    for (const [mode, prompts] of Object.entries(PROMPTS)) {
        it(`keeps every ${mode} line short enough to be said in one go`, () => {
            for (const line of lines(prompts))
                expect(line.length, line).toBeLessThanOrEqual(
                    SPEECH.MAX_UTTERANCE_CHARS
                );
        });
    }

    it("never tells a touch player to press a key", () => {
        for (const line of lines(PROMPTS.touch))
            expect(line, line).not.toMatch(
                /\b(press|key|arrow|space|enter|escape)\b/i
            );
    });
});
