/**
 * Bootstrap: resume the AudioContext on a user gesture, then wire input, speech, state
 * and world together.
 *
 * (spec) An AudioContext starts suspended and only a user gesture can resume it. The
 * "press any key to begin" prompt exists to satisfy that rule; it doubles as the moment
 * the player confirms their headphones are on, which is why onboarding starts there and
 * not on page load.
 */

import { masterVolume, resumeAudio, setMasterVolume } from "./audio/context";
import { GAME, SETTINGS } from "./config";
import { Radar } from "./ui/radar";
import { TelemetryRecorder, downloadSessions } from "./telemetry";
import { playCalibrationTone } from "./audio/cues";
import { speech } from "./audio/speech";
import { SourcePool } from "./audio/source";
import { GameLoop } from "./game/loop";
import { World } from "./game/world";
import { Round, StateMachine } from "./game/state";
import { createDifficulty } from "./game/difficulty";
import type { InputState } from "./game/player";

const status = requireElement("status");

/** (spec) The full control list, in one place so every channel reads the same words. */
const CONTROLS =
    "Left and right arrows turn. Up arrow walks forward. Space sends a sonar ping. " +
    "Enter collects the beacon when you are on it. Escape pauses and reads your score. " +
    "H repeats these controls.";

const SETTINGS_HELP =
    "S turns speech on and off. Minus and equals change the volume. " +
    "C switches high contrast visuals. D downloads your session data.";

/** Keys the game owns. Swallowing their defaults stops arrows and space scrolling the page. */
const HANDLED_KEYS = new Set([
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    " ",
    "Enter",
    "Escape",
]);

const input: InputState = { turnLeft: false, turnRight: false, forward: false };

const machine = new StateMachine();
const difficulty = createDifficulty();
const telemetry = new TelemetryRecorder();
const radar = new Radar(requireElement("radar") as HTMLCanvasElement);

let pool: SourcePool | null = null;
let world: World | null = null;
let round: Round | null = null;
let loop: GameLoop | null = null;
/** True when the current pause was forced by the page being hidden, not by the player. */
let pausedByVisibility = false;
/**
 * What the player has asked for, which is not always what the announcer is doing yet:
 * turning speech off is deferred until the confirmation has finished being spoken.
 */
let speechWanted = true;

waitForFirstKey();

function waitForFirstKey(): void {
    window.addEventListener("keydown", onFirstKey, { once: true });
}

/** The gesture that unlocks audio. Everything downstream assumes a running context. */
async function onFirstKey(): Promise<void> {
    try {
        await resumeAudio();
    } catch (error) {
        // Listen again rather than stranding the player: a refused resume is usually a
        // transient autoplay decision, and the next keypress is another chance at a gesture.
        announce(
            `Audio could not start: ${(error as Error).message} Press any key to retry.`
        );
        waitForFirstKey();
        return;
    }

    pool = new SourcePool();
    world = new World(pool, {
        onTargetCollected: () => {
            round?.collect();
            telemetry.recordCollect();
            announce(`Beacon collected. Score ${round?.score ?? 0}.`, true);
        },
        onHazardHit: () => {
            round?.penalise();
            telemetry.recordHazardHit();
            announce("Hazard. Five seconds lost.", true);
        },
    });

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseAllKeys);
    document.addEventListener("visibilitychange", onVisibilityChange);

    loop = new GameLoop(step, renderRadar);
    loop.start();

    if (!speech.isSupported) {
        // Nothing can be said about this out loud, so say it in the live region and let the
        // player's own screen reader pick it up.
        announce(
            "This browser has no speech synthesis. Sound cues still work."
        );
    }
    void runOnboarding();
}

/**
 * (spec) Spoken onboarding, in the order SPEC.md §7 sets out.
 *
 * The phase itself is the skip flag: pressing Space starts the round, which leaves the
 * onboarding phase, and the loop below stops at its next check. That avoids a separate
 * "skipped" boolean that could disagree with the state machine.
 */
async function runOnboarding(): Promise<void> {
    machine.enter("onboarding");

    const steps: Array<string | (() => Promise<void>)> = [
        "Welcome to ReLuminate Echo. A beacon hunt you play with your ears.",
        "Put on headphones now. The game is played entirely by ear, and it will not work on speakers.",
        "Now a quick headphone check. This tone is in your left ear.",
        () => playCalibrationTone("left"),
        "And this tone is in your right ear.",
        () => playCalibrationTone("right"),
        "If those arrived the wrong way round, your headphones are reversed. Swap them over.",
        CONTROLS,
        SETTINGS_HELP,
        "Press Space to begin.",
    ];

    for (const item of steps) {
        if (!machine.is("onboarding")) return;
        if (typeof item === "string") await announce(item);
        else await item();
    }
}

function startRound(): void {
    if (!world) return;
    const parameters = difficulty.next();
    round = new Round(parameters);
    telemetry.beginRound(parameters);
    world.start(parameters);
    machine.enter("playing");
    announce(
        `Round started. ${parameters.roundSeconds} seconds. Find the beacon.`,
        true
    );
}

function endRound(): void {
    if (!round || !world) return;
    machine.enter("roundOver");
    world.stop();
    difficulty.record({
        score: round.score,
        hazardHits: round.hazardHits,
        durationSeconds: round.elapsed,
    });
    telemetry.endRound(round.score);
    const plural = round.score === 1 ? "beacon" : "beacons";
    announce(
        `Round over. You found ${round.score} ${plural}. Press Space to play again.`,
        true
    );
}

/** One fixed simulation step. */
function step(dt: number): void {
    if (!machine.is("playing") || !world || !round) return;

    world.update(dt, input);
    round.tick(dt);
    telemetry.sample(dt, {
        distanceToTarget: world.distanceToTarget,
        bearingToTarget: world.bearingToTarget,
        isWalking: world.player.isWalking,
    });

    if (round.takeWarning()) announce("Ten seconds remaining.", true);
    if (round.isOver) endRound();
}

function onKeyDown(event: KeyboardEvent): void {
    if (HANDLED_KEYS.has(event.key)) event.preventDefault();
    if (event.repeat) return;

    switch (event.key) {
        case "ArrowLeft":
            input.turnLeft = true;
            break;
        case "ArrowRight":
            input.turnRight = true;
            break;
        case "ArrowUp":
            input.forward = true;
            break;
        case " ":
            onSpace();
            break;
        case "Enter":
            if (machine.is("playing")) world?.collect();
            break;
        case "Escape":
            togglePause();
            break;
        case "h":
        case "H":
            announce(CONTROLS, true);
            break;
        case "s":
        case "S":
            toggleSpeech();
            break;
        case "-":
        case "_":
            changeVolume(-SETTINGS.VOLUME_STEP);
            break;
        case "=":
        case "+":
            changeVolume(SETTINGS.VOLUME_STEP);
            break;
        case "c":
        case "C":
            toggleContrast();
            break;
        case "d":
        case "D":
            exportTelemetry();
            break;
        default:
            break;
    }
}

function onKeyUp(event: KeyboardEvent): void {
    if (HANDLED_KEYS.has(event.key)) event.preventDefault();
    switch (event.key) {
        case "ArrowLeft":
            input.turnLeft = false;
            break;
        case "ArrowRight":
            input.turnRight = false;
            break;
        case "ArrowUp":
            input.forward = false;
            break;
        default:
            break;
    }
}

/** (spec) Space begins the game, pings during play, and starts the next round after one ends. */
function onSpace(): void {
    if (machine.is("onboarding", "roundOver")) {
        speech.cancel();
        startRound();
        return;
    }
    if (!machine.is("playing") || !round || !world) return;
    if (round.usePing()) {
        telemetry.recordPing();
        world.ping();
    }
}

/** (spec) Escape pauses and speaks the current score. */
function togglePause(): void {
    if (machine.is("playing")) pause();
    else if (machine.is("paused")) unpause();
}

function pause(): void {
    if (!round || !world || !machine.enter("paused")) return;
    releaseAllKeys();
    world.silence();
    const seconds = Math.ceil(round.timeRemaining);
    announce(
        `Paused. Score ${round.score}. ${seconds} seconds left. Escape to resume.`,
        true
    );
}

function unpause(): void {
    if (!world || !machine.enter("playing")) return;
    world.resume();
    announce("Resumed.", true);
}

/**
 * A backgrounded page has its animation frames throttled or stopped altogether, which
 * would leave the round crawling or frozen while the beacon carried on sounding.
 * Pausing outright is both honest and what the player would expect. Resuming on return
 * is deliberate: an auto-pause the player did not ask for should not need undoing.
 *
 * This reacts to transitions only. A page that is hidden before the player ever presses
 * a key cannot have been played in the first place, and trusting `document.hidden` as a
 * proxy for "frames have stopped" is not safe: embedded web views report hidden while
 * still painting at full rate.
 */
function onVisibilityChange(): void {
    if (document.hidden) {
        if (machine.is("playing")) {
            pausedByVisibility = true;
            pause();
        }
    } else if (pausedByVisibility) {
        pausedByVisibility = false;
        unpause();
    }
}

/**
 * (spec) Setting one of three: speech on/off, for players whose screen reader would
 * otherwise read every announcement a second time.
 *
 * Turning speech off says so first and mutes afterwards, otherwise the confirmation
 * would be the one announcement the player never hears.
 */
function toggleSpeech(): void {
    speechWanted = !speechWanted;

    if (speechWanted) {
        speech.setEnabled(true);
        announce("Speech on.", true);
        return;
    }

    void announce("Speech off.", true).then(() => {
        // The player may have changed their mind while that sentence was being spoken.
        // Tracking the intent separately is what makes a second press during the
        // confirmation mean "actually, leave it on" instead of "turn it off again".
        if (!speechWanted) speech.setEnabled(false);
    });
}

/** (spec) Setting two of three: master volume. Affects game audio, not the speech voice. */
function changeVolume(delta: number): void {
    const next =
        Math.round(Math.min(1, Math.max(0, masterVolume() + delta)) * 100) /
        100;
    setMasterVolume(next);
    announce(`Volume ${Math.round(next * 100)} percent.`, true);
}

/** (spec) Setting three of three: high contrast visuals, for players with some sight. */
function toggleContrast(): void {
    const root = document.documentElement;
    const high = root.dataset["contrast"] !== "high";
    if (high) root.dataset["contrast"] = "high";
    else delete root.dataset["contrast"];
    radar.setHighContrast(high);
    announce(`High contrast ${high ? "on" : "off"}.`, true);
}

/** (spec) D downloads everything recorded in this browser as JSON. Nothing is uploaded. */
function exportTelemetry(): void {
    const rounds = downloadSessions();
    const plural = rounds === 1 ? "round" : "rounds";
    announce(`Downloaded ${rounds} ${plural} of session data.`, true);
}

/**
 * (spec) The radar is drawn for sighted viewers of the demo recording, so it renders on
 * every animation frame rather than every simulation step. It reads the world and
 * changes nothing; hiding it would not alter the game in any way.
 */
function renderRadar(): void {
    if (!world || !machine.is("playing", "paused")) {
        radar.render(null);
        return;
    }
    radar.render({
        player: {
            x: world.player.x,
            y: world.player.y,
            heading: world.player.heading,
        },
        target: { x: world.target.x, y: world.target.y },
        hazards: world.hazards,
        arenaSize: GAME.ARENA_SIZE,
        inRange: world.isTargetInRange,
    });
}

/** A key held while the window loses focus never reports keyup, so clear the lot. */
function releaseAllKeys(): void {
    input.turnLeft = false;
    input.turnRight = false;
    input.forward = false;
}

/**
 * The single announcement channel.
 *
 * (spec) Everything is said aloud and written to the ARIA live region, so a player using
 * their own screen reader with our speech muted gets the same information. Resolves once
 * the line has been spoken, which is what lets onboarding sequence itself.
 */
function announce(message: string, priority = false): Promise<void> {
    status.textContent = message;
    return speech.speak(message, { priority });
}

function requireElement(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing required element #${id}`);
    return element;
}
