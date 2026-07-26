// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo, useEffect, useState } from "react";
import { TopTabRuntimeHost, type TopTabSurfaceFactories } from "./top-tab-runtime-host";
import type { TopTabRuntime, TopTabRuntimeSnapshot, WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import { WorkspaceContentSlot } from "./workspace-content-slot";
import type { TopTab } from "./workspace-content-state";

type FileTopTab = Extract<TopTab, { kind: "file" }>;

interface RuntimeSnapshotOwner {
    registry: WorkspaceTopTabRuntimeRegistry;
    tabId: string;
    snapshot: TopTabRuntimeSnapshot;
}

export interface WorkspaceFileContentSlotProps {
    active: boolean;
    tab: FileTopTab;
    registry: WorkspaceTopTabRuntimeRegistry;
    createRuntime(tab: TopTab): TopTabRuntime;
    factories: TopTabSurfaceFactories;
}

function LoadingFileSurface({ title }: { title: string }) {
    return (
        <div className="flex h-full items-center justify-center" role="status">
            {`Loading ${title}`}
        </div>
    );
}

const StableFileRuntimeHost = memo(function StableFileRuntimeHost({
    tab,
    registry,
    createRuntime,
    factories,
}: Omit<WorkspaceFileContentSlotProps, "active">) {
    return (
        <TopTabRuntimeHost activeTab={tab} registry={registry} createRuntime={createRuntime} factories={factories} />
    );
});
StableFileRuntimeHost.displayName = "StableFileRuntimeHost";

export function WorkspaceFileContentSlot({
    active,
    tab,
    registry,
    createRuntime,
    factories,
}: WorkspaceFileContentSlotProps) {
    const [runtimeSnapshotOwner, setRuntimeSnapshotOwner] = useState<RuntimeSnapshotOwner>();

    useEffect(() => {
        const runtime = registry.getOrCreate(tab.id, () => createRuntime(tab));
        const update = () => setRuntimeSnapshotOwner({ registry, tabId: tab.id, snapshot: runtime.getSnapshot() });
        update();
        return runtime.subscribe(update);
    }, [createRuntime, registry, tab]);

    const runtimeSnapshot =
        runtimeSnapshotOwner?.registry === registry && runtimeSnapshotOwner.tabId === tab.id
            ? runtimeSnapshotOwner.snapshot
            : undefined;
    const status = runtimeSnapshot?.status;
    const showRuntime = status === "ready" || status === "error";
    return (
        <WorkspaceContentSlot active={active} testId={`file-top-tab-surface-${tab.id}`}>
            {showRuntime ? (
                <StableFileRuntimeHost
                    tab={tab}
                    registry={registry}
                    createRuntime={createRuntime}
                    factories={factories}
                />
            ) : (
                <LoadingFileSurface title={tab.title} />
            )}
        </WorkspaceContentSlot>
    );
}
