// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { COMMAND_INLINE_FRAME_CLASSNAME, CommandInlineFrame } from "@/app/view/cmdblock/command-inline-frame";
import { cn } from "@/util/util";
import { ChevronRight, Search } from "lucide-react";
import type { RefObject } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentSelectorRequest } from "./agent-chat-host";

type AgentSelectorRequestType = AgentSelectorRequest["type"];

export interface AgentSelectorEntryView {
    id: string;
    parentId?: string;
    type?: string;
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
const TREE_SEARCH_FONT_PX = 12;
const TREE_ROW_FONT_PX = 12;
const TREE_ROW_LINE_HEIGHT_PX = 22;
const TREE_INDENT_PX = 16;
const TREE_MARKER_PX = 22;
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
    if (type === "resume") return "Resumed session.";
    return "Forked session.";
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
        return sanitizeTreeEntries(
            result.entries.map((entry) => ({
                id: entry.id,
                parentId: entry.parentId,
                type: entry.type,
                role: entry.role,
                label: entry.label,
                preview: entry.preview,
                timestamp: entry.timestamp,
                isLeaf: entry.isLeaf,
                isCurrent: entry.isCurrent,
            }))
        );
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

const VISIBLE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary", "compaction"]);

function isDisplayableEntry(entry: AgentSelectorEntryView): boolean {
    if (entry.role === "tool" || entry.role === "toolResult") {
        return false;
    }
    if (entry.role === "assistant" && (!entry.preview || entry.preview.length === 0)) {
        return false;
    }
    if (entry.role === "user" || entry.role === "assistant") {
        return true;
    }
    if (entry.type && VISIBLE_ENTRY_TYPES.has(entry.type)) return true;
    if (entry.label && entry.preview && entry.preview !== entry.type) return true;
    return false;
}

function sanitizeTreeEntries(raw: AgentSelectorEntryView[]): AgentSelectorEntryView[] {
    const hidden = new Set<string>();
    for (const e of raw) {
        if (!isDisplayableEntry(e)) hidden.add(e.id);
    }
    if (hidden.size === 0) return raw;
    const byId = new Map(raw.map((e) => [e.id, e]));
    const reparent = (parentId: string | undefined): string | undefined => {
        let cur = parentId;
        let guard = 0;
        while (cur && hidden.has(cur) && guard < raw.length) {
            cur = byId.get(cur)?.parentId;
            guard++;
        }
        return cur;
    };
    return raw
        .filter((e) => !hidden.has(e.id))
        .map((e) => {
            const newParent = reparent(e.parentId);
            if (newParent === e.parentId) return e;
            return { ...e, parentId: newParent };
        });
}

// =========================================================================
// Tree computation helpers — ported from Pi's tree-selector.ts
// =========================================================================
//
// Pi session tree is a linked list (each message's parentId = previous msg).
// A "fork point" is any node that has ≥2 children (multiple branches).
// Linear chains (single child) are rendered at the SAME visual depth as the
// parent — only actual forks introduce indentation.
//
// Indentation rules (from Pi):
// - Single-child chain: child stays at same indent as parent (flat)
// - Fork point (≥2 children): children get indent+1
// - First generation after a fork: also indent+1 for visual grouping
// - Gutters array tracks vertical guide lines at each ancestor branch position

interface GutterInfo {
    position: number;
    show: boolean;
}

interface TreeLayoutEntry {
    /** Display indent level (number of indent cells before the marker) */
    displayIndent: number;
    /** True if this node is a direct child of a fork point (shows ├─ or └─) */
    showConnector: boolean;
    /** If showConnector: true = └─ (last sibling), false = ├─ (not last) */
    isLast: boolean;
    /** Gutter positions and whether to draw vertical guides */
    gutters: GutterInfo[];
}

interface TreeLayout {
    byId: Map<string, AgentSelectorEntryView>;
    /** Per-node layout keyed by entry id */
    layoutOf: Map<string, TreeLayoutEntry>;
    /** Node IDs in DFS display order (only includes visible nodes) */
    orderedIds: string[];
    /** Whether any node has children (for chevron display) */
    hasChildren: Map<string, boolean>;
    /** Whether a node is a foldable branch point (root or child of multi-child parent) */
    isFoldable: Map<string, boolean>;
    /** IDs on the active path (from root to current leaf) */
    activePathIds: Set<string>;
}

/**
 * Compute tree layout following Pi's algorithm.
 * Handles filtering (search + collapsed state) and recomputes visual structure
 * on the visible tree, so single-child chains stay flat even after filtering.
 */
function computeTreeLayout(
    entries: AgentSelectorEntryView[],
    collapsed: Set<string>,
    query: string,
    currentLeafId: string | undefined
): TreeLayout {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const childrenOf = new Map<string | undefined, AgentSelectorEntryView[]>();
    for (const e of entries) {
        const key = e.parentId ?? undefined;
        if (!childrenOf.has(key)) childrenOf.set(key, []);
        childrenOf.get(key)!.push(e);
    }

    // Determine which entries pass the type/filter check
    const q = query.trim().toLowerCase();
    const matches = (e: AgentSelectorEntryView): boolean => {
        if (!q) return true;
        const hay = (e.role + " " + (e.label ?? "") + " " + e.preview + " " + (e.type ?? "")).toLowerCase();
        return hay.includes(q);
    };

    // Determine visibility:
    // - Search filter: matching entries + all ancestors
    // - Collapsed: descendants of collapsed nodes are hidden
    const searchMatched = new Set<string>();
    if (q) {
        for (const e of entries) {
            if (matches(e)) searchMatched.add(e.id);
        }
    }

    // Build a set of all ancestor IDs for search-matched nodes
    const searchVisibleWithAncestors = new Set<string>();
    if (q) {
        for (const id of searchMatched) {
            let cur: string | undefined = id;
            while (cur) {
                searchVisibleWithAncestors.add(cur);
                cur = byId.get(cur)?.parentId;
            }
        }
    }

    // Walk full tree to determine visible nodes (respecting collapsed + search)
    const visibleIds: string[] = [];
    const isVisible = (id: string): boolean => {
        if (q && !searchVisibleWithAncestors.has(id)) return false;
        return true;
    };

    const collectVisible = (parentId: string | undefined) => {
        const kids = childrenOf.get(parentId) ?? [];
        for (const child of kids) {
            if (isVisible(child.id)) {
                visibleIds.push(child.id);
                if (!collapsed.has(child.id)) {
                    collectVisible(child.id);
                }
            } else {
                // Skip this node but check children (if parent is collapsed, skip whole subtree)
                if (!collapsed.has(child.id)) {
                    collectVisible(child.id);
                }
            }
        }
    };
    collectVisible(undefined);

    const visibleSet = new Set(visibleIds);

    // Build "visible tree": for each visible node, find nearest visible ancestor
    const visibleParent = new Map<string, string | null>();
    const visibleChildren = new Map<string | null, string[]>();
    visibleChildren.set(null, []);

    const findVisibleAncestor = (nodeId: string): string | null => {
        let cur = byId.get(nodeId)?.parentId ?? null;
        while (cur !== null && cur !== undefined) {
            if (visibleSet.has(cur)) return cur;
            cur = byId.get(cur)?.parentId ?? null;
        }
        return null;
    };

    for (const id of visibleIds) {
        const ancestor = findVisibleAncestor(id);
        visibleParent.set(id, ancestor);
        if (!visibleChildren.has(ancestor)) visibleChildren.set(ancestor, []);
        visibleChildren.get(ancestor)!.push(id);
    }

    // Sort visible children: branch containing current (isCurrent) leaf first, preserving original order
    const containsCurrentCache = new Map<string, boolean>();
    const containsCurrent = (nodeId: string | null): boolean => {
        if (nodeId === null) return visibleIds.some((id) => byId.get(id)?.isCurrent);
        if (containsCurrentCache.has(nodeId)) return containsCurrentCache.get(nodeId)!;
        const entry = byId.get(nodeId);
        let has = !!(entry?.isCurrent);
        const kids = visibleChildren.get(nodeId) ?? [];
        for (const cid of kids) {
            if (containsCurrent(cid)) { has = true; break; }
        }
        containsCurrentCache.set(nodeId, has);
        return has;
    };

    const sortChildren = (kids: string[]): string[] => {
        const prioritized: string[] = [];
        const rest: string[] = [];
        for (const id of kids) {
            if (containsCurrent(id)) prioritized.push(id);
            else rest.push(id);
        }
        return [...prioritized, ...rest];
    };

    for (const [key, kids] of visibleChildren) {
        visibleChildren.set(key, sortChildren(kids));
    }

    // Build hasChildren (original tree, for chevron display logic)
    const hasChildren = new Map<string, boolean>();
    for (const e of entries) {
        hasChildren.set(e.id, (childrenOf.get(e.id)?.length ?? 0) > 0);
    }

    // DFS walk the VISIBLE tree using Pi's indentation rules to compute layout
    const layoutOf = new Map<string, TreeLayoutEntry>();
    const orderedIds: string[] = [];

    // Stack items: [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
    type StackItem = [string, number, boolean, boolean, boolean, GutterInfo[], boolean];
    const stack: StackItem[] = [];

    const rootIds = visibleChildren.get(null) ?? [];
    const isFoldable = new Map<string, boolean>();
    const multiRoots = rootIds.length > 1;

    for (let i = rootIds.length - 1; i >= 0; i--) {
        const isLast = i === rootIds.length - 1;
        stack.push([
            rootIds[i],
            multiRoots ? 1 : 0,
            multiRoots,
            multiRoots,
            isLast,
            [],
            multiRoots,
        ]);
    }

    while (stack.length > 0) {
        const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

        const connDisplayed = showConnector && !isVirtualRootChild;
        const currentDisplayIndent = multiRoots ? Math.max(0, indent - 1) : indent;

        orderedIds.push(nodeId);
        layoutOf.set(nodeId, { displayIndent: currentDisplayIndent, showConnector: connDisplayed, isLast, gutters: [...gutters] });

        const kids = visibleChildren.get(nodeId) ?? [];
        const multipleChildren = kids.length > 1;

        const vParent = visibleParent.get(nodeId) ?? null;
        const canFold = kids.length > 0 && (vParent === null || (visibleChildren.get(vParent)?.length ?? 0) > 1);
        isFoldable.set(nodeId, canFold);

        let childIndent: number;
        if (multipleChildren) {
            childIndent = indent + 1;
        } else if (justBranched && indent > 0) {
            childIndent = indent + 1;
        } else {
            childIndent = indent;
        }

        const connectorPosition = Math.max(0, currentDisplayIndent - 1);
        const childGutters: GutterInfo[] = connDisplayed
            ? [...gutters, { position: connectorPosition, show: !isLast }]
            : gutters;

        for (let i = kids.length - 1; i >= 0; i--) {
            const childIsLast = i === kids.length - 1;
            stack.push([
                kids[i],
                childIndent,
                multipleChildren,
                multipleChildren,
                childIsLast,
                childGutters,
                false,
            ]);
        }
    }

    // Build active path (from root to current leaf)
    const activePathIds = new Set<string>();
    if (currentLeafId && byId.has(currentLeafId)) {
        let cur: string | undefined = currentLeafId;
        while (cur) {
            activePathIds.add(cur);
            cur = byId.get(cur)?.parentId;
        }
    }

    return { byId, layoutOf, orderedIds, hasChildren, isFoldable, activePathIds };
}

// =========================================================================
// Main component
// =========================================================================

export const AgentSelectorPopover = memo(
    ({ request, onClose, onUserMessage, onEditorText }: AgentSelectorPopoverProps) => {
        const [state, setState] = useState<AgentSelectorViewState>({ status: "idle", entries: [] });
        const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
        const panelRef = useRef<HTMLDivElement>(null);
        const searchInputRef = useRef<HTMLInputElement>(null);
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
                style={{ fontSize: "11px" }}
                onClick={handleCancel}
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
                    searchInputRef={searchInputRef}
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

// =========================================================================
// AgentSelectorPanel
// =========================================================================

export interface AgentSelectorPanelProps {
    panelRef?: RefObject<HTMLDivElement | null>;
    searchInputRef?: RefObject<HTMLInputElement | null>;
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
        searchInputRef,
        requestType,
        state,
        busyEntryId,
        listMaxHeight = COMMAND_SELECTOR_LIST_MAX_HEIGHT_PX,
        onPick,
        onCancel,
    }: AgentSelectorPanelProps) => {
        const [activeIdx, setActiveIdx] = useState(0);
        const [query, setQuery] = useState("");
        const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
        const listInnerRef = useRef<HTMLDivElement>(null);
        const listRef = useRef<HTMLDivElement>(null);

        const isTree = requestType === "tree";
        const currentLeafId = useMemo(
            () => state.entries.find((e) => e.isCurrent)?.id,
            [state.entries]
        );

        const treeLayout = useMemo(() => {
            if (!isTree) return null;
            return computeTreeLayout(state.entries, collapsed, query, currentLeafId);
        }, [isTree, state.entries, collapsed, query, currentLeafId]);

        const visibleIds = treeLayout ? treeLayout.orderedIds : state.entries.map((e) => e.id);
        const totalCount = state.entries.length;
        const visibleCount = visibleIds.length;
        const empty = state.status === "ready" && visibleCount === 0;

        // Reset focus and collapse when data loads
        useEffect(() => {
            if (state.status !== "ready") return;
            const initialId = getInitialAgentSelectorFocusEntryId(requestType, state.entries);
            if (initialId && treeLayout) {
                const idx = treeLayout.orderedIds.indexOf(initialId);
                setActiveIdx(idx >= 0 ? idx : 0);
            } else {
                setActiveIdx(0);
            }
            setQuery("");
        }, [requestType, state.status, state.entries]); // eslint-disable-line react-hooks/exhaustive-deps

        // When visibility changes (filter or collapse), keep activeIdx within bounds
        useEffect(() => {
            if (visibleCount === 0) {
                setActiveIdx(0);
            } else if (activeIdx >= visibleCount) {
                setActiveIdx(visibleCount - 1);
            }
        }, [visibleCount, activeIdx]);

        // Scroll active row into view
        useEffect(() => {
            if (visibleCount === 0) return;
            const list = listInnerRef.current;
            if (!list) return;
            const row = list.querySelector<HTMLElement>(`[data-agent-row-idx="${activeIdx}"]`);
            row?.scrollIntoView({ block: "nearest" });
        }, [activeIdx, visibleCount]);

        const toggleCollapsed = useCallback((id: string) => {
            setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(id)) {
                    next.delete(id);
                } else {
                    next.add(id);
                }
                return next;
            });
        }, []);

        const handleKeyDown = useCallback(
            (e: React.KeyboardEvent) => {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (visibleCount === 0) return;
                    setActiveIdx((prev) => (prev + 1) % visibleCount);
                    return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    if (visibleCount === 0) return;
                    setActiveIdx((prev) => (prev - 1 + visibleCount) % visibleCount);
                    return;
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    const entryId = visibleIds[activeIdx];
                    const entry = entryId ? state.entries.find((en) => en.id === entryId) : undefined;
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
                // Tree-specific keys
                if (isTree && treeLayout) {
                    const entryId = visibleIds[activeIdx];
                    const entry = entryId ? treeLayout.byId.get(entryId) : undefined;
                    const hasKids = entry ? treeLayout.hasChildren.get(entry.id) ?? false : false;
                    const isFoldableNode = entry ? treeLayout.isFoldable.get(entry.id) ?? false : false;
                    if (e.key === "ArrowRight") {
                        e.preventDefault();
                        if (entry && hasKids && isFoldableNode) {
                            setCollapsed((prev) => {
                                const next = new Set(prev);
                                next.delete(entry.id);
                                return next;
                            });
                        }
                        return;
                    }
                    if (e.key === "ArrowLeft") {
                        e.preventDefault();
                        if (entry && hasKids && isFoldableNode && !collapsed.has(entry.id)) {
                            setCollapsed((prev) => {
                                const next = new Set(prev);
                                next.add(entry.id);
                                return next;
                            });
                        } else if (entry && entry.parentId) {
                            const parentIdx = visibleIds.indexOf(entry.parentId);
                            if (parentIdx >= 0) setActiveIdx(parentIdx);
                        }
                        return;
                    }
                }
                if (e.key === "/" && isTree && searchInputRef?.current && document.activeElement !== searchInputRef.current) {
                    e.preventDefault();
                    searchInputRef.current.focus();
                    searchInputRef.current.select();
                }
            },
            [visibleCount, visibleIds, state.entries, activeIdx, busyEntryId, onPick, onCancel, isTree, treeLayout, collapsed, searchInputRef]
        );

        const handleSearchKeyDown = useCallback(
            (e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    listRef.current?.focus();
                    if (visibleCount > 0) setActiveIdx(0);
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    if (query) {
                        setQuery("");
                    } else {
                        listRef.current?.focus();
                    }
                    return;
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    const entryId = visibleIds[activeIdx];
                    const entry = entryId ? state.entries.find((en) => en.id === entryId) : undefined;
                    if (entry && busyEntryId == null) {
                        onPick(entry.id);
                    }
                    return;
                }
            },
            [visibleCount, visibleIds, activeIdx, state.entries, busyEntryId, onPick, query]
        );

        const handleRowClick = useCallback(
            (entryId: string) => {
                if (busyEntryId != null) return;
                const idx = visibleIds.indexOf(entryId);
                if (idx >= 0) setActiveIdx(idx);
                onPick(entryId);
            },
            [busyEntryId, onPick, visibleIds]
        );

        const handleChevronClick = useCallback(
            (e: React.MouseEvent, entryId: string) => {
                e.stopPropagation();
                toggleCollapsed(entryId);
            },
            [toggleCollapsed]
        );

        return (
            <div
                ref={panelRef}
                tabIndex={-1}
                role="listbox"
                aria-label={getAgentSelectorTitle(requestType)}
                onKeyDown={handleKeyDown}
                className="font-mono text-foreground outline-none focus:outline-none"
                style={{ fontSize: `${TREE_ROW_FONT_PX}px` }}
            >
                {state.status === "loading" && <PanelMessage>Loading…</PanelMessage>}
                {state.status === "error" && <PanelMessage tone="error">{state.message}</PanelMessage>}
                {empty && state.status === "ready" && (
                    <PanelMessage>{query ? "No matches." : "No entries available for this session."}</PanelMessage>
                )}

                {isTree && state.entries.length > 0 && (
                    <TreeSearchBar
                        inputRef={searchInputRef}
                        value={query}
                        onChange={setQuery}
                        onKeyDown={handleSearchKeyDown}
                    />
                )}

                {visibleCount > 0 && (
                    <div
                        ref={listRef}
                        tabIndex={-1}
                        className="outline-none"
                        onKeyDown={handleKeyDown}
                    >
                        <TreeList
                            entries={state.entries}
                            requestType={requestType}
                            treeLayout={treeLayout}
                            visibleIds={visibleIds}
                            collapsed={collapsed}
                            activeIdx={activeIdx}
                            busyEntryId={busyEntryId}
                            listMaxHeight={listMaxHeight}
                            listInnerRef={listInnerRef}
                            onHover={setActiveIdx}
                            onRowClick={handleRowClick}
                            onChevronClick={handleChevronClick}
                        />
                    </div>
                )}

                <TreeHintFooter
                    isTree={isTree}
                    visibleCount={visibleCount}
                    totalCount={totalCount}
                    filtering={query.length > 0}
                />
            </div>
        );
    }
);
AgentSelectorPanel.displayName = "AgentSelectorPanel";

// =========================================================================
// Panel messages
// =========================================================================

function PanelMessage({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
    return (
        <div className={cn("px-3 py-4 text-center font-sans", tone === "error" ? "text-rose-300" : "text-secondary/75")}>
            {children}
        </div>
    );
}

// =========================================================================
// Search bar (for /tree)
// =========================================================================

interface TreeSearchBarProps {
    inputRef?: RefObject<HTMLInputElement | null>;
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

const TreeSearchBar = memo(({ inputRef, value, onChange, onKeyDown }: TreeSearchBarProps) => (
    <div
        className="flex cursor-text items-center gap-2 border-b border-fg-overlay-2/80 px-3 py-1.5"
        onClick={() => {
            if (document.activeElement !== inputRef?.current) {
                inputRef?.current?.focus();
            }
        }}
    >
        <Search size={13} className="shrink-0 text-secondary/50" />
        <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="filter messages…"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent font-mono text-foreground outline-none placeholder:text-secondary/45"
            style={{ fontSize: `${TREE_SEARCH_FONT_PX}px`, lineHeight: "18px" }}
        />
        {!value && (
            <kbd className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1 font-sans text-secondary/60" style={{ fontSize: "10px" }}>
                /
            </kbd>
        )}
    </div>
));
TreeSearchBar.displayName = "TreeSearchBar";

// =========================================================================
// Hint footer (with count)
// =========================================================================

interface TreeHintFooterProps {
    isTree: boolean;
    visibleCount: number;
    totalCount: number;
    filtering: boolean;
}

const TreeHintFooter = memo(({ isTree, visibleCount, totalCount, filtering }: TreeHintFooterProps) => (
    <div
        className="flex items-center gap-x-3 border-t border-fg-overlay-2 bg-fg-overlay-1/60 px-3 py-1.5 font-sans text-secondary/65"
        style={{ fontSize: `${SELECTOR_FOOTER_FONT_PX}px` }}
    >
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">↑</kbd>
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">↓</kbd>
            <span>navigate</span>
        </span>
        {isTree && (
            <span className="inline-flex items-center gap-1.5">
                <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">←</kbd>
                <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">→</kbd>
                <span>fold</span>
            </span>
        )}
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">↵</kbd>
            <span>select</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1.5">esc</kbd>
            <span>dismiss</span>
        </span>
        <span className="ml-auto font-mono tabular-nums text-secondary/50">
            ({visibleCount}/{totalCount})
        </span>
    </div>
));
TreeHintFooter.displayName = "TreeHintFooter";

// =========================================================================
// TreeList — renders rows with proper tree DOM (indent cells + markers)
// =========================================================================

interface TreeListProps {
    entries: AgentSelectorEntryView[];
    requestType: AgentSelectorRequestType;
    treeLayout: TreeLayout | null;
    visibleIds: string[];
    collapsed: Set<string>;
    activeIdx: number;
    busyEntryId: string | null;
    listMaxHeight: number;
    listInnerRef: RefObject<HTMLDivElement | null>;
    onHover: (idx: number) => void;
    onRowClick: (id: string) => void;
    onChevronClick: (e: React.MouseEvent, id: string) => void;
}

const TreeList = memo(function TreeList({
    entries,
    requestType,
    treeLayout,
    visibleIds,
    collapsed,
    activeIdx,
    busyEntryId,
    listMaxHeight,
    listInnerRef,
    onHover,
    onRowClick,
    onChevronClick,
}: TreeListProps) {
    const isTree = requestType === "tree";
    const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

    return (
        <div
            ref={listInnerRef}
            className="tree-list-root overflow-y-auto"
            style={{
                maxHeight: `${listMaxHeight}px`,
                padding: "4px 0",
                lineHeight: `${TREE_ROW_LINE_HEIGHT_PX}px`,
            }}
        >
            <style>{TreeListStyles}</style>
            {visibleIds.map((entryId, idx) => {
                const entry = byId.get(entryId);
                if (!entry) return null;
                const isActive = idx === activeIdx;
                const isBusy = busyEntryId === entry.id;
                const isCurrent = !!entry.isCurrent;

                if (isTree && treeLayout) {
                    return (
                        <TreeRow
                            key={entry.id}
                            entry={entry}
                            idx={idx}
                            layout={treeLayout}
                            collapsed={collapsed}
                            isActive={isActive}
                            isBusy={isBusy}
                            isCurrent={isCurrent}
                            onHover={onHover}
                            onRowClick={onRowClick}
                            onChevronClick={onChevronClick}
                        />
                    );
                }

                return (
                    <FlatRow
                        key={entry.id}
                        entry={entry}
                        idx={idx}
                        isActive={isActive}
                        isBusy={isBusy}
                        onHover={onHover}
                        onRowClick={onRowClick}
                    />
                );
            })}
        </div>
    );
});

// =========================================================================
// TreeRow — single tree node with indent cells and marker (Pi-aligned)
// =========================================================================

type IndentKind = "none" | "guide" | "branch" | "corner";

interface TreeRowProps {
    entry: AgentSelectorEntryView;
    idx: number;
    layout: TreeLayout;
    collapsed: Set<string>;
    isActive: boolean;
    isBusy: boolean;
    isCurrent: boolean;
    onHover: (idx: number) => void;
    onRowClick: (id: string) => void;
    onChevronClick: (e: React.MouseEvent, id: string) => void;
}

const TreeRow = memo(function TreeRow({
    entry,
    idx,
    layout,
    collapsed,
    isActive,
    isBusy,
    isCurrent,
    onHover,
    onRowClick,
    onChevronClick,
}: TreeRowProps) {
    const nodeLayout = layout.layoutOf.get(entry.id);
    const displayIndent = nodeLayout?.displayIndent ?? 0;
    const showConnector = nodeLayout?.showConnector ?? false;
    const isLast = nodeLayout?.isLast ?? true;
    const gutters = nodeLayout?.gutters ?? [];
    const hasChildren = layout.hasChildren.get(entry.id) ?? false;
    const isFoldableNode = layout.isFoldable.get(entry.id) ?? false;
    const isNodeCollapsed = collapsed.has(entry.id);

    // Build indent cells per Pi's algorithm:
    // - displayIndent cells total
    // - For cells 0..displayIndent-2: gutter guides (│ or space)
    // - For cell displayIndent-1: connector (├ or └) if showConnector, else continue gutter/none
    const indents: IndentKind[] = [];
    const connectorPosition = showConnector ? displayIndent - 1 : -1;

    for (let level = 0; level < displayIndent; level++) {
        const gutter = gutters.find((g) => g.position === level);
        if (gutter) {
            indents.push(gutter.show ? "guide" : "none");
        } else if (level === connectorPosition) {
            indents.push(isLast ? "corner" : "branch");
        } else {
            indents.push("none");
        }
    }

    const roleClass =
        entry.role === "user"
            ? "role-user"
            : entry.role === "assistant"
              ? "role-assistant"
              : entry.role === "tool"
                ? "role-tool"
                : entry.role === "toolResult"
                  ? "role-toolresult"
                  : "role-default";

    const isToolEntry = entry.role === "tool" || entry.role === "toolResult";

    return (
        <div
            data-agent-row-idx={idx}
            data-agent-entry-id={entry.id}
            data-agent-selector-row={entry.id}
            data-agent-selector-active={isActive ? "true" : undefined}
            data-agent-selector-current={isCurrent ? "true" : undefined}
            aria-disabled={isBusy || undefined}
            className={cn(
                "tree-row group flex cursor-pointer select-none items-center pr-2",
                isActive && "tree-row-active",
                isCurrent && "tree-row-current",
                isBusy && "pointer-events-none opacity-60"
            )}
            onMouseEnter={() => onHover(idx)}
            onClick={() => onRowClick(entry.id)}
        >
            {isCurrent && <div className="tree-current-bar" />}
            {indents.map((kind, i) => {
                const isOnPath = layout.activePathIds.has(entry.id);
                return (
                    <div
                        key={i}
                        className={cn(
                            "tree-indent",
                            kind === "guide" && "tree-indent-guide",
                            kind === "branch" && "tree-indent-branch",
                            kind === "corner" && "tree-indent-corner",
                            isOnPath && (kind === "guide" || kind === "branch" || kind === "corner") && "tree-indent-active"
                        )}
                    />
                );
            })}
            <div className="tree-marker">
                {isFoldableNode && hasChildren ? (
                    <button
                        type="button"
                        className="tree-chevron tree-chevron-visible"
                        onClick={(e) => onChevronClick(e, entry.id)}
                        tabIndex={-1}
                    >
                        <ChevronRight
                            size={12}
                            strokeWidth={2.5}
                            className={cn("tree-chevron-icon", !isNodeCollapsed && "tree-chevron-expanded")}
                        />
                    </button>
                ) : (
                    <span className="tree-chevron tree-chevron-hidden">
                        <ChevronRight size={12} strokeWidth={2.5} className="tree-chevron-icon" />
                    </span>
                )}
                <div className={cn("tree-diamond", `tree-diamond-${entry.role ?? "default"}`)} />
            </div>
            <div className="tree-content">
                {isToolEntry ? (
                    <span className="tree-toolcall">
                        <span className="tree-tool-bracket">[</span>
                        {entry.label ? (
                            <>
                                <span className="tree-tool-name">{entry.label}</span>
                                {entry.preview && (
                                    <>
                                        <span className="tree-tool-sep">: </span>
                                        <span className="tree-tool-cmd">{truncate(entry.preview, 80)}</span>
                                    </>
                                )}
                            </>
                        ) : (
                            <span className="tree-tool-cmd">{truncate(entry.preview, 80)}</span>
                        )}
                        <span className="tree-tool-bracket">]</span>
                    </span>
                ) : entry.label ? (
                    <span className="tree-label-entry">
                        <span className="tree-label">{entry.label}</span>
                        {entry.preview && <span className="tree-label-preview"> — {truncate(entry.preview, 60)}</span>}
                    </span>
                ) : (
                    <>
                        <span className={cn("tree-role", roleClass)}>
                            {entry.role ?? "entry"}
                            <span className="tree-role-colon">:</span>
                        </span>
                        <span className="tree-msg">{truncate(entry.preview || entry.type || "", 80)}</span>
                    </>
                )}
                {isCurrent && <span className="tree-streaming"><span /><span /><span /></span>}
                {isBusy && <span className="tree-busy">…</span>}
            </div>
        </div>
    );
});

// =========================================================================
// FlatRow — simple row for non-tree (resume/fork) selectors
// =========================================================================

interface FlatRowProps {
    entry: AgentSelectorEntryView;
    idx: number;
    isActive: boolean;
    isBusy: boolean;
    onHover: (idx: number) => void;
    onRowClick: (id: string) => void;
}

const FlatRow = memo(function FlatRow({ entry, idx, isActive, isBusy, onHover, onRowClick }: FlatRowProps) {
    const roleColor =
        entry.role === "user"
            ? "text-blue-300"
            : entry.role === "assistant"
              ? "text-green-300"
              : entry.role === "tool" || entry.role === "toolResult"
                ? "text-yellow-300"
                : entry.role === "session"
                  ? "text-purple-300"
                  : "";
    const label = entry.label
        ? entry.label
        : entry.preview && entry.preview.length > 0
          ? entry.preview
          : entry.type ?? "";
    return (
        <div
            data-agent-row-idx={idx}
            data-agent-selector-row={entry.id}
            data-agent-selector-active={isActive ? "true" : undefined}
            aria-disabled={isBusy || undefined}
            className={cn(
                "flex cursor-pointer select-none items-center px-3",
                isActive ? "bg-fg-overlay-2/70 text-foreground" : "text-secondary/85 hover:bg-fg-overlay-1",
                isBusy && "pointer-events-none opacity-60"
            )}
            style={{ height: `${TREE_ROW_LINE_HEIGHT_PX}px` }}
            onMouseEnter={() => onHover(idx)}
            onClick={() => onRowClick(entry.id)}
        >
            <div className="tree-marker" style={{ position: "relative" }}>
                <div className={cn("tree-diamond", `tree-diamond-${entry.role ?? "default"}`)} />
            </div>
            <div className="min-w-0 flex-1" style={{ paddingLeft: "4px" }}>
                {entry.label ? (
                    <span className="block min-w-0 truncate">
                        <span className="font-semibold text-foreground">{entry.label}</span>
                        <span className="text-secondary/50"> — {entry.preview}</span>
                    </span>
                ) : (
                    <span className={cn("block min-w-0 truncate", isActive ? "text-foreground" : roleColor)}>
                        {label}
                    </span>
                )}
            </div>
            {isBusy && <span className="shrink-0 pl-2 text-secondary/60">Working…</span>}
        </div>
    );
});

// =========================================================================
// Utilities
// =========================================================================

function truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1) + "…";
}

// =========================================================================
// CSS for tree rows (pseudo-elements for guide lines, diamonds, etc.)
// =========================================================================

const TreeListStyles = `
.tree-list-root {
    font-family: var(--mono-font, "SF Mono", "JetBrains Mono", "IBM Plex Mono", Menlo, Consolas, monospace);
    font-size: ${TREE_ROW_FONT_PX}px;
    color: var(--foreground, #e2e8f0);
}

.tree-row {
    height: ${TREE_ROW_LINE_HEIGHT_PX}px;
    position: relative;
    color: rgba(226, 232, 240, 0.75);
    transition: background-color 80ms ease;
}
.tree-row:hover {
    background: rgba(255, 255, 255, 0.04);
}
.tree-row-active {
    background: rgba(92, 184, 232, 0.08) !important;
    color: #e2e8f0;
}
.tree-row-current {
    background: rgba(92, 184, 232, 0.12);
    color: #e2e8f0;
}
.tree-row-active.tree-row-current {
    background: rgba(92, 184, 232, 0.18);
    box-shadow: inset 0 0 0 1px rgba(92, 184, 232, 0.2), 0 0 8px rgba(92, 184, 232, 0.1);
}

.tree-current-bar {
    position: absolute;
    left: 0;
    top: 3px;
    bottom: 3px;
    width: 2px;
    background: #5cb8e8;
    border-radius: 1px;
    box-shadow: 0 0 6px rgba(92, 184, 232, 0.6);
}

.tree-indent {
    flex-shrink: 0;
    width: ${TREE_INDENT_PX}px;
    height: ${TREE_ROW_LINE_HEIGHT_PX}px;
    position: relative;
}
.tree-indent-guide::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    background: rgba(255, 255, 255, 0.07);
    transform: translateX(-0.5px);
}
.tree-indent-branch::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    background: rgba(255, 255, 255, 0.07);
    transform: translateX(-0.5px);
}
.tree-indent-branch::before {
    content: "";
    position: absolute;
    top: calc(50% - 0.5px);
    left: 50%;
    width: 50%;
    height: 1px;
    background: rgba(255, 255, 255, 0.07);
}
.tree-indent-active::after {
    background: rgba(92, 184, 232, 0.25);
}
.tree-indent-active::before {
    background: rgba(92, 184, 232, 0.3);
}
.tree-indent-corner::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 50%;
    left: 50%;
    width: 1px;
    background: rgba(255, 255, 255, 0.07);
    transform: translateX(-0.5px);
}
.tree-indent-corner::before {
    content: "";
    position: absolute;
    top: calc(50% - 0.5px);
    left: 50%;
    width: 50%;
    height: 1px;
    background: rgba(255, 255, 255, 0.07);
}

.tree-marker {
    flex-shrink: 0;
    width: ${TREE_MARKER_PX}px;
    height: ${TREE_ROW_LINE_HEIGHT_PX}px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding-left: 2px;
}

.tree-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: rgba(148, 163, 184, 0.5);
    cursor: pointer;
    border-radius: 2px;
}
.tree-chevron-visible {
    opacity: 1;
}
.tree-chevron-hidden {
    opacity: 0;
    pointer-events: none;
}
.tree-row:hover .tree-chevron-hidden {
    opacity: 0.4;
}
.tree-chevron:hover {
    background: rgba(255, 255, 255, 0.06);
    color: rgba(226, 232, 240, 0.85);
}
.tree-row-active .tree-chevron {
    color: rgba(125, 211, 252, 0.8);
}
.tree-chevron-icon {
    transition: transform 120ms ease;
}
.tree-chevron-expanded {
    transform: rotate(90deg);
}

.tree-diamond {
    width: 6px;
    height: 6px;
    transform: rotate(45deg);
    border-radius: 1px;
    flex-shrink: 0;
}
.tree-diamond-user {
    background: #7eb8e8;
    box-shadow: 0 0 0 1.5px rgba(126, 184, 232, 0.2);
}
.tree-diamond-assistant {
    background: #7dd3a8;
    box-shadow: 0 0 0 1.5px rgba(125, 211, 168, 0.2);
}
.tree-diamond-tool {
    background: #e8c468;
    box-shadow: 0 0 0 1.5px rgba(232, 196, 104, 0.2);
}
.tree-diamond-toolresult {
    background: #c4a0e8;
    box-shadow: 0 0 0 1.5px rgba(196, 160, 232, 0.2);
}
.tree-diamond-session {
    background: #c4a0e8;
    box-shadow: 0 0 0 1.5px rgba(196, 160, 232, 0.2);
}
.tree-diamond-default {
    background: rgba(148, 163, 184, 0.6);
    box-shadow: 0 0 0 1.5px rgba(148, 163, 184, 0.15);
}
.tree-row-active .tree-diamond-user { box-shadow: 0 0 0 1.5px rgba(126, 184, 232, 0.35), 0 0 6px rgba(126, 184, 232, 0.4); }
.tree-row-active .tree-diamond-assistant { box-shadow: 0 0 0 1.5px rgba(125, 211, 168, 0.35), 0 0 6px rgba(125, 211, 168, 0.4); }
.tree-row-active .tree-diamond-tool { box-shadow: 0 0 0 1.5px rgba(232, 196, 104, 0.35), 0 0 6px rgba(232, 196, 104, 0.4); }

.tree-content {
    flex: 1;
    min-width: 0;
    padding-left: 4px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    gap: 0;
}

.tree-role {
    flex-shrink: 0;
    font-weight: 500;
}
.tree-role-colon {
    color: rgba(148, 163, 184, 0.5);
    margin-right: 4px;
}
.role-user { color: #7eb8e8; }
.role-assistant { color: #7dd3a8; }
.role-tool { color: #e8c468; }
.role-toolresult { color: #c4a0e8; }
.role-default { color: rgba(148, 163, 184, 0.75); }

.tree-msg {
    color: rgba(226, 232, 240, 0.8);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
.tree-row-active .tree-msg { color: #f1f5f9; }
.tree-row-current .tree-msg { color: #f1f5f9; }

.tree-toolcall {
    color: #e8c468;
}
.tree-tool-bracket {
    color: rgba(232, 196, 104, 0.5);
}
.tree-tool-name {
    color: #e8c468;
    font-weight: 500;
}
.tree-tool-sep {
    color: rgba(232, 196, 104, 0.5);
}
.tree-tool-cmd {
    color: rgba(232, 196, 104, 0.85);
}

.tree-label-entry {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
.tree-label {
    font-weight: 600;
    color: #e2e8f0;
}
.tree-label-preview {
    color: rgba(148, 163, 184, 0.5);
}

.tree-streaming {
    display: inline-flex;
    gap: 2px;
    margin-left: 6px;
    align-items: center;
    flex-shrink: 0;
}
.tree-streaming span {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: #5cb8e8;
    animation: tree-stream-pulse 1.2s ease-in-out infinite;
}
.tree-streaming span:nth-child(2) { animation-delay: 0.15s; }
.tree-streaming span:nth-child(3) { animation-delay: 0.3s; }
@keyframes tree-stream-pulse {
    0%, 100% { opacity: 0.25; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1); }
}

.tree-busy {
    flex-shrink: 0;
    padding-left: 6px;
    color: rgba(148, 163, 184, 0.6);
}

.tree-content code {
    font-family: inherit;
    background: rgba(255, 255, 255, 0.06);
    padding: 0 3px;
    border-radius: 2px;
    font-size: 0.95em;
    color: rgba(226, 232, 240, 0.9);
}
`;
