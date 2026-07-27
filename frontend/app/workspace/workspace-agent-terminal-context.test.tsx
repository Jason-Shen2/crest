// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { globalStore } from "@/app/store/jotaiStore";
import { act, renderHook } from "@testing-library/react";
import { atom, Provider } from "jotai";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wosHarness = vi.hoisted(() => ({
    atoms: new Map<string, any>(),
    subscribe: vi.fn(),
    subscriptions: [] as Array<{ oref: string; unsubscribe: ReturnType<typeof vi.fn> }>,
}));

const cmdRowsHarness = vi.hoisted(() => ({
    atoms: new Map<string, any>(),
    attach: vi.fn(),
    detach: vi.fn(),
}));

vi.mock("@/app/store/wos", async () => {
    const jotai = await vi.importActual<typeof import("jotai")>("jotai");
    return {
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
        getWaveObjectAtom: (oref: string) => {
            let objectAtom = wosHarness.atoms.get(oref);
            if (!objectAtom) {
                objectAtom = jotai.atom(undefined);
                wosHarness.atoms.set(oref, objectAtom);
            }
            return objectAtom;
        },
        wpsSubscribeToObject: wosHarness.subscribe,
    };
});

vi.mock("@/app/xterm/cmdblock-rows", async () => {
    const jotai = await vi.importActual<typeof import("jotai")>("jotai");
    return {
        attachCmdRows: cmdRowsHarness.attach,
        detachCmdRows: cmdRowsHarness.detach,
        recentCommandsAtom: (blockId: string) => {
            let recentAtom = cmdRowsHarness.atoms.get(blockId);
            if (!recentAtom) {
                recentAtom = jotai.atom<string[]>([]);
                cmdRowsHarness.atoms.set(blockId, recentAtom);
            }
            return recentAtom;
        },
    };
});

import {
    buildWorkspaceAgentExecutionContext,
    useWorkspaceAgentTerminalContext,
} from "./workspace-agent-context";

function setWaveObject(oref: string, value: WaveObj): void {
    let objectAtom = wosHarness.atoms.get(oref);
    if (!objectAtom) {
        objectAtom = atom<WaveObj | undefined>(undefined);
        wosHarness.atoms.set(oref, objectAtom);
    }
    globalStore.set(objectAtom, value);
}

function setRecentCommands(blockId: string, commands: string[]): void {
    let recentAtom = cmdRowsHarness.atoms.get(blockId);
    if (!recentAtom) {
        recentAtom = atom<string[]>([]);
        cmdRowsHarness.atoms.set(blockId, recentAtom);
    }
    globalStore.set(recentAtom, commands);
}

function seedTerminal(tabId: string, layoutId: string, blockId: string, connection: string, commands: string[]): void {
    setWaveObject(`tab:${tabId}`, {
        otype: "tab",
        oid: tabId,
        version: 1,
        name: tabId,
        layoutstate: layoutId,
        blockids: [blockId],
    } as Tab);
    setWaveObject(`layout:${layoutId}`, {
        otype: "layout",
        oid: layoutId,
        version: 1,
        focusednodeid: `node-${blockId}`,
        leaforder: [{ nodeid: `node-${blockId}`, blockid: blockId }],
    } as LayoutState);
    setWaveObject(`block:${blockId}`, {
        otype: "block",
        oid: blockId,
        version: 1,
        meta: { connection },
    } as Block);
    setRecentCommands(blockId, commands);
}

function Wrapper({ children }: PropsWithChildren) {
    return <Provider store={globalStore}>{children}</Provider>;
}

beforeEach(() => {
    wosHarness.atoms.clear();
    wosHarness.subscriptions = [];
    wosHarness.subscribe.mockReset().mockImplementation((oref: string) => {
        const unsubscribe = vi.fn();
        wosHarness.subscriptions.push({ oref, unsubscribe });
        return unsubscribe;
    });
    cmdRowsHarness.atoms.clear();
    cmdRowsHarness.attach.mockReset();
    cmdRowsHarness.detach.mockReset();
});

describe("useWorkspaceAgentTerminalContext", () => {
    it("balances live resources across A to B, empty, and unmount while ignoring stale A updates", () => {
        seedTerminal("terminal-a", "layout-a", "block-a", "ssh://a", ["new-a", "old-a"]);
        seedTerminal("terminal-b", "layout-b", "block-b", "ssh://b", ["new-b", "old-b"]);

        const { result, rerender, unmount } = renderHook(
            ({ tabId }: { tabId?: string }) => {
                const terminalContext = useWorkspaceAgentTerminalContext(tabId);
                return buildWorkspaceAgentExecutionContext({
                    workspaceId: "workspace-1",
                    generation: 1,
                    workspaceDir: "/repo",
                    preferredTerminalTabId: tabId,
                    ...terminalContext,
                });
            },
            {
                initialProps: { tabId: "terminal-a" },
                wrapper: Wrapper,
            }
        );

        expect(result.current).toMatchObject({
            connection: "ssh://a",
            recentCmds: ["old-a", "new-a"],
        });
        expect(cmdRowsHarness.attach).toHaveBeenCalledWith("block-a");
        expect(wosHarness.subscribe.mock.calls.map(([oref]) => oref)).toEqual([
            "tab:terminal-a",
            "layout:layout-a",
            "block:block-a",
        ]);

        rerender({ tabId: "terminal-b" });

        expect(result.current).toMatchObject({
            connection: "ssh://b",
            recentCmds: ["old-b", "new-b"],
        });
        expect(cmdRowsHarness.detach).toHaveBeenCalledWith("block-a");
        expect(cmdRowsHarness.attach).toHaveBeenCalledWith("block-b");

        act(() => {
            setWaveObject("tab:terminal-a", {
                otype: "tab",
                oid: "terminal-a",
                version: 2,
                name: "stale-a",
                layoutstate: "layout-stale",
                blockids: ["block-stale"],
            } as Tab);
        });

        expect(result.current).toMatchObject({
            connection: "ssh://b",
            recentCmds: ["old-b", "new-b"],
        });
        expect(wosHarness.subscribe).not.toHaveBeenCalledWith("layout:layout-stale");

        act(() => setRecentCommands("block-b", ["latest-b", "middle-b", "oldest-b"]));

        expect(result.current.recentCmds).toEqual(["oldest-b", "middle-b", "latest-b"]);

        rerender({ tabId: undefined });

        expect(result.current).toMatchObject({ connection: "", recentCmds: [] });
        expect(cmdRowsHarness.detach).toHaveBeenCalledWith("block-b");

        rerender({ tabId: "terminal-b" });
        unmount();

        expect(cmdRowsHarness.attach.mock.calls).toEqual([["block-a"], ["block-b"], ["block-b"]]);
        expect(cmdRowsHarness.detach.mock.calls).toEqual([["block-a"], ["block-b"], ["block-b"]]);
        for (const { unsubscribe } of wosHarness.subscriptions) {
            expect(unsubscribe).toHaveBeenCalledOnce();
        }
    });
});
