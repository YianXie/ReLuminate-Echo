/**
 * Bootstrap: resume the AudioContext on a user gesture, then wire input, speech, state
 * and world together.
 *
 * (spec) An AudioContext starts suspended and only a user gesture can resume it. The
 * "press any key to begin" prompt, and the Start button that stands in for it on a touch
 * screen, exist to satisfy that rule. They double as the moment the player confirms their
 * headphones are on, which is why onboarding starts there and not on page load.
 */

import {
    isAudioRunning,
    masterVolume,
    resumeAudio,
    setMasterVolume,
} from "./audio/context";
import { GAME, PRACTICE, SETTINGS, SPEECH } from "./config";
import { Radar } from "./ui/radar";
import { TelemetryRecorder, downloadSessions } from "./telemetry";
import { playCalibrationTone } from "./audio/cues";
import { speech } from "./audio/speech";
import { SourcePool } from "./audio/source";
import { GameLoop } from "./game/loop";
import { World } from "./game/world";
import { Round, StateMachine } from "./game/state";
import { createDifficulty, practiceParameters } from "./game/difficulty";
import type { InputState } from "./game/player";
import { PROMPTS, type InputMode, type Prompts } from "./prompts";
import { TouchControls, type TouchAction } from "./ui/touch";

const status = requireElement("status");

/**
 * The part of the practice script that names no control. The rest is in `prompts.ts`.
 * Always spoken in full, whatever SPEECH.IN_ROUND_VERBOSITY says: this is the one place
 * the game is teaching rather than being played.
 */
const PRACTICE_NEXT = "Now find the next one on your own.";

/**
 * A primary input that cannot hover and is coarse: a phone or a tablet, where the player
 * most likely has no keyboard and is going to play with the on-screen controls.
 */
const NO_KEYBOARD_QUERY = "(hover: none) and (pointer: coarse)";

/** Any touch screen at all, a touch laptop included. Decides whether the buttons are shown. */
const TOUCH_QUERY = "(any-pointer: coarse)";

const TOUCH_START_PROMPT =
    "Put on headphones, then tap Start at the bottom of the screen, or press any key.";

/** Keys the game owns. Swallowing their defaults stops arrows and space scrolling the page. */
const HANDLED_KEYS = new Set([
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    " ",
    "Enter",
    "Escape",
]);

/** Movement keys held down. The on-screen buttons keep their own, in `touch.held`. */
const input: InputState = { turnLeft: false, turnRight: false, forward: false };
/** What `World` is handed each step: the keys and the buttons together. */
const movement: InputState = { turnLeft: false, turnRight: false, forward: false };

const touch = new TouchControls(document, {
    onAction: onTouchAction,
    onUse: () => {
        inputMode = "touch";
        wakeAudio();
    },
});

const machine = new StateMachine();
const difficulty = createDifficulty();
const telemetry = new TelemetryRecorder();
const radar = new Radar(requireElement("radar") as HTMLCanvasElement);

let pool: SourcePool | null = null;
let world: World | null = null;
let round: Round | null = null;
let loop: GameLoop | null = null;
/** Which entry of PRACTICE.BEACONS is being hunted. Only meaningful in the practice phase. */
let practiceBeacon = 0;
/** True when the current pause was forced by the page being hidden, not by the player. */
let pausedByVisibility = false;
/**
 * What the player has asked for, which is not always what the announcer is doing yet:
 * turning speech off is deferred until the confirmation has finished being spoken.
 */
let speechWanted = true;
/**
 * Which way of playing the spoken instructions describe: whichever the player used last.
 * A phone starts out on touch, and a tablet with a keyboard plugged in moves over to the
 * keys the moment one is pressed.
 */
let inputMode: InputMode = matches(NO_KEYBOARD_QUERY) ? "touch" : "keyboard";
/** True between the first gesture being accepted and the page closing. */
let started = false;
/** Keeps a phone's screen from locking mid-round, which would pause the game. */
let wakeLock: WakeLockSentinel | null = null;

prepareTouch();
waitForFirstGesture();

/** The spoken wording for the input the player is using. */
function prompts(): Prompts {
    return PROMPTS[inputMode];
}

/**
 * Shows the on-screen controls on anything with a touch screen. Until the game starts
 * they are a single Start button, which is the gesture a phone has to give before audio
 * or speech may begin: it stands in for "press any key".
 *
 * The prompt is written straight to the live region rather than announced, because
 * speech cannot start until that gesture has been given.
 */
function prepareTouch(): void {
    if (!matches(TOUCH_QUERY)) return;
    document.documentElement.dataset["input"] = "touch";
    requireElement("touch-controls").hidden = false;
    status.textContent = TOUCH_START_PROMPT;
    machine.onChange(syncTouchPad);
    syncTouchPad();
}

/**
 * Arms the keyboard half of the first gesture. The Start button is always listening, and
 * `onFirstGesture()` ignores whichever of the two comes second.
 */
function waitForFirstGesture(): void {
    window.addEventListener("keydown", onFirstKey, { once: true });
}

function onFirstKey(): void {
    inputMode = "keyboard";
    void onFirstGesture();
}

/**
 * The gesture that unlocks audio. Everything downstream assumes a running context.
 *
 * Anything that needs the gesture itself, rather than just having had one, happens before
 * the first `await`: after it, iOS no longer counts this as the player's doing.
 */
async function onFirstGesture(): Promise<void> {
    if (started) return;
    started = true;
    window.removeEventListener("keydown", onFirstKey);
    speech.unlock();
    void keepScreenAwake();

    try {
        await resumeAudio();
    } catch (error) {
        // Listen again rather than stranding the player: a refused resume is usually a
        // transient autoplay decision, and the next gesture is another chance.
        started = false;
        announce(
            `Audio could not start: ${(error as Error).message} ${prompts().retry}`
        );
        waitForFirstGesture();
        return;
    }

    const startButton = document.getElementById("touch-start");
    const pad = document.getElementById("touch-pad");
    if (startButton && pad) {
        startButton.hidden = true;
        pad.hidden = false;
    }

    pool = new SourcePool();
    world = new World(pool, {
        onTargetCollected: () => {
            round?.collect();
            telemetry.recordCollect();
            if (machine.is("practice")) advancePractice();
            else announce(collectedLine(round?.score ?? 0), true);
        },
        onHazardHit: () => {
            round?.penalise();
            telemetry.recordHazardHit();
            announce(hazardLine(), true);
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
 * The phase itself is the skip flag: pressing Space, T or P starts a round, which leaves
 * the onboarding phase, and the loop below stops at its next check. That avoids a separate
 * "skipped" boolean that could disagree with the state machine.
 */
async function runOnboarding(): Promise<void> {
    machine.enter("onboarding");

    const words = prompts();
    const steps: Array<string | (() => Promise<void>)> = [
        words.welcome,
        "Put on headphones now. The game is played entirely by ear, and it will not work on speakers.",
        "Now a quick headphone check. This tone is in your left ear.",
        () => playCalibrationTone("left"),
        "And this tone is in your right ear.",
        () => playCalibrationTone("right"),
        "If those arrived the wrong way round, your headphones are reversed. Swap them over.",
        ...words.controls,
        ...words.settings,
        words.onboardingEnd,
    ];

    for (const item of steps) {
        if (!machine.is("onboarding")) return;
        if (typeof item !== "string") {
            await item();
            continue;
        }
        // A priority line, such as a volume change, drops whatever was waiting behind it,
        // and that can be this step. None of onboarding is optional, so say it again. Each
        // retry takes another keypress from the player, so this cannot spin.
        while (!(await announce(item)))
            if (!machine.is("onboarding")) return;
    }
}

function startRound(): void {
    if (!world) return;
    const parameters = difficulty.next();
    round = new Round(parameters);
    telemetry.beginRound(parameters, "timed");
    world.start(parameters);
    machine.enter("playing");
    // The level is the one thing about this round the player cannot work out by ear.
    announce(
        `Level ${parameters.level}. ${parameters.roundSeconds} seconds. Find the beacon.`,
        true
    );
}

/**
 * The practice round: two beacons at scripted bearings, no hazards, no clock, nothing to
 * lose. Everything else is the real game, the sonar ping included, because that is what
 * is being taught. It is recorded like any other round, marked as practice.
 */
function startPractice(): void {
    if (!world) return;
    const parameters = practiceParameters();
    round = new Round(parameters);
    telemetry.beginRound(parameters, "practice");
    world.start(parameters);
    practiceBeacon = 0;
    placePracticeBeacon();
    machine.enter("practice");
    announce(prompts().practiceFirst, true);
    // The welcome line invites the player to skip straight here, and one who does has
    // been told to turn and walk but never which controls do that. Queued behind the
    // instruction rather than ahead of it, so a player who already knows and gets on with
    // it never hears them: collecting the first beacon flushes whatever is still waiting.
    for (const line of prompts().movement) void announce(line);
}

/**
 * Moves the beacon to its scripted place. The world has already put it somewhere random,
 * as it does for every new beacon; nothing has sounded from there yet, so overruling it
 * is inaudible. Returns false once the script has run out.
 */
function placePracticeBeacon(): boolean {
    const beacon = PRACTICE.BEACONS[practiceBeacon];
    if (!beacon || !world) return false;
    world.spawnTargetAt(beacon.bearingDeg, beacon.distance);
    return true;
}

/** A practice beacon was collected: on to the next, or done. */
function advancePractice(): void {
    practiceBeacon += 1;
    if (placePracticeBeacon()) announce(PRACTICE_NEXT, true);
    else endPractice();
}

/** Reached by collecting the last practice beacon or by pressing Escape. Same state, same prompt. */
function endPractice(): void {
    if (!round || !world || !machine.enter("roundOver")) return;
    world.stop();
    // Practice never reaches the difficulty controller: it says nothing about how hard a
    // timed round should be.
    telemetry.endRound(round.score);
    announce(prompts().practiceDone, true);
}

function endRound(): void {
    if (!round || !world) return;
    machine.enter("roundOver");
    world.stop();
    // The staircase is fed from the telemetry record rather than keeping a second set of
    // per-hunt timings: what adapts the game and what gets exported cannot then disagree.
    const record = telemetry.endRound(round.score);
    difficulty.record({
        score: round.score,
        hazardHits: round.hazardHits,
        durationSeconds: round.elapsed,
        acquisitionSeconds: record.acquisitions.map((a) => a.secondsToAcquire),
        abandonedHuntSeconds: record.abandonedSeconds,
    });
    const plural = round.score === 1 ? "beacon" : "beacons";
    announce(
        `Round over. You found ${round.score} ${plural}. ${prompts().playAgain}`,
        true
    );
}

/** (spec) In 'minimal' the collect cue has already said "collected"; only the number is news. */
function collectedLine(score: number): string {
    return SPEECH.IN_ROUND_VERBOSITY === "minimal"
        ? `${score}`
        : `Beacon collected. Score ${score}.`;
}

function hazardLine(): string {
    return SPEECH.IN_ROUND_VERBOSITY === "minimal"
        ? "Hazard."
        : "Hazard. Five seconds lost.";
}

/** One fixed simulation step. */
function step(dt: number): void {
    if (!machine.is("playing", "practice") || !world || !round) return;

    movement.turnLeft = input.turnLeft || touch.held.turnLeft;
    movement.turnRight = input.turnRight || touch.held.turnRight;
    movement.forward = input.forward || touch.held.forward;
    world.update(dt, movement);
    round.tick(dt);
    telemetry.sample(dt, {
        distanceToTarget: world.distanceToTarget,
        bearingToTarget: world.bearingToTarget,
        isWalking: world.player.isWalking,
    });

    // Neither can happen in practice: its round is infinitely long. See practiceParameters().
    if (round.takeWarning()) announce("Ten seconds remaining.", true);
    if (round.isOver) endRound();
}

function onKeyDown(event: KeyboardEvent): void {
    if (HANDLED_KEYS.has(event.key)) event.preventDefault();
    if (event.repeat) return;
    inputMode = "keyboard";
    wakeAudio();
    // A chord on a letter belongs to the browser, not the game: Cmd+P is "print", not
    // "start a practice round under the print dialog". Movement, Space, Enter and Escape
    // stay live with a modifier down, so a screen-reader user still holding Control from
    // silencing their own speech does not lose a turn. Shift is left alone: "+" needs it.
    const chord = event.ctrlKey || event.metaKey || event.altKey;
    if (chord && !HANDLED_KEYS.has(event.key)) return;

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
            if (machine.is("playing", "practice")) world?.collect();
            break;
        case "Escape":
            onEscape();
            break;
        case "t":
        case "T":
            beginFromReady(startRound);
            break;
        case "p":
        case "P":
            beginFromReady(startPractice);
            break;
        case "h":
        case "H":
            repeatControls();
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

/**
 * The on-screen buttons. Each does what its key does, through the same function, so the
 * two ways of playing cannot drift apart. Movement is not here: it is held, not pressed,
 * and `step()` reads it from `touch.held`.
 */
function onTouchAction(action: TouchAction): void {
    if (action === "start") {
        void onFirstGesture();
        return;
    }
    if (!started) return;
    switch (action) {
        case "practice":
            beginFromReady(startPractice);
            break;
        case "timed":
            beginFromReady(startRound);
            break;
        case "pause":
            onEscape();
            break;
        case "help":
            repeatControls();
            break;
        case "ping":
            ping();
            break;
        case "collect":
            if (machine.is("playing", "practice")) world?.collect();
            break;
        case "speech":
            toggleSpeech();
            break;
        case "volumeDown":
            changeVolume(-SETTINGS.VOLUME_STEP);
            break;
        case "volumeUp":
            changeVolume(SETTINGS.VOLUME_STEP);
            break;
        case "contrast":
            toggleContrast();
            break;
        case "download":
            exportTelemetry();
            break;
    }
}

/**
 * Marks the buttons that do nothing in the current phase, so a screen reader says
 * "dimmed" instead of leaving the player to wonder why a tap did nothing. They stay
 * pressable, because a button that vanishes from under a finger is worse. The pause
 * button is named for what it will do.
 */
function syncTouchPad(): void {
    const ready = machine.is("onboarding", "roundOver");
    const hunting = machine.is("playing", "practice");
    const live: Record<string, boolean> = {
        practice: ready,
        timed: ready,
        pause: machine.is("playing", "paused", "practice"),
        ping: hunting,
        collect: hunting,
        turnLeft: hunting,
        turnRight: hunting,
        forward: hunting,
    };
    const pad = requireElement("touch-pad");
    for (const button of pad.querySelectorAll<HTMLElement>("button")) {
        const name = button.dataset["action"] ?? button.dataset["hold"] ?? "";
        const enabled = live[name] ?? true;
        button.setAttribute("aria-disabled", String(!enabled));
    }
    requireElement("touch-pause").textContent = machine.is("paused")
        ? "Resume"
        : machine.is("practice")
          ? "End practice"
          : "Pause";
}

/**
 * (spec) H reads the controls again. The first sentence flushes whatever was waiting and
 * the rest queue up behind it in one go, so nothing else can land in the middle of the
 * list. A later priority line drops the remainder, which is right: it is more urgent.
 */
function repeatControls(): void {
    prompts().controls.forEach((line, index) => void announce(line, index === 0));
}

/**
 * (spec) Space does the expected thing for the phase: practice first from onboarding, a
 * timed round from the ready state between rounds, and a sonar ping during either.
 */
function onSpace(): void {
    if (machine.is("onboarding")) {
        beginFromReady(startPractice);
        return;
    }
    if (machine.is("roundOver")) {
        beginFromReady(startRound);
        return;
    }
    ping();
}

function ping(): void {
    if (!machine.is("playing", "practice") || !round || !world) return;
    if (round.usePing()) {
        telemetry.recordPing();
        world.ping();
    }
}

/**
 * Onboarding and the ready state between rounds are the two places a round can start
 * from. T and P mean the same thing in both; mid-round they do nothing. Whatever was
 * being said is cut off, because the player has just answered it.
 */
function beginFromReady(start: () => void): void {
    if (!machine.is("onboarding", "roundOver")) return;
    speech.cancel();
    start();
}

/**
 * (spec) Escape pauses and speaks the current score. Practice has no clock to stop, so
 * there it ends the practice instead.
 */
function onEscape(): void {
    if (machine.is("playing")) pause();
    else if (machine.is("paused")) unpause();
    else if (machine.is("practice")) {
        // The player has asked to leave, so the rest of a nine-second instruction about a
        // beacon that no longer exists is not worth waiting for.
        speech.cancel();
        endPractice();
    }
}

function pause(): void {
    if (!round || !world || !machine.enter("paused")) return;
    releaseAllKeys();
    world.silence();
    const seconds = Math.ceil(round.timeRemaining);
    announce(
        `Paused. Score ${round.score}. ${seconds} seconds left. ${prompts().resume}`,
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
        } else if (machine.is("practice")) {
            // No clock to stop, so no pause to enter. Just do not leave a wall hissing
            // into a tab nobody is looking at.
            world?.silence();
        }
        return;
    }

    // A locked phone releases the wake lock and may suspend the audio context, and
    // neither comes back by itself. Most browsers let a page that has played before
    // resume without a fresh gesture; where one does not, the next press does it.
    void keepScreenAwake();
    wakeAudio();
    if (pausedByVisibility) {
        pausedByVisibility = false;
        unpause();
    } else if (machine.is("practice")) {
        world?.resume();
    }
}

/**
 * Restarts an audio context the system has suspended since the game began, as iOS does
 * after the phone is locked or a call comes in. Called from every press, because a press
 * is the gesture a browser may insist on before it lets audio start again.
 */
function wakeAudio(): void {
    if (started && !isAudioRunning()) resumeAudio().catch(() => {});
}

/**
 * Asks the browser not to lock the screen while the page is visible. On a phone, a
 * locked screen hides the page, which pauses the round, so a player listening rather
 * than looking would be cut off every thirty seconds. Refusal is not an error: the
 * browser may not offer it, or battery saver may be on.
 */
async function keepScreenAwake(): Promise<void> {
    if (wakeLock || !("wakeLock" in navigator) || document.hidden) return;
    try {
        const lock = await navigator.wakeLock.request("screen");
        wakeLock = lock;
        lock.addEventListener("release", () => {
            if (wakeLock === lock) wakeLock = null;
        });
    } catch {
        // Not offered or not allowed. The game still plays; the phone may lock.
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
    if (!world || !machine.is("playing", "paused", "practice")) {
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
    touch.releaseAll();
}

/**
 * The single announcement channel.
 *
 * (spec) Everything is said aloud and written to the ARIA live region, so a player using
 * their own screen reader with our speech muted gets the same information. Resolves once
 * the line has been spoken, which is what lets onboarding sequence itself, and resolves
 * false if the line was dropped from the queue without being said.
 *
 * The live region is written as the line starts being spoken, not as it is queued.
 * Several lines queued together, as H does, would otherwise overwrite each other at once
 * and a screen reader would catch only the last.
 */
function announce(message: string, priority = false): Promise<boolean> {
    if (
        import.meta.env.DEV &&
        message.length > SPEECH.MAX_UTTERANCE_CHARS
    ) {
        console.warn(
            `Announcement is ${message.length} characters, over ` +
                `SPEECH.MAX_UTTERANCE_CHARS (${SPEECH.MAX_UTTERANCE_CHARS}). ` +
                `Split it into sentences: "${message}"`
        );
    }
    return speech.speak(message, {
        priority,
        onStart: () => {
            status.textContent = message;
        },
    });
}

function matches(query: string): boolean {
    return window.matchMedia?.(query)?.matches ?? false;
}

function requireElement(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing required element #${id}`);
    return element;
}
