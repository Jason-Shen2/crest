// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// File explorer — header (h-8) + tree body.
//
// Header layout (1:1 with terax-ai FileExplorer.tsx):
//   ┌──────────────────────────────────────────────────────┐
//   │ [folder] <dir name>            [+F] [+D] [×]        │
//   └──────────────────────────────────────────────────────┘
//   - Left:  flex flex-1, 14px muted folder glyph + text-xs
//            font-medium text-foreground/80 dir name; truncate +
//            title={root} so the full path surfaces on hover.
//   - Right: three 24px (size-6) square buttons, muted →
//            hover:text-foreground + hover:bg-white/[0.06].
//            Same vocabulary as WorkspaceSwitcher popover actions.
//   - h-8 (32px) to stay in rhythm with the topbar h-9 (~36px) —
//     terax uses h-8 (32px) here, crest follows.
//
// Right-side buttons:
//   - New File / New Folder: route through FileExplorerModel
//     (which handles the input row + cancel).
//   - Close: hides the file panel via WorkspaceLayoutModel.
//     The topbar's "Toggle File Explorer" button is a switch,
//     not a dismiss; the right-corner × is the conventional
//     file-panel pattern (matches the existing close affordance
//     in Wave / VSCode-style panels) and stays.

import { Icon } from "@/app/icon/Icon";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { useAtomValue } from "jotai";
import { memo, useEffect, useRef, useState } from "react";
import { getCachedHome, workspaceDirAtom } from "./file-explorer-atoms";
import { FileExplorerModel } from "./file-explorer-model";
import type { FileExplorerWorkspaceActions } from "./file-explorer-workspace-actions";
import { FileExplorerTree } from "./file-explorer-tree";

function basename(path: string): string {
    if (path == null || path.length === 0) return "";
    const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
    const idx = trimmed.lastIndexOf("/");
    if (idx < 0) return trimmed;
    const tail = trimmed.slice(idx + 1);
    return tail.length > 0 ? tail : trimmed;
}

function prettyRoot(path: string): string {
    const home = getCachedHome();
    if (path === home) return "~";
    if (home && path.startsWith(home + "/")) return "~/" + basename(path);
    return basename(path) || path;
}

export const FileExplorer = memo(({ workspaceActions }: { workspaceActions: FileExplorerWorkspaceActions }) => {
    const model = FileExplorerModel.getInstance();
    const root = useAtomValue(model.rootAtom);
    const cwd = useAtomValue(workspaceDirAtom);
    const [isTreeScrolling, setIsTreeScrolling] = useState(false);
    const treeScrollIdleTimerRef = useRef<number>(0);

    useEffect(() => {
        return model.bindWorkspaceActions(workspaceActions);
    }, [model, workspaceActions]);

    useEffect(() => {
        if (!cwd) return;
        if (cwd !== model.getRootNow()) model.setRoot(cwd);
    }, [cwd]);

    useEffect(() => {
        return () => window.clearTimeout(treeScrollIdleTimerRef.current);
    }, []);

    const onNewFile = () => model.startNewFile(root);
    const onNewFolder = () => model.startNewFolder(root);

    const onClose = () => {
        WorkspaceLayoutModel.getInstance().toggleLeftPanel("files");
    };

    const onTreeScroll = () => {
        setIsTreeScrolling(true);
        window.clearTimeout(treeScrollIdleTimerRef.current);
        treeScrollIdleTimerRef.current = window.setTimeout(() => setIsTreeScrolling(false), 650);
    };

    return (
        <div className="flex flex-col h-full w-full bg-card text-primary overflow-hidden border-r border-border/60">
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Icon name="folder-01" size={14} className="shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-medium text-foreground/80" title={root}>
                        {prettyRoot(root)}
                    </span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    <button
                        type="button"
                        title="New File"
                        onClick={onNewFile}
                        className="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
                    >
                        <Icon name="file-plus" size={14} strokeWidth={1.75} />
                    </button>
                    <button
                        type="button"
                        title="New Folder"
                        onClick={onNewFolder}
                        className="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
                    >
                        <Icon name="folder-01" size={14} strokeWidth={1.75} />
                    </button>
                    <button
                        type="button"
                        title="Close"
                        onClick={onClose}
                        className="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
                    >
                        <Icon name="cancel-01" size={14} strokeWidth={1.75} />
                    </button>
                </div>
            </div>
            <div
                className="file-explorer-scroll flex-grow overflow-auto"
                data-scrolling={isTreeScrolling ? "true" : "false"}
                onScroll={onTreeScroll}
            >
                <FileExplorerTree />
            </div>
        </div>
    );
});

FileExplorer.displayName = "FileExplorer";
