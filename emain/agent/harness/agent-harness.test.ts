// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for AgentHarness. Uses a fake AI provider registered against a
// custom api so prompts resolve without network/credentials.

import { afterEach, describe, expect, it } from "vitest";

import {
    type AssistantMessage,
    type Context,
    type Model,
    registerApiProvider,
    resetApiProviders,
    type SimpleStreamOptions,
    AssistantMessageEventStream,
} from "../../ai";
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

function registerFakeProvider(): void {
    registerApiProvider({
        api: FAKE_API,
        stream: () => new AssistantMessageEventStream(),
        streamSimple: (model: Model<any>, _context: Context, _options?: SimpleStreamOptions) => {
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

async function buildHarness() {
    registerFakeProvider();
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
