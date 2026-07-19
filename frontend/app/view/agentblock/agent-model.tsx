// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentViewModel — the "agent" block form.  Same TerminalModel engine as the
// pure-terminal "term"/"termblocks" forms, but mounts the agent surface
// (chat host / session selector / composer) via WorkspaceAgentSurface.
// Created explicitly by the launcher's Agent widget and as the
// default block in new tabs.  See docs/superpowers/specs/2026-07-07-block-dual-form-split-design.md.

import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceAgentSurface } from "@/app/term/render/agent-surface";
import { TerminalView } from "@/app/term/render/terminal-view";
import { getBlockMetaKeyAtom, getSettingsKeyAtom } from "@/store/global";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";

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
    }
}

const AgentViewAdapter: React.FC<{ model: AgentViewModel }> = ({ model }) => {
    const fontSize = useAtomValue(model.termFontSizeAtom);
    const focusRequest = useAtomValue(model.focusRequestAtom);
    return <AgentSurfaceHost blockId={model.blockId} fontSize={fontSize} focusRequest={focusRequest} />;
};
AgentViewAdapter.displayName = "AgentViewAdapter";

const AgentSurfaceHost: React.FC<{ blockId: string; fontSize: number; focusRequest: number }> = ({
    blockId,
    fontSize,
    focusRequest,
}) => {
    return (
        <TerminalView
            outerBlockId={blockId}
            fontSize={fontSize}
            focusRequest={focusRequest}
            agentSurfaceComponent={WorkspaceAgentSurface}
        />
    );
};
AgentSurfaceHost.displayName = "AgentSurfaceHost";
