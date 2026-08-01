// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { Atom } from "jotai";
import type { TopTabCloseCoordinator } from "./top-tab-close-coordinator";
import { recordTopTabPerformance, topTabPerformanceNow } from "./top-tab-performance";
import type { GitDiffMode, TopTab } from "./workspace-content-state";
import { isValidTopTab, normalizeFileTabPath, topTabIdentityKey } from "./workspace-content-state";

export interface WorkspaceTopTabController {
    openFile(path: string): string;
    openPreview(path: string): string;
    openGitDiff(input: { repoRoot: string; path: string; mode: GitDiffMode; originalPath?: string }): string;
    openAgentTurnDiff(input: { sessionMetadata: AgentSessionMeta; turnId: string; path: string }): string;
    activate(topTabId: string): void;
    close(topTabId: string): Promise<boolean>;
    relocateFile(topTabId: string, path: string): boolean;
}

interface WorkspaceTopTabModel {
    contentStateAtom: Atom<{ topTabs: TopTab[] }>;
    openTopTab(tab: TopTab): void;
    activateTopTab(topTabId: string): void;
    closeTopTab(topTabId: string): void;
    updateTopTab(topTabId: string, updates: { kind: "file"; path?: string; title?: string }): void;
    registerPreReplacementTeardown(teardown: () => void): () => void;
}

function titleForPath(path: string): string {
    const normalized = normalizeFileTabPath(path);
    return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

class WorkspaceTopTabControllerImpl implements WorkspaceTopTabController {
    model: WorkspaceTopTabModel;
    closeCoordinator: TopTabCloseCoordinator;
    topTabIdByIdentity = new Map<string, string>();
    identityByTopTabId = new Map<string, string>();
    unregisterTeardown: () => void = () => {};
    unsubscribeContentState: () => void = () => {};
    attached = false;
    disposed = false;

    constructor(model: WorkspaceTopTabModel, closeCoordinator?: TopTabCloseCoordinator) {
        this.model = model;
        this.closeCoordinator = closeCoordinator;
    }

    openFile(path: string): string {
        const normalizedPath = normalizeFileTabPath(path);
        return this.open({
            id: "",
            kind: "file",
            path: normalizedPath,
            title: titleForPath(normalizedPath),
        });
    }

    openPreview(path: string): string {
        const normalizedPath = normalizeFileTabPath(path);
        return this.open({
            id: "",
            kind: "preview",
            path: normalizedPath,
            title: titleForPath(normalizedPath),
        });
    }

    openGitDiff(input: { repoRoot: string; path: string; mode: GitDiffMode; originalPath?: string }): string {
        const repoRoot = normalizeFileTabPath(input.repoRoot);
        const path = normalizeFileTabPath(input.path);
        const originalPath = normalizeFileTabPath(input.originalPath ?? "");
        return this.open({
            id: "",
            kind: "git-diff",
            repoRoot,
            path,
            mode: input.mode,
            originalPath,
            title: titleForPath(path),
        });
    }

    openAgentTurnDiff(input: { sessionMetadata: AgentSessionMeta; turnId: string; path: string }): string {
        const sessionPath = normalizeFileTabPath(input.sessionMetadata?.path ?? "");
        const sessionCwd = normalizeFileTabPath(input.sessionMetadata?.cwd ?? "");
        return this.open({
            id: "",
            kind: "agent-turn-diff",
            sessionId: input.sessionMetadata?.id ?? "",
            sessionCreatedAt: input.sessionMetadata?.createdAt ?? "",
            sessionCwd,
            sessionPath,
            turnId: input.turnId,
            path: input.path,
            title: titleForPath(input.path),
        });
    }

    activate(topTabId: string): void {
        this.assertActive();
        const startedAt = topTabPerformanceNow();
        this.model.activateTopTab(topTabId);
        const tab = globalStore.get(this.model.contentStateAtom).topTabs.find((candidate) => candidate.id === topTabId);
        if (tab) {
            recordTopTabPerformance("top-tab-activate", {
                kind: tab.kind,
                id: tab.id,
                duration: topTabPerformanceNow() - startedAt,
            });
        }
    }

    async close(topTabId: string): Promise<boolean> {
        this.assertActive();
        const identity = this.identityByTopTabId.get(topTabId);
        if (!identity) {
            return false;
        }
        if (this.closeCoordinator && !(await this.closeCoordinator.close(topTabId))) {
            return false;
        }
        if (!this.closeCoordinator) {
            this.model.closeTopTab(topTabId);
        }
        this.identityByTopTabId.delete(topTabId);
        this.topTabIdByIdentity.delete(identity);
        return true;
    }

    relocateFile(topTabId: string, path: string): boolean {
        this.assertActive();
        const normalizedPath = normalizeFileTabPath(path);
        const state = globalStore.get(this.model.contentStateAtom);
        const current = state.topTabs.find((tab) => tab.id === topTabId);
        if (current?.kind !== "file") {
            return false;
        }
        const destinationIdentity = topTabIdentityKey({ ...current, path: normalizedPath });
        if (
            state.topTabs.some(
                (tab) => tab.id !== topTabId && tab.kind === "file" && topTabIdentityKey(tab) === destinationIdentity
            )
        ) {
            return false;
        }
        this.model.updateTopTab(topTabId, {
            kind: "file",
            path: normalizedPath,
            title: titleForPath(normalizedPath),
        });
        return globalStore
            .get(this.model.contentStateAtom)
            .topTabs.some((tab) => tab.id === topTabId && tab.kind === "file" && tab.path === normalizedPath);
    }

    open(descriptor: TopTab): string {
        this.assertActive();
        const startedAt = topTabPerformanceNow();
        if (!isValidTopTab({ ...descriptor, id: "candidate" })) {
            throw new Error("Invalid Top Tab descriptor");
        }
        const identity = topTabIdentityKey(descriptor);
        const existingId = this.topTabIdByIdentity.get(identity);
        if (existingId) {
            this.model.activateTopTab(existingId);
            recordTopTabPerformance("top-tab-activate", {
                kind: descriptor.kind,
                id: existingId,
                duration: topTabPerformanceNow() - startedAt,
            });
            return existingId;
        }
        const id = crypto.randomUUID();
        this.model.openTopTab({ ...descriptor, id });
        const accepted = globalStore
            .get(this.model.contentStateAtom)
            .topTabs.some((tab) => tab.id === id && topTabIdentityKey(tab) === identity);
        if (!accepted) {
            throw new Error("Workspace model rejected Top Tab");
        }
        recordTopTabPerformance("top-tab-open", {
            kind: descriptor.kind,
            id,
            duration: topTabPerformanceNow() - startedAt,
        });
        return id;
    }

    assertActive(): void {
        if (!this.attached || this.disposed) {
            throw new Error("Workspace Top Tab controller is disposed");
        }
    }

    start(): void {
        if (this.disposed) {
            throw new Error("Workspace Top Tab controller is disposed");
        }
        if (this.attached) {
            return;
        }
        this.attached = true;
        this.syncIdentities();
        this.unsubscribeContentState = globalStore.sub(this.model.contentStateAtom, () => this.syncIdentities());
        this.unregisterTeardown = this.model.registerPreReplacementTeardown(() => this.dispose());
    }

    stop(): void {
        if (!this.attached) {
            return;
        }
        this.attached = false;
        this.unsubscribeContentState();
        this.unregisterTeardown();
        this.unsubscribeContentState = () => {};
        this.unregisterTeardown = () => {};
        this.topTabIdByIdentity.clear();
        this.identityByTopTabId.clear();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.stop();
        this.disposed = true;
    }

    syncIdentities(): void {
        this.topTabIdByIdentity.clear();
        this.identityByTopTabId.clear();
        for (const tab of globalStore.get(this.model.contentStateAtom).topTabs) {
            const identity = topTabIdentityKey(tab);
            this.topTabIdByIdentity.set(identity, tab.id);
            this.identityByTopTabId.set(tab.id, identity);
        }
    }
}

export function makeWorkspaceTopTabController(
    model: WorkspaceTopTabModel,
    closeCoordinator?: TopTabCloseCoordinator
): WorkspaceTopTabController & { start(): void; stop(): void; dispose(): void } {
    return new WorkspaceTopTabControllerImpl(model, closeCoordinator);
}
