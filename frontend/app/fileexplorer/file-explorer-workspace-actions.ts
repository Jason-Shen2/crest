// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface FileExplorerWorkspaceActions {
    openFile(path: string): Promise<void>;
    renamePath(oldPath: string, newPath: string): Promise<boolean>;
    deletePath(path: string): Promise<boolean>;
    createTerminal(cwd: string): Promise<void>;
}

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TerminalNavigationAdapter } from "@/app/workspace/terminal-navigation";
import type { TopTabCloseCoordinator } from "@/app/workspace/top-tab-close-coordinator";
import type { WorkspaceTopTabController } from "@/app/workspace/top-tab-controller";
import { normalizeFileTabPath, type TopTab } from "@/app/workspace/workspace-content-state";
import type { WorkspaceEditorRegistry } from "@/app/workspace/workspace-editor-registry";
import type { WorkspaceModel } from "@/app/workspace/workspace-model";
import { joinLocalPath } from "@/util/local-path";
import { formatRemoteUri } from "@/util/waveutil";

type FileMutationRpc = {
    rename(oldPath: string, newPath: string): Promise<void>;
    delete(path: string): Promise<void>;
};

export interface FileExplorerWorkspaceActionDependencies {
    controller: Pick<WorkspaceTopTabController, "openFile">;
    closeCoordinator: Pick<TopTabCloseCoordinator, "prepareFileMutationsSession">;
    editorRegistry: WorkspaceEditorRegistry;
    homeDir: string;
    model: Pick<WorkspaceModel, "contentStateAtom" | "updateTopTab" | "closeTopTab">;
    terminalNavigation: Pick<TerminalNavigationAdapter, "create">;
    rpc?: FileMutationRpc;
}

function isPathOrChild(path: string, target: string): boolean {
    return path === target || path.startsWith(`${target}/`);
}

function replacePathPrefix(path: string, oldPrefix: string, newPrefix: string): string {
    return path === oldPrefix ? newPrefix : `${newPrefix}${path.slice(oldPrefix.length)}`;
}

function resolveFileExplorerPath(path: string, homeDir: string): string {
    const normalizedPath = path.replace(/\\/g, "/");
    if (normalizedPath !== "~" && !normalizedPath.startsWith("~/")) {
        return normalizeFileTabPath(normalizedPath);
    }
    const normalizedHome = normalizeFileTabPath(homeDir);
    const homeRelativePath = normalizedPath === "~" ? "" : normalizedPath.slice(2);
    return homeRelativePath ? normalizeFileTabPath(joinLocalPath(normalizedHome, homeRelativePath)) : normalizedHome;
}

function defaultRpc(): FileMutationRpc {
    return {
        rename: (oldPath, newPath) =>
            RpcApi.FileMoveCommand(TabRpcClient, {
                srcuri: formatRemoteUri(oldPath, "local"),
                desturi: formatRemoteUri(newPath, "local"),
            }),
        delete: (path) =>
            RpcApi.FileDeleteCommand(TabRpcClient, {
                path: formatRemoteUri(path, "local"),
                recursive: true,
            }),
    };
}

export function makeFileExplorerWorkspaceActions(
    deps: FileExplorerWorkspaceActionDependencies
): FileExplorerWorkspaceActions {
    const rpc = deps.rpc ?? defaultRpc();
    let mutationTail = Promise.resolve();

    function serialize<T>(operation: () => Promise<T>): Promise<T> {
        const next = mutationTail.then(operation, operation);
        mutationTail = next.then(
            () => {},
            () => {}
        );
        return next;
    }

    function affected(target: string): Array<Extract<TopTab, { kind: "file" | "preview" }>> {
        const normalized = normalizeFileTabPath(target);
        return globalStore
            .get(deps.model.contentStateAtom)
            .topTabs.filter(
                (tab): tab is Extract<TopTab, { kind: "file" | "preview" }> =>
                    (tab.kind === "file" || tab.kind === "preview") && isPathOrChild(tab.path, normalized)
            );
    }

    return {
        async openFile(path) {
            deps.controller.openFile(resolveFileExplorerPath(path, deps.homeDir));
        },
        renamePath(oldPath, newPath) {
            return serialize(async () => {
                const oldNormalized = resolveFileExplorerPath(oldPath, deps.homeDir);
                const newNormalized = resolveFileExplorerPath(newPath, deps.homeDir);
                const tabs = affected(oldNormalized);
                const prepared = await deps.closeCoordinator.prepareFileMutationsSession(tabs.map((tab) => tab.id));
                if (!prepared) {
                    return false;
                }
                const runtimes = [
                    ...new Set(
                        [...deps.editorRegistry.runtimesByPath.entries()]
                            .filter(([path]) => isPathOrChild(path, oldNormalized))
                            .map(([, runtime]) => runtime)
                    ),
                ];
                const migrations = runtimes.map((runtime) => ({
                    oldPath: runtime.path,
                    newPath: replacePathPrefix(runtime.path, oldNormalized, newNormalized),
                }));
                let filesystemRenamed = false;
                const renameFilesystem = async () => {
                    await rpc.rename(oldNormalized, newNormalized);
                    filesystemRenamed = true;
                };
                try {
                    await deps.editorRegistry.migratePaths(migrations, renameFilesystem);
                    for (const tab of tabs) {
                        deps.model.updateTopTab(tab.id, {
                            kind: tab.kind,
                            path: replacePathPrefix(tab.path, oldNormalized, newNormalized),
                        });
                    }
                    prepared.commit();
                    return true;
                } catch (error) {
                    if (filesystemRenamed) {
                        await deps.editorRegistry
                            .migratePaths(
                                migrations.map(({ oldPath, newPath }) => ({
                                    oldPath: newPath,
                                    newPath: oldPath,
                                })),
                                () => rpc.rename(newNormalized, oldNormalized)
                            )
                            .catch(() => {});
                    }
                    for (const tab of tabs) {
                        deps.model.updateTopTab(tab.id, { kind: tab.kind, path: tab.path });
                    }
                    prepared.rollback();
                    throw error;
                }
            });
        },
        deletePath(path) {
            return serialize(async () => {
                const normalized = resolveFileExplorerPath(path, deps.homeDir);
                const tabs = affected(normalized);
                const prepared = await deps.closeCoordinator.prepareFileMutationsSession(tabs.map((tab) => tab.id));
                if (!prepared) {
                    return false;
                }
                const runtimes = [
                    ...new Set(
                        [...deps.editorRegistry.runtimesByPath.entries()]
                            .filter(([runtimePath]) => isPathOrChild(runtimePath, normalized))
                            .map(([, runtime]) => runtime)
                    ),
                ];
                try {
                    await deps.editorRegistry.deletePaths(
                        runtimes.map((runtime) => runtime.path),
                        () => rpc.delete(normalized)
                    );
                    for (const tab of tabs) {
                        deps.model.closeTopTab(tab.id);
                    }
                    prepared.commit();
                    return true;
                } catch (error) {
                    prepared.rollback();
                    throw error;
                }
            });
        },
        async createTerminal(cwd) {
            await deps.terminalNavigation.create({ cwd: resolveFileExplorerPath(cwd, deps.homeDir) });
        },
    };
}
