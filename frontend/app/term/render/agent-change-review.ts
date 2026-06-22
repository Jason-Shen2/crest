// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { PiRun } from "@/app/store/use-pi-chat";

export type ChangeOperationKind = "patch" | "write" | "create" | "delete" | "rename";
export type ChangeSetFileStatus = "added" | "modified" | "deleted" | "renamed";
export type ChangeReviewWarningCode = "unknown-file" | "unknown-hunk" | "hunk-file-mismatch";

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

export interface ChangeSetHunk {
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

export interface ChangeSetStats {
    files: number;
    hunks: number;
    additions: number;
    deletions: number;
}

export interface ChangeSetFileStats {
    hunks: number;
    additions: number;
    deletions: number;
}

export interface ChangeSetFile {
    path: string;
    previousPath?: string;
    status: ChangeSetFileStatus;
    operations: ChangeOperation[];
    hunks: ChangeSetHunk[];
    stats: ChangeSetFileStats;
    patchStatus?: "complete" | "unavailable";
    patchUnavailableReason?: string;
}

export interface ChangeSet {
    id: string;
    files: ChangeSetFile[];
    totals: ChangeSetStats;
}

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

export interface ChangeReviewFile {
    path: string;
    previousPath?: string;
    status: ChangeSetFileStatus;
    hunks: ChangeSetHunk[];
    stats: ChangeSetFileStats;
    patchStatus?: "complete" | "unavailable";
    patchUnavailableReason?: string;
}

export interface ChangeReviewModule {
    id: string;
    title: string;
    summary?: string;
    files: ChangeReviewFile[];
}

export interface ChangeReviewWarning {
    code: ChangeReviewWarningCode;
    message: string;
    severity: "warning";
}

export interface ChangeReview {
    changeSetId: string;
    changeSet: ChangeSet;
    modules: ChangeReviewModule[];
    ungroupedFiles: ChangeReviewFile[];
    warnings: ChangeReviewWarning[];
}

const HunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function extractChangeOperations(run: PiRun): ChangeOperation[] {
    const operations: ChangeOperation[] = [];
    for (const message of run.responseMessages) {
        if (message.role !== "toolResult") continue;
        if (message.isError === true) continue;
        appendOperation(operations, operationFromDetails(message.details, run.runId, message.toolCallId));
        for (const content of message.content ?? []) {
            if (content.type !== "toolResult") continue;
            if (content.isError === true) continue;
            const toolCallId = stringField(content, "toolCallId") || stringField(content, "toolUseId");
            appendOperation(operations, operationFromDetails(content.details, run.runId, toolCallId));
        }
    }
    return operations;
}

export function parseUnifiedPatchHunks(patch: string): ChangeSetHunk[] {
    const hunks: ChangeSetHunk[] = [];
    const hunkCountsByPath = new Map<string, number>();
    let currentPath = "";
    let currentHunk: ChangeSetHunk;

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

export function buildChangeSet(operations: ChangeOperation[]): ChangeSet {
    const filesByPath = new Map<string, ChangeSetFile>();
    for (const operation of operations) {
        const operationStatus = statusForOperation(operation);
        const file = getOrCreateFile(filesByPath, operation.path, operationStatus);
        file.operations.push(operation);
        file.status = operationStatus;
        file.previousPath = operation.previousPath || file.previousPath;
        file.patchStatus = operation.patchStatus || file.patchStatus;
        if (operation.patchUnavailableReason && !file.patchUnavailableReason) {
            file.patchUnavailableReason = operation.patchUnavailableReason;
        }
        if (operation.patchStatus === "unavailable" || !operation.patch) continue;
        for (const hunk of parseUnifiedPatchHunks(operation.patch)) {
            const hunkFile = getOrCreateFile(
                filesByPath,
                hunk.path === "unknown" ? operation.path : hunk.path,
                operationStatus
            );
            if (!hunkFile.operations.includes(operation)) {
                hunkFile.operations.push(operation);
            }
            hunkFile.status = operationStatus;
            hunkFile.previousPath = operation.previousPath || hunkFile.previousPath;
            hunkFile.patchStatus = operation.patchStatus || hunkFile.patchStatus;
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
        id: operations[0]?.runId || "changes",
        files,
        totals: {
            files: files.length,
            hunks: sum(files, (file) => file.stats.hunks),
            additions: sum(files, (file) => file.stats.additions),
            deletions: sum(files, (file) => file.stats.deletions),
        },
    };
}

export function deriveAgentChangeReview(run: PiRun, outline?: ChangeOutline): ChangeReview {
    return buildChangeReview(buildChangeSet(extractChangeOperations(run)), outline);
}

export function buildChangeReview(changeSet: ChangeSet, outline?: ChangeOutline): ChangeReview {
    const warnings = validateOutline(changeSet, outline);
    if (warnings.length > 0) {
        return makeReview(
            changeSet,
            [],
            changeSet.files.map((file) => reviewFile(file, file.hunks)),
            warnings
        );
    }

    const modules = (outline?.modules ?? []).map((module) => ({
        id: module.id,
        title: module.title,
        ...(module.summary ? { summary: module.summary } : {}),
        files: module.files.map((outlineFile) => {
            const file = findFile(changeSet, outlineFile.path);
            const hunks = outlineFile.hunkIds
                ? outlineFile.hunkIds.map((hunkId) => findHunk(changeSet, hunkId))
                : file.hunks;
            return reviewFile(file, hunks);
        }),
    }));
    const groupedPaths = new Set(modules.flatMap((module) => module.files.map((file) => file.path)));
    const ungroupedFiles = changeSet.files
        .filter((file) => !groupedPaths.has(file.path))
        .map((file) => reviewFile(file, file.hunks));
    return makeReview(changeSet, modules, ungroupedFiles, []);
}

function makeReview(
    changeSet: ChangeSet,
    modules: ChangeReviewModule[],
    ungroupedFiles: ChangeReviewFile[],
    warnings: ChangeReviewWarning[]
): ChangeReview {
    return {
        changeSetId: changeSet.id,
        changeSet,
        modules,
        ungroupedFiles,
        warnings,
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

function getOrCreateFile(
    filesByPath: Map<string, ChangeSetFile>,
    path: string,
    status: ChangeSetFileStatus
): ChangeSetFile {
    let file = filesByPath.get(path);
    if (file) return file;
    file = {
        path,
        status,
        operations: [],
        hunks: [],
        stats: { hunks: 0, additions: 0, deletions: 0 },
    };
    filesByPath.set(path, file);
    return file;
}

function statusForOperation(operation: ChangeOperation): ChangeSetFileStatus {
    if (operation.kind === "create") return "added";
    if (operation.kind === "delete") return "deleted";
    if (operation.kind === "rename") return "renamed";
    return "modified";
}

function statsForHunks(hunks: ChangeSetHunk[]): ChangeSetFileStats {
    return {
        hunks: hunks.length,
        additions: sum(hunks, (hunk) => hunk.additions),
        deletions: sum(hunks, (hunk) => hunk.deletions),
    };
}

function validateOutline(changeSet: ChangeSet, outline?: ChangeOutline): ChangeReviewWarning[] {
    const warnings: ChangeReviewWarning[] = [];
    for (const module of outline?.modules ?? []) {
        for (const outlineFile of module.files) {
            if (!findFile(changeSet, outlineFile.path)) {
                warnings.push({
                    code: "unknown-file",
                    message: `Outline references unknown file "${outlineFile.path}".`,
                    severity: "warning",
                });
            }
            for (const hunkId of outlineFile.hunkIds ?? []) {
                const hunk = findHunk(changeSet, hunkId);
                if (!hunk) {
                    warnings.push({
                        code: "unknown-hunk",
                        message: `Outline references unknown hunk "${hunkId}".`,
                        severity: "warning",
                    });
                    continue;
                }
                if (hunk.path !== outlineFile.path) {
                    warnings.push({
                        code: "hunk-file-mismatch",
                        message: `Outline references hunk "${hunkId}" outside file "${outlineFile.path}".`,
                        severity: "warning",
                    });
                }
            }
        }
    }
    return warnings;
}

function reviewFile(file: ChangeSetFile, hunks: ChangeSetHunk[]): ChangeReviewFile {
    return {
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        status: file.status,
        hunks,
        stats: statsForHunks(hunks),
        ...(file.patchStatus ? { patchStatus: file.patchStatus } : {}),
        ...(file.patchUnavailableReason ? { patchUnavailableReason: file.patchUnavailableReason } : {}),
    };
}

function findFile(changeSet: ChangeSet, path: string): ChangeSetFile {
    return changeSet.files.find((file) => file.path === path);
}

function findHunk(changeSet: ChangeSet, hunkId: string): ChangeSetHunk {
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
