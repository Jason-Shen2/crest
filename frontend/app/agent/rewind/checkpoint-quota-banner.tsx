// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { Button } from "@/shadcn/ui/button";

export interface CheckpointQuotaBannerProps {
    quota: AgentCheckpointQuotaView;
    busy: boolean;
    mutationsDisabled?: boolean;
    onCleanup: () => void;
    onManage: () => void;
}

function quotaMessage(quota: AgentCheckpointQuotaView): string {
    if (quota.status === "referenced-over-quota") {
        const explanation =
            "Checkpoint snapshots are still referenced by agent sessions. Archive and moving sessions to trash do not release this storage. Permanent deletion removes a trashed session, but snapshots may remain referenced by workspace history.";
        return quota.message ? `${quota.message}. ${explanation}` : explanation;
    }
    return quota.message ?? "Checkpoint storage exceeds its soft quota. New workspace captures are paused.";
}

export function CheckpointQuotaBanner({
    quota,
    busy,
    mutationsDisabled = false,
    onCleanup,
    onManage,
}: CheckpointQuotaBannerProps) {
    if (quota.status === "ok") {
        return null;
    }

    return (
        <section
            aria-busy={busy}
            className="grid gap-2 rounded-2xl border border-amber-300/25 bg-amber-400/10 px-3 py-2.5 text-sm"
            role="status"
        >
            <div>
                <p className="font-medium text-amber-100">Checkpoint storage needs attention</p>
                <p className="mt-0.5 text-xs text-amber-100/80">{quotaMessage(quota)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
                <Button
                    className="cursor-pointer"
                    disabled={busy || mutationsDisabled || !quota.cleanupAvailable}
                    onClick={onCleanup}
                    size="sm"
                    variant="outline"
                >
                    Clean up unreferenced snapshots
                </Button>
                <Button
                    className="cursor-pointer"
                    disabled={busy || mutationsDisabled}
                    onClick={onManage}
                    size="sm"
                    variant="outline"
                >
                    Manage checkpoint storage
                </Button>
            </div>
        </section>
    );
}
