// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopTabContentDeck } from "./top-tab-content-deck";
import type { TopTabSurfaceFactories } from "./top-tab-runtime-host";
import type { TopTabRuntime } from "./top-tab-runtime-registry";
import { WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import type { TopTab } from "./workspace-content-state";

const FileA: TopTab = { id: "file-a", kind: "file", path: "/repo/a.ts", title: "a.ts" };
const FileB: TopTab = { id: "file-b", kind: "file", path: "/repo/b.ts", title: "b.ts" };
const PreviewTab: TopTab = { id: "preview-a", kind: "preview", path: "/repo/a.md", title: "a.md" };
const DiffTab: TopTab = {
    id: "diff-a",
    kind: "git-diff",
    repoRoot: "/repo",
    path: "src/a.ts",
    mode: "+",
    originalPath: "",
    title: "a.ts",
};
const AgentTurnDiffTab: TopTab = {
    id: "turn-diff-a",
    kind: "agent-turn-diff",
    sessionId: "session-1",
    sessionCreatedAt: "2026-08-02T12:00:00.000Z",
    sessionCwd: "/repo",
    sessionPath: "/sessions/session-1.db",
    turnId: "turn-1",
    path: "src/a.ts",
    title: "a.ts",
};

function makeRuntime(title: string): TopTabRuntime {
    return {
        getSnapshot: () => ({ dirty: false, title, status: "ready" }),
        subscribe: () => () => {},
        dispose: vi.fn(),
    };
}

function Lifecycle({
    id,
    mounts,
    unmounts,
}: {
    id: string;
    mounts: Map<string, number>;
    unmounts: Map<string, number>;
}) {
    useEffect(() => {
        mounts.set(id, (mounts.get(id) ?? 0) + 1);
        return () => unmounts.set(id, (unmounts.get(id) ?? 0) + 1);
    }, [id, mounts, unmounts]);
    return <div data-testid={`file-body-${id}`}>file:{id}</div>;
}

function makeFactories(
    mounts = new Map<string, number>(),
    unmounts = new Map<string, number>()
): TopTabSurfaceFactories {
    return {
        renderFile: (tab) => <Lifecycle id={tab.id} mounts={mounts} unmounts={unmounts} />,
        renderPreview: (tab) => <div>preview:{tab.id}</div>,
        renderGitDiff: (tab) => <div>diff:{tab.id}</div>,
        renderAgentTurnDiff: (tab) => <div>turn-diff:{tab.id}</div>,
    };
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("TopTabContentDeck", () => {
    it("renders a cold File loading slot without creating runtime content during static render", () => {
        const factories = makeFactories();
        const renderFile = vi.spyOn(factories, "renderFile");
        const createRuntime = vi.fn((tab: TopTab) => makeRuntime(tab.title));
        const html = renderToString(
            <TopTabContentDeck
                topTabs={[FileA]}
                activeTopTabId={FileA.id}
                registry={new WorkspaceTopTabRuntimeRegistry()}
                createRuntime={createRuntime}
                factories={factories}
            />
        );

        expect(html).toContain("Loading a.ts");
        expect(renderFile).not.toHaveBeenCalled();
        expect(createRuntime).not.toHaveBeenCalled();
    });

    it("keeps an activated File surface mounted while Agent is active and reuses the same DOM node", async () => {
        const mounts = new Map<string, number>();
        const unmounts = new Map<string, number>();
        const factories = makeFactories(mounts, unmounts);
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const view = render(
            <TopTabContentDeck
                topTabs={[FileA]}
                activeTopTabId="file-a"
                registry={registry}
                createRuntime={(tab) => makeRuntime(tab.title)}
                factories={factories}
            />
        );

        const fileBody = await screen.findByTestId("file-body-file-a");
        const fileSurface = screen.getByTestId("file-top-tab-surface-file-a");

        view.rerender(
            <TopTabContentDeck
                topTabs={[FileA]}
                activeTopTabId={undefined}
                registry={registry}
                createRuntime={(tab) => makeRuntime(tab.title)}
                factories={factories}
            />
        );

        expect(screen.getByTestId("file-body-file-a")).toBe(fileBody);
        expect(screen.getByTestId("file-top-tab-surface-file-a")).toBe(fileSurface);
        expect(fileSurface.getAttribute("aria-hidden")).toBe("true");
        expect(mounts.get("file-a")).toBe(1);
        expect(unmounts.get("file-a") ?? 0).toBe(0);

        view.rerender(
            <TopTabContentDeck
                topTabs={[FileA]}
                activeTopTabId="file-a"
                registry={registry}
                createRuntime={(tab) => makeRuntime(tab.title)}
                factories={factories}
            />
        );

        expect(screen.getByTestId("file-body-file-a")).toBe(fileBody);
        expect(screen.getByTestId("file-top-tab-surface-file-a").getAttribute("aria-hidden")).toBe("false");
        expect(mounts.get("file-a")).toBe(1);
        expect(unmounts.get("file-a") ?? 0).toBe(0);
    });

    it("gives File A and File B independent stable slots", async () => {
        const mounts = new Map<string, number>();
        const unmounts = new Map<string, number>();
        const factories = makeFactories(mounts, unmounts);
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const createRuntime = (tab: TopTab) => makeRuntime(tab.title);
        const view = render(
            <TopTabContentDeck
                topTabs={[FileA, FileB]}
                activeTopTabId="file-a"
                registry={registry}
                createRuntime={createRuntime}
                factories={factories}
            />
        );
        const fileABody = await screen.findByTestId("file-body-file-a");

        view.rerender(
            <TopTabContentDeck
                topTabs={[FileA, FileB]}
                activeTopTabId="file-b"
                registry={registry}
                createRuntime={createRuntime}
                factories={factories}
            />
        );
        const fileBBody = await screen.findByTestId("file-body-file-b");

        expect(screen.getByTestId("file-top-tab-surface-file-a").getAttribute("aria-hidden")).toBe("true");
        expect(screen.getByTestId("file-top-tab-surface-file-b").getAttribute("aria-hidden")).toBe("false");

        view.rerender(
            <TopTabContentDeck
                topTabs={[FileA, FileB]}
                activeTopTabId="file-a"
                registry={registry}
                createRuntime={createRuntime}
                factories={factories}
            />
        );

        expect(screen.getByTestId("file-body-file-a")).toBe(fileABody);
        expect(screen.getByTestId("file-body-file-b")).toBe(fileBBody);
        expect(screen.getByTestId("file-top-tab-surface-file-a").getAttribute("aria-hidden")).toBe("false");
        expect(screen.getByTestId("file-top-tab-surface-file-b").getAttribute("aria-hidden")).toBe("true");
        expect(mounts.get("file-a")).toBe(1);
        expect(mounts.get("file-b")).toBe(1);
        expect(unmounts.get("file-a") ?? 0).toBe(0);
        expect(unmounts.get("file-b") ?? 0).toBe(0);
    });

    it("unmounts a retained File surface exactly once when its descriptor is removed", async () => {
        const mounts = new Map<string, number>();
        const unmounts = new Map<string, number>();
        const factories = makeFactories(mounts, unmounts);
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const createRuntime = (tab: TopTab) => makeRuntime(tab.title);
        const view = render(
            <TopTabContentDeck
                topTabs={[FileA, FileB]}
                activeTopTabId="file-a"
                registry={registry}
                createRuntime={createRuntime}
                factories={factories}
            />
        );
        await screen.findByTestId("file-body-file-a");

        view.rerender(
            <TopTabContentDeck
                topTabs={[FileB]}
                activeTopTabId={undefined}
                registry={registry}
                createRuntime={createRuntime}
                factories={factories}
            />
        );

        expect(screen.queryByTestId("file-body-file-a")).toBeNull();
        expect(unmounts.get("file-a")).toBe(1);
    });

    it.each([
        ["Preview", PreviewTab, "renderPreview"],
        ["Git Diff", DiffTab, "renderGitDiff"],
        ["Agent Turn Diff", AgentTurnDiffTab, "renderAgentTurnDiff"],
    ] as const)(
        "renders a cold active %s loading surface during static render without calling its factory",
        (_, tab, key) => {
            const factories = makeFactories();
            const factory = vi.spyOn(factories, key);
            const createRuntime = vi.fn((nextTab: TopTab) => makeRuntime(nextTab.title));

            const html = renderToString(
                <TopTabContentDeck
                    topTabs={[tab]}
                    activeTopTabId={tab.id}
                    registry={new WorkspaceTopTabRuntimeRegistry()}
                    createRuntime={createRuntime}
                    factories={factories}
                />
            );

            expect(html).toContain(`Loading ${tab.title}`);
            expect(factory).not.toHaveBeenCalled();
            expect(createRuntime).not.toHaveBeenCalled();
        }
    );

    it.each([PreviewTab, DiffTab, AgentTurnDiffTab])(
        "mounts %kind after the client loading commit and unmounts when inactive",
        async (tab) => {
            const factories = makeFactories();
            const createRuntime = vi.fn((nextTab: TopTab) => makeRuntime(nextTab.title));
            const registry = new WorkspaceTopTabRuntimeRegistry();
            const view = render(
                <TopTabContentDeck
                    topTabs={[tab]}
                    activeTopTabId={tab.id}
                    registry={registry}
                    createRuntime={createRuntime}
                    factories={factories}
                />
            );

            const prefix = tab.kind === "preview" ? "preview" : tab.kind === "git-diff" ? "diff" : "turn-diff";
            await screen.findByText(`${prefix}:${tab.id}`);
            expect(createRuntime).toHaveBeenCalledTimes(1);

            const runtime = registry.get(tab.id);
            view.rerender(
                <TopTabContentDeck
                    topTabs={[tab]}
                    activeTopTabId={undefined}
                    registry={registry}
                    createRuntime={createRuntime}
                    factories={factories}
                />
            );

            expect(screen.queryByText(`${prefix}:${tab.id}`)).toBeNull();
            await waitFor(() => expect(runtime?.dispose).toHaveBeenCalledTimes(1));
        }
    );
});
