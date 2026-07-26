import { PiGuiComponentKind, type TUI } from "../tui.ts";
import { Text, type TextSnapshot } from "./text.ts";

export interface LoaderIndicatorOptions {
    /** Animation frames. Use an empty array to hide the indicator. */
    frames?: string[];
    /** Frame interval in milliseconds for animated indicators. */
    intervalMs?: number;
}

export interface LoaderSnapshot extends TextSnapshot {
    label: string;
    frame: string;
    cancellable: boolean;
    aborted?: boolean;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;

/**
 * Loader component that updates with an optional spinning animation.
 */
export class Loader extends Text {
    override readonly [PiGuiComponentKind]: PiGuiComponentKind = "loader";
    private frames = [...DEFAULT_FRAMES];
    private intervalMs = DEFAULT_INTERVAL_MS;
    private currentFrame = 0;
    private intervalId: NodeJS.Timeout | null = null;
    private running = false;
    private disposed = false;
    private ui: TUI | null = null;
    private renderIndicatorVerbatim = false;
    private spinnerColorFn: (str: string) => string;
    private messageColorFn: (str: string) => string;
    private message: string = "Loading...";

    constructor(
        ui: TUI,
        spinnerColorFn: (str: string) => string,
        messageColorFn: (str: string) => string,
        message: string = "Loading...",
        indicator?: LoaderIndicatorOptions
    ) {
        super("", 1, 0);
        this.ui = ui;
        this.spinnerColorFn = spinnerColorFn;
        this.messageColorFn = messageColorFn;
        this.message = message;
        this.setIndicator(indicator);
    }

    render(width: number): string[] {
        return ["", ...super.render(width)];
    }

    start(): void {
        if (this.running || this.disposed) {
            return;
        }
        this.running = true;
        this.updateDisplay();
        this.startAnimation();
    }

    stop(): void {
        this.running = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.running || this.intervalId) {
            this.stop();
        }
    }

    setMessage(message: string): void {
        this.message = message;
        this.updateDisplay();
    }

    getSnapshot(): LoaderSnapshot {
        return {
            ...super.getSnapshot(),
            label: this.message,
            frame: this.frames[this.currentFrame] ?? "",
            cancellable: false,
            aborted: undefined,
        };
    }

    setIndicator(indicator?: LoaderIndicatorOptions): void {
        this.renderIndicatorVerbatim = indicator !== undefined;
        this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
        const intervalMs = indicator?.intervalMs;
        this.intervalMs =
            intervalMs != null && Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
        this.currentFrame = 0;
        if (this.running) {
            this.stop();
        }
        this.start();
    }

    private startAnimation(): void {
        if (this.frames.length <= 1) {
            return;
        }
        this.intervalId = setInterval(() => {
            this.currentFrame = (this.currentFrame + 1) % this.frames.length;
            this.updateDisplay();
        }, this.intervalMs);
    }

    private updateDisplay(): void {
        const frame = this.frames[this.currentFrame] ?? "";
        const renderedFrame = this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
        const indicator = frame.length > 0 ? `${renderedFrame} ` : "";
        this.setText(`${indicator}${this.messageColorFn(this.message)}`);
        if (this.running && !this.disposed && this.ui) {
            this.ui.requestRender();
        }
    }
}
