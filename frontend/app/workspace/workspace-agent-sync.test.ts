// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAgentModel } from "./workspace-agent-model";
import { WorkspaceAgentSync } from "./workspace-agent-sync";
import { WorkspaceModel } from "./workspace-model";

const SessionOne: AgentSessionMeta = {
    id: "session-1",
    createdAt: "2026-07-25T01:00:00Z",
    cwd: "/tmp/project",
    path: "/tmp/project/.crest/session-1.db",
};
const ModelOne: AgentSelectionMeta = {
    provider: "openai",
    model: "gpt-5",
    reasoning: "high",
};

function workspace(oid: string, agentRevision: number, terminalTabIds: string[]): Workspace {
    return {
        oid,
        otype: "workspace",
        version: agentRevision + 1,
        navigationrevision: 0,
        agentrevision: agentRevision,
        agentstate: {
            activesession: SessionOne,
        },
        terminaltabids: terminalTabIds,
    } as Workspace;
}

afterEach(async () => {
    await WorkspaceAgentModel.resetInstances();
    await WorkspaceModel.resetInstances();
});

describe("WorkspaceAgentSync", () => {
    it("projects only Agent state and Agent revision", async () => {
        const workspaceAtom = jotai.atom(workspace("ws-1", 2, ["term-1"]));
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 3,
            initialRevision: 2,
            initialState: workspace("ws-1", 2, ["term-1"]).agentstate,
        });
        const owner = WorkspaceModel.getInstance({ windowId: "win-1", workspaceId: "ws-1" });
        const sync = new WorkspaceAgentSync(model, owner, workspaceAtom);
        sync.start();

        globalStore.set(workspaceAtom, {
            ...workspace("ws-1", 3, []),
            agentstate: {
                activesession: SessionOne,
                selection: ModelOne,
            },
            name: "ignored",
            navigationrevision: 99,
        });

        expect(model.revision).toBe(3);
        expect(globalStore.get(model.stateAtom)).toEqual({
            activeSession: SessionOne,
            selection: ModelOne,
        });
        expect(owner.revision).toBe(0);
        await sync.dispose();
    });

    it("does not let Terminal inventory changes mutate dirty Agent state", async () => {
        const workspaceAtom = jotai.atom(workspace("ws-1", 5, ["term-1"]));
        const saveCheckpoint = vi.fn().mockResolvedValue({
            workspaceid: "ws-1",
            revision: 6,
            state: {
                activesession: SessionOne,
                selection: ModelOne,
            },
        });
        const agentModel = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 3,
            initialRevision: 5,
            initialState: workspace("ws-1", 5, ["term-1"]).agentstate,
            saveCheckpoint,
        });
        const owner = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            initialTerminalTabIds: ["term-1"],
        });
        const sync = new WorkspaceAgentSync(agentModel, owner, workspaceAtom);
        sync.start();
        agentModel.selectModel(ModelOne);

        globalStore.set(workspaceAtom, workspace("ws-1", 5, []));

        expect(globalStore.get(agentModel.stateAtom)).toEqual({
            activeSession: SessionOne,
            selection: ModelOne,
        });
        await agentModel.flush();
        expect(saveCheckpoint).toHaveBeenCalledWith({
            workspaceid: "ws-1",
            expectedrevision: 5,
            state: {
                activesession: SessionOne,
                selection: ModelOne,
            },
        });
        await sync.dispose();
    });

    it("ignores old workspace updates and stops before the Workspace owner is replaced", async () => {
        const workspaceAtom = jotai.atom(workspace("ws-1", 1, ["term-1"]));
        const agentModel = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 4,
            initialRevision: 1,
            initialState: workspace("ws-1", 1, ["term-1"]).agentstate,
        });
        const owner = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
        });
        const sync = new WorkspaceAgentSync(agentModel, owner, workspaceAtom);
        sync.start();

        globalStore.set(workspaceAtom, workspace("ws-old", 5, ["term-old"]));
        expect(agentModel.revision).toBe(1);

        await WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-2",
        });
        globalStore.set(workspaceAtom, workspace("ws-1", 7, ["term-late"]));

        expect(agentModel.revision).toBe(1);
        expect(agentModel.disposed).toBe(true);
    });
});
