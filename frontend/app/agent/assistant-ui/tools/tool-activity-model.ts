// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { normalizeFileTabPath } from "@/app/workspace/workspace-content-state";
import { isAbsoluteLocalPath, joinLocalPath } from "@/util/local-path";

export type ToolActivityStatus =
    | { type: "running" }
    | { type: "complete" }
    | { type: "requires-action" }
    | { type: "incomplete"; reason?: string; error?: unknown };

export type ToolActivityPart = {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    args: unknown;
    status?: ToolActivityStatus;
    result?: unknown;
    isError?: boolean;
};

export type ToolActivityKind = "search" | "read";

export type SearchActivityRule = {
    query: string;
    scopes: string[];
};

export type SearchActivityModel = {
    label: "Searching" | "Searched";
    rules: SearchActivityRule[];
    active: boolean;
    errors: string[];
};

export type ReadActivityEntry = {
    absolutePath: string;
    displayPath: string;
    basename: string;
    failed: boolean;
};

export type ReadActivityModel = {
    label: "Reading" | "Read";
    summary: string;
    entries: ReadActivityEntry[];
    active: boolean;
    errors: string[];
};

function record(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    return value as Record<string, unknown>;
}

function stringArg(args: unknown, key: string): string | undefined {
    const value = record(args)?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getToolActivityKind(part: ToolActivityPart): ToolActivityKind | undefined {
    if (part.status?.type === "requires-action") return;
    if (part.toolName === "read") return stringArg(part.args, "path") ? "read" : undefined;
    if (part.toolName === "find" || part.toolName === "grep") {
        return stringArg(part.args, "pattern") ? "search" : undefined;
    }
    return;
}

function activityError(part: ToolActivityPart): string | undefined {
    if (part.status?.type === "incomplete") {
        if (typeof part.status.error === "string") return part.status.error;
        return part.status.reason === "cancelled" ? "Cancelled" : "Tool failed";
    }
    if (part.isError) return "Tool failed";
    return;
}

export function buildSearchActivityModel(parts: ToolActivityPart[]): SearchActivityModel {
    const active = parts.some((part) => part.status?.type === "running");
    const rules = parts.map((part) => {
        const query = stringArg(part.args, "pattern") ?? "";
        if (part.toolName === "find") {
            const path = stringArg(part.args, "path");
            return { query, scopes: path && path !== "." ? [path] : [] };
        }
        return {
            query,
            scopes: [stringArg(part.args, "path"), stringArg(part.args, "glob")].filter(
                (value): value is string => !!value && value !== "."
            ),
        };
    });
    return {
        label: active ? "Searching" : "Searched",
        rules,
        active,
        errors: parts.map(activityError).filter((value): value is string => !!value),
    };
}

function resolveReadPath(path: string, workspaceDir: string): string {
    const normalizedPath = path.replace(/\\/g, "/");
    return normalizeFileTabPath(
        isAbsoluteLocalPath(normalizedPath) ? normalizedPath : joinLocalPath(workspaceDir, normalizedPath)
    );
}

function displayReadPath(absolutePath: string, workspaceDir: string): string {
    const root = normalizeFileTabPath(workspaceDir);
    if (absolutePath === root) return absolutePath.split("/").filter(Boolean).at(-1) ?? absolutePath;
    return absolutePath.startsWith(`${root}/`) ? absolutePath.slice(root.length + 1) : absolutePath;
}

function readSummary(entries: ReadActivityEntry[]): string {
    if (entries.length === 1) return entries[0].basename;
    if (entries.length === 2) return `${entries[0].basename} and ${entries[1].basename}`;
    return `${entries[0].basename} and ${entries.length - 1} other files`;
}

export function buildReadActivityModel(parts: ToolActivityPart[], workspaceDir: string): ReadActivityModel {
    const byPath = new Map<string, ReadActivityEntry>();
    for (const part of parts) {
        const path = stringArg(part.args, "path");
        if (!path) continue;
        const absolutePath = resolveReadPath(path, workspaceDir);
        const previous = byPath.get(absolutePath);
        const failed = !!activityError(part);
        byPath.set(absolutePath, {
            absolutePath,
            displayPath: displayReadPath(absolutePath, workspaceDir),
            basename: absolutePath.split("/").filter(Boolean).at(-1) ?? absolutePath,
            failed: previous ? previous.failed && failed : failed,
        });
    }
    const entries = [...byPath.values()];
    const active = parts.some((part) => part.status?.type === "running");
    return {
        label: active ? "Reading" : "Read",
        summary: readSummary(entries),
        entries,
        active,
        errors: parts.map(activityError).filter((value): value is string => !!value),
    };
}
