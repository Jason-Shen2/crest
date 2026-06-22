// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    completeSimple,
    type Api,
    type AssistantMessage,
    type Message,
    type Model,
    type SimpleStreamOptions,
} from "../../ai";
import type { ChangeOperation, ChangeOperationKind } from "./change-operation";

export interface ChangeOutlineFile {
    path: string;
    hunkIds?: string[];
}

export interface ChangeOutlineModule {
    id: string;
    title: string;
    summary?: string;
    files: ChangeOutlineFile[];
}

export interface ChangeOutline {
    modules?: ChangeOutlineModule[];
}

export interface ExtractChangeOperationsOptions {
    runId?: string;
}

export interface GenerateChangeOutlineOptions<TApi extends Api = Api> {
    model: Model<TApi>;
    operations?: ChangeOperation[];
    messages?: Message[];
    runId?: string;
    customInstructions?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    maxTokens?: number;
    complete?: typeof completeSimple;
}

interface CompactHunk {
    id: string;
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    additions: number;
    deletions: number;
}

interface CompactFile {
    path: string;
    previousPath?: string;
    status: "added" | "modified" | "deleted" | "renamed";
    patchStatus?: "complete" | "unavailable";
    patchUnavailableReason?: string;
    stats: {
        hunks: number;
        additions: number;
        deletions: number;
    };
    hunks: CompactHunk[];
    operations: CompactOperation[];
}

interface CompactOperation {
    id: string;
    kind: ChangeOperationKind;
    toolCallId?: string;
}

const HunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const SystemPrompt =
    "You generate a change outline for code review. Group related changed files and hunks into concise modules.";

export function extractChangeOperationsFromMessages(
    messages: Message[],
    options: ExtractChangeOperationsOptions = {}
): ChangeOperation[] {
    const operations: ChangeOperation[] = [];
    for (const message of messages) {
        if (message.role !== "toolResult") {
            continue;
        }
        if (message.isError === true) {
            continue;
        }
        appendOperation(operations, operationFromDetails(message.details, options.runId, message.toolCallId));
        for (const content of message.content ?? []) {
            const nested = content as unknown as {
                type?: string;
                isError?: boolean;
                details?: unknown;
                toolCallId?: string;
                toolUseId?: string;
            };
            if (nested.type !== "toolResult" || nested.isError === true) {
                continue;
            }
            appendOperation(
                operations,
                operationFromDetails(nested.details, options.runId, nested.toolCallId || nested.toolUseId)
            );
        }
    }
    return operations;
}

export function buildCompactChangeSetJson(operations: ChangeOperation[]): string {
    const filesByPath = new Map<string, CompactFile>();
    for (const operation of operations) {
        const file = getOrCreateCompactFile(filesByPath, operation);
        file.operations.push(compactOperation(operation));
        if (operation.previousPath && !file.previousPath) {
            file.previousPath = operation.previousPath;
        }
        if (operation.patchStatus) {
            file.patchStatus = operation.patchStatus;
        }
        if (operation.patchUnavailableReason && !file.patchUnavailableReason) {
            file.patchUnavailableReason = operation.patchUnavailableReason;
        }
        if (operation.patchStatus === "unavailable" || !operation.patch) {
            continue;
        }
        for (const hunk of parsePatchHunks(operation.patch, operation.path)) {
            file.hunks.push(hunk);
        }
    }

    const files = Array.from(filesByPath.values()).map((file) => ({
        ...file,
        stats: statsForHunks(file.hunks),
    }));
    const totals = {
        files: files.length,
        hunks: sum(files, (file) => file.stats.hunks),
        additions: sum(files, (file) => file.stats.additions),
        deletions: sum(files, (file) => file.stats.deletions),
    };
    return JSON.stringify({ files, totals }, undefined, 2);
}

export function buildChangeOutlinePrompt(operations: ChangeOperation[], customInstructions?: string): string {
    const changeSetJson = buildCompactChangeSetJson(operations);
    const extra = customInstructions ? `\n\nAdditional instructions:\n${customInstructions}` : "";
    return `Review this compact change set and group related changes into a ChangeOutline.

Return only JSON matching this TypeScript shape:
{
  "modules": [
    {
      "id": "short-stable-kebab-case",
      "title": "Human readable module title",
      "summary": "Optional one sentence summary",
      "files": [{ "path": "relative/path.ts", "hunkIds": ["relative/path.ts:1"] }]
    }
  ]
}

Use only paths and hunk ids present in the change set. Omit hunkIds when a module should include the whole file.

<changeSet>
${changeSetJson}
</changeSet>${extra}`;
}

export function parseChangeOutlineText(text: string): ChangeOutline {
    const jsonText = extractJsonText(text);
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch (error) {
        throw new Error(
            `Unable to parse change outline JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!isRecord(parsed)) {
        throw new Error("Unable to parse change outline JSON: response must be a JSON object");
    }
    return normalizeOutline(parsed);
}

export async function generateChangeOutline<TApi extends Api = Api>(
    options: GenerateChangeOutlineOptions<TApi>
): Promise<ChangeOutline | undefined> {
    const operations =
        options.operations ??
        (options.messages ? extractChangeOperationsFromMessages(options.messages, { runId: options.runId }) : []);
    if (operations.length === 0) {
        return { modules: [] };
    }

    const prompt = buildChangeOutlinePrompt(operations, options.customInstructions);
    const complete = options.complete ?? completeSimple;
    const streamOptions: SimpleStreamOptions = {
        apiKey: options.apiKey,
        headers: options.headers,
        signal: options.signal,
        maxTokens: options.maxTokens ?? 1800,
        temperature: 0,
    };
    const response = await complete(
        options.model,
        {
            systemPrompt: SystemPrompt,
            messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
        },
        streamOptions
    );
    if (response.stopReason === "aborted") {
        throw new Error(response.errorMessage || "Change outline generation aborted");
    }
    if (response.stopReason === "error") {
        throw new Error(`Change outline generation failed: ${response.errorMessage || "Unknown error"}`);
    }
    if (response.stopReason === "length") {
        return undefined;
    }
    return parseChangeOutlineText(textFromAssistantMessage(response));
}

function appendOperation(operations: ChangeOperation[], operation: ChangeOperation | undefined): void {
    if (!operation) {
        return;
    }
    operations.push(operation);
}

function operationFromDetails(details: unknown, runId?: string, toolCallId?: string): ChangeOperation | undefined {
    if (!isRecord(details)) {
        return undefined;
    }
    const operation = details.changeOperation;
    if (!isChangeOperation(operation)) {
        return undefined;
    }
    return {
        ...operation,
        ...(runId ? { runId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
    };
}

function isChangeOperation(value: unknown): value is ChangeOperation {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.id === "string" && typeof value.kind === "string" && typeof value.path === "string";
}

function getOrCreateCompactFile(filesByPath: Map<string, CompactFile>, operation: ChangeOperation): CompactFile {
    const existing = filesByPath.get(operation.path);
    if (existing) {
        existing.status = statusForOperation(operation);
        return existing;
    }
    const file: CompactFile = {
        path: operation.path,
        ...(operation.previousPath ? { previousPath: operation.previousPath } : {}),
        status: statusForOperation(operation),
        ...(operation.patchStatus ? { patchStatus: operation.patchStatus } : {}),
        ...(operation.patchUnavailableReason ? { patchUnavailableReason: operation.patchUnavailableReason } : {}),
        stats: { hunks: 0, additions: 0, deletions: 0 },
        hunks: [],
        operations: [],
    };
    filesByPath.set(operation.path, file);
    return file;
}

function compactOperation(operation: ChangeOperation): CompactOperation {
    return {
        id: operation.id,
        kind: operation.kind,
        ...(operation.toolCallId ? { toolCallId: operation.toolCallId } : {}),
    };
}

function statusForOperation(operation: ChangeOperation): CompactFile["status"] {
    if (operation.kind === "create") {
        return "added";
    }
    if (operation.kind === "delete") {
        return "deleted";
    }
    if (operation.kind === "rename") {
        return "renamed";
    }
    return "modified";
}

function parsePatchHunks(patch: string, fallbackPath: string): CompactHunk[] {
    const hunks: CompactHunk[] = [];
    const countsByPath = new Map<string, number>();
    let currentPath = fallbackPath;
    let oldLinesRemaining = 0;
    let newLinesRemaining = 0;
    let currentHunk: CompactHunk;
    let pendingOldPath = "";

    for (const line of patch.split(/\r?\n/)) {
        const headerMatch = line.match(HunkHeaderRe);
        if (currentHunk && !headerMatch) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
                currentHunk.additions += 1;
                newLinesRemaining -= 1;
            } else if (line.startsWith("-") && !line.startsWith("---")) {
                currentHunk.deletions += 1;
                oldLinesRemaining -= 1;
            } else if (line.startsWith(" ")) {
                oldLinesRemaining -= 1;
                newLinesRemaining -= 1;
            }
            if (oldLinesRemaining <= 0 && newLinesRemaining <= 0) {
                currentHunk = undefined;
            }
            continue;
        }

        if (headerMatch) {
            const hunkPath = currentPath || fallbackPath;
            const count = (countsByPath.get(hunkPath) ?? 0) + 1;
            countsByPath.set(hunkPath, count);
            currentHunk = {
                id: `${hunkPath}:${count}`,
                header: headerMatch[5] ?? "",
                oldStart: Number(headerMatch[1]),
                oldLines: Number(headerMatch[2] ?? "1"),
                newStart: Number(headerMatch[3]),
                newLines: Number(headerMatch[4] ?? "1"),
                additions: 0,
                deletions: 0,
            };
            oldLinesRemaining = currentHunk.oldLines;
            newLinesRemaining = currentHunk.newLines;
            hunks.push(currentHunk);
            continue;
        }

        const oldPath = parseOldPatchPath(line);
        if (oldPath) {
            pendingOldPath = oldPath;
            continue;
        }
        const newPath = parseNewPatchPath(line, pendingOldPath);
        if (newPath) {
            currentPath = newPath;
            pendingOldPath = "";
        }
    }
    return hunks;
}

function parseOldPatchPath(line: string): string {
    if (!line.startsWith("--- ")) {
        return "";
    }
    return normalizePatchPath(line.slice(4));
}

function parseNewPatchPath(line: string, oldPath: string): string {
    if (!line.startsWith("+++ ")) {
        return "";
    }
    const path = normalizePatchPath(line.slice(4));
    if (path === "/dev/null") {
        return oldPath;
    }
    return path;
}

function normalizePatchPath(path: string): string {
    const token = path.trim().split(/\s+/)[0];
    if (token.startsWith("a/") || token.startsWith("b/")) {
        return token.slice(2);
    }
    return token;
}

function statsForHunks(hunks: CompactHunk[]): CompactFile["stats"] {
    return {
        hunks: hunks.length,
        additions: sum(hunks, (hunk) => hunk.additions),
        deletions: sum(hunks, (hunk) => hunk.deletions),
    };
}

function extractJsonText(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        return fenced[1].trim();
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return text.slice(start, end + 1);
    }
    return text.trim();
}

function normalizeOutline(value: Record<string, unknown>): ChangeOutline {
    const modules = Array.isArray(value.modules)
        ? value.modules.map(normalizeModule).filter((module) => module.files.length > 0)
        : [];
    return { modules };
}

function normalizeModule(value: unknown): ChangeOutlineModule {
    if (!isRecord(value)) {
        return { id: "", title: "", files: [] };
    }
    const files = Array.isArray(value.files) ? value.files.map(normalizeOutlineFile).filter((file) => file.path) : [];
    return {
        id:
            typeof value.id === "string" && value.id
                ? value.id
                : slugify(typeof value.title === "string" ? value.title : "changes"),
        title: typeof value.title === "string" && value.title ? value.title : "Changes",
        ...(typeof value.summary === "string" && value.summary ? { summary: value.summary } : {}),
        files,
    };
}

function normalizeOutlineFile(value: unknown): ChangeOutlineFile {
    if (!isRecord(value) || typeof value.path !== "string") {
        return { path: "" };
    }
    const hunkIds = Array.isArray(value.hunkIds)
        ? value.hunkIds.filter((hunkId): hunkId is string => typeof hunkId === "string")
        : undefined;
    return {
        path: value.path,
        ...(hunkIds && hunkIds.length > 0 ? { hunkIds } : {}),
    };
}

function slugify(value: string): string {
    return (
        value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "changes"
    );
}

function textFromAssistantMessage(message: AssistantMessage): string {
    return message.content
        .filter((content): content is { type: "text"; text: string } => content.type === "text")
        .map((content) => content.text)
        .join("\n");
}

function sum<T>(items: T[], valueOf: (item: T) => number): number {
    return items.reduce((total, item) => total + valueOf(item), 0);
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null;
}
