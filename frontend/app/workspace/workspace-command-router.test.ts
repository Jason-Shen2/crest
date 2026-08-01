// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    WorkspaceCommandRouter,
    type TerminalCommandAdapter,
    type TerminalNavigationAdapter,
} from "./workspace-command-router";
import { makeWorkspaceModel, WorkspaceModel } from "./workspace-model";

function makeTerminalCommands(): TerminalCommandAdapter {
    return {
        create: vi.fn(),
        close: vi.fn(),
    };
}

function makeRouter(
    options: { activeTerminalTabId?: string; terminalTabIds?: string[] } = {},
    terminalCommands = makeTerminalCommands(),
    reportError = vi.fn()
) {
    const model = makeWorkspaceModel({
        workspaceId: "workspace-1",
        initialActiveTerminalTabId: options.activeTerminalTabId,
        initialContentState: {
            activecontent: { kind: "agent" },
            toptabs: [
                { id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" },
                { id: "file-2", kind: "file", path: "/tmp/b.ts", title: "b.ts" },
            ],
            lastactivetoptabid: "",
        },
    });
    const terminalNavigation: TerminalNavigationAdapter = {
        getTerminalTabIds: () => options.terminalTabIds ?? [options.activeTerminalTabId].filter(Boolean),
        activate: (terminalTabId) => {
            if (!terminalNavigation.getTerminalTabIds().includes(terminalTabId)) {
                return false;
            }
            model.activateTerminal(terminalTabId);
            return true;
        },
        select: (terminalTabId) => terminalNavigation.activate(terminalTabId),
        create: vi.fn(),
        rename: vi.fn(),
        close: vi.fn(),
        reorder: vi.fn(),
    };
    return {
        model,
        terminalCommands,
        terminalNavigation,
        reportError,
        router: new WorkspaceCommandRouter(model, terminalCommands, terminalNavigation, reportError),
    };
}

afterEach(async () => {
    await WorkspaceModel.resetInstances();
});

describe("WorkspaceCommandRouter", () => {
    it("routes content commands to the Top Tab controller and right-side Browser", () => {
        const { model, terminalCommands, terminalNavigation } = makeRouter();
        const controller = {
            openFile: vi.fn(),
            openPreview: vi.fn(),
            openGitDiff: vi.fn(),
            openAgentTurnDiff: vi.fn(),
            activate: vi.fn(),
            close: vi.fn(),
            relocateFile: vi.fn(),
        };
        const layoutModel = { openRightTool: vi.fn() };
        const rightBrowserModel = { newTab: vi.fn() };
        const router = new WorkspaceCommandRouter(
            model,
            terminalCommands,
            terminalNavigation,
            undefined,
            undefined,
            controller,
            layoutModel as any,
            rightBrowserModel as any
        );

        router.dispatch({ type: "open-file", path: "/repo/a.ts" });
        router.dispatch({ type: "open-preview", path: "/repo/readme.md" });
        router.dispatch({ type: "open-git-diff", repoRoot: "/repo", path: "a.ts", mode: "-" });
        router.dispatch({ type: "open-url", url: "https://example.com" });

        expect(controller.openFile).toHaveBeenCalledWith("/repo/a.ts");
        expect(controller.openPreview).toHaveBeenCalledWith("/repo/readme.md");
        expect(controller.openGitDiff).toHaveBeenCalledWith({
            type: "open-git-diff",
            repoRoot: "/repo",
            path: "a.ts",
            mode: "-",
        });
        expect(layoutModel.openRightTool).toHaveBeenCalledWith("browser");
        expect(rightBrowserModel.newTab).toHaveBeenCalledWith("https://example.com", true);
    });

    it("routes Cmd+W Top Tab closure through the asynchronous close coordinator", async () => {
        const { model, terminalCommands, terminalNavigation } = makeRouter();
        const close = vi.fn().mockResolvedValue(false);
        model.activateTopTab("file-1");
        const router = new WorkspaceCommandRouter(model, terminalCommands, terminalNavigation, undefined, { close });

        router.dispatch({ type: "close-active" });
        await vi.waitFor(() => expect(close).toHaveBeenCalledWith("file-1"));
        expect(globalStore.get(model.contentStateAtom).topTabs).toHaveLength(2);
    });
    it("dispatches valid direct activation and creation commands to the workspace owner", () => {
        const { model, router, terminalCommands } = makeRouter({ activeTerminalTabId: "terminal-1" });
        const activateAgent = vi.spyOn(model, "activateAgent");
        const activateTerminal = vi.spyOn(model, "activateTerminal");
        const activateTopTab = vi.spyOn(model, "activateTopTab");

        router.dispatch({ type: "activate-agent" });
        router.dispatch({ type: "activate-terminal", terminalTabId: "terminal-1" });
        router.dispatch({ type: "activate-top-tab", topTabId: "file-1" });
        router.dispatch({ type: "new-terminal" });

        expect(activateAgent).toHaveBeenCalledOnce();
        expect(activateTerminal).toHaveBeenCalledWith("terminal-1");
        expect(activateTopTab).toHaveBeenCalledWith("file-1");
        expect(terminalCommands.create).toHaveBeenCalledOnce();
    });

    it("rejects a Terminal activation outside the current proven Terminal membership", () => {
        const { model, router } = makeRouter({ activeTerminalTabId: "terminal-1" });
        const activateTerminal = vi.spyOn(model, "activateTerminal");
        const before = globalStore.get(model.contentStateAtom);

        router.dispatch({ type: "activate-terminal", terminalTabId: "terminal-from-another-workspace" });

        expect(activateTerminal).not.toHaveBeenCalled();
        expect(globalStore.get(model.contentStateAtom)).toBe(before);
    });

    it("activates another Terminal proven to belong to the same workspace", () => {
        const { model, router } = makeRouter({
            activeTerminalTabId: "terminal-1",
            terminalTabIds: ["terminal-1", "terminal-2"],
        });

        router.dispatch({ type: "activate-terminal", terminalTabId: "terminal-2" });

        expect(globalStore.get(model.activeTerminalTabIdAtom)).toBe("terminal-2");
        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({
            kind: "terminal",
            terminalTabId: "terminal-2",
        });
    });

    it("keeps Agent open when close-active is dispatched", () => {
        const { model, router, terminalCommands } = makeRouter({ activeTerminalTabId: "terminal-1" });
        const closeTopTab = vi.spyOn(model, "closeTopTab");

        router.dispatch({ type: "close-active" });

        expect(closeTopTab).not.toHaveBeenCalled();
        expect(terminalCommands.close).not.toHaveBeenCalled();
        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({ kind: "agent" });
    });

    it("routes close-active to the active Top Tab or Terminal adapter", () => {
        const { model, router, terminalCommands } = makeRouter({ activeTerminalTabId: "terminal-1" });
        const closeTopTab = vi.spyOn(model, "closeTopTab");

        model.activateTopTab("file-1");
        router.dispatch({ type: "close-active" });
        expect(closeTopTab).toHaveBeenCalledWith("file-1");

        model.activateTerminal("terminal-1");
        router.dispatch({ type: "close-active" });
        expect(terminalCommands.close).toHaveBeenCalledWith("terminal-1");
    });

    it("cycles next and previous through Agent, workspace Terminals, and ordered Top Tabs", () => {
        const { model, router } = makeRouter({
            activeTerminalTabId: "terminal-1",
            terminalTabIds: ["terminal-1", "terminal-2"],
        });

        const expectedNext = [
            { kind: "terminal", terminalTabId: "terminal-1" },
            { kind: "terminal", terminalTabId: "terminal-2" },
            { kind: "top-tab", topTabId: "file-1" },
            { kind: "top-tab", topTabId: "file-2" },
            { kind: "agent" },
        ];
        for (const activeContent of expectedNext) {
            router.dispatch({ type: "next-content" });
            expect(globalStore.get(model.contentStateAtom).activeContent).toEqual(activeContent);
        }

        router.dispatch({ type: "previous-content" });
        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({
            kind: "top-tab",
            topTabId: "file-2",
        });
        router.dispatch({ type: "previous-content" });
        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({
            kind: "top-tab",
            topTabId: "file-1",
        });
    });

    it("omits the Terminal boundary when no current Terminal is known", () => {
        const { model, router } = makeRouter();

        router.dispatch({ type: "next-content" });
        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({
            kind: "top-tab",
            topTabId: "file-1",
        });

        model.activateAgent();
        router.dispatch({ type: "previous-content" });
        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({
            kind: "top-tab",
            topTabId: "file-2",
        });
    });

    it("reports synchronous Terminal adapter failures without changing content state", () => {
        const terminalCommands: TerminalCommandAdapter = {
            create: vi.fn(() => {
                throw new Error("create failed");
            }),
            close: vi.fn(() => {
                throw new Error("close failed");
            }),
        };
        const { model, reportError, router } = makeRouter({ activeTerminalTabId: "terminal-1" }, terminalCommands);

        expect(() => router.dispatch({ type: "new-terminal" })).not.toThrow();
        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({ kind: "agent" });

        model.activateTerminal("terminal-1");
        const terminalState = globalStore.get(model.contentStateAtom);
        expect(() => router.dispatch({ type: "close-active" })).not.toThrow();
        expect(globalStore.get(model.contentStateAtom)).toEqual(terminalState);
        expect(reportError).toHaveBeenCalledTimes(2);
    });

    it("reports rejected Terminal adapter promises without unhandled rejections or state changes", async () => {
        const terminalCommands: TerminalCommandAdapter = {
            create: vi.fn(() => Promise.reject(new Error("create rejected"))),
            close: vi.fn(() => Promise.reject(new Error("close rejected"))),
        };
        const { model, reportError, router } = makeRouter({ activeTerminalTabId: "terminal-1" }, terminalCommands);

        router.dispatch({ type: "new-terminal" });
        model.activateTerminal("terminal-1");
        const terminalState = globalStore.get(model.contentStateAtom);
        router.dispatch({ type: "close-active" });
        await Promise.resolve();

        expect(globalStore.get(model.contentStateAtom)).toEqual(terminalState);
        expect(reportError).toHaveBeenCalledTimes(2);
    });
});
