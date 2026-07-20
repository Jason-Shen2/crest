import { getKeybindings } from "../keybindings.ts";
import { PiGuiComponentKind } from "../tui.ts";
import { Loader, type LoaderSnapshot } from "./loader.ts";

/**
 * Loader that can be cancelled with Escape.
 * Extends Loader with an AbortSignal for cancelling async operations.
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	override readonly [PiGuiComponentKind]: PiGuiComponentKind = "cancellableloader";
	private abortController = new AbortController();

	/** Called when user presses Escape */
	onAbort?: () => void;

	/** AbortSignal that is aborted when user presses Escape */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/** Whether the loader was aborted */
	get aborted(): boolean {
		return this.abortController.signal.aborted;
	}

	override getSnapshot(): LoaderSnapshot {
		return {
			...super.getSnapshot(),
			cancellable: true,
			aborted: this.aborted,
		};
	}

	cancel(): void {
		this.abortController.abort();
		this.onAbort?.();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
		}
	}

	dispose(): void {
		this.stop();
	}
}
