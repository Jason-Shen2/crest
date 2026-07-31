// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemorySessionRepo } from "@crest/agent/harness/session/memory-repo";
import type { ToolCallEvent } from "@crest/agent/harness/types";
import { registerApiProvider, resetApiProviders, type Model, type SimpleStreamOptions } from "@crest/ai";
import { AssistantMessageEventStream } from "@crest/ai/utils/event-stream";
import { buildAgentHarnessHost } from "./harness-factory";
import type { ToolCallHook } from "./permissions";

function fakeModel(): Model<any> {
    return {
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
    };
}

describe("AgentHarnessHost", () => {
    afterEach(() => resetApiProviders());

    it("exposes the generated system-prompt manifest on preparation snapshots", async () => {
        const session = await new InMemorySessionRepo().create({});
        const host = buildAgentHarnessHost({
            session,
            model: fakeModel(),
            promptInputs: { cwd: "/first" },
            contextFiles: [{ path: "/first/AGENTS.md", content: "Project rule" }],
        });

        const snapshot = await host.harness.createTurnPreparationSnapshot("hello");

        expect(snapshot.systemPrompt).toContain("Project rule");
        expect(snapshot.systemPromptMetadata).toMatchObject({
            text: snapshot.systemPrompt,
            segments: expect.arrayContaining([
                expect.objectContaining({ id: "project:/first/AGENTS.md", kind: "project_instruction" }),
            ]),
        });
    });

    it("threads the session-context transformer into the harness", async () => {
        const session = await new InMemorySessionRepo().create({});
        const transformSessionContext = vi.fn(async ({ context }) => context);
        const host = buildAgentHarnessHost({
            session,
            model: fakeModel(),
            promptInputs: { cwd: "/first" },
            transformSessionContext,
        });

        await host.harness.createTurnPreparationSnapshot("hello");

        expect(transformSessionContext).toHaveBeenCalledTimes(1);
    });

    it("threads provider-context observation through the host boundary", async () => {
        const observation = vi.fn();
        const model = { ...fakeModel(), api: "host-observer-test" } as Model<any>;
        registerApiProvider({
            api: model.api,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (activeModel: Model<any>, _context, options?: SimpleStreamOptions) => {
                const stream = new AssistantMessageEventStream();
                void (async () => {
                    await options?.onPayload?.({ exact: true }, activeModel);
                    const message = {
                        role: "assistant" as const,
                        content: [{ type: "text" as const, text: "done" }],
                        api: activeModel.api,
                        provider: activeModel.provider,
                        model: activeModel.id,
                        stopReason: "stop" as const,
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
                    stream.push({ type: "start", partial: message });
                    stream.push({ type: "done", reason: "stop", message });
                })();
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const host = buildAgentHarnessHost({
            session,
            model,
            promptInputs: { cwd: "/first" },
            observeProviderContext: observation,
        });

        await host.harness.prompt("hello");
        await Promise.resolve();

        expect(observation).toHaveBeenCalledWith(expect.objectContaining({ payload: { exact: true } }));
    });

    it("exposes the current cwd after an execution-context update", async () => {
        const session = await new InMemorySessionRepo().create({});
        const host = buildAgentHarnessHost({
            session,
            model: fakeModel(),
            promptInputs: { cwd: "/first" },
        });

        expect(host.getCwd()).toBe("/first");
        host.update({ cwd: "/second" });
        expect(host.getCwd()).toBe("/second");
    });

    it("updates auth and tool hooks without rebuilding the Harness", async () => {
        const session = await new InMemorySessionRepo().create({});
        const model = fakeModel();
        const toolEvent: ToolCallEvent = {
            type: "tool_call",
            toolCallId: "call-1",
            toolName: "bash",
            input: {},
        };
        const firstAuth = vi.fn(async () => ({ apiKey: "first" }));
        const secondAuth = vi.fn(async () => ({ apiKey: "second" }));
        const firstHook: ToolCallHook = vi.fn(async () => undefined);
        const secondHook: ToolCallHook = vi.fn(async () => ({ block: true, reason: "blocked" }));
        const host = buildAgentHarnessHost({
            session,
            model,
            promptInputs: { cwd: "/a" },
            getApiKeyAndHeaders: firstAuth,
            toolCallHook: firstHook,
        });

        host.setAuthResolver(secondAuth);
        host.setToolCallHook(secondHook);

        await expect(host.resolveAuth(model)).resolves.toEqual({ apiKey: "second" });
        await expect(host.runToolCallHook(toolEvent)).resolves.toEqual({ block: true, reason: "blocked" });
        expect(firstAuth).not.toHaveBeenCalled();
        expect(firstHook).not.toHaveBeenCalled();
    });
});
