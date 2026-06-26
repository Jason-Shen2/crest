// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { COMMAND_INLINE_FRAME_CLASSNAME, CommandInlineFrame } from "@/app/view/cmdblock/command-inline-frame";
import { cn } from "@/util/util";
import type { RefObject } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentSelectorRequest } from "./agent-chat-host";

type AgentSelectorRequestType = AgentSelectorRequest["type"];

export interface AgentSelectorEntryView {
    id: string;
    parentId?: string;
    role?: string;
    label?: string;
    preview: string;
    timestamp?: string;
    isLeaf?: boolean;
    isCurrent?: boolean;
    sessionMetadata?: AgentSessionMeta;
}

export type AgentSelectorViewState =
    | { status: "idle" | "loading"; entries: AgentSelectorEntryView[] }
    | { status: "ready"; entries: AgentSelectorEntryView[] }
    | { status: "error"; entries: AgentSelectorEntryView[]; message: string };

export interface AgentSelectorPopoverProps {
    anchorRef?: RefObject<HTMLElement | null>;
    request: AgentSelectorRequest | null;
    onClose: () => void;
    onUserMessage?: (message: string) => void;
    onEditorText?: (text: string) => void;
}

export const COMMAND_SELECTOR_LIST_MAX_HEIGHT_PX = 360;
const COMMAND_SELECTOR_LIST_MIN_HEIGHT_PX = 200;
const COMMAND_SELECTOR_LIST_MAX_RESIZE_HEIGHT_PX = 720;
const SELECTOR_FOOTER_FONT_PX = 11;
export const COMMAND_SELECTOR_INLINE_CLASSNAME = COMMAND_INLINE_FRAME_CLASSNAME;

export async function commitAgentSelectorPick(
    request: AgentSelectorRequest,
    entryId: string,
    entries: AgentSelectorEntryView[] = []
): Promise<AgentNavigateTreeResult | AgentForkSessionResult> {
    if (request.type === "tree") {
        return await request.navigateTree(entryId);
    }
    if (request.type === "resume") {
        const sessionMetadata = entries.find((entry) => entry.id === entryId)?.sessionMetadata;
        if (!sessionMetadata) {
            throw new Error("Selected session is no longer available.");
        }
        return await request.resumeSession(sessionMetadata);
    }
    return await request.forkSession(entryId);
}

export function shouldAllowAgentSelectorCancel(busyEntryId: string | null): boolean {
    return busyEntryId == null;
}

export function editorTextFromAgentSelectorResult(
    result: AgentNavigateTreeResult | AgentForkSessionResult
): string | undefined {
    return "editorText" in result ? result.editorText : undefined;
}

export function getAgentSelectorTitle(type: AgentSelectorRequestType): string {
    if (type === "tree") return "Agent session tree";
    if (type === "resume") return "Resume agent session";
    return "Fork agent session";
}

export function getInitialAgentSelectorFocusEntryId(
    type: AgentSelectorRequestType,
    entries: AgentSelectorEntryView[]
): string | undefined {
    if (type === "fork") {
        return entries[entries.length - 1]?.id;
    }
    return entries.find((entry) => entry.isCurrent)?.id ?? entries[0]?.id;
}

function successMessage(type: AgentSelectorRequestType): string {
    if (type === "tree") return "Navigated agent session tree.";
    if (type === "resume") return "Resumed agent session.";
    return "Forked agent session.";
}

function normalizeForkPoints(points: AgentForkPointView[]): AgentSelectorEntryView[] {
    return points.map((point) => ({
        id: point.entryId,
        role: "user",
        preview: point.preview,
        timestamp: point.timestamp,
    }));
}

async function loadSelectorEntries(request: AgentSelectorRequest): Promise<AgentSelectorEntryView[]> {
    if (request.type === "tree") {
        const result = await request.listTree();
        return result.entries.map((entry) => ({
            id: entry.id,
            parentId: entry.parentId,
            role: entry.role,
            label: entry.label,
            preview: entry.preview,
            timestamp: entry.timestamp,
            isLeaf: entry.isLeaf,
            isCurrent: entry.isCurrent,
        }));
    }
    if (request.type === "resume") {
        const sessions = await request.listSessions();
        return sessions.map((session, index) => ({
            id: session.path || session.id || String(index),
            role: "session",
            label: session.path ? session.path.split(/[\\/]/).pop() : session.id || "session",
            preview: session.cwd,
            timestamp: session.createdAt,
            sessionMetadata: session,
        }));
    }
    return normalizeForkPoints(await request.listForkPoints());
}

export const AgentSelectorPopover = memo(
    ({ request, onClose, onUserMessage, onEditorText }: AgentSelectorPopoverProps) => {
        const [state, setState] = useState<AgentSelectorViewState>({ status: "idle", entries: [] });
        const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
        const panelRef = useRef<HTMLDivElement>(null);
        const previousFocusRef = useRef<HTMLElement | null>(null);
        const commitRequestIdRef = useRef(0);
        const [listMaxHeight, setListMaxHeight] = useState(COMMAND_SELECTOR_LIST_MAX_HEIGHT_PX);

        useEffect(() => {
            if (!request) {
                commitRequestIdRef.current++;
                return;
            }
            return () => {
                commitRequestIdRef.current++;
            };
        }, [request]);

        useEffect(() => {
            if (!request) return;
            previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            return () => {
                const previous = previousFocusRef.current;
                previousFocusRef.current = null;
                if (previous && previous.isConnected) {
                    previous.focus({ preventScroll: true });
                }
            };
        }, [request]);

        useEffect(() => {
            if (!request) {
                setState({ status: "idle", entries: [] });
                setBusyEntryId(null);
                return;
            }

            let cancelled = false;
            setState({ status: "loading", entries: [] });
            setBusyEntryId(null);
            void loadSelectorEntries(request)
                .then((entries) => {
                    if (cancelled) return;
                    setState({ status: "ready", entries });
                })
                .catch((err) => {
                    if (cancelled) return;
                    const message = err instanceof Error ? err.message : String(err);
                    setState({ status: "error", entries: [], message });
                });

            return () => {
                cancelled = true;
            };
        }, [request]);

        useEffect(() => {
            if (state.status === "ready" && state.entries.length > 0) {
                const id = window.setTimeout(() => {
                    panelRef.current?.focus({ preventScroll: true });
                }, 0);
                return () => window.clearTimeout(id);
            }
        }, [state.status, state.entries.length]);

        const handlePick = useCallback(
            async (entryId: string) => {
                if (!request) return;
                const commitRequestId = ++commitRequestIdRef.current;
                setBusyEntryId(entryId);
                try {
                    const result = await commitAgentSelectorPick(request, entryId, state.entries);
                    if (commitRequestId !== commitRequestIdRef.current) return;
                    const editorText = editorTextFromAgentSelectorResult(result);
                    if (editorText != null) {
                        onEditorText?.(editorText);
                    }
                    onUserMessage?.(successMessage(request.type));
                    onClose();
                } catch (err) {
                    if (commitRequestId !== commitRequestIdRef.current) return;
                    const message = err instanceof Error ? err.message : String(err);
                    setState((prev) => ({ status: "error", entries: prev.entries, message }));
                } finally {
                    if (commitRequestId === commitRequestIdRef.current) {
                        setBusyEntryId(null);
                    }
                }
            },
            [request, state.entries, onClose, onUserMessage, onEditorText]
        );

        const handleCancel = useCallback(() => {
            commitRequestIdRef.current++;
            onClose();
        }, [onClose]);

        const handleResizeStart = useCallback(
            (e: React.MouseEvent<HTMLButtonElement>) => {
                e.preventDefault();
                const startY = e.clientY;
                const startHeight = listMaxHeight;
                const onMove = (mv: MouseEvent) => {
                    const next = Math.min(
                        COMMAND_SELECTOR_LIST_MAX_RESIZE_HEIGHT_PX,
                        Math.max(COMMAND_SELECTOR_LIST_MIN_HEIGHT_PX, startHeight - (mv.clientY - startY))
                    );
                    setListMaxHeight(next);
                };
                const onUp = () => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            },
            [listMaxHeight]
        );

        if (!request) return null;

        const canCancel = shouldAllowAgentSelectorCancel(busyEntryId);
        const cancelButton = canCancel ? (
            <button
                type="button"
                className="rounded px-2 py-1 text-secondary hover:bg-fg-overlay-2/70 hover:text-foreground"
                onClick={handleCancel}
                style={{ fontSize: "11px" }}
            >
                Cancel
            </button>
        ) : (
            <span className="px-2 py-1 text-secondary/40" style={{ fontSize: "11px" }}>
                Cancel
            </span>
        );

        return (
            <CommandInlineFrame
                commandName={`/${request.type}`}
                onResizeStart={handleResizeStart}
                headerActions={cancelButton}
            >
                <AgentSelectorPanel
                    panelRef={panelRef}
                    requestType={request.type}
                    state={state}
                    busyEntryId={busyEntryId}
                    listMaxHeight={listMaxHeight}
                    onPick={handlePick}
                    onCancel={handleCancel}
                />
            </CommandInlineFrame>
        );
    }
);
AgentSelectorPopover.displayName = "AgentSelectorPopover";

export interface AgentSelectorPanelProps {
    panelRef?: RefObject<HTMLDivElement | null>;
    requestType: AgentSelectorRequestType;
    state: AgentSelectorViewState;
    busyEntryId: string | null;
    listMaxHeight?: number;
    onPick: (entryId: string) => void;
    onCancel: () => void;
}

export const AgentSelectorPanel = memo(
    ({
        panelRef,
        requestType,
        state,
        busyEntryId,
        listMaxHeight = COMMAND_SELECTOR_LIST_MAX_HEIGHT_PX,
        onPick,
        onCancel,
    }: AgentSelectorPanelProps) => {
        const [activeIdx, setActiveIdx] = useState(0);
        const listInnerRef = useRef<HTMLDivElement>(null);
        const depths = useMemo(() => computeDepths(state.entries), [state.entries]);
        const empty = state.status === "ready" && state.entries.length === 0;
        const entryCount = state.entries.length;

        useEffect(() => {
            if (state.status !== "ready") return;
            const initialId = getInitialAgentSelectorFocusEntryId(requestType, state.entries);
            const idx = state.entries.findIndex((e) => e.id === initialId);
            setActiveIdx(idx >= 0 ? idx : 0);
        }, [requestType, state.status, state.entries]);

        useEffect(() => {
            if (entryCount === 0) return;
            const list = listInnerRef.current;
            if (!list) return;
            const row = list.querySelector<HTMLElement>(`[data-agent-selector-row-idx="${activeIdx}"]`);
            row?.scrollIntoView({ block: "nearest" });
        }, [activeIdx, entryCount]);

        const handleKeyDown = useCallback(
            (e: React.KeyboardEvent) => {
                if (entryCount === 0) {
                    if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        onCancel();
                    }
                    return;
                }
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveIdx((prev) => (prev + 1) % entryCount);
                    return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveIdx((prev) => (prev - 1 + entryCount) % entryCount);
                    return;
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    const entry = state.entries[activeIdx];
                    if (entry && busyEntryId == null) {
                        onPick(entry.id);
                    }
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancel();
                    return;
                }
            },
            [entryCount, state.entries, activeIdx, busyEntryId, onPick, onCancel]
        );

        return (
            <div
                ref={panelRef}
                className="text-[12px] text-foreground font-sans outline-none"
                tabIndex={-1}
                role="listbox"
                aria-label={getAgentSelectorTitle(requestType)}
                onKeyDown={handleKeyDown}
            >
                {state.status === "loading" && <PanelMessage>Loading choices…</PanelMessage>}
                {state.status === "error" && <PanelMessage tone="error">{state.message}</PanelMessage>}
                {empty && <PanelMessage>No choices available for this session.</PanelMessage>}

                {state.entries.length > 0 && (
                    <div ref={listInnerRef} className="overflow-y-auto" style={{ maxHeight: `${listMaxHeight}px` }}>
                        {state.entries.map((entry, idx) => {
                            const isActive = idx === activeIdx;
                            const indent = Math.min(depths.get(entry.id) ?? 0, 6) * 14 + 12;
                            return (
                                <div
                                    key={entry.id}
                                    data-agent-selector-row={entry.id}
                                    data-agent-selector-row-idx={idx}
                                    data-agent-selector-active={isActive ? "true" : undefined}
                                    data-agent-selector-current={entry.isCurrent ? "true" : undefined}
                                    className={cn(
                                        "flex w-full items-center gap-2 py-1.5 pr-2 text-left transition-colors",
                                        isActive ? "bg-fg-overlay-2/70" : "hover:bg-fg-overlay-1"
                                    )}
                                    onMouseEnter={() => setActiveIdx(idx)}
                                >
                                    <button
                                        type="button"
                                        className="flex w-full items-start gap-2 bg-transparent px-0 py-0 text-left focus:outline-none"
                                        style={{ paddingLeft: `${indent}px` }}
                                        onClick={() => busyEntryId == null && onPick(entry.id)}
                                        disabled={busyEntryId != null}
                                    >
                                        <span className="mt-0.5 shrink-0 text-secondary/50 text-[11px]">
                                            {requestType === "tree" ? "↳" : "•"}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-2">
                                                <span className="truncate font-medium" style={{ fontSize: "12px" }}>
                                                    {entry.label || entry.role || "entry"}
                                                </span>
                                                {entry.isCurrent && (
                                                    <span className="shrink-0 rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-300">
                                                        current
                                                    </span>
                                                )}
                                                {entry.isLeaf && !entry.isCurrent && (
                                                    <span className="shrink-0 rounded bg-fg-overlay-2/70 px-1.5 py-0.5 text-[10px] text-secondary">
                                                        leaf
                                                    </span>
                                                )}
                                            </span>
                                            <span
                                                className="mt-0.5 block truncate text-secondary/75"
                                                style={{ fontSize: "11px" }}
                                            >
                                                {entry.preview}
                                            </span>
                                        </span>
                                        {busyEntryId === entry.id && (
                                            <span className="shrink-0 self-center text-secondary text-[11px]">
                                                Working…
                                            </span>
                                        )}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                <SelectorHintFooter />
            </div>
        );
    }
);
AgentSelectorPanel.displayName = "AgentSelectorPanel";

function PanelMessage({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
    return (
        <div className={cn("px-3 py-4 text-center", tone === "error" ? "text-rose-300" : "text-secondary/75")}>
            {children}
        </div>
    );
}

const SelectorHintFooter = memo(() => (
    <div
        className="flex items-center gap-x-3 border-t border-fg-overlay-2 bg-fg-overlay-1/60 px-3 py-1.5 font-sans text-secondary/65"
        style={{ fontSize: `${SELECTOR_FOOTER_FONT_PX}px` }}
    >
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">
                ↑
            </kbd>
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">
                ↓
            </kbd>
            <span>navigate</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">
                ↵
            </kbd>
            <span>select</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1.5">
                esc
            </kbd>
            <span>dismiss</span>
        </span>
    </div>
));
SelectorHintFooter.displayName = "SelectorHintFooter";

function computeDepths(entries: AgentSelectorEntryView[]): Map<string, number> {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const depths = new Map<string, number>();
    const depthFor = (entry: AgentSelectorEntryView): number => {
        const cached = depths.get(entry.id);
        if (cached != null) return cached;
        const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
        const depth = parent ? depthFor(parent) + 1 : 0;
        depths.set(entry.id, depth);
        return depth;
    };
    entries.forEach(depthFor);
    return depths;
}
