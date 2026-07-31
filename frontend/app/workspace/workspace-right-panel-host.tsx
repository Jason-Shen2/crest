// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global";
import { useAtomValue } from "jotai";
import * as jotai from "jotai";
import { RightToolPanel, RightToolPanelMagnifiedOverlay } from "./right-tool-panel";
import type { WorkspaceAgentContextState, WorkspaceAgentModel } from "./workspace-agent-model";
import { WorkspaceLayoutModel } from "./workspace-layout-model";

const EmptyAgentStateAtom = jotai.atom({ activeSession: undefined as AgentSessionMeta | undefined });
const EmptyContextStateAtom = jotai.atom(null as WorkspaceAgentContextState | null);

export function WorkspaceRightPanelHost({ agentModel }: { agentModel?: WorkspaceAgentModel }) {
    const model = WorkspaceLayoutModel.getInstance();
    const workspace = useAtomValue(atoms.workspace);
    const hydrated = useAtomValue(model.rightToolPanelAtom);
    const agentState = useAtomValue(agentModel?.stateAtom ?? EmptyAgentStateAtom);
    const contextState = useAtomValue(agentModel?.contextSnapshotAtom ?? EmptyContextStateAtom);
    const state = model.getRightToolPanelStateForWorkspace(workspace.oid, hydrated);
    const sessionId = agentState?.activeSession?.path;

    return (
        <>
            {state.visible ? (
                <RightToolPanel
                    state={state}
                    sessionId={sessionId}
                    contextState={contextState}
                    onOpenTool={(tool) => model.openRightTool(tool)}
                    onSelectTool={(tool) => model.selectRightTool(tool)}
                    onCloseTool={(tool) => model.closeRightTool(tool)}
                    onMagnify={() => model.setRightToolPanelMagnified(!state.magnified)}
                    onFocusPanel={() => model.setRightToolPanelFocused(true)}
                    onBlurPanel={() => model.setRightToolPanelFocused(false)}
                />
            ) : null}
            <RightToolPanelMagnifiedOverlay state={state} onExit={() => model.setRightToolPanelMagnified(false)} />
        </>
    );
}
