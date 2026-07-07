// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentViewModel — the "agent" block form.  Same TerminalModel engine as the
// pure-terminal "term"/"termblocks" forms, but mounts the agent surface
// (chat host / activity bar / session selector / agent input mode) via
// useAgentPane.  Created explicitly by the launcher's Agent widget and as the
// default block in new tabs.  See docs/superpowers/specs/2026-07-07-block-dual-form-split-design.md.

import { useAgentPane, type AgentPaneDeps, type AgentSlot } from "@/app/term/render/agent-pane";
import { TerminalView } from "@/app/term/render/terminal-view";
import { globalStore } from "@/app/store/jotaiStore";
import { getBlockMetaKeyAtom, getSettingsKeyAtom } from "@/store/global";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import * as React from "react";

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
    const renderAgentSlot = (ctx: AgentPaneDeps): AgentSlot => {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        return useAgentPane(blockId, ctx.model, ctx);
    };
    return (
        <TerminalView
            outerBlockId={blockId}
            fontSize={fontSize}
            focusRequest={focusRequest}
            renderAgentSlot={renderAgentSlot}
        />
    );
};
AgentSurfaceHost.displayName = "AgentSurfaceHost";
