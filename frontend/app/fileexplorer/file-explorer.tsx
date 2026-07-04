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
import { memo, useEffect } from "react";
import { focusedBlockCwdAtom, getCachedHome } from "./file-explorer-atoms";
import { FileExplorerModel } from "./file-explorer-model";
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

export const FileExplorer = memo(() => {
    const model = FileExplorerModel.getInstance();
    const root = useAtomValue(model.rootAtom);
    const { tabId, blockId, cwd } = useAtomValue(focusedBlockCwdAtom);

    useEffect(() => {
        if (!cwd) return;
        if (cwd !== model.getRootNow()) model.setRoot(cwd);
    }, [tabId, blockId, cwd]);

    const onNewFile = () => model.startNewFile(root);
    const onNewFolder = () => model.startNewFolder(root);

    const onClose = () => {
        WorkspaceLayoutModel.getInstance().setFileExplorerVisible(false);
    };

    return (
        <div className="flex flex-col h-full w-full bg-black/20 text-primary overflow-hidden">
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-white/10 px-2">
                {/* Left: folder glyph + dir name.  flex-1 + min-w-0 lets
                    the name truncate when the panel narrows; the title
                    attribute keeps the full path discoverable on hover. */}
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Icon name="folder-01" size={14} className="shrink-0 text-white/45" />
                    <span className="truncate text-xs font-medium text-foreground/80" title={root}>
                        {prettyRoot(root)}
                    </span>
                </div>
                {/* Right: 24px square buttons.  size-6 + rounded-md + muted
                    → hover pair is the same vocabulary used in the
                    WorkspaceSwitcher popover action rows, so they read
                    as a single design system across the app. */}
                <div className="flex shrink-0 items-center gap-0.5">
                    <button
                        type="button"
                        title="New File"
                        onClick={onNewFile}
                        className="grid size-6 cursor-pointer place-items-center rounded-md text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white"
                    >
                        <Icon name="file-plus" size={14} strokeWidth={1.75} />
                    </button>
                    <button
                        type="button"
                        title="New Folder"
                        onClick={onNewFolder}
                        className="grid size-6 cursor-pointer place-items-center rounded-md text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white"
                    >
                        <Icon name="folder-01" size={14} strokeWidth={1.75} />
                    </button>
                    <button
                        type="button"
                        title="Close"
                        onClick={onClose}
                        className="grid size-6 cursor-pointer place-items-center rounded-md text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white"
                    >
                        <Icon name="cancel-01" size={14} strokeWidth={1.75} />
                    </button>
                </div>
            </div>
            <div className="flex-grow overflow-auto">
                <FileExplorerTree />
            </div>
        </div>
    );
});

FileExplorer.displayName = "FileExplorer";
