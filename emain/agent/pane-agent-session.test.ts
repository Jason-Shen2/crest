// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { PaneHarness } from "./harness-factory";
import {
    AgentRunSessionEntryType,
    buildPersistedRunsFromSessionEntries,
    buildPersistedRunsFromTimeline,
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

    it("navigates the session tree without branch summarization", async () => {
        const fake = makeFakeHarness();
        fake.setNavigateTreeResult(() => Promise.resolve({ cancelled: false, editorText: "edit this" }));
        const owner = new PaneAgentSession("/s", fake.pane);

        const result = await owner.navigateTree("entry-1");

        expect(fake.calls.navigateTree).toEqual([{ targetId: "entry-1", options: { summarize: false } }]);
        expect(result).toEqual({ editorText: "edit this" });
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
    it("builds a completed run keyed by the main-owned run id", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        const q = user("hello");
        const partial = assistant("hel");
        const final = assistant("hello back", "stop");

        owner.send("run-a", "hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_start", message: partial });
        fake.emit({ type: "message_end", message: final });
        fake.emit({ type: "agent_end", messages: [q, final] });

        expect(owner.getSnapshot().runs).toEqual([
            {
                runId: "run-a",
                userMessage: q,
                responseMessages: [final],
                status: "done",
            },
        ]);
    });

    it("records the run boundary in the session before starting the prompt", async () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);

        owner.send("run-a", "hello");
        await flush();

        expect(fake.calls.custom).toEqual([{ customType: AgentRunSessionEntryType, data: { runId: "run-a" } }]);
        expect(fake.calls.prompt).toEqual(["hello"]);
    });

    it("marks the active run errored from an errored assistant message", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        const q = user("hello");
        const final = assistant("", "error", "rate limited");

        owner.send("run-err", "hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_start", message: assistant("") });
        fake.emit({ type: "message_end", message: final });

        expect(owner.getSnapshot().runs).toEqual([
            {
                runId: "run-err",
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

        owner.send("run-a", "hello");
        fake.emit({ type: "message_start", message: q });
        fake.emit({ type: "message_start", message: assistant("hel") });
        fake.emit({ type: "message_end", message: final });
        fake.emit({ type: "agent_end", messages: [q, final] });

        expect(onRunFinished).toHaveBeenCalledWith({
            runId: "run-a",
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

        owner.send("run-a", "hello");
        fake.emit({ type: "message_start", message: user("hello") });
        fake.emit({ type: "message_start", message: assistant("hello back") });
        fake.emit({ type: "message_end", message: assistant("hello back", "stop") });
        fake.emit({ type: "agent_end", messages: [] });
        owner.setRunChangeOutline("run-a", {
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

    it("rebuilds runs from session run-boundary entries instead of inferring from user-message position", () => {
        const q1 = user("q1");
        const a1 = assistant("a1", "stop");
        const q2 = user("q2");
        const a2 = assistant("a2", "stop");
        const entries: SessionTreeEntry[] = [
            {
                type: "custom",
                id: "run-entry-1",
                parentId: null,
                timestamp: "2026-01-01T00:00:00.000Z",
                customType: AgentRunSessionEntryType,
                data: { runId: "run-1" },
            },
            { type: "message", id: "m1", parentId: "run-entry-1", timestamp: "2026-01-01T00:00:01.000Z", message: q1 },
            { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: a1 },
            {
                type: "custom",
                id: "run-entry-2",
                parentId: "m2",
                timestamp: "2026-01-01T00:00:03.000Z",
                customType: AgentRunSessionEntryType,
                data: { runId: "run-2" },
            },
            { type: "message", id: "m3", parentId: "run-entry-2", timestamp: "2026-01-01T00:00:04.000Z", message: q2 },
            { type: "message", id: "m4", parentId: "m3", timestamp: "2026-01-01T00:00:05.000Z", message: a2 },
        ];

        const runs = buildPersistedRunsFromSessionEntries(entries, [
            { agentrunid: "wrong-positional-run-1", seq: 1 },
            { agentrunid: "wrong-positional-run-2", seq: 2 },
        ]);

        expect(runs).toEqual([
            { runId: "run-1", userMessage: q1, responseMessages: [a1], status: "done" },
            { runId: "run-2", userMessage: q2, responseMessages: [a2], status: "done" },
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
        owner.send("run-a", "a");
        owner.send("run-b", "b");
        await flush();
        expect(fake.calls.prompt).toEqual(["a"]);
        expect(fake.calls.followUp).toEqual(["b"]);
        expect(owner.getSnapshot().status).toBe("idle");
    });

    it("after the run ends (agent_end), the next send prompts again", async () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        owner.send("run-a", "a");
        fake.emit({ type: "agent_end", messages: [] }); // clears running
        owner.send("run-c", "c");
        await flush();
        expect(fake.calls.prompt).toEqual(["a", "c"]);
        expect(fake.calls.followUp).toEqual([]);
    });

    it("a prompt rejection clears running and surfaces status=error", async () => {
        const fake = makeFakeHarness();
        fake.setPromptResult(() => Promise.reject(new Error("boom")));
        const owner = new PaneAgentSession("/s", fake.pane);
        owner.send("run-a", "a");
        await flush();
        const snap = owner.getSnapshot();
        expect(snap.status).toBe("error");
        expect(snap.errorMessage).toBe("boom");
        // running was cleared → the next send prompts (doesn't deadlock on followUp).
        owner.send("run-b", "b");
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
