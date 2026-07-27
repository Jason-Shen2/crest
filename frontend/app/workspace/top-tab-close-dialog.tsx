// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useSyncExternalStore } from "react";
import type { TopTabCloseDecision, TopTabCloseRequest } from "./top-tab-close-coordinator";

type PendingRequest = TopTabCloseRequest & { resolve(decision: TopTabCloseDecision): void };

export class TopTabCloseDialogController {
    queue: PendingRequest[] = [];
    listeners = new Set<() => void>();

    requestDecision(request: TopTabCloseRequest): Promise<TopTabCloseDecision> {
        return new Promise((resolve) => {
            this.queue.push({ ...request, resolve });
            this.emit();
        });
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): PendingRequest => this.queue[0];

    resolve(decision: TopTabCloseDecision): void {
        this.queue.shift()?.resolve(decision);
        this.emit();
    }

    cancelAll(): void {
        this.queue.splice(0).forEach((request) => request.resolve("cancel"));
        this.emit();
    }

    emit(): void {
        this.listeners.forEach((listener) => listener());
    }
}

export function TopTabCloseDialog({ controller }: { controller: TopTabCloseDialogController }) {
    const request = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    useEffect(() => () => controller.cancelAll(), [controller]);
    if (!request) {
        return null;
    }
    return (
        <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        >
            <div className="rounded bg-secondary p-4 shadow-xl">
                <p>Save changes to {request.title}?</p>
                <div className="mt-4 flex justify-end gap-2">
                    {(["cancel", "discard", "save"] as const).map((decision) => (
                        <button
                            key={decision}
                            type="button"
                            className="cursor-pointer rounded px-3 py-1 capitalize hover:bg-white/10"
                            onClick={() => controller.resolve(decision)}
                        >
                            {decision[0].toUpperCase() + decision.slice(1)}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
