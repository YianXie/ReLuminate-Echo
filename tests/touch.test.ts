import { describe, expect, it } from "vitest";
import { TOUCH } from "../src/config";
import {
    isHoldControl,
    isTouchAction,
    remainingHoldMs,
} from "../src/ui/touch";

describe("remainingHoldMs", () => {
    const minimum = TOUCH.MIN_HOLD_SECONDS * 1000;

    it("stretches a tap to the minimum hold", () => {
        expect(remainingHoldMs(0)).toBe(minimum);
        expect(remainingHoldMs(minimum / 2)).toBeCloseTo(minimum / 2, 9);
    });

    it("lets go at once of a press that has already lasted long enough", () => {
        expect(remainingHoldMs(minimum)).toBe(0);
        expect(remainingHoldMs(minimum * 10)).toBe(0);
    });
});

describe("markup attributes", () => {
    it("accepts the names index.html uses and nothing else", () => {
        expect(isTouchAction("ping")).toBe(true);
        expect(isTouchAction("volumeUp")).toBe(true);
        expect(isTouchAction("turnLeft")).toBe(false);
        expect(isTouchAction(undefined)).toBe(false);

        expect(isHoldControl("forward")).toBe(true);
        expect(isHoldControl("ping")).toBe(false);
        expect(isHoldControl(undefined)).toBe(false);
    });
});
