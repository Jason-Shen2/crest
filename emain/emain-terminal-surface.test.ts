// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
    TerminalRendererKindMismatchError,
    TerminalSurfaceController,
    type TerminalSurfaceControllerDeps,
    type TerminalSurfaceView,
} from "./emain-terminal-surface";

function makeDeferred<T = void>() {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

type TestView = TerminalSurfaceView & { destroyed: boolean };

function makeView(tabId: string): TestView {
    return { terminalTabId: tabId, destroyed: false };
}

function makeHarness() {
    const identity = { workspaceId: "workspace-1", generation: 3 };
    const views = new Map<string, TestView>();
    const readiness = new Map<string, ReturnType<typeof makeDeferred>>();
    const calls: string[] = [];
    const statuses: TerminalSurfaceStatus[] = [];
    const deps: TerminalSurfaceControllerDeps = {
        getCurrentIdentity: () => identity,
        getView: (tabId) => views.get(tabId),
        createView: (tabId) => {
            const view = makeView(tabId);
            readiness.set(tabId, makeDeferred());
            calls.push(`create:${tabId}`);
            return view;
        },
        registerView: (view) => {
            views.set(view.terminalTabId, view);
            calls.push(`register:${view.terminalTabId}`);
        },
        disposeView: (view) => {
            if (views.get(view.terminalTabId) === view) {
                views.delete(view.terminalTabId);
            }
            (view as TestView).destroyed = true;
            calls.push(`dispose:${view.terminalTabId}`);
        },
        isTerminalView: () => true,
        initializeView: (view) => readiness.get(view.terminalTabId).promise,
        getViews: () => views.values(),
        showView: (view, bounds) => {
            if ((view as TestView).destroyed) {
                throw new Error("show after dispose");
            }
            calls.push(`show:${view.terminalTabId}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`);
        },
        hideView: (view) => calls.push(`hide:${view.terminalTabId}`),
        raiseView: (view) => calls.push(`raise:${view.terminalTabId}`),
        focusTerminal: (view) => {
            if ((view as TestView).destroyed) {
                throw new Error("focus after dispose");
            }
            calls.push(`focus-terminal:${view.terminalTabId}`);
        },
        focusWorkspace: () => calls.push("focus-workspace"),
        emitStatus: (status) => statuses.push(status),
    };
    const controller = new TerminalSurfaceController(deps);
    const terminal = (tabId: string, revision: number): WorkspaceSurfaceState => ({
        kind: "terminal",
        terminalTabId: tabId,
        workspaceId: identity.workspaceId,
        generation: identity.generation,
        revision,
        bounds: { x: 240, y: 72, width: 760, height: 680 },
    });
    const agent = (revision: number): WorkspaceSurfaceState => ({
        kind: "agent",
        workspaceId: identity.workspaceId,
        generation: identity.generation,
        revision,
        bounds: { x: 240, y: 72, width: 760, height: 680 },
    });
    return { agent, calls, controller, identity, readiness, statuses, terminal, views };
}

describe("TerminalSurfaceController", () => {
    it("keeps a cold Terminal offscreen until ready, then shows, raises, and focuses it", async () => {
        const harness = makeHarness();
        const activation = harness.controller.request(harness.terminal("terminal-a", 1));

        expect(harness.calls).toEqual(["create:terminal-a", "register:terminal-a", "hide:terminal-a"]);
        expect(harness.statuses.at(-1)).toMatchObject({
            state: "loading",
            terminaltabid: "terminal-a",
            revision: 1,
        });

        harness.readiness.get("terminal-a").resolve();
        await activation;

        expect(harness.calls).toEqual([
            "create:terminal-a",
            "register:terminal-a",
            "hide:terminal-a",
            "show:terminal-a:240,72,760,680",
            "raise:terminal-a",
            "focus-terminal:terminal-a",
        ]);
        expect(harness.statuses.at(-1)).toMatchObject({
            state: "ready",
            terminaltabid: "terminal-a",
            revision: 1,
        });
    });

    it("makes only the latest target visible across an A to B cold-init race", async () => {
        const harness = makeHarness();
        const activateA = harness.controller.request(harness.terminal("terminal-a", 1));
        const activateB = harness.controller.request(harness.terminal("terminal-b", 2));

        harness.readiness.get("terminal-a").resolve();
        await activateA;
        expect(harness.calls.some((call) => call.startsWith("show:terminal-a"))).toBe(false);

        harness.readiness.get("terminal-b").resolve();
        await activateB;
        expect(harness.calls.filter((call) => call.startsWith("show:"))).toEqual([
            "show:terminal-b:240,72,760,680",
        ]);
        expect(harness.calls.at(-1)).toBe("focus-terminal:terminal-b");
    });

    it("does not expose a cold Terminal when a newer resize arrives during initialization", async () => {
        const harness = makeHarness();
        const first = harness.controller.request(harness.terminal("terminal-a", 1));
        const resized = {
            ...harness.terminal("terminal-a", 2),
            bounds: { x: 300, y: 80, width: 640, height: 520 },
        };
        const second = harness.controller.request(resized);

        expect(harness.calls.filter((call) => call.startsWith("show:"))).toEqual([]);
        expect(harness.calls.filter((call) => call.startsWith("create:"))).toEqual(["create:terminal-a"]);

        harness.readiness.get("terminal-a").resolve();
        await Promise.all([first, second]);

        expect(harness.calls.filter((call) => call.startsWith("show:"))).toEqual([
            "show:terminal-a:300,80,640,520",
        ]);
        expect(harness.calls).not.toContain("dispose:terminal-a");
        expect(harness.statuses.at(-1)).toMatchObject({ state: "ready", revision: 2 });
    });

    it("contains asynchronous view creation failures and reports an actionable error", async () => {
        const harness = makeHarness();
        harness.controller = new TerminalSurfaceController({
            ...harness.controller.deps,
            createView: async () => {
                throw new Error("create failed");
            },
        });

        await expect(harness.controller.request(harness.terminal("terminal-a", 1))).resolves.toBeUndefined();

        expect(harness.calls.some((call) => call.startsWith("show:"))).toBe(false);
        expect(harness.statuses.at(-1)).toMatchObject({
            state: "error",
            terminaltabid: "terminal-a",
            revision: 1,
            message: "create failed",
        });
    });

    it("contains cold-init failure without covering Workspace content", async () => {
        const harness = makeHarness();
        const activation = harness.controller.request(harness.terminal("terminal-a", 1));
        harness.readiness.get("terminal-a").reject(new Error("renderer failed"));
        await activation;

        expect(harness.calls.some((call) => call.startsWith("show:"))).toBe(false);
        expect(harness.statuses.at(-1)).toMatchObject({
            state: "error",
            terminaltabid: "terminal-a",
            revision: 1,
            message: "renderer failed",
        });
    });

    it("retries initialization after a cold failure without recreating the view", async () => {
        const harness = makeHarness();
        const failed = harness.controller.request(harness.terminal("terminal-a", 1));
        harness.readiness.get("terminal-a").reject(new Error("renderer failed"));
        await failed;

        const retryReadiness = makeDeferred();
        harness.readiness.set("terminal-a", retryReadiness);
        const retried = harness.controller.request(harness.terminal("terminal-a", 2));
        expect(harness.calls.filter((call) => call.startsWith("create:"))).toEqual(["create:terminal-a"]);
        expect(harness.calls.filter((call) => call.startsWith("show:"))).toEqual([]);

        retryReadiness.resolve();
        await retried;
        expect(harness.calls.filter((call) => call.startsWith("show:"))).toEqual([
            "show:terminal-a:240,72,760,680",
        ]);
        expect(harness.statuses.at(-1)).toMatchObject({ state: "ready", revision: 2 });
    });

    it("hides every Terminal and focuses Workspace for Agent including zero-Terminal state", async () => {
        const harness = makeHarness();
        harness.views.set("terminal-a", makeView("terminal-a"));
        harness.views.set("terminal-b", makeView("terminal-b"));

        await harness.controller.request(harness.agent(1));

        expect(harness.calls).toEqual(["hide:terminal-a", "hide:terminal-b", "focus-workspace"]);
        expect(harness.statuses.at(-1)).toEqual({
            state: "idle",
            workspaceid: harness.identity.workspaceId,
            generation: harness.identity.generation,
            revision: 1,
        });

        const empty = makeHarness();
        await empty.controller.request(empty.agent(1));
        expect(empty.calls).toEqual(["focus-workspace"]);
    });

    it("warm reactivation reapplies bounds and explicitly focuses the Terminal", async () => {
        const harness = makeHarness();
        harness.views.set("terminal-a", makeView("terminal-a"));

        await harness.controller.request(harness.terminal("terminal-a", 1));

        expect(harness.calls).toEqual([
            "show:terminal-a:240,72,760,680",
            "raise:terminal-a",
            "focus-terminal:terminal-a",
        ]);
    });

    it("ignores stale identity and revision without moving or focusing views", async () => {
        const harness = makeHarness();
        await harness.controller.request(harness.agent(4));
        harness.calls.length = 0;

        await harness.controller.request({ ...harness.terminal("terminal-a", 5), workspaceId: "workspace-old" });
        await harness.controller.request({ ...harness.terminal("terminal-a", 5), generation: 2 });
        await harness.controller.request(harness.terminal("terminal-a", 4));

        expect(harness.calls).toEqual([]);
    });

    it("contains destroy during cold initialization", async () => {
        const harness = makeHarness();
        const activation = harness.controller.request(harness.terminal("terminal-a", 1));
        harness.controller.destroy();
        harness.readiness.get("terminal-a").resolve();
        await activation;

        expect(harness.calls.some((call) => call.startsWith("show:"))).toBe(false);
        expect(harness.calls.some((call) => call.startsWith("focus-terminal:"))).toBe(false);
        expect(harness.calls).toContain("dispose:terminal-a");
    });

    it("disposes a late cold creation after reset without unregistering a replacement", async () => {
        const harness = makeHarness();
        const creation = makeDeferred<TerminalSurfaceView>();
        harness.controller = new TerminalSurfaceController({
            ...harness.controller.deps,
            createView: () => creation.promise,
        });
        const activation = harness.controller.request(harness.terminal("terminal-a", 1));
        harness.controller.reset();
        const replacement = makeView("terminal-a");
        harness.views.set("terminal-a", replacement);

        creation.resolve(makeView("terminal-a"));
        await activation;

        expect(harness.views.get("terminal-a")).toBe(replacement);
        expect(harness.calls.filter((call) => call === "dispose:terminal-a")).toHaveLength(1);
        expect(harness.calls.some((call) => call === "register:terminal-a")).toBe(false);
    });

    it("disposes a late cold creation after destroy and never registers it", async () => {
        const harness = makeHarness();
        const creation = makeDeferred<TerminalSurfaceView>();
        harness.controller = new TerminalSurfaceController({
            ...harness.controller.deps,
            createView: () => creation.promise,
        });
        const activation = harness.controller.request(harness.terminal("terminal-a", 1));
        harness.controller.destroy();

        creation.resolve(makeView("terminal-a"));
        await activation;

        expect(harness.views.has("terminal-a")).toBe(false);
        expect(harness.calls.filter((call) => call === "dispose:terminal-a")).toHaveLength(1);
        expect(harness.calls.some((call) => call === "register:terminal-a")).toBe(false);
    });

    it("rejects a warm non-Terminal renderer without showing it", async () => {
        const harness = makeHarness();
        harness.views.set("terminal-a", makeView("terminal-a"));
        harness.controller = new TerminalSurfaceController({
            ...harness.controller.deps,
            isTerminalView: () => false,
        });

        await harness.controller.request(harness.terminal("terminal-a", 1));

        expect(harness.calls.some((call) => call.startsWith("show:"))).toBe(false);
        expect(harness.calls).toContain("dispose:terminal-a");
        expect(harness.statuses.at(-1)).toMatchObject({ state: "error", revision: 1 });
    });

    it("rejects a cold non-Terminal renderer after initialization without legacy fallback", async () => {
        const harness = makeHarness();
        harness.controller = new TerminalSurfaceController({
            ...harness.controller.deps,
            isTerminalView: () => false,
        });
        const activation = harness.controller.request(harness.terminal("terminal-a", 1));
        harness.readiness.get("terminal-a").resolve();
        await activation;

        expect(harness.calls.some((call) => call.startsWith("show:"))).toBe(false);
        expect(harness.calls).toContain("dispose:terminal-a");
        expect(harness.statuses.at(-1)).toMatchObject({
            state: "error",
            revision: 1,
            message: "renderer is not terminal",
        });
    });

    it("permanently disposes and unregisters a renderer-kind mismatch during initialization", async () => {
        const harness = makeHarness();
        let mismatchedView: TestView;
        harness.controller = new TerminalSurfaceController({
            ...harness.controller.deps,
            createView: (tabId) => {
                mismatchedView = makeView(tabId);
                harness.readiness.set(tabId, makeDeferred());
                return mismatchedView;
            },
            initializeView: async () => {
                throw new TerminalRendererKindMismatchError("legacy");
            },
        });

        await harness.controller.request(harness.terminal("terminal-a", 1));

        expect(mismatchedView.destroyed).toBe(true);
        expect(harness.views.has("terminal-a")).toBe(false);
        expect(harness.calls).toContain("dispose:terminal-a");
        expect(harness.statuses.at(-1)).toMatchObject({
            state: "error",
            message: "expected terminal renderer, received legacy",
        });
    });

    it.each(["resolve", "reject"] as const)(
        "isolates a replacement initialization from an old generation that later %ss",
        async (oldOutcome) => {
            const harness = makeHarness();
            const initializations = new Map<TestView, ReturnType<typeof makeDeferred>>();
            harness.controller = new TerminalSurfaceController({
                ...harness.controller.deps,
                initializeView: async (view) => {
                    const readiness = makeDeferred();
                    initializations.set(view as TestView, readiness);
                    harness.calls.push(`initialize:${view.terminalTabId}`);
                    return readiness.promise;
                },
            });

            const oldActivation = harness.controller.request(harness.terminal("terminal-a", 1));
            const oldView = harness.views.get("terminal-a");
            harness.controller.reset();
            harness.identity.generation = 4;
            harness.views.clear();

            const replacementActivation = harness.controller.request(harness.terminal("terminal-a", 1));
            const replacement = harness.views.get("terminal-a");
            expect(replacement).not.toBe(oldView);
            expect(harness.calls.filter((call) => call === "initialize:terminal-a")).toHaveLength(2);

            if (oldOutcome === "resolve") {
                initializations.get(oldView).resolve();
            } else {
                initializations.get(oldView).reject(new Error("old generation failed"));
            }
            await oldActivation;

            expect(oldView.destroyed).toBe(true);
            expect(replacement.destroyed).toBe(false);
            expect(harness.views.get("terminal-a")).toBe(replacement);

            const resizedActivation = harness.controller.request(harness.terminal("terminal-a", 2));
            expect(harness.calls.filter((call) => call === "initialize:terminal-a")).toHaveLength(2);

            initializations.get(replacement).resolve();
            await Promise.all([replacementActivation, resizedActivation]);
            expect(harness.calls.filter((call) => call.startsWith("show:"))).toEqual([
                "show:terminal-a:240,72,760,680",
            ]);
        }
    );

    it.each(["resolve", "mismatch"] as const)(
        "keeps an exact-view new owner isolated when the old owner later %ss",
        async (oldOutcome) => {
            const harness = makeHarness();
            const initializations: ReturnType<typeof makeDeferred>[] = [];
            harness.controller = new TerminalSurfaceController({
                ...harness.controller.deps,
                initializeView: async () => {
                    const readiness = makeDeferred();
                    initializations.push(readiness);
                    harness.calls.push("initialize:terminal-a");
                    return readiness.promise;
                },
            });

            const oldActivation = harness.controller.request(harness.terminal("terminal-a", 1));
            const sharedView = harness.views.get("terminal-a");
            harness.controller.reset();
            harness.identity.generation = 4;

            const replacementActivation = harness.controller.request(harness.terminal("terminal-a", 1));
            expect(harness.views.get("terminal-a")).toBe(sharedView);
            expect(initializations).toHaveLength(2);

            if (oldOutcome === "resolve") {
                initializations[0].resolve();
            } else {
                initializations[0].reject(new TerminalRendererKindMismatchError("legacy"));
            }
            await oldActivation;

            expect(sharedView.destroyed).toBe(false);
            expect(harness.calls.some((call) => call.startsWith("show:"))).toBe(false);
            const resizedActivation = harness.controller.request(harness.terminal("terminal-a", 2));
            expect(initializations).toHaveLength(2);
            expect(harness.calls.some((call) => call.startsWith("show:"))).toBe(false);

            initializations[1].resolve();
            await Promise.all([replacementActivation, resizedActivation]);
            expect(sharedView.destroyed).toBe(false);
            expect(harness.calls.filter((call) => call.startsWith("show:"))).toEqual([
                "show:terminal-a:240,72,760,680",
            ]);
        }
    );

    it.each(["resolve", "mismatch"] as const)(
        "preserves the current exact View when its new owner settles before the old owner %ss",
        async (oldOutcome) => {
            const harness = makeHarness();
            const initializations: ReturnType<typeof makeDeferred>[] = [];
            harness.controller = new TerminalSurfaceController({
                ...harness.controller.deps,
                initializeView: async () => {
                    const readiness = makeDeferred();
                    initializations.push(readiness);
                    return readiness.promise;
                },
            });

            const oldActivation = harness.controller.request(harness.terminal("terminal-a", 1));
            const sharedView = harness.views.get("terminal-a");
            harness.controller.reset();
            harness.identity.generation = 4;
            const currentActivation = harness.controller.request(harness.terminal("terminal-a", 1));

            initializations[1].resolve();
            await currentActivation;
            expect(harness.calls.filter((call) => call.startsWith("show:"))).toHaveLength(1);

            if (oldOutcome === "resolve") {
                initializations[0].resolve();
            } else {
                initializations[0].reject(new TerminalRendererKindMismatchError("legacy"));
            }
            await oldActivation;

            expect(sharedView.destroyed).toBe(false);
            expect(harness.views.get("terminal-a")).toBe(sharedView);
            expect(harness.calls).not.toContain("dispose:terminal-a");
            expect(harness.calls.filter((call) => call.startsWith("show:"))).toHaveLength(1);
        }
    );
});
