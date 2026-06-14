// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { UIcon } from "@/app/element/ui-icon";
import { getApi } from "@/app/store/global";
import { cn } from "@/util/util";
import type { MouseEvent, ReactNode } from "react";
import { memo, useEffect, useMemo, useState } from "react";

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
type ToolKind = "command" | "modify" | "read" | "search" | "find" | "list" | "fetch" | "generic";

const SUMMARY_MAX_LEN = 180;

function deriveStatus(result: PiToolResultContent | undefined): Status {
    if (!result) return "running";
    return result.isError ? "error" : "done";
}

function describeStatus(status: Status): { icon: string; accent: string } {
    switch (status) {
        case "error":
            return {
                icon: "x-circle",
                accent: "text-rose-400",
            };
        case "running":
            return {
                icon: "clock-loader",
                accent: "text-[var(--ansi-yellow)]",
            };
        case "done":
            return {
                icon: "check-circle-broken",
                accent: "text-[var(--ansi-green)]",
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
    if (matchesToolName(name, [/^find$/, /^glob$/, /(^|[._:-])file[_-]?glob$/, /(^|[._:-])list[_-]?files$/])) {
        return {
            title: "Find files",
            summary: objectString(call.input, ["query", "pattern", "glob"]) || inputSummary(call.input),
            icon: "file",
            kind: "find",
        };
    }
    if (matchesToolName(name, [/^grep$/, /(^|[._:-])search$/, /(^|[._:-])search[_-]?codebase$/])) {
        return {
            title: "Search code",
            summary: objectString(call.input, ["query", "pattern"]) || inputSummary(call.input),
            icon: "search",
            kind: "search",
        };
    }

    if (matchesToolName(name, [/^ls$/])) {
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

function FileChip({ path }: { path: string }) {
    if (!path) return null;
    return (
        <span
            className="min-w-0 truncate rounded border border-fg-overlay-2 bg-fg-overlay-1/50 px-2 py-1 font-mono text-[11px] text-secondary/90"
            data-tool-file-chip={path}
            title={path}
        >
            {fileNameFromPath(path)}
        </span>
    );
}

function DetailSection({
    label,
    name,
    path,
    children,
}: {
    label: string;
    name: string;
    path?: string;
    children: ReactNode;
}) {
    return (
        <section
            className="rounded border border-fg-overlay-2 bg-background"
            data-tool-detail-section={name}
        >
            <div className="flex min-w-0 items-center justify-between gap-3 border-b border-fg-overlay-2 px-4 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-secondary/60">{label}</div>
                {path && <FileChip path={path} />}
            </div>
            <div className="p-4">{children}</div>
        </section>
    );
}

function DetailPre({ children, tone }: { children: ReactNode; tone?: "error" }) {
    return (
        <pre
            className={cn(
                "max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-fg-overlay-1/30 p-3 text-foreground/90",
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

function formatCommandText(text: string): string {
    const newlinePos = text.indexOf("\n");
    if (newlinePos === -1) return text;
    const firstLine = text.slice(0, newlinePos);
    if (!text.slice(newlinePos).trim()) return firstLine;
    return `${firstLine}…`;
}

function currentDirectoryLabel(path: string): string {
    if (!path || path === ".") return "the current directory";
    return path;
}

function grepTitle(input: unknown): string {
    const query = objectString(input, ["pattern", "query", "q"]);
    const path = currentDirectoryLabel(objectString(input, ["path", "cwd", "workdir"]));
    if (!query) return `Grepping in ${path}`;
    return `Grepping for ${query} in ${path}`;
}

function findTitle(input: unknown): string {
    const pattern = objectString(input, ["pattern", "query", "glob"]);
    const path = currentDirectoryLabel(objectString(input, ["path", "search_dir", "cwd", "workdir"]));
    if (!pattern) return `Finding files in ${path}`;
    return `Finding files that match ${pattern} in ${path}`;
}

function displayTitle(call: PiToolCall, tool: { title: string; summary: string; kind: ToolKind }): string {
    const path = objectString(call.input, ["path", "file", "filepath"]);
    const actionTitle = objectString(call.input, ["title", "summary", "description"]);
    if (tool.kind === "command") {
        return formatCommandText(objectString(call.input, ["command", "cmd"]) || tool.summary);
    }
    if (tool.kind === "modify") {
        if (actionTitle) return actionTitle;
        return path ? fileNameFromPath(path) : tool.title;
    }
    if (tool.kind === "search") {
        return grepTitle(call.input);
    }
    if (tool.kind === "find") {
        return findTitle(call.input);
    }
    if (tool.kind === "read" || tool.kind === "list") {
        return path || tool.summary;
    }
    if (tool.kind === "fetch") {
        return objectString(call.input, ["url", "uri"]) || tool.summary;
    }
    return tool.title;
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

function WarpDiffFileBar({ path, openPath }: { path: string; openPath: string }) {
    if (!path) return null;
    return (
        <div
            className="flex min-w-0 items-center bg-[#071518] px-11 py-4 font-mono text-[14px] text-[#d9dddd]/65"
            data-warp-diff-file-bar="true"
            data-tool-diff-tabs="true"
        >
            <span className="min-w-0 truncate" title={path}>
                {path}
            </span>
            <button
                type="button"
                title="Copy path"
                aria-label="Copy path"
                className="sr-only"
                onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard.writeText(path);
                }}
            >
                Copy path
            </button>
            {openPath && (
                <button
                    type="button"
                    title="Open file"
                    aria-label="Open file"
                    className="sr-only"
                    onClick={(e) => {
                        e.stopPropagation();
                        getApi().openNativePath(openPath);
                    }}
                >
                    Open file
                </button>
            )}
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
            className="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-0 text-[10px] font-medium"
            data-diff-stat-added={added}
            data-diff-stat-removed={removed}
        >
            {added > 0 && <span className="text-emerald-400">+{added}</span>}
            {removed > 0 && <span className="text-rose-400">-{removed}</span>}
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

function parseHunkHeader(line: string): { oldLine: number; newLine: number } | null {
    const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (!match) return null;
    return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

function parseDiffLine(line: string, oldLine: number, newLine: number): DiffRow {
    const type = diffLineType(line);
    if (type === "hunk") {
        return { type, oldLine: "", newLine: "", marker: "", content: "..." };
    }

    const marker = line.startsWith("+") || line.startsWith("-") ? line[0] : "";
    const body = marker ? line.slice(1) : line.startsWith(" ") ? line.slice(1) : line;
    const lineMatch = body.match(/^\s*(\d+)\s(.*)$/);
    const explicitLineNumber = lineMatch ? lineMatch[1] : "";
    const content = lineMatch ? lineMatch[2] : body.replace(/^ /, "");
    return {
        type,
        oldLine: type === "add" ? "" : explicitLineNumber || (oldLine > 0 ? String(oldLine) : ""),
        newLine: type === "remove" ? "" : explicitLineNumber || (newLine > 0 ? String(newLine) : ""),
        marker,
        content,
    };
}

function parseDiffRows(diff: string): { rows: DiffRow[]; hunkCount: number } {
    const rows: DiffRow[] = [];
    let oldLine = 0;
    let newLine = 0;
    let hunkCount = 0;

    for (const line of diff.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("@@")) {
            const hunk = parseHunkHeader(line);
            if (hunk) {
                oldLine = hunk.oldLine;
                newLine = hunk.newLine;
            }
            hunkCount += 1;
            continue;
        }

        const row = parseDiffLine(line, oldLine, newLine);
        rows.push(row);
        if (row.type === "add") {
            newLine += 1;
        } else if (row.type === "remove") {
            oldLine += 1;
        } else {
            oldLine += 1;
            newLine += 1;
        }
    }

    return { rows, hunkCount };
}

function CodeDiff({ diff, path }: { diff: string; path: string }) {
    const { rows, hunkCount } = parseDiffRows(diff);
    const hasAddedRows = rows.some((row) => row.type === "add");
    return (
        <div
            className="overflow-hidden bg-[#071518]"
            data-tool-diff="true"
            data-tool-diff-file={path}
        >
            <div className="relative max-h-[520px] min-h-[230px] overflow-auto text-[14px] leading-[22px]" data-tool-diff-editor="true">
                {hasAddedRows && (
                    <div className="absolute bottom-0 left-0 top-0 w-2 bg-[#a4ff67]" data-warp-added-gutter="true" />
                )}
                {rows.map((row, idx) => {
                    return (
                        <div
                            key={idx}
                            data-diff-line-type={row.type}
                            data-diff-old-line={row.oldLine}
                            data-diff-new-line={row.newLine}
                            className={cn(
                                "grid grid-cols-[32px_52px_minmax(0,1fr)] pl-4 pr-6 font-mono",
                                row.type === "add" && "bg-[#315f43] text-[#e3ece6]",
                                row.type === "remove" && "bg-[#612f35] text-[#f0d3d7]",
                                row.type === "hunk" && "bg-fg-overlay-1/30 text-secondary/50",
                                row.type === "context" && "text-[#d9dddd]"
                            )}
                        >
                            <span className="select-none text-right text-[#d9dddd]/70">{row.oldLine || row.newLine}</span>
                            <span className="select-none text-center text-[#d9dddd]/45">{row.marker}</span>
                            <span className="min-w-max whitespace-pre pl-2">{row.content || " "}</span>
                        </div>
                    );
                })}
            </div>
            {hunkCount > 0 && (
                <div
                    className="flex items-center justify-end gap-5 bg-gradient-to-t from-[#050b0d] to-[#071518] px-8 py-5 text-[13px] text-[#d9dddd]/75"
                    data-warp-hunk-nav="true"
                >
                    <span>Hunk:</span>
                    <span className="font-semibold text-[#f3f5f5]">1/{hunkCount}</span>
                    <span className="flex items-center gap-2 font-semibold text-[#f3f5f5]">
                        <UIcon name="arrow-up" size={13} /> Previous
                    </span>
                    <span className="flex items-center gap-2 font-semibold text-[#f3f5f5]">
                        <UIcon name="arrow-down" size={13} /> Next
                    </span>
                </div>
            )}
        </div>
    );
}

function renderInputDetails(call: PiToolCall, kind: ToolKind, showStructuredFallback = true) {
    const input = call.input;
    const path = objectString(input, ["path", "file", "filepath"]);
    if (kind === "command") {
        return (
            <DetailSection label="Command" name="command">
                <DetailPre>{objectString(input, ["command", "cmd"]) || stringify(input)}</DetailPre>
                <DetailRow label="cwd" value={objectString(input, ["workdir", "cwd"])} />
            </DetailSection>
        );
    }
    if (kind === "modify") {
        const content = objectString(input, ["content", "newContent", "replacement", "patch", "diff"]);
        if (!content && showStructuredFallback) {
            return (
                <DetailSection label="Input" name="input" path={path}>
                    <DetailPre>{stringify(input, true)}</DetailPre>
                </DetailSection>
            );
        }
        return (
            <>
                {content ? (
                    <DetailSection label="Content" name="content" path={path}>
                        <DetailPre>{content}</DetailPre>
                    </DetailSection>
                ) : null}
            </>
        );
    }
    if (kind === "search") {
        return (
            <DetailSection label="Search" name="input">
                <DetailRow label="query" value={objectString(input, ["query", "pattern", "q"])} />
                <DetailRow label="path" value={path} />
                <DetailRow label="glob" value={objectString(input, ["glob"])} />
            </DetailSection>
        );
    }
    if (kind === "read" || kind === "list") {
        return (
            <DetailSection label="Input" name="input" path={path || inputSummary(input)}>
                <DetailRow label="path" value={path || inputSummary(input)} />
            </DetailSection>
        );
    }
    if (kind === "fetch") {
        return (
            <DetailSection label="Input" name="input">
                <DetailRow label="url" value={objectString(input, ["url"]) || inputSummary(input)} />
            </DetailSection>
        );
    }

    const rows = Object.entries((input && typeof input === "object" ? input : {}) as Record<string, unknown>)
        .filter(([, value]) => value == null || ["string", "number", "boolean"].includes(typeof value))
        .slice(0, 8);
    if (rows.length === 0) {
        return (
            <DetailSection label="Input" name="input">
                <DetailPre>{inputSummary(input)}</DetailPre>
            </DetailSection>
        );
    }
    return (
        <DetailSection label="Input" name="input">
            {rows.map(([key, value]) => (
                <DetailRow key={key} label={key} value={String(value ?? "")} />
            ))}
        </DetailSection>
    );
}

function modificationDiff(result: PiToolResultContent | undefined): string {
    if (!result) return "";
    return detailsString(result.details, ["diff", "patch"]);
}

export const ToolCallCard = memo(({ call, result, defaultExpanded = false }: ToolCallCardProps) => {
    const status = deriveStatus(result);
    const { icon, accent } = describeStatus(status);
    const [expanded, setExpanded] = useState(defaultExpanded || status === "error");
    const tool = useMemo(() => describeTool(call), [call]);
    const title = useMemo(() => displayTitle(call, tool), [call, tool]);
    const resultText = useMemo(() => renderResultText(result), [result]);
    const resultPreview = useMemo(() => compactText(resultText), [resultText]);
    const modifyDiff = useMemo(() => modificationDiff(result), [result]);
    const modifyDiffStats = useMemo(() => diffStats(modifyDiff), [modifyDiff]);
    const hasModifyDiff = tool.kind === "modify" && Boolean(modifyDiff);
    const modifyPath = objectString(call.input, ["path", "file", "filepath"]);
    const headerTitle = tool.kind === "modify" ? title : tool.title;

    useEffect(() => {
        if (status !== "error") return;
        setExpanded(true);
    }, [status]);

    return (
        <div
            className={cn(
                "group/tool my-3 overflow-hidden rounded-[10px] border shadow-[0_18px_48px_rgba(0,0,0,0.24)] transition-colors",
                status === "error" ? "border-rose-500/35" : "border-[#25434a]"
            )}
            data-warp-tool-card="true"
            data-tool-activity="true"
            data-tool-callid={call.id}
            data-tool-status={status}
            data-tool-kind={tool.kind}
            data-tool-title={title}
            data-tool-name={call.name}
            data-tool-action=""
        >
            <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className={cn(
                    "flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left transition-colors",
                    "bg-[#21353a] hover:bg-[#284047]",
                    expanded && "rounded-b-none border-b border-[#25434a]"
                )}
            >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    <UIcon name={icon} size={15} className={cn("shrink-0", accent)} />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-[15px] font-medium text-[#f0f3f3]">
                            {headerTitle}
                        </span>
                        {tool.kind !== "modify" && (
                            <span
                                className={cn(
                                    "min-w-0 truncate text-[11px] text-secondary/70",
                                    tool.kind === "command" && "font-mono"
                                )}
                            >
                                {title !== tool.title ? title : ""}
                            </span>
                        )}
                        {hasModifyDiff && (
                            <DiffStats added={modifyDiffStats.added} removed={modifyDiffStats.removed} />
                        )}
                    </div>
                    {status === "error" && resultPreview && (
                        <div className="mt-0.5 truncate text-[11px] text-rose-300/90">{resultPreview}</div>
                    )}
                </div>
                {hasModifyDiff && (
                    <IconActionButton
                        title="Expand diff"
                        icon="plus"
                        onClick={(e) => {
                            e.stopPropagation();
                            setExpanded((v) => !v);
                        }}
                    />
                )}
                <UIcon
                    name={expanded ? "chevron-down" : "chevron-right"}
                    size={14}
                    className="shrink-0 text-[#f0f3f3]/85"
                />
            </button>
            {expanded && hasModifyDiff && (
                <div data-tool-detail-body="true">
                    <WarpDiffFileBar path={modifyPath} openPath={openablePath(call.input, modifyPath)} />
                    <CodeDiff diff={modifyDiff} path={modifyPath} />
                    {resultText && <div className="sr-only">{resultText}</div>}
                </div>
            )}
            {expanded && !hasModifyDiff && tool.kind === "modify" && (
                <div
                    className="space-y-3 bg-background p-4 text-[11px] font-mono"
                    data-tool-detail-body="true"
                >
                    {result && result.isError && (
                        <DetailSection label="Error" name="result">
                            <DetailPre tone="error">{resultText || "(empty)"}</DetailPre>
                        </DetailSection>
                    )}
                    {(!result || !result.isError) && (
                        <>
                            {renderInputDetails(call, tool.kind, true)}
                            {result && (
                                <DetailSection label="Result" name="result">
                                    <DetailPre>{resultText || "(empty)"}</DetailPre>
                                </DetailSection>
                            )}
                        </>
                    )}
                </div>
            )}
            {expanded && !hasModifyDiff && tool.kind !== "modify" && (
                <div
                    className="space-y-3 bg-background p-4 text-[11px] font-mono"
                    data-tool-detail-body="true"
                >
                    {renderInputDetails(call, tool.kind, true)}
                    {result && (
                        <DetailSection label={status === "error" ? "Error" : "Result"} name="result">
                            <DetailPre tone={status === "error" ? "error" : undefined}>
                                {resultText || "(empty)"}
                            </DetailPre>
                        </DetailSection>
                    )}
                </div>
            )}
        </div>
    );
});
ToolCallCard.displayName = "ToolCallCard";
