// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { PiAgentMessage, PiRun } from "@/app/store/use-pi-chat";

export type AgentToolViewStatus = "running" | "done" | "failed";
export type AgentToolViewRisk = "read-only" | "file-edit" | "command" | "network" | "external";
export type AgentToolViewCategory = "explore" | "modify" | "verify" | "command" | "external" | "work";
export type CompactToolStatus = AgentToolViewStatus;
export type CompactToolKind = "read" | "search" | "edit" | "command" | "web" | "agent" | "other";
export type CompactToolIcon = "file" | "search" | "edit" | "terminal" | "globe" | "agent" | "tool";

export interface CompactToolResult {
    content?: Array<{ type: string; text?: string; [field: string]: unknown }>;
    details?: unknown;
    isError?: boolean;
}

export interface CompactToolCall {
    id: string;
    name: string;
    input: unknown;
}

export interface CompactToolItem {
    call: CompactToolCall;
    status: CompactToolStatus;
    kind: CompactToolKind;
    result?: CompactToolResult;
}

export type CompactToolGroup =
    | { id: string; kind: "read-group"; items: CompactToolItem[] }
    | { id: string; kind: "tool"; item: CompactToolItem };

export type AgentToolViewResult = CompactToolResult;

export interface AgentToolViewItem {
    id: string;
    name: string;
    input: unknown;
    status: AgentToolViewStatus;
    result?: AgentToolViewResult;
    category: AgentToolViewCategory;
    title: string;
    summary: string;
    risk: AgentToolViewRisk;
    detail?: string;
}

export interface AgentToolViewModel {
    tools: AgentToolViewItem[];
}

interface ToolDescriptor {
    category: AgentToolViewCategory;
    title: string;
    doneSummary: string;
    runningSummary: string;
    failedSummary: string;
    risk: AgentToolViewRisk;
}

const ExploreDescriptor: ToolDescriptor = {
    category: "explore",
    title: "Explore implementation",
    doneSummary: "Inspected project files.",
    runningSummary: "Inspecting project files.",
    failedSummary: "Could not inspect project files.",
    risk: "read-only",
};

const ModifyDescriptor: ToolDescriptor = {
    category: "modify",
    title: "Modify files",
    doneSummary: "Updated files.",
    runningSummary: "Updating files.",
    failedSummary: "File update failed.",
    risk: "file-edit",
};

const VerifyDescriptor: ToolDescriptor = {
    category: "verify",
    title: "Verify result",
    doneSummary: "Ran validation.",
    runningSummary: "Running validation.",
    failedSummary: "Validation failed.",
    risk: "command",
};

const CommandDescriptor: ToolDescriptor = {
    category: "command",
    title: "Run command",
    doneSummary: "Ran command.",
    runningSummary: "Running command.",
    failedSummary: "Command failed.",
    risk: "command",
};

const ExternalDescriptor: ToolDescriptor = {
    category: "external",
    title: "Gather external context",
    doneSummary: "Gathered external context.",
    runningSummary: "Gathering external context.",
    failedSummary: "External context lookup failed.",
    risk: "network",
};

const WorkDescriptor: ToolDescriptor = {
    category: "work",
    title: "Work on task",
    doneSummary: "Completed task activity.",
    runningSummary: "Working on task.",
    failedSummary: "Task activity failed.",
    risk: "external",
};

const ValidationCommandRe = /\b(test|tests|vitest|jest|lint|typecheck|tsc|build)\b/i;
const MaxMutationLineCount = 1000;

interface CappedLineCount {
    count: number;
    capped: boolean;
}

export function deriveAgentToolViewModel(run: PiRun): AgentToolViewModel {
    const resultsByCallId = indexToolResults(run.responseMessages);
    return {
        tools: collectToolCalls(run.responseMessages).map((call) => {
            const result = resultsByCallId.get(call.id);
            const status = deriveCompactToolStatus(call, result);
            const descriptor = classifyToolCall(call);
            const detail = descriptor.risk === "file-edit" ? fileEvidence(call.input) || undefined : undefined;
            return {
                id: call.id,
                name: call.name,
                input: call.input,
                status,
                ...(result ? { result } : {}),
                category: descriptor.category,
                title: descriptor.title,
                summary: summarizeTool(descriptor, status, detail),
                risk: descriptor.risk,
                ...(detail ? { detail } : {}),
            };
        }),
    };
}

export function deriveCompactToolStatus(_call: CompactToolCall, result?: CompactToolResult): CompactToolStatus {
    if (result == null) return "running";
    return result.isError ? "failed" : "done";
}

export function deriveCompactToolKind(call: CompactToolCall): CompactToolKind {
    return compactToolKind(call);
}

export function compactToolKind(call: CompactToolCall): CompactToolKind {
    const name = call.name.toLowerCase();
    if (isEditTool(name)) return "edit";
    if (isCommandTool(name)) return "command";
    if (isExternalTool(name)) return "web";
    if (isSearchTool(name)) return "search";
    if (isReadOnlyTool(name)) return "read";
    if (isAgentTool(name)) return "agent";
    return "other";
}

export function compactToolLabel(item: CompactToolItem): string {
    const path = compactToolPath(item);
    switch (item.kind) {
        case "read":
            return path ? `Read ${basename(path)}` : "Read files";
        case "search":
            return `Search ${path || "workspace"}`;
        case "edit":
            return path ? `Edit ${basename(path)}` : "Edit files";
        case "command":
            return "Run command";
        case "web": {
            const url = stringField(item.call.input, "url");
            return url ? `Fetch ${urlHost(url)}` : "Fetch web";
        }
        case "agent":
            return "Run subagent";
        case "other":
            return humanizeToolName(item.call.name);
    }
}

export function compactToolIcon(item: CompactToolItem): CompactToolIcon {
    switch (item.kind) {
        case "read":
            return "file";
        case "search":
            return "search";
        case "edit":
            return "edit";
        case "command":
            return "terminal";
        case "web":
            return "globe";
        case "agent":
            return "agent";
        case "other":
            return "tool";
    }
}

export function compactToolSummary(item: CompactToolItem): string {
    const path = compactToolPath(item);
    const command = compactToolCommand(item);
    const mutationSummary = compactToolMutationSummary(item);
    if (item.status === "failed") {
        switch (item.kind) {
            case "edit":
                if (mutationSummary) return `Could not update ${mutationSummary}`;
                return path ? `Could not update ${path}` : "File update failed.";
            case "command":
                return command ? `Command failed: ${command}` : "Command failed.";
            case "web": {
                const url = stringField(item.call.input, "url");
                return url ? `Failed to fetch ${url}` : "External context lookup failed.";
            }
            case "read":
            case "search":
                return "Could not inspect project files.";
            default:
                return "Task activity failed.";
        }
    }
    if (item.status === "running") {
        switch (item.kind) {
            case "read":
                return path ? `Reading ${path}` : "Reading files";
            case "search": {
                const pattern = stringField(item.call.input, "pattern") || stringField(item.call.input, "query");
                return pattern ? `Searching ${path || "workspace"} for ${pattern}` : `Searching ${path || "workspace"}`;
            }
            case "edit":
                if (mutationSummary) return `Updating ${mutationSummary}`;
                return path ? `Updating ${path}` : "Updating files.";
            case "command":
                return command ? `Running ${command}` : "Running command.";
            case "web": {
                const url = stringField(item.call.input, "url");
                return url ? `Fetching ${url}` : "Gathering external context.";
            }
            case "agent":
                return "Running subagent.";
            default:
                return "Working on task.";
        }
    }
    switch (item.kind) {
        case "read":
            return path ? `Read ${path}` : "Inspected project files.";
        case "search": {
            const pattern = stringField(item.call.input, "pattern") || stringField(item.call.input, "query");
            return pattern ? `Searched ${path || "workspace"} for ${pattern}` : `Searched ${path || "workspace"}`;
        }
        case "edit":
            if (mutationSummary) return `Updated ${mutationSummary}`;
            return path ? `Updated ${path}` : "Updated files.";
        case "command":
            return command ? `Ran ${command}` : "Ran command.";
        case "web": {
            const url = stringField(item.call.input, "url");
            return url ? `Fetched ${url}` : "Gathered external context.";
        }
        case "agent":
            return "Completed subagent.";
        default:
            return "Completed task activity.";
    }
}

export function compactToolPath(itemOrCall: CompactToolItem | CompactToolCall): string {
    const input = "call" in itemOrCall ? itemOrCall.call.input : itemOrCall.input;
    return fileEvidence(input) || stringField(input, "path") || "";
}

export function compactToolCommand(itemOrCall: CompactToolItem | CompactToolCall): string {
    const input = "call" in itemOrCall ? itemOrCall.call.input : itemOrCall.input;
    return inputCommand(input);
}

export function compactToolMutationSummary(itemOrCall: CompactToolItem | CompactToolCall): string {
    const call = "call" in itemOrCall ? itemOrCall.call : itemOrCall;
    if (!isEditTool(call.name.toLowerCase())) return "";
    const path = compactToolPath(call);
    const stats = mutationStats(call);
    if (!path && !stats) return "";
    return `${path || "files"}${stats ? ` (${stats})` : ""} - review in diff`;
}

export function renderCompactToolResultText(result?: CompactToolResult): string {
    if (!result?.content) return "";
    return result.content.flatMap((part) => textParts(part)).join("\n");
}

export function groupCompactTools(items: CompactToolItem[]): CompactToolGroup[] {
    const groups: CompactToolGroup[] = [];
    let readItems: CompactToolItem[] = [];
    const flushReadItems = () => {
        if (readItems.length === 0) return;
        if (readItems.length === 1) {
            const [item] = readItems;
            groups.push({ id: `tool-${item.call.id}`, kind: "tool", item });
        } else {
            groups.push({ id: `read-group-${readItems[0].call.id}`, kind: "read-group", items: readItems });
        }
        readItems = [];
    };

    for (const item of items) {
        if (item.kind === "read") {
            readItems.push(item);
            continue;
        }
        flushReadItems();
        groups.push({ id: `tool-${item.call.id}`, kind: "tool", item });
    }
    flushReadItems();
    return groups;
}

export function isCompactReadGroup(group: CompactToolGroup): group is Extract<CompactToolGroup, { kind: "read-group" }> {
    return group.kind === "read-group";
}

export function isHeavyCompactTool(item: CompactToolItem): boolean {
    return item.kind === "edit" || item.kind === "command" || item.kind === "web" || item.kind === "agent";
}

function collectToolCalls(messages: PiAgentMessage[]): CompactToolCall[] {
    const calls: CompactToolCall[] = [];
    for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const content of message.content ?? []) {
            if (content.type !== "toolCall") continue;
            calls.push({
                id: String(content.id ?? ""),
                name: String(content.name ?? ""),
                input: content.input != null ? content.input : content.arguments,
            });
        }
    }
    return calls;
}

function indexToolResults(messages: PiAgentMessage[]): Map<string, CompactToolResult> {
    const map = new Map<string, CompactToolResult>();
    for (const message of messages) {
        if (message.role !== "toolResult") continue;
        const messageToolUseId = stringField(message, "toolUseId") || stringField(message, "toolCallId");
        if (messageToolUseId) {
            map.set(messageToolUseId, {
                content: message.content as AgentToolViewResult["content"],
                details: message.details,
                isError: message.isError === true,
            });
            continue;
        }
        for (const content of message.content ?? []) {
            if (content.type !== "toolResult") continue;
            const toolUseId = stringField(content, "toolUseId") || stringField(content, "toolCallId");
            if (!toolUseId) continue;
            map.set(toolUseId, {
                content: content.content as AgentToolViewResult["content"],
                details: content.details,
                isError: content.isError === true,
            });
        }
    }
    return map;
}

function classifyToolCall(call: CompactToolCall): ToolDescriptor {
    const name = call.name.toLowerCase();
    if (isEditTool(name)) return ModifyDescriptor;
    if (isCommandTool(name)) {
        return ValidationCommandRe.test(inputCommand(call.input)) ? VerifyDescriptor : CommandDescriptor;
    }
    if (isExternalTool(name)) return ExternalDescriptor;
    if (isReadOnlyTool(name)) return ExploreDescriptor;
    return WorkDescriptor;
}

function summarizeTool(descriptor: ToolDescriptor, status: AgentToolViewStatus, detail?: string): string {
    if (descriptor.risk === "file-edit" && detail) {
        const target = basename(detail);
        if (status === "running") return `Updating ${target}`;
        if (status === "failed") return `Could not update ${target}`;
        return `Updated ${target}`;
    }
    if (status === "running") return descriptor.runningSummary;
    if (status === "failed") return descriptor.failedSummary;
    return descriptor.doneSummary;
}

function isReadOnlyTool(name: string): boolean {
    return [
        /^read$/,
        /(^|[._:-])read([_-]?(text|file))*$/,
        /^grep$/,
        /(^|[._:-])grep$/,
        /^find$/,
        /^glob$/,
        /^ls$/,
        /(^|[._:-])search/,
        /(^|[._:-])list/,
        /(^|[._:-])cmd[_-]?history$/,
    ].some((pattern) => pattern.test(name));
}

function isSearchTool(name: string): boolean {
    return [/^grep$/, /(^|[._:-])grep$/, /^find$/, /^glob$/, /(^|[._:-])search/].some((pattern) => pattern.test(name));
}

function isEditTool(name: string): boolean {
    return [
        /^write$/,
        /^edit$/,
        /^modify$/,
        /(^|[._:-])write/,
        /(^|[._:-])edit/,
        /(^|[._:-])modify([_-]?file)?$/,
        /(^|[._:-])apply[_-]?patch$/,
    ].some((pattern) => pattern.test(name));
}

function isCommandTool(name: string): boolean {
    return [
        /^bash$/,
        /^exec$/,
        /(^|[._:-])exec[_-]?command$/,
        /(^|[._:-])run[_-]?command$/,
        /(^|[._:-])shell[_-]?exec$/,
    ].some((pattern) => pattern.test(name));
}

function isExternalTool(name: string): boolean {
    return /^mcp__/.test(name) || /(^|[._:-])web[_-]?fetch$/.test(name) || /(^|[._:-])fetch$/.test(name);
}

function isAgentTool(name: string): boolean {
    return /(^|[._:-])spawn[_-]?cli[_-]?agent$/.test(name) || /(^|[._:-])subagent$/.test(name);
}

function inputCommand(input: unknown): string {
    if (typeof input === "string") return input;
    if (!input || typeof input !== "object") return "";
    return stringField(input, "command") || stringField(input, "cmd");
}

function mutationStats(call: CompactToolCall): string {
    const input = call.input;
    const name = call.name.toLowerCase();
    const patchText = patchMutationText(input);
    if (patchText && (name.includes("patch") || looksLikePatch(patchText))) {
        const stats = countPatchLines(patchText);
        if (stats.added.count || stats.deleted.count) return `+${formatCappedCount(stats.added)} -${formatCappedCount(stats.deleted)}`;
    }
    const replacementStats = replacementMutationStats(input);
    if (replacementStats) return replacementStats;
    const content = stringField(input, "content");
    if (content) return lineCountLabel(countTextLines(content, MaxMutationLineCount), "new");
    return "";
}

function replacementMutationStats(input: unknown): string {
    const oldLines = makeCappedLineCount();
    const newLines = makeCappedLineCount();
    addTextLineCountFromFields(oldLines, input, ["oldText", "old_text", "oldString", "old_string", "old"]);
    addTextLineCountFromFields(newLines, input, ["newText", "new_text", "newString", "new_string", "new"]);
    addEditLineCounts(oldLines, newLines, input);
    if (!oldLines.count && !newLines.count) return "";
    return [lineCountLabel(oldLines, "old"), lineCountLabel(newLines, "new")].filter(Boolean).join(", ");
}

function makeCappedLineCount(): CappedLineCount {
    return { count: 0, capped: false };
}

function addTextLineCountFromFields(total: CappedLineCount, input: unknown, fields: string[]): void {
    for (const field of fields) {
        addTextLineCount(total, stringField(input, field));
        if (total.capped) return;
    }
}

function addEditLineCounts(oldLines: CappedLineCount, newLines: CappedLineCount, input: unknown): void {
    if (!input || typeof input !== "object") return;
    const edits = (input as Record<string, unknown>).edits;
    if (!Array.isArray(edits)) return;
    for (const edit of edits) {
        addTextLineCountFromFields(oldLines, edit, ["oldText", "old_text", "oldString", "old_string", "old"]);
        addTextLineCountFromFields(newLines, edit, ["newText", "new_text", "newString", "new_string", "new"]);
        if (oldLines.capped && newLines.capped) return;
    }
}

function addTextLineCount(total: CappedLineCount, text: string): void {
    if (!text || total.capped) return;
    if (total.count >= MaxMutationLineCount) {
        total.capped = true;
        return;
    }
    const remaining = MaxMutationLineCount - total.count;
    const next = countTextLines(text, remaining);
    total.count += next.count;
    if (next.capped) {
        total.count = MaxMutationLineCount;
        total.capped = true;
    }
}

function patchMutationText(input: unknown): string {
    if (typeof input === "string") return input;
    return stringField(input, "patch") || stringField(input, "diff") || stringField(input, "text");
}

function looksLikePatch(text: string): boolean {
    return /^\*\*\* (?:Add|Update|Delete) File: /m.test(text) || /^@@ /m.test(text) || /^diff --git /m.test(text);
}

function countPatchLines(text: string): { added: CappedLineCount; deleted: CappedLineCount } {
    const stats = {
        added: { count: 0, capped: false },
        deleted: { count: 0, capped: false },
    };
    let mutationLineCount = 0;
    scanLines(text, (line) => {
        if (line.startsWith("+") && !isPatchFileHeader(line, "+")) {
            if (mutationLineCount >= MaxMutationLineCount) {
                stats.added.capped = true;
                return true;
            }
            stats.added.count += 1;
            mutationLineCount += 1;
        } else if (line.startsWith("-") && !isPatchFileHeader(line, "-")) {
            if (mutationLineCount >= MaxMutationLineCount) {
                stats.deleted.capped = true;
                return true;
            }
            stats.deleted.count += 1;
            mutationLineCount += 1;
        }
        return false;
    });
    return stats;
}

function isPatchFileHeader(line: string, marker: "+" | "-"): boolean {
    return line.startsWith(`${marker}${marker}${marker} `) || line.startsWith(`${marker}${marker}${marker}\t`);
}

function countTextLines(text: string, limit: number): CappedLineCount {
    const result = { count: 0, capped: false };
    if (!text) return result;
    result.count = 1;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char !== "\n" && char !== "\r") continue;
        const nextIdx = char === "\r" && text[i + 1] === "\n" ? i + 1 : i;
        if (nextIdx === text.length - 1) return result;
        incrementCappedCount(result, limit);
        if (result.capped) return result;
        i = nextIdx;
    }
    return result;
}

function scanLines(text: string, visit: (line: string) => boolean | void): void {
    let lineStart = 0;
    for (let i = 0; i <= text.length; i++) {
        const char = text[i];
        if (i !== text.length && char !== "\n" && char !== "\r") continue;
        const shouldStop = visit(text.slice(lineStart, i));
        if (shouldStop) return;
        if (char === "\r" && text[i + 1] === "\n") {
            i += 1;
        }
        lineStart = i + 1;
    }
}

function incrementCappedCount(value: CappedLineCount, limit = MaxMutationLineCount): void {
    if (value.capped) return;
    if (value.count >= limit) {
        value.capped = true;
        value.count = limit;
        return;
    }
    value.count += 1;
}

function formatCappedCount(value: CappedLineCount): string {
    return `${value.count}${value.capped ? "+" : ""}`;
}

function lineCountLabel(value: CappedLineCount | number, label: "old" | "new"): string {
    const count = typeof value === "number" ? value : value.count;
    if (!count) return "";
    const capped = typeof value === "number" ? "" : value.capped ? "+" : "";
    return `${count}${capped} ${label} ${count === 1 && !capped ? "line" : "lines"}`;
}

function fileEvidence(input: unknown): string {
    const directPath =
        stringField(input, "path") ||
        stringField(input, "file") ||
        stringField(input, "filepath") ||
        stringField(input, "file_path") ||
        stringField(input, "filePath");
    if (directPath) return directPath;
    const patchText = patchMutationText(input);
    return patchPathEvidence(patchText);
}

function patchPathEvidence(patchText: string): string {
    const applyPatchMatch = patchText.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
    if (applyPatchMatch?.[1]) return applyPatchMatch[1].trim();
    const diffGitMatch = patchText.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (diffGitMatch?.[2]) return diffGitMatch[2].trim();
    const unifiedNewFileMatch = patchText.match(/^\+\+\+ (?:b\/)?(.+)$/m);
    if (unifiedNewFileMatch?.[1] && unifiedNewFileMatch[1] !== "/dev/null") return unifiedNewFileMatch[1].trim();
    const unifiedOldFileMatch = patchText.match(/^--- (?:a\/)?(.+)$/m);
    if (unifiedOldFileMatch?.[1] && unifiedOldFileMatch[1] !== "/dev/null") return unifiedOldFileMatch[1].trim();
    return "";
}

function basename(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

function urlHost(url: string): string {
    try {
        return new URL(url).host || url;
    } catch {
        return url;
    }
}

function humanizeToolName(name: string): string {
    const label = name.split(/[._:-]/).filter(Boolean).at(-1) || name || "Tool";
    return label
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\w/, (char) => char.toUpperCase());
}

function textParts(part: { type: string; text?: string; [field: string]: unknown }): string[] {
    if (part.type === "text" && typeof part.text === "string") return [part.text];
    if (Array.isArray(part.content)) {
        return part.content.flatMap((child) =>
            child && typeof child === "object" && "type" in child
                ? textParts(child as { type: string; text?: string; [field: string]: unknown })
                : []
        );
    }
    return [];
}

function stringField(input: unknown, field: string): string {
    if (!input || typeof input !== "object") return "";
    const value = (input as Record<string, unknown>)[field];
    return typeof value === "string" ? value : "";
}
