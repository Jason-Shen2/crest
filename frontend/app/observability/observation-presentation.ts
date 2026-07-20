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
const SearchPayloadLimit = 1_024;
export const SearchIndexLimit = 4_096;

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

class BudgetWriter {
    private readonly parts: string[] = [];
    private remaining: number;
    exhausted = false;

    constructor(limit: number) {
        this.remaining = limit;
    }

    write(value: string): void {
        if (this.exhausted || value.length === 0) return;
        if (value.length <= this.remaining) {
            this.parts.push(value);
            this.remaining -= value.length;
            return;
        }
        const contentLength = Math.max(0, this.remaining - 3);
        if (contentLength > 0) this.parts.push(value.slice(0, contentLength));
        this.parts.push(".".repeat(Math.min(3, this.remaining)));
        this.remaining = 0;
        this.exhausted = true;
    }

    toString(): string {
        return this.parts.join("");
    }
}

function writeQuotedString(writer: BudgetWriter, value: string): void {
    writer.write('"');
    for (let index = 0; index < value.length && !writer.exhausted; index++) {
        const char = value[index];
        const code = value.charCodeAt(index);
        if (char === '"' || char === "\\") {
            writer.write(`\\${char}`);
        } else if (char === "\n") {
            writer.write("\\n");
        } else if (char === "\r") {
            writer.write("\\r");
        } else if (char === "\t") {
            writer.write("\\t");
        } else if (code < 0x20) {
            writer.write(`\\u${code.toString(16).padStart(4, "0")}`);
        } else {
            writer.write(char);
        }
    }
    writer.write('"');
}

function writeValue(writer: BudgetWriter, value: unknown, ancestors: WeakSet<object>): void {
    if (writer.exhausted) return;
    if (value == null) {
        writer.write("null");
        return;
    }
    if (typeof value === "string") {
        writeQuotedString(writer, value);
        return;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        writer.write(String(value));
        return;
    }
    if (typeof value !== "object") {
        writeQuotedString(writer, String(value));
        return;
    }
    if (ancestors.has(value)) {
        writer.write('"[Circular]"');
        return;
    }

    ancestors.add(value);
    const array = Array.isArray(value);
    writer.write(array ? "[" : "{");
    let first = true;
    for (const key in value) {
        if (writer.exhausted || !Object.prototype.hasOwnProperty.call(value, key)) break;
        writer.write(first ? "" : ",");
        if (!array) {
            writeQuotedString(writer, key);
            writer.write(":");
        }
        let item: unknown;
        try {
            item = (value as Record<string, unknown>)[key];
        } catch {
            item = "[Unreadable]";
        }
        writeValue(writer, item, ancestors);
        first = false;
    }
    writer.write(array ? "]" : "}");
    ancestors.delete(value);
}

function boundedSerialize(value: unknown, limit: number): string {
    if (value == null) return "";
    const writer = new BudgetWriter(limit);
    writeValue(writer, value, new WeakSet());
    return writer.toString();
}

function compactPayload(value: unknown): string {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return clampSummary(typeof value === "string" ? value : boundedSerialize(value, SummaryLimit));
    }
    const writer = new BudgetWriter(SummaryLimit);
    let first = true;
    for (const key in value) {
        if (writer.exhausted || !Object.prototype.hasOwnProperty.call(value, key)) break;
        writer.write(first ? "" : ", ");
        writer.write(`${humanize(key.slice(0, SummaryLimit))}: `);
        let item: unknown;
        try {
            item = (value as Record<string, unknown>)[key];
        } catch {
            item = "[Unreadable]";
        }
        writeValue(writer, item, new WeakSet());
        first = false;
    }
    return writer.toString();
}

function categoryFor(observation: Observation): ObservationCategory {
    if (observation.level === "ERROR" || observation.statusMessage != null) {
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

function toneFor(observation: Observation, category: ObservationCategory): ObservationTone {
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

function labelFor(observation: Observation, category: ObservationCategory): string {
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

function summaryFor(observation: Observation, category: ObservationCategory): string {
    if (category === "error" && observation.statusMessage) {
        return clampSummary(observation.statusMessage);
    }
    if (observation.type === "TOOL") {
        return compactPayload(observation.input) || compactPayload(observation.output);
    }
    if (observation.type === "GENERATION") {
        const output =
            typeof observation.output === "string"
                ? observation.output
                : boundedSerialize(observation.output, SummaryLimit);
        const input =
            typeof observation.input === "string" ? observation.input : boundedSerialize(observation.input, SummaryLimit);
        return clampSummary(output || input);
    }
    return compactPayload(observation.input) || compactPayload(observation.output);
}

function formatDuration(observation: Observation): string | null {
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

function badgesFor(observation: Observation): ObservationBadge[] {
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

export function presentObservation(observation: Observation): ObservationPresentation {
    const category = categoryFor(observation);
    const label = labelFor(observation, category);
    const summary = summaryFor(observation, category);
    const searchableText = [
        label,
        summary,
        observation.name,
        observation.statusMessage,
        boundedSerialize(observation.input, SearchPayloadLimit),
        boundedSerialize(observation.output, SearchPayloadLimit),
        boundedSerialize(observation.metadata, SearchPayloadLimit),
    ]
        .filter(Boolean)
        .join(" ")
        .slice(0, SearchIndexLimit);

    return {
        category,
        label,
        summary,
        tone: toneFor(observation, category),
        badges: badgesFor(observation),
        searchableText,
    };
}
