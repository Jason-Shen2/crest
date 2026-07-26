// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentViewModel — the "agent" block form.  Mounts the agent surface (chat
// host / session selector / composer) via WorkspaceAgentSurface.  The agent
// view has never rendered terminal content; it previously mounted the old
// TerminalView purely as a chrome/TerminalModel host, so with that engine
// replaced by frontend/app/xterm/ this file hosts the surface directly.
// WorkspaceAgentSurface takes the per-block XtermPaneModel (its
// notificationAtom contract) — see docs/terax-terminal-port.md §四 P1.6/P1.7.
// Created explicitly by the launcher's Agent widget and as the
// default block in new tabs.  See docs/superpowers/specs/2026-07-07-block-dual-form-split-design.md.

import { workspaceDirAtom } from "@/app/fileexplorer/file-explorer-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceAgentSurface, type AgentSurfaceContext } from "@/app/term/render/agent-surface";
import { TerminalNotification } from "@/app/term/render/terminal-notification";
import { attachCmdRows, detachCmdRows, recentCommandsAtom } from "@/app/xterm/cmdblock-rows";
import { disposeXtermPaneModel, getXtermPaneModel } from "@/app/xterm/xterm-pane-model";
import { disposeSession } from "@/app/xterm/xterm-session";
import { getBlockMetaKeyAtom, getSettingsKeyAtom, useOrefMetaKeyAtom, WOS } from "@/store/global";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";

export class AgentViewModel implements ViewModel {
    readonly viewType = "agent";
    readonly blockId: string;
    readonly viewIcon = jotai.atom("sparkles");
    readonly viewName = jotai.atom("");
    readonly noPadding = jotai.atom(true);
    readonly termFontSizeAtom: jotai.Atom<number>;
    readonly focusRequestAtom = jotai.atom(0);
    disposed = false;
    constructor({ blockId }: ViewModelInitType) {
        this.blockId = blockId;
        const metaAtom = getBlockMetaKeyAtom(blockId, "term:fontsize");
        const settingAtom = getSettingsKeyAtom("term:fontsize");
        this.termFontSizeAtom = jotai.atom((get) => {
            const override = get(metaAtom);
            if (typeof override === "number") return override;
            const fallback = get(settingAtom);
            return typeof fallback === "number" ? fallback : 16;
        });
        attachCmdRows(blockId);
    }
    get viewComponent(): ViewComponent {
        return AgentViewAdapter as unknown as ViewComponent;
    }
    giveFocus(): boolean {
        globalStore.set(this.focusRequestAtom, (prev) => prev + 1);
        return true;
    }
    dispose(): void {
        this.disposed = true;
        detachCmdRows(this.blockId);
        disposeSession(this.blockId);
        disposeXtermPaneModel(this.blockId);
    }
}

const AgentViewAdapter: React.FC<{ model: AgentViewModel }> = ({ model }) => {
    return <AgentSurfaceHost blockId={model.blockId} />;
};
AgentViewAdapter.displayName = "AgentViewAdapter";

// The old TerminalView shell ignored fontSize/focusRequest for agent blocks
// (the agent surface replaced the terminal content and input bar entirely),
// so the host doesn't take them.
const AgentSurfaceHost: React.FC<{ blockId: string }> = ({ blockId }) => {
    const model = getXtermPaneModel(blockId);

    const notification = useAtomValue(model.notificationAtom);
    useEffect(() => {
        if (!notification) return;
        const id = setTimeout(() => {
            globalStore.set(model.notificationAtom, "");
        }, 3500);
        return () => clearTimeout(id);
    }, [notification, model]);

    const workspaceDir = useAtomValue(workspaceDirAtom);
    const commandHistory = useAtomValue(recentCommandsAtom(blockId));
    const connectionName = useOrefMetaKeyAtom(WOS.makeORef("block", blockId), "connection") ?? "";
    const context = useMemo<AgentSurfaceContext>(
        () => ({
            workspaceDir,
            // liveGitBranch stays unset: ContextChipModel (term/contextchip/
            // chip-model.ts) computes the branch, but it's per-instance with
            // no block registry, and nothing constructs it since its host
            // (the old TerminalView) was deleted — it also needs the
            // setCwd/onCommandCompleted drivers that view provided.
            liveGitBranch: undefined,
            // recentCommandsAtom is most-recent-first; downstream
            // buildSystemPrompt slices from the tail, so hand it the ten
            // most recent flipped back to oldest-first.
            recentCmds: commandHistory.slice(0, 10).reverse(),
            liveConnection: connectionName || "",
            inAltScreen: false,
        }),
        [workspaceDir, commandHistory, connectionName]
    );

    return (
        <div className="relative flex h-full w-full flex-col bg-panel">
            <WorkspaceAgentSurface outerBlockId={blockId} model={model} context={context} />
            {notification && <TerminalNotification message={notification} />}
        </div>
    );
};
AgentSurfaceHost.displayName = "AgentSurfaceHost";
