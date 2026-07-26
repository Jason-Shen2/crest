// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentExtUiPanel — renders the extension ctx.ui surface inline above the
// composer: read-only status lines + widget blocks (setStatus / setWidget)
// and the single active interactive prompt (confirm / select / input).
//
// The prompt is answered via respondExtUi(requestId, result); dismissing the
// panel (Esc / outside click) cancels the prompt with the "declined" value
// (confirm → false, select/input → undefined) so the extension's awaiting
// Promise always settles.

import type { PiExtUiRequest, PiExtUiState } from "@/app/store/use-pi-chat";
import { Markdown } from "@/app/element/markdown";
import { COMMAND_INLINE_FRAME_CLASSNAME, CommandInlineFrame } from "@/app/view/cmdblock/command-inline-frame";
import { cn } from "@/util/util";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type {
    RenderedExtensionEntryNode,
    WidgetEventDispatchResult,
    WidgetNode,
} from "../../../../emain/agent/extensions/pi-gui/crest/widget-tree";
import { normalizeMarkdownPartialClosingFence } from "../../../../emain/agent/extensions/pi-gui/crest/markdown-normalize";

export type AgentWidgetEventHandler = (
    event: AgentWidgetEvent
) => Promise<WidgetEventDispatchResult> | void;

export function forwardAgentWidgetEvent(
    api: { respondWidgetEvent: AgentWidgetEventHandler } | null,
    event: AgentWidgetEvent
): ReturnType<AgentWidgetEventHandler> {
    return api?.respondWidgetEvent(event);
}

export interface AgentExtUiPanelProps {
    extUi: PiExtUiState;
    respondExtUi: (requestId: string, result: unknown) => void;
    respondWidgetEvent?: AgentWidgetEventHandler;
    /** Composer anchor so outside-click dismissal ignores clicks on the input. */
    anchorRef?: RefObject<HTMLElement | null>;
}

const WidgetPaddingUnitPx = 8;
const WidgetPaddingMaxUnits = 64;
const WidgetEventFallbackPrefix =
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let widgetEventFallbackCounter = 0;

export function createWidgetEventIdGenerator(options: {
    randomUUID?: () => string;
} = {}): () => string {
    const hasInjectedUuid = Object.prototype.hasOwnProperty.call(options, "randomUUID");
    const randomUUID = hasInjectedUuid
        ? options.randomUUID
        : globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    return () => randomUUID?.() ??
        `${WidgetEventFallbackPrefix}-${++widgetEventFallbackCounter}`;
}

const makeWidgetEventId = createWidgetEventIdGenerator();

function clampWidgetPadding(value = 0): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(WidgetPaddingMaxUnits, Math.max(0, value));
}

function widgetPaddingStyle(paddingx = 0, paddingy = 0): CSSProperties {
    return {
        paddingInline: `${clampWidgetPadding(paddingx) * WidgetPaddingUnitPx}px`,
        paddingBlock: `${clampWidgetPadding(paddingy) * WidgetPaddingUnitPx}px`,
    };
}

export function widgetSelectEvent(nodeid: string, index: number): AgentWidgetEvent {
    return { nodeid, type: "select", payload: { index } };
}

export function widgetInputChangeEvent(
    nodeid: string,
    value: string,
    selectionstart: number,
    selectionend: number,
    eventid?: string
): AgentWidgetEvent {
    return {
        nodeid,
        type: "change",
        ...(eventid == null ? {} : { eventid }),
        payload: { value, selectionstart, selectionend },
    };
}

export function widgetInputSubmitEvent(
    nodeid: string,
    value: string,
    selectionstart: number,
    selectionend: number,
    eventid?: string
): AgentWidgetEvent {
    return {
        nodeid,
        type: "submit",
        ...(eventid == null ? {} : { eventid }),
        payload: { value, selectionstart, selectionend },
    };
}

export function widgetInputCancelEvent(nodeid: string, eventid?: string): AgentWidgetEvent {
    return { nodeid, type: "cancel", ...(eventid == null ? {} : { eventid }) };
}

export function widgetCancelEvent(nodeid: string): AgentWidgetEvent {
    return { nodeid, type: "cancel" };
}

export function widgetKeyEvent(nodeid: string, data: string): AgentWidgetEvent {
    return { nodeid, type: "key", payload: { data } };
}

export function keyDataForWidgetTerminal(key: string): string {
    switch (key) {
        case "Enter":
            return "\n";
        case "Escape":
            return "\x1b";
        case "ArrowUp":
            return "\x1b[A";
        case "ArrowDown":
            return "\x1b[B";
        case "ArrowRight":
            return "\x1b[C";
        case "ArrowLeft":
            return "\x1b[D";
        case "Backspace":
            return "\x7f";
        case "Tab":
            return "\t";
        default:
            return key.length === 1 ? key : "";
    }
}

export function editorKeyboardEventMatchesBinding(
    event: Pick<
        React.KeyboardEvent<HTMLTextAreaElement>,
        "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
    >,
    bindings: string[]
): boolean {
    const eventKey = event.key.toLowerCase();
    if (eventKey !== "enter" && eventKey !== "return") return false;

    return bindings.some((binding) => {
        const parts = binding.toLowerCase().split("+");
        const key = parts.pop();
        if (key !== "enter" && key !== "return") return false;
        const modifiers = new Set(parts);
        if ([...modifiers].some((modifier) => !["alt", "ctrl", "shift", "super"].includes(modifier))) {
            return false;
        }
        return (
            modifiers.has("alt") === event.altKey &&
            modifiers.has("ctrl") === event.ctrlKey &&
            modifiers.has("shift") === event.shiftKey &&
            modifiers.has("super") === event.metaKey
        );
    });
}

export function notifyCustomWidgetCancel(
    request: PiExtUiRequest,
    respondWidgetEvent?: AgentWidgetEventHandler
): void {
    if (request.kind !== "custom") return;
    respondWidgetEvent?.(widgetCancelEvent(request.widget.id));
}

/** True when there's anything to render (a status, a widget, or a prompt). */
export function hasAgentExtUiContent(extUi: PiExtUiState): boolean {
    return (
        extUi.request != null ||
        extUi.header != null ||
        extUi.footer != null ||
        Object.keys(extUi.statuses).length > 0 ||
        Object.keys(extUi.widgets).length > 0 ||
        Object.keys(extUi.widgetnodes).length > 0 ||
        extUi.renderedEntries.length > 0
    );
}

/** The value sent back when the user cancels/dismisses a prompt. */
export function extUiDeclinedResult(kind: PiExtUiRequest["kind"]): unknown {
    return kind === "confirm" ? false : undefined;
}

const AgentExtUiStatusWidgets = memo(
    ({
        statuses,
        widgets,
        widgetnodes,
        renderedEntries,
        header,
        footer,
        respondWidgetEvent,
    }: {
        statuses: Record<string, string>;
        widgets: Record<string, string[]>;
        widgetnodes: Record<string, WidgetNode>;
        renderedEntries: RenderedExtensionEntryNode[];
        header?: WidgetNode;
        footer?: WidgetNode;
        respondWidgetEvent?: AgentWidgetEventHandler;
    }) => {
        const statusEntries = Object.entries(statuses);
        const widgetEntries = Object.entries(widgets);
        const widgetNodeEntries = Object.entries(widgetnodes);
        if (
            statusEntries.length === 0 &&
            widgetEntries.length === 0 &&
            widgetNodeEntries.length === 0 &&
            renderedEntries.length === 0 &&
            !header &&
            !footer
        ) {
            return null;
        }
        return (
            <div className={`${COMMAND_INLINE_FRAME_CLASSNAME} shrink-0`}>
                <div className="space-y-2 px-4 py-3 font-mono text-[12px] leading-relaxed">
                    {header && <WidgetTreeRenderer node={header} onEvent={respondWidgetEvent} />}
                    {statusEntries.map(([key, text]) => (
                        <div key={`status-${key}`} className="flex items-center gap-2 text-foreground/90">
                            <span className="size-1.5 shrink-0 rounded-full bg-accent/80" aria-hidden="true" />
                            <span className="truncate" title={text}>
                                {text}
                            </span>
                        </div>
                    ))}
                    {widgetEntries.map(([key, lines]) => (
                        <div
                            key={`widget-${key}`}
                            className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-foreground/85"
                        >
                            {lines.map((line, index) => (
                                <div key={index} className="whitespace-pre-wrap break-words">
                                    {line || "\u00a0"}
                                </div>
                            ))}
                        </div>
                    ))}
                    {widgetNodeEntries.map(([key, node]) => (
                        <div
                            key={`widget-node-${key}`}
                            className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-foreground/85"
                        >
                            <WidgetTreeRenderer node={node} onEvent={respondWidgetEvent} />
                        </div>
                    ))}
                    {renderedEntries.map((entry) => (
                        <div
                            key={`rendered-entry-${entry.id}`}
                            className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-foreground/85"
                        >
                            <WidgetTreeRenderer node={entry.widget} onEvent={respondWidgetEvent} />
                        </div>
                    ))}
                    {footer && <WidgetTreeRenderer node={footer} onEvent={respondWidgetEvent} />}
                </div>
            </div>
        );
    }
);
AgentExtUiStatusWidgets.displayName = "AgentExtUiStatusWidgets";

function ExtUiConfirmPrompt({
    request,
    onRespond,
}: {
    request: Extract<PiExtUiRequest, { kind: "confirm" }>;
    onRespond: (result: unknown) => void;
}) {
    return (
        <div className="px-4 py-4 font-sans text-[13px] leading-relaxed">
            {request.message && <div className="mb-3 text-foreground/85">{request.message}</div>}
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={() => onRespond(false)}
                    className="cursor-pointer rounded-lg border border-white/[0.1] px-3 py-1.5 text-secondary/85 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={() => onRespond(true)}
                    className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 font-medium text-black transition-opacity hover:opacity-90"
                >
                    Confirm
                </button>
            </div>
        </div>
    );
}

function ExtUiSelectPrompt({
    request,
    onRespond,
}: {
    request: Extract<PiExtUiRequest, { kind: "select" }>;
    onRespond: (result: unknown) => void;
}) {
    return (
        <div className="flex flex-col gap-px p-1">
            {request.options.map((option, index) => (
                <button
                    key={`${index}-${option}`}
                    type="button"
                    onClick={() => onRespond(option)}
                    className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] text-foreground/85 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                    <span className="grid size-[22px] shrink-0 place-items-center rounded-lg border border-white/[0.085] bg-white/[0.045] font-mono text-[10px] text-secondary/55">
                        {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="truncate" title={option}>
                        {option}
                    </span>
                </button>
            ))}
        </div>
    );
}

function ExtUiInputPrompt({
    request,
    onRespond,
}: {
    request: Extract<PiExtUiRequest, { kind: "input" }>;
    onRespond: (result: unknown) => void;
}) {
    const [value, setValue] = useState(request.initial ?? "");
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);
    return (
        <form
            className="flex flex-col gap-3 px-4 py-4"
            onSubmit={(e) => {
                e.preventDefault();
                onRespond(value);
            }}
        >
            <input
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-lg border border-white/[0.12] bg-black/25 px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent/70"
            />
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={() => onRespond(undefined)}
                    className="cursor-pointer rounded-lg border border-white/[0.1] px-3 py-1.5 text-secondary/85 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 font-medium text-black transition-opacity hover:opacity-90"
                >
                    Submit
                </button>
            </div>
        </form>
    );
}

function ExtUiEditorPrompt({
    request,
    onRespond,
}: {
    request: Extract<PiExtUiRequest, { kind: "editor" }>;
    onRespond: (result: unknown) => void;
}) {
    const [value, setValue] = useState(request.prefill ?? "");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        textareaRef.current?.focus();
        textareaRef.current?.select();
    }, []);
    return (
        <form
            className="flex flex-col gap-3 px-4 py-4"
            onSubmit={(e) => {
                e.preventDefault();
                onRespond(value);
            }}
        >
            <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                rows={8}
                className="max-h-[320px] min-h-[160px] w-full resize-y rounded-lg border border-white/[0.12] bg-black/25 px-3 py-2 font-mono text-[13px] leading-relaxed text-foreground outline-none focus:border-accent/70"
            />
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={() => onRespond(undefined)}
                    className="cursor-pointer rounded-lg border border-white/[0.1] px-3 py-1.5 text-secondary/85 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 font-medium text-black transition-opacity hover:opacity-90"
                >
                    Save
                </button>
            </div>
        </form>
    );
}

function WidgetTreeRenderer({ node, onEvent }: { node: WidgetNode; onEvent?: AgentWidgetEventHandler }) {
    if (node.kind === "text") {
        return (
            <div
                data-agent-widget-kind="text"
                className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90"
                style={widgetPaddingStyle(node.paddingx, node.paddingy)}
            >
                {node.text}
            </div>
        );
    }
    if (node.kind === "box" || node.kind === "container") {
        return (
            <div
                data-agent-widget-kind={node.kind}
                className="flex flex-col rounded-xl border border-white/[0.08] bg-white/[0.03]"
                style={widgetPaddingStyle(node.paddingx, node.paddingy)}
            >
                {node.children.map((child) => (
                    <WidgetTreeRenderer key={child.id} node={child} onEvent={onEvent} />
                ))}
            </div>
        );
    }
    if (node.kind === "spacer") {
        return <div style={{ height: `${Math.max(1, node.lines) * 8}px` }} aria-hidden="true" />;
    }
    if (node.kind === "selectlist") {
        return <WidgetSelectListRenderer key={node.id} node={node} onEvent={onEvent} />;
    }
    if (node.kind === "settingslist") {
        return (
            <WidgetSettingsListRenderer key={node.id} node={node} onEvent={onEvent} />
        );
    }
    if (node.kind === "input") {
        return <WidgetInputRenderer key={node.id} node={node} onEvent={onEvent} />;
    }
    if (node.kind === "markdown") {
        return <WidgetMarkdownRenderer source={node.source} paddingx={node.paddingx} paddingy={node.paddingy} />;
    }
    if (node.kind === "editor") {
        return <WidgetEditorRenderer key={node.id} node={node} onEvent={onEvent} />;
    }
    if (node.kind === "image") {
        return (
            <figure className="space-y-2 p-2">
                <img
                    src={node.src}
                    alt={node.filename ?? node.mimetype}
                    className="max-h-[240px] max-w-full rounded-lg border border-white/[0.08] object-contain"
                />
                <figcaption className="font-mono text-[12px] text-secondary/75">
                    {node.filename ?? node.mimetype}
                    {node.widthpx && node.heightpx ? ` (${node.widthpx}x${node.heightpx})` : ""}
                </figcaption>
            </figure>
        );
    }
    if (node.kind === "loader") {
        return (
            <div
                data-agent-widget-id={node.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-[13px] text-foreground/90"
            >
                <div className="flex min-w-0 items-center gap-2">
                    {node.frame && <span className="font-mono text-accent">{node.frame}</span>}
                    <span className="truncate">{node.label}</span>
                    {node.aborted ? <span className="font-mono text-[11px] text-secondary/75">Cancelled</span> : null}
                </div>
                {node.cancellable && (
                    <button
                        type="button"
                        onClick={() => onEvent?.(widgetCancelEvent(node.id))}
                        className="cursor-pointer rounded-lg border border-white/[0.1] px-3 py-1.5 text-[12px] text-secondary/85 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                    >
                        Cancel
                    </button>
                )}
            </div>
        );
    }
    if (node.kind === "truncatedtext") {
        return <div className="truncate px-3 py-2 text-[13px] text-foreground/90">{node.text}</div>;
    }
    if (node.kind === "terminal") {
        return (
            <pre
                tabIndex={0}
                onKeyDown={(event) => {
                    event.preventDefault();
                    onEvent?.(widgetKeyEvent(node.id, keyDataForWidgetTerminal(event.key)));
                }}
                className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-black/30 p-3 font-mono text-[12px] leading-relaxed text-foreground/85 outline-none focus:ring-1 focus:ring-accent/60"
            >
                {node.lines.join("\n")}
            </pre>
        );
    }
    if (node.kind === "richtable") {
        return (
            <div className="overflow-x-auto p-2">
                <table className="w-full border-collapse text-left text-[13px]">
                    <thead className="text-secondary/75">
                        <tr>
                            {node.columns.map((column) => (
                                <th key={column.key} className="border-b border-white/[0.08] px-2 py-1 font-medium">
                                    {column.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {node.rows.map((row, rowIndex) => (
                            <tr key={rowIndex} className="text-foreground/85">
                                {node.columns.map((column) => (
                                    <td key={column.key} className="border-b border-white/[0.05] px-2 py-1">
                                        {String(row[column.key] ?? "")}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    }
    if (node.kind === "diffview") {
        return (
            <pre className="overflow-x-auto rounded-xl bg-black/25 p-3 font-mono text-[12px] leading-relaxed">
                {node.filename && <div className="text-secondary/75">{node.filename}</div>}
                {node.hunks.map((hunk, hunkIndex) => (
                    <div key={hunkIndex}>
                        <div className="text-accent/85">{hunk.header}</div>
                        {hunk.lines.map((line, lineIndex) => (
                            <div
                                key={lineIndex}
                                className={
                                    line.type === "add"
                                        ? "text-emerald-300/85"
                                        : line.type === "remove"
                                          ? "text-red-300/85"
                                          : "text-foreground/75"
                                }
                            >
                                {line.text}
                            </div>
                        ))}
                    </div>
                ))}
            </pre>
        );
    }
    if (node.kind === "chart") {
        return (
            <div className="space-y-2 p-3 text-[13px]">
                {node.series.map((series) => (
                    <div key={series.name}>
                        <div className="mb-1 font-medium text-foreground/90">{series.name}</div>
                        {series.points.map((point) => (
                            <div key={point.label} className="grid grid-cols-[80px_1fr_auto] items-center gap-2">
                                <span className="truncate text-secondary/75">{point.label}</span>
                                <span
                                    className="h-2 rounded-full bg-accent/70"
                                    style={{ width: `${Math.max(6, point.value * 12)}px` }}
                                />
                                <span className="font-mono text-[12px] text-foreground/80">{point.value}</span>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        );
    }
    return null;
}

function WidgetSelectListRenderer({
    node,
    onEvent,
}: {
    node: Extract<WidgetNode, { kind: "selectlist" }>;
    onEvent?: AgentWidgetEventHandler;
}) {
    const [filter, setFilter] = useState(node.filter ?? "");
    const composingRef = useRef(false);
    const focusedWithinRef = useRef(false);
    const dirtyRef = useRef(false);
    const localFilterRef = useRef(node.filter ?? "");
    const latestSnapshotFilterRef = useRef(node.filter ?? "");
    const lastDispatchedFilterRef = useRef(node.filter ?? "");
    const reconcileFilter = (value: string) => {
        dirtyRef.current = false;
        localFilterRef.current = value;
        lastDispatchedFilterRef.current = value;
        setFilter(value);
    };
    useEffect(() => {
        const nextFilter = node.filter ?? "";
        latestSnapshotFilterRef.current = nextFilter;
        if (composingRef.current) return;
        if (nextFilter === localFilterRef.current) {
            dirtyRef.current = false;
            lastDispatchedFilterRef.current = nextFilter;
            return;
        }
        if (dirtyRef.current) return;
        reconcileFilter(nextFilter);
    }, [node]);
    const dispatchFilter = (value: string) => {
        if (value === lastDispatchedFilterRef.current) return;
        lastDispatchedFilterRef.current = value;
        onEvent?.({ nodeid: node.id, type: "change", payload: { value } });
    };
    const dispatchSemanticKey = (event: React.KeyboardEvent<HTMLElement>) => {
        if (composingRef.current) return;
        const data =
            event.key === "ArrowUp"
                ? "\x1b[A"
                : event.key === "ArrowDown"
                  ? "\x1b[B"
                  : event.key === "Enter"
                    ? "\n"
                    : event.key === "Escape"
                      ? "\x1b"
                      : "";
        if (!data) return;
        event.preventDefault();
        onEvent?.(widgetKeyEvent(node.id, data));
    };
    const visibleItems = node.items.slice(node.visiblestart, node.visibleend);
    const activeOptionId = node.nomatch ? undefined : `${node.id}-option-${node.selectedindex}`;
    return (
        <div
            className="flex flex-col gap-2 p-1"
            onFocusCapture={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                focusedWithinRef.current = true;
                onEvent?.({ nodeid: node.id, type: "focus", payload: { focused: true } });
            }}
            onBlurCapture={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                focusedWithinRef.current = false;
                if (!composingRef.current) {
                    reconcileFilter(latestSnapshotFilterRef.current);
                }
                onEvent?.({ nodeid: node.id, type: "focus", payload: { focused: false } });
            }}
        >
            <input
                type="search"
                aria-label={`Filter ${node.id}`}
                value={filter}
                onChange={(event) => {
                    const value = event.target.value;
                    dirtyRef.current = true;
                    localFilterRef.current = value;
                    setFilter(value);
                    if (!composingRef.current) dispatchFilter(value);
                }}
                onCompositionStart={() => {
                    composingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                    composingRef.current = false;
                    dispatchFilter(event.currentTarget.value);
                }}
                onKeyDown={dispatchSemanticKey}
                className="w-full rounded-lg border border-white/[0.12] bg-black/25 px-3 py-2 font-mono text-[12px] text-foreground outline-none focus:border-accent/70"
            />
            <div
                role="listbox"
                tabIndex={node.focused ? 0 : -1}
                aria-activedescendant={activeOptionId}
                aria-label={`Select list ${node.id}`}
                onKeyDown={dispatchSemanticKey}
                className="flex flex-col gap-px outline-none focus:ring-1 focus:ring-accent/60"
            >
                {node.nomatch ? (
                    <div role="status" className="px-2.5 py-2 text-[12px] text-secondary/75">
                        No matching options
                    </div>
                ) : (
                    visibleItems.map((item, localIndex) => {
                        const index = node.visiblestart + localIndex;
                        return (
                            <div
                                key={`${item.value}-${index}`}
                                id={`${node.id}-option-${index}`}
                                role="option"
                                aria-selected={index === node.selectedindex}
                                onClick={() => onEvent?.(widgetSelectEvent(node.id, index))}
                                className={cn(
                                    "cursor-pointer rounded-xl px-2.5 py-2 text-left text-[13px]",
                                    index === node.selectedindex
                                        ? "bg-accent/15 text-foreground"
                                        : "text-foreground/80"
                                )}
                            >
                                <div className="font-medium">{item.label}</div>
                                {item.description && (
                                    <div className="text-[12px] text-secondary/75">{item.description}</div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={() => onEvent?.(widgetCancelEvent(node.id))}
                    className="cursor-pointer rounded-lg border border-white/[0.1] px-3 py-1.5 text-[12px] text-secondary/85 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}

function WidgetSettingsListRenderer({
    node,
    onEvent,
}: {
    node: Extract<WidgetNode, { kind: "settingslist" }>;
    onEvent?: AgentWidgetEventHandler;
}) {
    const [filter, setFilter] = useState(node.filter ?? "");
    const composingRef = useRef(false);
    const dirtyRef = useRef(false);
    const localFilterRef = useRef(node.filter ?? "");
    const latestSnapshotFilterRef = useRef(node.filter ?? "");
    const lastDispatchedFilterRef = useRef(node.filter ?? "");
    const parentRootRef = useRef<HTMLDivElement>(null);
    const submenuRootRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const listboxRef = useRef<HTMLDivElement>(null);
    const previousSubmenuIdRef = useRef<string | undefined>(undefined);
    const restoreEligibleRef = useRef(false);
    const focusWithinRef = useRef(false);
    const submenuId = node.submenu?.id;
    const reconcileFilter = (value: string) => {
        dirtyRef.current = false;
        localFilterRef.current = value;
        lastDispatchedFilterRef.current = value;
        setFilter(value);
    };
    useEffect(() => {
        const nextFilter = node.filter ?? "";
        latestSnapshotFilterRef.current = nextFilter;
        if (composingRef.current) return;
        if (nextFilter === localFilterRef.current) {
            dirtyRef.current = false;
            lastDispatchedFilterRef.current = nextFilter;
            return;
        }
        if (dirtyRef.current) return;
        reconcileFilter(nextFilter);
    }, [node]);
    useLayoutEffect(() => {
        const previousSubmenuId = previousSubmenuIdRef.current;
        const submenuAppearing = Boolean(submenuId && submenuId !== previousSubmenuId);
        const submenuClosing = Boolean(!submenuId && previousSubmenuId);
        previousSubmenuIdRef.current = submenuId;

        if (submenuAppearing) {
            composingRef.current = false;
            reconcileFilter(node.filter ?? "");
            const shouldHandoff =
                focusWithinRef.current && document.activeElement === document.body;
            restoreEligibleRef.current = shouldHandoff;
            if (!shouldHandoff) return;
            submenuRootRef.current
                ?.querySelector<HTMLElement>(
                    'input, textarea, button, [tabindex]:not([tabindex="-1"])'
                )
                ?.focus();
            return;
        }
        if (submenuClosing) {
            const shouldRestore =
                restoreEligibleRef.current &&
                focusWithinRef.current &&
                document.activeElement === document.body;
            restoreEligibleRef.current = false;
            if (shouldRestore && node.focused) {
                (node.searchenabled ? searchInputRef.current : listboxRef.current)?.focus();
            }
        }
    }, [
        node.focused,
        node.filter,
        node.searchenabled,
        submenuId,
    ]);

    const dispatchFilter = (value: string) => {
        if (value === lastDispatchedFilterRef.current) return;
        lastDispatchedFilterRef.current = value;
        onEvent?.({ nodeid: node.id, type: "change", payload: { filter: value } });
    };
    const dispatchSemanticKey = (event: React.KeyboardEvent<HTMLElement>, filterControl = false) => {
        if (composingRef.current) return;
        if (filterControl && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === " ")) return;

        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            onEvent?.({
                nodeid: node.id,
                type: "cycle",
                payload: { direction: event.key === "ArrowRight" ? 1 : -1 },
            });
            return;
        }
        if (event.key === "Enter" || event.key === " ") {
            if (node.nomatch) return;
            event.preventDefault();
            onEvent?.({ nodeid: node.id, type: "submit" });
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            onEvent?.(widgetCancelEvent(node.id));
            return;
        }
        const data =
            event.key === "ArrowUp"
                ? "\x1b[A"
                : event.key === "ArrowDown"
                  ? "\x1b[B"
                  : "";
        if (!data) return;
        event.preventDefault();
        onEvent?.(widgetKeyEvent(node.id, data));
    };
    const visibleItems = node.items.slice(node.visiblestart, node.visibleend);
    const activeOptionId = node.nomatch ? undefined : `${node.id}-option-${node.selectedindex}`;

    if (node.submenu) {
        return (
            <div
                ref={submenuRootRef}
                onFocusCapture={() => {
                    focusWithinRef.current = true;
                }}
                onBlurCapture={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                    focusWithinRef.current = false;
                    restoreEligibleRef.current = false;
                }}
            >
                <WidgetTreeRenderer node={node.submenu} onEvent={onEvent} />
            </div>
        );
    }

    return (
        <div
            ref={parentRootRef}
            className="flex flex-col gap-2 p-1"
            onFocusCapture={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                focusWithinRef.current = true;
                onEvent?.({ nodeid: node.id, type: "focus", payload: { focused: true } });
            }}
            onBlurCapture={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                focusWithinRef.current = false;
                if (!composingRef.current) {
                    reconcileFilter(latestSnapshotFilterRef.current);
                }
                onEvent?.({ nodeid: node.id, type: "focus", payload: { focused: false } });
            }}
        >
            {node.searchenabled && (
                <input
                    ref={searchInputRef}
                    type="search"
                    aria-label={`Filter ${node.id}`}
                    value={filter}
                    onChange={(event) => {
                        const value = event.target.value;
                        dirtyRef.current = true;
                        localFilterRef.current = value;
                        setFilter(value);
                        if (!composingRef.current) dispatchFilter(value);
                    }}
                    onCompositionStart={() => {
                        composingRef.current = true;
                    }}
                    onCompositionEnd={(event) => {
                        composingRef.current = false;
                        dispatchFilter(event.currentTarget.value);
                    }}
                    onKeyDown={(event) => dispatchSemanticKey(event, true)}
                    className="w-full rounded-lg border border-white/[0.12] bg-black/25 px-3 py-2 font-mono text-[12px] text-foreground outline-none focus:border-accent/70"
                />
            )}
            <div
                ref={listboxRef}
                role="listbox"
                tabIndex={node.focused ? 0 : -1}
                aria-activedescendant={activeOptionId}
                aria-label={`Settings list ${node.id}`}
                onKeyDown={dispatchSemanticKey}
                className="flex flex-col gap-px outline-none focus:ring-1 focus:ring-accent/60"
            >
                {node.nomatch ? (
                    <div role="status" className="px-2.5 py-2 text-[12px] text-secondary/75">
                        No matching settings
                    </div>
                ) : (
                    visibleItems.map((item, localIndex) => {
                        const index = node.visiblestart + localIndex;
                        return (
                            <div
                                key={item.id}
                                id={`${node.id}-option-${index}`}
                                role="option"
                                aria-selected={index === node.selectedindex}
                                onClick={() => onEvent?.(widgetSelectEvent(node.id, index))}
                                onDoubleClick={() =>
                                    onEvent?.({ nodeid: node.id, type: "submit", payload: { index } })
                                }
                                className={cn(
                                    "grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-2.5 py-2 text-[13px]",
                                    index === node.selectedindex
                                        ? "bg-accent/15 text-foreground"
                                        : "text-foreground/80"
                                )}
                            >
                                <div>
                                    <div className="font-medium">{item.label}</div>
                                    {item.description && (
                                        <div className="text-[12px] text-secondary/75">{item.description}</div>
                                    )}
                                </div>
                                <span className="min-w-12 text-center font-mono text-[12px] text-secondary/85">
                                    {item.currentvalue}
                                </span>
                            </div>
                        );
                    })
                )}
            </div>
            <div className="px-2 text-[11px] text-secondary/70">Use Left/Right to change, Enter to activate, Escape to cancel.</div>
            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={() => onEvent?.(widgetCancelEvent(node.id))}
                    className="cursor-pointer rounded-lg border border-white/[0.1] px-3 py-1.5 text-[12px] text-secondary/85 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}

function WidgetMarkdownRenderer({ source, paddingx, paddingy }: { source: string; paddingx: number; paddingy: number }) {
    return (
        <div
            data-agent-widget-kind="markdown"
            style={widgetPaddingStyle(paddingx, paddingy)}
        >
            <Markdown
                text={normalizeMarkdownPartialClosingFence(source)}
                className="agent-ext-markdown text-[13px] leading-relaxed text-foreground/90"
                scrollable={false}
            />
        </div>
    );
}

function WidgetEditorRenderer({
    node,
    onEvent,
}: {
    node: Extract<WidgetNode, { kind: "editor" }>;
    onEvent?: AgentWidgetEventHandler;
}) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const composingRef = useRef(false);
    const dirtyRef = useRef(false);
    const nextOrderRef = useRef(0);
    const pendingRef = useRef(new Map<string, OrderedWidgetEditTuple>());
    const authoritativeRef = useRef<OrderedWidgetEditTuple>({
        value: node.value,
        selectionstart: node.selectionstart,
        selectionend: node.selectionend,
        order: 0,
    });
    const lastSentRef = useRef<OrderedWidgetEditTuple>(authoritativeRef.current);
    const selectionRef = useRef({ start: node.selectionstart, end: node.selectionend });
    const pendingSelectionRef = useRef<{ start: number; end: number } | undefined>(undefined);
    const initialSelectionRef = useRef({ start: node.selectionstart, end: node.selectionend });
    const [value, setValue] = useState(node.value);
    const recomputeLastSent = () => {
        const pending = newestOrderedWidgetEdit(pendingRef.current.values());
        lastSentRef.current = newestOrderedWidgetEdit([authoritativeRef.current, ...(pending ? [pending] : [])])!;
        dirtyRef.current = pendingRef.current.size > 0;
    };
    const removePendingEvent = (eventid: string, accepted = false) => {
        const tuple = pendingRef.current.get(eventid);
        if (!tuple) return;
        pendingRef.current.delete(eventid);
        if (accepted && tuple.order > authoritativeRef.current.order) authoritativeRef.current = tuple;
        recomputeLastSent();
    };
    const dispatchPendingEvent = (event: AgentWidgetEvent, tuple?: OrderedWidgetEditTuple) => {
        if (!onEvent || !event.eventid) return;
        try {
            const result = onEvent(event) as Promise<WidgetEventDispatchResult> | undefined;
            if (result == null) {
                removePendingEvent(event.eventid);
                return;
            }
            void result.then((outcome) => {
                if (!outcome.handled) {
                    removePendingEvent(event.eventid!);
                } else if (!outcome.published) {
                    removePendingEvent(event.eventid!, tuple != null);
                }
            }).catch(() => {
                removePendingEvent(event.eventid!);
            });
        } catch {
            removePendingEvent(event.eventid);
        }
    };
    const readControl = () => {
        const textarea = textareaRef.current;
        if (!textarea) return undefined;
        const control = {
            value: textarea.value,
            selectionstart: textarea.selectionStart ?? selectionRef.current.start,
            selectionend: textarea.selectionEnd ?? selectionRef.current.end,
        };
        selectionRef.current = { start: control.selectionstart, end: control.selectionend };
        return control;
    };
    const dispatchChange = () => {
        const control = readControl();
        if (!control) return;
        const lastSent = lastSentRef.current;
        if (
            control.value === lastSent.value &&
            control.selectionstart === lastSent.selectionstart &&
            control.selectionend === lastSent.selectionend
        ) {
            return;
        }
        if (!onEvent) return;
        const eventid = makeWidgetEventId();
        const pending = { ...control, order: ++nextOrderRef.current };
        pendingRef.current.set(eventid, pending);
        lastSentRef.current = pending;
        dirtyRef.current = true;
        dispatchPendingEvent(
            widgetInputChangeEvent(
                node.id,
                control.value,
                control.selectionstart,
                control.selectionend,
                eventid
            ),
            pending
        );
    };
    const dispatchSubmit = () => {
        const control = readControl();
        if (!control || !onEvent) return;
        const eventid = makeWidgetEventId();
        const pending = { ...control, order: ++nextOrderRef.current };
        pendingRef.current.set(eventid, pending);
        lastSentRef.current = pending;
        dirtyRef.current = true;
        dispatchPendingEvent(
            widgetInputSubmitEvent(
                node.id,
                control.value,
                control.selectionstart,
                control.selectionend,
                eventid
            ),
            pending
        );
    };
    const dispatchFocus = (focused: boolean) => {
        if (!onEvent) return;
        const eventid = makeWidgetEventId();
        dispatchPendingEvent({
            nodeid: node.id,
            type: "focus",
            eventid,
            payload: { focused },
        });
    };
    useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const initialSelection = initialSelectionRef.current;
        textarea.setSelectionRange(initialSelection.start, initialSelection.end);
        selectionRef.current = {
            start: textarea.selectionStart ?? 0,
            end: textarea.selectionEnd ?? 0,
        };
        initialSelectionRef.current = {
            start: textarea.selectionStart ?? 0,
            end: textarea.selectionEnd ?? 0,
        };
    }, []);
    useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea || composingRef.current) return;
        let snapshotOrder: number;
        if (node.ackid != null) {
            const acknowledged = pendingRef.current.get(node.ackid);
            if (!acknowledged) {
                if (dirtyRef.current) return;
                snapshotOrder = ++nextOrderRef.current;
            } else {
                snapshotOrder = acknowledged.order;
                for (const [eventid, pending] of pendingRef.current) {
                    if (pending.order <= snapshotOrder) pendingRef.current.delete(eventid);
                }
                recomputeLastSent();
                if (snapshotOrder < authoritativeRef.current.order) {
                    const authoritative = authoritativeRef.current;
                    pendingSelectionRef.current = {
                        start: authoritative.selectionstart,
                        end: authoritative.selectionend,
                    };
                    textarea.value = authoritative.value;
                    setValue(authoritative.value);
                    return;
                }
            }
        } else if (dirtyRef.current) {
            return;
        } else {
            snapshotOrder = ++nextOrderRef.current;
        }
        authoritativeRef.current = {
            value: node.value,
            selectionstart: node.selectionstart,
            selectionend: node.selectionend,
            order: snapshotOrder,
        };
        recomputeLastSent();
        if (dirtyRef.current) return;
        if (textarea.value === node.value) {
            textarea.setSelectionRange(node.selectionstart, node.selectionend);
            selectionRef.current = { start: textarea.selectionStart ?? 0, end: textarea.selectionEnd ?? 0 };
            return;
        }
        pendingSelectionRef.current = { start: node.selectionstart, end: node.selectionend };
        textarea.value = node.value;
        setValue(node.value);
    }, [node]);
    useLayoutEffect(() => {
        const textarea = textareaRef.current;
        const selection = pendingSelectionRef.current;
        if (!textarea || !selection) return;
        pendingSelectionRef.current = undefined;
        textarea.setSelectionRange(selection.start, selection.end);
        selectionRef.current = selection;
    }, [value]);
    return (
        <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                if (composingRef.current) return;
                dispatchSubmit();
            }}
        >
            <textarea
                ref={textareaRef}
                aria-label={`Editor ${node.id}`}
                value={value}
                rows={6}
                onChange={(event) => {
                    const nextValue = event.target.value;
                    setValue(nextValue);
                    if (!composingRef.current) dispatchChange();
                }}
                onCompositionStart={() => {
                    composingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                    composingRef.current = false;
                    setValue(event.currentTarget.value);
                    dispatchChange();
                }}
                onSelect={() => {
                    if (!composingRef.current) dispatchChange();
                }}
                onFocus={() => dispatchFocus(true)}
                onBlur={() => dispatchFocus(false)}
                onKeyDown={(event) => {
                    if (composingRef.current) return;
                    if (editorKeyboardEventMatchesBinding(event, node.newlinekeys)) return;
                    if (!editorKeyboardEventMatchesBinding(event, node.submitkeys)) return;
                    event.preventDefault();
                    dispatchSubmit();
                }}
                style={widgetPaddingStyle(node.paddingx, 0)}
                className="max-h-[320px] min-h-[120px] w-full resize-y rounded-xl border border-white/[0.12] bg-black/25 font-mono text-[13px] leading-relaxed text-foreground outline-none focus:border-accent/70"
            />
            <div className="flex justify-end">
                <button
                    type="submit"
                    className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-black transition-opacity hover:opacity-90"
                >
                    Save
                </button>
            </div>
        </form>
    );
}

interface OrderedWidgetEditTuple {
    value: string;
    selectionstart: number;
    selectionend: number;
    order: number;
}

function newestOrderedWidgetEdit(
    edits: Iterable<OrderedWidgetEditTuple>
): OrderedWidgetEditTuple | undefined {
    let newest: OrderedWidgetEditTuple | undefined;
    for (const edit of edits) {
        if (!newest || edit.order > newest.order) newest = edit;
    }
    return newest;
}

function WidgetInputRenderer({
    node,
    onEvent,
}: {
    node: Extract<WidgetNode, { kind: "input" }>;
    onEvent?: AgentWidgetEventHandler;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    const composingRef = useRef(false);
    const dirtyRef = useRef(false);
    const nextOrderRef = useRef(0);
    const pendingRef = useRef(new Map<string, OrderedWidgetEditTuple>());
    const authoritativeRef = useRef<OrderedWidgetEditTuple>({
        value: node.value,
        selectionstart: node.selectionstart,
        selectionend: node.selectionend,
        order: 0,
    });
    const lastSentRef = useRef<OrderedWidgetEditTuple>(authoritativeRef.current);
    const selectionRef = useRef({ start: node.selectionstart, end: node.selectionend });
    const pendingSelectionRef = useRef<{ start: number; end: number } | undefined>(undefined);
    const initialSelectionRef = useRef({ start: node.selectionstart, end: node.selectionend });
    const [value, setValue] = useState(node.value);
    const recomputeLastSent = () => {
        const pending = newestOrderedWidgetEdit(pendingRef.current.values());
        lastSentRef.current = newestOrderedWidgetEdit([authoritativeRef.current, ...(pending ? [pending] : [])])!;
        dirtyRef.current = pendingRef.current.size > 0;
    };
    const removePendingEvent = (eventid: string, accepted = false) => {
        const tuple = pendingRef.current.get(eventid);
        if (!tuple) return;
        pendingRef.current.delete(eventid);
        if (accepted && tuple.order > authoritativeRef.current.order) authoritativeRef.current = tuple;
        recomputeLastSent();
    };
    const dispatchPendingEvent = (event: AgentWidgetEvent, tuple?: OrderedWidgetEditTuple) => {
        if (!onEvent || !event.eventid) return;
        try {
            const result = onEvent(event) as Promise<WidgetEventDispatchResult> | undefined;
            if (result == null) {
                removePendingEvent(event.eventid);
                return;
            }
            void result.then((outcome) => {
                if (!outcome.handled) {
                    removePendingEvent(event.eventid!);
                } else if (!outcome.published) {
                    removePendingEvent(event.eventid!, tuple != null);
                }
            }).catch(() => {
                removePendingEvent(event.eventid!);
            });
        } catch {
            removePendingEvent(event.eventid);
        }
    };
    const readControl = () => {
        const input = inputRef.current;
        if (!input) return undefined;
        const control = {
            value: input.value,
            selectionstart: input.selectionStart ?? selectionRef.current.start,
            selectionend: input.selectionEnd ?? selectionRef.current.end,
        };
        selectionRef.current = { start: control.selectionstart, end: control.selectionend };
        return control;
    };
    const dispatchChange = () => {
        const control = readControl();
        if (!control) return;
        const lastSent = lastSentRef.current;
        if (
            control.value === lastSent.value &&
            control.selectionstart === lastSent.selectionstart &&
            control.selectionend === lastSent.selectionend
        ) {
            return;
        }
        if (!onEvent) return;
        const eventid = makeWidgetEventId();
        const pending = { ...control, order: ++nextOrderRef.current };
        pendingRef.current.set(eventid, pending);
        lastSentRef.current = pending;
        dirtyRef.current = true;
        dispatchPendingEvent(
            widgetInputChangeEvent(
                node.id,
                control.value,
                control.selectionstart,
                control.selectionend,
                eventid
            ),
            pending
        );
    };
    const dispatchSubmit = () => {
        const control = readControl();
        if (!control) return;
        if (!onEvent) return;
        const eventid = makeWidgetEventId();
        const pending = { ...control, order: ++nextOrderRef.current };
        pendingRef.current.set(eventid, pending);
        lastSentRef.current = pending;
        dirtyRef.current = true;
        dispatchPendingEvent(
            widgetInputSubmitEvent(
                node.id,
                control.value,
                control.selectionstart,
                control.selectionend,
                eventid
            ),
            pending
        );
    };
    const dispatchEvent = (type: "cancel" | "focus", payload?: unknown) => {
        if (!onEvent) return;
        const eventid = makeWidgetEventId();
        dispatchPendingEvent({
            nodeid: node.id,
            type,
            eventid,
            ...(payload == null ? {} : { payload }),
        });
    };
    useLayoutEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        const initialSelection = initialSelectionRef.current;
        input.setSelectionRange(initialSelection.start, initialSelection.end);
        selectionRef.current = {
            start: input.selectionStart ?? 0,
            end: input.selectionEnd ?? 0,
        };
        initialSelectionRef.current = { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 };
    }, []);
    useLayoutEffect(() => {
        const input = inputRef.current;
        if (!input || composingRef.current) return;
        let snapshotOrder: number;
        if (node.ackid != null) {
            const acknowledged = pendingRef.current.get(node.ackid);
            if (!acknowledged) {
                if (dirtyRef.current) return;
                snapshotOrder = ++nextOrderRef.current;
            } else {
                snapshotOrder = acknowledged.order;
                for (const [eventid, pending] of pendingRef.current) {
                    if (pending.order <= snapshotOrder) pendingRef.current.delete(eventid);
                }
                recomputeLastSent();
                if (snapshotOrder < authoritativeRef.current.order) {
                    const authoritative = authoritativeRef.current;
                    pendingSelectionRef.current = {
                        start: authoritative.selectionstart,
                        end: authoritative.selectionend,
                    };
                    input.value = authoritative.value;
                    setValue(authoritative.value);
                    return;
                }
            }
        } else if (dirtyRef.current) {
            return;
        } else {
            snapshotOrder = ++nextOrderRef.current;
        }
        authoritativeRef.current = {
            value: node.value,
            selectionstart: node.selectionstart,
            selectionend: node.selectionend,
            order: snapshotOrder,
        };
        recomputeLastSent();
        if (dirtyRef.current) return;
        if (input.value === node.value) {
            input.setSelectionRange(node.selectionstart, node.selectionend);
            selectionRef.current = { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 };
            return;
        }
        pendingSelectionRef.current = { start: node.selectionstart, end: node.selectionend };
        input.value = node.value;
        setValue(node.value);
    }, [node]);
    useLayoutEffect(() => {
        const input = inputRef.current;
        const selection = pendingSelectionRef.current;
        if (!input || !selection) return;
        pendingSelectionRef.current = undefined;
        input.setSelectionRange(selection.start, selection.end);
        selectionRef.current = selection;
    }, [value]);
    return (
        <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                dispatchSubmit();
            }}
        >
            <input
                ref={inputRef}
                role="textbox"
                aria-label={`Input ${node.id}`}
                value={value}
                onChange={(event) => {
                    const nextValue = event.target.value;
                    setValue(nextValue);
                    if (!composingRef.current) dispatchChange();
                }}
                onCompositionStart={() => {
                    composingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                    composingRef.current = false;
                    setValue(event.currentTarget.value);
                    dispatchChange();
                }}
                onSelect={dispatchChange}
                onFocus={() => {
                    dispatchEvent("focus", { focused: true });
                }}
                onBlur={() => {
                    dispatchEvent("focus", { focused: false });
                }}
                onKeyDown={(event) => {
                    if (composingRef.current) return;
                    if (event.key === "Enter") {
                        event.preventDefault();
                        dispatchSubmit();
                        return;
                    }
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    dispatchEvent("cancel");
                }}
                className="w-full rounded-lg border border-white/[0.12] bg-black/25 px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent/70"
            />
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={() => dispatchEvent("cancel")}
                    className="cursor-pointer rounded-lg border border-white/[0.1] px-3 py-1.5 text-[12px] text-secondary/85 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-black transition-opacity hover:opacity-90"
                >
                    Submit
                </button>
            </div>
        </form>
    );
}

function ExtUiCustomPrompt({
    request,
    respondWidgetEvent,
}: {
    request: Extract<PiExtUiRequest, { kind: "custom" }>;
    respondWidgetEvent?: AgentWidgetEventHandler;
}) {
    return (
        <div className="px-2 py-2">
            <WidgetTreeRenderer node={request.widget} onEvent={respondWidgetEvent} />
        </div>
    );
}

function ExtUiPrompt({
    request,
    respondExtUi,
    respondWidgetEvent,
    anchorRef,
}: {
    request: PiExtUiRequest;
    respondExtUi: (requestId: string, result: unknown) => void;
    respondWidgetEvent?: AgentWidgetEventHandler;
    anchorRef?: RefObject<HTMLElement | null>;
}) {
    // Guard against a double-answer: dismissal + click can both fire.
    const answeredRef = useRef(false);
    // A fresh request means a fresh prompt — reset the guard.
    useEffect(() => {
        answeredRef.current = false;
    }, [request.requestId]);
    const respond = useMemo(
        () =>
            (result: unknown): void => {
                if (answeredRef.current) return;
                answeredRef.current = true;
                respondExtUi(request.requestId, result);
            },
        [request.requestId, respondExtUi]
    );
    const label =
        request.kind === "confirm"
            ? "CONFIRM"
            : request.kind === "select"
              ? "SELECT"
              : request.kind === "editor"
                ? "EDITOR"
                : request.kind === "custom"
                  ? "CUSTOM"
                  : "INPUT";
    let body: React.ReactNode;
    if (request.kind === "confirm") {
        body = <ExtUiConfirmPrompt request={request} onRespond={respond} />;
    } else if (request.kind === "select") {
        body = <ExtUiSelectPrompt request={request} onRespond={respond} />;
    } else if (request.kind === "editor") {
        body = <ExtUiEditorPrompt request={request} onRespond={respond} />;
    } else if (request.kind === "custom") {
        body = <ExtUiCustomPrompt request={request} respondWidgetEvent={respondWidgetEvent} />;
    } else {
        body = <ExtUiInputPrompt request={request} onRespond={respond} />;
    }
    const title = "title" in request ? request.title : "Custom UI";
    return (
        <CommandInlineFrame
            commandName={label}
            className="shrink-0 animate-in fade-in slide-in-from-bottom-1 duration-150"
            dismissAnchorRef={anchorRef}
            headerContent={<span className="truncate text-[13px] text-foreground/85">{title}</span>}
            onDismiss={() => {
                notifyCustomWidgetCancel(request, respondWidgetEvent);
                respond(extUiDeclinedResult(request.kind));
            }}
            role="dialog"
        >
            {body}
        </CommandInlineFrame>
    );
}

export const AgentExtUiPanel = memo(({ extUi, respondExtUi, respondWidgetEvent, anchorRef }: AgentExtUiPanelProps) => {
    if (!hasAgentExtUiContent(extUi)) return null;
    return (
        <div className={cn("flex shrink-0 flex-col gap-2")} data-testid="agent-ext-ui">
            <AgentExtUiStatusWidgets
                statuses={extUi.statuses}
                widgets={extUi.widgets}
                widgetnodes={extUi.widgetnodes}
                renderedEntries={extUi.renderedEntries}
                header={extUi.header}
                footer={extUi.footer}
                respondWidgetEvent={respondWidgetEvent}
            />
            {extUi.request && (
                <ExtUiPrompt
                    request={extUi.request}
                    respondExtUi={respondExtUi}
                    respondWidgetEvent={respondWidgetEvent}
                    anchorRef={anchorRef}
                />
            )}
        </div>
    );
});
AgentExtUiPanel.displayName = "AgentExtUiPanel";
