// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/app/icon/Icon";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { useWaveEnv, WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { fireAndForget, useAtomValueSafe } from "@/util/util";
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
import "./workspaceswitcher.scss";

export type WorkspaceSwitcherEnv = WaveEnvSubset<{
    electron: {
        deleteWorkspace: WaveEnv["electron"]["deleteWorkspace"];
        createWorkspace: WaveEnv["electron"]["createWorkspace"];
        selectDirectory: WaveEnv["electron"]["selectDirectory"];
        switchWorkspace: WaveEnv["electron"]["switchWorkspace"];
    };
    atoms: {
        workspace: WaveEnv["atoms"]["workspace"];
    };
    services: {
        workspace: WaveEnv["services"]["workspace"];
    };
}>;

type WorkspaceListEntry = {
    windowId: string;
    workspace: Workspace;
};

const WorkspaceMapAtom = atom<WorkspaceListEntry[]>([]);
const DefaultPillName = "Default";

export const LoadingTabLabel = "...";

export function getFallbackFileBadgeLabel(ext: string): string {
    return ext.slice(0, 2).toUpperCase() || "--";
}

const WorkspaceSwitcher = forwardRef<HTMLDivElement>((_, ref) => {
    const env = useWaveEnv<WorkspaceSwitcherEnv>();
    const setWorkspaceList = useSetAtom(WorkspaceMapAtom);
    const activeWorkspace = useAtomValueSafe(env.atoms.workspace);
    const workspaceList = useAtomValue(WorkspaceMapAtom);
    const [isOpen, setIsOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);

    const updateWorkspaceList = useCallback(async () => {
        const list = await env.services.workspace.ListWorkspaces();
        if (!list) {
            return;
        }
        const next = await Promise.all(
            list.map(async (entry) => ({
                windowId: entry.windowid,
                workspace: await env.services.workspace.GetWorkspace(entry.workspaceid),
            }))
        );
        setWorkspaceList(next);
    }, [env.services.workspace, setWorkspaceList]);

    useEffect(
        () =>
            waveEventSubscribeSingle({
                eventType: "workspace:update",
                handler: () => fireAndForget(updateWorkspaceList),
            }),
        [updateWorkspaceList]
    );
    useEffect(() => {
        fireAndForget(updateWorkspaceList);
    }, [updateWorkspaceList]);

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
            if (dir) {
                env.electron.createWorkspace(dir);
            }
        });
        setIsOpen(false);
    }, [env.electron]);

    const onCommitRename = useCallback(
        (workspaceId: string, name: string) => {
            const trimmed = name.trim();
            setEditingId(null);
            const current = workspaceList.find((entry) => entry.workspace.oid === workspaceId)?.workspace.name;
            if (!trimmed || trimmed === current) {
                return;
            }
            fireAndForget(() => env.services.workspace.UpdateWorkspace(workspaceId, trimmed, "", "", false));
        },
        [env.services.workspace, workspaceList]
    );

    const { refs, floatingStyles, context } = useFloating({
        open: isOpen,
        onOpenChange: (open) => {
            setIsOpen(open);
            if (open) {
                fireAndForget(updateWorkspaceList);
            }
        },
        placement: "bottom-start",
        middleware: [offsetMiddleware(6)],
        whileElementsMounted: autoUpdate,
    });
    const click = useClick(context);
    const dismiss = useDismiss(context);
    const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);
    const pillName = activeWorkspace?.name?.trim() || DefaultPillName;

    return (
        <div ref={ref} className="workspace-switcher-popover">
            <button
                ref={refs.setReference}
                type="button"
                className={`workspace-switcher-pill ${isOpen ? "is-active" : ""}`}
                title="Spaces"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                {...getReferenceProps()}
            >
                <span className="workspace-switcher-pill-name">{pillName}</span>
                <Icon name="chevron-right" size={14} strokeWidth={1.75} className="workspace-switcher-pill-chevron" />
            </button>
            {isOpen ? (
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
                        <div className="workspace-switcher-list">
                            {workspaceList.map((entry) => (
                                <SpaceRow
                                    key={entry.workspace.oid}
                                    workspace={entry.workspace}
                                    active={entry.workspace.oid === activeWorkspace?.oid}
                                    canDelete={workspaceList.length > 1}
                                    editing={editingId === entry.workspace.oid}
                                    onSwitch={() => onSwitch(entry.workspace.oid)}
                                    onDelete={() => env.electron.deleteWorkspace(entry.workspace.oid)}
                                    onStartRename={() => setEditingId(entry.workspace.oid)}
                                    onCommitRename={(name) => onCommitRename(entry.workspace.oid, name)}
                                    onCancelRename={() => setEditingId(null)}
                                />
                            ))}
                        </div>
                        <div className="workspace-switcher-footer">
                            <button type="button" onClick={onNewSpace} className="workspace-switcher-new">
                                <Icon name="add-01" size={14} strokeWidth={1.75} />
                                <span>New space</span>
                            </button>
                        </div>
                    </div>
                </FloatingPortal>
            ) : null}
        </div>
    );
});
WorkspaceSwitcher.displayName = "WorkspaceSwitcher";

function SpaceRow({
    workspace,
    active,
    canDelete,
    editing,
    onSwitch,
    onDelete,
    onStartRename,
    onCommitRename,
    onCancelRename,
}: {
    workspace: Workspace;
    active: boolean;
    canDelete: boolean;
    editing: boolean;
    onSwitch: () => void;
    onDelete: () => void;
    onStartRename: () => void;
    onCommitRename: (name: string) => void;
    onCancelRename: () => void;
}) {
    return (
        <div className={`workspace-switcher-row ${active ? "is-active" : ""} ${editing ? "is-editing" : ""}`}>
            <div className="workspace-switcher-row-header">
                <button type="button" onClick={onSwitch} className="workspace-switcher-main">
                    {editing ? (
                        <InlineRename initial={workspace.name || ""} onCommit={onCommitRename} onCancel={onCancelRename} />
                    ) : (
                        <span className="workspace-switcher-name">{workspace.name || "Untitled"}</span>
                    )}
                </button>
                <div className="workspace-switcher-actions">
                    <button type="button" title="Rename" aria-label="Rename" onClick={onStartRename} className="workspace-switcher-action">
                        <Icon name="edit-02" size={12} strokeWidth={1.75} />
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
        </div>
    );
}

function InlineRename({
    initial,
    onCommit,
    onCancel,
}: {
    initial: string;
    onCommit: (value: string) => void;
    onCancel: () => void;
}) {
    const ref = useRef<HTMLInputElement>(null);
    const done = useRef(false);
    useEffect(() => {
        const raf = requestAnimationFrame(() => {
            ref.current?.focus();
            ref.current?.select();
        });
        return () => cancelAnimationFrame(raf);
    }, []);
    const finish = (callback: () => void) => {
        if (done.current) {
            return;
        }
        done.current = true;
        callback();
    };
    return (
        <input
            ref={ref}
            type="text"
            defaultValue={initial}
            aria-label="Rename space"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                    event.preventDefault();
                    finish(() => onCommit(event.currentTarget.value));
                } else if (event.key === "Escape") {
                    event.preventDefault();
                    finish(onCancel);
                }
            }}
            onBlur={(event) => {
                if (document.hasFocus()) {
                    finish(() => onCommit(event.currentTarget.value));
                }
            }}
            className="workspace-switcher-rename-input"
        />
    );
}

export { WorkspaceSwitcher };
