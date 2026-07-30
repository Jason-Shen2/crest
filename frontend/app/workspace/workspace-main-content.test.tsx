// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TopTabRuntime } from "./top-tab-runtime-registry";
import { WorkspaceMainContent, type WorkspaceMainContentProps } from "./workspace-main-content";

const apiMocks = vi.hoisted(() => ({
    setWorkspaceSurface: vi.fn(),
}));

const agentContentMock = vi.hoisted(() => ({
    props: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/app/store/global", () => ({
    getApi: () => apiMocks,
}));

vi.mock("@/app/agent/agent-content", () => ({
    AgentContent: (props: Record<string, unknown>) => {
        agentContentMock.props = props;
        return <div>Agent content</div>;
    },
}));

vi.mock("./file-top-tab", () => ({
    FileTopTab: () => <div>File editor</div>,
}));

vi.mock("./git-diff-top-tab", () => ({
    GitDiffTopTab: ({ tab }: any) => <div>Git diff production:{tab.path}</div>,
}));

const TopTabs = [
    { id: "file-a", kind: "file" as const, path: "/repo/a.ts", title: "a.ts" },
    { id: "file-b", kind: "file" as const, path: "/repo/b.ts", title: "b.ts" },
];

function makeProps(overrides: Partial<WorkspaceMainContentProps> = {}): WorkspaceMainContentProps {
    return {
        workspaceId: "workspace-1",
        generation: 1,
        activeContent: { kind: "agent" },
        topTabs: TopTabs,
        onCloseTopTab: vi.fn().mockResolvedValue(true),
        onCloseTerminal: vi.fn(),
        ...overrides,
    };
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    agentContentMock.props = undefined;
});

describe("WorkspaceMainContent identity", () => {
    it("leaves Top Tab chrome to the shared TopBar instead of reserving a second row", () => {
        render(<WorkspaceMainContent {...makeProps()} />);

        expect(screen.queryByRole("tablist", { name: "Open files" })).toBeNull();
    });

    it("injects the production Git diff factory only for the active Git diff tab", () => {
        const diffTab = {
            id: "diff-a",
            kind: "git-diff" as const,
            repoRoot: "/repo",
            path: "src/a.ts",
            mode: "-" as const,
            originalPath: "",
            title: "a.ts",
        };
        const view = render(
            <WorkspaceMainContent
                {...makeProps({
                    activeContent: { kind: "agent" },
                    topTabs: [...TopTabs, diffTab],
                })}
            />
        );

        expect(screen.queryByText("Git diff production:src/a.ts")).toBeNull();
        view.rerender(
            <WorkspaceMainContent
                {...makeProps({
                    activeContent: { kind: "top-tab", topTabId: "diff-a" },
                    topTabs: [...TopTabs, diffTab],
                })}
            />
        );
        expect(screen.getByText("Git diff production:src/a.ts")).toBeTruthy();
    });

    it("uses the injected editor registry for the File factory and strip runtime", () => {
        const snapshot = { dirty: false, title: "a.ts", status: "ready" };
        const editorRegistry = {
            open: vi.fn(() => ({ getSnapshot: () => snapshot, subscribe: () => () => {} })),
        } as any;
        render(
            <WorkspaceMainContent
                {...makeProps({
                    activeContent: { kind: "top-tab", topTabId: "file-a" },
                    editorRegistry,
                })}
            />
        );

        expect(editorRegistry.open).toHaveBeenCalledWith("file-a", "/repo/a.ts");
    });

    it("disposes the workspace runtime registry on workspace replacement", async () => {
        const firstSnapshot = { dirty: false, title: "a.ts", status: "ready" as const };
        const secondSnapshot = { dirty: false, title: "a.ts", status: "ready" as const };
        const firstRuntime: TopTabRuntime = {
            getSnapshot: () => firstSnapshot,
            subscribe: () => () => {},
            dispose: vi.fn(),
        };
        const secondRuntime: TopTabRuntime = {
            getSnapshot: () => secondSnapshot,
            subscribe: () => () => {},
            dispose: vi.fn(),
        };
        const view = render(
            <WorkspaceMainContent
                {...makeProps({
                    activeContent: { kind: "top-tab", topTabId: "file-a" },
                    topTabRuntimeFactory: () => firstRuntime,
                })}
            />
        );
        view.rerender(
            <WorkspaceMainContent
                {...makeProps({
                    workspaceId: "workspace-2",
                    activeContent: { kind: "top-tab", topTabId: "file-a" },
                    topTabRuntimeFactory: () => secondRuntime,
                })}
            />
        );

        await vi.waitFor(() => expect(firstRuntime.dispose).toHaveBeenCalledTimes(1));
        expect(secondRuntime.dispose).not.toHaveBeenCalled();
    });

    it("does not render the fixed Agent entry inside the main surface", () => {
        render(<WorkspaceMainContent {...makeProps()} />);

        expect(screen.queryByRole("button", { name: "Agent" })).toBeNull();
        expect(screen.queryByRole("tablist", { name: "Open files" })).toBeNull();
    });

    it("does not mount Agent content before the first Agent activation", () => {
        const view = render(
            <WorkspaceMainContent
                {...makeProps({ activeContent: { kind: "terminal", terminalTabId: "terminal-a" } })}
            />
        );

        expect(screen.queryByTestId("agent-surface")).toBeNull();

        view.rerender(<WorkspaceMainContent {...makeProps({ activeContent: { kind: "agent" } })} />);

        expect(screen.getByTestId("agent-surface").getAttribute("aria-hidden")).toBe("false");
    });

    it("opens Agent Read files through the authoritative top-tab controller", () => {
        const openFile = vi.fn(() => "file-tab-1");
        render(
            <WorkspaceMainContent
                {...makeProps({
                    agentModel: {} as any,
                    agentClient: {} as any,
                    agentExecutionContext: {
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    },
                    topTabController: { openFile } as any,
                })}
            />
        );

        (agentContentMock.props?.onOpenFile as ((path: string) => void) | undefined)?.("/repo/src/app.ts");

        expect(openFile).toHaveBeenCalledWith("/repo/src/app.ts");
    });

    it("keeps Terminal navigation out of the top tabs and renders no Phase 2 placeholder copy", () => {
        render(
            <WorkspaceMainContent
                {...makeProps({ activeContent: { kind: "terminal", terminalTabId: "terminal-a" } })}
            />
        );

        expect(screen.queryByRole("button", { name: "Terminal mock" })).toBeNull();
        expect(screen.queryByText(/Terminal renderer:/)).toBeNull();
        expect(screen.queryByText(/workspace renderer migration/)).toBeNull();
    });

    it("remounts terminal surfaces and keeps File slots independent when their identity changes", () => {
        const view = render(
            <WorkspaceMainContent
                {...makeProps({ activeContent: { kind: "terminal", terminalTabId: "terminal-a" } })}
            />
        );
        const terminalA = screen.getByTestId("terminal-surface");

        view.rerender(
            <WorkspaceMainContent
                {...makeProps({
                    activeContent: { kind: "terminal", terminalTabId: "terminal-b" },
                })}
            />
        );
        const terminalB = screen.getByTestId("terminal-surface");
        expect(terminalB).not.toBe(terminalA);

        view.rerender(
            <WorkspaceMainContent {...makeProps({ activeContent: { kind: "top-tab", topTabId: "file-a" } })} />
        );
        const fileA = screen.getByTestId("file-top-tab-surface-file-a");
        view.rerender(
            <WorkspaceMainContent {...makeProps({ activeContent: { kind: "top-tab", topTabId: "file-b" } })} />
        );
        const fileB = screen.getByTestId("file-top-tab-surface-file-b");
        expect(fileB).not.toBe(fileA);
        expect(fileA.getAttribute("aria-hidden")).toBe("true");
        expect(fileB.getAttribute("aria-hidden")).toBe("false");
    });

    it("keeps the agent surface mounted while other identities change", () => {
        const view = render(<WorkspaceMainContent {...makeProps()} />);
        const agent = screen.getByTestId("agent-surface");

        view.rerender(
            <WorkspaceMainContent
                {...makeProps({ activeContent: { kind: "terminal", terminalTabId: "terminal-b" } })}
            />
        );
        expect(screen.getAllByTestId("agent-surface")).toHaveLength(1);
        expect(screen.getByTestId("agent-surface")).toBe(agent);
        expect(agent.getAttribute("aria-hidden")).toBe("true");
        expect(agent.hasAttribute("inert")).toBe(true);
        expect(agent.hidden).toBe(true);
        expect(agent.style.display).toBe("none");
        expect(screen.getByTestId("agent-surface").className).toContain("absolute");
        expect(screen.getByTestId("terminal-surface").className).toContain("absolute");
        view.rerender(
            <WorkspaceMainContent {...makeProps({ activeContent: { kind: "top-tab", topTabId: "file-b" } })} />
        );

        expect(screen.getAllByTestId("agent-surface")).toHaveLength(1);
        expect(screen.getByTestId("agent-surface")).toBe(agent);
        expect(agent.getAttribute("aria-hidden")).toBe("true");
        expect(agent.hasAttribute("inert")).toBe(true);
        expect(agent.hidden).toBe(true);
        expect(agent.style.display).toBe("none");
        expect(screen.getByTestId("file-top-tab-surface-file-b").className).toContain("absolute");

        view.rerender(<WorkspaceMainContent {...makeProps({ activeContent: { kind: "agent" } })} />);

        expect(screen.getAllByTestId("agent-surface")).toHaveLength(1);
        expect(screen.getByTestId("agent-surface")).toBe(agent);
        expect(agent.getAttribute("aria-hidden")).toBe("false");
        expect(agent.hasAttribute("inert")).toBe(false);
        expect(agent.hidden).toBe(false);
        expect(agent.style.display).toBe("block");
    });

    it("shows matching Terminal failure and retries with a newer surface revision", () => {
        const onCloseTerminal = vi.fn();
        render(
            <WorkspaceMainContent
                {...makeProps({
                    activeContent: { kind: "terminal", terminalTabId: "terminal-a" },
                    terminalSurfaceStatus: {
                        state: "error",
                        workspaceid: "workspace-1",
                        generation: 1,
                        revision: 1,
                        terminaltabid: "terminal-a",
                        message: "cold init failed",
                    },
                    onCloseTerminal,
                })}
            />
        );

        expect(screen.getByText("cold init failed")).toBeTruthy();
        expect(screen.getByText("cold init failed").parentElement?.className).toContain("pointer-events-auto");
        const initialRevision = apiMocks.setWorkspaceSurface.mock.calls.at(-1)[0].revision;
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(apiMocks.setWorkspaceSurface.mock.calls.at(-1)[0]).toMatchObject({
            kind: "terminal",
            terminalTabId: "terminal-a",
            revision: initialRevision + 1,
        });
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onCloseTerminal).toHaveBeenCalledWith("terminal-a");
    });

    it("shows only a matching loading status and leaves ready Terminal content to the native surface", () => {
        const view = render(
            <WorkspaceMainContent
                {...makeProps({
                    activeContent: { kind: "terminal", terminalTabId: "terminal-a" },
                    terminalSurfaceStatus: {
                        state: "loading",
                        workspaceid: "workspace-1",
                        generation: 1,
                        revision: 1,
                        terminaltabid: "terminal-a",
                    },
                })}
            />
        );

        expect(screen.getByRole("status").textContent).toContain("Loading terminal");
        expect(screen.getByTestId("terminal-surface").className).toContain("pointer-events-none");
        view.rerender(
            <WorkspaceMainContent
                {...makeProps({
                    activeContent: { kind: "terminal", terminalTabId: "terminal-a" },
                    terminalSurfaceStatus: {
                        state: "loading",
                        workspaceid: "another-workspace",
                        generation: 1,
                        revision: 2,
                        terminaltabid: "terminal-a",
                    },
                })}
            />
        );
        expect(screen.queryByRole("status")).toBeNull();
        view.rerender(
            <WorkspaceMainContent
                {...makeProps({
                    activeContent: { kind: "terminal", terminalTabId: "terminal-a" },
                    terminalSurfaceStatus: {
                        state: "ready",
                        workspaceid: "workspace-1",
                        generation: 1,
                        revision: 3,
                        terminaltabid: "terminal-a",
                    },
                })}
            />
        );
        expect(screen.getByTestId("terminal-surface").textContent).toBe("");
    });

    it("clears the old Terminal renderer desire when its Workspace surface unmounts", () => {
        const view = render(
            <WorkspaceMainContent
                {...makeProps({ activeContent: { kind: "terminal", terminalTabId: "terminal-a" } })}
            />
        );
        const activeRevision = apiMocks.setWorkspaceSurface.mock.calls.at(-1)[0].revision;

        view.unmount();

        expect(apiMocks.setWorkspaceSurface.mock.calls.at(-1)[0]).toMatchObject({
            kind: "agent",
            workspaceId: "workspace-1",
            generation: 1,
            revision: activeRevision + 1,
        });
    });
});
