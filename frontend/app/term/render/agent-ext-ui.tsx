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
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type {
    RenderedExtensionEntryNode,
    WidgetNode,
} from "../../../../emain/agent/extensions/pi-gui/crest/widget-tree";

export interface AgentExtUiPanelProps {
    extUi: PiExtUiState;
    respondExtUi: (requestId: string, result: unknown) => void;
    respondWidgetEvent?: (event: AgentWidgetEvent) => void;
    /** Composer anchor so outside-click dismissal ignores clicks on the input. */
    anchorRef?: RefObject<HTMLElement | null>;
}

const WidgetPaddingUnitPx = 8;
const WidgetPaddingMaxUnits = 64;

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

export function widgetInputChangeEvent(nodeid: string, value: string): AgentWidgetEvent {
    return { nodeid, type: "change", payload: { value } };
}

export function widgetInputSubmitEvent(nodeid: string): AgentWidgetEvent {
    return { nodeid, type: "submit" };
}

export function widgetInputCancelEvent(nodeid: string): AgentWidgetEvent {
    return { nodeid, type: "cancel" };
}

export function widgetValueChangeEvent(nodeid: string, id: string, value: string): AgentWidgetEvent {
    return { nodeid, type: "change", payload: { id, value } };
}

export function widgetInputRendererSyncKey(nodeid: string, value: string): string {
    return `${nodeid}:${value}`;
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

export function notifyCustomWidgetCancel(
    request: PiExtUiRequest,
    respondWidgetEvent?: (event: AgentWidgetEvent) => void
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
        respondWidgetEvent?: (event: AgentWidgetEvent) => void;
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

function WidgetTreeRenderer({ node, onEvent }: { node: WidgetNode; onEvent?: (event: AgentWidgetEvent) => void }) {
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
        const selectedIndex =
            node.items.length === 0 ? -1 : Math.max(0, Math.min(node.selectedindex, node.items.length - 1));
        const activeOptionId = selectedIndex >= 0 ? `${node.id}-option-${selectedIndex}` : undefined;
        return (
            <div className="flex flex-col gap-2 p-1">
                <div
                    role="listbox"
                    tabIndex={node.focused ? 0 : -1}
                    aria-activedescendant={activeOptionId}
                    aria-label={`Select list ${node.id}`}
                    onKeyDown={(event) => {
                        const data = keyDataForWidgetTerminal(event.key);
                        if (!data) return;
                        event.preventDefault();
                        onEvent?.(widgetKeyEvent(node.id, data));
                    }}
                    className="flex flex-col gap-px outline-none focus:ring-1 focus:ring-accent/60"
                >
                    {node.items.map((item, index) => (
                        <div
                            key={`${item.value}-${index}`}
                            id={`${node.id}-option-${index}`}
                            role="option"
                            aria-selected={index === selectedIndex}
                            onClick={() => onEvent?.(widgetSelectEvent(node.id, index))}
                            className={cn(
                                "cursor-pointer rounded-xl px-2.5 py-2 text-left text-[13px]",
                                index === selectedIndex ? "bg-accent/15 text-foreground" : "text-foreground/80"
                            )}
                        >
                            <div className="font-medium">{item.label}</div>
                            {item.description && (
                                <div className="text-[12px] text-secondary/75">{item.description}</div>
                            )}
                        </div>
                    ))}
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
    if (node.kind === "settingslist") {
        return (
            <WidgetSettingsListRenderer node={node} onEvent={onEvent} />
        );
    }
    if (node.kind === "input") {
        return (
            <WidgetInputRenderer
                key={widgetInputRendererSyncKey(node.id, node.value)}
                id={node.id}
                initialValue={node.value}
                onEvent={onEvent}
            />
        );
    }
    if (node.kind === "markdown") {
        return <WidgetMarkdownRenderer source={node.source} paddingx={node.paddingx} paddingy={node.paddingy} />;
    }
    if (node.kind === "editor") {
        return (
            <WidgetEditorRenderer
                key={widgetInputRendererSyncKey(node.id, node.value)}
                id={node.id}
                initialValue={node.value}
                paddingx={node.paddingx}
                onEvent={onEvent}
            />
        );
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

function nextCyclicValue(values: string[], currentValue: string, direction: 1 | -1): string {
    if (values.length === 0) return currentValue;
    const currentIndex = values.indexOf(currentValue);
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    return values[(startIndex + direction + values.length) % values.length] ?? currentValue;
}

function WidgetSettingsListRenderer({
    node,
    onEvent,
}: {
    node: Extract<WidgetNode, { kind: "settingslist" }>;
    onEvent?: (event: AgentWidgetEvent) => void;
}) {
    const [activeIndex, setActiveIndex] = useState(node.selectedindex);
    useEffect(() => {
        setActiveIndex(node.selectedindex);
    }, [node.id, node.selectedindex]);
    const selectedIndex =
        node.items.length === 0 ? -1 : Math.max(0, Math.min(activeIndex, node.items.length - 1));
    const activeOptionId = selectedIndex >= 0 ? `${node.id}-option-${selectedIndex}` : undefined;
    const activeItem = selectedIndex >= 0 ? node.items[selectedIndex] : undefined;
    const changeActiveValue = (direction: 1 | -1) => {
        if (!activeItem?.values?.length) return;
        onEvent?.(widgetValueChangeEvent(node.id, activeItem.id, nextCyclicValue(activeItem.values, activeItem.currentvalue, direction)));
    };
    return (
        <div className="flex flex-col gap-2 p-1">
            <div
                role="listbox"
                tabIndex={0}
                aria-activedescendant={activeOptionId}
                aria-label={`Settings list ${node.id}`}
                onKeyDown={(event) => {
                    if (event.key === "ArrowRight") {
                        event.preventDefault();
                        changeActiveValue(1);
                        return;
                    }
                    if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        changeActiveValue(-1);
                        return;
                    }
                    if (event.key === "Enter") {
                        event.preventDefault();
                        onEvent?.({ nodeid: node.id, type: "submit" });
                        return;
                    }
                    if (event.key === "Escape") {
                        event.preventDefault();
                        onEvent?.(widgetCancelEvent(node.id));
                        return;
                    }
                    const data = keyDataForWidgetTerminal(event.key);
                    if (!data) return;
                    event.preventDefault();
                    onEvent?.(widgetKeyEvent(node.id, data));
                }}
                className="flex flex-col gap-px outline-none focus:ring-1 focus:ring-accent/60"
            >
                {node.items.map((item, index) => {
                    return (
                        <div
                            key={item.id}
                            id={`${node.id}-option-${index}`}
                            role="option"
                            aria-selected={index === selectedIndex}
                            onClick={() => {
                                setActiveIndex(index);
                                onEvent?.(widgetSelectEvent(node.id, index));
                            }}
                            className={cn(
                                "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-2.5 py-2 text-[13px]",
                                index === selectedIndex ? "bg-accent/15 text-foreground" : "text-foreground/80"
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
                })}
            </div>
            <div className="px-2 text-[11px] text-secondary/70">Use Left/Right to change, Enter to activate, Escape to cancel.</div>
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
                text={source}
                className="agent-ext-markdown text-[13px] leading-relaxed text-foreground/90"
                scrollable={false}
            />
        </div>
    );
}

function WidgetEditorRenderer({
    id,
    initialValue,
    paddingx,
    onEvent,
}: {
    id: string;
    initialValue: string;
    paddingx: number;
    onEvent?: (event: AgentWidgetEvent) => void;
}) {
    const [value, setValue] = useState(initialValue);
    useEffect(() => {
        setValue(initialValue);
    }, [id, initialValue]);
    return (
        <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                onEvent?.({ nodeid: id, type: "submit" });
            }}
        >
            <textarea
                aria-label={`Editor ${id}`}
                value={value}
                rows={6}
                onChange={(event) => {
                    const nextValue = event.target.value;
                    setValue(nextValue);
                    onEvent?.({ nodeid: id, type: "change", payload: { value: nextValue } });
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        onEvent?.(widgetCancelEvent(id));
                        return;
                    }
                    const data = keyDataForWidgetTerminal(event.key);
                    if (!data || event.key.length === 1) return;
                    event.preventDefault();
                    onEvent?.(widgetKeyEvent(id, data));
                }}
                style={widgetPaddingStyle(paddingx, 0)}
                className="max-h-[320px] min-h-[120px] w-full resize-y rounded-xl border border-white/[0.12] bg-black/25 font-mono text-[13px] leading-relaxed text-foreground outline-none focus:border-accent/70"
            />
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={() => onEvent?.(widgetCancelEvent(id))}
                    className="cursor-pointer rounded-lg border border-white/[0.1] px-3 py-1.5 text-[12px] text-secondary/85 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                    Cancel
                </button>
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

function WidgetInputRenderer({
    id,
    initialValue,
    onEvent,
}: {
    id: string;
    initialValue: string;
    onEvent?: (event: AgentWidgetEvent) => void;
}) {
    const [value, setValue] = useState(initialValue);
    useEffect(() => {
        setValue(initialValue);
    }, [id, initialValue]);
    return (
        <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                onEvent?.(widgetInputSubmitEvent(id));
            }}
        >
            <input
                role="textbox"
                aria-label={`Input ${id}`}
                value={value}
                onChange={(event) => {
                    const nextValue = event.target.value;
                    setValue(nextValue);
                    onEvent?.(widgetInputChangeEvent(id, nextValue));
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        onEvent?.(widgetInputSubmitEvent(id));
                        return;
                    }
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    onEvent?.(widgetInputCancelEvent(id));
                }}
                className="w-full rounded-lg border border-white/[0.12] bg-black/25 px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-accent/70"
            />
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={() => onEvent?.(widgetInputCancelEvent(id))}
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
    respondWidgetEvent?: (event: AgentWidgetEvent) => void;
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
    respondWidgetEvent?: (event: AgentWidgetEvent) => void;
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
