// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSelectorRequest } from "@/app/agent/agent-chat-host";
import { COMMAND_INLINE_FRAME_CLASSNAME, CommandInlineFrame } from "@/app/view/cmdblock/command-inline-frame";
import {
    COMMAND_SELECTOR_LIST_MAX_HEIGHT_PX,
    COMMAND_SELECTOR_LIST_MAX_RESIZE_HEIGHT_PX,
    COMMAND_SELECTOR_LIST_MIN_HEIGHT_PX,
    COMMAND_SELECTOR_ROW_FONT_PX,
    COMMAND_SELECTOR_SEARCH_FONT_PX,
    CommandSelectorHintFooter,
    CommandSelectorMessage,
    CommandSelectorPanel,
    CommandSelectorSearchBar,
    useCommandSelectorNavigation,
    useFocusOnReady,
    useScrollActiveRowIntoView,
    type SelectorHint,
} from "@/app/view/cmdblock/command-selector-panel";
import { cn } from "@/util/util";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { RefObject } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

type AgentSelectorRequestType = AgentSelectorRequest["type"];

export interface AgentSelectorEntryView {
    id: string;
    parentId?: string;
    type?: string;
    role?: string;
    label?: string;
    stopReason?: string;
    preview: string;
    timestamp?: string;
    isLeaf?: boolean;
    isCurrent?: boolean;
    referenceable?: boolean;
    sessionMetadata?: AgentSessionMeta;
    sessionDetail?: AgentSessionDetail;
}

export type AgentSelectorViewState =
    | { status: "idle" | "loading"; entries: AgentSelectorEntryView[] }
    | { status: "ready"; entries: AgentSelectorEntryView[] }
    | { status: "error"; entries: AgentSelectorEntryView[]; message: string };

export type SessionManagerView =
    | { type: "sessions"; action: "resume" | "reference" }
    | { type: "reference-detail"; source: AgentSessionMeta; sourceTitle: string };

interface SessionReferenceConfig {
    source: AgentSessionMeta;
    turnIds?: string[];
}

export interface SessionSelectorProps {
    anchorRef?: RefObject<HTMLElement | null>;
    request: AgentSelectorRequest | null;
    onClose: () => void;
    onUserMessage?: (message: string) => void;
    onEditorText?: (text: string) => void;
    referencesEnabled?: boolean;
}

function isAgentSelectorRequestCurrent(request: AgentSelectorRequest): boolean {
    return request.isCurrent?.() !== false;
}

export const COMMAND_SELECTOR_INLINE_CLASSNAME = COMMAND_INLINE_FRAME_CLASSNAME;

const TREE_INDENT_PX = 16;
const TREE_MARKER_PX = 22;
const TREE_ROW_LINE_HEIGHT_PX = 22;
const EmptyEntryIds: ReadonlySet<string> = new Set();

export async function commitAgentSelectorPick(
    request: AgentSelectorRequest,
    entryId: string,
    entries: AgentSelectorEntryView[] = []
): Promise<AgentNavigateTreeResult | AgentForkSessionResult> {
    if (request.type === "tree") {
        return await request.navigateTree(entryId);
    }
    if (request.type === "session") {
        const sessionMetadata = entries.find((entry) => entry.id === entryId)?.sessionMetadata;
        if (!sessionMetadata) {
            throw new Error("Selected session is no longer available.");
        }
        return await request.resumeSession(sessionMetadata);
    }
    return await request.forkSession(entryId);
}

export async function commitAgentTreeReference(
    request: Extract<AgentSelectorRequest, { type: "tree" }>,
    entryId: string,
    requestedRepresentation: AgentContextRepresentation
): Promise<void> {
    await request.prepareTurnReference(entryId, requestedRepresentation);
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
    if (type === "session") return "Session manager";
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

export function isAgentSelectorGlobalNavigationKey(key: string): boolean {
    return key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === "Escape";
}

function basenameOfPath(input: string): string {
    const normalized = input.replace(/[\\/]+$/, "");
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || normalized || "session";
}

function formatSessionTimestamp(iso: string): string {
    if (!iso) return "unknown time";
    return iso.slice(0, 16).replace("T", " ");
}

export function getResumeSessionDisplayText(session: AgentSessionDetail): string {
    const name = session.name?.trim();
    if (name) return name;
    if (session.firstMessage) return session.firstMessage;
    if (session.previewText) return session.previewText;
    return `${basenameOfPath(session.cwd)} · ${formatSessionTimestamp(session.createdAt)}`;
}

function successMessage(type: AgentSelectorRequestType): string {
    if (type === "tree") return "Navigated agent session tree.";
    if (type === "session") return "Resumed session.";
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

function normalizeReferencePoints(points: AgentReferencePointView[]): AgentSelectorEntryView[] {
    return points.map((point) => ({
        id: point.entryId,
        role: "user",
        preview: point.preview,
        timestamp: point.timestamp,
    }));
}

async function loadSelectorEntries(
    request: AgentSelectorRequest,
    scopeCwd?: string
): Promise<AgentSelectorEntryView[]> {
    if (request.type === "tree") {
        const result = await request.listTree();
        // No pre-filtering here: the backend now sends every non-structural
        // entry (incl. toolResults / bookkeeping) and the visible set is
        // decided at layout time by the active FilterMode (Pi parity).
        return result.entries.map((entry) => ({
            id: entry.id,
            parentId: entry.parentId,
            type: entry.type,
            role: entry.role,
            label: entry.label,
            stopReason: entry.stopReason,
            preview: entry.preview,
            timestamp: entry.timestamp,
            isLeaf: entry.isLeaf,
            isCurrent: entry.isCurrent,
            referenceable: entry.referenceable,
        }));
    }
    if (request.type === "session") {
        const sessions = await request.listSessions(scopeCwd ?? undefined);
        const sessionsByPath = new Map(sessions.map((s) => [s.path, s]));
        return sessions.map((session, index) => {
            const parentPath = session.parentSessionPath;
            const parentExists = parentPath ? sessionsByPath.has(parentPath) : false;
            const displayText = getResumeSessionDisplayText(session);
            return {
                id: session.path || session.id || String(index),
                parentId: parentExists ? parentPath : undefined,
                role: "session",
                label: session.name?.trim() || undefined,
                preview: displayText,
                timestamp: session.modifiedAt || session.createdAt,
                sessionMetadata: { id: session.id, createdAt: session.createdAt, cwd: session.cwd, path: session.path },
                sessionDetail: session,
            };
        });
    }
    return normalizeForkPoints(await request.listForkPoints());
}

// =========================================================================
// FilterMode — ported verbatim from Pi's tree-selector.ts applyFilter().
// =========================================================================
//
// Pi's /tree does NOT hide tool results by default — it shows them. The only
// things hidden in `default` are settings/bookkeeping entries, plus assistant
// turns that have no text (pure tool calls) unless they errored/aborted. Each
// mode narrows further:
//   - default:      hide settings/bookkeeping (toolResults STAY visible)
//   - no-tools:     default minus toolResults
//   - user-only:    only user messages
//   - labeled-only: only entries that carry a label
//   - all:          everything, including settings
export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export const FILTER_MODES: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

export const FILTER_MODE_LABEL: Record<FilterMode, string> = {
    default: "default",
    "no-tools": "no-tools",
    "user-only": "user",
    "labeled-only": "labeled",
    all: "all",
};

const SelectorControlRailClassName = "mx-3 mt-2 flex flex-wrap items-center gap-1.5 px-0.5 py-0.5 select-none";
const SelectorControlChipBaseClassName =
    "min-h-7 cursor-pointer rounded-lg px-1.5 py-0.5 font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/70";
const SessionToolbarClassName = "mx-3 mt-2 flex min-h-8 items-center justify-between gap-4 px-0.5 select-none";
const SessionToolbarGroupClassName = "flex min-w-0 items-center gap-4";
const SessionToolbarButtonBaseClassName =
    "relative inline-flex min-h-7 cursor-pointer items-center gap-1.5 border-b px-0.5 py-0.5 font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/70";

function selectorControlChipClassName(active: boolean): string {
    return cn(
        SelectorControlChipBaseClassName,
        active
            ? "bg-white/[0.07] text-cyan-300/90 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.045)]"
            : "text-secondary/45 hover:bg-white/[0.045] hover:text-secondary/80"
    );
}

function sessionToolbarButtonClassName(active: boolean): string {
    return cn(
        SessionToolbarButtonBaseClassName,
        active ? "border-cyan-300/70 text-cyan-300/90" : "border-transparent text-secondary/45 hover:text-secondary/80"
    );
}

// Settings/bookkeeping entry types hidden in the default view. `leaf`/`label`
// are already stripped by the backend, so they never reach here.
const SETTINGS_ENTRY_TYPES = new Set(["custom", "model_change", "thinking_level_change", "session_info"]);

/**
 * Whether an entry is visible under the given FilterMode. Mirrors Pi's
 * applyFilter predicate (the assistant no-text rule + the mode switch).
 */
export function isEntryVisibleForMode(
    entry: AgentSelectorEntryView,
    mode: FilterMode,
    currentLeafId: string | undefined
): boolean {
    // Session rows always show; this predicate is tree-only.
    if (entry.role === "session") return true;

    const isCurrentLeaf = entry.id === currentLeafId;

    // Hide assistant turns with only tool calls (no text) unless error/aborted.
    // Always keep the current leaf so the active position stays visible.
    if (entry.role === "assistant" && !isCurrentLeaf) {
        const hasText = !!entry.preview && entry.preview.length > 0;
        const isErrorOrAborted = !!entry.stopReason && entry.stopReason !== "stop" && entry.stopReason !== "toolUse";
        if (!hasText && !isErrorOrAborted) return false;
    }

    const isSettingsEntry = !!entry.type && SETTINGS_ENTRY_TYPES.has(entry.type);

    switch (mode) {
        case "user-only":
            return entry.role === "user";
        case "no-tools":
            return !isSettingsEntry && entry.role !== "toolResult" && entry.role !== "tool";
        case "labeled-only":
            return entry.label !== undefined;
        case "all":
            return true;
        default:
            return !isSettingsEntry;
    }
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
    currentLeafId: string | undefined,
    mode: FilterMode
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
        let hay = (e.role + " " + (e.label ?? "") + " " + e.preview + " " + (e.type ?? "")).toLowerCase();
        if (e.role === "session" && e.sessionDetail) {
            hay +=
                " " +
                (e.sessionDetail.firstMessage || "") +
                " " +
                (e.sessionDetail.previewText || "") +
                " " +
                (e.sessionDetail.cwd || "");
        }
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

    // Walk full tree to determine visible nodes (respecting collapsed + search
    // + the active FilterMode). Mode-hidden nodes are skipped here; the
    // visible-tree pass below reparents survivors to their nearest visible
    // ancestor, so single-child chains stay flat even after filtering.
    const visibleIds: string[] = [];
    const isVisible = (id: string): boolean => {
        if (q && !searchVisibleWithAncestors.has(id)) return false;
        const entry = byId.get(id);
        if (entry && !isEntryVisibleForMode(entry, mode, currentLeafId)) return false;
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
        let has = !!entry?.isCurrent;
        const kids = visibleChildren.get(nodeId) ?? [];
        for (const cid of kids) {
            if (containsCurrent(cid)) {
                has = true;
                break;
            }
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
        stack.push([rootIds[i], multiRoots ? 1 : 0, multiRoots, multiRoots, isLast, [], multiRoots]);
    }

    while (stack.length > 0) {
        const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

        const connDisplayed = showConnector && !isVirtualRootChild;
        const currentDisplayIndent = multiRoots ? Math.max(0, indent - 1) : indent;

        orderedIds.push(nodeId);
        layoutOf.set(nodeId, {
            displayIndent: currentDisplayIndent,
            showConnector: connDisplayed,
            isLast,
            gutters: [...gutters],
        });

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
            stack.push([kids[i], childIndent, multipleChildren, multipleChildren, childIsLast, childGutters, false]);
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

export const SessionSelector = memo(
    ({ anchorRef, request, onClose, onUserMessage, onEditorText, referencesEnabled = true }: SessionSelectorProps) => {
        const [state, setState] = useState<AgentSelectorViewState>({ status: "idle", entries: [] });
        const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
        const [referenceBusy, setReferenceBusy] = useState(false);
        const [announcement, setAnnouncement] = useState("");
        const panelRef = useRef<HTMLDivElement>(null);
        const searchInputRef = useRef<HTMLInputElement>(null);
        const previousFocusRef = useRef<HTMLElement | null>(null);
        const commitRequestIdRef = useRef(0);
        const detailLoadIdRef = useRef(0);
        const pickBusyRef = useRef(false);
        const closeRequestedRef = useRef(false);
        const referenceBusyRef = useRef<number | null>(null);
        const referenceOperationIdRef = useRef(0);
        const [listMaxHeight, setListMaxHeight] = useState(COMMAND_SELECTOR_LIST_MAX_HEIGHT_PX);
        const [sessionScope, setSessionScope] = useState<"cwd" | "all">("cwd");
        const [managerView, setManagerView] = useState<SessionManagerView>({
            type: "sessions",
            action: "resume",
        });
        const [detailState, setDetailState] = useState<AgentSelectorViewState>({ status: "idle", entries: [] });
        const [returnFocusEntryId, setReturnFocusEntryId] = useState<string>();
        const [referenceConfig, setReferenceConfig] = useState<SessionReferenceConfig>();
        const [configuredDeliveryScope, setConfiguredDeliveryScope] = useState<AgentContextDeliveryScope>("message");
        const [configuredRepresentation, setConfiguredRepresentation] = useState<AgentContextRepresentation>("full");
        const [referenceConfigError, setReferenceConfigError] = useState<string>();
        const [selectedTurnIds, setSelectedTurnIds] = useState<Set<string>>(new Set());
        const [addedTurnIds, setAddedTurnIds] = useState<Set<string>>(new Set());

        useEffect(() => {
            referenceBusyRef.current = null;
            pickBusyRef.current = false;
            closeRequestedRef.current = false;
            detailLoadIdRef.current++;
            setReferenceBusy(false);
            setAnnouncement("");
            if (!request) {
                commitRequestIdRef.current++;
                return;
            }
            return () => {
                commitRequestIdRef.current++;
                detailLoadIdRef.current++;
                pickBusyRef.current = false;
                referenceBusyRef.current = null;
            };
        }, [request]);

        useEffect(() => {
            if (!request) return;
            setSessionScope("cwd");
            setManagerView({ type: "sessions", action: "resume" });
            setDetailState({ status: "idle", entries: [] });
            setReturnFocusEntryId(undefined);
            setReferenceConfig(undefined);
            setConfiguredDeliveryScope("message");
            setConfiguredRepresentation("full");
            setReferenceConfigError(undefined);
            setSelectedTurnIds(new Set());
            setAddedTurnIds(new Set());
        }, [request]);

        useEffect(() => {
            if (referencesEnabled || (managerView.type === "sessions" && managerView.action === "resume")) {
                return;
            }
            setManagerView({ type: "sessions", action: "resume" });
            setDetailState({ status: "idle", entries: [] });
        }, [managerView, referencesEnabled]);

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

        // Tree/fork selectors keep focus on their listbox root. Session
        // manager options use roving DOM focus inside AgentSelectorPanel so
        // assistive technology observes the active option itself.
        useFocusOnReady(panelRef, !!request && request.type !== "session" && state.status === "ready");

        useEffect(() => {
            if (!request) {
                setState({ status: "idle", entries: [] });
                setBusyEntryId(null);
                return;
            }

            let cancelled = false;
            setState({ status: "loading", entries: [] });
            setBusyEntryId(null);
            const scopeCwd = request.type === "session" && sessionScope === "cwd" ? request.cwd : undefined;
            void loadSelectorEntries(request, scopeCwd)
                .then((entries) => {
                    if (cancelled || !isAgentSelectorRequestCurrent(request)) return;
                    setState({ status: "ready", entries });
                })
                .catch((err) => {
                    if (cancelled || !isAgentSelectorRequestCurrent(request)) return;
                    const message = err instanceof Error ? err.message : String(err);
                    setState({ status: "error", entries: [], message });
                });

            return () => {
                cancelled = true;
            };
        }, [request, sessionScope]);

        useEffect(() => {
            if (request?.type !== "session" || managerView.type !== "reference-detail") return;
            const detailLoadId = ++detailLoadIdRef.current;
            setDetailState({ status: "loading", entries: [] });
            void request
                .listReferencePoints(managerView.source)
                .then((points) => {
                    if (detailLoadId !== detailLoadIdRef.current) return;
                    setDetailState({ status: "ready", entries: normalizeReferencePoints(points) });
                })
                .catch((err) => {
                    if (detailLoadId !== detailLoadIdRef.current) return;
                    const message = err instanceof Error ? err.message : String(err);
                    setDetailState({ status: "error", entries: [], message });
                });
            return () => {
                if (detailLoadId === detailLoadIdRef.current) {
                    detailLoadIdRef.current++;
                }
            };
        }, [request, managerView]);

        const handlePick = useCallback(
            async (entryId: string) => {
                if (
                    !request ||
                    !isAgentSelectorRequestCurrent(request) ||
                    pickBusyRef.current ||
                    referenceBusyRef.current != null
                ) {
                    return;
                }
                if (request.type === "session" && managerView.type === "sessions") {
                    const sourceEntry = state.entries.find((entry) => entry.id === entryId);
                    if (!sourceEntry?.sessionMetadata) {
                        setState((prev) => ({
                            status: "error",
                            entries: prev.entries,
                            message: "Selected session is no longer available.",
                        }));
                        return;
                    }
                    if (managerView.action === "reference") {
                        if (sourceEntry.sessionMetadata.path === request.currentSessionPath) return;
                        setReturnFocusEntryId(entryId);
                        setDetailState({ status: "loading", entries: [] });
                        setSelectedTurnIds(new Set());
                        setAddedTurnIds(new Set(request.getAddedTurnIds(sourceEntry.sessionMetadata)));
                        setManagerView({
                            type: "reference-detail",
                            source: sourceEntry.sessionMetadata,
                            sourceTitle: sourceEntry.preview,
                        });
                        return;
                    }
                }
                const commitRequestId = ++commitRequestIdRef.current;
                pickBusyRef.current = true;
                setBusyEntryId(entryId);
                try {
                    const result = await commitAgentSelectorPick(request, entryId, state.entries);
                    if (
                        commitRequestId !== commitRequestIdRef.current ||
                        !isAgentSelectorRequestCurrent(request)
                    ) {
                        return;
                    }
                    const editorText = editorTextFromAgentSelectorResult(result);
                    if (editorText != null) {
                        onEditorText?.(editorText);
                    }
                    onUserMessage?.(successMessage(request.type));
                    onClose();
                } catch (err) {
                    if (
                        commitRequestId !== commitRequestIdRef.current ||
                        !isAgentSelectorRequestCurrent(request)
                    ) {
                        return;
                    }
                    const message = err instanceof Error ? err.message : String(err);
                    setState((prev) => ({ status: "error", entries: prev.entries, message }));
                } finally {
                    if (commitRequestId === commitRequestIdRef.current) {
                        pickBusyRef.current = false;
                        if (!isAgentSelectorRequestCurrent(request)) return;
                        setBusyEntryId(null);
                    }
                }
            },
            [request, managerView, state.entries, onClose, onUserMessage, onEditorText]
        );

        const handleTreeReference = useCallback(
            async (entryId: string, requestedRepresentation: AgentContextRepresentation) => {
                if (request?.type !== "tree" || referenceBusyRef.current != null) return;
                const referenceOperationId = ++referenceOperationIdRef.current;
                referenceBusyRef.current = referenceOperationId;
                const commitRequestId = ++commitRequestIdRef.current;
                setReferenceBusy(true);
                setBusyEntryId(entryId);
                try {
                    await commitAgentTreeReference(request, entryId, requestedRepresentation);
                    if (commitRequestId !== commitRequestIdRef.current) return;
                    setAnnouncement("Reference added");
                    onUserMessage?.("Reference added");
                    onClose();
                } catch (err) {
                    if (commitRequestId !== commitRequestIdRef.current) return;
                    const message = err instanceof Error ? err.message : String(err);
                    setState((prev) => ({ status: "error", entries: prev.entries, message }));
                } finally {
                    if (referenceBusyRef.current === referenceOperationId) {
                        referenceBusyRef.current = null;
                        setReferenceBusy(false);
                        setBusyEntryId(null);
                    }
                }
            },
            [request, onClose, onUserMessage]
        );

        const handleSessionReference = useCallback(
            async (deliveryScope: AgentContextDeliveryScope, requestedRepresentation: AgentContextRepresentation) => {
                if (
                    request?.type !== "session" ||
                    !referenceConfig ||
                    referenceBusyRef.current != null ||
                    pickBusyRef.current
                ) {
                    return;
                }
                const referenceOperationId = ++referenceOperationIdRef.current;
                referenceBusyRef.current = referenceOperationId;
                const commitRequestId = ++commitRequestIdRef.current;
                setReferenceBusy(true);
                setBusyEntryId(referenceConfig.source.path);
                setReferenceConfigError(undefined);
                try {
                    if (referenceConfig.turnIds) {
                        const results = await Promise.allSettled(
                            referenceConfig.turnIds.map((turnId) =>
                                request.prepareTurnReference(
                                    referenceConfig.source,
                                    turnId,
                                    deliveryScope,
                                    requestedRepresentation
                                )
                            )
                        );
                        if (commitRequestId !== commitRequestIdRef.current) return;
                        const succeededTurnIds = referenceConfig.turnIds.filter(
                            (_, index) => results[index].status === "fulfilled"
                        );
                        const failedTurnIds = referenceConfig.turnIds.filter(
                            (_, index) => results[index].status === "rejected"
                        );
                        if (succeededTurnIds.length > 0) {
                            setAddedTurnIds((previous) => new Set([...previous, ...succeededTurnIds]));
                            setSelectedTurnIds((previous) => {
                                const next = new Set(previous);
                                succeededTurnIds.forEach((turnId) => next.delete(turnId));
                                return next;
                            });
                        }
                        if (failedTurnIds.length > 0) {
                            setReferenceConfig((previous) =>
                                previous ? { ...previous, turnIds: failedTurnIds } : previous
                            );
                            setReferenceConfigError(`Added ${succeededTurnIds.length}, failed ${failedTurnIds.length}`);
                            return;
                        }
                    } else {
                        await request.prepareSessionReference(
                            referenceConfig.source,
                            deliveryScope,
                            requestedRepresentation
                        );
                    }
                    if (commitRequestId !== commitRequestIdRef.current) return;
                    setAnnouncement("Context added");
                    onUserMessage?.("Context added");
                    onClose();
                } catch (err) {
                    if (commitRequestId !== commitRequestIdRef.current) return;
                    const message = err instanceof Error ? err.message : String(err);
                    setReferenceConfigError(message);
                } finally {
                    if (referenceBusyRef.current === referenceOperationId) {
                        referenceBusyRef.current = null;
                        setReferenceBusy(false);
                        setBusyEntryId(null);
                    }
                }
            },
            [request, referenceConfig, onClose, onUserMessage]
        );

        const handleSessionDetailOpen = useCallback(
            (entryId: string) => {
                if (request?.type !== "session" || referenceBusyRef.current != null) return;
                const sourceEntry = state.entries.find((entry) => entry.id === entryId);
                if (!sourceEntry?.sessionMetadata || sourceEntry.sessionMetadata.path === request.currentSessionPath) {
                    return;
                }
                setReturnFocusEntryId(entryId);
                setDetailState({ status: "loading", entries: [] });
                setSelectedTurnIds(new Set());
                setAddedTurnIds(new Set(request.getAddedTurnIds(sourceEntry.sessionMetadata)));
                setManagerView({
                    type: "reference-detail",
                    source: sourceEntry.sessionMetadata,
                    sourceTitle:
                        sourceEntry.label?.trim() ||
                        sourceEntry.sessionDetail?.firstMessage?.trim() ||
                        sourceEntry.preview ||
                        "Untitled session",
                });
            },
            [request, state.entries]
        );

        const handleTurnToggle = useCallback(
            (entryId: string) => {
                if (
                    request?.type !== "session" ||
                    managerView.type !== "reference-detail" ||
                    referenceBusyRef.current != null ||
                    addedTurnIds.has(entryId) ||
                    !detailState.entries.some((entry) => entry.id === entryId)
                ) {
                    return;
                }
                setSelectedTurnIds((previous) => {
                    const next = new Set(previous);
                    if (next.has(entryId)) {
                        next.delete(entryId);
                    } else {
                        next.add(entryId);
                    }
                    return next;
                });
            },
            [addedTurnIds, detailState.entries, managerView, request]
        );

        const handleTurnConfigOpen = useCallback(() => {
            if (
                request?.type !== "session" ||
                managerView.type !== "reference-detail" ||
                referenceBusyRef.current != null
            ) {
                return;
            }
            const turnIds = detailState.entries
                .map((entry) => entry.id)
                .filter((entryId) => selectedTurnIds.has(entryId) && !addedTurnIds.has(entryId));
            if (turnIds.length === 0) return;
            setConfiguredDeliveryScope("message");
            setConfiguredRepresentation("full");
            setReferenceConfigError(undefined);
            setReferenceConfig({
                source: managerView.source,
                turnIds,
            });
        }, [addedTurnIds, detailState.entries, managerView, request, selectedTurnIds]);

        const handleCancel = useCallback(() => {
            if (!shouldAllowAgentSelectorCancel(referenceBusyRef.current == null ? null : "reference")) return;
            if (referenceConfig) {
                setReferenceConfig(undefined);
                setReferenceConfigError(undefined);
                return;
            }
            if (managerView.type === "reference-detail") {
                detailLoadIdRef.current++;
                setManagerView({ type: "sessions", action: "resume" });
                setSelectedTurnIds(new Set());
                setAddedTurnIds(new Set());
                return;
            }
            if (closeRequestedRef.current) return;
            closeRequestedRef.current = true;
            commitRequestIdRef.current++;
            onClose();
        }, [managerView, onClose, referenceConfig]);

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

        return (
            <CommandInlineFrame
                commandName={`/${request.type}`}
                dismissAnchorRef={anchorRef}
                onDismiss={handleCancel}
                dismissOnEscape={false}
                onResizeStart={handleResizeStart}
            >
                <div role="status" aria-live="polite" className="sr-only">
                    {announcement}
                </div>
                {referenceConfig ? (
                    <ContextConfigurationPanel
                        panelRef={panelRef}
                        selectedCount={referenceConfig.turnIds?.length ?? 1}
                        deliveryScope={configuredDeliveryScope}
                        representation={configuredRepresentation}
                        busy={referenceBusy}
                        errorMessage={referenceConfigError}
                        onBack={handleCancel}
                        onDeliveryScopeChange={setConfiguredDeliveryScope}
                        onRepresentationChange={setConfiguredRepresentation}
                        onAdd={() => void handleSessionReference(configuredDeliveryScope, configuredRepresentation)}
                    />
                ) : (
                    <AgentSelectorPanel
                        panelRef={panelRef}
                        searchInputRef={searchInputRef}
                        requestType={request.type}
                        state={
                            request.type === "session" && managerView.type === "reference-detail" ? detailState : state
                        }
                        busyEntryId={busyEntryId}
                        referenceBusy={referenceBusy}
                        listMaxHeight={listMaxHeight}
                        onPick={
                            request.type === "session" && managerView.type === "reference-detail"
                                ? () => undefined
                                : handlePick
                        }
                        onReference={request.type === "tree" && referencesEnabled ? handleTreeReference : undefined}
                        selectedEntryIds={selectedTurnIds}
                        disabledEntryIds={addedTurnIds}
                        onToggleEntry={
                            request.type === "session" && managerView.type === "reference-detail"
                                ? handleTurnToggle
                                : undefined
                        }
                        onNext={
                            request.type === "session" && managerView.type === "reference-detail"
                                ? handleTurnConfigOpen
                                : undefined
                        }
                        onCancel={handleCancel}
                        resetIdentity={request}
                        sessionManagerView={request.type === "session" ? managerView : undefined}
                        sessionScope={request.type === "session" ? sessionScope : undefined}
                        currentSessionPath={request.type === "session" ? request.currentSessionPath : undefined}
                        initialFocusEntryId={
                            request.type === "session" && managerView.type === "sessions"
                                ? returnFocusEntryId
                                : undefined
                        }
                        onSessionAction={
                            request.type === "session" && referencesEnabled
                                ? (action) => setManagerView({ type: "sessions", action })
                                : undefined
                        }
                        onSessionReference={
                            request.type === "session" && referencesEnabled ? handleSessionDetailOpen : undefined
                        }
                        onToggleSessionScope={
                            request.type === "session"
                                ? () => setSessionScope((scope) => (scope === "cwd" ? "all" : "cwd"))
                                : undefined
                        }
                        referencesEnabled={referencesEnabled}
                    />
                )}
            </CommandInlineFrame>
        );
    }
);
SessionSelector.displayName = "SessionSelector";

interface ContextConfigurationPanelProps {
    panelRef?: RefObject<HTMLDivElement | null>;
    selectedCount: number;
    deliveryScope: AgentContextDeliveryScope;
    representation: AgentContextRepresentation;
    busy: boolean;
    errorMessage?: string;
    onBack: () => void;
    onDeliveryScopeChange: (value: AgentContextDeliveryScope) => void;
    onRepresentationChange: (value: AgentContextRepresentation) => void;
    onAdd: () => void;
}

const ContextRepresentationOptions: ReadonlyArray<{
    value: AgentContextRepresentation;
    label: string;
    description: string;
}> = [
    { value: "full", label: "Full", description: "Complete selected context." },
    {
        value: "summary",
        label: "Summary",
        description: "Generate after adding.",
    },
];

const ContextDeliveryScopeOptions: ReadonlyArray<{
    value: AgentContextDeliveryScope;
    label: string;
    description: string;
}> = [
    {
        value: "message",
        label: "This message",
        description: "Next request only.",
    },
    {
        value: "conversation",
        label: "Conversation",
        description: "Keep with this turn.",
    },
];

interface ContextSegmentedRadioGroupProps<Value extends string> {
    groupRef: RefObject<HTMLDivElement | null>;
    label: string;
    name: string;
    value: Value;
    options: ReadonlyArray<{ value: Value; label: string; description: string }>;
    busy: boolean;
    onChange: (value: Value) => void;
}

function cycleContextOption<Value extends string>(
    options: ReadonlyArray<{ value: Value }>,
    value: Value,
    offset: -1 | 1,
    onChange: (next: Value) => void
): void {
    const currentIndex = options.findIndex((option) => option.value === value);
    const nextIndex = (currentIndex + offset + options.length) % options.length;
    onChange(options[nextIndex].value);
}

function ContextSegmentedRadioGroup<Value extends string>({
    groupRef,
    label,
    name,
    value,
    options,
    busy,
    onChange,
}: ContextSegmentedRadioGroupProps<Value>) {
    return (
        <fieldset className="min-w-0">
            <legend className="mb-[6px] text-[10px] uppercase tracking-[0.08em] text-secondary/55">{label}</legend>
            <div
                ref={groupRef}
                role="radiogroup"
                aria-label={label}
                aria-disabled={busy}
                tabIndex={busy ? -1 : 0}
                className="grid grid-cols-2 gap-[3px] rounded-lg border border-white/[0.08] bg-white/[0.025] p-[3px] outline-none transition-colors focus-visible:border-accent/70 focus-visible:ring-2 focus-visible:ring-accent/15"
            >
                {options.map((option) => {
                    const selected = value === option.value;
                    return (
                        <label
                            key={option.value}
                            className={cn(
                                "relative flex min-h-[48px] min-w-0 cursor-pointer items-center gap-[8px] rounded-md px-[10px] py-[6px] text-left transition-colors",
                                selected
                                    ? "bg-white/[0.09] text-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.045)]"
                                    : "text-secondary/65 hover:bg-white/[0.04] hover:text-foreground",
                                busy && "pointer-events-none opacity-50"
                            )}
                        >
                            <input
                                type="radio"
                                name={name}
                                value={option.value}
                                checked={selected}
                                disabled={busy}
                                tabIndex={-1}
                                onChange={() => onChange(option.value)}
                                className="sr-only"
                            />
                            <span
                                aria-hidden="true"
                                className={cn(
                                    "flex size-[14px] shrink-0 items-center justify-center rounded-full border text-[9px] leading-none",
                                    selected
                                        ? "border-accent/70 bg-accent/15 text-accent"
                                        : "border-white/[0.18] text-transparent"
                                )}
                            >
                                ✓
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-[12px] leading-[17px]">{option.label}</span>
                                <span className="truncate text-[10px] leading-[14px] text-secondary/50">
                                    {option.description}
                                </span>
                            </span>
                        </label>
                    );
                })}
            </div>
        </fieldset>
    );
}

function ContextConfigurationPanel({
    panelRef,
    selectedCount,
    deliveryScope,
    representation,
    busy,
    errorMessage,
    onBack,
    onDeliveryScopeChange,
    onRepresentationChange,
    onAdd,
}: ContextConfigurationPanelProps) {
    const backButtonRef = useRef<HTMLButtonElement>(null);
    const deliveryGroupRef = useRef<HTMLDivElement>(null);
    const representationGroupRef = useRef<HTMLDivElement>(null);
    const addButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        deliveryGroupRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!errorMessage) return;
        addButtonRef.current?.focus();
    }, [errorMessage]);

    const moveFocus = useCallback((target: EventTarget | null, offset: -1 | 1) => {
        if (!(target instanceof HTMLElement)) return;
        const zones = [
            backButtonRef.current,
            deliveryGroupRef.current,
            representationGroupRef.current,
            addButtonRef.current,
        ];
        const currentIndex = zones.findIndex((zone) => zone === target || zone?.contains(target));
        if (currentIndex < 0) return;
        const nextIndex = Math.max(0, Math.min(zones.length - 1, currentIndex + offset));
        zones[nextIndex]?.focus();
    }, []);

    const selectedLabel = selectedCount === 1 ? "1 turn selected" : `${selectedCount} turns selected`;
    const addLabel = selectedCount === 1 ? "Add reference" : `Add ${selectedCount} references`;

    return (
        <CommandSelectorPanel
            panelRef={panelRef}
            ariaLabel="Context configuration"
            role="region"
            onKeyDown={(event) => {
                if (busy) return;
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    onBack();
                    return;
                }
                if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    onAdd();
                    return;
                }
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    event.stopPropagation();
                    moveFocus(event.target, event.key === "ArrowUp" ? -1 : 1);
                    return;
                }
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                const target = event.target;
                const offset = event.key === "ArrowLeft" ? -1 : 1;
                if (target instanceof Node && deliveryGroupRef.current?.contains(target)) {
                    event.preventDefault();
                    event.stopPropagation();
                    cycleContextOption(ContextDeliveryScopeOptions, deliveryScope, offset, onDeliveryScopeChange);
                    return;
                }
                if (target instanceof Node && representationGroupRef.current?.contains(target)) {
                    event.preventDefault();
                    event.stopPropagation();
                    cycleContextOption(ContextRepresentationOptions, representation, offset, onRepresentationChange);
                }
            }}
        >
            <div className="flex min-h-[42px] items-center justify-between border-b border-white/[0.07] px-[12px] py-[6px]">
                <button
                    ref={backButtonRef}
                    type="button"
                    aria-label="Back"
                    disabled={busy}
                    className="inline-flex min-h-[28px] w-fit cursor-pointer items-center gap-[4px] rounded-md px-[6px] text-[12px] text-secondary/70 transition-colors hover:bg-white/[0.045] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-50"
                    onClick={onBack}
                >
                    ← Back
                </button>
                <span className="text-[10px] text-secondary/45">{selectedLabel}</span>
            </div>
            <div className="grid gap-[14px] px-[12px] py-[12px]">
                <ContextSegmentedRadioGroup
                    groupRef={deliveryGroupRef}
                    label="Use in"
                    name="context-delivery"
                    value={deliveryScope}
                    options={ContextDeliveryScopeOptions}
                    busy={busy}
                    onChange={onDeliveryScopeChange}
                />
                <ContextSegmentedRadioGroup
                    groupRef={representationGroupRef}
                    label="Include as"
                    name="context-representation"
                    value={representation}
                    options={ContextRepresentationOptions}
                    busy={busy}
                    onChange={onRepresentationChange}
                />
            </div>
            {errorMessage && (
                <p className="mx-[12px] mb-[8px] text-[11px] text-destructive" role="alert">
                    {errorMessage}
                </p>
            )}
            <div className="flex min-h-[48px] items-center border-t border-white/[0.07] px-[12px] py-[8px]">
                <CommandSelectorHintFooter
                    className="min-h-0 flex-1 border-t-0 px-0 py-0"
                    hints={[
                        { keys: ["←", "→"], label: "choose" },
                        { keys: ["↑", "↓"], label: "group" },
                        { keys: ["↵"], label: "add" },
                        { keys: ["esc"], label: "back" },
                    ]}
                    trailing={
                        <button
                            ref={addButtonRef}
                            type="button"
                            disabled={busy}
                            className="min-h-[28px] cursor-pointer rounded-lg bg-accent/80 px-[12px] py-[4px] text-[12px] text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-50"
                            onClick={onAdd}
                        >
                            {busy ? "Adding…" : addLabel}
                        </button>
                    }
                />
            </div>
        </CommandSelectorPanel>
    );
}

// =========================================================================
// AgentSelectorPanel
// =========================================================================

function buildSelectorHints(
    isTree: boolean,
    isSession: boolean,
    isReferenceDetail: boolean,
    visibleCount: number,
    totalCount: number
) {
    const hints: SelectorHint[] = [{ keys: ["↑", "↓"], label: "navigate" }];
    if (isTree && !isSession) {
        hints.push({ keys: ["←", "→"], label: "fold" });
        hints.push({ keys: ["^o"], label: "cycle filter" });
    }
    if (isSession && !isReferenceDetail) {
        hints.push({ keys: ["←", "→"], label: "action" });
        hints.push({ keys: ["/"], label: "filter" });
    }
    if (isReferenceDetail) {
        hints.push({ keys: ["space"], label: "select" });
        hints.push({ keys: ["↵"], label: "next" });
    } else {
        hints.push({ keys: ["↵"], label: "select" });
    }
    hints.push({ keys: ["esc"], label: isReferenceDetail ? "back" : "dismiss" });
    return <CommandSelectorHintFooter hints={hints} countText={`(${visibleCount}/${totalCount})`} />;
}

export interface AgentSelectorPanelProps {
    panelRef?: RefObject<HTMLDivElement | null>;
    searchInputRef?: RefObject<HTMLInputElement | null>;
    requestType: AgentSelectorRequestType;
    state: AgentSelectorViewState;
    busyEntryId: string | null;
    referenceBusy?: boolean;
    listMaxHeight?: number;
    onPick: (entryId: string) => void;
    onReference?: (entryId: string, representation: AgentContextRepresentation) => void;
    selectedEntryIds?: ReadonlySet<string>;
    disabledEntryIds?: ReadonlySet<string>;
    onToggleEntry?: (entryId: string) => void;
    onNext?: () => void;
    onCancel: () => void;
    resetIdentity?: object;
    sessionManagerView?: SessionManagerView;
    sessionScope?: "cwd" | "all";
    currentSessionPath?: string;
    initialFocusEntryId?: string;
    onSessionAction?: (action: "resume" | "reference") => void;
    onSessionReference?: (entryId: string) => void;
    onToggleSessionScope?: () => void;
    referencesEnabled?: boolean;
}

export const AgentSelectorPanel = memo(
    ({
        panelRef,
        searchInputRef,
        requestType,
        state,
        busyEntryId,
        referenceBusy = false,
        listMaxHeight = COMMAND_SELECTOR_LIST_MAX_HEIGHT_PX,
        onPick,
        onReference,
        selectedEntryIds = EmptyEntryIds,
        disabledEntryIds = EmptyEntryIds,
        onToggleEntry,
        onNext,
        onCancel,
        resetIdentity,
        sessionManagerView,
        sessionScope,
        currentSessionPath,
        initialFocusEntryId,
        onSessionReference,
        onToggleSessionScope,
    }: AgentSelectorPanelProps) => {
        const [query, setQuery] = useState("");
        const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
        const [filterMode, setFilterMode] = useState<FilterMode>("default");
        const [sessionRowAction, setSessionRowAction] = useState<"resume" | "reference">("resume");
        const listInnerRef = useRef<HTMLDivElement>(null);
        const listRef = useRef<HTMLDivElement>(null);
        const backButtonRef = useRef<HTMLButtonElement>(null);
        const previousManagerViewTypeRef = useRef(sessionManagerView?.type);
        const focusActiveOptionRef = useRef(false);

        const isTree = requestType === "tree";
        const isSession = requestType === "session";
        const isReferenceDetail = sessionManagerView?.type === "reference-detail";
        const isSessionList = isSession && !isReferenceDetail;
        const currentLeafId = useMemo(() => state.entries.find((e) => e.isCurrent)?.id, [state.entries]);

        const treeLayout = useMemo(() => {
            if (!isTree) return null;
            return computeTreeLayout(state.entries, collapsed, query, currentLeafId, filterMode);
        }, [isTree, state.entries, collapsed, query, currentLeafId, filterMode]);

        const sessionVisibleIds = useMemo(() => {
            if (!isSessionList) return null;
            const q = query.trim().toLowerCase();
            if (!q) return state.entries.map((e) => e.id);
            return state.entries
                .filter((e) => {
                    let hay = (e.role + " " + (e.label ?? "") + " " + e.preview + " " + (e.type ?? "")).toLowerCase();
                    if (e.sessionDetail) {
                        hay +=
                            " " +
                            (e.sessionDetail.firstMessage || "") +
                            " " +
                            (e.sessionDetail.previewText || "") +
                            " " +
                            (e.sessionDetail.cwd || "");
                    }
                    return hay.includes(q);
                })
                .map((e) => e.id);
        }, [isSessionList, state.entries, query]);

        const visibleIds = useMemo(
            () => treeLayout?.orderedIds ?? sessionVisibleIds ?? state.entries.map((entry) => entry.id),
            [treeLayout, sessionVisibleIds, state.entries]
        );
        const totalCount = state.entries.length;
        const visibleCount = visibleIds.length;
        const empty = state.status === "ready" && visibleCount === 0;

        const commitIndex = useCallback(
            (index: number) => {
                const entryId = visibleIds[index];
                const entry = entryId ? state.entries.find((en) => en.id === entryId) : undefined;
                const isCurrentReferenceTarget =
                    isSessionList &&
                    sessionManagerView?.type === "sessions" &&
                    sessionManagerView.action === "reference" &&
                    entry?.sessionMetadata?.path === currentSessionPath;
                if (entry && busyEntryId == null && !isCurrentReferenceTarget) {
                    onPick(entry.id);
                }
            },
            [visibleIds, state.entries, busyEntryId, isSessionList, sessionManagerView, currentSessionPath, onPick]
        );

        // Shared ↑↓ / Enter / Esc behavior + clamped activeIdx (single source
        // of truth with the model picker, via useCommandSelectorNavigation).
        const { activeIdx, setActiveIdx, handleNavKey } = useCommandSelectorNavigation({
            itemCount: visibleCount,
            onCommit: commitIndex,
            onDismiss: onCancel,
            commitDisabled: busyEntryId != null,
        });

        useEffect(() => {
            if (state.status !== "ready") return;
            const initialId = initialFocusEntryId ?? getInitialAgentSelectorFocusEntryId(requestType, state.entries);
            if (isReferenceDetail) {
                const firstSelectableIndex = visibleIds.findIndex((entryId) => !disabledEntryIds.has(entryId));
                setActiveIdx(firstSelectableIndex >= 0 ? firstSelectableIndex : 0);
            } else if (initialId) {
                const idx = visibleIds.indexOf(initialId);
                setActiveIdx(idx >= 0 ? idx : 0);
            } else {
                setActiveIdx(0);
            }
        }, [
            disabledEntryIds,
            initialFocusEntryId,
            isReferenceDetail,
            requestType,
            setActiveIdx,
            state.entries,
            state.status,
            visibleIds,
        ]);

        useEffect(() => {
            setQuery("");
            setCollapsed(new Set());
            setFilterMode("default");
            setSessionRowAction("resume");
        }, [requestType, resetIdentity]);

        useEffect(() => {
            if (!isSessionList || sessionRowAction !== "reference") return;
            const entryId = visibleIds[activeIdx];
            const entry = entryId ? state.entries.find((candidate) => candidate.id === entryId) : undefined;
            if (onSessionReference && entry?.sessionMetadata?.path !== currentSessionPath) return;
            setSessionRowAction("resume");
        }, [
            activeIdx,
            currentSessionPath,
            isSessionList,
            onSessionReference,
            sessionRowAction,
            state.entries,
            visibleIds,
        ]);

        useEffect(() => {
            const previousViewType = previousManagerViewTypeRef.current;
            previousManagerViewTypeRef.current = sessionManagerView?.type;
            if (!isSession) return;
            const focusTimer = window.setTimeout(() => {
                if (isReferenceDetail) {
                    backButtonRef.current?.focus({ preventScroll: true });
                    return;
                }
                if (previousViewType !== "reference-detail" || !initialFocusEntryId) return;
                const sourceRow = Array.from(
                    listInnerRef.current?.querySelectorAll<HTMLElement>("[data-agent-selector-row]") ?? []
                ).find((row) => row.dataset.agentSelectorRow === initialFocusEntryId);
                sourceRow?.focus({ preventScroll: true });
            }, 0);
            return () => window.clearTimeout(focusTimer);
        }, [initialFocusEntryId, isReferenceDetail, isSession, sessionManagerView?.type, state.status]);

        useEffect(() => {
            if (!isSession || state.status !== "ready" || visibleCount === 0) return;
            const focusTimer = window.setTimeout(() => {
                const activeOption = listInnerRef.current?.querySelector<HTMLElement>(
                    `[data-agent-row-idx="${activeIdx}"]`
                );
                const activeElement = document.activeElement;
                const focusIsOutsidePanel =
                    !(activeElement instanceof Node) || !(panelRef?.current?.contains(activeElement) ?? false);
                const shouldFocus =
                    focusActiveOptionRef.current ||
                    (!isReferenceDetail &&
                        (focusIsOutsidePanel ||
                            activeElement === panelRef?.current ||
                            activeElement === listRef.current ||
                            (activeElement instanceof HTMLElement && activeElement.getAttribute("role") === "option")));
                focusActiveOptionRef.current = false;
                if (shouldFocus) activeOption?.focus({ preventScroll: true });
            }, 0);
            return () => window.clearTimeout(focusTimer);
        }, [activeIdx, isReferenceDetail, isSession, panelRef, state.status, visibleCount]);

        // Scroll active row into view
        useScrollActiveRowIntoView(listInnerRef, activeIdx, (i) => `[data-agent-row-idx="${i}"]`, visibleCount > 0);

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

        // Switch FilterMode. Mirrors Pi: every mode change clears the folded
        // set so the freshly-filtered tree opens fully expanded.
        const changeFilterMode = useCallback((mode: FilterMode) => {
            setFilterMode(mode);
            setCollapsed(new Set());
        }, []);

        // Toggle a mode against `default` (Pi's direct-filter keys), or cycle.
        const toggleFilterMode = useCallback(
            (mode: FilterMode) => changeFilterMode(filterMode === mode ? "default" : mode),
            [filterMode, changeFilterMode]
        );

        const cycleFilterMode = useCallback(
            (dir: 1 | -1) => {
                const i = FILTER_MODES.indexOf(filterMode);
                changeFilterMode(FILTER_MODES[(i + dir + FILTER_MODES.length) % FILTER_MODES.length]);
            },
            [filterMode, changeFilterMode]
        );

        const handleKeyDown = useCallback(
            (e: React.KeyboardEvent) => {
                const target = e.target;
                if (target instanceof HTMLInputElement && e.key !== "Escape") return;
                if (target instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
                if (isSessionList && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "ArrowLeft") {
                        setSessionRowAction("resume");
                        return;
                    }
                    const entryId = visibleIds[activeIdx];
                    const entry = entryId ? state.entries.find((candidate) => candidate.id === entryId) : undefined;
                    if (onSessionReference && entry?.sessionMetadata?.path !== currentSessionPath) {
                        setSessionRowAction("reference");
                    }
                    return;
                }
                if (isSessionList && e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    const entryId = visibleIds[activeIdx];
                    const entry = entryId ? state.entries.find((candidate) => candidate.id === entryId) : undefined;
                    if (
                        sessionRowAction === "reference" &&
                        onSessionReference &&
                        entry?.sessionMetadata?.path !== currentSessionPath
                    ) {
                        onSessionReference(entryId);
                        return;
                    }
                    commitIndex(activeIdx);
                    return;
                }
                if (isReferenceDetail && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                    e.preventDefault();
                    const direction = e.key === "ArrowDown" ? 1 : -1;
                    for (let offset = 1; offset <= visibleCount; offset++) {
                        const nextIndex = (activeIdx + direction * offset + visibleCount) % visibleCount;
                        if (!disabledEntryIds.has(visibleIds[nextIndex])) {
                            focusActiveOptionRef.current = true;
                            setActiveIdx(nextIndex);
                            break;
                        }
                    }
                    return;
                }
                if (isReferenceDetail && e.key === " ") {
                    e.preventDefault();
                    const entryId = visibleIds[activeIdx];
                    if (entryId && !disabledEntryIds.has(entryId)) {
                        onToggleEntry?.(entryId);
                    }
                    return;
                }
                if (isReferenceDetail && e.key === "Enter") {
                    e.preventDefault();
                    if (selectedEntryIds.size > 0) {
                        onNext?.();
                    }
                    return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    focusActiveOptionRef.current = isSession;
                }
                // Shared ↑↓ / Enter / Esc first; fall through to tree-specific keys.
                if (handleNavKey(e)) return;
                // Tree-specific keys
                if (isTree && treeLayout) {
                    // FilterMode shortcuts (Pi parity): ctrl+d/t/u/l/a direct or
                    // toggle-vs-default, ctrl+o / shift+ctrl+o to cycle.
                    if (e.ctrlKey && !e.metaKey && !e.altKey) {
                        const key = e.key.toLowerCase();
                        if (key === "d") {
                            e.preventDefault();
                            changeFilterMode("default");
                            return;
                        }
                        if (key === "t") {
                            e.preventDefault();
                            toggleFilterMode("no-tools");
                            return;
                        }
                        if (key === "u") {
                            e.preventDefault();
                            toggleFilterMode("user-only");
                            return;
                        }
                        if (key === "l") {
                            e.preventDefault();
                            toggleFilterMode("labeled-only");
                            return;
                        }
                        if (key === "a") {
                            e.preventDefault();
                            toggleFilterMode("all");
                            return;
                        }
                        if (key === "o") {
                            e.preventDefault();
                            cycleFilterMode(e.shiftKey ? -1 : 1);
                            return;
                        }
                    }
                    const entryId = visibleIds[activeIdx];
                    const entry = entryId ? treeLayout.byId.get(entryId) : undefined;
                    const hasKids = entry ? (treeLayout.hasChildren.get(entry.id) ?? false) : false;
                    const isFoldableNode = entry ? (treeLayout.isFoldable.get(entry.id) ?? false) : false;
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
                if (
                    e.key === "/" &&
                    (isTree || isSessionList) &&
                    searchInputRef?.current &&
                    document.activeElement !== searchInputRef.current
                ) {
                    e.preventDefault();
                    searchInputRef.current.focus();
                    searchInputRef.current.select();
                }
            },
            [
                handleNavKey,
                visibleIds,
                activeIdx,
                setActiveIdx,
                isTree,
                isSession,
                isSessionList,
                treeLayout,
                collapsed,
                searchInputRef,
                changeFilterMode,
                toggleFilterMode,
                cycleFilterMode,
                disabledEntryIds,
                isReferenceDetail,
                onNext,
                onToggleEntry,
                selectedEntryIds.size,
                visibleCount,
                commitIndex,
                currentSessionPath,
                onSessionReference,
                sessionRowAction,
                state.entries,
            ]
        );

        const handleSearchKeyDown = useCallback(
            (e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    e.stopPropagation();
                    focusActiveOptionRef.current = isSession;
                    if (visibleCount > 0) setActiveIdx(0);
                    return;
                }
                if (e.key === "Escape") {
                    if (e.currentTarget.value) {
                        e.preventDefault();
                        e.stopPropagation();
                        setQuery("");
                        return;
                    }
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    const entryId = visibleIds[activeIdx];
                    const entry = entryId ? state.entries.find((en) => en.id === entryId) : undefined;
                    if (entry && busyEntryId == null) {
                        onPick(entry.id);
                    }
                    return;
                }
            },
            [visibleCount, visibleIds, activeIdx, state.entries, busyEntryId, onPick, isSession]
        );

        const handleGlobalKeyDown = useCallback(
            (e: KeyboardEvent) => {
                const activeElement = document.activeElement;
                const focusInsidePanel =
                    activeElement instanceof Node &&
                    ((panelRef?.current?.contains(activeElement) ?? false) ||
                        activeElement === searchInputRef?.current ||
                        activeElement === listRef.current);
                if (focusInsidePanel) return;

                if (isAgentSelectorGlobalNavigationKey(e.key)) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "ArrowDown") {
                        focusActiveOptionRef.current = isSession;
                        if (visibleCount > 0) setActiveIdx((prev) => (prev + 1) % visibleCount);
                        return;
                    }
                    if (e.key === "ArrowUp") {
                        focusActiveOptionRef.current = isSession;
                        if (visibleCount > 0) setActiveIdx((prev) => (prev - 1 + visibleCount) % visibleCount);
                        return;
                    }
                    if (e.key === "Enter") {
                        if (visibleCount > 0 && busyEntryId == null) commitIndex(activeIdx);
                        return;
                    }
                    onCancel();
                    return;
                }

                if (e.key === "/" && (isTree || isSessionList) && searchInputRef?.current) {
                    e.preventDefault();
                    e.stopPropagation();
                    searchInputRef.current.focus();
                    searchInputRef.current.select();
                }
            },
            [
                activeIdx,
                busyEntryId,
                commitIndex,
                isSession,
                isSessionList,
                isTree,
                onCancel,
                panelRef,
                searchInputRef,
                setActiveIdx,
                visibleCount,
            ]
        );

        useEffect(() => {
            window.addEventListener("keydown", handleGlobalKeyDown, true);
            return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
        }, [handleGlobalKeyDown]);

        const handleRowClick = useCallback(
            (entryId: string) => {
                if (busyEntryId != null) return;
                const entry = state.entries.find((candidate) => candidate.id === entryId);
                if (
                    isSessionList &&
                    sessionManagerView?.type === "sessions" &&
                    sessionManagerView.action === "reference" &&
                    entry?.sessionMetadata?.path === currentSessionPath
                ) {
                    return;
                }
                const idx = visibleIds.indexOf(entryId);
                if (idx >= 0) setActiveIdx(idx);
                if (isReferenceDetail) {
                    if (!disabledEntryIds.has(entryId)) {
                        onToggleEntry?.(entryId);
                    }
                    return;
                }
                onPick(entryId);
            },
            [
                busyEntryId,
                currentSessionPath,
                disabledEntryIds,
                isReferenceDetail,
                isSessionList,
                onPick,
                onToggleEntry,
                sessionManagerView,
                state.entries,
                visibleIds,
            ]
        );

        const handleChevronClick = useCallback(
            (e: React.MouseEvent, entryId: string) => {
                e.stopPropagation();
                toggleCollapsed(entryId);
            },
            [toggleCollapsed]
        );

        return (
            <CommandSelectorPanel
                panelRef={panelRef}
                ariaLabel={getAgentSelectorTitle(requestType)}
                role={isSession ? "region" : "listbox"}
                onKeyDown={handleKeyDown}
            >
                {state.status === "loading" && <CommandSelectorMessage>Loading…</CommandSelectorMessage>}
                {state.status === "error" && (
                    <CommandSelectorMessage tone="error">{state.message}</CommandSelectorMessage>
                )}
                {empty && state.status === "ready" && (
                    <CommandSelectorMessage>
                        {query
                            ? "No matches."
                            : isSessionList
                              ? "No sessions found. Start a conversation to create one."
                              : "No entries available for this session."}
                    </CommandSelectorMessage>
                )}

                {isSessionList && (
                    <div
                        data-session-toolbar="true"
                        className={cn(SessionToolbarClassName, "justify-start")}
                        style={{ fontSize: `${COMMAND_SELECTOR_SEARCH_FONT_PX}px` }}
                    >
                        {state.status !== "loading" && state.status !== "idle" && (
                            <div
                                role="group"
                                aria-label="Session scope"
                                data-command-selector-filter-rail="true"
                                className={SessionToolbarGroupClassName}
                            >
                                <button
                                    type="button"
                                    aria-pressed={sessionScope === "cwd"}
                                    className={sessionToolbarButtonClassName(sessionScope === "cwd")}
                                    onClick={() => onToggleSessionScope?.()}
                                >
                                    <span
                                        className={cn(
                                            "inline-block size-2 rounded-full",
                                            sessionScope === "cwd"
                                                ? "bg-cyan-400 shadow-[0_0_4px_rgba(92,184,232,0.6)]"
                                                : "border border-secondary/40"
                                        )}
                                    />
                                    Current Folder
                                </button>
                                <button
                                    type="button"
                                    aria-pressed={sessionScope === "all"}
                                    className={sessionToolbarButtonClassName(sessionScope === "all")}
                                    onClick={() => onToggleSessionScope?.()}
                                >
                                    <span
                                        className={cn(
                                            "inline-block size-2 rounded-full",
                                            sessionScope === "all"
                                                ? "bg-cyan-400 shadow-[0_0_4px_rgba(92,184,232,0.6)]"
                                                : "border border-secondary/40"
                                        )}
                                    />
                                    All
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {isReferenceDetail && (
                    <div className="mx-3 mt-2 flex h-[32px] items-center justify-between">
                        <button
                            ref={backButtonRef}
                            type="button"
                            disabled={referenceBusy}
                            className="h-[24px] cursor-pointer justify-self-start rounded-lg bg-white/[0.045] px-[8px] text-[12px] text-secondary/75 transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/70"
                            onClick={onCancel}
                        >
                            ← Back
                        </button>
                        <div className="flex items-center gap-[8px]">
                            <span className="text-[11px] text-secondary/55">{selectedEntryIds.size} selected</span>
                            <button
                                type="button"
                                aria-label="Next"
                                disabled={selectedEntryIds.size === 0 || referenceBusy}
                                className="h-[24px] cursor-pointer rounded-lg bg-accent/80 px-[10px] text-[12px] text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/70 disabled:pointer-events-none disabled:opacity-40"
                                onClick={onNext}
                            >
                                Next →
                            </button>
                        </div>
                    </div>
                )}

                {isTree && state.status !== "loading" && state.status !== "idle" && state.entries.length > 0 && (
                    <div
                        data-command-selector-filter-rail="true"
                        className={SelectorControlRailClassName}
                        style={{ fontSize: `${COMMAND_SELECTOR_SEARCH_FONT_PX}px` }}
                    >
                        {FILTER_MODES.map((mode) => (
                            <button
                                key={mode}
                                type="button"
                                className={selectorControlChipClassName(filterMode === mode)}
                                onClick={() => changeFilterMode(mode)}
                            >
                                {FILTER_MODE_LABEL[mode]}
                            </button>
                        ))}
                    </div>
                )}

                {(isTree || isSessionList) && state.entries.length > 0 && (
                    <CommandSelectorSearchBar
                        inputRef={searchInputRef}
                        value={query}
                        onChange={setQuery}
                        onKeyDown={handleSearchKeyDown}
                        placeholder={isSessionList ? "filter sessions…" : "filter messages…"}
                        ariaLabel={isSessionList ? "Filter sessions" : "Filter messages"}
                    />
                )}

                {visibleCount > 0 && (
                    <div
                        ref={listRef}
                        tabIndex={-1}
                        role={isSession ? "listbox" : undefined}
                        aria-label={isReferenceDetail ? "Reference turns" : isSessionList ? "Sessions" : undefined}
                        aria-multiselectable={isReferenceDetail || undefined}
                        className="outline-none"
                    >
                        <TreeList
                            entries={state.entries}
                            requestType={requestType}
                            treeLayout={treeLayout}
                            visibleIds={visibleIds}
                            collapsed={collapsed}
                            activeIdx={activeIdx}
                            busyEntryId={busyEntryId}
                            referenceBusy={referenceBusy}
                            listMaxHeight={listMaxHeight}
                            listInnerRef={listInnerRef}
                            onHover={setActiveIdx}
                            onRowClick={handleRowClick}
                            onReference={onReference}
                            selectedEntryIds={selectedEntryIds}
                            disabledEntryIds={disabledEntryIds}
                            onSessionReference={onSessionReference}
                            sessionManagerView={sessionManagerView}
                            currentSessionPath={currentSessionPath}
                            sessionRowAction={sessionRowAction}
                            onChevronClick={handleChevronClick}
                        />
                    </div>
                )}

                {buildSelectorHints(isTree, isSession, isReferenceDetail, visibleCount, totalCount)}
            </CommandSelectorPanel>
        );
    }
);
AgentSelectorPanel.displayName = "AgentSelectorPanel";

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
    referenceBusy: boolean;
    listMaxHeight: number;
    listInnerRef: RefObject<HTMLDivElement | null>;
    onHover: (idx: number) => void;
    onRowClick: (id: string) => void;
    onReference?: (id: string, representation: AgentContextRepresentation) => void;
    selectedEntryIds?: ReadonlySet<string>;
    disabledEntryIds?: ReadonlySet<string>;
    onSessionReference?: (id: string) => void;
    sessionManagerView?: SessionManagerView;
    currentSessionPath?: string;
    sessionRowAction: "resume" | "reference";
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
    referenceBusy,
    listMaxHeight,
    listInnerRef,
    onHover,
    onRowClick,
    onReference,
    selectedEntryIds = EmptyEntryIds,
    disabledEntryIds = EmptyEntryIds,
    onSessionReference,
    sessionManagerView,
    currentSessionPath,
    sessionRowAction,
    onChevronClick,
}: TreeListProps) {
    const isTreeMode = requestType === "tree";
    const isSessionList = requestType === "session" && sessionManagerView?.type !== "reference-detail";
    const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

    return (
        <div data-command-selector-list="true" className="mx-3 overflow-hidden rounded-xl">
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

                    if (isTreeMode && treeLayout) {
                        return (
                            <TreeRow
                                key={entry.id}
                                entry={entry}
                                idx={idx}
                                layout={treeLayout}
                                collapsed={collapsed}
                                isActive={isActive}
                                isBusy={isBusy}
                                referenceBusy={referenceBusy}
                                isCurrent={isCurrent}
                                onHover={onHover}
                                onRowClick={onRowClick}
                                onReference={onReference}
                                onChevronClick={onChevronClick}
                            />
                        );
                    }

                    if (isSessionList) {
                        const isDisabled = entry.sessionMetadata?.path === currentSessionPath;
                        return (
                            <SessionRow
                                key={entry.id}
                                entry={entry}
                                idx={idx}
                                isActive={isActive}
                                isBusy={isBusy}
                                isDisabled={isDisabled}
                                selectedAction={isActive ? sessionRowAction : undefined}
                                onHover={onHover}
                                onRowClick={onRowClick}
                                onAddContext={onSessionReference}
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
                            referenceBusy={referenceBusy}
                            onReference={onReference}
                            isSelected={selectedEntryIds.has(entry.id)}
                            isDisabled={disabledEntryIds.has(entry.id)}
                            selectionMode={sessionManagerView?.type === "reference-detail"}
                        />
                    );
                })}
            </div>
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
    referenceBusy: boolean;
    isCurrent: boolean;
    onHover: (idx: number) => void;
    onRowClick: (id: string) => void;
    onReference?: (id: string, representation: AgentContextRepresentation) => void;
    onChevronClick: (e: React.MouseEvent, id: string) => void;
}

const TreeRow = memo(function TreeRow({
    entry,
    idx,
    layout,
    collapsed,
    isActive,
    isBusy,
    referenceBusy,
    isCurrent,
    onHover,
    onRowClick,
    onReference,
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
    const canReference = entry.role === "user" && entry.referenceable === true && onReference != null;

    return (
        <div
            data-agent-row-idx={idx}
            data-agent-entry-id={entry.id}
            data-agent-selector-row={entry.id}
            data-agent-selector-active={isActive ? "true" : undefined}
            data-agent-selector-current={isCurrent ? "true" : undefined}
            aria-disabled={isBusy || undefined}
            className={cn(
                "tree-row group flex cursor-pointer select-none items-center pr-2 text-left",
                isActive && "tree-row-active",
                isCurrent && "tree-row-current",
                isBusy && "pointer-events-none opacity-60"
            )}
            style={canReference ? { height: "28px" } : undefined}
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
                            isOnPath &&
                                (kind === "guide" || kind === "branch" || kind === "corner") &&
                                "tree-indent-active"
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
                {isCurrent && (
                    <span className="tree-streaming">
                        <span />
                        <span />
                        <span />
                    </span>
                )}
                {isBusy && <span className="tree-busy">…</span>}
            </div>
            {canReference && (
                <ReferenceActionMenu
                    label="Add reference"
                    busy={referenceBusy}
                    onSelect={(representation) => onReference?.(entry.id, representation)}
                />
            )}
        </div>
    );
});

interface SessionRowProps {
    entry: AgentSelectorEntryView;
    idx: number;
    isActive: boolean;
    isBusy: boolean;
    isDisabled: boolean;
    selectedAction?: "resume" | "reference";
    onHover: (idx: number) => void;
    onRowClick: (id: string) => void;
    onAddContext?: (id: string) => void;
}

function formatRelativeTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
    return `${Math.floor(diffDays / 365)}y`;
}

const SessionRow = memo(function SessionRow({
    entry,
    idx,
    isActive,
    isBusy,
    isDisabled,
    selectedAction,
    onHover,
    onRowClick,
    onAddContext,
}: SessionRowProps) {
    const detail = entry.sessionDetail;
    const hasName = !!entry.label;
    const age = formatRelativeTime(entry.timestamp || new Date(0).toISOString());
    const displayText = hasName ? entry.label! : entry.preview || "";
    const secondaryText = detail?.cwd || "";

    return (
        <div
            id={`agent-selector-option-${encodeURIComponent(entry.id)}`}
            role="option"
            aria-label={displayText}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            data-agent-row-idx={idx}
            data-agent-entry-id={entry.id}
            data-agent-selector-row={entry.id}
            data-agent-selector-active={isActive ? "true" : undefined}
            aria-disabled={isBusy || isDisabled || undefined}
            className={cn(
                "resume-row resume-row-grid group cursor-pointer select-none px-3 text-left focus:outline-none",
                isActive && "resume-row-active",
                (isBusy || isDisabled) && "pointer-events-none opacity-60"
            )}
            onMouseEnter={() => onHover(idx)}
            onClick={() => onRowClick(entry.id)}
        >
            <span className={cn("resume-cursor", isActive ? "resume-cursor-on" : "resume-cursor-off")}>›</span>
            <span className="resume-marker">
                <span className={cn("resume-dot", hasName ? "resume-dot-named" : "resume-dot-default")} />
            </span>
            <div className="resume-body">
                <span className={cn("resume-title", hasName ? "resume-named" : "resume-msg")}>
                    {truncate(displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim(), 120)}
                </span>
                {secondaryText && <span className="resume-sub">{secondaryText}</span>}
            </div>
            <div className="session-row-actions grid shrink-0 grid-cols-[64px_92px_3ch] items-center gap-1">
                <button
                    type="button"
                    aria-label={`Resume ${displayText}`}
                    aria-hidden={!isActive}
                    tabIndex={isActive ? 0 : -1}
                    data-session-action-selected={selectedAction === "resume" ? "true" : undefined}
                    disabled={isBusy || isDisabled}
                    className={cn(
                        "h-[20px] w-full cursor-pointer rounded-md px-[6px] text-[11px] transition-colors hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40",
                        !isActive && "pointer-events-none invisible",
                        selectedAction === "resume" ? "bg-accent/15 text-accent" : "text-secondary/65"
                    )}
                    onClick={(event) => {
                        event.stopPropagation();
                        onRowClick(entry.id);
                    }}
                >
                    Resume
                </button>
                {onAddContext ? (
                    <button
                        type="button"
                        aria-label={`Add ${displayText} as context`}
                        aria-hidden={!isActive}
                        tabIndex={isActive ? 0 : -1}
                        data-session-action-selected={selectedAction === "reference" ? "true" : undefined}
                        disabled={isBusy || isDisabled}
                        className={cn(
                            "h-[20px] w-full cursor-pointer rounded-md px-[6px] text-[11px] transition-colors hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40",
                            !isActive && "pointer-events-none invisible",
                            selectedAction === "reference" ? "bg-accent/15 text-accent" : "text-secondary/65"
                        )}
                        onClick={(event) => {
                            event.stopPropagation();
                            onAddContext(entry.id);
                        }}
                    >
                        Add context
                    </button>
                ) : (
                    <span />
                )}
                <span className="resume-age">{age}</span>
            </div>
        </div>
    );
});

// =========================================================================
// FlatRow — simple row for non-tree (fork) selectors
// =========================================================================

interface FlatRowProps {
    entry: AgentSelectorEntryView;
    idx: number;
    isActive: boolean;
    isBusy: boolean;
    onHover: (idx: number) => void;
    onRowClick: (id: string) => void;
    referenceBusy?: boolean;
    onReference?: (id: string, representation: AgentContextRepresentation) => void;
    isSelected?: boolean;
    isDisabled?: boolean;
    selectionMode?: boolean;
}

const FlatRow = memo(function FlatRow({
    entry,
    idx,
    isActive,
    isBusy,
    onHover,
    onRowClick,
    referenceBusy = false,
    onReference,
    isSelected = false,
    isDisabled = false,
    selectionMode = false,
}: FlatRowProps) {
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
          : (entry.type ?? "");
    return (
        <div
            id={`agent-selector-option-${encodeURIComponent(entry.id)}`}
            role="option"
            aria-label={label}
            aria-selected={selectionMode ? isSelected : isActive}
            tabIndex={isActive ? 0 : -1}
            data-agent-row-idx={idx}
            data-agent-selector-row={entry.id}
            data-agent-selector-active={isActive ? "true" : undefined}
            aria-disabled={isBusy || isDisabled || undefined}
            className={cn(
                "flex cursor-pointer select-none items-center px-3 text-left focus:outline-none",
                isActive ? "bg-fg-overlay-2/70 text-foreground" : "text-secondary/85 hover:bg-fg-overlay-1",
                selectionMode && isSelected && "bg-cyan-300/[0.10] text-foreground",
                (isBusy || isDisabled) && "pointer-events-none opacity-45"
            )}
            style={{ height: `${TREE_ROW_LINE_HEIGHT_PX}px`, textAlign: "left" }}
            onMouseEnter={() => onHover(idx)}
            onClick={() => onRowClick(entry.id)}
        >
            <div className="tree-marker" style={{ position: "relative" }}>
                {selectionMode && isSelected ? (
                    <span className="text-[12px] font-semibold text-cyan-300" aria-hidden="true">
                        ✓
                    </span>
                ) : (
                    <div className={cn("tree-diamond", `tree-diamond-${entry.role ?? "default"}`)} />
                )}
            </div>
            <div className="min-w-0 flex-1 text-left" style={{ paddingLeft: "8px", textAlign: "left" }}>
                {entry.label ? (
                    <span className="block min-w-0 truncate text-left" style={{ textAlign: "left" }}>
                        <span className="font-semibold text-foreground">{entry.label}</span>
                        <span className="text-secondary/50"> — {entry.preview}</span>
                    </span>
                ) : (
                    <span
                        className={cn("block min-w-0 truncate text-left", isActive ? "text-foreground" : roleColor)}
                        style={{ textAlign: "left" }}
                    >
                        {label}
                    </span>
                )}
            </div>
            {onReference && (
                <ReferenceActionMenu
                    label="Add reference"
                    busy={referenceBusy}
                    onSelect={(representation) => onReference(entry.id, representation)}
                />
            )}
            {selectionMode && isDisabled && <span className="ml-2 shrink-0 text-[11px] text-secondary/55">Added</span>}
            {isBusy && <span className="shrink-0 pl-2 text-secondary/60">Working…</span>}
        </div>
    );
});

const REFERENCE_REPRESENTATIONS: readonly AgentContextRepresentation[] = ["full", "summary"];

function representationLabel(value: AgentContextRepresentation): string {
    return value === "full" ? "Full" : "Summary";
}

interface ReferenceActionMenuProps {
    label: string;
    busy: boolean;
    onSelect: (representation: AgentContextRepresentation) => void;
}

function ReferenceActionMenu({ label, busy, onSelect }: ReferenceActionMenuProps) {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (busy) setOpen(false);
    }, [busy]);

    return (
        <div className="relative ml-2 shrink-0" onClick={(event) => event.stopPropagation()}>
            <button
                type="button"
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={busy}
                className="inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] text-cyan-300/85 transition-colors hover:bg-white/[0.06] hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/70 disabled:pointer-events-none disabled:opacity-50"
                onClick={() => setOpen((value) => !value)}
            >
                {busy ? "Working…" : label}
                {!busy && <ChevronDown aria-hidden="true" size={12} />}
            </button>
            {open && (
                <div
                    role="menu"
                    aria-label="Reference format"
                    className="absolute right-0 top-full z-30 mt-1 min-w-28 overflow-hidden rounded-lg border border-border/70 bg-popover p-1 shadow-xl"
                >
                    {REFERENCE_REPRESENTATIONS.map((representation) => (
                        <button
                            key={representation}
                            type="button"
                            role="menuitem"
                            className="flex min-h-7 w-full cursor-pointer items-center rounded-md px-2 text-left text-xs text-foreground transition-colors hover:bg-fg-overlay-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/70"
                            onClick={() => {
                                setOpen(false);
                                onSelect(representation);
                            }}
                        >
                            {representationLabel(representation)}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

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
    font-size: ${COMMAND_SELECTOR_ROW_FONT_PX}px;
    color: var(--foreground, #e2e8f0);
}

.tree-row {
    height: ${TREE_ROW_LINE_HEIGHT_PX}px;
    position: relative;
    border-radius: 8px;
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

.resume-row {
    height: ${TREE_ROW_LINE_HEIGHT_PX}px;
    gap: 8px;
    border-radius: 8px;
    color: rgba(226, 232, 240, 0.70);
    transition: background-color 80ms ease, color 80ms ease;
}
.resume-row-grid {
    display: grid;
    grid-template-columns: 12px 14px minmax(0, 1fr) max-content;
    align-items: center;
    column-gap: 8px;
}
.resume-row:hover {
    background: rgba(255, 255, 255, 0.04);
}
.resume-row-active {
    background: rgba(92, 184, 232, 0.08) !important;
    color: #e2e8f0;
}
.resume-cursor {
    width: 12px;
    text-align: center;
    line-height: ${TREE_ROW_LINE_HEIGHT_PX}px;
    font-size: 12px;
    font-weight: 600;
    user-select: none;
}
.resume-cursor-on {
    color: #5cb8e8;
    text-shadow: 0 0 6px rgba(92, 184, 232, 0.5);
}
.resume-cursor-off {
    color: transparent;
}
.resume-marker {
    display: flex;
    width: 14px;
    height: ${TREE_ROW_LINE_HEIGHT_PX}px;
    align-items: center;
    justify-content: center;
}
.resume-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
}
.resume-dot-default {
    background: rgba(148, 163, 184, 0.45);
}
.resume-dot-named {
    background: #f0b429;
    box-shadow: 0 0 4px rgba(240, 180, 41, 0.4);
}
.resume-row-active .resume-dot-default {
    background: rgba(92, 184, 232, 0.7);
}
.resume-body {
    display: flex;
    overflow: hidden;
    align-items: baseline;
    gap: 8px;
    line-height: ${TREE_ROW_LINE_HEIGHT_PX}px;
}
.resume-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.resume-named {
    color: #f0b429;
    font-weight: 500;
}
.resume-row-active .resume-named {
    color: #f5c959;
}
.resume-msg {
    color: rgba(226, 232, 240, 0.82);
}
.resume-sub {
    max-width: 40%;
    flex-shrink: 0;
    overflow: hidden;
    color: rgba(148, 163, 184, 0.40);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.resume-age {
    min-width: 3ch;
    color: rgba(148, 163, 184, 0.45);
    font-size: 11px;
    line-height: ${TREE_ROW_LINE_HEIGHT_PX}px;
    text-align: right;
}
.resume-row-active .resume-age {
    color: rgba(92, 184, 232, 0.70);
}

`;
