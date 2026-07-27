// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Component, useEffect, useLayoutEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { recordTopTabPerformance, topTabPerformanceNow } from "./top-tab-performance";
import type { TopTabRuntime, WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import type { TopTab } from "./workspace-content-state";

type FileTopTab = Extract<TopTab, { kind: "file" }>;
type PreviewTopTab = Extract<TopTab, { kind: "preview" }>;
type GitDiffTopTab = Extract<TopTab, { kind: "git-diff" }>;

export interface TopTabSurfaceFactories {
    renderFile(tab: FileTopTab, runtime: TopTabRuntime): ReactNode;
    renderPreview(tab: PreviewTopTab): ReactNode;
    renderGitDiff(tab: GitDiffTopTab): ReactNode;
}

export interface TopTabRuntimeHostProps {
    activeTab?: TopTab;
    registry: WorkspaceTopTabRuntimeRegistry;
    createRuntime(tab: TopTab): TopTabRuntime;
    factories: TopTabSurfaceFactories;
}

interface BoundaryProps {
    tab: TopTab;
    children: ReactNode;
}

interface BoundaryState {
    error?: Error;
    retry: number;
}

class TopTabErrorBoundary extends Component<BoundaryProps, BoundaryState> {
    state: BoundaryState = { retry: 0 };

    static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
        return { error };
    }

    componentDidCatch(_error: Error, _info: ErrorInfo): void {}

    render() {
        if (this.state.error) {
            return (
                <div className="h-full w-full" role="alert">
                    <p>{this.state.error.message}</p>
                    <button
                        aria-label={`Retry ${this.props.tab.title}`}
                        className="cursor-pointer"
                        type="button"
                        onClick={() => this.setState(({ retry }) => ({ error: undefined, retry: retry + 1 }))}
                    >
                        Retry
                    </button>
                </div>
            );
        }
        return (
            <div className="h-full w-full" key={`${this.props.tab.id}:${this.state.retry}`}>
                {this.props.children}
            </div>
        );
    }
}

function ActiveTopTabSurface({
    tab,
    runtime,
    factories,
}: {
    tab: TopTab;
    runtime: TopTabRuntime;
    factories: TopTabSurfaceFactories;
}) {
    switch (tab.kind) {
        case "file":
            return factories.renderFile(tab, runtime);
        case "preview":
            return factories.renderPreview(tab);
        case "git-diff":
            return factories.renderGitDiff(tab);
    }
}

function EphemeralRuntimeOwner({
    topTabId,
    registry,
    runtime,
    children,
}: {
    topTabId: string;
    registry: WorkspaceTopTabRuntimeRegistry;
    runtime: TopTabRuntime;
    children: ReactNode;
}) {
    useEffect(() => {
        registry.cancelScheduledClose(topTabId, runtime);
        return () => registry.scheduleClose(topTabId, runtime);
    }, [registry, runtime, topTabId]);
    return children;
}

function TopTabSuccessfulContent({ tab, children }: { tab: TopTab; children: ReactNode }) {
    const startedAt = useRef(topTabPerformanceNow());
    const recorded = useRef(false);
    useLayoutEffect(() => {
        if (recorded.current) {
            return;
        }
        recorded.current = true;
        recordTopTabPerformance("top-tab-first-content", {
            kind: tab.kind,
            id: tab.id,
            duration: topTabPerformanceNow() - startedAt.current,
        });
    }, [tab.id, tab.kind]);
    return children;
}

export function TopTabRuntimeHost({ activeTab, registry, createRuntime, factories }: TopTabRuntimeHostProps) {
    if (!activeTab) {
        return null;
    }
    const runtime = registry.getOrCreate(activeTab.id, () => createRuntime(activeTab));
    const panel = (
        <section aria-label={activeTab.title} className="absolute inset-0 h-full w-full" role="tabpanel">
            <TopTabErrorBoundary key={activeTab.id} tab={activeTab}>
                <TopTabSuccessfulContent key={activeTab.id} tab={activeTab}>
                    <ActiveTopTabSurface tab={activeTab} runtime={runtime} factories={factories} />
                </TopTabSuccessfulContent>
            </TopTabErrorBoundary>
        </section>
    );
    if (activeTab.kind === "file") {
        return panel;
    }
    return (
        <EphemeralRuntimeOwner topTabId={activeTab.id} registry={registry} runtime={runtime}>
            {panel}
        </EphemeralRuntimeOwner>
    );
}
