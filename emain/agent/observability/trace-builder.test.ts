// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { TraceBuilder } from "./trace-builder";
import type { TraceDetail } from "./types";

function makeBuilder(): TraceBuilder {
    let nextId = 0;
    let nextTime = 0;
    return new TraceBuilder({
        createId: (prefix) => `${prefix}-${++nextId}`,
        now: () => new Date(Date.UTC(2026, 6, 18, 8, 0, nextTime++)).toISOString(),
    });
}

function lastGraph(detail: TraceDetail | undefined): TraceDetail {
    expect(detail).toBeDefined();
    return detail!;
}

describe("TraceBuilder", () => {
    it("maps subscriber-visible generation model metadata", () => {
        const builder = makeBuilder();
        const sessionPath = "/tmp/crest/sessions/project/model.db";

        builder.applyEvent({ sessionPath, event: { type: "agent_start" } });
        const detail = lastGraph(
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
        expect(detail.observations[1].model).toBe("openrouter/auto");

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
        const builder = new TraceBuilder({
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
        let detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_update",
                    message: { role: "assistant", content: [{ type: "text", text: "First" }] },
                    assistantMessageEvent: { type: "text_delta", delta: "First" },
                },
            })
        );
        expect(detail.observations[1].startTime).toBe("2026-07-18T08:00:10.000Z");
        expect(detail.observations[1].timeToFirstToken).toBe(6);

        now = "2026-07-18T08:00:20.000Z";
        detail = lastGraph(
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
        expect(detail.observations[1].latency).toBe(10);
        expect(detail.observations[1].timeToFirstToken).toBe(6);
    });

    it("maps the AgentHarness raw agent event stream into a visible trace", () => {
        const builder = makeBuilder();
        const sessionPath = "/tmp/crest/sessions/project/raw.db";

        let detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "agent_start" },
            })
        );

        expect(detail.trace).toMatchObject({
            id: "trace-1",
            name: "agent_run",
            sessionId: sessionPath,
            status: "running",
        });
        expect(detail.observations[0]).toMatchObject({
            type: "AGENT",
            name: "agent",
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "turn_start" },
            })
        );
        const turn = detail.observations.find((observation) => observation.name === "turn");
        expect(turn).toMatchObject({
            type: "SPAN",
            parentObservationId: "observation-2",
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_end",
                    message: { role: "user", content: [{ type: "text", text: "What changed?" }] },
                    entryId: "entry-user-1",
                } as any,
            })
        );

        expect(detail.trace.input).toBe("What changed?");
        expect(detail.trace.metadata).toMatchObject({ userEntryId: "entry-user-1" });
        const updatedTurn = detail.observations.find((observation) => observation.id === turn?.id);
        expect(updatedTurn).toMatchObject({
            type: "SPAN",
            parentObservationId: "observation-2",
            input: "What changed?",
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_start",
                    message: { role: "assistant", content: [{ type: "text", text: "" }] },
                } as any,
            })
        );

        let generation = detail.observations.find((observation) => observation.name === "assistant_response");
        expect(generation).toMatchObject({
            type: "GENERATION",
            name: "assistant_response",
            parentObservationId: turn?.id,
        });

        detail = lastGraph(
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

        generation = detail.observations.find((observation) => observation.name === "assistant_response");
        expect(generation).toMatchObject({
            endTime: null,
            output: "Observed",
        });

        detail = lastGraph(
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

        generation = detail.observations.find((observation) => observation.name === "assistant_response");
        expect(generation).toMatchObject({
            endTime: expect.any(String),
            output: "Observed changes.",
            usageDetails: { input: 12, output: 4 },
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "agent_end", messages: [] },
            })
        );

        expect(detail.trace.status).toBe("success");
        expect(detail.trace.endedAt).toEqual(expect.any(String));
    });

    it("maps a run with generation and tool events into Langfuse Trace/Observation objects", () => {
        const builder = makeBuilder();
        const sessionPath = "/tmp/crest/sessions/project/run.db";

        let detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "agent_start" },
            })
        );

        expect(detail.trace).toMatchObject({
            id: "trace-1",
            name: "agent_run",
            sessionId: sessionPath,
            status: "running",
        });
        expect(detail.observations).toHaveLength(1);
        expect(detail.observations[0]).toMatchObject({
            id: "observation-2",
            traceId: "trace-1",
            type: "AGENT",
            name: "agent",
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "turn_start" },
            })
        );
        const turn = detail.observations.find((observation) => observation.name === "turn");
        expect(turn).toMatchObject({
            type: "SPAN",
            parentObservationId: "observation-2",
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_end",
                    message: { role: "user", content: [{ type: "text", text: "Summarize the repo" }] },
                    entryId: "entry-user-1",
                } as any,
            })
        );

        expect(detail.trace.input).toBe("Summarize the repo");
        expect(detail.observations[0].input).toBe("Summarize the repo");
        const updatedTurn = detail.observations.find((observation) => observation.id === turn?.id);
        expect(updatedTurn).toMatchObject({
            type: "SPAN",
            parentObservationId: "observation-2",
            input: "Summarize the repo",
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_start",
                    message: { role: "assistant", content: [{ type: "text", text: "" }] },
                } as any,
            })
        );

        const generation = detail.observations.find((observation) => observation.name === "assistant_response");
        expect(generation).toMatchObject({
            type: "GENERATION",
            name: "assistant_response",
            parentObservationId: turn?.id,
        });

        detail = lastGraph(
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

        let tool = detail.observations.find((observation) => observation.name === "read_file");
        expect(tool).toMatchObject({
            type: "TOOL",
            name: "read_file",
            input: { path: "README.md" },
            parentObservationId: turn?.id,
        });

        detail = lastGraph(
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

        tool = detail.observations.find((observation) => observation.name === "read_file");
        expect(tool).toMatchObject({
            endTime: expect.any(String),
            level: "ERROR",
            statusMessage: "Tool read_file failed",
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "settled", nextTurnCount: 1 } as any,
            })
        );

        expect(detail.trace.status).toBe("success");
        expect(detail.trace.endedAt).toEqual(expect.any(String));
        expect(detail.observations[0].endTime).toEqual(expect.any(String));
    });

    it("groups Pi turns as one assistant response plus its tool results", () => {
        const builder = makeBuilder();
        const sessionPath = "/tmp/crest/sessions/project/turn.db";

        builder.applyEvent({ sessionPath, event: { type: "agent_start" } });
        let detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "turn_start" },
            })
        );

        const firstTurn = detail.observations.find((observation) => observation.name === "turn");
        expect(firstTurn).toMatchObject({
            type: "SPAN",
            parentObservationId: "observation-2",
            metadata: { turnIndex: 0 },
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_end",
                    message: { role: "user", content: [{ type: "text", text: "Inspect the repo" }] },
                    entryId: "entry-turn-1",
                } as any,
            })
        );
        const updatedFirstTurn = detail.observations.find((observation) => observation.id === firstTurn?.id);
        expect(updatedFirstTurn).toMatchObject({
            input: "Inspect the repo",
            metadata: { entryId: "entry-turn-1", role: "user", turnIndex: 0 },
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_start",
                    message: { role: "assistant", content: [{ type: "text", text: "" }] },
                } as any,
            })
        );
        const firstGeneration = detail.observations.find((observation) => observation.name === "assistant_response");
        expect(firstGeneration?.parentObservationId).toBe(firstTurn?.id);

        detail = lastGraph(
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
        const firstTool = detail.observations.find((observation) => observation.name === "read_file");
        expect(firstTool?.parentObservationId).toBe(firstTurn?.id);

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_end",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "Need another tool call" }],
                        usage: {},
                    },
                } as any,
            })
        );
        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "turn_end",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "Need another tool call" }],
                    },
                    toolResults: [{ toolCallId: "call-1", content: [{ type: "text", text: "ok" }] }],
                } as any,
            })
        );
        expect(detail.observations.find((observation) => observation.id === firstTurn?.id)).toMatchObject({
            endTime: expect.any(String),
            output: "Need another tool call",
            metadata: {
                turnIndex: 0,
                toolResultCount: 1,
            },
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "turn_start" },
            })
        );
        const turns = detail.observations.filter((observation) => observation.name === "turn");
        expect(turns).toHaveLength(2);
        const secondTurn = turns[1];
        expect(secondTurn).toMatchObject({
            type: "SPAN",
            parentObservationId: "observation-2",
            metadata: { turnIndex: 1 },
        });

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: {
                    type: "message_start",
                    message: { role: "assistant", content: [{ type: "text", text: "" }] },
                } as any,
            })
        );
        const secondGeneration = detail.observations.filter(
            (observation) => observation.name === "assistant_response"
        )[1];
        expect(secondGeneration?.parentObservationId).toBe(secondTurn.id);

        detail = lastGraph(
            builder.applyEvent({
                sessionPath,
                event: { type: "model_select", model: "claude-sonnet" } as any,
            })
        );
        const lifecycle = detail.observations.find((observation) => observation.name === "model_change");
        expect(lifecycle?.parentObservationId).toBe(secondTurn.id);
    });
});
