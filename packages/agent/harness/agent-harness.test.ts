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
} from "@crest/ai";
import { AssistantMessageEventStream } from "@crest/ai/utils/event-stream";
import type { AgentMessage, AgentTool } from "../types";
import { AgentHarness } from "./agent-harness";
import { InMemorySessionRepo } from "./session/memory-repo";
import { NodeExecutionEnv } from "../node";
import { Type } from "typebox";
import { AgentHarnessTerminalPreparationError, type AgentHarnessProviderContextObservation } from "./types";

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

    it("returns the precommitted user entry id for a prepared prompt", async () => {
        const { harness, session } = await buildHarness();
        let preparedUserEntryId = "";

        const result = await harness.promptReturningEntryId("hello", {
            prepare: async (input) => {
                await session.appendCustomEntry("prepared_manifest", {});
                preparedUserEntryId = await session.appendMessage(input.userMessage);
                return { userEntryId: preparedUserEntryId, systemPromptSuffix: "prepared" };
            },
        });

        expect(result.userEntryId).toBe(preparedUserEntryId);
    });
});

describe("AgentHarness — structured system prompt", () => {
    afterEach(() => {
        resetApiProviders();
    });

    it("retains prompt metadata while exposing only text to turn preparation", async () => {
        registerFakeProvider();
        const session = await new InMemorySessionRepo().create({});
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            tools: [],
            systemPrompt: () => ({
                text: "structured prompt",
                metadata: { source: "manifest" },
            }),
        });

        const snapshot = await harness.createTurnPreparationSnapshot("hello");

        expect(snapshot.systemPrompt).toBe("structured prompt");
        expect(snapshot.systemPromptMetadata).toEqual({ source: "manifest" });
    });

    it("keeps string prompt callbacks compatible", async () => {
        registerFakeProvider();
        const session = await new InMemorySessionRepo().create({});
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            tools: [],
            systemPrompt: () => "plain prompt",
        });

        const snapshot = await harness.createTurnPreparationSnapshot("hello");

        expect(snapshot.systemPrompt).toBe("plain prompt");
        expect(snapshot.systemPromptMetadata).toBeUndefined();
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

    it("builds and decorates context from one branch snapshot", async () => {
        registerFakeProvider();
        const session = await new InMemorySessionRepo().create({});
        const branchEntry = {
            type: "message" as const,
            id: "branch-assistant",
            parentId: null,
            timestamp: "2026-07-25T00:00:00.000Z",
            message: fakeAssistantMessage(fakeModel()),
        };
        const buildContext = vi.spyOn(session, "buildContext").mockResolvedValue({
            messages: [fakeAssistantMessage(fakeModel())],
            messageEntryIds: ["stale-assistant"],
            thinkingLevel: "off",
            model: null,
        });
        vi.spyOn(session, "getBranch").mockResolvedValueOnce([branchEntry]);
        const seen: Array<{ entryIds: string[]; messageEntryIds: Array<string | undefined> }> = [];
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            thinkingLevel: "off",
            tools: [],
            systemPrompt: "base",
            transformSessionContext: async ({ entries, context }) => {
                seen.push({
                    entryIds: entries.map((entry) => entry.id),
                    messageEntryIds: context.messageEntryIds,
                });
                return context;
            },
        });

        await harness.prompt("hello");

        expect(buildContext).not.toHaveBeenCalled();
        expect(seen[0]).toEqual({ entryIds: ["branch-assistant"], messageEntryIds: ["branch-assistant"] });
        expect(seen.every((item) => item.messageEntryIds.every((id) => id == null || item.entryIds.includes(id)))).toBe(
            true
        );
    });

    it("takes a fresh turn snapshot for an unprepared queued follow-up", async () => {
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
        const prompt = harness.prompt("first");
        await waitFor(() => streams.length === 1);
        await harness.setModel(nextModel);
        await harness.followUp("second");
        streams[0].push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await waitFor(() => streams.length === 2);

        expect(seenModels).toEqual(["fake-model", "next-model"]);

        streams[1].push({ type: "done", reason: "stop", message: fakeAssistantMessage(nextModel) });
        await prompt;
    });
});

describe("AgentHarness — prepared turns", () => {
    afterEach(() => {
        resetApiProviders();
    });

    it("reuses the exact authoritatively counted payload after token-bearing provider hooks", async () => {
        const sentPayloads: unknown[] = [];
        const sentContexts: Context[] = [];
        const sentRequestMetadata: unknown[] = [];
        const requestHook = vi.fn(async () => ({ streamOptions: { metadata: { counted: true } } }));
        const contextHook = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
            messages: [
                ...messages,
                { role: "user" as const, content: [{ type: "text" as const, text: "hook-added" }], timestamp: 1 },
            ],
        }));
        const tokenBearingHook = vi.fn(async ({ payload }: { payload: unknown }) => ({
            payload: { ...(payload as object), prompt_cache_key: "cache-key" },
        }));
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
                const stream = new AssistantMessageEventStream();
                void (async () => {
                    sentContexts.push(context);
                    sentRequestMetadata.push(options?.metadata);
                    const builtPayload = { model: model.id, input: "provider-built" };
                    const transformed = await options?.onPayload?.(builtPayload, model);
                    sentPayloads.push(transformed ?? builtPayload);
                    const message = fakeAssistantMessage(model);
                    stream.push({ type: "start", partial: message });
                    stream.push({ type: "done", reason: "stop", message });
                })();
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
            systemPrompt: "base",
        });
        harness.on("before_provider_request", requestHook);
        harness.on("context", contextHook);
        harness.on("before_provider_payload", tokenBearingHook);
        let countedPayload: unknown;
        let countedMessages: AgentMessage[] = [];
        let countedRequestOptions: unknown;

        await harness.prompt("hello", {
            prepare: async (input) => {
                countedRequestOptions = await input.transformProviderRequest();
                countedMessages = await input.transformContextMessages(input.messages);
                countedPayload = await input.transformProviderPayload({
                    model: input.model.id,
                    input: "provider-built",
                    system: `${input.systemPrompt}\n\noverlay`,
                });
                return {
                    userEntryId: await session.appendMessage(input.userMessage),
                    systemPromptSuffix: "overlay",
                    finalProviderRequestOptions: countedRequestOptions as never,
                    transformedContextMessages: countedMessages,
                    finalProviderPayload: countedPayload,
                };
            },
        });

        expect(requestHook).toHaveBeenCalledTimes(1);
        expect(contextHook).toHaveBeenCalledTimes(1);
        expect(tokenBearingHook).toHaveBeenCalledTimes(1);
        expect(sentContexts[0]!.messages).toEqual(countedMessages);
        expect(sentRequestMetadata).toEqual([{ counted: true }]);
        expect(sentPayloads).toHaveLength(1);
        expect(sentPayloads[0]).toBe(countedPayload);
    });

    it("observes the final provider context and payload with durable message identities", async () => {
        const observations: unknown[] = [];
        const contextHook = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
            messages: [
                ...messages.map((message) => ({ ...message })),
                { role: "user" as const, content: [{ type: "text" as const, text: "synthetic" }], timestamp: 2 },
            ],
        }));
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
                const stream = new AssistantMessageEventStream();
                void (async () => {
                    await options?.onPayload?.({ provider: "built" }, model);
                    const message = fakeAssistantMessage(model);
                    stream.push({ type: "start", partial: message });
                    stream.push({ type: "done", reason: "stop", message });
                })();
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const priorEntryId = await session.appendMessage({
            role: "user",
            content: [{ type: "text", text: "prior" }],
            timestamp: 1,
        });
        await session.appendMessage(fakeAssistantMessage(fakeModel()));
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            tools: [],
            systemPrompt: () => ({ text: "structured prompt", metadata: { source: "manifest" } }),
            streamOptions: { metadata: { request: "final" } },
            observeProviderContext: (observation) => {
                observations.push(observation);
            },
        });
        harness.on("context", contextHook);
        harness.on("before_provider_payload", async ({ payload }: { payload: unknown }) => ({
            payload: { ...(payload as object), transformed: true },
        }));

        await harness.prompt("current");
        await Promise.resolve();

        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({
            model: { id: "fake-model" },
            sessionId: expect.any(String),
            leafId: expect.any(String),
            systemPrompt: "structured prompt",
            systemPromptMetadata: { source: "manifest" },
            requestOptions: { metadata: { request: "final" } },
            payload: { provider: "built", transformed: true },
        });
        const observation = observations[0] as { messages: AgentMessage[]; messageEntryIds: Array<string | undefined> };
        expect(observation.messages.at(-1)).toMatchObject({ role: "user", content: [{ text: "synthetic" }] });
        expect(observation.messageEntryIds).toContain(priorEntryId);
        expect(observation.messageEntryIds.at(-1)).toBeUndefined();
    });

    it("observes entries committed by semantic turn preparation", async () => {
        const observations: AgentHarnessProviderContextObservation[] = [];
        let blockObservationRead = false;
        let observationReadStarted = false;
        let providerPayloadReturned = false;
        let releaseObservationRead!: () => void;
        const observationReadGate = new Promise<void>((resolve) => {
            releaseObservationRead = resolve;
        });
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
                const stream = new AssistantMessageEventStream();
                void (async () => {
                    blockObservationRead = true;
                    await options?.onPayload?.({ provider: "built" }, model);
                    providerPayloadReturned = true;
                    stream.push({ type: "done", reason: "stop", message: fakeAssistantMessage(model) });
                })();
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            tools: [],
            observeProviderContext: (observation) => {
                observations.push(observation);
            },
        });
        const originalGetBranch = session.getBranch.bind(session);
        vi.spyOn(session, "getBranch").mockImplementation(async () => {
            if (blockObservationRead) {
                observationReadStarted = true;
                await observationReadGate;
            }
            return await originalGetBranch();
        });
        let markerId = "";
        let userEntryId = "";

        const prompt = harness.prompt("prepared", {
            prepare: async (input) => {
                markerId = await session.appendCustomEntry("context_attachment", { source: "prepared" });
                userEntryId = await session.appendMessage(input.userMessage);
                return { userEntryId, systemPromptSuffix: "prepared context" };
            },
        });
        try {
            await waitFor(() => observationReadStarted);
            expect(providerPayloadReturned).toBe(true);
        } finally {
            releaseObservationRead();
            await prompt;
        }
        await waitFor(() => observations.length === 1);

        expect(observations).toHaveLength(1);
        expect(observations[0]!.entries.map((entry) => entry.id)).toEqual(
            expect.arrayContaining([markerId, userEntryId])
        );
    });

    it("isolates provider-context observation failures from the provider stream", async () => {
        const diagnostic = vi.fn();
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
                const stream = new AssistantMessageEventStream();
                void (async () => {
                    await options?.onPayload?.({ provider: "built" }, model);
                    const message = fakeAssistantMessage(model);
                    stream.push({ type: "start", partial: message });
                    stream.push({ type: "done", reason: "stop", message });
                })();
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            tools: [],
            observeProviderContext: () => {
                throw new Error("inspection failed");
            },
            onProviderContextObservationError: diagnostic,
        });

        await expect(harness.prompt("hello")).resolves.toMatchObject({ role: "assistant" });
        await Promise.resolve();

        expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ message: "inspection failed" }));
    });

    it("consumes generic prepared request and payload receipts without a transformed context receipt", async () => {
        const sentRequestMetadata: unknown[] = [];
        const sentPayloads: unknown[] = [];
        const requestHook = vi.fn(async () => ({ streamOptions: { metadata: { unexpected: true } } }));
        const contextHook = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({ messages }));
        const payloadHook = vi.fn(async ({ payload }: { payload: unknown }) => ({ payload }));
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
                const stream = new AssistantMessageEventStream();
                void (async () => {
                    sentRequestMetadata.push(options?.metadata);
                    sentPayloads.push(await options?.onPayload?.({ provider: "built" }, model));
                    const message = fakeAssistantMessage(model);
                    stream.push({ type: "start", partial: message });
                    stream.push({ type: "done", reason: "stop", message });
                })();
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            tools: [],
        });
        harness.on("before_provider_request", requestHook);
        harness.on("context", contextHook);
        harness.on("before_provider_payload", payloadHook);
        const preparedPayload = { prepared: true };

        await harness.prompt("hello", {
            prepare: async (input) => ({
                userEntryId: await session.appendMessage(input.userMessage),
                systemPromptSuffix: "",
                finalProviderRequestOptions: { metadata: { prepared: true } },
                finalProviderPayload: preparedPayload,
            }),
        });

        expect(contextHook).toHaveBeenCalledOnce();
        expect(requestHook).not.toHaveBeenCalled();
        expect(payloadHook).not.toHaveBeenCalled();
        expect(sentRequestMetadata).toEqual([{ prepared: true }]);
        expect(sentPayloads).toEqual([preparedPayload]);
    });

    it("prepares the initial prompt before the provider request and reuses its user entry", async () => {
        const contexts: Context[] = [];
        let requestCount = 0;
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
                contexts.push(context);
                const stream = new AssistantMessageEventStream();
                void (async () => {
                    await options?.onPayload?.({ request: requestCount }, model);
                    const isToolRequest = requestCount++ === 0;
                    const message =
                        isToolRequest
                            ? {
                                  ...fakeAssistantMessage(model),
                                  content: [
                                      { type: "toolCall" as const, id: "call-1", name: "lookup", arguments: {} },
                                  ],
                                  stopReason: "toolUse" as const,
                              }
                            : fakeAssistantMessage(model);
                    stream.push({ type: "start", partial: message });
                    stream.push({ type: "done", reason: isToolRequest ? "toolUse" : "stop", message });
                })();
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const historyUser = {
            role: "user" as const,
            content: [{ type: "text" as const, text: "earlier question" }],
            timestamp: Date.now(),
        };
        const historyAssistant = fakeAssistantMessage(fakeModel());
        await session.appendMessage(historyUser);
        await session.appendMessage(historyAssistant);
        const tool: AgentTool = {
            name: "lookup",
            label: "Lookup",
            description: "Looks something up",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "found" }], details: {} }),
        };
        const model = fakeModel();
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model,
            thinkingLevel: "off",
            tools: [tool],
            systemPrompt: "ordinary system prompt",
        });
        const requestHook = vi.fn(async () => ({ streamOptions: { metadata: { hook: true } } }));
        const contextHook = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({ messages }));
        const payloadHook = vi.fn(async ({ payload }: { payload: unknown }) => ({ payload }));
        harness.on("before_provider_request", requestHook);
        harness.on("context", contextHook);
        harness.on("before_provider_payload", payloadHook);
        const userEnds: Array<{ entryId?: string }> = [];
        harness.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "user") {
                userEnds.push({ entryId: event.entryId });
            }
        });
        const prepare = vi.fn(async (input) => {
            expect(input.systemPrompt).toBe("ordinary system prompt");
            expect(input.messages).toEqual([historyUser, historyAssistant, input.userMessage]);
            expect(input.userMessage.role).toBe("user");
            expect(input.model).toBe(model);
            expect(input.activeTools).toEqual([tool]);
            const userEntryId = await session.appendMessage(input.userMessage);
            const finalProviderRequestOptions = await input.transformProviderRequest();
            const transformedContextMessages = await input.transformContextMessages(input.messages);
            const finalProviderPayload = await input.transformProviderPayload({ request: 0 });
            return {
                userEntryId,
                systemPromptSuffix: "prepared overlay",
                finalProviderRequestOptions,
                transformedContextMessages,
                finalProviderPayload,
            };
        });

        await harness.prompt("hello", { prepare });

        expect(prepare).toHaveBeenCalledOnce();
        expect(requestHook).toHaveBeenCalledTimes(2);
        expect(contextHook).toHaveBeenCalledTimes(2);
        expect(payloadHook).toHaveBeenCalledTimes(2);
        expect(contexts).toHaveLength(2);
        for (const context of contexts) {
            expect(context.systemPrompt).toBe("ordinary system prompt\n\nprepared overlay");
            expect(context.systemPrompt.match(/prepared overlay/g)).toHaveLength(1);
        }
        const branch = await session.getBranch();
        const messageEntries = branch.filter((entry) => entry.type === "message");
        expect(messageEntries.map((entry) => entry.message.role)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
            "toolResult",
            "assistant",
        ]);
        const currentUserEntries = messageEntries.filter(
            (entry) =>
                entry.message.role === "user" &&
                Array.isArray(entry.message.content) &&
                entry.message.content.some((content) => content.type === "text" && content.text === "hello"),
        );
        expect(currentUserEntries).toHaveLength(1);
        expect(userEnds).toEqual([{ entryId: currentUserEntries[0]!.id }]);
    });

    it("activates queued config before taking the semantic preparation snapshot", async () => {
        const streams: AssistantMessageEventStream[] = [];
        const providerModels: string[] = [];
        const contexts: Context[] = [];
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (model: Model<any>, context: Context) => {
                providerModels.push(model.id);
                contexts.push(context);
                const stream = new AssistantMessageEventStream();
                streams.push(stream);
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        let systemPrompt = "system one";
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            thinkingLevel: "off",
            tools: [],
            systemPrompt: () => systemPrompt,
        });
        const nextModel = { ...fakeModel(), id: "next-model" };
        const preparedSnapshots: Array<{ model: string; systemPrompt: string }> = [];
        const prompt = harness.prompt("first");
        await waitFor(() => streams.length === 1);
        await harness.followUp(
            "second",
            {
                activate: async () => {
                    systemPrompt = "system two";
                    await harness.setModel(nextModel);
                },
            },
            async (input) => {
                preparedSnapshots.push({ model: input.model.id, systemPrompt: input.systemPrompt });
                const userEntryId = await session.appendMessage(input.userMessage);
                return { userEntryId, systemPromptSuffix: "prepared overlay" };
            },
        );

        streams[0]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await waitFor(() => streams.length === 2);

        expect(preparedSnapshots).toEqual([{ model: "next-model", systemPrompt: "system two" }]);
        expect(providerModels).toEqual(["fake-model", "next-model"]);
        expect(contexts[1]!.systemPrompt).toBe("system two\n\nprepared overlay");

        streams[1]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(nextModel) });
        await prompt;
    });

    it("does not request the provider when initial preparation fails", async () => {
        const contexts: Context[] = [];
        const { harness } = await buildHarness(contexts);

        await expect(
            harness.prompt("hello", {
                prepare: async () => {
                    throw new Error("cannot prepare");
                },
            }),
        ).rejects.toThrow("cannot prepare");
        expect(contexts).toEqual([]);
    });

    it("returns to idle when an automatically promoted follow-up fails activation", async () => {
        const { harness } = await buildHarness();
        let preparationStarted = false;
        let releasePreparation!: () => void;
        const preparationGate = new Promise<void>((resolve) => {
            releasePreparation = resolve;
        });
        const prompt = harness.prompt("failed initial", {
            prepare: async () => {
                preparationStarted = true;
                await preparationGate;
                throw new AgentHarnessTerminalPreparationError(new Error("terminal initial failure"));
            },
        });
        await waitFor(() => preparationStarted);
        await harness.followUp("promoted", {
            activate: async () => {
                throw new Error("promoted activation failed");
            },
        });

        releasePreparation();

        await expect(prompt).rejects.toThrow("promoted activation failed");
        expect(harness.isIdle()).toBe(true);
    });

    it("promotes a queued follow-up whose user message uses string content", async () => {
        const contexts: Context[] = [];
        const { harness } = await buildHarness(contexts);
        let preparationStarted = false;
        let releasePreparation!: () => void;
        const preparationGate = new Promise<void>((resolve) => {
            releasePreparation = resolve;
        });
        const prompt = harness.prompt("failed initial", {
            prepare: async () => {
                preparationStarted = true;
                await preparationGate;
                throw new AgentHarnessTerminalPreparationError(new Error("terminal initial failure"));
            },
        });
        await waitFor(() => preparationStarted);
        await harness.followUp("promoted");
        const queuedHarness = harness as unknown as {
            followUpQueue: Array<{ content: string | unknown[] }>;
        };
        queuedHarness.followUpQueue[0]!.content = "promoted string content";

        releasePreparation();
        await prompt;

        expect(contexts).toHaveLength(1);
        expect(contexts[0]!.messages.at(-1)).toEqual(
            expect.objectContaining({ role: "user", content: "promoted string content" }),
        );
    });

    it("requeues a failed prepared follow-up together with its preparation", async () => {
        const streams: AssistantMessageEventStream[] = [];
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (model: Model<any>) => {
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
            tools: [],
        });
        let prepareAttempts = 0;
        const prepare = vi.fn(async (input) => {
            prepareAttempts++;
            if (prepareAttempts === 1) throw new Error("follow-up preparation failed");
            return {
                userEntryId: await session.appendMessage(input.userMessage),
                systemPromptSuffix: "retried overlay",
            };
        });

        const prompt = harness.prompt("first");
        await waitFor(() => streams.length === 1);
        await harness.followUp("second", undefined, prepare);
        streams[0]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await prompt;

        expect(prepare).toHaveBeenCalledOnce();
        expect(streams).toHaveLength(1);
        const retry = harness.prompt("retry");
        await waitFor(() => streams.length === 2);
        streams[1]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await waitFor(() => streams.length === 3);
        streams[2]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await retry;

        expect(prepare).toHaveBeenCalledTimes(2);
        const aborted = await harness.abort();
        expect(aborted.clearedFollowUp).toEqual([]);
    });

    it("processes prepared follow-ups one at a time even in all mode", async () => {
        const streams: AssistantMessageEventStream[] = [];
        const contexts: Context[] = [];
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (_model: Model<any>, context: Context) => {
                contexts.push(context);
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
            tools: [],
            followUpMode: "all",
            systemPrompt: "base",
        });
        const userEnds: Array<{ entryId?: string }> = [];
        harness.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "user") {
                userEnds.push({ entryId: event.entryId });
            }
        });
        const prepare = (suffix: string) =>
            vi.fn(async (input) => ({
                userEntryId: await session.appendMessage(input.userMessage),
                systemPromptSuffix: suffix,
            }));
        const prepareSecond = prepare("second overlay");
        const prepareThird = prepare("third overlay");

        const prompt = harness.prompt("first");
        await waitFor(() => streams.length === 1);
        await harness.followUp("second", undefined, prepareSecond);
        await harness.followUp("third", undefined, prepareThird);
        streams[0]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await waitFor(() => streams.length === 2);

        expect(prepareSecond).toHaveBeenCalledOnce();
        expect(prepareThird).not.toHaveBeenCalled();
        expect(prepareSecond.mock.calls[0]![0].messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user",
        ]);
        expect(contexts[1]!.messages).toEqual(prepareSecond.mock.calls[0]![0].messages);
        expect(contexts[1]!.systemPrompt).toBe("base\n\nsecond overlay");
        expect(contexts[1]!.systemPrompt.match(/second overlay/g)).toHaveLength(1);
        streams[1]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await waitFor(() => streams.length === 3);

        expect(prepareThird).toHaveBeenCalledOnce();
        expect(prepareThird.mock.calls[0]![0].messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
            "user",
        ]);
        expect(contexts[2]!.messages).toEqual(prepareThird.mock.calls[0]![0].messages);
        expect(contexts[2]!.systemPrompt).toBe("base\n\nthird overlay");
        expect(contexts[2]!.systemPrompt.match(/third overlay/g)).toHaveLength(1);
        expect(contexts[2]!.systemPrompt).not.toContain("second overlay");
        streams[2]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await prompt;

        const userEntries = (await session.getBranch()).filter(
            (entry) => entry.type === "message" && entry.message.role === "user",
        );
        expect(userEntries).toHaveLength(3);
        expect(userEnds).toEqual(userEntries.map((entry) => ({ entryId: entry.id })));
    });

    it("prepares from the hook-adjusted provider base request", async () => {
        const contexts: Context[] = [];
        const providerModels: Model<any>[] = [];
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: (model: Model<any>, context: Context) => {
                providerModels.push(model);
                contexts.push(context);
                const stream = new AssistantMessageEventStream();
                const message = fakeAssistantMessage(model);
                stream.push({ type: "start", partial: message });
                stream.push({ type: "done", reason: "stop", message });
                return stream;
            },
        });
        const session = await new InMemorySessionRepo().create({});
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            tools: [],
            systemPrompt: "ordinary system prompt",
        });
        const hookModel = { ...fakeModel(), id: "hook-model" };
        const hookTool: AgentTool = {
            name: "hook-tool",
            label: "Hook Tool",
            description: "Hook tool",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
        };
        const hookMessage = fakeAssistantMessage(fakeModel());
        harness.on("before_agent_start", async () => {
            await harness.setModel(hookModel);
            await harness.setTools([hookTool], [hookTool.name]);
            return {
                systemPrompt: "hook system prompt",
                messages: [hookMessage],
            };
        });
        const prepare = vi.fn(async (input) => {
            expect(input.systemPrompt).toBe("hook system prompt");
            expect(input.messages).toEqual([input.userMessage, hookMessage]);
            expect(input.model).toBe(hookModel);
            expect(input.activeTools).toEqual([hookTool]);
            return {
                userEntryId: await session.appendMessage(input.userMessage),
                systemPromptSuffix: "hook overlay",
            };
        });

        await harness.prompt("hello", { prepare });

        expect(prepare).toHaveBeenCalledOnce();
        expect(contexts).toHaveLength(1);
        expect(contexts[0]!.messages).toEqual(prepare.mock.calls[0]![0].messages);
        expect(contexts[0]!.systemPrompt).toBe("hook system prompt\n\nhook overlay");
        expect(contexts[0]!.tools).toEqual([hookTool]);
        expect(providerModels).toEqual([hookModel]);
    });

    it("rejects a prepared prompt while preserving pending next-turn messages", async () => {
        const contexts: Context[] = [];
        registerFakeProvider(contexts);
        const repo = new InMemorySessionRepo();
        const session = await repo.create({});
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: process.cwd() }),
            session,
            model: fakeModel(),
            tools: [],
        });
        const eventTexts: string[] = [];
        harness.subscribe((event) => {
            if (event.type !== "message_end" || event.message.role !== "user") return;
            const content = event.message.content;
            eventTexts.push(
                typeof content === "string"
                    ? content
                    : content.filter((item) => item.type === "text").map((item) => item.text).join(""),
            );
        });
        await harness.nextTurn("queued first");

        await expect(
            harness.prompt("prepared second", {
                prepare: async (input) => ({
                    userEntryId: await session.appendMessage(input.userMessage),
                    systemPromptSuffix: "overlay",
                }),
            }),
        ).rejects.toMatchObject({ code: "invalid_state" });

        expect(contexts).toEqual([]);
        expect(eventTexts).toEqual([]);
        expect(await session.getBranch()).toEqual([]);

        await harness.prompt("ordinary second");

        const providerTexts = contexts[0]!.messages
            .filter((message) => message.role === "user")
            .map((message) =>
                typeof message.content === "string"
                    ? message.content
                    : message.content.filter((item) => item.type === "text").map((item) => item.text).join(""),
            );
        const reopened = await repo.open(await session.getMetadata());
        const branchTexts = (await reopened.getBranch()).flatMap((entry) => {
            if (entry.type !== "message" || entry.message.role !== "user") return [];
            return typeof entry.message.content === "string"
                ? [entry.message.content]
                : [entry.message.content.filter((item) => item.type === "text").map((item) => item.text).join("")];
        });
        expect(providerTexts).toEqual(["queued first", "ordinary second"]);
        expect(eventTexts).toEqual(providerTexts);
        expect(branchTexts).toEqual(providerTexts);
    });

    it("does not start a provider request after an initial preparation is aborted", async () => {
        const contexts: Context[] = [];
        const { harness, session } = await buildHarness(contexts);
        let preparedUserEntryId = "";
        let preparationStarted = false;
        const userEnds: string[] = [];
        harness.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "user" && event.entryId) {
                userEnds.push(event.entryId);
            }
        });
        const prompt = harness
            .prompt("aborted", {
                prepare: async (input) => {
                    preparationStarted = true;
                    await new Promise<void>((resolve) => {
                        input.signal?.addEventListener("abort", () => resolve(), { once: true });
                        setTimeout(resolve, 10);
                    });
                    preparedUserEntryId = await session.appendMessage(input.userMessage);
                    return { userEntryId: preparedUserEntryId, systemPromptSuffix: "overlay" };
                },
            })
            .catch((error) => error);
        await waitFor(() => preparationStarted);

        await harness.abort();
        await prompt;

        expect(contexts).toEqual([]);
        await harness.prompt("after abort");
        expect(contexts).toHaveLength(1);
        expect(userEnds).toHaveLength(1);
        expect(userEnds[0]).not.toBe(preparedUserEntryId);
    });

    it("clears an in-flight prepared follow-up without starting its provider request", async () => {
        const streams: AssistantMessageEventStream[] = [];
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: () => {
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
            tools: [],
        });
        let preparationStarted = false;
        let preparedUserEntryId = "";
        const userEntryIds: string[] = [];
        harness.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "user" && event.entryId) {
                userEntryIds.push(event.entryId);
            }
        });
        const prompt = harness.prompt("first");
        await waitFor(() => streams.length === 1);
        await harness.followUp("blocked follow-up", undefined, async (input) => {
            preparationStarted = true;
            await new Promise<void>((resolve) => {
                input.signal?.addEventListener("abort", () => resolve(), { once: true });
                setTimeout(resolve, 10);
            });
            preparedUserEntryId = await session.appendMessage(input.userMessage);
            return {
                userEntryId: preparedUserEntryId,
                systemPromptSuffix: "overlay",
            };
        });
        streams[0]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await waitFor(() => preparationStarted);

        const aborted = await harness.abort();
        await prompt;

        expect(streams).toHaveLength(1);
        expect(aborted.clearedFollowUp).toHaveLength(1);
        expect((await harness.abort()).clearedFollowUp).toEqual([]);
        const afterAbort = harness.prompt("after abort");
        await waitFor(() => streams.length === 2);
        streams[1]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await afterAbort;
        expect(userEntryIds).toHaveLength(2);
        expect(userEntryIds[1]).not.toBe(preparedUserEntryId);
    });

    it("stops a follow-up aborted during activation before semantic preparation or provider request", async () => {
        const streams: AssistantMessageEventStream[] = [];
        registerApiProvider({
            api: FAKE_API,
            stream: () => new AssistantMessageEventStream(),
            streamSimple: () => {
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
            tools: [],
        });
        let activationStarted = false;
        const prepare = vi.fn(async (input) => ({
            userEntryId: await session.appendMessage(input.userMessage),
            systemPromptSuffix: "must not be used",
        }));
        const prompt = harness.prompt("first");
        await waitFor(() => streams.length === 1);
        await harness.followUp(
            "blocked follow-up",
            {
                activate: async (signal) => {
                    activationStarted = true;
                    await new Promise<void>((resolve) => {
                        signal?.addEventListener("abort", () => resolve(), { once: true });
                    });
                },
            },
            prepare,
        );
        streams[0]!.push({ type: "done", reason: "stop", message: fakeAssistantMessage(fakeModel()) });
        await waitFor(() => activationStarted);

        const aborted = await harness.abort();
        await prompt;

        expect(prepare).not.toHaveBeenCalled();
        expect(streams).toHaveLength(1);
        expect(aborted.clearedFollowUp).toHaveLength(1);
        expect((await harness.abort()).clearedFollowUp).toEqual([]);
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
