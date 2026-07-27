// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { isAbsoluteLocalPath } from "@/util/local-path";
import type { WorkspaceTopTabController } from "./top-tab-controller";

const MaxSeenRequestIds = 256;
const SeenRequestIdTtlMs = 5 * 60 * 1000;

export interface WorkspaceOpenContentSubscriptionOptions {
    workspaceId: string;
    generation: number;
    controller: Pick<WorkspaceTopTabController, "openPreview">;
    isCurrent(workspaceId: string, generation: number): boolean;
}

export function subscribeWorkspaceOpenContentEvents(options: WorkspaceOpenContentSubscriptionOptions): () => void {
    const seenRequestIds = new Map<string, number>();
    let disposed = false;
    let unsubscribe = () => {};
    try {
        unsubscribe = waveEventSubscribeSingle({
            eventType: "workspace:open-content",
            scope: `workspace:${options.workspaceId}`,
            handler: (event) => {
                if (disposed || !options.isCurrent(options.workspaceId, options.generation)) {
                    return;
                }
                const data = event.data;
                if (
                    data?.workspaceid !== options.workspaceId ||
                    data.kind !== "preview" ||
                    !isAbsoluteLocalPath(data.path) ||
                    typeof data.requestid !== "string" ||
                    !data.requestid
                ) {
                    return;
                }
                const now = Date.now();
                for (const [requestId, seenAt] of seenRequestIds) {
                    if (now - seenAt <= SeenRequestIdTtlMs) {
                        break;
                    }
                    seenRequestIds.delete(requestId);
                }
                if (seenRequestIds.has(data.requestid)) {
                    seenRequestIds.delete(data.requestid);
                    seenRequestIds.set(data.requestid, now);
                    return;
                }
                seenRequestIds.set(data.requestid, now);
                while (seenRequestIds.size > MaxSeenRequestIds) {
                    seenRequestIds.delete(seenRequestIds.keys().next().value);
                }
                options.controller.openPreview(data.path);
            },
        });
    } catch {
        return () => {};
    }
    return () => {
        disposed = true;
        seenRequestIds.clear();
        unsubscribe();
    };
}
