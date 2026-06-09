// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { UIcon } from "@/app/element/ui-icon";
import { getApi } from "@/app/store/global";
import { cn } from "@/util/util";
import type { MouseEvent, ReactNode } from "react";
import { memo, useMemo, useState } from "react";

export interface PiToolCall {
    id: string;
    name: string;
    input: unknown;
}

export interface PiToolResultContent {
    content?: Array<{ type: string; text?: string; [field: string]: unknown }>;
    details?: unknown;
    isError?: boolean;
}

export interface ToolCallCardProps {
    call: PiToolCall;
    result?: PiToolResultContent;
    defaultExpanded?: boolean;
}

type Status = "running" | "done" | "error";
type ToolKind = "command" | "modify" | "read" | "search" | "list" | "fetch" | "generic";

const SUMMARY_MAX_LEN = 180;

function deriveStatus(result: PiToolResultContent | undefined): Status {
    if (!result) return "running";
    return result.isError ? "error" : "done";
}

function describeStatus(status: Status): { icon: string; accent: string; label: string; badgeClass: string } {
    switch (status) {
        case "error":
            return {
                icon: "x-circle",
                accent: "text-rose-400",
                label: "Failed",
                badgeClass: "border-rose-500/25 bg-rose-500/8 text-rose-300",
            };
        case "running":
            return {
                icon: "clock-loader",
                accent: "text-[var(--ansi-yellow)]",
                label: "Running",
                badgeClass: "border-fg-overlay-2 bg-fg-overlay-1/45 text-secondary/85",
            };
        case "done":
            return {
                icon: "check-circle-broken",
                accent: "text-[var(--ansi-green)]",
                label: "Completed",
                badgeClass: "border-fg-overlay-2 bg-fg-overlay-1/45 text-secondary/85",
            };
    }
}

function stringify(input: unknown, pretty = false): string {
    if (input == null) return "";
    if (typeof input === "string") return input;
    try {
        return JSON.stringify(input, null, pretty ? 2 : 0);
    } catch {
        return String(input);
    }
}

function compactText(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= SUMMARY_MAX_LEN) return oneLine;
    return `${oneLine.slice(0, SUMMARY_MAX_LEN - 1)}...`;
}

function objectString(input: unknown, keys: string[]): string {
    if (!input || typeof input !== "object") return "";
    const record = input as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

function detailsString(details: unknown, keys: string[]): string {
    return objectString(details, keys);
}

function isAbsolutePath(path: string): boolean {
    return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function joinPath(base: string, path: string): string {
    if (!base) return path;
    if (base.endsWith("/") || base.endsWith("\\")) return `${base}${path}`;
    return `${base}/${path}`;
}

function openablePath(input: unknown, path: string): string {
    if (!path) return "";
    if (isAbsolutePath(path)) return path;
    const cwd = objectString(input, ["workdir", "cwd"]);
    return cwd ? joinPath(cwd, path) : "";
}

function inputSummary(input: unknown): string {
    const value = objectString(input, [
        "command",
        "cmd",
        "path",
        "file",
        "filepath",
        "url",
        "pattern",
        "query",
        "q",
        "code",
        "expression",
        "message",
        "text",
        "name",
    ]);
    if (value) return value;
    if (typeof input === "string") return input;
    return "View details";
}

function humanizeToolName(name: string): string {
    const visibleName = name.startsWith("mcp__") ? name.split("__").slice(-1)[0] : name;
    const text = visibleName
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim();
    if (!text) return "Tool call";
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function matchesToolName(name: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(name));
}

function describeTool(call: PiToolCall): { title: string; summary: string; icon: string; kind: ToolKind } {
    const name = call.name.toLowerCase();
    const command = objectString(call.input, ["command", "cmd"]);
    if (
        matchesToolName(name, [
            /(^|[._:-])bash$/,
            /(^|[._:-])shell[_-]?exec$/,
            /(^|[._:-])exec[_-]?command$/,
            /(^|[._:-])run[_-]?command$/,
            /^exec$/,
        ])
    ) {
        return {
            title: "Run shell command",
            summary: command || inputSummary(call.input),
            icon: "terminal",
            kind: "command",
        };
    }

    const path = objectString(call.input, ["path", "file", "filepath"]);
    if (matchesToolName(name, [/^read$/, /(^|[._:-])read[_-]?file$/])) {
        return { title: "Read file", summary: path || inputSummary(call.input), icon: "file", kind: "read" };
    }
    if (
        matchesToolName(name, [
            /^write$/,
            /^edit$/,
            /(^|[._:-])write[_-]?file$/,
            /(^|[._:-])edit[_-]?file$/,
            /(^|[._:-])apply[_-]?patch$/,
        ])
    ) {
        return {
            title: "Modify file",
            summary: path || inputSummary(call.input),
            icon: "file-code-02",
            kind: "modify",
        };
    }
    if (matchesToolName(name, [/^grep$/, /^find$/, /(^|[._:-])search$/, /(^|[._:-])search[_-]?codebase$/])) {
        return {
            title: "Search code",
            summary: objectString(call.input, ["query", "pattern"]) || inputSummary(call.input),
            icon: "search",
            kind: "search",
        };
    }

    if (matchesToolName(name, [/^ls$/, /(^|[._:-])list[_-]?files$/])) {
        return { title: "List files", summary: path || inputSummary(call.input), icon: "file", kind: "list" };
    }
    if (matchesToolName(name, [/^web[_-]?fetch$/, /(^|[._:-])fetch$/])) {
        return {
            title: "Fetch URL",
            summary: objectString(call.input, ["url"]) || inputSummary(call.input),
            icon: "compass-3",
            kind: "fetch",
        };
    }

    return { title: humanizeToolName(call.name), summary: inputSummary(call.input), icon: "gear", kind: "generic" };
}

function activityTitle(kind: ToolKind, status: Status, fallback: string): string {
    const titles: Record<ToolKind, Record<Status, string>> = {
        command: { running: "Running command", done: "Ran command", error: "Command failed" },
        modify: { running: "Editing file", done: "Edited file", error: "Edit failed" },
        read: { running: "Reading file", done: "Read file", error: "Read failed" },
        search: { running: "Searching code", done: "Searched code", error: "Search failed" },
        list: { running: "Listing files", done: "Listed files", error: "List failed" },
        fetch: { running: "Fetching URL", done: "Fetched URL", error: "Fetch failed" },
        generic: { running: fallback, done: fallback, error: `${fallback} failed` },
    };
    return titles[kind][status];
}

function outputLineCount(text: string): number {
    const trimmed = text.trimEnd();
    if (!trimmed) return 0;
    return trimmed.split("\n").length;
}

function resultMetadata(status: Status, resultText: string, hasModifyDiff: boolean): string {
    if (status === "running") return "In progress";
    if (status === "error") return "Needs attention";
    if (hasModifyDiff) return "Diff ready";
    const lines = outputLineCount(resultText);
    if (lines === 0) return "No output";
    if (lines === 1) return "1 line output";
    return `${lines} lines output`;
}

function activityAction(kind: ToolKind, status: Status, hasModifyDiff: boolean): string {
    if (status === "error") return "Inspect";
    if (hasModifyDiff) return "View diff";
    if (kind === "read" || kind === "list" || kind === "fetch" || kind === "search") return "Results";
    return "Details";
}

function renderResultText(result: PiToolResultContent | undefined): string {
    if (!result || !result.content) return "";
    const parts: string[] = [];
    for (const c of result.content) {
        if (c.type === "text" && typeof c.text === "string") {
            parts.push(c.text);
        } else if (c.type === "image") {
            parts.push("[image]");
        } else {
            parts.push(`[${c.type}]`);
        }
    }
    return parts.join("\n");
}

function DetailLabel({ children }: { children: ReactNode }) {
    return <div className="mb-1 text-[10px] uppercase tracking-wide text-secondary/60">{children}</div>;
}

function DetailPre({ children, tone }: { children: ReactNode; tone?: "error" }) {
    return (
        <pre
            className={cn(
                "mb-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-fg-overlay-1/30 p-2 text-foreground/90",
                tone === "error" && "text-rose-300"
            )}
        >
            {children || "(empty)"}
        </pre>
    );
}

function DetailRow({ label, value }: { label: string; value: string }) {
    if (!value) return null;
    return (
        <div className="mb-2 grid grid-cols-[72px_minmax(0,1fr)] gap-2">
            <div className="text-[10px] uppercase tracking-wide text-secondary/60">{label}</div>
            <div className="min-w-0 break-words text-foreground/90">{value}</div>
        </div>
    );
}

function fileNameFromPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    return normalized.split("/").filter(Boolean).pop() || path;
}

function IconActionButton({
    title,
    icon,
    onClick,
}: {
    title: string;
    icon: string;
    onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            onClick={onClick}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-secondary hover:bg-fg-overlay-2 hover:text-foreground"
        >
            <UIcon name={icon} size={11} />
        </button>
    );
}

function DiffFileTabs({ path, openPath }: { path: string; openPath: string }) {
    if (!path) return null;
    return (
        <div
            className="flex min-w-0 items-center border-b border-fg-overlay-2 bg-fg-overlay-1"
            data-tool-diff-tabs="true"
        >
            <div className="min-w-0 flex-1 overflow-x-auto">
                <button
                    type="button"
                    title={path}
                    data-tool-diff-tab="true"
                    className="flex h-8 w-[120px] cursor-pointer items-center bg-fg-overlay-2 px-2 text-left text-secondary/85 hover:bg-fg-overlay-3"
                >
                    <span className="min-w-0 truncate">{fileNameFromPath(path)}</span>
                </button>
            </div>
            <div className="flex shrink-0 items-center gap-0.5 pr-2">
                <IconActionButton
                    title="Copy path"
                    icon="copy"
                    onClick={(e) => {
                        e.stopPropagation();
                        void navigator.clipboard.writeText(path);
                    }}
                />
                {openPath && (
                    <IconActionButton
                        title="Open file"
                        icon="share-01"
                        onClick={(e) => {
                            e.stopPropagation();
                            getApi().openNativePath(openPath);
                        }}
                    />
                )}
            </div>
        </div>
    );
}

function diffStats(diff: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) {
            added += 1;
        } else if (line.startsWith("-")) {
            removed += 1;
        }
    }
    return { added, removed };
}

function DiffStats({ added, removed }: { added: number; removed: number }) {
    if (added === 0 && removed === 0) return null;
    return (
        <span
            className="inline-flex shrink-0 items-center gap-2 rounded border border-fg-overlay-3 bg-fg-overlay-1/50 px-2 py-0.5 text-[10px]"
            data-diff-stat-added={added}
            data-diff-stat-removed={removed}
        >
            {added > 0 && <span className="text-emerald-300">+{added}</span>}
            {added > 0 && removed > 0 && <span className="h-1 w-1 rounded-full bg-secondary/40" />}
            {removed > 0 && <span className="text-rose-300">-{removed}</span>}
        </span>
    );
}

function diffLineType(line: string): "add" | "remove" | "hunk" | "context" {
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "remove";
    return "context";
}

interface DiffRow {
    type: "add" | "remove" | "hunk" | "context";
    oldLine: string;
    newLine: string;
    marker: string;
    content: string;
}

function parseDiffLine(line: string): DiffRow {
    const type = diffLineType(line);
    if (type === "hunk") {
        return { type, oldLine: "", newLine: "", marker: "", content: "..." };
    }

    const marker = line.startsWith("+") || line.startsWith("-") ? line[0] : "";
    const body = marker ? line.slice(1) : line.startsWith(" ") ? line.slice(1) : line;
    const lineMatch = body.match(/^\s*(\d+)\s(.*)$/);
    const lineNumber = lineMatch ? lineMatch[1] : "";
    const content = lineMatch ? lineMatch[2] : body.replace(/^ /, "");
    return {
        type,
        oldLine: type === "add" ? "" : lineNumber,
        newLine: type === "remove" ? "" : lineNumber,
        marker,
        content,
    };
}

function CodeDiff({ diff, path }: { diff: string; path: string }) {
    const rows = diff
        .split("\n")
        .filter((line) => !line.startsWith("+++") && !line.startsWith("---"))
        .map(parseDiffLine);
    return (
        <div
            className="overflow-hidden bg-background"
            data-tool-diff="true"
            data-tool-diff-file={path}
        >
            <div className="max-h-[500px] overflow-auto py-1 text-[11px] leading-5" data-tool-diff-editor="true">
                {rows.map((row, idx) => {
                    return (
                        <div
                            key={idx}
                            data-diff-line-type={row.type}
                            className={cn(
                                "grid grid-cols-[20px_40px_40px_minmax(0,1fr)] px-2",
                                row.type === "add" && "bg-emerald-500/10 text-emerald-200",
                                row.type === "remove" && "bg-rose-500/10 text-rose-200",
                                row.type === "hunk" && "text-secondary/45",
                                row.type === "context" && "text-foreground/85"
                            )}
                        >
                            <span className="select-none text-center text-secondary/50">{row.marker}</span>
                            <span className="select-none text-right text-secondary/45">{row.oldLine}</span>
                            <span className="select-none text-right text-secondary/45">{row.newLine}</span>
                            <span className="min-w-max whitespace-pre pl-4">{row.content || " "}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function renderInputDetails(call: PiToolCall, kind: ToolKind, showStructuredFallback = true) {
    const input = call.input;
    const path = objectString(input, ["path", "file", "filepath"]);
    if (kind === "command") {
        return (
            <>
                <DetailLabel>command</DetailLabel>
                <DetailPre>{objectString(input, ["command", "cmd"]) || stringify(input)}</DetailPre>
                <DetailRow label="cwd" value={objectString(input, ["workdir", "cwd"])} />
            </>
        );
    }
    if (kind === "modify") {
        const content = objectString(input, ["content", "newContent", "replacement", "patch", "diff"]);
        if (!content && showStructuredFallback) {
            return (
                <>
                    <DetailLabel>input</DetailLabel>
                    <DetailPre>{stringify(input, true)}</DetailPre>
                </>
            );
        }
        return (
            <>
                {content ? (
                    <>
                        <DetailLabel>content</DetailLabel>
                        <DetailPre>{content}</DetailPre>
                    </>
                ) : null}
            </>
        );
    }
    if (kind === "search") {
        return (
            <>
                <DetailRow label="query" value={objectString(input, ["query", "pattern", "q"])} />
                <DetailRow label="path" value={path} />
                <DetailRow label="glob" value={objectString(input, ["glob"])} />
            </>
        );
    }
    if (kind === "read" || kind === "list") {
        return <DetailRow label="path" value={path || inputSummary(input)} />;
    }
    if (kind === "fetch") {
        return <DetailRow label="url" value={objectString(input, ["url"]) || inputSummary(input)} />;
    }

    const rows = Object.entries((input && typeof input === "object" ? input : {}) as Record<string, unknown>)
        .filter(([, value]) => value == null || ["string", "number", "boolean"].includes(typeof value))
        .slice(0, 8);
    if (rows.length === 0) return <DetailPre>{inputSummary(input)}</DetailPre>;
    return (
        <>
            {rows.map(([key, value]) => (
                <DetailRow key={key} label={key} value={String(value ?? "")} />
            ))}
        </>
    );
}

function modificationDiff(result: PiToolResultContent | undefined): string {
    if (!result) return "";
    return detailsString(result.details, ["diff", "patch"]);
}

function ModifyResultDetails({ call, result }: { call: PiToolCall; result: PiToolResultContent | undefined }) {
    const path = objectString(call.input, ["path", "file", "filepath"]);
    const diff = modificationDiff(result);
    if (!path && !diff) return null;
    return (
        <>
            <DiffFileTabs path={path} openPath={openablePath(call.input, path)} />
            {diff && <CodeDiff diff={diff} path={path} />}
        </>
    );
}

export const ToolCallCard = memo(({ call, result, defaultExpanded = false }: ToolCallCardProps) => {
    const status = deriveStatus(result);
    const { icon, accent, label, badgeClass } = describeStatus(status);
    const [expanded, setExpanded] = useState(defaultExpanded);
    const tool = useMemo(() => describeTool(call), [call]);
    const title = useMemo(() => activityTitle(tool.kind, status, tool.title), [tool.kind, tool.title, status]);
    const inputSummary = useMemo(() => compactText(tool.summary), [tool.summary]);
    const resultText = useMemo(() => renderResultText(result), [result]);
    const resultPreview = useMemo(() => compactText(resultText), [resultText]);
    const modifyDiff = useMemo(() => modificationDiff(result), [result]);
    const modifyDiffStats = useMemo(() => diffStats(modifyDiff), [modifyDiff]);
    const hasModifyDiff = tool.kind === "modify" && Boolean(modifyDiff);
    const metadata = useMemo(() => resultMetadata(status, resultText, hasModifyDiff), [status, resultText, hasModifyDiff]);
    const action = useMemo(() => activityAction(tool.kind, status, hasModifyDiff), [tool.kind, status, hasModifyDiff]);

    return (
        <div
            className={cn(
                "group/tool my-2 overflow-hidden rounded-xl border bg-fg-overlay-1/25 shadow-[0_10px_28px_rgba(0,0,0,0.18)] transition-colors",
                status === "error" ? "border-rose-500/35 bg-rose-500/5" : "border-fg-overlay-2 hover:border-fg-overlay-3"
            )}
            data-tool-activity="true"
            data-tool-callid={call.id}
            data-tool-status={status}
            data-tool-kind={tool.kind}
            data-tool-title={title}
            data-tool-name={call.name}
            data-tool-action={action}
        >
            <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className={cn(
                    "flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-fg-overlay-1/60",
                    expanded && "rounded-b-none"
                )}
            >
                <span
                    className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-fg-overlay-2 bg-background/45",
                        status === "running" && "border-[var(--color-term-accent-25)] bg-[var(--color-term-accent-10)]",
                        status === "done" && "bg-fg-overlay-1/60",
                        status === "error" && "border-rose-500/25 bg-rose-500/10"
                    )}
                >
                    <UIcon name={tool.icon} size={15} className={cn("shrink-0", status === "running" ? "text-[var(--color-term-accent)]" : "text-secondary/85")} />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-[13px] font-semibold text-foreground/95">
                            {title}
                        </span>
                        {hasModifyDiff && <DiffStats added={modifyDiffStats.added} removed={modifyDiffStats.removed} />}
                        {!hasModifyDiff && (
                            <span className="shrink-0 text-[11px] text-secondary/55">{metadata}</span>
                        )}
                    </div>
                    {!hasModifyDiff && (
                        <div className="mt-1 truncate font-mono text-[12px] text-secondary/70">{inputSummary}</div>
                    )}
                    {status === "error" && resultPreview && (
                        <div className="mt-1 truncate text-[11px] text-rose-300">{resultPreview}</div>
                    )}
                </div>
                <span
                    className={cn(
                        "hidden shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] sm:inline-flex",
                        badgeClass
                    )}
                >
                    <UIcon name={icon} size={11} className={cn("shrink-0", accent)} />
                    {label}
                </span>
                <span className="hidden shrink-0 text-[11px] text-secondary/55 transition-colors group-hover/tool:text-foreground/75 sm:inline">
                    {action}
                </span>
                <UIcon
                    name={expanded ? "chevron-down" : "chevron-right"}
                    size={12}
                    className="shrink-0 text-secondary/55"
                />
            </button>
            {expanded && (
                <div
                    className={cn(
                        "border-t border-fg-overlay-2/70 bg-background/80 text-[11px] font-mono",
                        hasModifyDiff ? "p-0" : "px-4 py-3"
                    )}
                >
                    {tool.kind === "modify" && <ModifyResultDetails call={call} result={result} />}
                    {renderInputDetails(call, tool.kind, !hasModifyDiff)}
                    {result && (
                        <div className={cn(hasModifyDiff && "px-4 py-3")}>
                            <div className="mb-1 text-[10px] uppercase tracking-wide text-secondary/60">
                                {status === "error" ? "error" : "result"}
                            </div>
                            <DetailPre tone={status === "error" ? "error" : undefined}>
                                {resultText || "(empty)"}
                            </DetailPre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
});
ToolCallCard.displayName = "ToolCallCard";
