// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

interface QuitApp {
    quit(): void;
}

interface QuitWindow {
    requestWorkspaceClose(reason: "quit"): Promise<boolean>;
    finalizeWorkspaceClose?(commit: boolean): void | Promise<void>;
}

type QuitReason = "quit";

let applicationCloseCoordinator: EMainQuitCoordinator;

export function setApplicationCloseCoordinator(coordinator: EMainQuitCoordinator): void {
    applicationCloseCoordinator = coordinator;
}

export function guardApplicationClose(
    reason: QuitReason,
    action: () => void | Promise<void>,
    approveQuitReentry = false
): Promise<boolean> {
    if (!applicationCloseCoordinator) {
        return Promise.resolve(action()).then(() => true);
    }
    return applicationCloseCoordinator.guardAction(reason, action, approveQuitReentry);
}

export class EMainQuitCoordinator {
    app: QuitApp;
    getWindows: () => readonly QuitWindow[];
    approvedQuit = false;
    inflight: Promise<void>;
    guardInflight: Promise<boolean>;

    constructor(app: QuitApp, getWindows: () => readonly QuitWindow[]) {
        this.app = app;
        this.getWindows = getWindows;
    }

    beforeQuit(event: { preventDefault(): void }): boolean {
        if (this.approvedQuit) {
            this.approvedQuit = false;
            return true;
        }
        event.preventDefault();
        if (this.inflight) {
            return false;
        }
        this.inflight = this.requestQuit().finally(() => {
            this.inflight = undefined;
        });
        return false;
    }

    async requestQuit(): Promise<void> {
        await this.guardAction("quit", () => this.app.quit(), true);
    }

    async guardAction(
        reason: QuitReason,
        action: () => void | Promise<void>,
        approveQuitReentry = false
    ): Promise<boolean> {
        if (this.guardInflight) {
            return false;
        }
        this.guardInflight = this.runGuardedAction(reason, action, approveQuitReentry).finally(() => {
            this.guardInflight = undefined;
        });
        return this.guardInflight;
    }

    async runGuardedAction(
        reason: QuitReason,
        action: () => void | Promise<void>,
        approveQuitReentry: boolean
    ): Promise<boolean> {
        const windows = [...this.getWindows()];
        try {
            const results = await Promise.all(windows.map((window) => window.requestWorkspaceClose(reason)));
            if (!results.every(Boolean)) {
                await Promise.all(windows.map((window) => window.finalizeWorkspaceClose?.(false)));
                return false;
            }
            if (approveQuitReentry) {
                this.approvedQuit = true;
            }
            let actionResult: void | Promise<void>;
            try {
                actionResult = action();
            } finally {
                if (approveQuitReentry) {
                    this.approvedQuit = false;
                }
            }
            await actionResult;
            await Promise.all(windows.map((window) => window.finalizeWorkspaceClose?.(true)));
            return true;
        } catch {
            await Promise.allSettled(windows.map((window) => window.finalizeWorkspaceClose?.(false)));
            return false;
        }
    }
}
