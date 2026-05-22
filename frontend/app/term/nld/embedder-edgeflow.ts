// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// EdgeFlowNldClassifier — main-thread proxy that talks to the worker
// hosting the fine-tuned shell-vs-NL ONNX model.  Per pending request
// we keep a deferred promise keyed by an incrementing id; the worker
// echoes the id back so we can resolve the right call when results
// return out of order.  Aborts are honored by rejecting the deferred
// locally — the worker keeps running but its result is discarded.

import { globalStore } from "@/app/store/jotaiStore";
import { embedderReadyAtom } from "./embedder";
import ClassifierWorker from "./embedder.worker?worker";
import type { NldClassifier } from "./types";

type Verdict = { pShell: number; pAI: number };

interface Pending {
    resolve: (v: Verdict | null) => void;
    reject: (err: Error) => void;
    onAbort: () => void;
}

export class EdgeFlowNldClassifier implements NldClassifier {
    private worker: Worker;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private initPromise: Promise<void>;
    private _ready = false;
    private disposed = false;

    constructor() {
        this.worker = new ClassifierWorker();
        this.worker.addEventListener("message", this.handleMessage);

        this.initPromise = new Promise<void>((resolve, reject) => {
            const id = this.nextId++;
            const onError = (err: Error) => reject(err);
            this.pending.set(id, {
                resolve: () => {
                    this._ready = true;
                    globalStore.set(embedderReadyAtom, true);
                    // eslint-disable-next-line no-console
                    console.info(
                        "[NLD] classifier ready —",
                        "fine-tuned multilingual MiniLM-L12 loaded, tier-2 will fire on next keystroke"
                    );
                    resolve();
                },
                reject: onError,
                onAbort: () => {
                    /* init is not abortable from the consumer */
                },
            });
            this.worker.postMessage({ id, type: "init" });
        });

        // Swallow init errors so we degrade to "not ready" rather than
        // throwing an unhandled rejection during module load.
        this.initPromise.catch((err) => {
            console.error("[NLD] classifier init failed:", err);
        });
    }

    get ready(): boolean {
        return this._ready && !this.disposed;
    }

    async classify(text: string, signal: AbortSignal): Promise<Verdict | null> {
        if (this.disposed) return null;
        if (!this._ready) {
            try {
                await this.initPromise;
            } catch {
                return null;
            }
            if (this.disposed) return null;
        }
        if (signal.aborted) return null;

        const id = this.nextId++;
        try {
            return await new Promise<Verdict | null>((resolve, reject) => {
                const onAbort = () => {
                    this.pending.delete(id);
                    resolve(null);
                };
                signal.addEventListener("abort", onAbort, { once: true });

                this.pending.set(id, {
                    resolve: (v) => {
                        signal.removeEventListener("abort", onAbort);
                        resolve(v);
                    },
                    reject: (err) => {
                        signal.removeEventListener("abort", onAbort);
                        reject(err);
                    },
                    onAbort,
                });
                this.worker.postMessage({ id, type: "classify", text });
            });
        } catch (err) {
            // Inference failure — treat as neutral so the composer can fall
            // back to tier-1.  Logged once at the call site rather than in
            // handleMessage so init failures don't masquerade as classify
            // failures.
            console.error("[NLD] classify failed:", err);
            return null;
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        globalStore.set(embedderReadyAtom, false);
        this.worker.removeEventListener("message", this.handleMessage);
        this.worker.terminate();
        for (const p of this.pending.values()) p.resolve(null);
        this.pending.clear();
    }

    private handleMessage = (event: MessageEvent): void => {
        const msg = event.data as
            | { id: number; type: "ready" }
            | { id: number; type: "verdict"; pShell: number; pAI: number }
            | { id: number; type: "error"; message: string };

        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);

        if (msg.type === "ready") {
            pending.resolve(null);
            return;
        }
        if (msg.type === "verdict") {
            pending.resolve({ pShell: msg.pShell, pAI: msg.pAI });
            return;
        }
        // Error — reject so init's catch sees the real failure (instead
        // of being fake-resolved as "ready") and classify's catch maps it
        // to a neutral null at the call site.
        pending.reject(new Error(msg.message));
    };
}

// Back-compat alias for in-flight rename.
export { EdgeFlowNldClassifier as EdgeFlowEmbedder };
