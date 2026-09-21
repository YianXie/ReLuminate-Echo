/**
 * Self-voicing: a Web Speech wrapper and the announcement queue.
 *
 * (spec) The player may have no vision and no screen reader running, so the game speaks
 * for itself. A mute toggle exists for the opposite case — a screen-reader user would
 * otherwise hear everything twice, once from us and once from their own software.
 *
 * The queue is the point of this module. `speechSynthesis` has a queue of its own, but
 * it offers no way to drop pending items without also cutting off whatever is mid-word,
 * and being interrupted mid-word is exactly what a player navigating by ear cannot
 * afford. So we keep one utterance in flight at a time and manage the backlog here.
 *
 * Like the rest of `src/audio/`, this imports nothing from `src/game/`.
 */

import { SPEECH } from "../config";

export interface SpeakOptions {
    /**
     * Drops anything still waiting so this line is next.
     *
     * It does NOT cut off the line currently being spoken: SPEC.md is explicit that
     * announcements must not interrupt each other mid-word, and a round-over or
     * ten-seconds-left cue arriving one short sentence late is a far smaller problem than
     * a player losing the second half of the sentence they were listening to.
     */
    priority?: boolean;
    /**
     * Called as the line starts being spoken, which for a queued line is later than the
     * call to `speak()`. A caller mirroring speech into an ARIA live region writes it from
     * here, so that several lines queued in one go reach the region one at a time, each
     * as it is said, instead of overwriting each other on the spot.
     *
     * Never called for a line that is dropped from the queue before its turn.
     */
    onStart?: () => void;
}

interface QueueItem {
    text: string;
    /** True if the line was started, false if it was dropped before its turn. */
    resolve: (started: boolean) => void;
    onStart: (() => void) | undefined;
}

export class Announcer {
    private readonly queue: QueueItem[] = [];
    private current: QueueItem | null = null;
    private watchdog: number | null = null;
    private enabled = true;

    /** False when the browser has no speech synthesis at all. */
    readonly isSupported: boolean =
        typeof window !== "undefined" && "speechSynthesis" in window;

    get isEnabled(): boolean {
        return this.enabled && this.isSupported;
    }

    /**
     * Queues a line. Resolves once it has been spoken, or once its reading time has passed
     * when speech is off, so that a caller sequencing onboarding can simply await each step.
     *
     * Resolves true if the line got its turn and false if it was dropped from the queue
     * first, by a priority line or by `cancel()`. A caller for whom the line was not
     * optional can use that to say it again.
     */
    speak(text: string, options: SpeakOptions = {}): Promise<boolean> {
        if (!text) return Promise.resolve(true);

        if (options.priority) {
            // Resolve the dropped lines rather than leaving their awaiters hanging forever.
            for (const item of this.queue.splice(0)) item.resolve(false);
        }

        return new Promise<boolean>((resolve) => {
            this.queue.push({ text, resolve, onStart: options.onStart });
            this.pump();
        });
    }

    /**
     * (spec) The mute toggle. Turning speech off stops the current line immediately —
     * here interrupting is the whole point, because the player has just asked for silence.
     *
     * It silences the voice and nothing else. Lines still waiting are kept and carry on
     * through the muted path in `pump()`, because from this moment the live region is the
     * player's only channel and those lines have not reached it yet.
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (enabled) return;
        const interrupted = this.stopCurrent();
        interrupted?.resolve(true);
        this.pump();
    }

    /** Drops everything, pending and in flight. */
    cancel(): void {
        for (const item of this.queue.splice(0)) item.resolve(false);
        // The line in flight had started, which is all `speak()` promises about it.
        this.stopCurrent()?.resolve(true);
    }

    /** Cuts off the line in flight, if any, and hands it back for its awaiter to be released. */
    private stopCurrent(): QueueItem | null {
        this.clearWatchdog();
        const interrupted = this.current;
        this.current = null;
        // A late `end` or `error` from the cancelled utterance is harmless: `finish()`
        // ignores any line that is no longer the current one.
        if (this.isSupported) window.speechSynthesis.cancel();
        return interrupted;
    }

    private pump(): void {
        if (this.current || this.queue.length === 0) return;
        const item = this.queue.shift();
        if (!item) return;
        this.current = item;
        item.onStart?.();

        if (!this.isEnabled) {
            // Muted, or the browser has no speech at all. The queue still runs, at reading
            // pace, because the ARIA live region is the fallback channel and overwriting it
            // faster than a screen reader can speak would swallow every line but the last.
            // This is the exact case the mute toggle exists for, so it has to keep working.
            this.watchdog = window.setTimeout(
                () => this.finish(item),
                this.estimate(item.text) * 1000
            );
            return;
        }

        const utterance = new SpeechSynthesisUtterance(item.text);
        utterance.lang = SPEECH.LANG;
        utterance.rate = SPEECH.RATE;
        utterance.pitch = SPEECH.PITCH;
        utterance.volume = SPEECH.VOLUME;
        utterance.onend = () => this.finish(item);
        // An error is still a finished line as far as the queue is concerned; stalling here
        // would silence every announcement that followed it.
        utterance.onerror = () => this.finish(item);

        this.armWatchdog(item);
        window.speechSynthesis.speak(utterance);
    }

    private finish(item: QueueItem): void {
        if (this.current !== item) return;
        this.clearWatchdog();
        this.current = null;
        item.resolve(true);
        // (spec) A beat between lines so two announcements never sound like one sentence.
        window.setTimeout(() => this.pump(), SPEECH.GAP * 1000);
    }

    private armWatchdog(item: QueueItem): void {
        const seconds =
            this.estimate(item.text) + SPEECH.WATCHDOG_PADDING_SECONDS;
        this.watchdog = window.setTimeout(
            () => this.finish(item),
            seconds * 1000
        );
    }

    /** Roughly how long a line takes to say, seconds. */
    private estimate(text: string): number {
        return text.length / SPEECH.ESTIMATED_CHARS_PER_SECOND / SPEECH.RATE;
    }

    private clearWatchdog(): void {
        if (this.watchdog !== null) window.clearTimeout(this.watchdog);
        this.watchdog = null;
    }
}

/** One announcer for the whole game. */
export const speech = new Announcer();
