// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Model } from "../ai";
import type { AgentHarnessHost } from "./harness-factory";
import { createExtensionContext, createExtensionRuntime, createExtensionUiBridge } from "./extensions";
import {
    createExtensionLifecycleHost,
    getExtensionGraphForLifecycleRuntime,
    unregisterExtensionLifecycleHosts,
} from "./extensions/lifecycle";
import {
    buildPersistedTurnsFromSessionEntries,
    AgentSessionRuntime,
    ExtensionUiRequestTerminatedError,
} from "./agent-session-runtime";
import type { AgentMessage, ThinkingLevel } from "./types";
import type { SessionTreeEntry } from "./harness/types";
import { Input } from "./extensions/pi-gui/src/components/input";
import type { WidgetBoxNode, WidgetNode } from "./extensions/pi-gui/crest/widget-tree";

// Minimal harness double: records prompt/followUp/abort calls and lets a
// test drive the event stream via emit(). Mirrors the only surface
// AgentSessionRuntime touches.
function makeFakeHarness() {
    const listeners = new Set<(event: unknown) => void>();
    const calls = {
        prompt: [] as string[],
        followUp: [] as string[],
        followUpPreparations: [] as Array<() => Promise<void>>,
        custom: [] as unknown[],
        abort: 0,
        disposeAll: 0,
        disposeOwner: [] as string[],
        navigateTree: [] as unknown[],
    };
    let promptResult: () => Promise<unknown> = () => new Promise(() => {}); // pending forever by default
    let navigateTreeResult: () => Promise<unknown> = () => Promise.resolve({ cancelled: false });
    const session = {
        getEntries: vi.fn().mockResolvedValue([]),
        getBranch: vi.fn().mockResolvedValue([]),
        getLeafId: vi.fn().mockResolvedValue(null),
        getLabel: vi.fn().mockResolvedValue(undefined),
    };
    const model = {
        id: "model-1",
        name: "Model 1",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "http://localhost",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
    } as Model<any>;
    let currentModel = model;
    let thinkingLevel: ThinkingLevel = "off";
    const harness = {
        subscribe(listener: (event: unknown) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        prompt(text: string) {
            calls.prompt.push(text);
            return promptResult();
        },
        followUp(text: string, _options?: unknown, prepare?: () => Promise<void>) {
            calls.followUp.push(text);
            if (prepare) calls.followUpPreparations.push(prepare);
            if (calls.prompt.length === 0) return Promise.reject(new Error("followUp before prompt"));
            return Promise.resolve();
        },
        appendCustomEntry(customType: string, data?: unknown) {
            calls.custom.push({ customType, data });
            return Promise.resolve();
        },
        promptWithCustomEntry(customType: string, data: unknown, text: string) {
            calls.custom.push({ customType, data });
            calls.prompt.push(text);
            return promptResult();
        },
        abort() {
            calls.abort += 1;
            return Promise.resolve({});
        },
        navigateTree(targetId: string, options?: unknown) {
            calls.navigateTree.push({ targetId, options });
            return navigateTreeResult();
        },
        isIdle: vi.fn(() => true),
        getModel: vi.fn(() => currentModel),
        setModel: vi.fn(async (next: Model<any>) => {
            currentModel = next;
        }),
        getThinkingLevel: vi.fn(() => thinkingLevel),
        setThinkingLevel: vi.fn(async (next: ThinkingLevel) => {
            thinkingLevel = next;
        }),
    };
    return {
        calls,
        model,
        session,
        emit(event: unknown) {
            for (const l of listeners) l(event);
        },
        listenerCount: () => listeners.size,
        setPromptResult(fn: () => Promise<unknown>) {
            promptResult = fn;
        },
        setNavigateTreeResult(fn: () => Promise<unknown>) {
            navigateTreeResult = fn;
        },
        async prepareNextFollowUp() {
            await calls.followUpPreparations.shift()?.();
        },
        pane: {
            harness,
            session,
            extensions: [],
            extensionLifecycleOwnerId: "/s",
            extensionLifecycleHost: {
                disposeOwner: vi.fn().mockImplementation((ownerId: string) => {
                    calls.disposeOwner.push(ownerId);
                    return Promise.resolve();
                }),
                disposeAll: vi.fn().mockImplementation(() => {
                    calls.disposeAll += 1;
                    return Promise.resolve();
                }),
            },
            appendCustomEntry: harness.appendCustomEntry,
            promptWithCustomEntry: harness.promptWithCustomEntry,
            update: vi.fn(),
            setAuthResolver: vi.fn(),
            setToolCallHook: vi.fn(),
            resolveAuth: vi.fn(),
            runToolCallHook: vi.fn(),
        } as unknown as AgentHarnessHost,
    };
}

function user(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}
function assistant(text: string, stopReason?: string, errorMessage?: string): AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        ...(stopReason != null ? { stopReason } : {}),
        ...(errorMessage != null ? { errorMessage } : {}),
    } as unknown as AgentMessage;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AgentHarnessHost naming", () => {
    it("exports the session-scoped harness adapter without pane terminology", () => {
        const source = readFileSync(new URL("./harness-factory.ts", import.meta.url), "utf8");
        expect(source).toContain("export interface AgentHarnessHost");
        expect(source).not.toContain("export interface PaneHarness");
    });
});

describe("AgentSessionRuntime naming", () => {
    it("exports the session owner without pane terminology", () => {
        const source = readFileSync(new URL("./agent-session-runtime.ts", import.meta.url), "utf8");
        expect(source).toContain("export class AgentSessionRuntime");
        expect(source).not.toContain("export class PaneAgentSession");
        expect(source).not.toContain("pane: AgentHarnessHost");
        expect(source).not.toContain("this.pane");
    });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

afterEach(() => {
    unregisterExtensionLifecycleHosts();
});

describe("AgentSessionRuntime — owned transcript", () => {
    it("subscribes to the harness once at construction", () => {
        const fake = makeFakeHarness();
        new AgentSessionRuntime("/s", fake.pane);
        expect(fake.listenerCount()).toBe(1);
    });

    it("appends on message_start and replaces the tail on update/end", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        fake.emit({ type: "message_start", message: user("hi") });
        fake.emit({ type: "message_start", message: assistant("par") });
        fake.emit({ type: "message_update", message: assistant("partial") });
        fake.emit({ type: "message_end", message: assistant("final", "stop") });
        const { messages } = owner.getSessionState();
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe("user");
        expect((messages[1] as { content: { text: string }[] }).content[0].text).toBe("final");
    });

    it("seeds the transcript from persisted history (reopened session)", () => {
        const fake = makeFakeHarness();
        const history = [user("old q"), assistant("old a", "stop")];
        const owner = new AgentSessionRuntime("/s", fake.pane, history);
        expect(owner.getSessionState().messages).toBe(history);
    });

    it("does NOT clobber the accumulated transcript on agent_end (turn-scoped)", () => {
        // The bug: agent_end.messages carries only the CURRENT turn's
        // messages, not the whole conversation. Replacing on agent_end wiped
        // prior turns → their blocks went "…loading agent turn…". The owner
        // must keep the incrementally-built array.
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        fake.emit({ type: "message_start", message: user("q1") });
        fake.emit({ type: "message_start", message: assistant("a1") });
        fake.emit({ type: "message_end", message: assistant("a1", "stop") });
        // agent_end for turn 1 carries only turn-1 messages — fine, matches.
        fake.emit({ type: "agent_end", messages: [user("q1"), assistant("a1", "stop")] });
        expect(owner.getSessionState().messages).toHaveLength(2);
    });

    it("accumulates messages across multiple turns (turn-scoped agent_end ignored)", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        // Turn 1
        fake.emit({ type: "message_start", message: user("q1") });
        fake.emit({ type: "message_end", message: user("q1") });
        fake.emit({ type: "message_start", message: assistant("a1") });
        fake.emit({ type: "message_end", message: assistant("a1", "stop") });
        fake.emit({ type: "agent_end", messages: [user("q1"), assistant("a1", "stop")] });
        // Turn 2 — agent_end here is turn-scoped ([q2, a2]); must NOT drop q1/a1.
        fake.emit({ type: "message_start", message: user("q2") });
        fake.emit({ type: "message_end", message: user("q2") });
        fake.emit({ type: "message_start", message: assistant("a2") });
        fake.emit({ type: "message_end", message: assistant("a2", "stop") });
        fake.emit({ type: "agent_end", messages: [user("q2"), assistant("a2", "stop")] });
        const { messages } = owner.getSessionState();
        expect(messages).toHaveLength(4);
        expect((messages[0] as { content: { text: string }[] }).content[0].text).toBe("q1");
        expect((messages[2] as { content: { text: string }[] }).content[0].text).toBe("q2");
    });
});

describe("AgentSessionRuntime — command operations", () => {
    it("lists session tree entries through the session harness session", async () => {
        const fake = makeFakeHarness();
        const entry = { type: "message", id: "1", parentId: null, timestamp: "t", message: user("hello") };
        fake.session.getEntries.mockResolvedValue([entry]);
        fake.session.getLeafId.mockResolvedValue("1");
        fake.session.getLabel.mockResolvedValue("Intro");

        const owner = new AgentSessionRuntime("/s", fake.pane);
        const result = await owner.listTreeEntries();

        expect(result.entries).toEqual([entry]);
        expect(result.leafId).toBe("1");
        expect(result.labels.get("1")).toBe("Intro");
    });

    it("omits internal leaf entries from listed session tree entries", async () => {
        const fake = makeFakeHarness();
        const message = { type: "message", id: "1", parentId: null, timestamp: "t", message: user("hello") };
        const leaf = { type: "leaf", id: "leaf-entry", parentId: "1", timestamp: "t", targetId: "1" };
        fake.session.getEntries.mockResolvedValue([message, leaf]);
        fake.session.getLeafId.mockResolvedValue("1");

        const owner = new AgentSessionRuntime("/s", fake.pane);
        const result = await owner.listTreeEntries();

        expect(result.entries).toEqual([message]);
        expect(fake.session.getLabel).toHaveBeenCalledTimes(1);
        expect(fake.session.getLabel).toHaveBeenCalledWith("1");
    });

    it("hides structural entries and reparents through chains of hidden nodes", async () => {
        const fake = makeFakeHarness();
        const leafEntry = {
            type: "leaf" as const,
            id: "leaf-1",
            parentId: null,
            timestamp: "t0",
            targetId: "m2",
        };
        const labelEntry = {
            type: "label" as const,
            id: "label-1",
            parentId: "leaf-1",
            timestamp: "t0b",
            targetId: "m1",
            label: "Start",
        };
        const userMsg = { type: "message" as const, id: "m1", parentId: "label-1", timestamp: "t1", message: user("hi") };
        const asstMsg = { type: "message" as const, id: "m2", parentId: "m1", timestamp: "t2", message: assistant("hi") };
        fake.session.getEntries.mockResolvedValue([leafEntry, labelEntry, userMsg, asstMsg]);
        fake.session.getLeafId.mockResolvedValue("m2");

        const owner = new AgentSessionRuntime("/s", fake.pane);
        const result = await owner.listTreeEntries();

        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]).toEqual(expect.objectContaining({ id: "m1", parentId: null }));
        expect(result.entries[1]).toEqual(expect.objectContaining({ id: "m2", parentId: "m1" }));
    });

    it("passes custom entries through for renderer filter modes", async () => {
        const fake = makeFakeHarness();
        const customEntry = {
            type: "custom" as const,
            id: "custom-1",
            parentId: null,
            timestamp: "t0",
            customType: "session_note",
            data: { id: "stale" },
        };
        const userMsg = { type: "message" as const, id: "m1", parentId: "custom-1", timestamp: "t1", message: user("hi") };
        fake.session.getEntries.mockResolvedValue([customEntry, userMsg]);
        fake.session.getLeafId.mockResolvedValue("m1");

        const owner = new AgentSessionRuntime("/s", fake.pane);
        const result = await owner.listTreeEntries();

        expect(result.entries).toEqual([customEntry, userMsg]);
    });

    it("navigates the session tree without branch summarization", async () => {
        const fake = makeFakeHarness();
        fake.setNavigateTreeResult(() => Promise.resolve({ cancelled: false, editorText: "edit this" }));
        const owner = new AgentSessionRuntime("/s", fake.pane);

        const result = await owner.navigateTree("entry-1");

        expect(fake.calls.navigateTree).toEqual([{ targetId: "entry-1", options: { summarize: false } }]);
        expect(result).toEqual({ editorText: "edit this" });
    });

    it("rebuilds owner session state from the selected branch after tree navigation", async () => {
        const fake = makeFakeHarness();
        const oldMessages = [user("old question"), assistant("old answer", "stop")];
        const q = user("new question");
        const a = assistant("new answer", "stop");
        const branchEntries: SessionTreeEntry[] = [
            {
                type: "message",
                id: "m1",
                parentId: null,
                timestamp: "2026-01-01T00:00:01.000Z",
                message: q,
            },
            {
                type: "message",
                id: "m2",
                parentId: "m1",
                timestamp: "2026-01-01T00:00:02.000Z",
                message: a,
            },
        ];
        fake.session.getBranch.mockResolvedValue(branchEntries);
        const owner = new AgentSessionRuntime("/s", fake.pane, oldMessages);
        owner.setStatus("build", "Running");
        const seen: unknown[] = [];
        owner.subscribe((event) => seen.push(event));

        await owner.navigateTree("m2");

        expect(owner.getSessionState().messages).toEqual([q, a]);
        expect(owner.getSessionState().turns).toEqual([
            {
                turnId: "m1",
                userMessage: q,
                responseMessages: [a],
                status: "done",
            },
        ]);
        expect(seen).toContainEqual({
            type: "session_state",
            messages: [q, a],
            turns: [
                {
                    turnId: "m1",
                    userMessage: q,
                    responseMessages: [a],
                    status: "done",
                },
            ],
            status: "idle",
            steer: [],
            followUp: [],
            extensionUi: {
                statuses: { build: "Running" },
                widgets: {},
                widgetnodes: {},
            },
        });
    });

    it("shows history up to the parent when navigating to a user message (leaf = parentId)", async () => {
        // Scenario: m1(user)->a1(assistant)->m2(user)->a2(assistant). User clicks m2 in
        // the tree. Harness moves leaf to m2.parentId = a1, so getBranch() returns
        // [m1,a1] (NOT m2). The user entry m1 must produce turn(m1).
        const fake = makeFakeHarness();
        const m1 = user("first question");
        const a1 = assistant("first answer", "stop");
        const m2 = user("second question");
        const branchAfterNavigate: SessionTreeEntry[] = [
            { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: m1 },
            { type: "message", id: "a1", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: a1 },
        ];
        fake.session.getBranch.mockResolvedValue(branchAfterNavigate);
        const owner = new AgentSessionRuntime("/s", fake.pane);
        owner.subscribe(() => {});

        // navigateTree targetId=m2 (a user message); harness returns editorText and
        // has already moved leaf to a1.
        fake.setNavigateTreeResult(() => Promise.resolve({ cancelled: false, editorText: "second question" }));
        const result = await owner.navigateTree("m2");

        expect(result).toEqual({ editorText: "second question" });
        const state = owner.getSessionState();
        expect(state.messages).toEqual([m1, a1]);
        expect(state.turns).toEqual([
            { turnId: "m1", userMessage: m1, responseMessages: [a1], status: "done" },
        ]);
    });

    it("shows history including the target when navigating to the first user message (parentId=null fallback)", async () => {
        // Scenario: m1(user)->a1(assistant)->m2(user)->a2(assistant). User clicks m1
        // (the first message, parentId=null). Previously newLeafId=null produced an
        // empty branch hiding all messages. Fix: newLeafId = targetEntry.parentId ??
        // targetId falls back to m1 itself, so getBranch() returns [m1] and the
        // user entry m1 produces turn(m1) with empty responseMessages.
        const fake = makeFakeHarness();
        const m1 = user("first question");
        const branchAfterNavigate: SessionTreeEntry[] = [
            { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: m1 },
        ];
        fake.session.getBranch.mockResolvedValue(branchAfterNavigate);
        const owner = new AgentSessionRuntime("/s", fake.pane);
        owner.subscribe(() => {});

        fake.setNavigateTreeResult(() => Promise.resolve({ cancelled: false, editorText: "first question" }));
        const result = await owner.navigateTree("m1");

        expect(result).toEqual({ editorText: "first question" });
        const state = owner.getSessionState();
        expect(state.messages).toEqual([m1]);
        expect(state.turns).toEqual([
            { turnId: "m1", userMessage: m1, responseMessages: [], status: "done" },
        ]);
    });

    it("returns an empty navigation result when tree navigation is cancelled", async () => {
        const fake = makeFakeHarness();
        fake.setNavigateTreeResult(() => Promise.resolve({ cancelled: true }));
        const owner = new AgentSessionRuntime("/s", fake.pane);

        await expect(owner.navigateTree("entry-1")).resolves.toEqual({});
    });

    it("reads the active leaf id from the session harness session", async () => {
        const fake = makeFakeHarness();
        fake.session.getLeafId.mockResolvedValue("leaf-1");
        const owner = new AgentSessionRuntime("/s", fake.pane);

        await expect(owner.getLeafId()).resolves.toBe("leaf-1");
    });
});

describe("AgentSessionRuntime — owned turns", () => {
    it("builds a completed turn keyed by the user entry id", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const q = user("hello");
        const partial = assistant("hel");
        const final = assistant("hello back", "stop");

        void owner.send("hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_end", message: q, entryId: "e-a" });
        fake.emit({ type: "message_start", message: partial });
        fake.emit({ type: "message_end", message: final });
        fake.emit({ type: "agent_end", messages: [q, final] });

        expect(owner.getSessionState().turns).toEqual([
            {
                turnId: "e-a",
                userMessage: q,
                responseMessages: [final],
                status: "done",
            },
        ]);
    });

    it("resolves send() with the user entry id from the message_end event", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const q = user("hello");

        const sendPromise = owner.send("hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_end", message: q, entryId: "e-a" });

        await expect(sendPromise).resolves.toBe("e-a");
    });

    it("rejects a pending send() promise on abort (queued followUp never commits)", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);

        const sendPromise = owner.send("hello");
        // No user message_end arrives; the user aborts. abort() clears the
        // harness followUpQueue, so the entryId will never come — the promise
        // must reject rather than hang forever.
        fake.emit({ type: "abort", clearedSteer: [], clearedFollowUp: [] });

        await expect(sendPromise).rejects.toThrow(/aborted/);
        // The resolver queue must be drained so the NEXT send isn't
        // mis-resolved by a stale head.
        const next = owner.send("again");
        fake.emit({ type: "message_start", message: user("again") });
        fake.emit({ type: "message_end", message: user("again"), entryId: "e-next" });
        await expect(next).resolves.toBe("e-next");
    });

    it("rejects a pending send() promise on dispose()", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);

        const sendPromise = owner.send("hello");
        owner.dispose();

        await expect(sendPromise).rejects.toThrow(/disposed/);
    });

    it("calls harness.prompt directly without inserting a turn-boundary custom entry", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);

        void owner.send("hello");
        await flush();

        expect(fake.calls.custom).toEqual([]);
        expect(fake.calls.prompt).toEqual(["hello"]);
    });

    it("marks the active turn errored from an errored assistant message", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const q = user("hello");
        const final = assistant("", "error", "rate limited");

        void owner.send("hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_end", message: q, entryId: "e-err" });
        fake.emit({ type: "message_start", message: assistant("") });
        fake.emit({ type: "message_end", message: final });

        expect(owner.getSessionState().turns).toEqual([
            {
                turnId: "e-err",
                userMessage: q,
                responseMessages: [final],
                status: "error",
                errorMessage: "rate limited",
            },
        ]);
    });

    it("calls onTurnFinished with the completed turn after agent_end", () => {
        const fake = makeFakeHarness();
        const onTurnFinished = vi.fn();
        const owner = new AgentSessionRuntime("/s", fake.pane, [], [], { onTurnFinished });
        const q = user("hello");
        const final = assistant("hello back", "stop");

        void owner.send("hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_end", message: q, entryId: "e-a" });
        fake.emit({ type: "message_start", message: assistant("hel") });
        fake.emit({ type: "message_end", message: final });
        fake.emit({ type: "agent_end", messages: [q, final] });

        expect(onTurnFinished).toHaveBeenCalledWith({
            turnId: "e-a",
            userMessage: q,
            responseMessages: [final],
            status: "done",
        });
    });

    it("updates a completed turn change outline and notifies subscribers", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const seen: string[] = [];
        owner.subscribe((event) => seen.push(event.type));

        void owner.send("hello");
        fake.emit({ type: "message_start", message: user("hello") });
        fake.emit({ type: "message_end", message: user("hello"), entryId: "e-a" });
        fake.emit({ type: "message_start", message: assistant("hello back") });
        fake.emit({ type: "message_end", message: assistant("hello back", "stop") });
        fake.emit({ type: "agent_end", messages: [] });
        owner.setTurnChangeOutline("e-a", {
            modules: [{ id: "ui", title: "UI changes", files: [{ path: "src/app.ts" }] }],
        });

        expect(owner.getSessionState().turns[0].changeOutline).toEqual({
            modules: [{ id: "ui", title: "UI changes", files: [{ path: "src/app.ts" }] }],
        });
        expect(seen).toContain("agent_turn_update");
    });
});

describe("buildPersistedTurnsFromSessionEntries", () => {
    it("opens one turn per user entry, keyed by the user entry id", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const q2 = user("q2");
        const a2 = assistant("a2", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "m1", parentId: null, timestamp: "t1", message: q1 },
            { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: a1 },
            { type: "message", id: "m3", parentId: "m2", timestamp: "t3", message: q2 },
            { type: "message", id: "m4", parentId: "m3", timestamp: "t4", message: a2 },
        ];

        const turns = buildPersistedTurnsFromSessionEntries(entries);

        expect(turns).toEqual([
            { turnId: "m1", userMessage: q1, responseMessages: [a1], status: "done" },
            { turnId: "m3", userMessage: q2, responseMessages: [a2], status: "done" },
        ]);
    });

    it("returns no turns for an empty branch", () => {
        expect(buildPersistedTurnsFromSessionEntries([])).toEqual([]);
    });

    it("opens a turn for every user entry from the start of the branch", () => {
        const preQ = user("hi");
        const preA = assistant("hello", "stop");
        const q1 = user("real");
        const a1 = assistant("answer", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "e0", parentId: null, timestamp: "t0", message: preQ },
            { type: "message", id: "e1", parentId: "e0", timestamp: "t1", message: preA },
            { type: "message", id: "e2", parentId: "e1", timestamp: "t2", message: q1 },
            { type: "message", id: "e3", parentId: "e2", timestamp: "t3", message: a1 },
        ];

        const turns = buildPersistedTurnsFromSessionEntries(entries);

        expect(turns).toEqual([
            { turnId: "e0", userMessage: preQ, responseMessages: [preA], status: "done" },
            { turnId: "e2", userMessage: q1, responseMessages: [a1], status: "done" },
        ]);
    });

    it("ignores non-message (custom) entries", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const entries: SessionTreeEntry[] = [
            {
                type: "custom",
                id: "custom-1",
                parentId: null,
                timestamp: "t0",
                customType: "session_note",
                data: { id: "stale" },
            },
            { type: "message", id: "m1", parentId: "custom-1", timestamp: "t1", message: q1 },
            { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: a1 },
        ];

        const turns = buildPersistedTurnsFromSessionEntries(entries);

        expect(turns).toEqual([
            { turnId: "m1", userMessage: q1, responseMessages: [a1], status: "done" },
        ]);
    });

    it("creates a turn with empty responseMessages for a user message without a reply", () => {
        // After navigating to the first user message (parentId=null → leaf falls
        // back to the target entry), the branch contains just that user message
        // with no assistant reply yet. The turn should still be created so the
        // agent block is visible.
        const q1 = user("first question");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "e1", parentId: null, timestamp: "t1", message: q1 },
        ];

        const turns = buildPersistedTurnsFromSessionEntries(entries);

        expect(turns).toEqual([
            { turnId: "e1", userMessage: q1, responseMessages: [], status: "done" },
        ]);
    });
});

describe("AgentSessionRuntime — status tracking", () => {
    it("reports running from the Harness lifecycle", () => {
        const fake = makeFakeHarness();
        vi.mocked(fake.pane.harness.isIdle).mockReturnValue(false);
        const owner = new AgentSessionRuntime("/s", fake.pane);

        expect(owner.isRunning()).toBe(true);
    });

    it("goes streaming on agent_start and idle on agent_end", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        expect(owner.getSessionState().status).toBe("idle");
        fake.emit({ type: "agent_start" });
        expect(owner.getSessionState().status).toBe("streaming");
        fake.emit({ type: "agent_end", messages: [] });
        expect(owner.getSessionState().status).toBe("idle");
    });

    it("captures an errored assistant turn and keeps status=error through agent_end", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        fake.emit({ type: "agent_start" });
        fake.emit({ type: "message_start", message: assistant("") });
        fake.emit({ type: "message_end", message: assistant("", "error", "rate limited") });
        let state = owner.getSessionState();
        expect(state.status).toBe("error");
        expect(state.errorMessage).toBe("rate limited");
        // agent_end must not paper over the error with idle.
        fake.emit({ type: "agent_end", messages: [assistant("", "error", "rate limited")] });
        state = owner.getSessionState();
        expect(state.status).toBe("error");
    });
});

describe("AgentSessionRuntime — execution config", () => {
    it("applies changed execution config before sending", async () => {
        const fake = makeFakeHarness();
        const runtime = new AgentSessionRuntime("/s", fake.pane);
        const nextModel = { ...fake.model, id: "next-model" };
        const authResolver = vi.fn();
        const toolCallHook = vi.fn();
        const send = vi.spyOn(runtime, "send").mockResolvedValue("entry-1");

        await runtime.sendWithExecutionConfig("hello", {
            promptInputs: { cwd: "/next" },
            model: nextModel,
            thinkingLevel: "high",
            authResolver,
            toolCallHook,
        });

        expect(fake.pane.update).toHaveBeenCalledWith({ cwd: "/next" });
        expect(fake.pane.setAuthResolver).toHaveBeenCalledWith(authResolver);
        expect(fake.pane.setToolCallHook).toHaveBeenCalledWith(toolCallHook);
        expect(fake.pane.harness.setModel).toHaveBeenCalledWith(nextModel);
        expect(fake.pane.harness.setThinkingLevel).toHaveBeenCalledWith("high");
        expect(send).toHaveBeenCalledWith("hello");
    });

    it("serializes config application with each send", async () => {
        const fake = makeFakeHarness();
        const runtime = new AgentSessionRuntime("/s", fake.pane);
        const seenModels: string[] = [];
        vi.spyOn(runtime, "send").mockImplementation(async (text) => {
            seenModels.push(fake.pane.harness.getModel().id);
            return text;
        });

        const first = runtime.sendWithExecutionConfig("entry-1", {
            promptInputs: { cwd: "/one" },
            model: { ...fake.model, id: "model-2" },
            thinkingLevel: "low",
        });
        const second = runtime.sendWithExecutionConfig("entry-2", {
            promptInputs: { cwd: "/two" },
            model: { ...fake.model, id: "model-3" },
            thinkingLevel: "high",
        });

        await expect(Promise.all([first, second])).resolves.toEqual(["entry-1", "entry-2"]);
        expect(seenModels).toEqual(["model-2", "model-3"]);
    });

    it("defers a queued follow-up config until that follow-up is activated", async () => {
        const fake = makeFakeHarness();
        const runtime = new AgentSessionRuntime("/s", fake.pane);
        const firstAuth = vi.fn();
        const secondAuth = vi.fn();
        const secondHook = vi.fn();
        const nextModel = { ...fake.model, id: "model-2" };

        const first = runtime.sendWithExecutionConfig("first", {
            promptInputs: { cwd: "/one" },
            model: fake.model,
            thinkingLevel: "off",
            authResolver: firstAuth,
        });
        await flush();
        fake.emit({ type: "message_end", message: user("first"), entryId: "entry-1" });
        await expect(first).resolves.toBe("entry-1");

        const second = runtime.sendWithExecutionConfig("second", {
            promptInputs: { cwd: "/two" },
            model: nextModel,
            thinkingLevel: "high",
            authResolver: secondAuth,
            toolCallHook: secondHook,
        });
        await flush();

        expect(fake.calls.followUp).toEqual(["second"]);
        expect(fake.pane.harness.setModel).not.toHaveBeenCalledWith(nextModel);
        expect(fake.pane.setAuthResolver).not.toHaveBeenCalledWith(secondAuth);
        expect(fake.pane.setToolCallHook).not.toHaveBeenCalledWith(secondHook);

        await fake.prepareNextFollowUp();

        expect(fake.pane.update).toHaveBeenLastCalledWith({ cwd: "/two" });
        expect(fake.pane.harness.setModel).toHaveBeenCalledWith(nextModel);
        expect(fake.pane.harness.setThinkingLevel).toHaveBeenCalledWith("high");
        expect(fake.pane.setAuthResolver).toHaveBeenCalledWith(secondAuth);
        expect(fake.pane.setToolCallHook).toHaveBeenCalledWith(secondHook);

        fake.emit({ type: "message_end", message: user("second"), entryId: "entry-2" });
        await expect(second).resolves.toBe("entry-2");
    });
});

describe("AgentSessionRuntime — queue mirror", () => {
    it("mirrors the steer/followUp queues from queue_update", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        fake.emit({ type: "queue_update", steer: [user("s1")], followUp: [user("f1"), user("f2")] });
        const state = owner.getSessionState();
        expect(state.steerQueue).toHaveLength(1);
        expect(state.followUpQueue).toHaveLength(2);
    });
});

describe("AgentSessionRuntime — extension UI snapshot", () => {
    it("owns extension UI mutations and returns isolated snapshot copies", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const semanticWidget: WidgetNode = {
            kind: "box",
            id: "result",
            paddingx: 0,
            paddingy: 0,
            children: [{ kind: "terminal", id: "output", lines: ["done"] }],
        };
        const header: WidgetNode = {
            kind: "box",
            id: "header",
            paddingx: 0,
            paddingy: 0,
            children: [{ kind: "text", id: "header-text", text: "Header", paddingx: 0, paddingy: 0 }],
        };
        const footer: WidgetNode = {
            kind: "box",
            id: "footer",
            paddingx: 0,
            paddingy: 0,
            children: [{ kind: "text", id: "footer-text", text: "Footer", paddingx: 0, paddingy: 0 }],
        };

        owner.setStatus("build", "Running");
        owner.setWidget("result", ["line one"]);
        owner.setWidget("result", semanticWidget);
        owner.setHeader(header);
        owner.setFooter(footer);
        (semanticWidget.children[0] as Extract<WidgetNode, { kind: "terminal" }>).lines[0] = "write-corrupted";
        (header.children[0] as Extract<WidgetNode, { kind: "text" }>).text = "write-corrupted";
        (footer.children[0] as Extract<WidgetNode, { kind: "text" }>).text = "write-corrupted";

        expect(owner.getSessionState().extensionUi).toEqual({
            statuses: { build: "Running" },
            widgets: {},
            widgetnodes: {
                result: {
                    kind: "box",
                    id: "result",
                    paddingx: 0,
                    paddingy: 0,
                    children: [{ kind: "terminal", id: "output", lines: ["done"] }],
                },
            },
            header: {
                kind: "box",
                id: "header",
                paddingx: 0,
                paddingy: 0,
                children: [{ kind: "text", id: "header-text", text: "Header", paddingx: 0, paddingy: 0 }],
            },
            footer: {
                kind: "box",
                id: "footer",
                paddingx: 0,
                paddingy: 0,
                children: [{ kind: "text", id: "footer-text", text: "Footer", paddingx: 0, paddingy: 0 }],
            },
        });

        const first = owner.getSessionState();
        first.extensionUi.statuses.build = "corrupted";
        const firstWidget = first.extensionUi.widgetnodes.result as WidgetBoxNode;
        (firstWidget.children[0] as Extract<WidgetNode, { kind: "terminal" }>).lines[0] = "read-corrupted";
        const firstHeader = first.extensionUi.header as WidgetBoxNode;
        (firstHeader.children[0] as Extract<WidgetNode, { kind: "text" }>).text = "read-corrupted";
        const firstFooter = first.extensionUi.footer as WidgetBoxNode;
        (firstFooter.children[0] as Extract<WidgetNode, { kind: "text" }>).text = "read-corrupted";

        expect(owner.getSessionState().extensionUi.statuses.build).toBe("Running");
        const next = owner.getSessionState().extensionUi;
        expect((next.widgetnodes.result as WidgetBoxNode).children[0]).toMatchObject({
            lines: ["done"],
        });
        expect((next.header as WidgetBoxNode).children[0]).toMatchObject({ text: "Header" });
        expect((next.footer as WidgetBoxNode).children[0]).toMatchObject({ text: "Footer" });
    });

    it("deep-clones nested widget nodes from initial and reload snapshots", () => {
        const fake = makeFakeHarness();
        const initialWidget: WidgetNode = {
            kind: "richtable",
            id: "table",
            columns: [{ key: "status", label: "Status" }],
            rows: [{ status: "ready" }],
        };
        const owner = new AgentSessionRuntime("/s", fake.pane, [], [], {
            initialExtensionUi: {
                statuses: {},
                widgets: {},
                widgetnodes: { table: initialWidget },
                header: initialWidget,
                footer: initialWidget,
            },
        });

        initialWidget.columns[0].label = "write-corrupted";
        initialWidget.rows[0].status = "write-corrupted";
        const reloadState = owner.getReloadState();
        const reloadWidget = reloadState.ui.widgetnodes.table as Extract<WidgetNode, { kind: "richtable" }>;
        reloadWidget.columns[0].label = "read-corrupted";
        reloadWidget.rows[0].status = "read-corrupted";
        const reloadHeader = reloadState.ui.header as Extract<WidgetNode, { kind: "richtable" }>;
        reloadHeader.rows[0].status = "read-corrupted";
        const reloadFooter = reloadState.ui.footer as Extract<WidgetNode, { kind: "richtable" }>;
        reloadFooter.rows[0].status = "read-corrupted";

        expect(owner.getReloadState().ui).toEqual({
            statuses: {},
            widgets: {},
            widgetnodes: {
                table: {
                    kind: "richtable",
                    id: "table",
                    columns: [{ key: "status", label: "Status" }],
                    rows: [{ status: "ready" }],
                },
            },
            header: {
                kind: "richtable",
                id: "table",
                columns: [{ key: "status", label: "Status" }],
                rows: [{ status: "ready" }],
            },
            footer: {
                kind: "richtable",
                id: "table",
                columns: [{ key: "status", label: "Status" }],
                rows: [{ status: "ready" }],
            },
        });
    });

    it("clears recoverable UI values", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const widget: WidgetNode = { kind: "terminal", id: "result", lines: ["done"] };

        owner.setStatus("build", "Running");
        owner.setWidget("result", widget);
        owner.setHeader(widget);
        owner.setFooter(widget);
        owner.setStatus("build", undefined);
        owner.setWidget("result", undefined);
        owner.setHeader(undefined);
        owner.setFooter(undefined);

        expect(owner.getSessionState().extensionUi).toEqual({
            statuses: {},
            widgets: {},
            widgetnodes: {},
            header: undefined,
            footer: undefined,
        });
    });

    it("updates the owner snapshot before emitting extension UI deltas", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        let statusAtCallback: string | undefined;
        owner.subscribe((event) => {
            if (event.type === "ext_ui_status") {
                statusAtCallback = owner.getSessionState().extensionUi.statuses[event.key];
            }
        });

        owner.setStatus("build", "Running");

        expect(statusAtCallback).toBe("Running");
    });

    it("seeds isolated UI state and restores only registered type-compatible flags", () => {
        const fake = makeFakeHarness();
        const runtime = createExtensionRuntime();
        runtime.flagValues.set("enabled", false);
        runtime.flagValues.set("label", "default");
        runtime.flagValues.set("disabled", true);
        runtime.flagValues.set("empty", "default");
        fake.pane = {
            ...fake.pane,
            extensions: [
                {
                    flags: new Map([
                        ["enabled", { name: "enabled", extensionPath: "/ext.ts", type: "boolean" }],
                        ["label", { name: "label", extensionPath: "/ext.ts", type: "string" }],
                        ["disabled", { name: "disabled", extensionPath: "/ext.ts", type: "boolean" }],
                        ["empty", { name: "empty", extensionPath: "/ext.ts", type: "string" }],
                    ]),
                },
            ],
            extensionRuntime: runtime,
        } as unknown as AgentHarnessHost;
        const initialUi = {
            statuses: { build: "Running" },
            widgets: { output: ["line one"] },
            widgetnodes: {},
        };
        const owner = new AgentSessionRuntime("/s", fake.pane, [], [], {
            initialExtensionUi: initialUi,
            initialFlagValues: {
                enabled: true,
                label: false,
                disabled: false,
                empty: "",
                removed: "stale",
            },
        });

        initialUi.statuses.build = "corrupted";
        initialUi.widgets.output[0] = "corrupted";
        const reloadState = owner.getReloadState();
        reloadState.ui.statuses.build = "corrupted again";
        reloadState.ui.widgets.output[0] = "corrupted again";
        reloadState.flags.enabled = false;

        expect(owner.getSessionState().extensionUi).toEqual({
            statuses: { build: "Running" },
            widgets: { output: ["line one"] },
            widgetnodes: {},
        });
        expect(owner.getFlagValue("enabled")).toBe(true);
        expect(owner.getFlagValue("label")).toBe("default");
        expect(owner.getFlagValue("disabled")).toBe(false);
        expect(owner.getFlagValue("empty")).toBe("");
        expect(owner.getFlagValue("removed")).toBeUndefined();
        expect(owner.getReloadState()).toEqual({
            ui: {
                statuses: { build: "Running" },
                widgets: { output: ["line one"] },
                widgetnodes: {},
            },
            flags: { enabled: true, label: "default", disabled: false, empty: "" },
        });
    });

    it("restores duplicate reload flags using the first registration only", () => {
        const fake = makeFakeHarness();
        const runtime = createExtensionRuntime();
        runtime.flagValues.set("duplicate", true);
        fake.pane = {
            ...fake.pane,
            extensions: [
                {
                    flags: new Map([
                        ["duplicate", { name: "duplicate", extensionPath: "/first.ts", type: "boolean" }],
                    ]),
                },
                {
                    flags: new Map([
                        ["duplicate", { name: "duplicate", extensionPath: "/second.ts", type: "string" }],
                    ]),
                },
            ],
            extensionRuntime: runtime,
        } as unknown as AgentHarnessHost;

        const owner = new AgentSessionRuntime("/s", fake.pane, [], [], {
            initialFlagValues: { duplicate: "restored by second registration" },
        });

        expect(owner.getFlagValue("duplicate")).toBe(true);
    });
});

describe("AgentSessionRuntime — send routing (no catch-busy)", () => {
    it("first send prompts; a concurrent send queues via followUp", async () => {
        const fake = makeFakeHarness(); // prompt() stays pending → running stays true
        const owner = new AgentSessionRuntime("/s", fake.pane);
        void owner.send("a");
        void owner.send("b");
        await flush();
        expect(fake.calls.prompt).toEqual(["a"]);
        expect(fake.calls.followUp).toEqual(["b"]);
        expect(owner.getSessionState().status).toBe("idle");
    });

    it("after the run ends (agent_end), the next send prompts again", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        void owner.send("a");
        fake.emit({ type: "agent_end", messages: [] }); // clears running
        void owner.send("c");
        await flush();
        expect(fake.calls.prompt).toEqual(["a", "c"]);
        expect(fake.calls.followUp).toEqual([]);
    });

    it("a prompt rejection clears running and surfaces status=error", async () => {
        const fake = makeFakeHarness();
        fake.setPromptResult(() => Promise.reject(new Error("boom")));
        const owner = new AgentSessionRuntime("/s", fake.pane);
        owner.send("a").catch(() => {});
        await flush();
        const state = owner.getSessionState();
        expect(state.status).toBe("error");
        expect(state.errorMessage).toBe("boom");
        // running was cleared → the next send prompts (doesn't deadlock on followUp).
        owner.send("b").catch(() => {});
        await flush();
        expect(fake.calls.prompt).toEqual(["a", "b"]);
    });
});

describe("AgentSessionRuntime — subscriber fan-out", () => {
    it.each([
        {
            reason: "abort" as const,
            terminate: (owner: AgentSessionRuntime, fake: ReturnType<typeof makeFakeHarness>) => {
                fake.emit({ type: "abort", clearedSteer: [], clearedFollowUp: [] });
            },
        },
        {
            reason: "reload" as const,
            terminate: (owner: AgentSessionRuntime) => {
                owner.dispose("reload");
            },
        },
        {
            reason: "dispose" as const,
            terminate: (owner: AgentSessionRuntime) => {
                owner.dispose();
            },
        },
    ])("terminates pending confirm and custom requests on $reason and ignores stale events", async ({ reason, terminate }) => {
        const fake = makeFakeHarness();
        const uiBridge = createExtensionUiBridge();
        const owner = new AgentSessionRuntime("/s", fake.pane, [], [], { extensionUiBridge: uiBridge });
        uiBridge.attach(owner);
        const ctx = createExtensionContext(() => "/work", uiBridge);
        const done = vi.fn();
        let widgetId = "";
        owner.subscribe((event) => {
            if (event.type === "ext_ui_request" && event.request.kind === "custom") {
                widgetId = event.request.widget.id;
            }
        });
        const confirmPromise = ctx.ui.confirm("Continue?");
        const customPromise = ctx.ui.custom((_tui, _theme, _keys, finish) => {
            const input = new Input();
            input.onSubmit = (value) => {
                done(value);
                finish(value);
            };
            return input;
        });
        const expectedError = {
            name: "ExtensionUiRequestTerminatedError",
            code: "EXT_UI_REQUEST_TERMINATED",
            reason,
        };
        const confirmRejection = expect(confirmPromise).rejects.toMatchObject(expectedError);
        const customRejection = expect(customPromise).rejects.toMatchObject(expectedError);

        terminate(owner, fake);

        await Promise.all([confirmRejection, customRejection]);
        expect(widgetId).not.toBe("");
        expect(owner.resolveCustomWidget(widgetId, "late")).toBe(false);
        expect(owner.respondWidgetEvent({ nodeid: widgetId, type: "submit" })).toBe(false);
        expect(done).not.toHaveBeenCalled();
    });

    it("exposes a typed extension UI request termination error", () => {
        const error = new ExtensionUiRequestTerminatedError("reload");

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
            name: "ExtensionUiRequestTerminatedError",
            message: "extension UI request terminated: reload",
            code: "EXT_UI_REQUEST_TERMINATED",
            reason: "reload",
        });
    });
    it("forwards harness events to subscribers and stops after unsubscribe", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const seen: string[] = [];
        const unsub = owner.subscribe((e) => seen.push(e.type));
        fake.emit({ type: "agent_start" });
        fake.emit({ type: "message_start", message: user("hi") });
        unsub();
        fake.emit({ type: "agent_end", messages: [] });
        expect(seen).toEqual(["agent_start", "message_start"]);
    });

    it("a subscriber reading getSessionState() inside its callback sees post-event state", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        let lenAtCallback = -1;
        owner.subscribe(() => {
            lenAtCallback = owner.getSessionState().messages.length;
        });
        fake.emit({ type: "message_start", message: user("hi") });
        expect(lenAtCallback).toBe(1);
    });

    it("emits request update events for active custom UI widgets", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const seen: unknown[] = [];
        owner.subscribe((event) => {
            if (event.type === "ext_ui_request_update") seen.push(event);
        });
        void owner.requestUi({
            kind: "custom",
            widget: {
                kind: "terminal",
                id: "terminal-1",
                lines: ["count:0"],
            },
        });

        owner.updateCustomWidget({
            kind: "terminal",
            id: "terminal-1",
            lines: ["count:1"],
        });

        expect(seen).toEqual([
            {
                type: "ext_ui_request_update",
                requestId: "extui-0",
                widget: {
                    kind: "terminal",
                    id: "terminal-1",
                    lines: ["count:1"],
                },
            },
        ]);
    });

    it("resolves and clears an active custom UI request when widget done is called", async () => {
        const fake = makeFakeHarness();
        const uiBridge = createExtensionUiBridge();
        const owner = new AgentSessionRuntime("/s", fake.pane, [], [], { extensionUiBridge: uiBridge });
        uiBridge.attach(owner);
        const ctx = createExtensionContext(() => "/work", uiBridge);
        const seen: unknown[] = [];
        owner.subscribe((event) => {
            if (event.type === "ext_ui_request" || event.type === "ext_ui_resolved" || event.type === "ext_ui_request_update") {
                seen.push(event);
            }
        });

        const customPromise = ctx.ui.custom((_tui, _theme, _keys, done) => {
            const input = new Input();
            input.setValue("ready");
            input.onSubmit = (value) => done(value);
            return input;
        });
        await Promise.resolve();
        const request = seen.find((event) => (event as { type?: string }).type === "ext_ui_request") as
            | { type: "ext_ui_request"; requestId: string; request: { kind: string; widget: { id: string } } }
            | undefined;
        expect(request?.request.kind).toBe("custom");
        if (!request || request.request.kind !== "custom") throw new Error("expected custom request");

        expect(owner.respondWidgetEvent({ nodeid: request.request.widget.id, type: "submit" })).toBe(true);

        await expect(customPromise).resolves.toBe("ready");
        expect(seen).toContainEqual({ type: "ext_ui_resolved", requestId: request.requestId });

        owner.updateCustomWidget({
            kind: "input",
            id: request.request.widget.id,
            value: "stale",
            cursor: 5,
            focused: false,
        });
        expect(seen.filter((event) => (event as { type?: string }).type === "ext_ui_request_update")).toEqual([]);
    });

    it("dispose() detaches the harness subscription and aborts", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        await owner.dispose();
        expect(fake.listenerCount()).toBe(0);
        expect(fake.calls.abort).toBe(1);
        expect(fake.calls.disposeOwner).toEqual(["/s"]);
        expect(fake.calls.disposeAll).toBe(0);
    });

    it("dispose() waits for lifecycle cleanup before resolving", async () => {
        const fake = makeFakeHarness();
        const disposeGate = deferred<void>();
        const disposeOwner = fake.pane.extensionLifecycleHost!.disposeOwner as ReturnType<typeof vi.fn>;
        disposeOwner.mockImplementationOnce(async (ownerId: string) => {
            fake.calls.disposeOwner.push(ownerId);
            await disposeGate.promise;
        });
        const owner = new AgentSessionRuntime("/s", fake.pane);
        let settled = false;

        const disposePromise = owner.dispose("reload").then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(settled).toBe(false);
        disposeGate.resolve();
        await disposePromise;
        expect(settled).toBe(true);
    });

    it("dispose() unregisters the lifecycle host from the global graph", async () => {
        const runtime = createExtensionRuntime();
        const lifecycleHost = createExtensionLifecycleHost(runtime);
        lifecycleHost.setNodes([
            {
                id: "session.ext",
                name: "session.ext",
                version: "1.0.0",
                path: "/tmp/session.ext.ts",
                scope: "workspace",
                status: "active",
                commands: [],
                tools: [],
                hooks: [],
                flags: [],
                errors: [],
            },
        ]);
        const fake = makeFakeHarness();
        fake.pane = { ...fake.pane, extensionLifecycleHost: lifecycleHost } as AgentHarnessHost;
        const owner = new AgentSessionRuntime("/s", fake.pane);

        await owner.dispose();

        expect(getExtensionGraphForLifecycleRuntime().nodes).toEqual([]);
    });

    it("dispose() propagates lifecycle cleanup errors after unregistering and aborting", async () => {
        const fake = makeFakeHarness();
        const error = new Error("cleanup failed");
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        (fake.pane.extensionLifecycleHost!.disposeOwner as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
        const owner = new AgentSessionRuntime("/s", fake.pane);

        await expect(owner.dispose()).rejects.toBe(error);

        expect(errorSpy).toHaveBeenCalledWith("[agent-session] extension cleanup error for /s:", error);
        expect(fake.calls.abort).toBe(1);
        errorSpy.mockRestore();
    });
});
