// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { PaneHarness } from "./harness-factory";
import { PaneAgentSession } from "./pane-agent-session";
import type { AgentMessage } from "./types";

// Minimal harness double: records prompt/followUp/abort calls and lets a
// test drive the event stream via emit(). Mirrors the only surface
// PaneAgentSession touches.
function makeFakeHarness() {
    const listeners = new Set<(event: unknown) => void>();
    const calls = { prompt: [] as string[], followUp: [] as string[], abort: 0 };
    let promptResult: () => Promise<unknown> = () => new Promise(() => {}); // pending forever by default
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
            return Promise.resolve();
        },
        abort() {
            calls.abort += 1;
            return Promise.resolve({});
        },
    };
    return {
        calls,
        emit(event: unknown) {
            for (const l of listeners) l(event);
        },
        listenerCount: () => listeners.size,
        setPromptResult(fn: () => Promise<unknown>) {
            promptResult = fn;
        },
        pane: { harness, update: vi.fn() } as unknown as PaneHarness,
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

    it("reconciles to the authoritative array on agent_end", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        // Stream a partial, then agent_end hands over the full transcript
        // (e.g. with timestamps assigned) — the owner adopts it wholesale.
        fake.emit({ type: "message_start", message: user("q") });
        const authoritative = [user("q"), assistant("a", "stop")];
        fake.emit({ type: "agent_end", messages: authoritative });
        expect(owner.getSnapshot().messages).toBe(authoritative);
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
    it("first send prompts; a concurrent send queues via followUp", () => {
        const fake = makeFakeHarness(); // prompt() stays pending → running stays true
        const owner = new PaneAgentSession("/s", fake.pane);
        owner.send("a");
        owner.send("b");
        expect(fake.calls.prompt).toEqual(["a"]);
        expect(fake.calls.followUp).toEqual(["b"]);
    });

    it("after the run ends (agent_end), the next send prompts again", () => {
        const fake = makeFakeHarness();
        const owner = new PaneAgentSession("/s", fake.pane);
        owner.send("a");
        fake.emit({ type: "agent_end", messages: [] }); // clears running
        owner.send("c");
        expect(fake.calls.prompt).toEqual(["a", "c"]);
        expect(fake.calls.followUp).toEqual([]);
    });

    it("a prompt rejection clears running and surfaces status=error", async () => {
        const fake = makeFakeHarness();
        fake.setPromptResult(() => Promise.reject(new Error("boom")));
        const owner = new PaneAgentSession("/s", fake.pane);
        owner.send("a");
        await flush();
        const snap = owner.getSnapshot();
        expect(snap.status).toBe("error");
        expect(snap.errorMessage).toBe("boom");
        // running was cleared → the next send prompts (doesn't deadlock on followUp).
        owner.send("b");
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
