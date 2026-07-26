// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RightBrowserModel } from "@/app/rightbrowser/right-browser";
import { openUrlInRightBrowser } from "@/app/rightbrowser/open-right-browser";
import type { WorkspaceTopTabController } from "./top-tab-controller";
import type { TerminalNavigationAdapter } from "./terminal-navigation";
import type { ActiveContent } from "./workspace-content-state";
import { WorkspaceLayoutModel } from "./workspace-layout-model";
import type { WorkspaceModel } from "./workspace-model";

export type { TerminalNavigationAdapter } from "./terminal-navigation";

export interface TerminalCommandAdapter {
    create(): void | Promise<void>;
    close(terminalTabId: string): void | Promise<void>;
}

export interface TopTabCloseAdapter {
    close(topTabId: string): Promise<boolean>;
}

export type WorkspaceCommandErrorReporter = (error: unknown, command: WorkspaceCommand) => void;

function defaultErrorReporter(error: unknown, command: WorkspaceCommand): void {
    console.error(`workspace command ${command.type} failed`, error);
}

function contentKey(content: ActiveContent): string {
    switch (content.kind) {
        case "agent":
            return "agent";
        case "terminal":
            return `terminal:${content.terminalTabId}`;
        case "top-tab":
            return `top-tab:${content.topTabId}`;
    }
}

export class WorkspaceCommandRouter {
    model: WorkspaceModel;
    terminalCommands: TerminalCommandAdapter;
    terminalNavigation: TerminalNavigationAdapter;
    reportError: WorkspaceCommandErrorReporter;
    topTabClose: TopTabCloseAdapter;
    topTabController: WorkspaceTopTabController;
    layoutModel: WorkspaceLayoutModel | undefined;
    rightBrowserModel: RightBrowserModel | undefined;

    constructor(
        model: WorkspaceModel,
        terminalCommands: TerminalCommandAdapter,
        terminalNavigation: TerminalNavigationAdapter,
        reportError: WorkspaceCommandErrorReporter = defaultErrorReporter,
        topTabClose?: TopTabCloseAdapter,
        topTabController?: WorkspaceTopTabController,
        layoutModel?: WorkspaceLayoutModel,
        rightBrowserModel?: RightBrowserModel
    ) {
        this.model = model;
        this.terminalCommands = terminalCommands;
        this.terminalNavigation = terminalNavigation;
        this.reportError = reportError;
        this.topTabClose = topTabClose;
        this.topTabController = topTabController;
        this.layoutModel = layoutModel;
        this.rightBrowserModel = rightBrowserModel;
    }

    dispatch(command: WorkspaceCommand): void {
        switch (command.type) {
            case "open-url":
                this.runTerminalCommand(command, () =>
                    openUrlInRightBrowser(
                        command.url,
                        this.layoutModel ?? WorkspaceLayoutModel.getInstance(),
                        this.rightBrowserModel ?? RightBrowserModel.getInstance()
                    )
                );
                return;
            case "open-file":
                this.runTerminalCommand(command, () => {
                    this.requireTopTabController().openFile(command.path);
                });
                return;
            case "open-preview":
                this.runTerminalCommand(command, () => {
                    this.requireTopTabController().openPreview(command.path);
                });
                return;
            case "open-git-diff":
                this.runTerminalCommand(command, () => {
                    this.requireTopTabController().openGitDiff(command);
                });
                return;
            case "activate-agent":
                this.model.activateAgent();
                return;
            case "activate-terminal":
                this.terminalNavigation.activate(command.terminalTabId);
                return;
            case "activate-terminal-index": {
                const terminalTabId = globalStore.get(this.model.terminalTabIdsAtom)[command.index];
                if (terminalTabId) {
                    this.terminalNavigation.activate(terminalTabId);
                }
                return;
            }
            case "activate-top-tab":
                this.model.activateTopTab(command.topTabId);
                return;
            case "new-terminal":
                this.runTerminalCommand(command, () => this.terminalCommands.create());
                return;
            case "close-active":
                this.closeActive();
                return;
            case "next-content":
                this.cycleContent(1);
                return;
            case "previous-content":
                this.cycleContent(-1);
                return;
            case "toggle-left-panel-files":
                (this.layoutModel ?? WorkspaceLayoutModel.getInstance()).toggleLeftPanel("files");
                return;
        }
    }

    requireTopTabController(): WorkspaceTopTabController {
        if (!this.topTabController) {
            throw new Error("Workspace Top Tab controller is unavailable");
        }
        return this.topTabController;
    }

    closeActive(): void {
        const activeContent = globalStore.get(this.model.contentStateAtom).activeContent;
        if (activeContent.kind === "agent") {
            return;
        }
        if (activeContent.kind === "top-tab") {
            this.runTerminalCommand({ type: "close-active" }, () =>
                this.topTabClose
                    ? this.topTabClose.close(activeContent.topTabId)
                    : Promise.resolve(this.model.closeTopTab(activeContent.topTabId) as unknown as boolean)
            );
            return;
        }
        const command: WorkspaceCommand = { type: "close-active" };
        this.runTerminalCommand(command, () => this.terminalCommands.close(activeContent.terminalTabId));
    }

    runTerminalCommand(command: WorkspaceCommand, invoke: () => void | Promise<unknown>): void {
        try {
            const result = invoke();
            if (result) {
                void result.catch((error) => this.reportCommandError(error, command));
            }
        } catch (error) {
            this.reportCommandError(error, command);
        }
    }

    reportCommandError(error: unknown, command: WorkspaceCommand): void {
        try {
            this.reportError(error, command);
        } catch (reportError) {
            console.error(`workspace command ${command.type} error reporter failed`, reportError);
        }
    }

    cycleContent(direction: 1 | -1): void {
        const state = globalStore.get(this.model.contentStateAtom);
        const contents: ActiveContent[] = [{ kind: "agent" }];
        const terminalTabIds = [...new Set(this.terminalNavigation.getTerminalTabIds().filter(Boolean))];
        contents.push(...terminalTabIds.map((terminalTabId) => ({ kind: "terminal" as const, terminalTabId })));
        contents.push(...state.topTabs.map((tab) => ({ kind: "top-tab" as const, topTabId: tab.id })));

        const activeKey = contentKey(state.activeContent);
        const activeIndex = contents.findIndex((content) => contentKey(content) === activeKey);
        const baseIndex = activeIndex === -1 ? 0 : activeIndex;
        const nextIndex = (baseIndex + direction + contents.length) % contents.length;
        this.activateContent(contents[nextIndex]);
    }

    activateContent(content: ActiveContent): void {
        switch (content.kind) {
            case "agent":
                this.model.activateAgent();
                return;
            case "terminal":
                this.terminalNavigation.activate(content.terminalTabId);
                return;
            case "top-tab":
                this.model.activateTopTab(content.topTabId);
                return;
        }
    }
}
