// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AgentRuntimeClient, type AgentRuntimeElectronApi } from "@/app/agent/agent-runtime-client";
import * as WOS from "@/app/store/wos";
import { attachCmdRows, detachCmdRows, recentCommandsAtom } from "@/app/xterm/cmdblock-rows";
import { atom, type Atom, useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";

const EmptyWaveObjectAtom = atom<WaveObj | undefined>(undefined);
const EmptyRecentCmdsAtom = atom<string[]>([]);
const MaxAgentRecentCommands = 10;

export interface WorkspaceAgentContextInput {
    workspaceId: string;
    generation: number;
    workspaceDir: string;
    sessionPath?: string;
    connection?: string;
    environment?: Record<string, string>;
    preferredTerminalTabId?: string;
    gitBranch?: string;
    recentCmds?: string[];
}

export function buildWorkspaceAgentExecutionContext(input: WorkspaceAgentContextInput): AgentExecutionContext {
    return {
        workspaceId: input.workspaceId,
        workspaceDir: input.workspaceDir,
        sessionPath: input.sessionPath,
        connection: input.connection ?? "",
        environment: { ...(input.environment ?? {}) },
        preferredTerminalTabId: input.preferredTerminalTabId,
        gitBranch: input.gitBranch,
        recentCmds: [...(input.recentCmds ?? [])],
    };
}

export interface WorkspaceAgentContextValue {
    runtimeClient: AgentRuntimeClient;
    executionContext: AgentExecutionContext;
}

export function makeWorkspaceAgentContext(
    input: WorkspaceAgentContextInput,
    agentApi: AgentRuntimeElectronApi
): WorkspaceAgentContextValue {
    return {
        runtimeClient: new AgentRuntimeClient(agentApi, {
            workspaceId: input.workspaceId,
            generation: input.generation,
        }),
        executionContext: buildWorkspaceAgentExecutionContext(input),
    };
}

export function resolveWorkspaceAgentTerminalBlockId(
    tab: Tab | undefined,
    layout: LayoutState | undefined
): string | undefined {
    if (!tab?.layoutstate || layout?.oid !== tab.layoutstate) {
        return undefined;
    }
    const blockIds = new Set(tab.blockids ?? []);
    const leaves = (layout.leaforder ?? []).filter((leaf) => blockIds.has(leaf.blockid));
    if (leaves.length === 0) {
        return undefined;
    }
    return leaves.find((leaf) => leaf.nodeid === layout.focusednodeid)?.blockid ?? leaves[0].blockid;
}

export function resolveWorkspaceAgentTerminalValues(
    blockId: string | undefined,
    block: Block | undefined,
    newestFirstCommands: string[]
): Pick<AgentExecutionContext, "connection" | "recentCmds"> {
    const connection =
        blockId && block?.oid === blockId && typeof block.meta?.connection === "string"
            ? block.meta.connection
            : "";
    return {
        connection,
        recentCmds: blockId ? newestFirstCommands.slice(0, MaxAgentRecentCommands).reverse() : [],
    };
}

function useSubscribedWaveObject<T extends WaveObj>(oref: string | undefined): T | undefined {
    const objectAtom = useMemo(
        () => (oref ? WOS.getWaveObjectAtom<T>(oref) : (EmptyWaveObjectAtom as Atom<T | undefined>)),
        [oref]
    );
    const object = useAtomValue(objectAtom);
    useEffect(() => {
        if (!oref) {
            return;
        }
        return WOS.wpsSubscribeToObject(oref);
    }, [oref]);
    return object;
}

export function useWorkspaceAgentTerminalContext(
    preferredTerminalTabId: string | undefined
): Pick<AgentExecutionContext, "connection" | "recentCmds"> {
    const tabOref = preferredTerminalTabId ? WOS.makeORef("tab", preferredTerminalTabId) : undefined;
    const tab = useSubscribedWaveObject<Tab>(tabOref);
    const layoutOref =
        tab?.oid === preferredTerminalTabId && tab?.layoutstate ? WOS.makeORef("layout", tab.layoutstate) : undefined;
    const layout = useSubscribedWaveObject<LayoutState>(layoutOref);
    const blockId = resolveWorkspaceAgentTerminalBlockId(tab, layout);
    const blockOref = blockId ? WOS.makeORef("block", blockId) : undefined;
    const block = useSubscribedWaveObject<Block>(blockOref);
    const recentCmdsAtom = useMemo(
        () => (blockId ? recentCommandsAtom(blockId) : EmptyRecentCmdsAtom),
        [blockId]
    );
    const newestFirstCommands = useAtomValue(recentCmdsAtom);

    useEffect(() => {
        if (!blockId) {
            return;
        }
        attachCmdRows(blockId);
        return () => detachCmdRows(blockId);
    }, [blockId]);

    return useMemo(
        () => resolveWorkspaceAgentTerminalValues(blockId, block, newestFirstCommands),
        [block, blockId, newestFirstCommands]
    );
}
