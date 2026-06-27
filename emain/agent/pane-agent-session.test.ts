// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { PaneHarness } from "./harness-factory";
import {
    buildPersistedRunsFromSessionEntries,
    buildPersistedRunsFromTimeline,
    buildRunsFromEntryIdJoin,
    PaneAgentSession,
} from "./pane-agent-session";
import type { AgentMessage } from "./types";
import type { SessionTreeEntry } from "./harness/types";

// Minimal harness double: records prompt/followUp/abort calls and lets a
// test drive the event stream via emit(). Mirrors the only surface
// PaneAgentSession touches.
function makeFakeHarness() {
    const listeners = new Set<(event: unknown) => void>();
    const calls = {
        prompt: [] as string[],
        followUp: [] as string[],
        custom: [] as unknown[],
        abort: 0,
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
    const harness = {
        subscribe(listener: (event: unknown) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        prompt(text: string) {
            calls.prompt.push(text);
            return promptResult();
        },
        followUp(text: string) {
            calls.followUp.push(text);
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
    };
    return {
        calls,
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
        pane: {
            harness,
            session,
            appendCustomEntry: harness.appendCustomEntry,
            promptWithCustomEntry: harness.promptWithCustomEntry,
            update: vi.fn(),
        } as unknown as PaneHarness,
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

describe("PaneAgentSession — owned transcript", () => {
    it("subscribes to the harness once at construction", () => {
        const fake = makeFakeHarness();
        new PaneAgentSession("/s", fake.pane);
        expect(fake.listenerCount()).toBe(1);
    });

    it("appends on message_start and replaces the tail on update/end", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        fake.emit({ type: "message_start", message: user("hi") });
        fake.emit({ type: "message_start", message: assistant("par") });
        fake.emit({ type: "message_update", message: assistant("partial") });
        fake.emit({ type: "message_end", message: assistant("final", "stop") });
        const { messages } = owner.getSnapshot();
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe("user");
        expect((messages[1] as { content: { text: string }[] }).content[0].text).toBe("final");
    });

    it("seeds the transcript from persisted history (reopened session)", () => {
        const fake = makeFakeHarness();
        const history = [user("old q"), assistant("old a", "stop")];
        const owner = new PaneAgentSession("/s", fake.pane, history);
        expect(owner.getSnapshot().messages).toBe(history);
    });

    it("does NOT clobber the accumulated transcript on agent_end (run-scoped)", () => {
        // The bug: agent_end.messages carries only the CURRENT run's
        // messages, not the whole conversation. Replacing on agent_end wiped
        // prior runs → their blocks went "…loading agent run…". The owner
        // must keep the incrementally-built array.
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        fake.emit({ type: "message_start", message: user("q1") });
        fake.emit({ type: "message_start", message: assistant("a1") });
        fake.emit({ type: "message_end", message: assistant("a1", "stop") });
        // agent_end for run 1 carries only run-1 messages — fine, matches.
        fake.emit({ type: "agent_end", messages: [user("q1"), assistant("a1", "stop")] });
        expect(owner.getSnapshot().messages).toHaveLength(2);
    });

    it("accumulates messages across multiple runs (run-scoped agent_end ignored)", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        // Run 1
        fake.emit({ type: "message_start", message: user("q1") });
        fake.emit({ type: "message_end", message: user("q1") });
        fake.emit({ type: "message_start", message: assistant("a1") });
        fake.emit({ type: "message_end", message: assistant("a1", "stop") });
        fake.emit({ type: "agent_end", messages: [user("q1"), assistant("a1", "stop")] });
        // Run 2 — agent_end here is run-scoped ([q2, a2]); must NOT drop q1/a1.
        fake.emit({ type: "message_start", message: user("q2") });
        fake.emit({ type: "message_end", message: user("q2") });
        fake.emit({ type: "message_start", message: assistant("a2") });
        fake.emit({ type: "message_end", message: assistant("a2", "stop") });
        fake.emit({ type: "agent_end", messages: [user("q2"), assistant("a2", "stop")] });
        const { messages } = owner.getSnapshot();
        expect(messages).toHaveLength(4);
        expect((messages[0] as { content: { text: string }[] }).content[0].text).toBe("q1");
        expect((messages[2] as { content: { text: string }[] }).content[0].text).toBe("q2");
    });
});

describe("PaneAgentSession — command operations", () => {
    it("lists session tree entries through the pane harness session", async () => {
        const fake = makeFakeHarness();
        const entry = { type: "message", id: "1", parentId: null, timestamp: "t", message: user("hello") };
        fake.session.getEntries.mockResolvedValue([entry]);
        fake.session.getLeafId.mockResolvedValue("1");
        fake.session.getLabel.mockResolvedValue("Intro");

        const owner = new PaneAgentSession("/s", fake.pane);
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

        const owner = new PaneAgentSession("/s", fake.pane);
        const result = await owner.listTreeEntries();

        expect(result.entries).toEqual([message]);
        expect(fake.session.getLabel).toHaveBeenCalledTimes(1);
        expect(fake.session.getLabel).toHaveBeenCalledWith("1");
    });

    it("hides all internal custom entries and reparents through chains of hidden nodes", async () => {
        const fake = makeFakeHarness();
        const runEntry = {
            type: "custom" as const,
            id: "run-1",
            parentId: null,
            timestamp: "t0",
            customType: "agent_run",
            data: { runId: "stale" },
        };
        const otherCustom = {
            type: "custom" as const,
            id: "cust-1",
            parentId: "run-1",
            timestamp: "t0b",
            customType: "internal_meta",
            data: {},
        };
        const userMsg = { type: "message" as const, id: "m1", parentId: "cust-1", timestamp: "t1", message: user("hi") };
        const asstMsg = { type: "message" as const, id: "m2", parentId: "m1", timestamp: "t2", message: assistant("hi") };
        fake.session.getEntries.mockResolvedValue([runEntry, otherCustom, userMsg, asstMsg]);
        fake.session.getLeafId.mockResolvedValue("m2");

        const owner = new PaneAgentSession("/s", fake.pane);
        const result = await owner.listTreeEntries();

        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]).toEqual(expect.objectContaining({ id: "m1", parentId: null }));
        expect(result.entries[1]).toEqual(expect.objectContaining({ id: "m2", parentId: "m1" }));
    });

    it("navigates the session tree without branch summarization", async () => {
        const fake = makeFakeHarness();
        fake.setNavigateTreeResult(() => Promise.resolve({ cancelled: false, editorText: "edit this" }));
        const owner = new PaneAgentSession("/s", fake.pane);

        const result = await owner.navigateTree("entry-1");

        expect(fake.calls.navigateTree).toEqual([{ targetId: "entry-1", options: { summarize: false } }]);
        expect(result).toEqual({ editorText: "edit this" });
    });

    it("rebuilds owner snapshot from the selected branch after tree navigation", async () => {
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
        const owner = new PaneAgentSession("/s", fake.pane, oldMessages);
        const seen: unknown[] = [];
        owner.subscribe((event) => seen.push(event));

        await owner.navigateTree("m2", [{ agentrunid: "new-run", seq: 1 }]);

        expect(owner.getSnapshot().messages).toEqual([q, a]);
        expect(owner.getSnapshot().runs).toEqual([
            {
                runId: "new-run",
                userMessage: q,
                responseMessages: [a],
                status: "done",
            },
        ]);
        expect(seen).toContainEqual(
            expect.objectContaining({
                type: "snapshot",
                messages: [q, a],
                runs: [
                    {
                        runId: "new-run",
                        userMessage: q,
                        responseMessages: [a],
                        status: "done",
                    },
                ],
            }),
        );
    });

    it("returns an empty navigation result when tree navigation is cancelled", async () => {
        const fake = makeFakeHarness();
        fake.setNavigateTreeResult(() => Promise.resolve({ cancelled: true }));
        const owner = new PaneAgentSession("/s", fake.pane);

        await expect(owner.navigateTree("entry-1")).resolves.toEqual({});
    });

    it("reads the active leaf id from the pane harness session", async () => {
        const fake = makeFakeHarness();
        fake.session.getLeafId.mockResolvedValue("leaf-1");
        const owner = new PaneAgentSession("/s", fake.pane);

        await expect(owner.getLeafId()).resolves.toBe("leaf-1");
    });
});

describe("PaneAgentSession — owned runs", () => {
    it("builds a completed run keyed by the user entry id", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        const q = user("hello");
        const partial = assistant("hel");
        const final = assistant("hello back", "stop");

        void owner.send("hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_end", message: q, entryId: "e-a" });
        fake.emit({ type: "message_start", message: partial });
        fake.emit({ type: "message_end", message: final });
        fake.emit({ type: "agent_end", messages: [q, final] });

        expect(owner.getSnapshot().runs).toEqual([
            {
                runId: "e-a",
                userMessage: q,
                responseMessages: [final],
                status: "done",
            },
        ]);
    });

    it("resolves send() with the user entry id from the message_end event", async () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        const q = user("hello");

        const sendPromise = owner.send("hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_end", message: q, entryId: "e-a" });

        await expect(sendPromise).resolves.toBe("e-a");
    });

    it("rejects a pending send() promise on abort (queued followUp never commits)", async () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);

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
        const owner = new PaneAgentSession("/s", fake.pane);

        const sendPromise = owner.send("hello");
        owner.dispose();

        await expect(sendPromise).rejects.toThrow(/disposed/);
    });

    it("calls harness.prompt directly without inserting a run-boundary custom entry", async () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);

        void owner.send("hello");
        await flush();

        expect(fake.calls.custom).toEqual([]);
        expect(fake.calls.prompt).toEqual(["hello"]);
    });

    it("marks the active run errored from an errored assistant message", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        const q = user("hello");
        const final = assistant("", "error", "rate limited");

        void owner.send("hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_end", message: q, entryId: "e-err" });
        fake.emit({ type: "message_start", message: assistant("") });
        fake.emit({ type: "message_end", message: final });

        expect(owner.getSnapshot().runs).toEqual([
            {
                runId: "e-err",
                userMessage: q,
                responseMessages: [final],
                status: "error",
                errorMessage: "rate limited",
            },
        ]);
    });

    it("calls onRunFinished with the completed run after agent_end", () => {
        const fake = makeFakeHarness();
        const onRunFinished = vi.fn();
        const owner = new PaneAgentSession("/s", fake.pane, [], [], { onRunFinished });
        const q = user("hello");
        const final = assistant("hello back", "stop");

        void owner.send("hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_end", message: q, entryId: "e-a" });
        fake.emit({ type: "message_start", message: assistant("hel") });
        fake.emit({ type: "message_end", message: final });
        fake.emit({ type: "agent_end", messages: [q, final] });

        expect(onRunFinished).toHaveBeenCalledWith({
            runId: "e-a",
            userMessage: q,
            responseMessages: [final],
            status: "done",
        });
    });

    it("updates a completed run change outline and notifies subscribers", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        const seen: string[] = [];
        owner.subscribe((event) => seen.push(event.type));

        void owner.send("hello");
        fake.emit({ type: "message_start", message: user("hello") });
        fake.emit({ type: "message_end", message: user("hello"), entryId: "e-a" });
        fake.emit({ type: "message_start", message: assistant("hello back") });
        fake.emit({ type: "message_end", message: assistant("hello back", "stop") });
        fake.emit({ type: "agent_end", messages: [] });
        owner.setRunChangeOutline("e-a", {
            modules: [{ id: "ui", title: "UI changes", files: [{ path: "src/app.ts" }] }],
        });

        expect(owner.getSnapshot().runs[0].changeOutline).toEqual({
            modules: [{ id: "ui", title: "UI changes", files: [{ path: "src/app.ts" }] }],
        });
        expect(seen).toContain("agent_run_update");
    });
});

describe("buildPersistedRunsFromTimeline", () => {
    it("rebuilds done runs keyed by persisted timeline run ids", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const q2 = user("q2");
        const a2 = assistant("a2", "stop");

        const runs = buildPersistedRunsFromTimeline([q1, a1, q2, a2], [
            { agentrunid: "run-1", seq: 1 },
            { agentrunid: "run-2", seq: 2 },
        ]);

        expect(runs).toEqual([
            { runId: "run-1", userMessage: q1, responseMessages: [a1], status: "done" },
            { runId: "run-2", userMessage: q2, responseMessages: [a2], status: "done" },
        ]);
    });

    it("rebuilds runs from session entries by grouping on user messages, using timeline runIds", () => {
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

        const runs = buildPersistedRunsFromSessionEntries(entries, [
            { agentrunid: "run-1", seq: 1 },
            { agentrunid: "run-2", seq: 2 },
        ]);

        expect(runs).toEqual([
            { runId: "run-1", userMessage: q1, responseMessages: [a1], status: "done" },
            { runId: "run-2", userMessage: q2, responseMessages: [a2], status: "done" },
        ]);
    });

    it("falls back to entry-id-based runIds when no timeline refs are available", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "m1", parentId: null, timestamp: "t1", message: q1 },
            { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: a1 },
        ];

        const runs = buildPersistedRunsFromSessionEntries(entries, []);

        expect(runs).toEqual([
            { runId: "run-m1", userMessage: q1, responseMessages: [a1], status: "done" },
        ]);
    });

    it("buildPersistedRunsFromSessionEntries joins on agentuserentryid when present", () => {
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

        const runs = buildPersistedRunsFromSessionEntries(
            entries,
            [{ agentrunid: "run-legacy", agentuserentryid: "e2", seq: 1 }],
        );

        expect(runs).toEqual([
            { runId: "e2", userMessage: q1, responseMessages: [a1], status: "done" },
        ]);
    });

    it("filters out legacy agent_run custom entries and ignores non-message entries", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const entries: SessionTreeEntry[] = [
            {
                type: "custom",
                id: "legacy-run-1",
                parentId: null,
                timestamp: "t0",
                customType: "agent_run",
                data: { runId: "stale" },
            },
            { type: "message", id: "m1", parentId: "legacy-run-1", timestamp: "t1", message: q1 },
            { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: a1 },
        ];

        const runs = buildPersistedRunsFromSessionEntries(entries, [
            { agentrunid: "run-actual", seq: 1 },
        ]);

        expect(runs).toEqual([
            { runId: "run-actual", userMessage: q1, responseMessages: [a1], status: "done" },
        ]);
    });

    it("filters timeline refs by agentsessionpath when sessionPath is provided", () => {
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

        // Mixed refs: seq 1 belongs to session-A, seq 2 to session-B, seq 3 to session-A
        // Without filtering, session-A would get refs [seq1(session-A), seq2(session-B)] → wrong runId for q2
        // With sessionPath filtering, session-A gets [seq1(session-A), seq3(session-A)] → correct
        const runs = buildPersistedRunsFromSessionEntries(entries, [
            { agentrunid: "run-A1", seq: 1, agentsessionpath: "/session-A" },
            { agentrunid: "run-B1", seq: 2, agentsessionpath: "/session-B" },
            { agentrunid: "run-A2", seq: 3, agentsessionpath: "/session-A" },
        ], "/session-A");

        expect(runs).toEqual([
            { runId: "run-A1", userMessage: q1, responseMessages: [a1], status: "done" },
            { runId: "run-A2", userMessage: q2, responseMessages: [a2], status: "done" },
        ]);
    });

    it("includes refs without agentsessionpath for backward compatibility", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "m1", parentId: null, timestamp: "t1", message: q1 },
            { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: a1 },
        ];

        // A ref without agentsessionpath (legacy data) is still included
        const runs = buildPersistedRunsFromSessionEntries(entries, [
            { agentrunid: "run-legacy", seq: 1 },
        ], "/session-A");

        expect(runs).toEqual([
            { runId: "run-legacy", userMessage: q1, responseMessages: [a1], status: "done" },
        ]);
    });

    it("excludes refs from other sessions when sessionPath is provided", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "m1", parentId: null, timestamp: "t1", message: q1 },
            { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: a1 },
        ];

        // Only refs for this session should be used; other-session refs are excluded
        const runs = buildPersistedRunsFromSessionEntries(entries, [
            { agentrunid: "run-other", seq: 1, agentsessionpath: "/session-B" },
            { agentrunid: "run-mine", seq: 2, agentsessionpath: "/session-A" },
        ], "/session-A");

        expect(runs).toEqual([
            { runId: "run-mine", userMessage: q1, responseMessages: [a1], status: "done" },
        ]);
    });

    it("reverse-matches refs to the LATEST user messages when there are more users than refs", () => {
        const preQ1 = user("hi");
        const preA1 = assistant("hello", "stop");
        const preQ2 = user("how are you");
        const preA2 = assistant("i'm fine", "stop");
        const q1 = user("sounds great");
        const a1 = assistant("thanks!", "stop");
        const q2 = user("nice");
        const a2 = assistant("cheers", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "m0", parentId: null, timestamp: "t0", message: preQ1 },
            { type: "message", id: "m1", parentId: "m0", timestamp: "t1", message: preA1 },
            { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: preQ2 },
            { type: "message", id: "m3", parentId: "m2", timestamp: "t3", message: preA2 },
            { type: "message", id: "m4", parentId: "m3", timestamp: "t4", message: q1 },
            { type: "message", id: "m5", parentId: "m4", timestamp: "t5", message: a1 },
            { type: "message", id: "m6", parentId: "m5", timestamp: "t6", message: q2 },
            { type: "message", id: "m7", parentId: "m6", timestamp: "t7", message: a2 },
        ];

        const runs = buildPersistedRunsFromSessionEntries(entries, [
            { agentrunid: "run-3", seq: 3 },
            { agentrunid: "run-4", seq: 4 },
        ]);

        expect(runs).toEqual([
            { runId: "run-3", userMessage: q1, responseMessages: [a1], status: "done" },
            { runId: "run-4", userMessage: q2, responseMessages: [a2], status: "done" },
        ]);
    });

    it("reverse-matches correctly when refs equal user messages count", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const q2 = user("q2");
        const a2 = assistant("a2", "stop");
        const q3 = user("q3");
        const a3 = assistant("a3", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "m1", parentId: null, timestamp: "t1", message: q1 },
            { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: a1 },
            { type: "message", id: "m3", parentId: "m2", timestamp: "t3", message: q2 },
            { type: "message", id: "m4", parentId: "m3", timestamp: "t4", message: a2 },
            { type: "message", id: "m5", parentId: "m4", timestamp: "t5", message: q3 },
            { type: "message", id: "m6", parentId: "m5", timestamp: "t6", message: a3 },
        ];

        const runs = buildPersistedRunsFromSessionEntries(entries, [
            { agentrunid: "run-1", seq: 1 },
            { agentrunid: "run-2", seq: 2 },
            { agentrunid: "run-3", seq: 3 },
        ]);

        expect(runs).toEqual([
            { runId: "run-1", userMessage: q1, responseMessages: [a1], status: "done" },
            { runId: "run-2", userMessage: q2, responseMessages: [a2], status: "done" },
            { runId: "run-3", userMessage: q3, responseMessages: [a3], status: "done" },
        ]);
    });

    it("ignores extra refs that have no matching user message (more refs than users)", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "m1", parentId: null, timestamp: "t1", message: q1 },
            { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: a1 },
        ];

        const runs = buildPersistedRunsFromSessionEntries(entries, [
            { agentrunid: "run-stale", seq: 1 },
            { agentrunid: "run-current", seq: 5 },
        ]);

        expect(runs).toEqual([
            { runId: "run-current", userMessage: q1, responseMessages: [a1], status: "done" },
        ]);
    });

    it("drops orphan assistant messages before the first matched user message", () => {
        const orphanQ = user("early");
        const orphanA = assistant("orphan reply", "stop");
        const q1 = user("real question");
        const a1 = assistant("real answer", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "m0", parentId: null, timestamp: "t0", message: orphanQ },
            { type: "message", id: "m1", parentId: "m0", timestamp: "t1", message: orphanA },
            { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: q1 },
            { type: "message", id: "m3", parentId: "m2", timestamp: "t3", message: a1 },
        ];

        const runs = buildPersistedRunsFromSessionEntries(entries, [
            { agentrunid: "run-real", seq: 3 },
        ]);

        expect(runs).toEqual([
            { runId: "run-real", userMessage: q1, responseMessages: [a1], status: "done" },
        ]);
    });
});

describe("buildRunsFromEntryIdJoin", () => {
    it("builds runs by joining on userEntryId, ignoring position", () => {
        const preQ = user("hi");
        const preA = assistant("hello", "stop");
        const q1 = user("real question");
        const a1 = assistant("real answer", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "e0", parentId: null, timestamp: "t0", message: preQ },
            { type: "message", id: "e1", parentId: "e0", timestamp: "t1", message: preA },
            { type: "message", id: "e2", parentId: "e1", timestamp: "t2", message: q1 },
            { type: "message", id: "e3", parentId: "e2", timestamp: "t3", message: a1 },
        ];

        const runs = buildRunsFromEntryIdJoin(entries, new Set(["e2"]));

        expect(runs).toEqual([
            { runId: "e2", userMessage: q1, responseMessages: [a1], status: "done" },
        ]);
    });

    it("creates one run per anchored userEntryId in branch order", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const q2 = user("q2");
        const a2 = assistant("a2", "stop");
        const entries: SessionTreeEntry[] = [
            { type: "message", id: "e1", parentId: null, timestamp: "t1", message: q1 },
            { type: "message", id: "e2", parentId: "e1", timestamp: "t2", message: a1 },
            { type: "message", id: "e3", parentId: "e2", timestamp: "t3", message: q2 },
            { type: "message", id: "e4", parentId: "e3", timestamp: "t4", message: a2 },
        ];

        const runs = buildRunsFromEntryIdJoin(entries, new Set(["e1", "e3"]));

        expect(runs).toEqual([
            { runId: "e1", userMessage: q1, responseMessages: [a1], status: "done" },
            { runId: "e3", userMessage: q2, responseMessages: [a2], status: "done" },
        ]);
    });
});

describe("PaneAgentSession — status tracking", () => {
    it("goes streaming on agent_start and idle on agent_end", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        expect(owner.getSnapshot().status).toBe("idle");
        fake.emit({ type: "agent_start" });
        expect(owner.getSnapshot().status).toBe("streaming");
        fake.emit({ type: "agent_end", messages: [] });
        expect(owner.getSnapshot().status).toBe("idle");
    });

    it("captures an errored assistant turn and keeps status=error through agent_end", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        fake.emit({ type: "agent_start" });
        fake.emit({ type: "message_start", message: assistant("") });
        fake.emit({ type: "message_end", message: assistant("", "error", "rate limited") });
        let snap = owner.getSnapshot();
        expect(snap.status).toBe("error");
        expect(snap.errorMessage).toBe("rate limited");
        // agent_end must not paper over the error with idle.
        fake.emit({ type: "agent_end", messages: [assistant("", "error", "rate limited")] });
        snap = owner.getSnapshot();
        expect(snap.status).toBe("error");
    });
});

describe("PaneAgentSession — queue mirror", () => {
    it("mirrors the steer/followUp queues from queue_update", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        fake.emit({ type: "queue_update", steer: [user("s1")], followUp: [user("f1"), user("f2")] });
        const snap = owner.getSnapshot();
        expect(snap.steerQueue).toHaveLength(1);
        expect(snap.followUpQueue).toHaveLength(2);
    });
});

describe("PaneAgentSession — send routing (no catch-busy)", () => {
    it("first send prompts; a concurrent send queues via followUp", async () => {
        const fake = makeFakeHarness(); // prompt() stays pending → running stays true
        const owner = new PaneAgentSession("/s", fake.pane);
        void owner.send("a");
        void owner.send("b");
        await flush();
        expect(fake.calls.prompt).toEqual(["a"]);
        expect(fake.calls.followUp).toEqual(["b"]);
        expect(owner.getSnapshot().status).toBe("idle");
    });

    it("after the run ends (agent_end), the next send prompts again", async () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
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
        const owner = new PaneAgentSession("/s", fake.pane);
        owner.send("a").catch(() => {});
        await flush();
        const snap = owner.getSnapshot();
        expect(snap.status).toBe("error");
        expect(snap.errorMessage).toBe("boom");
        // running was cleared → the next send prompts (doesn't deadlock on followUp).
        owner.send("b").catch(() => {});
        await flush();
        expect(fake.calls.prompt).toEqual(["a", "b"]);
    });
});

describe("PaneAgentSession — subscriber fan-out", () => {
    it("forwards harness events to subscribers and stops after unsubscribe", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        const seen: string[] = [];
        const unsub = owner.subscribe((e) => seen.push(e.type));
        fake.emit({ type: "agent_start" });
        fake.emit({ type: "message_start", message: user("hi") });
        unsub();
        fake.emit({ type: "agent_end", messages: [] });
        expect(seen).toEqual(["agent_start", "message_start"]);
    });

    it("a subscriber reading getSnapshot() inside its callback sees post-event state", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        let lenAtCallback = -1;
        owner.subscribe(() => {
            lenAtCallback = owner.getSnapshot().messages.length;
        });
        fake.emit({ type: "message_start", message: user("hi") });
        expect(lenAtCallback).toBe(1);
    });

    it("dispose() detaches the harness subscription and aborts", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        owner.dispose();
        expect(fake.listenerCount()).toBe(0);
        expect(fake.calls.abort).toBe(1);
    });
});
