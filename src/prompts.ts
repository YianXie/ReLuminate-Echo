/**
 * Every spoken line that names a control, in a keyboard wording and a touch wording.
 *
 * The game is played by ear, so the words are the interface: a phone player told to
 * "press Space" has been told nothing. `main.ts` picks the set for whichever input the
 * player last used, which is also why these are data and not inline strings: the tests
 * can check both sets against SPEECH.MAX_UTTERANCE_CHARS.
 *
 * The touch lines describe where each button is as well as what it does. A player who
 * cannot see the screen finds the buttons by that description alone, so it has to match
 * the layout of `#touch-pad` in index.html row for row.
 */

export type InputMode = "keyboard" | "touch";

export interface Prompts {
    /** The first line of onboarding, including how to skip it. */
    readonly welcome: string;
    /** How to turn and walk, repeated to a player who skipped straight into practice. */
    readonly movement: readonly string[];
    /** The full control list, read in onboarding and by H or the help button. */
    readonly controls: readonly string[];
    /** Settings, and anything else worth saying once. Onboarding only. */
    readonly settings: readonly string[];
    /** The last line of onboarding: how to start playing. */
    readonly onboardingEnd: string;
    /**
     * The first practice instruction. Says "to your right", which is only true while the
     * first entry of PRACTICE.BEACONS stays to the right.
     */
    readonly practiceFirst: string;
    readonly practiceDone: string;
    /** Ends the round-over line. */
    readonly playAgain: string;
    /** Ends the paused line. */
    readonly resume: string;
    /** Ends the line that says audio could not start. */
    readonly retry: string;
}

const KEYBOARD: Prompts = {
    welcome:
        "Welcome to ReLuminate Echo. A beacon hunt you play with your ears. " +
        "Press Space at any time to skip.",
    movement: ["Left and right arrows turn.", "Up arrow walks forward."],
    controls: [
        "Left and right arrows turn.",
        "Up arrow walks forward.",
        "Space sends a sonar ping.",
        "Enter collects the beacon when you are on it.",
        "Escape pauses and reads your score, or ends a practice round.",
        "P starts a practice round.",
        "T starts a timed round.",
        "H repeats these controls.",
    ],
    settings: [
        "S turns speech on and off.",
        "Minus and equals change the volume.",
        "C switches high contrast visuals.",
        "D downloads your session data.",
    ],
    onboardingEnd:
        "Press Space for a short practice. Or press T to go straight to a timed round.",
    practiceFirst:
        "The beacon is to your right. Turn right until you hear the click, then walk forward. " +
        "Press Enter when you hear the double chime.",
    practiceDone: "Practice complete. Press Space to start a timed round.",
    playAgain: "Press Space to play again.",
    resume: "Escape to resume.",
    retry: "Press any key to retry.",
};

const TOUCH: Prompts = {
    welcome:
        "Welcome to ReLuminate Echo. A beacon hunt you play with your ears. " +
        "Tap practice, top left, at any time to skip.",
    movement: [
        "Hold turn left or turn right, in the bottom corners, to turn.",
        "Hold walk, bottom centre, to walk forward.",
    ],
    controls: [
        "The controls are at the bottom of the screen, in three rows.",
        "Bottom row, left to right: turn left, walk, turn right. Hold them down to keep going.",
        "Middle row: ping on the left, collect on the right.",
        "Ping sends a sonar ping. Collect picks up the beacon when you are on it.",
        "Top row, left to right: practice, timed round, pause, and help.",
        "Pause pauses and reads your score, or ends a practice round.",
        "Help repeats these controls.",
        "With a screen reader on, double tap and hold to keep turning or walking.",
    ],
    settings: [
        "Buttons for speech, volume and contrast are in the settings section of the page.",
        "Your phone's own volume buttons work too.",
        "Locking the phone pauses the game.",
    ],
    onboardingEnd:
        "Tap practice, top left, for a short practice. " +
        "Or tap timed round, next to it, to go straight in.",
    practiceFirst:
        "The beacon is to your right. Hold turn right until you hear the click, then hold walk. " +
        "Tap collect when you hear the double chime.",
    practiceDone: "Practice complete. Tap timed round, top row, to start a timed round.",
    playAgain: "Tap timed round to play again.",
    resume: "Tap resume, top row, to carry on.",
    retry: "Tap start to retry.",
};

export const PROMPTS: Readonly<Record<InputMode, Prompts>> = {
    keyboard: KEYBOARD,
    touch: TOUCH,
};
