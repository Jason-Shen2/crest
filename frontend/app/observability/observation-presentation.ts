// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type ObservationCategory = "generation" | "tool" | "lifecycle" | "error";
export type ObservationTone = "neutral" | "info" | "success" | "warning" | "error";

export interface ObservationBadge {
    label: string;
    tone: ObservationTone;
}

export interface ObservationPresentation {
    category: ObservationCategory;
    label: string;
    summary: string;
    tone: ObservationTone;
    badges: ObservationBadge[];
    searchableText: string;
}

const SummaryLimit = 160;

const EventLabels: Record<string, string> = {
    model_change: "Model change",
    compaction: "Compaction",
    branch_nav: "Branch navigation",
};

function humanize(value: string): string {
    const words = value.replaceAll(/[_-]+/g, " ").trim();
    return words
        .split(/\s+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function clampSummary(value: string): string {
    const compact = value.replaceAll(/\s+/g, " ").trim();
    if (compact.length <= SummaryLimit) {
        return compact;
    }
    return `${compact.slice(0, SummaryLimit - 3).trimEnd()}...`;
}

function serialize(value: unknown): string {
    if (value == null) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function compactPayload(value: unknown): string {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return clampSummary(serialize(value));
    }
    const entries = Object.entries(value);
    return clampSummary(entries.map(([key, item]) => `${humanize(key)}: ${serialize(item)}`).join(", "));
}

function categoryFor(observation: AgentObservabilityObservation): ObservationCategory {
    if (observation.level === "ERROR") {
        return "error";
    }
    if (observation.type === "GENERATION") {
        return "generation";
    }
    if (observation.type === "TOOL") {
        return "tool";
    }
    return "lifecycle";
}

function toneFor(observation: AgentObservabilityObservation, category: ObservationCategory): ObservationTone {
    if (category === "error") {
        return "error";
    }
    if (observation.level === "WARNING") {
        return "warning";
    }
    if (category === "generation") {
        return "info";
    }
    if (category === "tool") {
        return "success";
    }
    return "neutral";
}

function labelFor(observation: AgentObservabilityObservation, category: ObservationCategory): string {
    if (observation.type === "EVENT" && observation.name) {
        return EventLabels[observation.name] ?? humanize(observation.name);
    }
    if (observation.name) {
        return humanize(observation.name);
    }
    if (category === "error") {
        return "Error";
    }
    return humanize(observation.type);
}

function summaryFor(observation: AgentObservabilityObservation, category: ObservationCategory): string {
    if (category === "error" && observation.statusMessage) {
        return clampSummary(observation.statusMessage);
    }
    if (observation.type === "TOOL") {
        return compactPayload(observation.input) || clampSummary(serialize(observation.output));
    }
    if (observation.type === "GENERATION") {
        const output = typeof observation.output === "string" ? observation.output : serialize(observation.output);
        return clampSummary(output || serialize(observation.input));
    }
    return compactPayload(observation.input) || clampSummary(serialize(observation.output));
}

function formatDuration(observation: AgentObservabilityObservation): string | null {
    if (!observation.endTime) {
        return null;
    }
    const durationMs = new Date(observation.endTime).getTime() - new Date(observation.startTime).getTime();
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        return null;
    }
    if (durationMs < 1000) {
        return `${Math.round(durationMs)} ms`;
    }
    return `${Number((durationMs / 1000).toFixed(2))} s`;
}

function totalTokens(usage: Record<string, number>): number | null {
    if (Number.isFinite(usage.totalTokens)) {
        return usage.totalTokens;
    }
    const total = (usage.input ?? 0) + (usage.output ?? 0);
    return total > 0 ? total : null;
}

function totalCost(cost: Record<string, number>): number | null {
    if (Number.isFinite(cost.total)) {
        return cost.total;
    }
    const values = Object.values(cost).filter(Number.isFinite);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

function badgesFor(observation: AgentObservabilityObservation): ObservationBadge[] {
    const badges: ObservationBadge[] = [];
    const duration = formatDuration(observation);
    const tokens = totalTokens(observation.usageDetails);
    const cost = totalCost(observation.costDetails);

    if (duration) {
        badges.push({ label: duration, tone: "neutral" });
    }
    if (observation.model) {
        badges.push({ label: observation.model, tone: "info" });
    }
    if (tokens != null) {
        badges.push({ label: `${tokens} tokens`, tone: "neutral" });
    }
    if (cost != null) {
        badges.push({ label: `$${cost}`, tone: "neutral" });
    }
    if (observation.statusMessage) {
        badges.push({ label: observation.statusMessage, tone: "error" });
    }
    return badges;
}

export function presentObservation(observation: AgentObservabilityObservation): ObservationPresentation {
    const category = categoryFor(observation);
    const label = labelFor(observation, category);
    const summary = summaryFor(observation, category);
    const searchableText = [
        label,
        summary,
        observation.name,
        observation.statusMessage,
        serialize(observation.input),
        serialize(observation.output),
        serialize(observation.metadata),
    ]
        .filter(Boolean)
        .join(" ");

    return {
        category,
        label,
        summary,
        tone: toneFor(observation, category),
        badges: badgesFor(observation),
        searchableText,
    };
}
