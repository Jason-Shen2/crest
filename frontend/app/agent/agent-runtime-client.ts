// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { PiAgentEvent } from "@/app/store/use-pi-chat";

export type WorkspaceAgentIdentity = Readonly<{
    workspaceId: string;
    generation: number;
}>;

export type AgentRuntimeElectronApi = ElectronApi["agent"];

const AgentApis = new WeakMap<AgentRuntimeClient, AgentRuntimeElectronApi>();

function getAgentApi(client: AgentRuntimeClient): AgentRuntimeElectronApi {
    const agent = AgentApis.get(client);
    if (!agent) {
        throw new Error("Workspace Agent runtime client is not initialized");
    }
    return agent;
}

export class AgentRuntimeClient {
    readonly identity: WorkspaceAgentIdentity;

    constructor(agent: AgentRuntimeElectronApi, identity: WorkspaceAgentIdentity) {
        AgentApis.set(this, agent);
        this.identity = Object.freeze({ ...identity });
    }

    createSession() {
        return getAgentApi(this).createSession(this.identity);
    }

    listSessions() {
        return getAgentApi(this).listSessions(this.identity);
    }

    listSessionDetails(limit?: number) {
        return getAgentApi(this).listSessionDetails(this.identity, limit);
    }

    listCommands() {
        return getAgentApi(this).listCommands(this.identity);
    }

    getSessionState(sessionMetadata: AgentSessionMeta): Promise<PiAgentEvent> {
        return getAgentApi(this).getSessionState(this.identity, sessionMetadata) as Promise<PiAgentEvent>;
    }

    inspectContext(options: AgentInspectContextOptions): Promise<AgentInspectContextResult> {
        return getAgentApi(this).inspectContext(this.identity, options);
    }

    listTree(sessionMetadata: AgentSessionMeta) {
        return getAgentApi(this).listTree(this.identity, sessionMetadata);
    }

    listForkPoints(sessionMetadata: AgentSessionMeta) {
        return getAgentApi(this).listForkPoints(this.identity, sessionMetadata);
    }

    navigateTree(input: AgentNavigateTreeInput) {
        return getAgentApi(this).navigateTree(this.identity, input);
    }

    forkSession(input: AgentForkSessionInput) {
        return getAgentApi(this).forkSession(this.identity, input);
    }

    cloneSession(input: AgentCloneSessionInput) {
        return getAgentApi(this).cloneSession(this.identity, input);
    }

    runCommand(input: AgentRunCommandInput) {
        return getAgentApi(this).runCommand(this.identity, input);
    }

    prepareContextDraft(input: AgentPrepareContextDraftInput) {
        return getAgentApi(this).prepareContextDraft(this.identity, input);
    }

    summarizeContextDraft(input: AgentSummarizeContextDraftInput) {
        return getAgentApi(this).summarizeContextDraft(this.identity, input);
    }

    discardContextDraft(input: AgentDiscardContextDraftInput) {
        return getAgentApi(this).discardContextDraft(this.identity, input);
    }

    listReferencePoints(input: AgentListReferencePointsInput) {
        return getAgentApi(this).listReferencePoints(this.identity, input);
    }

    listContextState(input: AgentListContextStateInput) {
        return getAgentApi(this).listContextState(this.identity, input);
    }

    commandRead(sessionMetadata: AgentSessionMeta, commandId: string) {
        return getAgentApi(this).commandRead(this.identity, sessionMetadata, { commandId });
    }

    commandWrite(sessionMetadata: AgentSessionMeta, commandId: string, input: string) {
        return getAgentApi(this).commandWrite(this.identity, sessionMetadata, { commandId, input });
    }

    commandResize(sessionMetadata: AgentSessionMeta, commandId: string, cols: number, rows: number) {
        return getAgentApi(this).commandResize(this.identity, sessionMetadata, { commandId, cols, rows });
    }

    commandStop(sessionMetadata: AgentSessionMeta, commandId: string) {
        return getAgentApi(this).commandStop(this.identity, sessionMetadata, { commandId });
    }

    renameSession(sessionMetadata: AgentSessionMeta, name: string) {
        return getAgentApi(this).renameSession(this.identity, { sessionMetadata, name });
    }

    archiveSession(sessionMetadata: AgentSessionMeta) {
        return getAgentApi(this).archiveSession(this.identity, sessionMetadata);
    }

    deleteSession(sessionMetadata: AgentSessionMeta) {
        return getAgentApi(this).deleteSession(this.identity, sessionMetadata);
    }

    send(options: AgentSendOptions) {
        return getAgentApi(this).send(this.identity, options);
    }

    abort(sessionPath: string) {
        return getAgentApi(this).abort(this.identity, sessionPath);
    }

    subscribe(sessionPath: string, callback: (event: unknown) => void, onError?: (error: unknown) => void) {
        return getAgentApi(this).subscribe(this.identity, sessionPath, callback, onError);
    }
}
