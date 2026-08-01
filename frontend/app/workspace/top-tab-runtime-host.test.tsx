// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopTabRuntimeHost, type TopTabSurfaceFactories } from "./top-tab-runtime-host";
import type { TopTabRuntime } from "./top-tab-runtime-registry";
import { WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import type { TopTab } from "./workspace-content-state";

const performanceTrace = vi.hoisted(() => ({
    record: vi.fn(),
    now: vi.fn(() => 0),
}));

vi.mock("./top-tab-performance", () => ({
    recordTopTabPerformance: performanceTrace.record,
    topTabPerformanceNow: performanceTrace.now,
}));

const FileTab: TopTab = { id: "file-1", kind: "file", path: "/repo/a.ts", title: "a.ts" };
const PreviewTab: TopTab = { id: "preview-1", kind: "preview", path: "/repo/a.md", title: "a.md" };
const DiffTab: TopTab = {
    id: "diff-1",
    kind: "git-diff",
    repoRoot: "/repo",
    path: "a.ts",
    mode: "+",
    originalPath: "",
    title: "a.ts",
};
const AgentTurnDiffTab: TopTab = {
    id: "turn-diff-1",
    kind: "agent-turn-diff",
    sessionId: "session-1",
    sessionCreatedAt: "2026-08-02T12:00:00.000Z",
    sessionCwd: "/repo",
    sessionPath: "/sessions/session-1.db",
    turnId: "turn-1",
    path: "src/a.ts",
    title: "a.ts",
};

function runtime(title: string): TopTabRuntime {
    return {
        getSnapshot: () => ({ dirty: false, title, status: "ready" }),
        subscribe: () => () => {},
        dispose: vi.fn(),
    };
}

function factories(): TopTabSurfaceFactories {
    return {
        renderFile: (tab) => <div>file:{tab.id}</div>,
        renderPreview: (tab) => <div>preview:{tab.id}</div>,
        renderGitDiff: (tab) => <div>diff:{tab.id}</div>,
        renderAgentTurnDiff: (tab) => <div>turn-diff:{tab.id}</div>,
    };
}

afterEach(() => {
    cleanup();
    performanceTrace.record.mockReset();
    performanceTrace.now.mockReset();
    performanceTrace.now.mockReturnValue(0);
});

describe("TopTabRuntimeHost", () => {
    it("traces each successfully committed active descriptor from its own mount", () => {
        performanceTrace.now
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(110)
            .mockReturnValueOnce(200)
            .mockReturnValueOnce(225)
            .mockReturnValueOnce(300)
            .mockReturnValueOnce(340);
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const view = render(
            <TopTabRuntimeHost
                activeTab={FileTab}
                registry={registry}
                createRuntime={(tab) => runtime(tab.title)}
                factories={factories()}
            />
        );

        view.rerender(
            <TopTabRuntimeHost
                activeTab={PreviewTab}
                registry={registry}
                createRuntime={(tab) => runtime(tab.title)}
                factories={factories()}
            />
        );
        view.rerender(
            <TopTabRuntimeHost
                activeTab={DiffTab}
                registry={registry}
                createRuntime={(tab) => runtime(tab.title)}
                factories={factories()}
            />
        );
        view.rerender(
            <TopTabRuntimeHost
                activeTab={AgentTurnDiffTab}
                registry={registry}
                createRuntime={(tab) => runtime(tab.title)}
                factories={factories()}
            />
        );

        expect(performanceTrace.record.mock.calls).toEqual([
            ["top-tab-first-content", { kind: "file", id: "file-1", duration: 10 }],
            ["top-tab-first-content", { kind: "preview", id: "preview-1", duration: 25 }],
            ["top-tab-first-content", { kind: "git-diff", id: "diff-1", duration: 40 }],
            ["top-tab-first-content", { kind: "agent-turn-diff", id: "turn-diff-1", duration: 0 }],
        ]);
        expect(JSON.stringify(performanceTrace.record.mock.calls)).not.toMatch(/\/repo|a\.ts|a\.md/);
    });

    it("does not trace first content when the active surface commits an error fallback", () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const failingFactories = factories();
        failingFactories.renderFile = () => {
            throw new Error("render failed");
        };

        render(
            <TopTabRuntimeHost
                activeTab={FileTab}
                registry={new WorkspaceTopTabRuntimeRegistry()}
                createRuntime={() => runtime("a.ts")}
                factories={failingFactories}
            />
        );

        expect(screen.getByText("render failed")).toBeTruthy();
        expect(performanceTrace.record).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it("releases the closing file alias without disposing another alias owner", async () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const sharedRuntime = {
            ...runtime("a.ts"),
            disposeAlias: vi.fn(),
        };
        registry.getOrCreate("file-1", () => sharedRuntime);
        registry.getOrCreate("file-2", () => sharedRuntime);

        await registry.close("file-1");

        expect(sharedRuntime.disposeAlias).toHaveBeenCalledWith("file-1");
        expect(sharedRuntime.dispose).not.toHaveBeenCalled();
        expect(registry.get("file-2")).toBe(sharedRuntime);
    });

    it("renders one active panel, creates File on first activation, and retains its runtime when the host is removed", () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const fileRuntime = runtime("a.ts");
        const createRuntime = vi.fn(() => fileRuntime);
        const view = render(
            <TopTabRuntimeHost
                activeTab={FileTab}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories()}
            />
        );
        expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
        expect(screen.getByText("file:file-1")).toBeTruthy();
        expect(screen.getByRole("tabpanel").firstElementChild?.classList.contains("h-full")).toBe(true);
        view.rerender(
            <TopTabRuntimeHost
                activeTab={undefined}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories()}
            />
        );
        expect(registry.get("file-1")).toBe(fileRuntime);
        view.rerender(
            <TopTabRuntimeHost
                activeTab={FileTab}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories()}
            />
        );
        expect(createRuntime).toHaveBeenCalledTimes(1);
    });

    it.each([PreviewTab, DiffTab, AgentTurnDiffTab])(
        "disposes $kind adapters when the active surface unmounts",
        async (tab) => {
            const registry = new WorkspaceTopTabRuntimeRegistry();
            const adapter = runtime(tab.title);
            const view = render(
                <TopTabRuntimeHost
                    activeTab={tab}
                    registry={registry}
                    createRuntime={() => adapter}
                    factories={factories()}
                />
            );
            view.rerender(
                <TopTabRuntimeHost
                    activeTab={undefined}
                    registry={registry}
                    createRuntime={() => adapter}
                    factories={factories()}
                />
            );
            await vi.waitFor(() => expect(adapter.dispose).toHaveBeenCalledTimes(1));
            expect(registry.get(tab.id)).toBeUndefined();
        }
    );

    it.each([PreviewTab, DiffTab, AgentTurnDiffTab])(
        "keeps the active $kind adapter alive through StrictMode replay",
        async (tab) => {
            const registry = new WorkspaceTopTabRuntimeRegistry();
            const adapter = runtime(tab.title);
            const view = render(
                <StrictMode>
                    <TopTabRuntimeHost
                        activeTab={tab}
                        registry={registry}
                        createRuntime={() => adapter}
                        factories={factories()}
                    />
                </StrictMode>
            );

            await Promise.resolve();
            expect(registry.get(tab.id)).toBe(adapter);
            expect(adapter.dispose).not.toHaveBeenCalled();
            expect(performanceTrace.record).toHaveBeenCalledTimes(1);
            expect(performanceTrace.record).toHaveBeenCalledWith("top-tab-first-content", {
                kind: tab.kind,
                id: tab.id,
                duration: 0,
            });

            view.unmount();
            await vi.waitFor(() => expect(adapter.dispose).toHaveBeenCalledTimes(1));
        }
    );

    it("does not retire a reactivated ephemeral runtime during an A to B to A switch", async () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const runtimeA = runtime("a.md");
        const runtimeB = runtime("diff");
        const createRuntime = (tab: TopTab) => (tab.id === PreviewTab.id ? runtimeA : runtimeB);
        const view = render(
            <TopTabRuntimeHost
                activeTab={PreviewTab}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories()}
            />
        );

        view.rerender(
            <TopTabRuntimeHost
                activeTab={DiffTab}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories()}
            />
        );
        view.rerender(
            <TopTabRuntimeHost
                activeTab={PreviewTab}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories()}
            />
        );
        await Promise.resolve();

        expect(registry.get(PreviewTab.id)).toBe(runtimeA);
        expect(runtimeA.dispose).not.toHaveBeenCalled();
    });

    it("contains a rejected ephemeral adapter disposal on unmount", async () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const adapter = runtime("a.md");
        vi.mocked(adapter.dispose).mockRejectedValue(new Error("dispose failed"));
        const view = render(
            <TopTabRuntimeHost
                activeTab={PreviewTab}
                registry={registry}
                createRuntime={() => adapter}
                factories={factories()}
            />
        );

        view.unmount();
        await vi.waitFor(() => expect(registry.disposeErrors).toHaveLength(1));
    });

    it("retries a failed surface with a retry key owned by its Top Tab", () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        let shouldFail = true;
        const failingFactories = factories();
        failingFactories.renderFile = () => {
            if (shouldFail) {
                throw new Error("render failed");
            }
            return <div>recovered</div>;
        };
        render(
            <TopTabRuntimeHost
                activeTab={FileTab}
                registry={new WorkspaceTopTabRuntimeRegistry()}
                createRuntime={() => runtime("a.ts")}
                factories={failingFactories}
            />
        );
        expect(screen.getByText("render failed")).toBeTruthy();
        shouldFail = false;
        fireEvent.click(screen.getByRole("button", { name: "Retry a.ts" }));
        expect(screen.getByText("recovered")).toBeTruthy();
        consoleError.mockRestore();
    });
});
