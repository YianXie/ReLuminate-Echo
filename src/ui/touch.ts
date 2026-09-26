import { TOUCH } from "../config";
import type { InputState } from "../game/player";

/**
 * On-screen controls for phones and tablets.
 *
 * This is the only module that listens to pointer events. The keyboard stays the primary
 * input and every button here does exactly what a key does, so the two can never drift
 * into offering different games. `main.ts` owns what each action means; this module only
 * turns taps and holds into action names and a held-movement state.
 *
 * Two kinds of button, both marked up in index.html:
 *
 * - `data-hold="turnLeft" | "turnRight" | "forward"`: movement. Held while a finger is
 *   down, like an arrow key. A press shorter than TOUCH.MIN_HOLD_SECONDS is stretched to
 *   that length, so a tap is a small step rather than nothing at all.
 * - `data-action="..."`: everything else, fired on `click`. A click is what a screen
 *   reader's double tap and a switch or keyboard activation produce as well as a finger,
 *   which makes it the one event every way of pressing a button has in common.
 */

export type HoldControl = keyof InputState;

export const TOUCH_ACTIONS = [
    "start",
    "practice",
    "timed",
    "pause",
    "help",
    "ping",
    "collect",
    "speech",
    "volumeDown",
    "volumeUp",
    "contrast",
    "download",
] as const;

export type TouchAction = (typeof TOUCH_ACTIONS)[number];

const HOLD_CONTROLS: readonly HoldControl[] = [
    "turnLeft",
    "turnRight",
    "forward",
];

/**
 * How much longer a movement press has to be kept down once the finger has lifted,
 * milliseconds. Zero for a press that has already lasted the minimum.
 */
export function remainingHoldMs(heldMs: number): number {
    return Math.max(0, TOUCH.MIN_HOLD_SECONDS * 1000 - heldMs);
}

export function isTouchAction(value: string | undefined): value is TouchAction {
    return (TOUCH_ACTIONS as readonly string[]).includes(value ?? "");
}

export function isHoldControl(value: string | undefined): value is HoldControl {
    return (HOLD_CONTROLS as readonly string[]).includes(value ?? "");
}

export interface TouchCallbacks {
    onAction: (action: TouchAction) => void;
    /** Any press at all, so the caller can switch its spoken wording to touch. */
    onUse: () => void;
}

export class TouchControls {
    /** Movement currently held down on screen. Read every simulation step. */
    readonly held: InputState = {
        turnLeft: false,
        turnRight: false,
        forward: false,
    };

    /** When each movement press began, `performance.now()` milliseconds. */
    private readonly pressedAt = new Map<HoldControl, number>();
    /** The pointer holding each movement button down, so a second finger cannot release it. */
    private readonly pointers = new Map<HoldControl, number>();
    /** Movement buttons whose next click belongs to a pointer press already handled. */
    private readonly pointerClicks = new Set<HoldControl>();
    private readonly releaseTimers = new Map<HoldControl, number>();

    constructor(
        root: ParentNode,
        private readonly callbacks: TouchCallbacks
    ) {
        for (const button of root.querySelectorAll<HTMLElement>("[data-hold]")) {
            const control = button.dataset["hold"];
            if (isHoldControl(control)) this.bindHold(button, control);
        }
        for (const button of root.querySelectorAll<HTMLElement>("[data-action]")) {
            const action = button.dataset["action"];
            if (isTouchAction(action)) this.bindAction(button, action);
        }
    }

    /** Lets go of everything at once, for pause, blur and a hidden page. */
    releaseAll(): void {
        for (const timer of this.releaseTimers.values()) window.clearTimeout(timer);
        this.releaseTimers.clear();
        this.pointers.clear();
        this.pressedAt.clear();
        for (const control of HOLD_CONTROLS) this.held[control] = false;
    }

    private bindAction(button: HTMLElement, action: TouchAction): void {
        button.addEventListener("click", () => {
            this.callbacks.onUse();
            this.callbacks.onAction(action);
        });
    }

    private bindHold(button: HTMLElement, control: HoldControl): void {
        button.addEventListener("pointerdown", (event) => {
            if (this.pointers.has(control)) return;
            event.preventDefault();
            // Capture keeps the release coming here even if the finger slides off the
            // button, which a player who cannot see the button will do.
            button.setPointerCapture?.(event.pointerId);
            this.pointers.set(control, event.pointerId);
            this.pointerClicks.add(control);
            this.callbacks.onUse();
            this.press(control);
        });

        const release = (event: PointerEvent): void => {
            if (this.pointers.get(control) !== event.pointerId) return;
            this.pointers.delete(control);
            if (event.type === "pointercancel") this.pointerClicks.delete(control);
            this.release(control);
        };
        button.addEventListener("pointerup", release);
        button.addEventListener("pointercancel", release);
        button.addEventListener("lostpointercapture", release);

        // A click that no pointer press came before it: a screen reader's double tap on
        // some platforms, or a switch device. There is nothing to hold, so it is a tap.
        button.addEventListener("click", () => {
            if (this.pointerClicks.delete(control)) return;
            this.callbacks.onUse();
            this.press(control);
            this.release(control);
        });

        // A long press would otherwise open the text-selection or share menu.
        button.addEventListener("contextmenu", (event) => event.preventDefault());
    }

    private press(control: HoldControl): void {
        const timer = this.releaseTimers.get(control);
        if (timer !== undefined) window.clearTimeout(timer);
        this.releaseTimers.delete(control);
        this.pressedAt.set(control, performance.now());
        this.held[control] = true;
    }

    private release(control: HoldControl): void {
        const since = performance.now() - (this.pressedAt.get(control) ?? 0);
        this.pressedAt.delete(control);
        const wait = remainingHoldMs(since);
        if (wait <= 0) {
            this.held[control] = false;
            return;
        }
        this.releaseTimers.set(
            control,
            window.setTimeout(() => {
                this.releaseTimers.delete(control);
                this.held[control] = false;
            }, wait)
        );
    }
}
