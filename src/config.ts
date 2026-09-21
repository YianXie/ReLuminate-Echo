/**
 * ReLuminate Echo — every tunable constant in the project.
 *
 * Nothing in this codebase hard-codes a number that a playtest might want to change.
 * If a value is a judgement call, the comment says what it trades off, because the
 * only way to tune an audio game is by ear and the person doing the tuning needs to
 * know which direction to push.
 *
 * Angles are in degrees where a human would read them and radians where the maths
 * needs them; the conversion always happens at the point of use, never here.
 * Times are in seconds, to match `AudioContext.currentTime`.
 */

/** Rules and geometry of the arena. Values marked (spec) come from SPEC.md §5. */
export const GAME = {
    /** (spec) Arena is ARENA_SIZE x ARENA_SIZE units, centred on the origin. */
    ARENA_SIZE: 40,
    /** (spec) Walking speed, units/sec. Faster feels responsive but overshoots the beacon. */
    PLAYER_SPEED: 3,
    /** (spec) Rotation speed, degrees/sec. Faster is quicker to aim, harder to hold a lock. */
    TURN_SPEED: 120,
    /** (spec) Distance at which the target can be collected, units. */
    COLLECT_RADIUS: 1.5,
    /** (spec) Distance at which a hazard is struck, units. */
    HAZARD_RADIUS: 1.2,
    /** (spec) Hazards per round. */
    HAZARD_COUNT: 3,
    /** (spec) Round length, seconds. */
    ROUND_SECONDS: 60,
    /** (spec) Seconds lost per hazard collision. */
    HAZARD_PENALTY: 5,
    /** (spec) Minimum seconds between sonar pings. */
    PING_COOLDOWN: 1.5,
    /**
     * (spec) Half-width of the "you are aimed at the target" window, degrees.
     * Wider is easier to find but gives a vaguer heading; narrower is a precise
     * bearing that is fiddly to hold while walking.
     */
    CENTRE_TOLERANCE: 5,

    /** Nothing spawns closer than this to the player, units. Keeps every hunt a real hunt. */
    MIN_SPAWN_DISTANCE: 6,
    /** Hazards are kept at least this far apart from each other and from the target, units. */
    MIN_ENTITY_SEPARATION: 4,
    /** The player cannot walk closer than this to a wall, units. Stops the listener sitting inside geometry. */
    WALL_MARGIN: 0.5,
    /** A hazard cannot be struck again until the player has left and re-entered its radius, units of hysteresis. */
    HAZARD_REARM_MARGIN: 0.6,
    /** Seconds remaining at which the "ten seconds left" warning fires. */
    WARNING_SECONDS: 10,
    /** Rejection-sampling attempts when placing an entity before falling back to a fixed ring. */
    SPAWN_ATTEMPTS: 64,
    /**
     * How far a sonar ping reaches, units. Half the arena, so a ping is a local snapshot
     * rather than a free map of everything. Raise it if playtesters feel lost.
     */
    PING_RADIUS: 20,
} as const;

/** Fixed simulation step. Decoupled from the display refresh rate so physics is deterministic. */
export const LOOP = {
    /** Seconds per simulation step (60 Hz). */
    FIXED_DT: 1 / 60,
    /** Longest real-time gap a single frame may simulate, seconds. Prevents a spiral of death after a tab stall. */
    MAX_FRAME_TIME: 0.25,
} as const;

/**
 * Audio engine parameters.
 *
 * `src/audio/` is a standalone module: these are the only numbers it reads, and it
 * reads nothing from `GAME`.
 */
export const AUDIO = {
    /** Master output level, 0..1. Headroom for several cues stacking at once. */
    MASTER_VOLUME_DEFAULT: 0.7,

    /**
     * Time constant for `setTargetAtTime`, seconds. (spec) Every per-frame parameter
     * change is smoothed with this instead of being assigned directly; at 60 Hz a direct
     * assignment produces audible zipper noise.
     * Larger = smoother but laggier panning; smaller = snappier but starts to buzz.
     */
    PARAM_SMOOTHING: 0.02,

    /** (spec) PannerNode settings. Shared by every positional source. */
    PANNER: {
        panningModel: "HRTF" as PanningModelType,
        distanceModel: "inverse" as DistanceModelType,
        refDistance: 1,
        maxDistance: 40,
        rolloffFactor: 1.4,
    },

    /**
     * (spec) HRTF panning is CPU-expensive. This caps concurrent PannerNodes; the pool
     * is allocated up front so no panner is ever constructed mid-round.
     */
    MAX_CONCURRENT_SOURCES: 8,

    /**
     * Distance -> lowpass cutoff, Hz. Air absorption analogue: far things are dull.
     * Interpolated logarithmically across 0..PANNER.maxDistance.
     */
    FILTER_NEAR_HZ: 18000,
    FILTER_FAR_HZ: 2600,

    /**
     * Rear shadowing. Generic HRTFs cause front/back reversals; real pinnae shadow high
     * frequencies from behind, so we imitate that. Angle 0 deg = dead ahead.
     * Interpolated logarithmically and never stepped.
     */
    REAR_FRONT_HZ: 18000,
    REAR_BEHIND_HZ: 2000,
    /**
     * Shapes where the shadowing bites. 1 = linear in (1-cos)/2, so half the effect is
     * already applied at 90 deg. Higher pushes the effect behind the 90 deg line, which is
     * where SPEC.md asks for it. Too high and the front/back difference becomes inaudible.
     */
    REAR_SHADOW_CURVE: 2,

    /** Q of the per-source lowpass. 1/sqrt(2) is maximally flat: a model, not an effect. */
    FILTER_Q: 0.7071,

    /** How far ahead of `currentTime` pulse envelopes are scheduled, seconds. */
    SCHEDULE_LOOKAHEAD: 0.12,
    /** Safety valve: most pulses one update may schedule. Guards against a runaway loop. */
    MAX_PULSES_PER_UPDATE: 32,

    /** Fade in/out when a pooled source is acquired or released, seconds. Short enough to feel instant. */
    VOICE_FADE: 0.01,
    /** Crossfade between a source's oscillator and its noise buffer, seconds. */
    TIMBRE_FADE: 0.005,

    /**
     * Fraction of the pulse period a single pulse may occupy. Above ~0.7 the pulses run
     * together and the rate stops reading as a rate; below ~0.3 a slow beacon feels sparse.
     */
    PULSE_DUTY: 0.6,
    /**
     * Pulse attack, seconds. Sharp onsets give the auditory system a clean interaural
     * time difference to work with, which is the strongest azimuth cue there is; a slow
     * fade-in blurs the onset and leaves only level differences to judge by.
     * Shorter = easier to localise but starts to click. Longer = a rounder tone that is
     * measurably harder to aim at.
     *
     * Note this does NOT help front/back discrimination on the beacon. Measured on a
     * 660 Hz sine, there is no energy above 2.5 kHz for the rear-shadowing lowpass to
     * remove (floor at -140 dB either way), so rear shadowing contributes 0 dB there.
     * It is worth 11 dB on the sawtooth hazard and 14 dB on the noise wall, which have
     * the harmonics to be shadowed. For the beacon, front/back is resolved by the
     * centre-lock tick and the pulse rate instead.
     */
    PULSE_ATTACK: 0.003,
    /** Attack is additionally capped at this fraction of the pulse, so short pulses stay clean. */
    PULSE_ATTACK_MAX_RATIO: 0.25,
    /** Fallback pulse length when a voice has no pulse map, seconds. */
    DEFAULT_PULSE_LENGTH: 0.12,
    /** A ping-forced pulse is capped this short so it reads as a reply, not a beat. */
    PULSE_ONCE_MAX_LENGTH: 0.1,
    /** Gap left after a ping-forced pulse before the normal train resumes, as a multiple of its length. */
    PULSE_ONCE_SPACING: 1.5,
    /**
     * How much louder a continuously-humming source gets when a ping reaches it, as a
     * multiple of its steady gain. Continuous voices cannot pulse from silence without
     * disappearing afterwards, so they swell instead.
     */
    PULSE_ONCE_BOOST: 2.2,
    /** Fraction of the accent spent swelling, the rest settling back. */
    PULSE_ONCE_BOOST_ATTACK_RATIO: 0.3,

    /** Guard band added after every one-shot cue before its nodes are torn down, seconds. */
    CUE_TAIL: 0.05,

    /** Length of the cached white-noise buffer, seconds. Long enough that the loop is not tonal. */
    NOISE_BUFFER_SECONDS: 2,

    /**
     * Target of every exponential fade-out. `exponentialRampToValueAtTime` cannot reach
     * zero, so fades land here instead: -80 dB, which is silence for any practical purpose.
     */
    SILENCE_FLOOR: 0.0001,
    /**
     * Frequency a pooled oscillator idles at before it has ever been assigned a voice.
     * Never heard — the envelope holds the source at zero until it is acquired — but an
     * oscillator has to be given something.
     */
    IDLE_OSC_FREQUENCY: 440,
} as const;

/**
 * Sound definitions. (spec) SPEC.md §6 fixes the frequencies and shapes; the gains and
 * envelope times are the parts to tune by ear.
 */
export const CUES = {
    /** The beacon. (spec) Sine, pulsed, 660 Hz. */
    TARGET: {
        frequency: 660,
        timbre: "sine" as const,
        /**
         * Source gain before distance attenuation.
         *
         * Capped by clipping, not by taste. The distance model holds the gain at 1.0 inside
         * refDistance and a generic HRTF adds roughly 1.5x on the near ear when a source is
         * off to one side, so anything above about 0.6 drives the output past full scale
         * when the player walks onto the beacon with the volume up. Measured, not guessed.
         */
        gain: 0.6,
        /**
         * Gentler than the shared AUDIO.PANNER.rolloffFactor of 1.4, which is what makes the
         * beacon audible from across the arena.
         *
         * Trades distance contrast for reach: at 1.4 the beacon spans 36 dB between
         * point-blank and the far wall, which sounds realistic and leaves it nearly inaudible
         * at 28 units. At 0.4 it is 4 to 6 dB louder everywhere you actually hunt, at the
         * cost of about 2 dB of the loudness-as-distance cue. Pulse rate carries proximity
         * anyway, which is what makes that trade affordable.
         *
         * Raise it back towards 1.4 if playtesters start walking straight past the beacon;
         * lower it further if they cannot find it at all.
         */
        rolloffFactor: 0.4,
        /** (spec) Pulse rate, pulses/sec, at PULSE_FAR_DISTANCE and at PULSE_NEAR_DISTANCE. */
        PULSE_RATE_FAR: 2,
        PULSE_RATE_NEAR: 8,
        PULSE_FAR_DISTANCE: 28,
        PULSE_NEAR_DISTANCE: 1.5,
        /** Longest a single pulse may last, seconds. Clamped shorter as the rate rises. */
        PULSE_LENGTH: 0.12,
    },

    /** Hazards. (spec) Sawtooth, continuous low hum, 110 Hz. */
    HAZARD: {
        frequency: 110,
        timbre: "sawtooth" as const,
        /** Deliberately below the target: a hazard should be noticed, not tracked. */
        gain: 0.55,
    },

    /** Walls. (spec) Filtered noise. Only the nearest wall is voiced, as a surf-like hiss. */
    WALL: {
        timbre: "noise" as const,
        gain: 0.5,
        /** Ceiling on the wall hiss cutoff, Hz. Distance and rear shadowing still apply below it. */
        maxCutoffHz: 1400,
        /** The wall is only audible inside this distance, units. Outside it the source is released. */
        AUDIBLE_DISTANCE: 5,
    },

    /** (spec) Sonar ping: filtered noise sweeping 300 -> 1200 Hz over 120 ms. */
    PING: {
        fromHz: 300,
        toHz: 1200,
        duration: 0.12,
        gain: 0.5,
        q: 4,
        attack: 0.008,
    },

    /** (spec) "You may collect this" — two-tone rising sine, 200 ms. */
    IN_RANGE: {
        tones: [880, 1320],
        duration: 0.2,
        gain: 0.35,
        attack: 0.01,
        overlap: 1.4,
    },

    /** (spec) Target collected — three-tone rising arpeggio, 300 ms. */
    COLLECT: {
        tones: [660, 880, 1320],
        duration: 0.3,
        gain: 0.4,
        attack: 0.01,
        overlap: 1.4,
    },

    /** (spec) Hazard struck — 80 Hz square burst, 250 ms. */
    COLLISION: {
        frequency: 80,
        duration: 0.25,
        gain: 0.5,
        attack: 0.005,
        /** A raw square at 80 Hz is mostly harmonics; this keeps it a thud, not a buzz. */
        lowpassHz: 600,
    },

    /**
     * (spec) Centre-lock tick: a short non-pitched click meaning "you are aimed correctly".
     * Deliberately noise, not a tone, so it cannot be confused with the beacon itself.
     */
    CENTRE_TICK: {
        duration: 0.014,
        filterHz: 3200,
        q: 1.2,
        /** Attack as a fraction of the tick. Keeps the click sharp without a DC thump. */
        attackRatio: 0.2,
        gain: 0.3,
        /** Rate limit, seconds. Below ~0.15 it machine-guns and stops reading as a discrete signal. */
        MIN_INTERVAL: 0.22,
    },

    /** Left/right headphone calibration tone used during onboarding. */
    CALIBRATION: {
        frequency: 440,
        duration: 0.7,
        gain: 0.35,
        attack: 0.02,
        release: 0.05,
    },
} as const;

/**
 * Self-voicing. (spec) The player may have no vision and no screen reader configured, so
 * the game reads itself aloud rather than relying on assistive technology being present.
 */
export const SPEECH = {
    LANG: "en-GB",
    /** 0.1..10. Above ~1.2 the game starts talking over its own cues. */
    RATE: 1.05,
    PITCH: 1,
    VOLUME: 1,
    /** Silence between consecutive announcements, seconds, so they do not run together. */
    GAP: 0.15,
    /**
     * The queue advances on the utterance's `end` event. Some browsers drop that event
     * after a cancel or a tab switch, which would wedge the queue forever, so a watchdog
     * estimates how long the line should take and moves on if the event never arrives.
     * Deliberately generous: cutting a real announcement short is worse than a late queue.
     */
    ESTIMATED_CHARS_PER_SECOND: 13,
    WATCHDOG_PADDING_SECONDS: 3,
} as const;

/** Player-facing settings. (spec) Exactly three, all keyboard-reachable and spoken. */
export const SETTINGS = {
    /** Master volume increment per key press. */
    VOLUME_STEP: 0.1,
} as const;

/**
 * Telemetry. (spec) Everything stays in the browser: no analytics service, no network
 * calls, nothing leaves the machine.
 */
export const TELEMETRY = {
    STORAGE_KEY: "reluminate-echo.sessions",
    /** Oldest rounds are dropped past this, so a long demo session cannot fill localStorage. */
    MAX_ROUNDS_STORED: 200,
    /**
     * How close the player must get before an approach counts as one worth measuring
     * overshoot on, as a multiple of the collect radius. Without this, wandering around
     * the far side of the arena would be logged as a wild overshoot.
     */
    OVERSHOOT_ARMING_RADIUS: 3,
} as const;

/**
 * The radar view. (spec) This is for sighted viewers watching the recording, not a
 * gameplay aid — the game has to be fully winnable with it hidden.
 */
export const RADAR = {
    /** Logical drawing size, px. The canvas is scaled up for high-density displays. */
    SIZE: 320,
    /** Padding between the canvas edge and the arena wall, px. */
    PADDING: 12,

    /** (spec) ReLuminate brand palette from SPEC.md §0. */
    COLOUR: {
        blue: "#2a5190",
        green: "#9cc383",
        coral: "#d95b52",
        grid: "#1b2a47",
        background: "#0b1220",
    },
    /** High-contrast substitutes, for players with some usable vision. */
    COLOUR_HIGH_CONTRAST: {
        blue: "#8ab4ff",
        green: "#b6ef97",
        coral: "#ff8a80",
        grid: "#ffffff",
        background: "#000000",
    },

    PLAYER_RADIUS: 5,
    TARGET_RADIUS: 6,
    HAZARD_RADIUS: 6,
    /** Half-angle of the heading cone, degrees. Matches nothing in the rules; it is a pointer. */
    CONE_HALF_ANGLE: 18,
    CONE_LENGTH: 34,
    /** Radar sweep rate, degrees/sec. Disabled entirely under prefers-reduced-motion. */
    SWEEP_SPEED: 90,
    LINE_WIDTH: 2,

    /** Gap between the beacon dot and its "in range" ring, px. */
    IN_RANGE_RING_GAP: 5,
    /** Opacities. The grid and sweep sit behind the entities and must not compete with them. */
    GRID_ALPHA: 0.5,
    SWEEP_ALPHA: 0.35,
    CONE_ALPHA: 0.45,
} as const;
