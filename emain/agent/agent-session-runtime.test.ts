// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    type AssistantMessage,
    type Model,
    registerApiProvider,
    resetApiProviders,
    type UserMessage,
} from "@crest/ai";
import { AssistantMessageEventStream } from "@crest/ai/utils/event-stream";
import type { ContextProjectionReport } from "./context/types";
import { AgentSessionRuntime, buildPersistedTurnsFromSessionEntries } from "./agent-session-runtime";
import { buildAgentHarnessHost, type AgentHarnessHost } from "./harness-factory";
import { InMemorySessionRepo } from "./harness/session/memory-repo";
import { makeCommittedContextTransaction } from "./harness/session/context-transaction-fixture";
import type {
    AgentHarnessPromptOptions,
    AgentHarnessTurnPreparation,
    AgentHarnessTurnPreparationInput,
    SessionTreeEntry,
} from "./harness/types";
import type { AgentMessage, ThinkingLevel } from "./types";

// Minimal harness double: records prompt/followUp/abort calls and lets a
// test drive the event stream via emit(). Mirrors the only surface
// AgentSessionRuntime touches.
function makeFakeHarness() {
    const listeners = new Set<(event: unknown) => void>();
    const calls = {
        prompt: [] as string[],
        promptOptions: [] as unknown[],
        followUp: [] as string[],
        followUpOptions: [] as unknown[],
        followUpPreparations: [] as Array<AgentHarnessTurnPreparation | undefined>,
        custom: [] as unknown[],
        abort: 0,
        navigateTree: [] as unknown[],
    };
    let promptResult: (options?: unknown) => Promise<unknown> = () => new Promise(() => {}); // pending forever by default
    let navigateTreeResult: () => Promise<unknown> = () => Promise.resolve({ cancelled: false });
    const session = {
        getEntries: vi.fn().mockResolvedValue([]),
        getBranch: vi.fn().mockResolvedValue([]),
        getLeafId: vi.fn().mockResolvedValue(null),
        getLabel: vi.fn().mockResolvedValue(undefined),
        appendCustomEntry: vi.fn().mockResolvedValue(undefined),
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
        prompt(text: string, options?: unknown) {
            calls.prompt.push(text);
            calls.promptOptions.push(options);
            return promptResult(options);
        },
        followUp(text: string, options?: unknown, prepare?: AgentHarnessTurnPreparation) {
            calls.followUp.push(text);
            calls.followUpOptions.push(options);
            calls.followUpPreparations.push(prepare);
            if (calls.prompt.length === 0) return Promise.reject(new Error("followUp before prompt"));
            return Promise.resolve();
        },
        appendCustomEntry: vi.fn((customType: string, data?: unknown) => {
            calls.custom.push({ customType, data });
            return Promise.resolve();
        }),
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
        setPromptResult(fn: (options?: unknown) => Promise<unknown>) {
            promptResult = fn;
        },
        setNavigateTreeResult(fn: () => Promise<unknown>) {
            navigateTreeResult = fn;
        },
        async prepareNextFollowUp(input?: Partial<AgentHarnessTurnPreparationInput>) {
            const queuedPrepare = calls.followUpPreparations.shift();
            const options = calls.followUpOptions.shift() as
                | { activate?: () => Promise<AgentHarnessTurnPreparation | void> }
                | undefined;
            const activatedPrepare = await options?.activate?.();
            const prepare = typeof activatedPrepare === "function" ? activatedPrepare : queuedPrepare;
            if (!prepare) return;
            return await prepare({
                userMessage: user("queued"),
                systemPrompt: "system",
                messages: [],
                model: currentModel,
                activeTools: [],
                transformProviderRequest: async () => ({}),
                transformContextMessages: async (messages) => messages,
                transformProviderPayload: async (payload) => payload,
                ...input,
            });
        },
        async preparePrompt(input?: Partial<AgentHarnessTurnPreparationInput>) {
            const options = calls.promptOptions.at(-1) as AgentHarnessPromptOptions | undefined;
            if (!options?.prepare) return;
            return await options.prepare({
                userMessage: user("prompt"),
                systemPrompt: "system",
                messages: [],
                model: currentModel,
                activeTools: [],
                transformProviderRequest: async () => ({}),
                transformContextMessages: async (messages) => messages,
                transformProviderPayload: async (payload) => payload,
                ...input,
            });
        },
        pane: {
            harness,
            session,
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

function user(text: string): UserMessage {
    return { role: "user", content: [{ type: "text", text }] } as UserMessage;
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

async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
        if (check()) return;
        await flush();
    }
    throw new Error("condition was not reached");
}

function projectionReport(targetTurnId: string, transactionId = `tx-${targetTurnId}`): ContextProjectionReport {
    return {
        schemaVersion: 1,
        transactionId,
        targetTurnId,
        createdAt: "2026-07-23T00:00:00.000Z",
        contextWindow: 1000,
        effectiveOutputReserve: 100,
        inputLimit: 900,
        baseInputTokens: 10,
        finalInputTokens: 20,
        referenceTokens: 10,
        countAccuracy: "exact",
        overlaySha256: "a".repeat(64),
        items: [],
    };
}

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
    it("lists session tree entries through the pane harness session", async () => {
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
        const userMsg = {
            type: "message" as const,
            id: "m1",
            parentId: "label-1",
            timestamp: "t1",
            message: user("hi"),
        };
        const asstMsg = {
            type: "message" as const,
            id: "m2",
            parentId: "m1",
            timestamp: "t2",
            message: assistant("hi"),
        };
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
        const userMsg = {
            type: "message" as const,
            id: "m1",
            parentId: "custom-1",
            timestamp: "t1",
            message: user("hi"),
        };
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
        expect(seen).toContainEqual(
            expect.objectContaining({
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
            })
        );
    });

    it("shows history up to the parent when navigating to a user message (leaf = parentId)", async () => {
        // Scenario: m1(user)->a1(assistant)->m2(user)->a2(assistant). User clicks m2 in
        // the tree. Harness moves leaf to m2.parentId = a1, so getBranch() returns
        // [m1,a1] (NOT m2). The user entry m1 must produce turn(m1).
        const fake = makeFakeHarness();
        const m1 = user("first question");
        const a1 = assistant("first answer", "stop");
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
        expect(state.turns).toEqual([{ turnId: "m1", userMessage: m1, responseMessages: [a1], status: "done" }]);
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
        expect(state.turns).toEqual([{ turnId: "m1", userMessage: m1, responseMessages: [], status: "done" }]);
    });

    it("returns an empty navigation result when tree navigation is cancelled", async () => {
        const fake = makeFakeHarness();
        fake.setNavigateTreeResult(() => Promise.resolve({ cancelled: true }));
        const owner = new AgentSessionRuntime("/s", fake.pane);

        await expect(owner.navigateTree("entry-1")).resolves.toEqual({});
    });

    it("reads the active leaf id from the pane harness session", async () => {
        const fake = makeFakeHarness();
        fake.session.getLeafId.mockResolvedValue("leaf-1");
        const owner = new AgentSessionRuntime("/s", fake.pane);

        await expect(owner.getLeafId()).resolves.toBe("leaf-1");
    });
});

describe("AgentSessionRuntime — authoritative context state", () => {
    it("hydrates projection reports without exposing persistent pin state", () => {
        const fake = makeFakeHarness();
        const branch = makeCommittedContextTransaction({ prefix: "hydrated" });
        const owner = new AgentSessionRuntime("/s", fake.pane, [], [], { initialContextEntries: branch });

        const state = owner.getSessionState();

        expect(state).not.toHaveProperty("contextPins");
        expect(state.contextReports).toEqual([
            expect.objectContaining({
                transactionId: "hydrated-transaction",
                targetTurnId: "hydrated-user",
            }),
        ]);
    });

    it("recomputes reports from the selected branch after tree navigation", async () => {
        const fake = makeFakeHarness();
        const attached = makeCommittedContextTransaction({ prefix: "active" });
        fake.session.getBranch.mockResolvedValue([]);
        const owner = new AgentSessionRuntime("/s", fake.pane, [], [], { initialContextEntries: attached });

        await owner.navigateTree("before-attach");

        expect(owner.getSessionState().contextReports).toEqual([]);
    });

    it("applies a context projection before notifying listeners", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const report = projectionReport("prepared-user");
        let reportsAtNotification: ContextProjectionReport[] | undefined;
        owner.subscribe((event) => {
            if (event.type === "context_projection") {
                reportsAtNotification = owner.getSessionState().contextReports;
            }
        });
        const send = owner.send("hello", {
            prepare: async () => ({
                userEntryId: "prepared-user",
                systemPromptSuffix: "overlay",
                projectionReport: report,
            }),
        });
        await flush();

        await fake.preparePrompt();
        await send;

        expect(reportsAtNotification).toEqual([report]);
    });

    it("refreshes committed projection reports before a prepared send resolves", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const branch = makeCommittedContextTransaction({ prefix: "new-context" });
        const report = (branch.find(
            (entry) => entry.type === "custom" && entry.customType === "context_projection"
        ) as Extract<SessionTreeEntry, { type: "custom" }>).data as ContextProjectionReport;
        const send = owner.send("hello", {
            prepare: async () => {
                fake.session.getBranch.mockResolvedValue(branch);
                return {
                    userEntryId: "new-context-user",
                    systemPromptSuffix: "overlay",
                    projectionReport: report,
                };
            },
        });
        await flush();

        await fake.preparePrompt();
        await send;

        expect(owner.getSessionState().contextReports).toEqual([
            expect.objectContaining({ targetTurnId: "new-context-user" }),
        ]);
    });

    it("replays reports in session_state after rebuilding", async () => {
        const fake = makeFakeHarness();
        const branch = makeCommittedContextTransaction({ prefix: "replay" });
        fake.session.getBranch.mockResolvedValue(branch);
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const events: unknown[] = [];
        owner.subscribe((event) => events.push(event));

        await owner.navigateTree("replay-user");

        expect(events.at(-1)).toEqual(
            expect.objectContaining({
                type: "session_state",
                contextReports: [expect.objectContaining({ targetTurnId: "replay-user" })],
            })
        );
        expect(events.at(-1)).not.toHaveProperty("contextPins");
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

    it("resolves a prepared send when its context transaction commits", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const report = projectionReport("prepared-user");
        const sendPromise = owner.send("hello", {
            prepare: async () => ({
                userEntryId: "prepared-user",
                systemPromptSuffix: "overlay",
                projectionReport: report,
            }),
        });
        await flush();

        await fake.preparePrompt();

        await expect(sendPromise).resolves.toBe("prepared-user");
        expect(owner.getSessionState().contextReports).toEqual([report]);
    });

    it("resolves a queued prepared send only when its own preparation commits", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const first = owner.send("first");
        await flush();
        fake.emit({ type: "message_end", message: user("first"), entryId: "first-user" });
        await expect(first).resolves.toBe("first-user");

        let settled = false;
        const second = owner
            .send("second", {
                prepare: async () => ({
                    userEntryId: "second-user",
                    systemPromptSuffix: "overlay",
                }),
            })
            .finally(() => {
                settled = true;
            });
        await flush();
        expect(settled).toBe(false);

        await fake.prepareNextFollowUp({ userMessage: user("second") });

        await expect(second).resolves.toBe("second-user");
    });

    it("keeps queued preparation inputs and user ids bound to their own sends", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        void owner.send("active");
        await flush();
        fake.emit({ type: "message_end", message: user("active"), entryId: "active-user" });
        const seen: string[][] = [];
        const prepare = (draftIds: string[], userEntryId: string): AgentHarnessTurnPreparation => async () => {
            seen.push(draftIds);
            return { userEntryId, systemPromptSuffix: userEntryId };
        };

        const second = owner.send("second", { prepare: prepare(["draft-2"], "user-2") });
        const third = owner.send("third", { prepare: prepare(["draft-3a", "draft-3b"], "user-3") });
        await flush();

        await fake.prepareNextFollowUp({ userMessage: user("second") });
        await expect(second).resolves.toBe("user-2");
        expect(await Promise.race([third.then(() => "settled"), flush().then(() => "pending")])).toBe("pending");
        await fake.prepareNextFollowUp({ userMessage: user("third") });
        await expect(third).resolves.toBe("user-3");
        expect(seen).toEqual([["draft-2"], ["draft-3a", "draft-3b"]]);
    });

    it("rejects only the failed prepared send without leaving a stale resolver", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        void owner.send("active");
        await flush();
        fake.emit({ type: "message_end", message: user("active"), entryId: "active-user" });
        const failed = owner.send("failed", {
            prepare: async () => {
                throw new Error("budget exceeded");
            },
        });
        const next = owner.send("next", {
            prepare: async () => ({ userEntryId: "next-user", systemPromptSuffix: "overlay" }),
        });
        await flush();

        await expect(fake.prepareNextFollowUp()).rejects.toThrow("budget exceeded");
        await expect(failed).rejects.toThrow("budget exceeded");
        await fake.prepareNextFollowUp();
        await expect(next).resolves.toBe("next-user");
    });

    it("does not reject the next queued send when an initial preparation fails", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        fake.setPromptResult(async (options) => {
            const prepare = (options as AgentHarnessPromptOptions).prepare!;
            await prepare({
                userMessage: user("failed"),
                systemPrompt: "system",
                messages: [],
                model: fake.model,
                activeTools: [],
                transformProviderRequest: async () => ({}),
                transformContextMessages: async (messages) => messages,
                transformProviderPayload: async (payload) => payload,
            });
        });
        const failed = owner.send("failed", {
            prepare: async () => {
                throw new Error("initial preparation failed");
            },
        });
        const next = owner.send("next", {
            prepare: async () => ({ userEntryId: "next-user", systemPromptSuffix: "overlay" }),
        });

        await expect(failed).rejects.toThrow("initial preparation failed");
        const beforeNextPreparation = await Promise.race([
            next.then(
                () => "resolved",
                () => "rejected"
            ),
            flush().then(() => "pending"),
        ]);
        expect(beforeNextPreparation).toBe("pending");

        await fake.prepareNextFollowUp();
        await expect(next).resolves.toBe("next-user");
    });

    it("rejects the exact queued send when config activation fails", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        void owner.send("active");
        await flush();
        fake.emit({ type: "message_end", message: user("active"), entryId: "active-user" });
        vi.mocked(fake.pane.harness.setModel).mockRejectedValueOnce(new Error("activation failed"));
        const queued = owner.sendWithExecutionConfig("queued", {
            promptInputs: { cwd: "/queued" },
            model: { ...fake.model, id: "next-model" },
            thinkingLevel: "high",
        });
        await flush();

        await expect(fake.prepareNextFollowUp()).rejects.toThrow("activation failed");
        const result = await Promise.race([
            queued.then(
                () => "resolved",
                (error) => (error as Error).message
            ),
            flush().then(() => "pending"),
        ]);

        expect(result).toBe("activation failed");
    });

    it("keeps a committed send successful when post-commit context refresh fails", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        fake.session.getBranch.mockRejectedValueOnce(new Error("refresh failed"));
        const send = owner.send("hello", {
            prepare: async () => ({
                userEntryId: "committed-user",
                systemPromptSuffix: "overlay",
                projectionReport: projectionReport("committed-user"),
            }),
        });
        await flush();

        await expect(fake.preparePrompt()).resolves.toEqual(
            expect.objectContaining({ userEntryId: "committed-user" })
        );
        await expect(send).resolves.toBe("committed-user");
        expect(owner.getSessionState().contextReports).toEqual([
            expect.objectContaining({ targetTurnId: "committed-user" }),
        ]);
    });

    it("lets a committed preparation win when abort races with its successful return", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const abortController = new AbortController();
        let releasePreparation!: () => void;
        const preparationGate = new Promise<void>((resolve) => {
            releasePreparation = resolve;
        });
        let preparationStarted = false;
        const send = owner.send("hello", {
            prepare: async () => {
                preparationStarted = true;
                await preparationGate;
                return {
                    userEntryId: "late-user",
                    systemPromptSuffix: "overlay",
                    projectionReport: projectionReport("late-user"),
                };
            },
        });
        await flush();
        const preparation = fake.preparePrompt({ signal: abortController.signal });
        await waitFor(() => preparationStarted);

        abortController.abort();
        releasePreparation();

        await expect(preparation).resolves.toEqual(expect.objectContaining({ userEntryId: "late-user" }));
        fake.emit({ type: "abort", clearedSteer: [], clearedFollowUp: [] });
        await expect(send).resolves.toBe("late-user");
        expect(owner.getSessionState().contextReports).toEqual([
            expect.objectContaining({ targetTurnId: "late-user" }),
        ]);
        expect(
            (owner as unknown as { ignoredCommittedEntryIds: Set<string> }).ignoredCommittedEntryIds.size
        ).toBe(0);
    });

    it("rejects queued uncommitted prepared sends on abort", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        void owner.send("active").catch(() => {});
        const queued = owner.send("queued", {
            prepare: async () => ({ userEntryId: "must-not-commit", systemPromptSuffix: "overlay" }),
        });
        await flush();

        fake.emit({ type: "abort", clearedSteer: [], clearedFollowUp: [user("queued")] });

        await expect(queued).rejects.toThrow(/aborted/);
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

        expect(turns).toEqual([{ turnId: "m1", userMessage: q1, responseMessages: [a1], status: "done" }]);
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

        expect(turns).toEqual([{ turnId: "e1", userMessage: q1, responseMessages: [], status: "done" }]);
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

    it("passes a fresh activated model to queued semantic preparation", async () => {
        const fake = makeFakeHarness();
        const runtime = new AgentSessionRuntime("/s", fake.pane);
        void runtime.send("active");
        await flush();
        fake.emit({ type: "message_end", message: user("active"), entryId: "active-user" });
        const nextModel = { ...fake.model, id: "prepared-model" };
        const seenModels: string[] = [];

        const queued = runtime.sendWithExecutionConfig(
            "queued",
            {
                promptInputs: { cwd: "/queued" },
                model: nextModel,
                thinkingLevel: "high",
            },
            {
                prepare: async (input) => {
                    seenModels.push(input.model.id);
                    return { userEntryId: "queued-user", systemPromptSuffix: "overlay" };
                },
            }
        );
        await flush();

        await fake.prepareNextFollowUp();

        await expect(queued).resolves.toBe("queued-user");
        expect(seenModels).toEqual(["prepared-model"]);
    });

    it("chooses queued semantic preparation at activation time", async () => {
        const fake = makeFakeHarness();
        const runtime = new AgentSessionRuntime("/s", fake.pane);
        void runtime.send("active");
        await flush();
        fake.emit({ type: "message_end", message: user("active"), entryId: "active-user" });
        let includeContext = false;
        const activatePreparation = vi.fn(async (): Promise<AgentHarnessTurnPreparation | undefined> =>
            includeContext
                ? async () => ({ userEntryId: "queued-context-user", systemPromptSuffix: "fresh overlay" })
                : undefined
        );

        const queued = runtime.sendWithExecutionConfig(
            "queued",
            {
                promptInputs: { cwd: "/queued" },
                model: fake.model,
                thinkingLevel: "off",
            },
            { activatePreparation }
        );
        await flush();
        includeContext = true;

        const prepared = await fake.prepareNextFollowUp();

        expect(activatePreparation).toHaveBeenCalledOnce();
        expect(prepared).toMatchObject({ userEntryId: "queued-context-user" });
        await expect(queued).resolves.toBe("queued-context-user");
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

    it("passes images to prompt and queued followUp sends", async () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        const firstImage = { type: "image" as const, data: "first", mimeType: "image/png" };
        const secondImage = { type: "image" as const, data: "second", mimeType: "image/jpeg" };

        void owner.send("a", { images: [firstImage] });
        void owner.send("b", { images: [secondImage] });
        await flush();

        expect(fake.calls.promptOptions).toEqual([{ images: [firstImage] }]);
        expect(fake.calls.followUpOptions).toEqual([
            expect.objectContaining({ images: [secondImage], activate: expect.any(Function) }),
        ]);
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

    it("dispose() detaches the harness subscription and aborts", () => {
        const fake = makeFakeHarness();
        const owner = new AgentSessionRuntime("/s", fake.pane);
        owner.dispose();
        expect(fake.listenerCount()).toBe(0);
        expect(fake.calls.abort).toBe(1);
    });
});

describe("AgentSessionRuntime — real prepared follow-up integration", () => {
    const api = "runtime-terminal-test";
    const model = {
        id: "runtime-model",
        name: "Runtime model",
        api,
        provider: "runtime-provider",
        baseUrl: "http://localhost",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
    } as Model<any>;

    afterEach(() => {
        resetApiProviders();
    });

    function done(text: string): { type: "done"; reason: "stop"; message: AssistantMessage } {
        return {
            type: "done",
            reason: "stop",
            message: {
                role: "assistant",
                content: [{ type: "text", text }],
                api,
                provider: model.provider,
                model: model.id,
                stopReason: "stop",
                timestamp: Date.now(),
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
            } as AssistantMessage,
        };
    }

    it("resolves a durably committed send when abort wins before provider start", async () => {
        const streams: AssistantMessageEventStream[] = [];
        registerApiProvider({
            api,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: () => {
                const stream = new AssistantMessageEventStream();
                streams.push(stream);
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const host = buildAgentHarnessHost({
            session,
            model,
            promptInputs: { cwd: process.cwd() },
        });
        const runtime = new AgentSessionRuntime("/runtime", host);
        let committedUserId = "";
        let appendCompleted = false;
        const send = runtime.send("commit then abort", {
            prepare: async (input) => {
                committedUserId = await session.appendMessage(input.userMessage);
                appendCompleted = true;
                await new Promise<void>((resolve) => {
                    if (input.signal?.aborted) {
                        resolve();
                    } else {
                        input.signal?.addEventListener("abort", () => resolve(), { once: true });
                    }
                });
                return {
                    userEntryId: committedUserId,
                    systemPromptSuffix: "committed overlay",
                    projectionReport: projectionReport(committedUserId),
                };
            },
        });
        await waitFor(() => appendCompleted);

        runtime.abort();

        await expect(send).resolves.toBe(committedUserId);
        await host.harness.waitForIdle();
        await waitFor(() => !runtime.running);
        expect(streams).toEqual([]);
        expect(runtime.getSessionState().contextReports).toEqual([
            expect.objectContaining({ targetTurnId: committedUserId }),
        ]);
        expect(
            (runtime as unknown as { ignoredCommittedEntryIds: Set<string> }).ignoredCommittedEntryIds.size
        ).toBe(0);
    });

    it("promotes an innocent queued send after an initial terminal failure", async () => {
        const streams: AssistantMessageEventStream[] = [];
        registerApiProvider({
            api,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: () => {
                const stream = new AssistantMessageEventStream();
                streams.push(stream);
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const runtime = new AgentSessionRuntime(
            "/runtime",
            buildAgentHarnessHost({
                session,
                model,
                promptInputs: { cwd: process.cwd() },
            })
        );
        let queuedUserId = "";
        const initial = runtime.send("initial", {
            prepare: async () => {
                throw new Error("initial terminal failure");
            },
        });
        const queued = runtime.send("queued", {
            prepare: async (input) => {
                queuedUserId = await session.appendMessage(input.userMessage);
                return { userEntryId: queuedUserId, systemPromptSuffix: "queued overlay" };
            },
        });

        await expect(initial).rejects.toThrow("initial terminal failure");
        await waitFor(() => streams.length === 1);
        await expect(queued).resolves.toBe(queuedUserId);
        const later = runtime.send("later");
        streams[0]!.push(done("queued done"));
        await waitFor(() => streams.length === 2);
        await expect(later).resolves.toEqual(expect.any(String));
        expect(await later).not.toBe(queuedUserId);
        streams[1]!.push(done("later done"));
        await waitFor(() => !runtime.running);
    });

    it("drops one terminally failed follow-up and preserves the next send identity", async () => {
        const streams: AssistantMessageEventStream[] = [];
        registerApiProvider({
            api,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: () => {
                const stream = new AssistantMessageEventStream();
                streams.push(stream);
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const host = buildAgentHarnessHost({
            session,
            model,
            promptInputs: { cwd: process.cwd() },
        });
        const runtime = new AgentSessionRuntime("/runtime", host);
        const failedPrepare = vi.fn(async () => {
            throw new Error("terminal preparation failed");
        });
        let nextUserId = "";
        const nextPrepare = vi.fn(async (input: AgentHarnessTurnPreparationInput) => {
            nextUserId = await session.appendMessage(input.userMessage);
            return { userEntryId: nextUserId, systemPromptSuffix: "next overlay" };
        });

        const active = runtime.send("active");
        await waitFor(() => streams.length === 1);
        await active;
        const failed = runtime.send("failed", { prepare: failedPrepare });
        const next = runtime.send("next", { prepare: nextPrepare });
        streams[0]!.push(done("active done"));

        await expect(failed).rejects.toThrow("terminal preparation failed");
        await waitFor(() => !runtime.running);
        const kick = runtime.send("kick");
        await waitFor(() => streams.length === 2);
        await kick;
        streams[1]!.push(done("kick done"));

        await waitFor(() => nextPrepare.mock.calls.length > 0);
        await expect(next).resolves.toBe(nextUserId);
        expect(failedPrepare).toHaveBeenCalledOnce();
        expect(nextPrepare).toHaveBeenCalledOnce();
        await waitFor(() => streams.length === 3);
        streams[2]!.push(done("next done"));
        await waitFor(() => !runtime.running);
    });
});
