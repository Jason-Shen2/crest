// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface LocalWorkspaceAgentState {
    activeSession?: AgentSessionMeta;
    selection?: AgentSelectionMeta;
}

function cloneSession(session?: AgentSessionMeta): AgentSessionMeta {
    return session == null ? undefined : { ...session };
}

function cloneSelection(selection?: AgentSelectionMeta): AgentSelectionMeta {
    return selection == null ? undefined : { ...selection };
}

export function hydrateWorkspaceAgentState(state?: WorkspaceAgentState): LocalWorkspaceAgentState {
    return {
        activeSession: cloneSession(state?.activesession),
        selection: cloneSelection(state?.selection),
    };
}

export function cloneWorkspaceAgentState(state: LocalWorkspaceAgentState): LocalWorkspaceAgentState {
    return {
        activeSession: cloneSession(state.activeSession),
        selection: cloneSelection(state.selection),
    };
}

export function serializeWorkspaceAgentState(state: LocalWorkspaceAgentState): WorkspaceAgentState {
    return {
        activesession: cloneSession(state.activeSession),
        selection: cloneSelection(state.selection),
    };
}

export function workspaceAgentStatesEqual(left: LocalWorkspaceAgentState, right: LocalWorkspaceAgentState): boolean {
    return JSON.stringify(serializeWorkspaceAgentState(left)) === JSON.stringify(serializeWorkspaceAgentState(right));
}
