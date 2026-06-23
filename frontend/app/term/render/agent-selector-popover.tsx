// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

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
}

export type AgentSelectorViewState =
    | { status: "idle" | "loading"; entries: AgentSelectorEntryView[] }
    | { status: "ready"; entries: AgentSelectorEntryView[] }
    | { status: "error"; entries: AgentSelectorEntryView[]; message: string };

export interface AgentSelectorPopoverProps {
    request: AgentSelectorRequest | null;
    onClose: () => void;
    onUserMessage?: (message: string) => void;
    onEditorText?: (text: string) => void;
}

export async function commitAgentSelectorPick(
    request: AgentSelectorRequest,
    entryId: string
): Promise<AgentNavigateTreeResult | AgentForkSessionResult> {
    if (request.type === "tree") {
        return await request.navigateTree(entryId);
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
    return type === "tree" ? "Agent session tree" : "Fork agent session";
}

function getAgentSelectorTitleId(type: AgentSelectorRequestType): string {
    return `agent-selector-${type}-title`;
}

function getAgentSelectorDescriptionId(type: AgentSelectorRequestType): string {
    return `agent-selector-${type}-description`;
}

function getAgentSelectorSubtitle(type: AgentSelectorRequestType): string {
    return type === "tree"
        ? "Jump to a previous point in this agent session."
        : "Pick a previous user prompt to fork into a new session.";
}

function successMessage(type: AgentSelectorRequestType): string {
    return type === "tree" ? "Navigated agent session tree." : "Forked agent session.";
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
    return normalizeForkPoints(await request.listForkPoints());
}

export const AgentSelectorPopover = memo(
    ({ request, onClose, onUserMessage, onEditorText }: AgentSelectorPopoverProps) => {
        const [state, setState] = useState<AgentSelectorViewState>({ status: "idle", entries: [] });
        const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
        const dialogRef = useRef<HTMLDivElement>(null);
        const previousFocusRef = useRef<HTMLElement | null>(null);
        const commitRequestIdRef = useRef(0);

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
            const onKeyDown = (e: KeyboardEvent) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                if (shouldAllowAgentSelectorCancel(busyEntryId)) {
                    onClose();
                }
            };
            document.addEventListener("keydown", onKeyDown, true);
            return () => document.removeEventListener("keydown", onKeyDown, true);
        }, [request, onClose, busyEntryId]);

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
            if (!request) return;
            const id = window.setTimeout(() => {
                const dialog = dialogRef.current;
                const firstEntry = dialog?.querySelector<HTMLElement>("[data-agent-selector-entry]:not(:disabled)");
                (firstEntry ?? dialog)?.focus({ preventScroll: true });
            }, 0);
            return () => window.clearTimeout(id);
        }, [request, state.status, state.entries.length]);

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

        const handlePick = useCallback(
            async (entryId: string) => {
                if (!request) return;
                const commitRequestId = ++commitRequestIdRef.current;
                setBusyEntryId(entryId);
                try {
                    const result = await commitAgentSelectorPick(request, entryId);
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
            [request, onClose, onUserMessage, onEditorText]
        );

        const handleCancel = useCallback(() => {
            if (!shouldAllowAgentSelectorCancel(busyEntryId)) return;
            commitRequestIdRef.current++;
            onClose();
        }, [busyEntryId, onClose]);

        if (!request) return null;

        return (
            <AgentSelectorPanel
                dialogRef={dialogRef}
                requestType={request.type}
                state={state}
                busyEntryId={busyEntryId}
                onPick={handlePick}
                onCancel={handleCancel}
            />
        );
    }
);
AgentSelectorPopover.displayName = "AgentSelectorPopover";

export interface AgentSelectorPanelProps {
    dialogRef?: RefObject<HTMLDivElement | null>;
    requestType: AgentSelectorRequestType;
    state: AgentSelectorViewState;
    busyEntryId: string | null;
    onPick: (entryId: string) => void;
    onCancel: () => void;
}

export const AgentSelectorPanel = memo(
    ({ dialogRef, requestType, state, busyEntryId, onPick, onCancel }: AgentSelectorPanelProps) => {
        const depths = useMemo(() => computeDepths(state.entries), [state.entries]);
        const empty = state.status === "ready" && state.entries.length === 0;
        const canCancel = shouldAllowAgentSelectorCancel(busyEntryId);
        const titleId = getAgentSelectorTitleId(requestType);
        const descriptionId = getAgentSelectorDescriptionId(requestType);
        return (
            <div
                className="absolute inset-0 z-[900]"
                data-agent-selector-backdrop="true"
                data-agent-selector-cancel-disabled={canCancel ? undefined : "true"}
                onClick={() => {
                    if (canCancel) onCancel();
                }}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    aria-describedby={descriptionId}
                    tabIndex={-1}
                    className="absolute bottom-24 left-1/2 w-[min(560px,calc(100%-32px))] -translate-x-1/2 overflow-hidden rounded-md border border-fg-overlay-3 bg-fg-overlay-1 text-[12px] text-foreground shadow-xl backdrop-blur"
                    data-agent-selector="true"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <div className="flex items-start justify-between gap-3 border-b border-fg-overlay-2/70 px-3 py-2">
                        <div>
                            <div id={titleId} className="text-[13px] font-semibold">
                                {getAgentSelectorTitle(requestType)}
                            </div>
                            <div id={descriptionId} className="mt-0.5 text-secondary/70">
                                {getAgentSelectorSubtitle(requestType)}
                            </div>
                        </div>
                        <button
                            type="button"
                            className="rounded px-2 py-1 text-secondary hover:bg-fg-overlay-2/70 hover:text-foreground"
                            onClick={onCancel}
                            disabled={!canCancel}
                        >
                            Cancel
                        </button>
                    </div>

                    {state.status === "loading" && <PanelMessage>Loading choices…</PanelMessage>}
                    {state.status === "error" && <PanelMessage tone="error">{state.message}</PanelMessage>}
                    {empty && <PanelMessage>No choices available for this session.</PanelMessage>}

                    {state.entries.length > 0 && (
                        <div className="max-h-[360px] overflow-y-auto py-1">
                            {state.entries.map((entry) => (
                                <button
                                    key={entry.id}
                                    type="button"
                                    data-agent-selector-entry={entry.id}
                                    data-agent-selector-current={entry.isCurrent ? "true" : undefined}
                                    className={cn(
                                        "flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-fg-overlay-2/70",
                                        entry.isCurrent && "bg-fg-overlay-2/45"
                                    )}
                                    onClick={() => onPick(entry.id)}
                                    disabled={busyEntryId != null}
                                >
                                    <span
                                        className="mt-0.5 shrink-0 text-secondary/60"
                                        style={{ width: `${Math.min(depths.get(entry.id) ?? 0, 6) * 14 + 16}px` }}
                                    >
                                        {requestType === "tree" ? "↳" : "•"}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2">
                                            <span className="truncate font-medium">
                                                {entry.label || entry.role || "entry"}
                                            </span>
                                            {entry.isCurrent && (
                                                <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] text-green-300">
                                                    current
                                                </span>
                                            )}
                                            {entry.isLeaf && !entry.isCurrent && (
                                                <span className="rounded bg-fg-overlay-2 px-1.5 py-0.5 text-[10px] text-secondary">
                                                    leaf
                                                </span>
                                            )}
                                        </span>
                                        <span className="mt-0.5 block truncate text-secondary/80">{entry.preview}</span>
                                    </span>
                                    {busyEntryId === entry.id && (
                                        <span className="shrink-0 text-secondary">Working…</span>
                                    )}
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="border-t border-fg-overlay-2/60 px-3 py-1.5 text-[11px] text-secondary/65">
                        Click a row to select · Esc or outside click cancels.
                    </div>
                </div>
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
