// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { PiRun } from "@/app/store/use-pi-chat";

export type ChangeOperationKind = "patch" | "write" | "create" | "delete" | "rename";

export interface ChangeOperation {
    id: string;
    runId?: string;
    toolCallId?: string;
    kind: ChangeOperationKind;
    path: string;
    previousPath?: string;
    patch?: string;
    patchStatus?: "complete" | "unavailable";
    patchUnavailableReason?: string;
    beforeContentHash?: string;
    afterContentHash?: string;
}

export interface AgentChangeHunk {
    id: string;
    path: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    header: string;
    additions: number;
    deletions: number;
}

export interface AgentChangeStats {
    files: number;
    hunks: number;
    additions: number;
    deletions: number;
}

export interface AgentChangeFileStats {
    hunks: number;
    additions: number;
    deletions: number;
}

export interface AgentChangeFile {
    path: string;
    operations: ChangeOperation[];
    hunks: AgentChangeHunk[];
    stats: AgentChangeFileStats;
    patchUnavailableReason?: string;
}

export interface AgentChangeSet {
    files: AgentChangeFile[];
    totals: AgentChangeStats;
}

export interface AgentChangeReviewOutlineFile {
    path: string;
    hunkIds?: string[];
}

export interface AgentChangeReviewOutline {
    title?: string;
    summary?: string;
    files?: AgentChangeReviewOutlineFile[];
}

export interface AgentChangeReviewFile {
    path: string;
    hunks: AgentChangeHunk[];
    stats: AgentChangeFileStats;
    patchUnavailableReason?: string;
}

export interface AgentChangeReview {
    title: string;
    summary: string;
    files: AgentChangeReviewFile[];
    totals: AgentChangeStats;
    isFallback: boolean;
    validationErrors: string[];
}

const HunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function extractChangeOperations(run: PiRun): ChangeOperation[] {
    const operations: ChangeOperation[] = [];
    for (const message of run.responseMessages) {
        if (message.role !== "toolResult") continue;
        appendOperation(operations, operationFromDetails(message.details, run.runId, message.toolCallId));
        for (const content of message.content ?? []) {
            if (content.type !== "toolResult") continue;
            const toolCallId = stringField(content, "toolCallId") || stringField(content, "toolUseId");
            appendOperation(operations, operationFromDetails(content.details, run.runId, toolCallId));
        }
    }
    return operations;
}

export function parseUnifiedPatchHunks(patch: string): AgentChangeHunk[] {
    const hunks: AgentChangeHunk[] = [];
    const hunkCountsByPath = new Map<string, number>();
    let currentPath = "";
    let currentHunk: AgentChangeHunk;

    for (const line of patch.split(/\r?\n/)) {
        const nextPath = parsePatchPath(line);
        if (nextPath) {
            currentPath = nextPath;
            currentHunk = undefined;
            continue;
        }

        const headerMatch = line.match(HunkHeaderRe);
        if (headerMatch) {
            const path = currentPath || "unknown";
            const nextCount = (hunkCountsByPath.get(path) ?? 0) + 1;
            hunkCountsByPath.set(path, nextCount);
            currentHunk = {
                id: `${path}:${nextCount}`,
                path,
                oldStart: Number(headerMatch[1]),
                oldLines: Number(headerMatch[2] ?? "1"),
                newStart: Number(headerMatch[3]),
                newLines: Number(headerMatch[4] ?? "1"),
                header: headerMatch[5] ?? "",
                additions: 0,
                deletions: 0,
            };
            hunks.push(currentHunk);
            continue;
        }

        if (!currentHunk) continue;
        if (line.startsWith("+") && !line.startsWith("+++")) {
            currentHunk.additions += 1;
            continue;
        }
        if (line.startsWith("-") && !line.startsWith("---")) {
            currentHunk.deletions += 1;
        }
    }

    return hunks;
}

export function buildChangeSet(operations: ChangeOperation[]): AgentChangeSet {
    const filesByPath = new Map<string, AgentChangeFile>();
    for (const operation of operations) {
        const file = getOrCreateFile(filesByPath, operation.path);
        file.operations.push(operation);
        if (operation.patchUnavailableReason && !file.patchUnavailableReason) {
            file.patchUnavailableReason = operation.patchUnavailableReason;
        }
        if (operation.patchStatus === "unavailable" || !operation.patch) continue;
        for (const hunk of parseUnifiedPatchHunks(operation.patch)) {
            const hunkFile = getOrCreateFile(filesByPath, hunk.path === "unknown" ? operation.path : hunk.path);
            if (!hunkFile.operations.includes(operation)) {
                hunkFile.operations.push(operation);
            }
            hunkFile.hunks.push(
                hunk.path === "unknown"
                    ? { ...hunk, path: operation.path, id: `${operation.path}:${hunkFile.hunks.length + 1}` }
                    : hunk
            );
        }
    }

    const files = Array.from(filesByPath.values()).map((file) => ({
        ...file,
        stats: statsForHunks(file.hunks),
    }));
    return {
        files,
        totals: {
            files: files.length,
            hunks: sum(files, (file) => file.stats.hunks),
            additions: sum(files, (file) => file.stats.additions),
            deletions: sum(files, (file) => file.stats.deletions),
        },
    };
}

export function deriveAgentChangeReview(run: PiRun, outline?: AgentChangeReviewOutline): AgentChangeReview {
    return buildChangeReview(buildChangeSet(extractChangeOperations(run)), outline);
}

export function buildChangeReview(changeSet: AgentChangeSet, outline?: AgentChangeReviewOutline): AgentChangeReview {
    if (!outline) {
        return fallbackReview(changeSet, []);
    }

    const validationErrors = validateOutline(changeSet, outline);
    if (validationErrors.length > 0) {
        return fallbackReview(changeSet, validationErrors);
    }

    const files = (outline.files ?? changeSet.files).map((outlineFile) => {
        const file = findFile(changeSet, outlineFile.path);
        const hunks = outlineFile.hunkIds
            ? outlineFile.hunkIds.map((hunkId) => findHunk(changeSet, hunkId))
            : file.hunks;
        return reviewFile(file, hunks);
    });

    return {
        title: outline.title || "Changed files",
        summary: outline.summary || summarizeTotals(changeSet.totals),
        files,
        totals: changeSet.totals,
        isFallback: false,
        validationErrors: [],
    };
}

function appendOperation(operations: ChangeOperation[], operation: ChangeOperation): void {
    if (!operation) return;
    operations.push(operation);
}

function operationFromDetails(details: unknown, runId: string, fallbackToolCallId?: string): ChangeOperation {
    if (!details || typeof details !== "object") return undefined;
    const operation = (details as { changeOperation?: unknown }).changeOperation;
    if (!isChangeOperation(operation)) return undefined;
    return {
        ...operation,
        runId: operation.runId || runId,
        toolCallId: operation.toolCallId || fallbackToolCallId,
    };
}

function isChangeOperation(value: unknown): value is ChangeOperation {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<ChangeOperation>;
    return typeof candidate.id === "string" && typeof candidate.kind === "string" && typeof candidate.path === "string";
}

function parsePatchPath(line: string): string {
    if (!line.startsWith("+++ ")) return "";
    const rawPath = line.slice(4).trim();
    if (!rawPath || rawPath === "/dev/null") return "";
    return rawPath.replace(/^b\//, "");
}

function getOrCreateFile(filesByPath: Map<string, AgentChangeFile>, path: string): AgentChangeFile {
    let file = filesByPath.get(path);
    if (file) return file;
    file = {
        path,
        operations: [],
        hunks: [],
        stats: { hunks: 0, additions: 0, deletions: 0 },
    };
    filesByPath.set(path, file);
    return file;
}

function statsForHunks(hunks: AgentChangeHunk[]): AgentChangeFileStats {
    return {
        hunks: hunks.length,
        additions: sum(hunks, (hunk) => hunk.additions),
        deletions: sum(hunks, (hunk) => hunk.deletions),
    };
}

function validateOutline(changeSet: AgentChangeSet, outline: AgentChangeReviewOutline): string[] {
    const errors: string[] = [];
    for (const outlineFile of outline.files ?? []) {
        if (!findFile(changeSet, outlineFile.path)) {
            errors.push(`Outline references unknown file "${outlineFile.path}".`);
        }
        for (const hunkId of outlineFile.hunkIds ?? []) {
            const hunk = findHunk(changeSet, hunkId);
            if (!hunk) {
                errors.push(`Outline references unknown hunk "${hunkId}".`);
                continue;
            }
            if (hunk.path !== outlineFile.path) {
                errors.push(`Outline references hunk "${hunkId}" outside file "${outlineFile.path}".`);
            }
        }
    }
    return errors;
}

function fallbackReview(changeSet: AgentChangeSet, validationErrors: string[]): AgentChangeReview {
    return {
        title: "Changed files",
        summary: summarizeTotals(changeSet.totals),
        files: changeSet.files.map((file) => reviewFile(file, file.hunks)),
        totals: changeSet.totals,
        isFallback: true,
        validationErrors,
    };
}

function reviewFile(file: AgentChangeFile, hunks: AgentChangeHunk[]): AgentChangeReviewFile {
    return {
        path: file.path,
        hunks,
        stats: statsForHunks(hunks),
        ...(file.patchUnavailableReason ? { patchUnavailableReason: file.patchUnavailableReason } : {}),
    };
}

function summarizeTotals(totals: AgentChangeStats): string {
    return `${totals.files} ${plural(totals.files, "file")} changed with ${totals.additions} ${plural(
        totals.additions,
        "addition"
    )} and ${totals.deletions} ${plural(totals.deletions, "deletion")}.`;
}

function plural(count: number, singular: string): string {
    return count === 1 ? singular : `${singular}s`;
}

function findFile(changeSet: AgentChangeSet, path: string): AgentChangeFile {
    return changeSet.files.find((file) => file.path === path);
}

function findHunk(changeSet: AgentChangeSet, hunkId: string): AgentChangeHunk {
    return changeSet.files.flatMap((file) => file.hunks).find((hunk) => hunk.id === hunkId);
}

function stringField(value: unknown, field: string): string {
    if (!value || typeof value !== "object") return "";
    const fieldValue = (value as Record<string, unknown>)[field];
    return typeof fieldValue === "string" ? fieldValue : "";
}

function sum<T>(items: T[], getValue: (item: T) => number): number {
    return items.reduce((total, item) => total + getValue(item), 0);
}
