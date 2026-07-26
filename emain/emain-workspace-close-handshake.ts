// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

interface WorkspaceCloseSender {
    id: number;
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
    once(event: "destroyed", listener: () => void): void;
    removeListener(event: "destroyed", listener: () => void): void;
}

interface PendingWorkspaceClose {
    requestid: string;
    senderId: number;
    finish(allow: boolean): void;
    timeout: NodeJS.Timeout;
    destroyed: () => void;
}

interface PreparedWorkspaceClose {
    requestid: string;
    sender: WorkspaceCloseSender;
}

export class WorkspaceCloseHandshake {
    getCurrentSender: () => WorkspaceCloseSender;
    timeoutMs: number;
    pending: PendingWorkspaceClose;
    prepared: PreparedWorkspaceClose;

    constructor(getCurrentSender: () => WorkspaceCloseSender, timeoutMs = 30000) {
        this.getCurrentSender = getCurrentSender;
        this.timeoutMs = timeoutMs;
    }

    request(reason: WorkspaceCloseRequest["reason"]): Promise<boolean> {
        if (this.pending || this.prepared) {
            return Promise.resolve(false);
        }
        const sender = this.getCurrentSender();
        if (!sender || sender.isDestroyed()) {
            return Promise.resolve(false);
        }
        const requestid = crypto.randomUUID();
        return new Promise((resolve) => {
            let finalized = false;
            const finish = (allow: boolean) => {
                if (finalized) {
                    return;
                }
                finalized = true;
                const pending = this.pending;
                if (pending?.requestid === requestid) {
                    clearTimeout(pending.timeout);
                    sender.removeListener("destroyed", pending.destroyed);
                    this.pending = undefined;
                }
                if (allow) {
                    this.prepared = { requestid, sender };
                }
                resolve(allow);
            };
            const destroyed = () => finish(false);
            this.pending = {
                requestid,
                senderId: sender.id,
                finish,
                timeout: setTimeout(() => finish(false), this.timeoutMs),
                destroyed,
            };
            sender.once("destroyed", destroyed);
            try {
                sender.send("workspace-close-request", { requestid, reason });
            } catch {
                finish(false);
            }
        });
    }

    respond(senderId: number, response: WorkspaceCloseResponse): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }
        const currentSender = this.getCurrentSender();
        const senderMatches = pending.senderId === senderId && currentSender?.id === senderId;
        if (!response || typeof response !== "object" || typeof response.requestid !== "string") {
            if (senderMatches) {
                pending.finish(false);
            }
            return;
        }
        if (pending.requestid !== response.requestid) {
            return;
        }
        if (!senderMatches || typeof response.allow !== "boolean") {
            pending.finish(false);
            return;
        }
        pending.finish(response.allow === true);
    }

    finalize(commit: boolean): boolean {
        const prepared = this.prepared;
        if (!prepared) {
            return false;
        }
        this.prepared = undefined;
        const currentSender = this.getCurrentSender();
        if (prepared.sender.isDestroyed() || currentSender?.id !== prepared.sender.id) {
            return false;
        }
        try {
            prepared.sender.send("workspace-close-finalize", { requestid: prepared.requestid, commit });
            return true;
        } catch {
            return false;
        }
    }
}
