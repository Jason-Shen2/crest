// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { assertRestorePlanMatchesConfirmation, type ConfirmedRestorePlanV1 } from "./confirmation-token";
import type { WorkspaceMutationLog } from "./workspace-mutation-log";

export async function assertConfirmedRestoreFresh(input: {
    confirmation: ConfirmedRestorePlanV1;
    currentHead: string;
    mode: "normal" | "force-drift";
    mutationLog: Pick<WorkspaceMutationLog, "findForeignOverlap">;
}): Promise<void> {
    assertRestorePlanMatchesConfirmation({
        confirmation: input.confirmation,
        plan: input.confirmation.plan,
        mode: input.mode,
    });
    if (input.currentHead === input.confirmation.authorityHead) return;

    const plan = input.confirmation.plan;
    const overlaps = await input.mutationLog.findForeignOverlap({
        afterCommit: input.confirmation.authorityHead,
        head: input.currentHead,
        paths: plan.paths.map((path) => path.path),
        includedCommits: new Set(),
        ownerSessionId: plan.sessionId,
    });
    for (const overlap of overlaps) {
        throw new Error(`Rewind confirmation is stale for path: ${overlap.path}`);
    }
}
