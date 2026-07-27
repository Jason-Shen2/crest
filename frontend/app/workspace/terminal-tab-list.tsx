// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TerminalNavigationAdapter } from "./terminal-navigation";
import { TerminalTabRow, type TerminalTabProjection } from "./terminal-tab-row";

const TerminalDragDataType = "application/x-crest-terminal-tab";
const AutoScrollEdgePx = 32;
const AutoScrollStepPx = 18;

export interface TerminalTabListProps {
    terminalTabIds: readonly string[];
    activeTerminalTabId: string;
    rows?: readonly TerminalTabProjection[];
    navigation: TerminalNavigationAdapter;
    className?: string;
}

export function reorderTerminalTabIds(terminalTabIds: readonly string[], sourceId: string, targetId: string): string[] {
    const sourceIndex = terminalTabIds.indexOf(sourceId);
    const targetIndex = terminalTabIds.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return Array.from(terminalTabIds);
    }
    const next = Array.from(terminalTabIds);
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, sourceId);
    return next;
}

export function TerminalTabList({
    terminalTabIds,
    activeTerminalTabId,
    rows = [],
    navigation,
    className,
}: TerminalTabListProps) {
    const authoritativeIdsRef = useRef(terminalTabIds);
    const mutationVersionRef = useRef(0);
    const reorderVersionRef = useRef(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const listboxRef = useRef<HTMLDivElement>(null);
    const selectionRefs = useRef(new Map<string, HTMLDivElement>());
    const focusedSelectionIdRef = useRef("");
    const [query, setQuery] = useState("");
    const [orderedIds, setOrderedIds] = useState(() => Array.from(terminalTabIds));
    const [draggingId, setDraggingId] = useState("");
    const [mutationError, setMutationError] = useState("");
    const [focusedTerminalTabId, setFocusedTerminalTabId] = useState(
        () => activeTerminalTabId || terminalTabIds[0] || ""
    );
    const [matchState, setMatchState] = useState<{
        query: string;
        matches: ReadonlyMap<string, boolean>;
    }>({ query: "", matches: new Map() });
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const reorderEnabled = normalizedQuery === "";
    const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
    const reportMatch = useCallback((terminalTabId: string, reportQuery: string, matches: boolean) => {
        setMatchState((current) => {
            const nextMatches = current.query === reportQuery ? new Map(current.matches) : new Map<string, boolean>();
            if (current.query === reportQuery && nextMatches.get(terminalTabId) === matches) {
                return current;
            }
            nextMatches.set(terminalTabId, matches);
            return { query: reportQuery, matches: nextMatches };
        });
    }, []);
    const matchReportComplete =
        normalizedQuery !== "" &&
        matchState.query === normalizedQuery &&
        orderedIds.every((terminalTabId) => matchState.matches.has(terminalTabId));
    const noMatches =
        matchReportComplete && orderedIds.every((terminalTabId) => !matchState.matches.get(terminalTabId));
    const visibleTerminalTabIds = matchReportComplete
        ? orderedIds.filter((terminalTabId) => matchState.matches.get(terminalTabId))
        : orderedIds;
    const rovingTerminalTabId = visibleTerminalTabIds.includes(focusedTerminalTabId)
        ? focusedTerminalTabId
        : visibleTerminalTabIds.includes(activeTerminalTabId)
          ? activeTerminalTabId
          : (visibleTerminalTabIds[0] ?? "");

    useEffect(() => {
        authoritativeIdsRef.current = terminalTabIds;
        setOrderedIds(Array.from(terminalTabIds));
    }, [terminalTabIds]);

    useEffect(() => {
        const listbox = listboxRef.current;
        const activeElement = listbox?.ownerDocument.activeElement;
        if (listbox && activeElement && listbox.contains(activeElement)) {
            return;
        }
        if (activeTerminalTabId) {
            setFocusedTerminalTabId(activeTerminalTabId);
        }
    }, [activeTerminalTabId]);

    useLayoutEffect(() => {
        const focusedSelectionId = focusedSelectionIdRef.current;
        if (!focusedSelectionId || visibleTerminalTabIds.includes(focusedSelectionId)) {
            return;
        }
        const fallbackId = rovingTerminalTabId;
        const fallbackNode = selectionRefs.current.get(fallbackId);
        if (!fallbackId || !fallbackNode) {
            focusedSelectionIdRef.current = "";
            return;
        }
        focusedSelectionIdRef.current = fallbackId;
        setFocusedTerminalTabId(fallbackId);
        fallbackNode.focus();
        navigation.select(fallbackId);
    });

    const runMutation = (mutation: () => Promise<void>) => {
        const mutationVersion = ++mutationVersionRef.current;
        setMutationError("");
        void mutation().then(
            () => {
                if (mutationVersion === mutationVersionRef.current) {
                    setMutationError("");
                }
            },
            (error) => {
                setOrderedIds(Array.from(authoritativeIdsRef.current));
                if (mutationVersion === mutationVersionRef.current) {
                    setMutationError(error instanceof Error ? error.message : String(error));
                }
            }
        );
    };
    const commitReorder = (next: string[]) => {
        if (next.length !== orderedIds.length || next.every((id, index) => id === orderedIds[index])) {
            return;
        }
        const reorderVersion = ++reorderVersionRef.current;
        setOrderedIds(next);
        void navigation.reorder(next).catch(() => {
            if (reorderVersion === reorderVersionRef.current) {
                setOrderedIds(Array.from(authoritativeIdsRef.current));
            }
        });
    };
    const moveByOffset = (terminalTabId: string, offset: -1 | 1) => {
        const sourceIndex = orderedIds.indexOf(terminalTabId);
        const targetId = orderedIds[sourceIndex + offset];
        if (!targetId || !reorderEnabled) return;
        commitReorder(reorderTerminalTabIds(orderedIds, terminalTabId, targetId));
    };
    const navigateVisibleRows = (terminalTabId: string, direction: "previous" | "next" | "first" | "last") => {
        const sourceIndex = visibleTerminalTabIds.indexOf(terminalTabId);
        if (sourceIndex < 0) {
            return;
        }
        let targetIndex = sourceIndex;
        if (direction === "previous") {
            targetIndex = Math.max(0, sourceIndex - 1);
        } else if (direction === "next") {
            targetIndex = Math.min(visibleTerminalTabIds.length - 1, sourceIndex + 1);
        } else if (direction === "first") {
            targetIndex = 0;
        } else {
            targetIndex = visibleTerminalTabIds.length - 1;
        }
        const targetId = visibleTerminalTabIds[targetIndex];
        if (!targetId) {
            return;
        }
        setFocusedTerminalTabId(targetId);
        navigation.select(targetId);
        selectionRefs.current.get(targetId)?.focus();
    };
    const autoScroll = (clientY: number) => {
        const element = scrollRef.current;
        if (!element) return;
        const bounds = element.getBoundingClientRect();
        if (clientY < bounds.top + AutoScrollEdgePx) {
            element.scrollTop -= AutoScrollStepPx;
        } else if (clientY > bounds.bottom - AutoScrollEdgePx) {
            element.scrollTop += AutoScrollStepPx;
        }
    };

    return (
        <section className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2">
                <label className="flex min-w-0 flex-1 items-center gap-1 rounded bg-fg-overlay-1 px-2">
                    <UIcon name="search" size={14} />
                    <input
                        type="search"
                        aria-label="Search terminals"
                        className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </label>
                {orderedIds.length > 0 ? (
                    <button
                        type="button"
                        aria-label="New Terminal"
                        className="cursor-pointer rounded p-1 hover:bg-fg-overlay-2"
                        onClick={() => runMutation(() => navigation.create())}
                    >
                        <UIcon name="plus" size={16} />
                    </button>
                ) : null}
            </div>

            {mutationError ? (
                <div role="alert" className="shrink-0 border-b border-border px-3 py-2 text-sm text-red-500">
                    {mutationError}
                </div>
            ) : null}

            {orderedIds.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
                    <div className="text-sm text-secondary">No terminals open</div>
                    <button
                        type="button"
                        aria-label="New Terminal"
                        className="cursor-pointer rounded border border-border px-3 py-1.5 text-sm hover:bg-fg-overlay-1"
                        onClick={() => runMutation(() => navigation.create())}
                    >
                        New Terminal
                    </button>
                </div>
            ) : (
                <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="terminal-tab-rows">
                    <div
                        ref={listboxRef}
                        role="listbox"
                        aria-label="Terminals"
                        onBlurCapture={(event) => {
                            const nextTarget = event.relatedTarget as Node | null;
                            if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                                focusedSelectionIdRef.current = "";
                            }
                        }}
                    >
                        {orderedIds.map((terminalTabId, index) => {
                            const row = rowById.get(terminalTabId);
                            return (
                                <TerminalTabRow
                                    key={terminalTabId}
                                    terminalTabId={terminalTabId}
                                    title={row?.title}
                                    runningKind={row?.runningKind}
                                    active={terminalTabId === activeTerminalTabId}
                                    tabIndex={terminalTabId === rovingTerminalTabId ? 0 : -1}
                                    query={normalizedQuery}
                                    draggable={reorderEnabled}
                                    isDragging={draggingId === terminalTabId}
                                    onSelect={() => navigation.select(terminalTabId)}
                                    onFocus={() => {
                                        focusedSelectionIdRef.current = terminalTabId;
                                        setFocusedTerminalTabId(terminalTabId);
                                    }}
                                    onNavigate={(direction) => navigateVisibleRows(terminalTabId, direction)}
                                    onRename={(name) => navigation.rename(terminalTabId, name)}
                                    onClose={() => runMutation(() => navigation.close(terminalTabId))}
                                    onMoveUp={
                                        reorderEnabled && index > 0 ? () => moveByOffset(terminalTabId, -1) : undefined
                                    }
                                    onMoveDown={
                                        reorderEnabled && index < orderedIds.length - 1
                                            ? () => moveByOffset(terminalTabId, 1)
                                            : undefined
                                    }
                                    onMatchChange={reportMatch}
                                    onDragStart={(event) => {
                                        if (!reorderEnabled) {
                                            event.preventDefault();
                                            return;
                                        }
                                        event.dataTransfer.effectAllowed = "move";
                                        event.dataTransfer.setData(TerminalDragDataType, terminalTabId);
                                        setDraggingId(terminalTabId);
                                    }}
                                    onDragOver={(event) => {
                                        if (!reorderEnabled) return;
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "move";
                                        autoScroll(event.clientY);
                                    }}
                                    onDrop={(event) => {
                                        if (!reorderEnabled) return;
                                        event.preventDefault();
                                        const sourceId = event.dataTransfer.getData(TerminalDragDataType);
                                        if (!orderedIds.includes(sourceId)) return;
                                        commitReorder(reorderTerminalTabIds(orderedIds, sourceId, terminalTabId));
                                        setDraggingId("");
                                    }}
                                    onDragEnd={() => setDraggingId("")}
                                    selectionRef={(node) => {
                                        if (node) {
                                            selectionRefs.current.set(terminalTabId, node);
                                            return;
                                        }
                                        selectionRefs.current.delete(terminalTabId);
                                    }}
                                />
                            );
                        })}
                    </div>
                    {noMatches ? (
                        <div
                            role="status"
                            aria-live="polite"
                            className="flex min-h-24 items-center justify-center px-4 text-center text-sm text-secondary"
                        >
                            No matching terminals
                        </div>
                    ) : null}
                </div>
            )}
        </section>
    );
}
