import { expectTypeOf } from "vitest";

interface CanonicalObservation {
    id: string;
    traceId: string;
    type:
        | "SPAN"
        | "EVENT"
        | "GENERATION"
        | "AGENT"
        | "TOOL"
        | "CHAIN"
        | "RETRIEVER"
        | "EVALUATOR"
        | "EMBEDDING"
        | "GUARDRAIL";
    startTime: string;
    endTime: string | null;
    name: string | null;
    metadata: Record<string, unknown>;
    parentObservationId: string | null;
    level: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
    statusMessage: string | null;
    version: string | null;
    model: string | null;
    input: unknown;
    output: unknown;
    latency: number | null;
    timeToFirstToken: number | null;
    usageDetails: Record<string, number>;
    costDetails: Record<string, number>;
    toolCalls: string[] | null;
    toolCallNames: string[] | null;
}

expectTypeOf<AgentObservabilityObservation>().toEqualTypeOf<CanonicalObservation>();
