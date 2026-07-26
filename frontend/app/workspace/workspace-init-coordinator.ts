// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface WorkspaceInitIdentity {
    workspaceId: string;
    generation: number;
}

export class WorkspaceInitCoordinator {
    latest: WorkspaceInitIdentity;
    queue = Promise.resolve();

    isCurrent(identity: WorkspaceInitIdentity): boolean {
        return this.latest?.generation === identity.generation && this.latest?.workspaceId === identity.workspaceId;
    }

    run(identity: WorkspaceInitIdentity, task: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
        if (this.latest != null && identity.generation < this.latest.generation) {
            return Promise.resolve();
        }
        this.latest = identity;
        const run = this.queue
            .catch(() => {})
            .then(async () => {
                if (!this.isCurrent(identity)) {
                    return;
                }
                await task(() => this.isCurrent(identity));
            });
        this.queue = run;
        return run;
    }
}
