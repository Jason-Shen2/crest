// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// WorkspaceSwitcher follows terax-ai's SpaceSwitcher pattern:
// one trigger pill, one popover listing spaces, and indented tab rows under
// the expanded active space. Keep rendered labels ASCII-safe because stale
// bundles have shown mojibake for symbol glyphs in this menu.

import { Icon } from "@/app/icon/Icon";
import { getIconByName } from "@/app/icon/icon-registry";
import { useWaveEnv, WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { fireAndForget, useAtomValueSafe } from "@/util/util";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import {
    autoUpdate,
    FloatingPortal,
    offset as offsetMiddleware,
    useClick,
    useDismiss,
    useFloating,
    useInteractions,
} from "@floating-ui/react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import "./workspaceswitcher.scss";

export type WorkspaceSwitcherEnv = WaveEnvSubset<{
    electron: {
        deleteWorkspace: WaveEnv["electron"]["deleteWorkspace"];
        createWorkspace: WaveEnv["electron"]["createWorkspace"];
        selectDirectory: WaveEnv["electron"]["selectDirectory"];
        switchWorkspace: WaveEnv["electron"]["switchWorkspace"];
        setActiveTab: WaveEnv["electron"]["setActiveTab"];
        closeTab: WaveEnv["electron"]["closeTab"];
    };
    atoms: {
        workspace: WaveEnv["atoms"]["workspace"];
    };
    services: {
        workspace: WaveEnv["services"]["workspace"];
    };
    wos: WaveEnv["wos"];
}>;

type WorkspaceListEntry = {
    windowId: string;
    workspace: Workspace;
};
type WorkspaceList = WorkspaceListEntry[];
const workspaceMapAtom = atom<WorkspaceList>([]);

export const LoadingTabLabel = "...";
const DEFAULT_PILL_NAME = "Default";

export function getFallbackFileBadgeLabel(ext: string): string {
    return ext.slice(0, 2).toUpperCase() || "--";
}

// File-type badge for the preview/codeedit view.  Restricted palette
// per the user's "color budget is tight" rule - five common types
// get accent text, the rest fall back to a neutral gray badge with
// a 2-letter extension.
const FILE_TYPE_BADGE: Record<string, { label: string; color: string }> = {
    ts: { label: "TS", color: "#3178c6" },
    tsx: { label: "TS", color: "#3178c6" },
    js: { label: "JS", color: "#f1e05a" },
    jsx: { label: "JS", color: "#f1e05a" },
    go: { label: "GO", color: "#00add8" },
    rs: { label: "RS", color: "#dea584" },
    py: { label: "PY", color: "#3572a5" },
};

function getFileBadge(file?: string) {
    if (!file) return null;
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    return FILE_TYPE_BADGE[ext] ?? { label: getFallbackFileBadgeLabel(ext), color: "rgba(255,255,255,0.45)" };
}

function getLastTwoPathSegs(path?: string): string | null {
    if (!path) return null;
    const segs = path.split(/[\\/]/).filter(Boolean);
    if (segs.length === 0) return null;
    if (segs.length === 1) return segs[0];
    return segs.slice(-2).join("/");
}

function getParentDirBasename(path?: string): string | null {
    if (!path) return null;
    const segs = path.split(/[\\/]/).filter(Boolean);
    if (segs.length <= 1) return null;
    return segs[segs.length - 2];
}

function getFileBasename(path?: string): string | null {
    if (!path) return null;
    const segs = path.split(/[\\/]/).filter(Boolean);
    return segs[segs.length - 1] ?? null;
}

function getUrlHost(url?: string): string | null {
    if (!url) return null;
    try {
        return new URL(url).host || null;
    } catch {
        return null;
    }
}

type TabInfo = {
    tabId: string;
    label: string;
    subtitle: string | null;
    iconKind: "folder" | "term" | "file" | "globe" | "file-badge";
    fileBadge: { label: string; color: string } | null;
    view: string;
};

function deriveTabInfo(tab: Tab | null, block: Block | null): TabInfo | null {
    if (!tab) return null;
    const meta = block?.meta ?? {};
    const file = meta.file;
    const cwd = meta["cmd:cwd"];
    const url = meta.url;
    const view = meta.view ?? "";
    const blockKind = meta["block:kind"];

    // Folder tab (flagged by openInNewTab) - folder icon, dir name,
    // cwd subtitle.
    if (blockKind === "folder") {
        const cwdPath = cwd ?? file;
        return {
            tabId: tab.oid,
            label: getFileBasename(cwdPath) ?? tab.name ?? "Folder",
            subtitle: getLastTwoPathSegs(cwdPath),
            iconKind: "folder",
            fileBadge: null,
            view,
        };
    }
    // Editor / preview with a file path.
    if (file && (view === "preview" || view === "codeedit")) {
        const ext = file.split(".").pop()?.toLowerCase() ?? "";
        const badge = getFileBadge(file);
        const useBadge = !!FILE_TYPE_BADGE[ext];
        return {
            tabId: tab.oid,
            label: getFileBasename(file) ?? tab.name ?? "File",
            subtitle: getParentDirBasename(file),
            iconKind: useBadge ? "file-badge" : "file",
            fileBadge: badge,
            view,
        };
    }
    // Web.
    if (view === "web" || url) {
        return {
            tabId: tab.oid,
            label: getUrlHost(url) ?? tab.name ?? "Web",
            subtitle: url ?? null,
            iconKind: "globe",
            fileBadge: null,
            view,
        };
    }
    // Terminal (default when "cmd:cwd" is set or no view).
    return {
        tabId: tab.oid,
        label: tab.name ?? "Terminal",
        subtitle: getLastTwoPathSegs(cwd),
        iconKind: "term",
        fileBadge: null,
        view,
    };
}

const WorkspaceSwitcher = forwardRef<HTMLDivElement>((_, ref) => {
    const env = useWaveEnv<WorkspaceSwitcherEnv>();
    const setWorkspaceList = useSetAtom(workspaceMapAtom);
    const activeWorkspace = useAtomValueSafe(env.atoms.workspace);
    const workspaceList = useAtomValue(workspaceMapAtom);
    const [isOpen, setIsOpen] = useState(false);
    const [expandedIds, setExpandedIds] = useState<Set<string>>(
        () => new Set(activeWorkspace?.oid ? [activeWorkspace.oid] : [])
    );
    // Single-row rename: only one InlineRename input is open at a time.
    // Matches terax-ai's SpaceSwitcher pattern (single editingId state
    // at the parent, not per-row).
    const [editingId, setEditingId] = useState<string | null>(null);

    const updateWorkspaceList = useCallback(async () => {
        const list = await env.services.workspace.ListWorkspaces();
        if (!list) return;
        const next: WorkspaceList = [];
        for (const entry of list) {
            globalStore.get(env.wos.getWaveObjectAtom(makeORef("workspace", entry.workspaceid)));
            next.push({
                windowId: entry.windowid,
                workspace: await env.services.workspace.GetWorkspace(entry.workspaceid),
            });
        }
        setWorkspaceList(next);
    }, []);

    useEffect(
        () =>
            waveEventSubscribeSingle({
                eventType: "workspace:update",
                handler: () => fireAndForget(updateWorkspaceList),
            }),
        []
    );
    useEffect(() => {
        fireAndForget(updateWorkspaceList);
    }, []);

    useEffect(() => {
        if (isOpen && activeWorkspace?.oid) {
            setExpandedIds(new Set([activeWorkspace.oid]));
        }
    }, [isOpen, activeWorkspace?.oid]);

    const toggleExpand = useCallback((id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const onSwitch = useCallback(
        (workspaceId: string) => {
            env.electron.switchWorkspace(workspaceId);
            setIsOpen(false);
        },
        [env.electron]
    );

    const onNewSpace = useCallback(() => {
        fireAndForget(async () => {
            const dir = await env.electron.selectDirectory();
            if (!dir) return;
            env.electron.createWorkspace(dir);
        });
        setIsOpen(false);
    }, [env.electron]);

    const onDelete = useCallback(
        (workspaceId: string) => {
            fireAndForget(async () => {
                env.electron.deleteWorkspace(workspaceId);
            });
        },
        [env.electron]
    );

    const onCommitRename = useCallback(
        (workspaceId: string, name: string) => {
            const trimmed = name.trim();
            setEditingId(null);
            // Empty input cancels (terax semantics — same as Escape).
            // Skip the roundtrip when nothing actually changed.
            const current = workspaceList.find((e) => e.workspace.oid === workspaceId)?.workspace.name;
            if (!trimmed || trimmed === current) return;
            fireAndForget(async () => {
                // Pass "" for icon/color and applyDefaults=false so the
                // server keeps the workspace's existing icon/color
                // (UpdateWorkspace only writes when the field is non-empty
                // AND applyDefaults is false doesn't clobber the rest).
                await env.services.workspace.UpdateWorkspace(workspaceId, trimmed, "", "", false);
            });
        },
        [env.services.workspace, workspaceList]
    );

    const onJumpTab = useCallback(
        (workspaceId: string, tabId: string) => {
            // Switch workspace (if not current) then set active tab.
            if (activeWorkspace?.oid !== workspaceId) {
                env.electron.switchWorkspace(workspaceId);
            }
            env.electron.setActiveTab(tabId);
            setIsOpen(false);
        },
        [env.electron, activeWorkspace?.oid]
    );

    const onCloseTab = useCallback(
        (workspaceId: string, tabId: string) => {
            // closeTab signature in crest: (workspaceId, tabId, confirmClose).
            // confirmClose isn't surfaced into the switcher - pass false
            // to skip the prompt.  Users can confirm via the tab strip.
            fireAndForget(async () => {
                await env.electron.closeTab(workspaceId, tabId, false);
            });
        },
        [env.electron]
    );

    const pillName = activeWorkspace?.name?.trim() || DEFAULT_PILL_NAME;
    const canDeleteAny = workspaceList.length > 1;

    // Bypass <PopoverButton>: it renders a `<Button>` that injects
    // `wave-button.solid.grey` (specificity beats `.workspace-switcher-pill`,
    // turning the trigger into a generic grey button that's visually wrong
    // and click-handling-confused).  Drive floating-ui ourselves with a real
    // <button> so the pill styles apply cleanly and the trigger is clickable.
    const { refs, floatingStyles, context } = useFloating({
        open: isOpen,
        onOpenChange: (open: boolean) => {
            setIsOpen(open);
            if (open) fireAndForget(updateWorkspaceList);
        },
        placement: "bottom-start",
        middleware: [offsetMiddleware(6)],
        whileElementsMounted: autoUpdate,
    });
    const click = useClick(context);
    const dismiss = useDismiss(context);
    const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);

    return (
        <div ref={ref} className="workspace-switcher-popover">
            <button
                ref={refs.setReference}
                type="button"
                className={`workspace-switcher-pill ${isOpen ? "is-active" : ""}`}
                title="Spaces"
                style={{
                    // topbar-root sets -webkit-app-region: drag; without an
                    // explicit "no-drag" override the button swallows clicks
                    // for window dragging instead of toggling the popover.
                    WebkitAppRegion: "no-drag",
                } as React.CSSProperties}
                {...getReferenceProps()}
            >
                <span className="workspace-switcher-pill-name">{pillName}</span>
                <Icon
                    name="chevron-right"
                    size={14}
                    strokeWidth={1.75}
                    className="workspace-switcher-pill-chevron"
                />
            </button>
            {isOpen && (
                <FloatingPortal>
                    <div
                        ref={refs.setFloating}
                        className="workspace-switcher-content"
                        style={floatingStyles}
                        {...getFloatingProps()}
                    >
                        <div className="workspace-switcher-header">
                    <span className="workspace-switcher-title">Spaces</span>
                </div>
                <OverlayScrollbarsComponent
                    className="workspace-switcher-scrollable"
                    options={{ scrollbars: { autoHide: "leave" } }}
                >
                    <div className="workspace-switcher-list">
                        {workspaceList.map((entry) => {
                            const w = entry.workspace;
                            const isActive = activeWorkspace?.oid === w.oid;
                            return (
                                <SpaceRow
                                    key={w.oid}
                                    workspace={w}
                                    isActive={isActive}
                                    expanded={expandedIds.has(w.oid)}
                                    canDelete={canDeleteAny}
                                    editing={editingId === w.oid}
                                    onToggleExpand={() => toggleExpand(w.oid)}
                                    onSwitch={() => onSwitch(w.oid)}
                                    onDelete={() => onDelete(w.oid)}
                                    onStartRename={() => setEditingId(w.oid)}
                                    onCommitRename={(name) => onCommitRename(w.oid, name)}
                                    onCancelRename={() => setEditingId(null)}
                                    onJumpTab={(tabId) => onJumpTab(w.oid, tabId)}
                                    onCloseTab={(tabId) => onCloseTab(w.oid, tabId)}
                                />
                            );
                        })}
                    </div>
                </OverlayScrollbarsComponent>
                        <div className="workspace-switcher-footer">
                            <button type="button" onClick={onNewSpace} className="workspace-switcher-new">
                                <Icon name="add-01" size={14} strokeWidth={1.75} />
                                <span>New space</span>
                            </button>
                        </div>
                    </div>
                </FloatingPortal>
            )}
        </div>
    );
});
WorkspaceSwitcher.displayName = "WorkspaceSwitcher";

// ---------------------------------------------------------------------------
// SpaceRow - caret + avatar + name + actions + (optional)
//            expanded TabRow list.
// ---------------------------------------------------------------------------

function SpaceRow({
    workspace,
    isActive,
    expanded,
    canDelete,
    editing,
    onToggleExpand,
    onSwitch,
    onDelete,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onJumpTab,
    onCloseTab,
}: {
    workspace: Workspace;
    isActive: boolean;
    expanded: boolean;
    canDelete: boolean;
    editing: boolean;
    onToggleExpand: () => void;
    onSwitch: () => void;
    onDelete: () => void;
    onStartRename: () => void;
    onCommitRename: (name: string) => void;
    onCancelRename: () => void;
    onJumpTab: (tabId: string) => void;
    onCloseTab: (tabId: string) => void;
}) {
    const color = workspace.color || "#7c3aed";
    return (
        <div className={`workspace-switcher-row ${isActive ? "is-active" : ""} ${editing ? "is-editing" : ""}`}>
            <div className="workspace-switcher-row-header">
                <button
                    type="button"
                    onClick={onToggleExpand}
                    className="workspace-switcher-caret"
                    aria-label={expanded ? "Collapse" : "Expand"}
                >
                    <Icon
                        name={expanded ? "chevron-down" : "chevron-right"}
                        size={12}
                        strokeWidth={1.75}
                        className="opacity-60"
                    />
                </button>
                <button type="button" onClick={onSwitch} className="workspace-switcher-main">
                    <SpaceAvatar workspace={workspace} color={color} />
                    {editing ? (
                        <InlineRename
                            initial={workspace.name || ""}
                            onCommit={onCommitRename}
                            onCancel={onCancelRename}
                        />
                    ) : (
                        <span className="workspace-switcher-name">{workspace.name || "Untitled"}</span>
                    )}
                </button>
                <div className="workspace-switcher-actions">
                        <button
                            type="button"
                            title="Rename"
                            aria-label="Rename"
                            onClick={onStartRename}
                            className="workspace-switcher-action"
                        >
                            <Icon name="edit-02" size={12} strokeWidth={1.75} />
                        </button>
                        <button
                            type="button"
                            title="New tab"
                            aria-label="New tab"
                            className="workspace-switcher-action"
                        >
                            <Icon name="add-01" size={12} strokeWidth={1.75} />
                        </button>
                        <button
                            type="button"
                            title={canDelete ? "Delete" : "Can't delete the last space"}
                            aria-label="Delete"
                            disabled={!canDelete}
                            onClick={onDelete}
                            className="workspace-switcher-action"
                        >
                            <Icon name="cancel-01" size={12} strokeWidth={1.75} />
                        </button>
                </div>
            </div>
            {expanded ? <TabList workspace={workspace} onJump={onJumpTab} onClose={onCloseTab} /> : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// InlineRename - single-line input that replaces the workspace name span
// when the user clicks the row's pencil icon.  Mirrors terax-ai's
// InlineRename contract: focus + select-all on mount, Enter commits,
// Escape cancels, blur commits.  See .workspace-switcher-rename-input
// for the styled appearance.
// ---------------------------------------------------------------------------

function InlineRename({
    initial,
    onCommit,
    onCancel,
    className,
}: {
    initial: string;
    onCommit: (value: string) => void;
    onCancel: () => void;
    className?: string;
}) {
    const ref = useRef<HTMLInputElement>(null);
    const done = useRef(false);

    useEffect(() => {
        // requestAnimationFrame so the input is in the DOM before we
        // focus — mirrors terax's pattern, and avoids a race where
        // `focus()` runs against a still-unmounted node.
        const raf = requestAnimationFrame(() => {
            ref.current?.focus();
            ref.current?.select();
        });
        return () => cancelAnimationFrame(raf);
    }, []);

    const finish = (fn: () => void) => {
        if (done.current) return;
        done.current = true;
        fn();
    };

    return (
        <input
            ref={ref}
            type="text"
            defaultValue={initial}
            aria-label="Rename space"
            spellCheck={false}
            autoComplete="off"
            // Stop the row's onClick (which would switch workspaces) from
            // firing while the user is typing.
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                    e.preventDefault();
                    finish(() => onCommit(e.currentTarget.value));
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    finish(onCancel);
                }
            }}
            onBlur={(e) => {
                // Skip blur-commit when the window itself is losing focus
                // (terax pattern) — otherwise alt-tabbing away would
                // commit a half-typed name.
                if (!document.hasFocus()) return;
                finish(() => onCommit(e.currentTarget.value));
            }}
            className={`workspace-switcher-rename-input ${className ?? ""}`}
        />
    );
}

// ---------------------------------------------------------------------------
// TabList - fetches each tab + its first block, renders one TabRow per tab.
// Indented to align with the avatar column (40px from row left edge).
// ---------------------------------------------------------------------------

function TabList({
    workspace,
    onJump,
    onClose,
}: {
    workspace: Workspace;
    onJump: (tabId: string) => void;
    onClose: (tabId: string) => void;
}) {
    const tabIds = workspace.tabids ?? [];
    if (tabIds.length === 0) {
        return <div className="workspace-switcher-tab-empty">No tabs</div>;
    }
    return (
        <div className="workspace-switcher-tab-list">
            {tabIds.map((tabId) => (
                <TabRow key={tabId} tabId={tabId} onJump={() => onJump(tabId)} onClose={() => onClose(tabId)} />
            ))}
        </div>
    );
}

function TabRow({ tabId, onJump, onClose }: { tabId: string; onJump: () => void; onClose: () => void }) {
    const env = useWaveEnv<WorkspaceSwitcherEnv>();
    // Tap the waveobject atoms so they sync; use the underlying
    // getter so the component re-renders when the waveobj is updated.
    const tab = useAtomValue(env.wos.getWaveObjectAtom(makeORef("tab", tabId))) as Tab | null;
    const firstBlockId = tab?.blockids?.[0];
    const block = useAtomValue(
        env.wos.getWaveObjectAtom(makeORef("block", firstBlockId ?? ""))
    ) as Block | null;
    const info = deriveTabInfo(tab, block);
    if (!info) {
        return (
            <div className="workspace-switcher-tab-row workspace-switcher-tab-loading">
                <span className="workspace-switcher-tab-icon" />
                <span className="workspace-switcher-tab-label">{LoadingTabLabel}</span>
            </div>
        );
    }
    return (
        <div className="workspace-switcher-tab-row" onClick={onJump}>
            <TabIcon info={info} />
            <span className="workspace-switcher-tab-meta">
                <span className="workspace-switcher-tab-label">{info.label}</span>
                {info.subtitle ? (
                    <span className="workspace-switcher-tab-subtitle">{info.subtitle}</span>
                ) : null}
            </span>
            <button
                type="button"
                title="Close tab"
                aria-label="Close tab"
                className="workspace-switcher-tab-close"
                onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                }}
            >
                <Icon name="cancel-01" size={11} strokeWidth={2} />
            </button>
        </div>
    );
}

function TabIcon({ info }: { info: TabInfo }) {
    if (info.iconKind === "file-badge" && info.fileBadge) {
        return (
            <span
                className="workspace-switcher-tab-badge"
                style={{ color: info.fileBadge.color, borderColor: `${info.fileBadge.color}55` }}
            >
                {info.fileBadge.label}
            </span>
        );
    }
    if (info.iconKind === "folder") {
        return <Icon name="folder-01" size={14} strokeWidth={1.75} className="workspace-switcher-tab-icon" />;
    }
    if (info.iconKind === "term") {
        return <Icon name="computer-terminal-02" size={14} strokeWidth={1.75} className="workspace-switcher-tab-icon" />;
    }
    if (info.iconKind === "globe") {
        return <Icon name="globe-02" size={14} strokeWidth={1.75} className="workspace-switcher-tab-icon" />;
    }
    // file (default - generic preview/file icon)
    return <Icon name="file-01" size={14} strokeWidth={1.75} className="workspace-switcher-tab-icon" />;
}

// ---------------------------------------------------------------------------
// SpaceAvatar - 20x20 rounded square with workspace color tint.
// 18% alpha bg + 32% inner border, mirrors terax SpaceAvatar.
// Renders the workspace icon if set, else the first letter of the
// name.  Letter color uses the workspace color (not pure white) so
// colored spaces read as "this is mine" at a glance.
// ---------------------------------------------------------------------------

function SpaceAvatar({ workspace, color }: { workspace: Workspace; color: string }) {
    const name = workspace.name?.trim() || "Untitled";
    const initial = name.charAt(0).toUpperCase();
    // Workspace icon strings live in the Go data layer and historically
    // used FontAwesome Kit custom glyphs ("custom@wave-logo-solid",
    // "triangle", "solid@cloud", ...).  The new Hugeicons-based <Icon>
    // renderer doesn't know those, so we look the name up first and fall
    // back to the first letter when it isn't registered.  Checking here
    // (instead of letting <Icon> warn and render nothing) keeps the
    // dev console clean and avoids a blank avatar for legacy data.
    const hasValidIcon = !!workspace.icon && getIconByName(workspace.icon) != null;
    return (
        <div
            className="workspace-switcher-avatar"
            style={{
                backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
                boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 32%, transparent)`,
            }}
        >
            {hasValidIcon ? (
                <Icon name={workspace.icon} size={11} strokeWidth={2} style={{ color }} />
            ) : (
                <span className="workspace-switcher-avatar-initial" style={{ color }}>
                    {initial}
                </span>
            )}
        </div>
    );
}

export { WorkspaceSwitcher };
