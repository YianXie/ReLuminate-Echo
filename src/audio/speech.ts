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
    resolve: () => void;
    onStart: (() => void) | undefined;
}

class Announcer {
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
     * Queues a line. Resolves when it has been spoken, or immediately when speech is off,
     * so that a caller sequencing onboarding can simply await each step.
     */
    speak(text: string, options: SpeakOptions = {}): Promise<void> {
        if (!text) return Promise.resolve();

        if (options.priority) {
            // Resolve the dropped lines rather than leaving their awaiters hanging forever.
            for (const item of this.queue.splice(0)) item.resolve();
        }

        return new Promise<void>((resolve) => {
            this.queue.push({ text, resolve, onStart: options.onStart });
            this.pump();
        });
    }

    /**
     * (spec) The mute toggle. Turning speech off stops the current line immediately —
     * here interrupting is the whole point, because the player has just asked for silence.
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) this.cancel();
    }

    /** Drops everything, pending and in flight. */
    cancel(): void {
        this.clearWatchdog();
        for (const item of this.queue.splice(0)) item.resolve();
        const finished = this.current;
        this.current = null;
        if (this.isSupported) window.speechSynthesis.cancel();
        finished?.resolve();
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
        item.resolve();
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
