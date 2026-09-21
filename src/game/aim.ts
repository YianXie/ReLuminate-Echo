import { CUES, GAME, type CentreTickMode } from "../config";

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Half-width of the "you are aimed at the beacon" window, degrees.
 *
 * Never narrower than GAME.CENTRE_TOLERANCE, and never narrower than the beacon: close
 * in, the collect radius covers more of the horizon than the fixed tolerance does, and a
 * player walking straight at it would otherwise hear the tick cut in and out.
 */
export function centreTolerance(
    collectRadius: number,
    distance: number
): number {
    // atan2 rather than atan of a quotient, so standing on the beacon is 90 degrees
    // instead of a division by zero.
    const subtended = Math.atan2(collectRadius, distance) * RAD_TO_DEG;
    return Math.max(GAME.CENTRE_TOLERANCE, subtended);
}

/**
 * What the centre-lock tick should do on one step: nothing, the unthrottled tick for
 * arriving on target, or the rate-limited one for staying there.
 */
export type CentreTick = "none" | "entry" | "held";

/** Remembers whether the player was aimed on the previous step, and when they last heard so. */
export class CentreLock {
    private aimed = false;
    private sinceTick = 0;

    /** Forgets the aim, so that the next aimed step counts as arriving. */
    reset(): void {
        this.aimed = false;
        this.sinceTick = 0;
    }

    step(
        dt: number,
        aimed: boolean,
        mode: CentreTickMode = CUES.CENTRE_TICK.MODE
    ): CentreTick {
        const entered = aimed && !this.aimed;
        this.aimed = aimed;
        if (!aimed) return "none";
        // Asked for on every aimed step; the cue's own rate limit sets the pace.
        if (mode === "continuous") return "held";

        if (entered) {
            this.sinceTick = 0;
            return "entry";
        }
        this.sinceTick += dt;
        if (this.sinceTick < CUES.CENTRE_TICK.EDGE_REPEAT_INTERVAL)
            return "none";
        this.sinceTick = 0;
        return "held";
    }
}
