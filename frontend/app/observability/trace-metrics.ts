export interface TraceMetrics {
    durationMs: number;
    generationCount: number;
    toolCount: number;
    lifecycleCount: number;
    errorCount: number;
    usage: Record<"input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens", number>;
    totalCost: number;
    finalOutput: string;
}

const UsageKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

function timestampMs(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}

function numericValue(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function observationCost(costDetails: Record<string, number> | null | undefined): number {
    const total = costDetails?.total;
    if (typeof total === "number" && Number.isFinite(total)) {
        return total;
    }
    return Object.values(costDetails ?? {}).reduce((sum, value) => sum + numericValue(value), 0);
}

function outputText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value == null) {
        return "";
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function traceDurationMs(graph: AgentObservabilityTraceGraph): number {
    const startedAt = timestampMs(graph.trace.timestamp);
    if (startedAt == null) {
        return 0;
    }
    const endedAt = timestampMs(graph.trace.endedAt);
    if (endedAt != null) {
        return Math.max(0, endedAt - startedAt);
    }
    const latestObservationAt = graph.observations.reduce((latest, observation) => {
        const boundary = timestampMs(observation.endTime ?? observation.startTime);
        return boundary == null ? latest : Math.max(latest, boundary);
    }, startedAt);
    return Math.max(0, latestObservationAt - startedAt);
}

export function computeTraceMetrics(graph: AgentObservabilityTraceGraph): TraceMetrics {
    const usage: TraceMetrics["usage"] = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
    };
    let generationCount = 0;
    let toolCount = 0;
    let lifecycleCount = 0;
    let errorCount = 0;
    let totalCost = 0;
    let lastGenerationOutput = "";

    for (const observation of graph.observations) {
        if (observation.type === "GENERATION") {
            generationCount += 1;
            const output = outputText(observation.output);
            if (output) {
                lastGenerationOutput = output;
            }
        } else if (observation.type === "TOOL") {
            toolCount += 1;
        } else if (observation.type === "EVENT") {
            lifecycleCount += 1;
        }

        if (observation.type !== "AGENT" && (observation.level === "ERROR" || observation.statusMessage)) {
            errorCount += 1;
        }

        for (const key of UsageKeys) {
            usage[key] += numericValue(observation.usageDetails?.[key]);
        }
        totalCost += observationCost(observation.costDetails);
    }

    return {
        durationMs: traceDurationMs(graph),
        generationCount,
        toolCount,
        lifecycleCount,
        errorCount,
        usage,
        totalCost,
        finalOutput:
            typeof graph.trace.output === "string" && graph.trace.output ? graph.trace.output : lastGenerationOutput,
    };
}
