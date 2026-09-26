import { RADAR } from "../config";

/** What the radar needs to draw a frame. Read-only: the radar never touches the game. */
export interface RadarView {
    player: { x: number; y: number; heading: number };
    target: { x: number; y: number } | null;
    hazards: ReadonlyArray<{ x: number; y: number }>;
    arenaSize: number;
    inRange: boolean;
}

interface Palette {
    blue: string;
    green: string;
    coral: string;
    grid: string;
    background: string;
}

const DEG = Math.PI / 180;

/**
 * Top-down canvas view of the arena.
 *
 * (spec) This exists for sighted viewers watching the demo recording. It is NOT a
 * gameplay aid: nothing is drawn here that the player cannot hear, and the game has to
 * be fully winnable with the monitor switched off. Nothing in the game reads from the
 * radar, and the radar never writes to the game.
 *
 * Deliberately plain — circles, a heading cone and a sweep. Anything more elaborate
 * would cost frames that the audio thread would rather have.
 */
export class Radar {
    private readonly context: CanvasRenderingContext2D;
    private palette: Palette = RADAR.COLOUR;
    private reducedMotion: boolean;
    /** Sweep angle, degrees. Visual only — it is never used to schedule a sound. */
    private sweep = 0;
    private lastFrame: number | null = null;

    constructor(private readonly canvas: HTMLCanvasElement) {
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context unavailable");
        this.context = context;

        // (spec) Respect prefers-reduced-motion: with it set, the sweep simply does not turn.
        const query = window.matchMedia("(prefers-reduced-motion: reduce)");
        this.reducedMotion = query.matches;
        query.addEventListener("change", (event) => {
            this.reducedMotion = event.matches;
        });

        this.resize();
    }

    setHighContrast(high: boolean): void {
        this.palette = high ? RADAR.COLOUR_HIGH_CONTRAST : RADAR.COLOUR;
    }

    /** Matches the backing store to the display density so the lines are not soft. */
    resize(): void {
        const ratio = window.devicePixelRatio || 1;
        this.canvas.width = RADAR.SIZE * ratio;
        this.canvas.height = RADAR.SIZE * ratio;
        // Width only: the stylesheet caps it at the page width on a narrow phone, and
        // the height follows from the square backing store.
        this.canvas.style.width = `${RADAR.SIZE}px`;
        this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    /** Called once per rendered frame, after the simulation has stepped. */
    render(view: RadarView | null): void {
        const ctx = this.context;
        const size = RADAR.SIZE;

        ctx.fillStyle = this.palette.background;
        ctx.fillRect(0, 0, size, size);

        const inner = size - RADAR.PADDING * 2;
        this.drawArena(inner);
        if (!view) return;

        const scale = inner / view.arenaSize;
        const toPixels = (x: number, y: number): [number, number] => [
            size / 2 + x * scale,
            // Canvas y grows downward and the arena's y grows north, so the axis is flipped.
            size / 2 - y * scale,
        ];

        this.advanceSweep();
        if (!this.reducedMotion) this.drawSweep(inner);

        for (const hazard of view.hazards) {
            const [hx, hy] = toPixels(hazard.x, hazard.y);
            this.dot(hx, hy, RADAR.HAZARD_RADIUS, this.palette.coral);
        }

        if (view.target) {
            const [tx, ty] = toPixels(view.target.x, view.target.y);
            this.dot(tx, ty, RADAR.TARGET_RADIUS, this.palette.green);
            if (view.inRange)
                this.ring(
                    tx,
                    ty,
                    RADAR.TARGET_RADIUS + RADAR.IN_RANGE_RING_GAP,
                    this.palette.green
                );
        }

        const [px, py] = toPixels(view.player.x, view.player.y);
        this.drawCone(px, py, view.player.heading);
        this.dot(px, py, RADAR.PLAYER_RADIUS, this.palette.blue);
    }

    private drawArena(inner: number): void {
        const ctx = this.context;
        const offset = RADAR.PADDING;
        ctx.strokeStyle = this.palette.grid;
        ctx.lineWidth = RADAR.LINE_WIDTH;
        ctx.strokeRect(offset, offset, inner, inner);

        // A centre cross, so a viewer can read "the player has drifted north-east" at a glance.
        ctx.globalAlpha = RADAR.GRID_ALPHA;
        ctx.beginPath();
        ctx.moveTo(RADAR.SIZE / 2, offset);
        ctx.lineTo(RADAR.SIZE / 2, offset + inner);
        ctx.moveTo(offset, RADAR.SIZE / 2);
        ctx.lineTo(offset + inner, RADAR.SIZE / 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    private advanceSweep(): void {
        const now = performance.now();
        const previous = this.lastFrame ?? now;
        this.lastFrame = now;
        if (this.reducedMotion) return;
        this.sweep =
            (this.sweep + ((now - previous) / 1000) * RADAR.SWEEP_SPEED) % 360;
    }

    private drawSweep(inner: number): void {
        const ctx = this.context;
        const centre = RADAR.SIZE / 2;
        const radius = inner / 2;
        const angle = this.sweep * DEG;
        ctx.save();
        ctx.globalAlpha = RADAR.SWEEP_ALPHA;
        ctx.strokeStyle = this.palette.green;
        ctx.lineWidth = RADAR.LINE_WIDTH;
        ctx.beginPath();
        ctx.moveTo(centre, centre);
        ctx.lineTo(
            centre + Math.sin(angle) * radius,
            centre - Math.cos(angle) * radius
        );
        ctx.stroke();
        ctx.restore();
    }

    /** The direction the player is facing. Heading 0 is north, which is up on the canvas. */
    private drawCone(x: number, y: number, heading: number): void {
        const ctx = this.context;
        const half = RADAR.CONE_HALF_ANGLE * DEG;
        const length = RADAR.CONE_LENGTH;
        ctx.save();
        ctx.translate(x, y);
        // Canvas angles start at +x and grow clockwise; the arena's heading starts at north.
        ctx.rotate(heading - Math.PI / 2);
        ctx.globalAlpha = RADAR.CONE_ALPHA;
        ctx.fillStyle = this.palette.blue;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, length, -half, half);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    private dot(x: number, y: number, radius: number, colour: string): void {
        const ctx = this.context;
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    private ring(x: number, y: number, radius: number, colour: string): void {
        const ctx = this.context;
        ctx.strokeStyle = colour;
        ctx.lineWidth = RADAR.LINE_WIDTH;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
    }
}
