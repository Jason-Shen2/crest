// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type WorkspaceSwitchTransactionResult =
    | { status: "committed"; workspaceId: string }
    | { status: "rolled-back"; workspaceId: string }
    | { status: "recovered-new"; workspaceId: string }
    | { status: "fatal"; workspaceId?: string; error: unknown };

export interface WorkspaceSwitchTransactionOptions {
    oldWorkspaceId: string;
    newWorkspaceId: string;
    switchBackend(workspaceId: string): Promise<boolean>;
    getBackendWorkspaceId(): Promise<string>;
    initialize(workspaceId: string): Promise<boolean>;
    commitOldView(): void;
    finalizePreparedClose(commit: boolean): boolean;
    enterFatal(error: unknown, authoritativeWorkspaceId?: string): void;
}

async function authoritativeWorkspaceId(options: WorkspaceSwitchTransactionOptions): Promise<string> {
    const workspaceId = await options.getBackendWorkspaceId();
    if (!workspaceId) {
        throw new Error("backend returned an empty authoritative workspace id");
    }
    return workspaceId;
}

export async function runWorkspaceSwitchTransaction(
    options: WorkspaceSwitchTransactionOptions
): Promise<WorkspaceSwitchTransactionResult> {
    try {
        if (!(await options.switchBackend(options.newWorkspaceId))) {
            throw new Error("workspace backend switch was rejected");
        }
        if (!(await options.initialize(options.newWorkspaceId))) {
            throw new Error("new workspace initialization failed");
        }
        if (!options.finalizePreparedClose(true)) {
            throw new Error("prepared workspace close commit could not be delivered");
        }
        options.commitOldView();
        return { status: "committed", workspaceId: options.newWorkspaceId };
    } catch (switchError) {
        let rollbackError: unknown;
        try {
            if ((await authoritativeWorkspaceId(options)) === options.newWorkspaceId) {
                if (!(await options.switchBackend(options.oldWorkspaceId))) {
                    throw new Error("workspace backend rollback was rejected");
                }
            }
        } catch (error) {
            rollbackError = error;
        }

        let backendWorkspaceId: string;
        try {
            backendWorkspaceId = await authoritativeWorkspaceId(options);
        } catch (authorityError) {
            const error = new AggregateError(
                [switchError, rollbackError, authorityError].filter(Boolean),
                "workspace switch authority could not be recovered"
            );
            options.finalizePreparedClose(false);
            options.enterFatal(error);
            return { status: "fatal", error };
        }

        if (backendWorkspaceId === options.oldWorkspaceId) {
            let initialized = false;
            try {
                initialized = await options.initialize(options.oldWorkspaceId);
            } catch (error) {
                rollbackError = error;
            }
            if (initialized && options.finalizePreparedClose(false)) {
                return { status: "rolled-back", workspaceId: options.oldWorkspaceId };
            }
            rollbackError =
                rollbackError ??
                new Error(
                    initialized
                        ? "prepared dirty workspace rollback could not be delivered"
                        : "old workspace renderer rollback failed"
                );
        } else if (backendWorkspaceId === options.newWorkspaceId) {
            let initialized = false;
            try {
                initialized = await options.initialize(options.newWorkspaceId);
            } catch (error) {
                rollbackError = error;
            }
            if (initialized && options.finalizePreparedClose(true)) {
                options.commitOldView();
                return { status: "recovered-new", workspaceId: options.newWorkspaceId };
            }
            rollbackError =
                rollbackError ??
                new Error(
                    initialized
                        ? "prepared workspace close commit could not be delivered"
                        : "new workspace renderer recovery failed"
                );
        } else {
            rollbackError = new Error(`backend selected unexpected workspace ${backendWorkspaceId}`);
        }

        const error = new AggregateError(
            [switchError, rollbackError].filter(Boolean),
            "workspace switch reached an unrecoverable state"
        );
        options.finalizePreparedClose(false);
        options.enterFatal(error, backendWorkspaceId);
        return { status: "fatal", workspaceId: backendWorkspaceId, error };
    }
}
