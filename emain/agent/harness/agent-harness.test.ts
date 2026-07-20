// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for AgentHarness. Uses a fake AI provider registered against a
// custom api so prompts resolve without network/credentials.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    type AssistantMessage,
    type Context,
    type Model,
    registerApiProvider,
    resetApiProviders,
    type SimpleStreamOptions,
} from "../../ai";
import { AssistantMessageEventStream } from "../../ai/utils/event-stream";
import { AgentHarness } from "./agent-harness";
import { InMemorySessionRepo } from "./session/memory-repo";
import { NodeExecutionEnv } from "../node";

const FAKE_API = "fake-test-api";

function fakeAssistantMessage(model: Model<any>): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
        api: model.api,
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
    };
}

function registerFakeProvider(capturedContexts?: Context[]): void {
    registerApiProvider({
        api: FAKE_API,
        stream: () => new AssistantMessageEventStream(),
        streamSimple: (model: Model<any>, context: Context, _options?: SimpleStreamOptions) => {
            capturedContexts?.push(context);
            const out = new AssistantMessageEventStream();
            const message = fakeAssistantMessage(model);
            out.push({ type: "start", partial: message });
            out.push({ type: "done", reason: "stop", message });
            return out;
        },
    });
}

function fakeModel(): Model<any> {
    return {
        id: "fake-model",
        name: "Fake Model",
        api: FAKE_API,
        provider: "fake-provider",
        baseUrl: "http://localhost",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
    };
}

async function buildHarness(capturedContexts?: Context[]) {
    registerFakeProvider(capturedContexts);
    const repo = new InMemorySessionRepo();
    const session = await repo.create({});
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const harness = new AgentHarness({
        env,
        session,
        model: fakeModel(),
        thinkingLevel: "off",
        tools: [],
        systemPrompt: "you are a test harness",
    });
    return { harness, session };
}

async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("condition was not reached");
}

describe("AgentHarness — promptReturningEntryId", () => {
    afterEach(() => {
        resetApiProviders();
    });

    it("exposes the user entry id created for a prompt", async () => {
        const { harness, session } = await buildHarness();
        const result = await harness.promptReturningEntryId("hello");
        expect(result.userEntryId).toBeTruthy();
        const branch = await session.getBranch();
        const userEntry = branch.find(
            (e) => e.type === "message" && (e.message as { role?: string }).role === "user",
        );
        expect(result.userEntryId).toBe(userEntry?.id);
    });
});

describe("AgentHarness — lifecycle state", () => {
    afterEach(() => {
        resetApiProviders();
    });

    it("reports idle before and after a prompt", async () => {
        const { harness } = await buildHarness();
        expect(harness.isIdle()).toBe(true);

        const prompt = harness.prompt("hello");
        expect(harness.isIdle()).toBe(false);

        await prompt;
        expect(harness.isIdle()).toBe(true);
    });

    it("prepares a queued follow-up before taking its turn snapshot", async () => {
        const streams: AssistantMessageEventStream[] = [];
        const seenModels: string[] = [];
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (model: Model<any>) => {
                seenModels.push(model.id);
                const stream = new AssistantMessageEventStream();
                streams.push(stream);
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            thinkingLevel: "off",
            tools: [],
            systemPrompt: "you are a test harness",
        });
        const nextModel = { ...fakeModel(), id: "next-model" };
        const prepare = vi.fn(async () => {
            await harness.setModel(nextModel);
        });

        const prompt = harness.prompt("first");
        await waitFor(() => streams.length === 1);
        await harness.followUp("second", undefined, prepare);
        streams[0].push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await waitFor(() => streams.length === 2);

        expect(prepare).toHaveBeenCalledOnce();
        expect(seenModels).toEqual(["fake-model", "next-model"]);

        streams[1].push({ type: "done", reason: "stop", message: fakeAssistantMessage(nextModel) });
        await prompt;
    });
});

describe("AgentHarness — navigateTree to the first message (parentId=null)", () => {
    afterEach(() => {
        resetApiProviders();
    });

    it("navigates to the first user message instead of falling off the tree", async () => {
        const { harness, session } = await buildHarness();
        const first = await harness.promptReturningEntryId("first prompt");
        await harness.prompt("second prompt");

        // Navigating to the very first user message: its parentId is null, so
        // the leaf must fall back to the target entry itself (not null) — the
        // bug was newLeafId = parentId = null, which collapsed the branch.
        const result = await harness.navigateTree(first.userEntryId);
        expect(result.cancelled).toBe(false);
        expect(await session.getLeafId()).toBe(first.userEntryId);

        const branch = await session.getBranch();
        const userMessages = branch.filter(
            (e) => e.type === "message" && (e.message as { role?: string }).role === "user",
        );
        expect(userMessages).toHaveLength(1);
        expect(userMessages[0]?.id).toBe(first.userEntryId);
    });

    it("strips the trailing user message from context so the next prompt has no duplicate", async () => {
        const contexts: Context[] = [];
        const { harness } = await buildHarness(contexts);
        const first = await harness.promptReturningEntryId("first prompt");
        await harness.navigateTree(first.userEntryId);

        contexts.length = 0;
        await harness.prompt("resumed prompt");

        // The leaf sits on the first user message after navigate. createTurnState
        // must strip that trailing user message so executeTurn's freshly-built
        // user message is not duplicated back-to-back in the LLM context.
        expect(contexts).toHaveLength(1);
        const messages = contexts[0]!.messages;
        const userTexts = messages
            .filter((m) => m.role === "user")
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
        expect(userTexts).toEqual([expect.stringContaining("resumed prompt")]);
    });
});
