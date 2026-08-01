// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { TopTabRuntimeHost, type TopTabSurfaceFactories } from "./top-tab-runtime-host";
import type { TopTabRuntime, WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import { WorkspaceContentSlot } from "./workspace-content-slot";
import type { TopTab } from "./workspace-content-state";
import { WorkspaceFileContentSlot } from "./workspace-file-content-slot";

type FileTopTab = Extract<TopTab, { kind: "file" }>;
type EphemeralTopTab = Extract<TopTab, { kind: "preview" | "git-diff" | "agent-turn-diff" }>;

export interface TopTabContentDeckProps {
    topTabs: TopTab[];
    activeTopTabId?: string;
    registry: WorkspaceTopTabRuntimeRegistry;
    createRuntime(tab: TopTab): TopTabRuntime;
    factories: TopTabSurfaceFactories;
}

function LoadingTopTabSurface({ title }: { title: string }) {
    return (
        <div className="flex h-full items-center justify-center" role="status">
            {`Loading ${title}`}
        </div>
    );
}

function isEphemeralTopTab(tab: TopTab): tab is EphemeralTopTab {
    return tab.kind === "preview" || tab.kind === "git-diff" || tab.kind === "agent-turn-diff";
}

export function TopTabContentDeck({
    topTabs,
    activeTopTabId,
    registry,
    createRuntime,
    factories,
}: TopTabContentDeckProps) {
    const activeTopTab = activeTopTabId ? topTabs.find((tab) => tab.id === activeTopTabId) : undefined;
    const activeFileTab = activeTopTab?.kind === "file" ? activeTopTab : undefined;
    const activeEphemeralTab = activeTopTab && isEphemeralTopTab(activeTopTab) ? activeTopTab : undefined;
    const [activatedFileTabIds, setActivatedFileTabIds] = useState<ReadonlySet<string>>(() => new Set());
    const [mountedEphemeralTopTabId, setMountedEphemeralTopTabId] = useState<string>();

    useEffect(() => {
        setActivatedFileTabIds((current) => {
            const availableFileTabIds = new Set(topTabs.filter((tab) => tab.kind === "file").map((tab) => tab.id));
            const next = new Set<string>();
            let changed = false;
            current.forEach((topTabId) => {
                if (availableFileTabIds.has(topTabId)) {
                    next.add(topTabId);
                    return;
                }
                changed = true;
            });
            if (activeFileTab && !next.has(activeFileTab.id)) {
                next.add(activeFileTab.id);
                changed = true;
            }
            return changed ? next : current;
        });
    }, [activeFileTab, topTabs]);

    useEffect(() => {
        setMountedEphemeralTopTabId(activeEphemeralTab?.id);
    }, [activeEphemeralTab?.id]);

    const fileTabs = topTabs.filter((tab): tab is FileTopTab => tab.kind === "file");
    const activeEphemeralTabIsMounted =
        activeEphemeralTab != null && mountedEphemeralTopTabId === activeEphemeralTab.id;

    return (
        <>
            {fileTabs.map((tab) => {
                const active = activeFileTab?.id === tab.id;
                const mounted = activatedFileTabIds.has(tab.id);
                if (!active && !mounted) {
                    return null;
                }
                return (
                    <WorkspaceFileContentSlot
                        active={active}
                        key={tab.id}
                        tab={tab}
                        registry={registry}
                        createRuntime={createRuntime}
                        factories={factories}
                    />
                );
            })}
            {activeEphemeralTab && !activeEphemeralTabIsMounted ? (
                <WorkspaceContentSlot active={true} testId={`ephemeral-top-tab-surface-${activeEphemeralTab.id}`}>
                    <LoadingTopTabSurface title={activeEphemeralTab.title} />
                </WorkspaceContentSlot>
            ) : null}
            {activeEphemeralTab && activeEphemeralTabIsMounted ? (
                <WorkspaceContentSlot active={true} testId={`ephemeral-top-tab-surface-${activeEphemeralTab.id}`}>
                    <TopTabRuntimeHost
                        activeTab={activeEphemeralTab}
                        registry={registry}
                        createRuntime={createRuntime}
                        factories={factories}
                    />
                </WorkspaceContentSlot>
            ) : null}
        </>
    );
}
