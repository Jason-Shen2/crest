// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { LangfuseTraceBuilder } from "./trace-builder";
import type { TraceGraph } from "./types";

function makeBuilder(): LangfuseTraceBuilder {
    let nextId = 0;
    let nextTime = 0;
    return new LangfuseTraceBuilder({
        createId: (prefix) => `${prefix}-${++nextId}`,
        now: () => new Date(Date.UTC(2026, 6, 18, 8, 0, nextTime++)).toISOString(),
    });
}

function lastGraph(graph: TraceGraph | undefined): TraceGraph {
    expect(graph).toBeDefined();
    return graph!;
}

describe("LangfuseTraceBuilder", () => {
    it("maps subscriber-visible generation model metadata", () => {
        const builder = makeBuilder();
        const sessionPath = "/tmp/crest/sessions/project/model.db";

        builder.applyEvent({ sessionPath, event: { type: "agent_start" } });
        const graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_start",
                    message: {
                        role: "assistant",
                        content: [],
                        model: "openrouter/auto",
                        provider: "openrouter",
                    },
                },
            })
        );
        expect(graph.observations[1].model).toBe("openrouter/auto");

        const completedGraph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_end",
                    message: {
                        role: "assistant",
                        content: [],
                        model: "openrouter/auto",
                        responseModel: "anthropic/claude-sonnet-4",
                        provider: "openrouter",
                        usage: {},
                        stopReason: "stop",
                    },
                },
            })
        );

        expect(completedGraph.observations[1]).toMatchObject({
            model: "anthropic/claude-sonnet-4",
            metadata: {
                provider: "openrouter",
                requestedModel: "openrouter/auto",
            },
        });
    });

    it("measures generation timing from the canonical request timestamp", () => {
        let now = "2026-07-18T08:00:00.000Z";
        const builder = new LangfuseTraceBuilder({
            createId: (() => {
                let nextId = 0;
                return (prefix) => `${prefix}-${++nextId}`;
            })(),
            now: () => now,
        });
        const sessionPath = "/tmp/crest/sessions/project/timing.db";
        const requestTimestamp = Date.parse("2026-07-18T08:00:10.000Z");

        builder.applyEvent({ sessionPath, event: { type: "agent_start" } });
        now = "2026-07-18T08:00:14.000Z";
        builder.applyEvent({
            sessionPath,
            event: {
                type: "message_start",
                message: { role: "assistant", content: [], timestamp: requestTimestamp },
            },
        });
        now = "2026-07-18T08:00:16.000Z";
        let graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_update",
                    message: { role: "assistant", content: [{ type: "text", text: "First" }] },
                    assistantMessageEvent: { type: "text_delta", delta: "First" },
                },
            })
        );
        expect(graph.observations[1].startTime).toBe("2026-07-18T08:00:10.000Z");
        expect(graph.observations[1].timeToFirstToken).toBe(6);

        now = "2026-07-18T08:00:20.000Z";
        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_end",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "Finished" }],
                        usage: {},
                        stopReason: "stop",
                    },
                },
            })
        );
        expect(graph.observations[1].latency).toBe(10);
        expect(graph.observations[1].timeToFirstToken).toBe(6);
    });

    it("maps the AgentHarness raw agent event stream into a visible trace", () => {
        const builder = makeBuilder();
        const sessionPath = "/tmp/crest/sessions/project/raw.db";

        let graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "agent_start" },
            })
        );

        expect(graph.trace).toMatchObject({
            id: "trace-1",
            name: "agent_run",
            sessionId: sessionPath,
            status: "running",
        });
        expect(graph.observations[0]).toMatchObject({
            type: "AGENT",
            name: "agent",
        });

        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_end",
                    message: { role: "user", content: [{ type: "text", text: "What changed?" }] },
                    entryId: "entry-user-1",
                } as any,
            })
        );

        expect(graph.trace.input).toBe("What changed?");
        expect(graph.trace.metadata).toMatchObject({ userEntryId: "entry-user-1" });

        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_start",
                    message: { role: "assistant", content: [{ type: "text", text: "" }] },
                } as any,
            })
        );

        expect(graph.observations[1]).toMatchObject({
            type: "GENERATION",
            name: "assistant_response",
            parentObservationId: "observation-2",
        });

        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_update",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "Observed" }],
                    },
                    assistantMessageEvent: { type: "text_delta", delta: "Observed" },
                } as any,
            })
        );

        expect(graph.observations[1]).toMatchObject({
            endTime: null,
            output: "Observed",
        });

        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_end",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "Observed changes." }],
                        usage: { input: 12, output: 4 },
                        stopReason: "stop",
                    },
                } as any,
            })
        );

        expect(graph.observations[1]).toMatchObject({
            endTime: expect.any(String),
            output: "Observed changes.",
            usageDetails: { input: 12, output: 4 },
        });

        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "agent_end", messages: [] },
            })
        );

        expect(graph.trace.status).toBe("success");
        expect(graph.trace.endedAt).toEqual(expect.any(String));
    });

    it("maps a run with generation and tool events into Langfuse Trace/Observation objects", () => {
        const builder = makeBuilder();
        const sessionPath = "/tmp/crest/sessions/project/run.db";

        let graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "agent_start" },
            })
        );

        expect(graph.trace).toMatchObject({
            id: "trace-1",
            name: "agent_run",
            sessionId: sessionPath,
            status: "running",
        });
        expect(graph.observations).toHaveLength(1);
        expect(graph.observations[0]).toMatchObject({
            id: "observation-2",
            traceId: "trace-1",
            type: "AGENT",
            name: "agent",
        });

        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_end",
                    message: { role: "user", content: [{ type: "text", text: "Summarize the repo" }] },
                    entryId: "entry-user-1",
                } as any,
            })
        );

        expect(graph.trace.input).toBe("Summarize the repo");
        expect(graph.observations[0].input).toBe("Summarize the repo");

        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_start",
                    message: { role: "assistant", content: [{ type: "text", text: "" }] },
                } as any,
            })
        );

        expect(graph.observations[1]).toMatchObject({
            type: "GENERATION",
            name: "assistant_response",
            parentObservationId: "observation-2",
        });

        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "tool_execution_start",
                    toolCallId: "call-1",
                    toolName: "read_file",
                    args: { path: "README.md" },
                } as any,
            })
        );

        expect(graph.observations[2]).toMatchObject({
            type: "TOOL",
            name: "read_file",
            input: { path: "README.md" },
            parentObservationId: "observation-2",
        });

        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "tool_execution_end",
                    toolCallId: "call-1",
                    toolName: "read_file",
                    result: [{ type: "text", text: "hello" }],
                    isError: true,
                } as any,
            })
        );

        expect(graph.observations[2]).toMatchObject({
            endTime: expect.any(String),
            level: "ERROR",
            statusMessage: "Tool read_file failed",
        });

        graph = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "settled", nextTurnCount: 1 } as any,
            })
        );

        expect(graph.trace.status).toBe("success");
        expect(graph.trace.endedAt).toEqual(expect.any(String));
        expect(graph.observations[0].endTime).toEqual(expect.any(String));
    });
});
