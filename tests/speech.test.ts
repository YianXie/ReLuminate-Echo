import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPEECH } from "../src/config";
import { Announcer } from "../src/audio/speech";

/**
 * The announcer only needs `window.speechSynthesis`, an utterance constructor and timers,
 * so it runs in plain Node against a fake synthesiser. The fake never finishes a line by
 * itself: each test ends utterances by hand, which is what makes the ordering visible.
 */

interface FakeUtterance {
    text: string;
    onend: (() => void) | null;
    onerror: (() => void) | null;
}

let utterances: FakeUtterance[] = [];
let cancels = 0;

/** Ends the utterance the fake synthesiser was most recently handed. */
function endCurrent(): void {
    utterances[utterances.length - 1]?.onend?.();
}

function spokenTexts(): string[] {
    return utterances.map((utterance) => utterance.text);
}

/** Long enough for the gap between lines to pass, short enough that no watchdog fires. */
const GAP_MS = SPEECH.GAP * 1000 + 1;

function readingTimeMs(text: string): number {
    return (
        (text.length / SPEECH.ESTIMATED_CHARS_PER_SECOND / SPEECH.RATE) * 1000
    );
}

beforeEach(() => {
    utterances = [];
    cancels = 0;
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("speechSynthesis", {
        speak: (utterance: FakeUtterance) => utterances.push(utterance),
        cancel: () => {
            cancels += 1;
        },
    });
    vi.stubGlobal(
        "SpeechSynthesisUtterance",
        class {
            onend: (() => void) | null = null;
            onerror: (() => void) | null = null;
            constructor(readonly text: string) {}
        }
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

/** Queues a line and records when it starts and how it resolves. */
function track(
    announcer: Announcer,
    text: string,
    log: string[],
    priority = false
): void {
    void announcer
        .speak(text, { priority, onStart: () => log.push(`start ${text}`) })
        .then((started) => log.push(`${started ? "done" : "dropped"} ${text}`));
}

describe("Announcer queue", () => {
    it("speaks one line at a time and starts each only when its turn comes", async () => {
        const announcer = new Announcer();
        const log: string[] = [];
        track(announcer, "one", log);
        track(announcer, "two", log);

        expect(spokenTexts()).toEqual(["one"]);
        expect(log).toEqual(["start one"]);

        endCurrent();
        await vi.advanceTimersByTimeAsync(GAP_MS);
        expect(spokenTexts()).toEqual(["one", "two"]);
        expect(log).toEqual(["start one", "done one", "start two"]);
    });

    it("never cuts off the line in flight for a priority line", async () => {
        const announcer = new Announcer();
        const log: string[] = [];
        track(announcer, "one", log);
        track(announcer, "urgent", log, true);

        expect(cancels).toBe(0);
        expect(spokenTexts()).toEqual(["one"]);

        endCurrent();
        await vi.advanceTimersByTimeAsync(GAP_MS);
        expect(spokenTexts()).toEqual(["one", "urgent"]);
    });

    it("drops waiting lines for a priority line, and tells their awaiters so", async () => {
        const announcer = new Announcer();
        const log: string[] = [];
        track(announcer, "one", log);
        track(announcer, "two", log);
        track(announcer, "three", log);
        track(announcer, "urgent", log, true);
        await vi.advanceTimersByTimeAsync(0);

        expect(log).toEqual(["start one", "dropped two", "dropped three"]);

        endCurrent();
        await vi.advanceTimersByTimeAsync(GAP_MS);
        expect(log).toEqual([
            "start one",
            "dropped two",
            "dropped three",
            "done one",
            "start urgent",
        ]);
    });

    it("keeps a list queued in one go together, behind the priority line that opens it", async () => {
        const announcer = new Announcer();
        const log: string[] = [];
        track(announcer, "talking", log);
        track(announcer, "stale", log);
        // What H does: first sentence with priority, the rest queued normally.
        track(announcer, "controls one", log, true);
        track(announcer, "controls two", log);
        track(announcer, "controls three", log);

        for (let i = 0; i < 4; i++) {
            endCurrent();
            await vi.advanceTimersByTimeAsync(GAP_MS);
        }
        expect(spokenTexts()).toEqual([
            "talking",
            "controls one",
            "controls two",
            "controls three",
        ]);
        expect(log).toContain("dropped stale");
    });

    it("moves on by itself when the browser never reports the end of a line", async () => {
        const announcer = new Announcer();
        const log: string[] = [];
        track(announcer, "stuck", log);
        track(announcer, "next", log);

        await vi.advanceTimersByTimeAsync(
            readingTimeMs("stuck") +
                SPEECH.WATCHDOG_PADDING_SECONDS * 1000 +
                GAP_MS
        );
        expect(log).toEqual(["start stuck", "done stuck", "start next"]);
    });
});

describe("Announcer mute", () => {
    // Regression: muting used to discard the backlog. Once the live region was written
    // from onStart, a line waiting behind "Speech off." reached neither channel.
    it("silences the voice but keeps the backlog flowing to onStart", async () => {
        const announcer = new Announcer();
        const log: string[] = [];
        track(announcer, "in flight", log);
        track(announcer, "waiting", log);

        announcer.setEnabled(false);
        await vi.advanceTimersByTimeAsync(0);

        expect(cancels).toBe(1);
        // The waiting line starts inside setEnabled() itself; the interrupted line's
        // awaiter hears about it a microtask later. Only the membership matters here.
        expect([...log].sort()).toEqual(
            ["done in flight", "start in flight", "start waiting"].sort()
        );
        // Muted lines are not handed to the synthesiser at all.
        expect(spokenTexts()).toEqual(["in flight"]);

        await vi.advanceTimersByTimeAsync(readingTimeMs("waiting") + 1);
        expect(log).toContain("done waiting");
    });

    it("paces muted lines at reading speed so the live region is not overwritten", async () => {
        const announcer = new Announcer();
        announcer.setEnabled(false);
        const log: string[] = [];
        const first = "a sentence of some length";
        track(announcer, first, log);
        track(announcer, "second", log);

        await vi.advanceTimersByTimeAsync(readingTimeMs(first) - 5);
        expect(log).toEqual([`start ${first}`]);

        await vi.advanceTimersByTimeAsync(5 + GAP_MS);
        expect(log).toEqual([`start ${first}`, `done ${first}`, "start second"]);
        expect(spokenTexts()).toEqual([]);
    });

    it("ignores a late end event from the utterance that muting cut off", async () => {
        const announcer = new Announcer();
        const log: string[] = [];
        track(announcer, "in flight", log);
        track(announcer, "waiting", log);

        announcer.setEnabled(false);
        endCurrent();
        await vi.advanceTimersByTimeAsync(GAP_MS);

        expect(log.filter((entry) => entry === "start waiting")).toHaveLength(1);
        expect(log).not.toContain("done waiting");
    });
});

describe("Announcer cancel", () => {
    it("drops everything: waiting lines never start, and are reported as dropped", async () => {
        const announcer = new Announcer();
        const log: string[] = [];
        track(announcer, "in flight", log);
        track(announcer, "waiting", log);

        announcer.cancel();
        await vi.advanceTimersByTimeAsync(GAP_MS);

        expect(cancels).toBe(1);
        expect(log).toEqual([
            "start in flight",
            "dropped waiting",
            "done in flight",
        ]);
        expect(spokenTexts()).toEqual(["in flight"]);
    });
});

describe("Announcer.unlock", () => {
    it("says one silent line straight away, and the queue does not wait for it", () => {
        const announcer = new Announcer();
        const log: string[] = [];
        announcer.unlock();
        track(announcer, "one", log);

        expect(spokenTexts()).toEqual([" ", "one"]);
        expect(log).toEqual(["start one"]);
    });
});
