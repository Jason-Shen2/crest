// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { ToastModel } from "@/app/notifications/toast-model";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { atom } from "jotai";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceTopTabController } from "./top-tab-controller-context";
import { handleWorkspaceCloseRequest, WorkspaceApp, type WorkspaceAppInit } from "./workspace-app";
import { WorkspaceModel } from "./workspace-model";
import { WorkspaceTerminalSync } from "./workspace-terminal-sync";

const layout = vi.hoisted(() => ({
    model: null as any,
    terminalListProps: null as any,
    leftPanelProps: null as any,
    leftPanelRenderCount: 0,
    rightPanelProps: null as any,
    topTabController: null as any,
    openTopTabOnMount: false,
    openedTopTabId: null as string | null,
    openTopTabError: null as unknown,
}));

const agentContent = vi.hoisted(() => ({
    props: null as any,
}));

const environment = vi.hoisted(() => ({
    make: vi.fn(),
    observed: [] as unknown[],
}));

const terminalRpc = vi.hoisted(() => ({
    create: vi.fn(),
    close: vi.fn(),
    rename: vi.fn(),
    reorder: vi.fn(),
}));

const monacoModels = vi.hoisted(() => new Map<string, any>());
const fileEditor = vi.hoisted(() => ({ props: null as any }));

vi.mock("@/app/monaco/monaco-env", () => ({ loadMonaco: vi.fn() }));
vi.mock("monaco-editor", () => ({
    Uri: { parse: (uri: string) => ({ toString: () => uri }) },
    editor: {
        createModel: (value: string, language: string, uri: { toString: () => string }) => {
            const listeners = new Set<() => void>();
            const model = {
                value,
                language,
                getValue: () => model.value,
                setValue: (next: string) => {
                    model.value = next;
                    listeners.forEach((listener) => listener());
                },
                onDidChangeContent: (listener: () => void) => {
                    listeners.add(listener);
                    return { dispose: () => listeners.delete(listener) };
                },
                dispose: () => monacoModels.delete(uri.toString()),
            };
            monacoModels.set(uri.toString(), model);
            return model;
        },
        getModel: (uri: { toString: () => string }) => monacoModels.get(uri.toString()) ?? null,
        setModelLanguage: vi.fn(),
    },
}));

vi.mock("@/app/view/codeeditor/codeeditor", () => ({
    CodeEditor: (props: any) => {
        fileEditor.props = props;
        return <div data-testid="workspace-file-editor">Monaco file editor {props.fileName.split("/").at(-1)}</div>;
    },
}));

type MockLeftPanelState = {
    visible: boolean;
    mode: "files" | "sessions" | "terminals";
    width: number;
};

vi.mock("@/app/store/services", async () => {
    const actual = await vi.importActual<typeof import("@/app/store/services")>("@/app/store/services");
    return {
        ...actual,
        WorkspaceService: {
            SaveWorkspaceCheckpoint: vi.fn().mockResolvedValue(undefined),
        },
    };
});

vi.mock("@/app/store/wshclientapi", async () => {
    const actual = await vi.importActual<typeof import("@/app/store/wshclientapi")>("@/app/store/wshclientapi");
    return {
        ...actual,
        RpcApi: {
            ...actual.RpcApi,
            WorkspaceCreateTerminalCommand: terminalRpc.create,
            WorkspaceCloseTerminalCommand: terminalRpc.close,
            WorkspaceRenameTerminalCommand: terminalRpc.rename,
            WorkspaceReorderTerminalsCommand: terminalRpc.reorder,
            FileReadCommand: vi.fn().mockResolvedValue({ info: {}, data64: "" }),
            FileWriteCommand: vi.fn().mockResolvedValue(undefined),
            GetCmdBlocksCommand: vi.fn().mockResolvedValue([]),
            EventSubCommand: vi.fn(),
            EventUnsubCommand: vi.fn(),
        },
    };
});

const electronApi = {
    workspaceCommandCallback: null as ((command: WorkspaceCommand) => void) | null,
    terminalSurfaceStatusCallback: null as ((status: TerminalSurfaceStatus) => void) | null,
    workspaceCloseCallback: null as ((request: WorkspaceCloseRequest) => void) | null,
    workspaceCloseFinalizeCallback: null as ((finalize: WorkspaceCloseFinalize) => void) | null,
    reinjectKeyCallback: null as ((event: WaveKeyboardEvent) => void) | null,
    controlShiftCallback: null as ((state: boolean) => void) | null,
    registeredGlobalKeys: [] as string[],
    unsubscribe: vi.fn(),
    surfaceUnsubscribe: vi.fn(),
    createTab: vi.fn(),
    closeTab: vi.fn().mockResolvedValue(false),
    setWorkspaceSurface: vi.fn(),
    getHomeDir: vi.fn(() => "/home/tester"),
    respondWorkspaceClose: vi.fn(),
};

vi.mock("@/app/waveenv/waveenvimpl", async () => {
    const actual = await vi.importActual<typeof import("@/app/waveenv/waveenvimpl")>("@/app/waveenv/waveenvimpl");
    environment.make.mockImplementation(actual.makeWaveEnvImpl);
    return {
        ...actual,
        makeWaveEnvImpl: environment.make,
    };
});

vi.mock("./workspace-layout-model", async () => {
    const jotai = await vi.importActual<typeof import("jotai")>("jotai");
    layout.model = {
        leftPanelAtom: jotai.atom({ visible: false, mode: "files", width: 260 }),
        rightToolPanelAtom: jotai.atom({
            visible: false,
            width: 400,
            openedTools: [],
            toolState: {},
            focused: false,
            magnified: false,
        }),
        getLeftPanelStateForWorkspace: vi.fn((_workspaceId: string, state: unknown) => state),
        hydrateLeftPanelFromWorkspace: vi.fn(),
        hydrateRightToolPanelFromWorkspace: vi.fn(),
        getLeftPanelMinWidth: vi.fn(() => 180),
        getLeftPanelMaxWidth: vi.fn(() => 520),
        previewLeftPanelWidth: vi.fn(),
        setLeftPanelWidth: vi.fn(),
        showLeftPanel: vi.fn((mode: MockLeftPanelState["mode"]) => {
            const current = globalStore.get(layout.model.leftPanelAtom) as MockLeftPanelState;
            globalStore.set(layout.model.leftPanelAtom, { ...current, visible: true, mode });
        }),
    };
    return {
        WorkspaceLayoutModel: {
            getInstance: () => layout.model,
        },
    };
});

vi.mock("@/app/topbar/topbar", async () => {
    const { useWaveEnv } = await import("@/app/waveenv/waveenv");
    return {
        TopBar: ({ onActivateAgent, topTabStrip }: { onActivateAgent?: () => void; topTabStrip?: React.ReactNode }) => {
            const env = useWaveEnv();
            environment.observed.push(env);
            const togglePanel = (mode: "files" | "sessions" | "terminals") => {
                const current = globalStore.get(layout.model.leftPanelAtom) as MockLeftPanelState;
                globalStore.set(
                    layout.model.leftPanelAtom,
                    current.visible && current.mode === mode
                        ? { ...current, visible: false }
                        : { ...current, visible: true, mode }
                );
            };
            return (
                <header>
                    {env.electron ? "Workspace top bar" : "Missing workspace environment"}
                    <button type="button" onClick={() => togglePanel("files")}>
                        Toggle Files panel
                    </button>
                    <button type="button" onClick={() => togglePanel("sessions")}>
                        Toggle Agent panel
                    </button>
                    <button type="button" onClick={() => togglePanel("terminals")}>
                        Toggle Terminal panel
                    </button>
                    {onActivateAgent != null ? (
                        <button type="button" onClick={onActivateAgent}>
                            Agent
                        </button>
                    ) : null}
                    {topTabStrip}
                </header>
            );
        },
    };
});

vi.mock("@/app/statusbar/status-bar", () => ({
    StatusBar: () => <footer>Workspace status</footer>,
}));

vi.mock("@/app/modals/modalsrenderer", () => ({
    ModalsRenderer: () => <div>Workspace modals</div>,
}));

vi.mock("./workspace-left-panel", () => ({
    WorkspaceLeftPanel: (props: { mode: string; terminalList?: React.ReactNode }) => {
        layout.leftPanelProps = props;
        layout.leftPanelRenderCount++;
        return (
            <aside>
                {props.mode}
                {props.mode === "terminals" ? props.terminalList : null}
            </aside>
        );
    },
}));

vi.mock("./terminal-tab-list", () => ({
    TerminalTabList: (props: any) => {
        layout.terminalListProps = props;
        return <div data-testid="workspace-terminal-list">{props.terminalTabIds.join(",")}</div>;
    },
}));

vi.mock("@/app/agent/agent-content", () => ({
    AgentContent: (props: any) => {
        agentContent.props = props;
        return <div data-testid="mock-agent-content">{props.executionContext.workspaceDir}</div>;
    },
}));

vi.mock("./workspace-right-panel-host", () => ({
    WorkspaceRightPanelHost: (props: any) => {
        layout.rightPanelProps = props;
        layout.topTabController = useWorkspaceTopTabController();
        useEffect(() => {
            if (!layout.openTopTabOnMount) {
                return;
            }
            try {
                layout.openedTopTabId = layout.topTabController.openFile("/repo/effect-open.ts");
            } catch (error) {
                layout.openTopTabError = error;
            }
        }, []);
        return <aside>Right tools</aside>;
    },
}));

let workspaceVersion = 0;

function makeWorkspaceInit(): WorkspaceAppInit {
    workspaceVersion += 100;
    return {
        windowId: "window-1",
        generation: 1,
        workspace: {
            otype: "workspace",
            oid: "workspace-1",
            version: workspaceVersion,
            meta: {},
            tabids: ["terminal-1", "terminal-2"],
            activetabid: "terminal-1",
            terminaltabids: ["terminal-1"],
            activeterminaltabid: "terminal-1",
            navigationrevision: 7,
            agentstate: {},
            contentstate: {
                activecontent: { kind: "agent" },
                toptabs: [
                    {
                        id: "readme",
                        kind: "file",
                        path: "/repo/README.md",
                        title: "README.md",
                    },
                ],
                lastactivetoptabid: "readme",
            },
        },
    };
}

afterEach(async () => {
    cleanup();
    ToastModel.getInstance().clear();
    await WorkspaceModel.resetInstances();
});

beforeEach(() => {
    vi.mocked(WorkspaceService.SaveWorkspaceCheckpoint).mockReset().mockResolvedValue(undefined);
    layout.model.leftPanelAtom = atom({ visible: false, mode: "files", width: 260 });
    environment.make.mockClear();
    environment.observed = [];
    electronApi.workspaceCommandCallback = null;
    electronApi.terminalSurfaceStatusCallback = null;
    electronApi.workspaceCloseCallback = null;
    electronApi.workspaceCloseFinalizeCallback = null;
    electronApi.reinjectKeyCallback = null;
    electronApi.controlShiftCallback = null;
    electronApi.registeredGlobalKeys = [];
    electronApi.unsubscribe.mockClear();
    electronApi.surfaceUnsubscribe.mockClear();
    electronApi.createTab.mockClear();
    electronApi.closeTab.mockClear();
    electronApi.setWorkspaceSurface.mockClear();
    electronApi.getHomeDir.mockClear();
    electronApi.respondWorkspaceClose.mockClear();
    agentContent.props = null;
    terminalRpc.create.mockReset();
    terminalRpc.close.mockReset();
    terminalRpc.rename.mockReset();
    terminalRpc.reorder.mockReset();
    layout.terminalListProps = null;
    layout.leftPanelProps = null;
    layout.leftPanelRenderCount = 0;
    layout.rightPanelProps = null;
    layout.topTabController = null;
    layout.openTopTabOnMount = false;
    layout.openedTopTabId = null;
    layout.openTopTabError = null;
    terminalRpc.create.mockImplementation((_client, data: WorkspaceCreateTerminalData) =>
        Promise.resolve({
            workspaceid: "workspace-1",
            navigationrevision: data.expectedrevision + 1,
            terminaltabids: ["terminal-1", "terminal-new"],
            activeterminaltabid: "terminal-new",
            contentstate: {
                activecontent: { kind: "terminal", terminaltabid: "terminal-new" },
                toptabs: [],
                lastactivetoptabid: "",
            },
        })
    );
    terminalRpc.close.mockResolvedValue({
        workspaceid: "workspace-1",
        navigationrevision: 10,
        terminaltabids: ["terminal-1"],
        activeterminaltabid: "terminal-1",
        contentstate: {
            activecontent: { kind: "terminal", terminaltabid: "terminal-1" },
            toptabs: [],
            lastactivetoptabid: "",
        },
    });
    (window as any).api = {
        onWorkspaceCommand: (callback: (command: WorkspaceCommand) => void) => {
            electronApi.workspaceCommandCallback = callback;
            return electronApi.unsubscribe;
        },
        onReinjectKey: (callback: (event: WaveKeyboardEvent) => void) => {
            electronApi.reinjectKeyCallback = callback;
            return () => {
                if (electronApi.reinjectKeyCallback === callback) {
                    electronApi.reinjectKeyCallback = null;
                }
            };
        },
        onControlShiftStateUpdate: (callback: (state: boolean) => void) => {
            electronApi.controlShiftCallback = callback;
            return () => {
                if (electronApi.controlShiftCallback === callback) {
                    electronApi.controlShiftCallback = null;
                }
            };
        },
        registerGlobalWebviewKeys: (keys: string[]) => {
            electronApi.registeredGlobalKeys = keys;
        },
        setKeyboardChordMode: vi.fn(),
        onTerminalSurfaceStatus: (callback: (status: TerminalSurfaceStatus) => void) => {
            electronApi.terminalSurfaceStatusCallback = callback;
            return electronApi.surfaceUnsubscribe;
        },
        onWorkspaceCloseRequest: (callback: (request: WorkspaceCloseRequest) => void) => {
            electronApi.workspaceCloseCallback = callback;
            return () => {
                electronApi.workspaceCloseCallback = null;
            };
        },
        respondWorkspaceClose: electronApi.respondWorkspaceClose,
        onWorkspaceCloseFinalize: (callback: (finalize: WorkspaceCloseFinalize) => void) => {
            electronApi.workspaceCloseFinalizeCallback = callback;
            return () => {
                electronApi.workspaceCloseFinalizeCallback = null;
            };
        },
        createTab: electronApi.createTab,
        closeTab: electronApi.closeTab,
        setWorkspaceSurface: electronApi.setWorkspaceSurface,
        getHomeDir: electronApi.getHomeDir,
        getEnv: vi.fn(() => "test.invalid"),
        agent: {
            createSession: vi.fn(),
            listSessions: vi.fn(),
            listSessionDetails: vi.fn(),
            listCommands: vi.fn(),
            getSessionState: vi.fn(),
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi.fn(),
            runCommand: vi.fn(),
            commandRead: vi.fn(),
            commandWrite: vi.fn(),
            commandResize: vi.fn(),
            commandStop: vi.fn(),
            send: vi.fn(),
            abort: vi.fn(),
            subscribe: vi.fn(),
        },
    };
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({ data: null }),
        })
    );
});

describe("WorkspaceApp", () => {
    it("renders the workspace Top Tab strip inside the shared TopBar", () => {
        render(<WorkspaceApp init={makeWorkspaceInit()} />);

        expect(screen.getByRole("tablist", { name: "Open files" }).closest("header")).toBeTruthy();
    });

    it("renders deduplicated checkpoint failure toasts and reports a new incident after recovery", async () => {
        const saveCheckpoint = vi.mocked(WorkspaceService.SaveWorkspaceCheckpoint);
        saveCheckpoint.mockRejectedValue(new Error("checkpoint offline"));
        render(<WorkspaceApp init={makeWorkspaceInit()} />);
        const model = WorkspaceModel.instances.get("window-1");

        model.activateTopTab("readme");
        await act(async () => {
            await expect(model.flush()).rejects.toThrow("checkpoint offline");
        });
        expect(screen.getByText("checkpoint offline")).toBeTruthy();
        await act(async () => {
            await expect(model.flush()).rejects.toThrow("checkpoint offline");
        });
        expect(globalStore.get(ToastModel.getInstance().toastsAtom)).toHaveLength(1);

        saveCheckpoint.mockResolvedValue(undefined);
        await act(async () => model.flush());
        model.activateAgent();
        saveCheckpoint.mockRejectedValue(new Error("checkpoint offline again"));
        await act(async () => {
            await expect(model.flush()).rejects.toThrow("checkpoint offline again");
        });
        expect(screen.getByText("checkpoint offline again")).toBeTruthy();
        expect(globalStore.get(ToastModel.getInstance().toastsAtom)).toHaveLength(2);
    });

    it("owns Workspace shortcuts for a zero-Terminal Agent workspace and replaces their router lifecycle", async () => {
        const firstInit = makeWorkspaceInit();
        firstInit.workspace.terminaltabids = [];
        firstInit.workspace.activeterminaltabid = "";
        firstInit.workspace.contentstate.activecontent = { kind: "agent" };
        const view = render(
            <WorkspaceApp key={`${firstInit.workspace.oid}:${firstInit.generation}`} init={firstInit} />
        );
        const firstReinject = electronApi.reinjectKeyCallback;

        expect(electronApi.registeredGlobalKeys).toContain("Cmd:t");
        expect(firstReinject).toBeTypeOf("function");

        const secondInit = makeWorkspaceInit();
        secondInit.generation = 2;
        secondInit.workspace.terminaltabids = [];
        secondInit.workspace.activeterminaltabid = "";
        secondInit.workspace.contentstate.activecontent = { kind: "agent" };
        await act(() =>
            WorkspaceModel.replaceInstance({
                windowId: secondInit.windowId,
                workspaceId: secondInit.workspace.oid,
                initialContentState: secondInit.workspace.contentstate,
                initialTerminalTabIds: secondInit.workspace.terminaltabids,
                initialActiveTerminalTabId: secondInit.workspace.activeterminaltabid,
                initialNavigationRevision: secondInit.workspace.navigationrevision,
                surfaceGeneration: secondInit.generation,
            })
        );
        view.rerender(<WorkspaceApp key={`${secondInit.workspace.oid}:${secondInit.generation}`} init={secondInit} />);

        expect(electronApi.reinjectKeyCallback).not.toBe(firstReinject);
        const shortcutEvent = new KeyboardEvent("keydown", {
            key: "t",
            code: "KeyT",
            metaKey: true,
            cancelable: true,
        });
        act(() => document.dispatchEvent(shortcutEvent));
        expect(shortcutEvent.defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(terminalRpc.create).toHaveBeenCalledOnce());
        expect(terminalRpc.create.mock.calls[0][1]).toMatchObject({
            workspaceid: secondInit.workspace.oid,
            expectedrevision: secondInit.workspace.navigationrevision,
        });

        view.unmount();
        expect(electronApi.reinjectKeyCallback).toBeNull();
        expect(electronApi.controlShiftCallback).toBeNull();
        expect(electronApi.registeredGlobalKeys).toEqual([]);
    });

    it("opens the production File surface, preserves its dirty model across switches, and disposes it", async () => {
        monacoModels.clear();
        const view = render(<WorkspaceApp init={makeWorkspaceInit()} />);
        let topTabId = "";
        act(() => {
            topTabId = layout.topTabController.openFile("/repo/integration.ts");
        });
        const editorNode = await screen.findByTestId("workspace-file-editor");
        const model = fileEditor.props.model;

        act(() => model.setValue("const edited = true;"));
        expect(screen.getByTestId(`top-tab-dirty-${topTabId}`)).toBeTruthy();
        expect(screen.getByRole("tab", { name: "integration.ts, unsaved changes" })).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Agent" }));
        expect(screen.getByTestId("workspace-file-editor")).toBe(editorNode);
        expect(screen.getByTestId(`file-top-tab-surface-${topTabId}`).getAttribute("aria-hidden")).toBe("true");
        fireEvent.click(screen.getByRole("tab", { name: "integration.ts, unsaved changes" }));
        expect(screen.getByTestId("workspace-file-editor")).toBe(editorNode);
        expect(screen.getByTestId(`file-top-tab-surface-${topTabId}`).getAttribute("aria-hidden")).toBe("false");
        expect(fileEditor.props.model).toBe(model);
        expect(fileEditor.props.text).toBe("const edited = true;");

        const workspaceModel = WorkspaceModel.getInstance({
            windowId: "window-1",
            workspaceId: "workspace-1",
        });
        await act(() => workspaceModel.prepareForReplacement());
        await vi.waitFor(() => expect(monacoModels.size).toBe(0));
        view.unmount();
    });

    it("disposes the final workspace file model on ordinary unmount", async () => {
        monacoModels.clear();
        const view = render(<WorkspaceApp init={makeWorkspaceInit()} />);
        fireEvent.click(screen.getByRole("tab", { name: "README.md" }));
        expect(monacoModels.size).toBe(1);

        view.unmount();
        await vi.waitFor(() => expect(monacoModels.size).toBe(0));
    });

    it("registers editor registry disposal for pre-replacement teardown", async () => {
        const init = makeWorkspaceInit();
        render(<WorkspaceApp init={init} />);
        const model = WorkspaceModel.getInstance({ windowId: init.windowId, workspaceId: init.workspace.oid });

        expect(model.preReplacementTeardowns.size).toBeGreaterThanOrEqual(4);
    });

    it("injects the authoritative Terminal list into the shared-width terminals panel", () => {
        layout.model.leftPanelAtom = atom({
            visible: true,
            mode: "terminals",
            width: 312,
        });

        render(<WorkspaceApp init={makeWorkspaceInit()} />);

        expect(screen.getByTestId("workspace-terminal-list").textContent).toBe("terminal-1");
        expect(layout.terminalListProps.activeTerminalTabId).toBe("terminal-1");
        expect(
            screen.getByTestId("workspace-terminal-list").parentElement?.parentElement?.getAttribute("style")
        ).toContain("width: 312px");
        expect(screen.getByRole("separator").getAttribute("aria-orientation")).toBe("vertical");
    });

    it("shares live remote Terminal membership between the list and command router", async () => {
        layout.model.leftPanelAtom = atom({
            visible: true,
            mode: "terminals",
            width: 312,
        });
        const init = makeWorkspaceInit();
        render(<WorkspaceApp init={init} />);

        const navigation = layout.terminalListProps.navigation;
        act(() =>
            WOS.primeWaveObject({
                ...init.workspace,
                version: init.workspace.version + 1,
                navigationrevision: init.workspace.navigationrevision + 1,
                terminaltabids: ["terminal-remote", "terminal-1"],
                activeterminaltabid: "terminal-remote",
                contentstate: {
                    ...init.workspace.contentstate,
                    activecontent: { kind: "terminal", terminaltabid: "terminal-remote" },
                },
            })
        );

        await vi.waitFor(() =>
            expect(layout.terminalListProps.terminalTabIds).toEqual(["terminal-remote", "terminal-1"])
        );
        expect(layout.terminalListProps.navigation).toBe(navigation);
        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-remote",
            })
        );
        expect(screen.getByTestId("terminal-surface")).toBeTruthy();
        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-stale",
            })
        );
        const model = WorkspaceModel.getInstance({ windowId: "window-1", workspaceId: "workspace-1" });
        expect(globalStore.get(model.activeTerminalTabIdAtom)).toBe("terminal-remote");

        act(() =>
            WOS.primeWaveObject({
                ...init.workspace,
                version: init.workspace.version + 2,
                navigationrevision: init.workspace.navigationrevision + 2,
                terminaltabids: ["terminal-1"],
                activeterminaltabid: "terminal-1",
                contentstate: {
                    ...init.workspace.contentstate,
                    activecontent: { kind: "agent" },
                },
            })
        );
        await vi.waitFor(() => expect(layout.terminalListProps.terminalTabIds).toEqual(["terminal-1"]));
        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-remote",
            })
        );
        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({ kind: "agent" });
    });

    it("keeps a zero-Terminal workspace usable without creating a Terminal route", () => {
        const init = makeWorkspaceInit();
        init.workspace.terminaltabids = [];
        init.workspace.activeterminaltabid = "";
        init.workspace.contentstate.activecontent = { kind: "agent" };
        init.workspace.meta["workspace:dir"] = "/repo";
        layout.model.leftPanelAtom = atom({
            visible: true,
            mode: "terminals",
            width: 312,
        });

        render(<WorkspaceApp init={init} />);

        expect(screen.getByTestId("agent-surface").hidden).toBe(false);
        expect(agentContent.props.executionContext.workspaceDir).toBe("/repo");
        expect(screen.getByTestId("mock-agent-content").textContent).toBe("/repo");
        expect(screen.queryByTestId("terminal-surface")).toBeNull();
        expect(layout.terminalListProps.terminalTabIds).toEqual([]);
        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-1",
            })
        );
        expect(screen.queryByTestId("terminal-surface")).toBeNull();
    });

    it("keeps panel mode independent from active content and uses one mutually exclusive shared-width panel", () => {
        render(<WorkspaceApp init={makeWorkspaceInit()} />);

        fireEvent.click(screen.getByRole("button", { name: "Toggle Terminal panel" }));
        expect(screen.getByText("terminals")).toBeTruthy();
        expect(screen.getByTestId("workspace-terminal-list")).toBeTruthy();
        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-1",
            })
        );
        fireEvent.click(screen.getByRole("button", { name: "Agent" }));
        expect(screen.getByText("sessions")).toBeTruthy();
        expect(screen.queryByTestId("terminal-surface")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Toggle Files panel" }));
        expect(screen.getByText("files")).toBeTruthy();
        expect(screen.queryByTestId("workspace-terminal-list")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Toggle Agent panel" }));
        expect(screen.getByText("sessions")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Toggle Agent panel" }));
        expect(screen.queryByText("sessions")).toBeNull();
    });

    it("passes Workspace Agent ownership into the sessions panel and right panel", () => {
        layout.model.leftPanelAtom = atom({
            visible: true,
            mode: "sessions",
            width: 312,
        });

        render(<WorkspaceApp init={makeWorkspaceInit()} />);

        expect(layout.leftPanelProps.agentRuntimeClient).toBe(agentContent.props.client);
        expect(layout.leftPanelProps.agentModel).toBe(agentContent.props.model);
        expect(layout.leftPanelProps.workspaceModel).toBe(
            WorkspaceModel.getInstance({ windowId: "window-1", workspaceId: "workspace-1" })
        );
        expect(layout.leftPanelProps.layoutModel).toBe(layout.model);
        expect(layout.rightPanelProps.agentModel).toBe(agentContent.props.model);
    });

    it("tears down old Terminal sync and desire before using the switched Workspace inventory", async () => {
        layout.model.leftPanelAtom = atom({
            visible: true,
            mode: "terminals",
            width: 312,
        });
        const disposeSpy = vi.spyOn(WorkspaceTerminalSync.prototype, "dispose");
        const firstInit = makeWorkspaceInit();
        const view = render(<WorkspaceApp key="workspace-1" init={firstInit} />);
        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-1",
            })
        );
        expect(electronApi.setWorkspaceSurface.mock.calls.at(-1)[0]).toMatchObject({
            kind: "terminal",
            workspaceId: "workspace-1",
            generation: 1,
        });
        const disposeCountBeforeSwitch = disposeSpy.mock.calls.length;
        const secondInit = makeWorkspaceInit();
        secondInit.generation = 2;
        secondInit.workspace.oid = "workspace-2";
        secondInit.workspace.terminaltabids = ["terminal-2"];
        secondInit.workspace.activeterminaltabid = "terminal-2";
        secondInit.workspace.contentstate.activecontent = { kind: "agent" };
        await act(() =>
            WorkspaceModel.replaceInstance({
                windowId: "window-1",
                workspaceId: "workspace-2",
                initialContentState: secondInit.workspace.contentstate,
                initialTerminalTabIds: secondInit.workspace.terminaltabids,
                initialActiveTerminalTabId: secondInit.workspace.activeterminaltabid,
                initialNavigationRevision: secondInit.workspace.navigationrevision,
                surfaceGeneration: secondInit.generation,
            })
        );
        view.rerender(<WorkspaceApp key="workspace-2" init={secondInit} />);

        expect(disposeSpy.mock.calls.length).toBeGreaterThan(disposeCountBeforeSwitch);
        expect(layout.terminalListProps.terminalTabIds).toEqual(["terminal-2"]);
        expect(electronApi.setWorkspaceSurface.mock.calls).toEqual(
            expect.arrayContaining([
                [
                    expect.objectContaining({
                        kind: "agent",
                        workspaceId: "workspace-1",
                        generation: 1,
                    }),
                ],
                [
                    expect.objectContaining({
                        kind: "agent",
                        workspaceId: "workspace-2",
                        generation: 2,
                    }),
                ],
            ])
        );

        act(() =>
            WOS.primeWaveObject({
                ...firstInit.workspace,
                version: firstInit.workspace.version + 10,
                navigationrevision: firstInit.workspace.navigationrevision + 10,
                terminaltabids: ["stale-old-workspace-terminal"],
            })
        );
        expect(layout.terminalListProps.terminalTabIds).toEqual(["terminal-2"]);
        disposeSpy.mockRestore();
    });

    it("provides the production Wave environment before committing its first render", () => {
        const onFirstRender = vi.fn();

        render(<WorkspaceApp init={makeWorkspaceInit()} onFirstRender={onFirstRender} />);

        expect(screen.getByText("Workspace top bar")).toBeTruthy();
        expect(onFirstRender).toHaveBeenCalledOnce();
    });

    it("creates one stable Wave environment across rerenders", () => {
        const init = makeWorkspaceInit();
        const view = render(<WorkspaceApp init={init} />);

        view.rerender(<WorkspaceApp init={init} />);

        expect(environment.make).toHaveBeenCalledOnce();
        expect(environment.observed.length).toBeGreaterThan(1);
        expect(environment.observed.every((value) => value === environment.observed[0])).toBe(true);
    });

    it("keeps one workspace root while content changes and keeps the agent surface mounted", () => {
        render(<WorkspaceApp init={makeWorkspaceInit()} />);
        const root = screen.getByTestId("workspace-renderer-root");
        const agent = screen.getByTestId("agent-surface");

        expect(agent.getAttribute("aria-hidden")).toBe("false");
        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-1",
            })
        );
        expect(screen.getByTestId("terminal-surface").hidden).toBe(false);
        expect(agent.getAttribute("aria-hidden")).toBe("true");
        expect(agent.hidden).toBe(true);
        expect(agent.style.display).toBe("none");

        fireEvent.click(screen.getByRole("button", { name: "Agent" }));
        expect(agent.getAttribute("aria-hidden")).toBe("false");

        fireEvent.click(screen.getByRole("tab", { name: "README.md" }));
        expect(screen.getByTestId("file-top-tab-surface-readme").textContent).toContain("README.md");
        expect(screen.getByTestId("workspace-renderer-root")).toBe(root);
    });

    it("keeps the left panel out of Agent to File navigation commits", () => {
        globalStore.set(layout.model.leftPanelAtom, { visible: true, mode: "files", width: 260 });
        render(<WorkspaceApp init={makeWorkspaceInit()} />);
        const renderCountBeforeNavigation = layout.leftPanelRenderCount;

        act(() => layout.topTabController.openFile("/repo/new-file.ts"));

        expect(screen.getByTestId("agent-surface").getAttribute("aria-hidden")).toBe("true");
        expect(layout.leftPanelRenderCount).toBe(renderCountBeforeNavigation);
    });

    it("keeps one Workspace renderer across Agent, Terminal, File, Preview, Diff, and Agent", () => {
        const init = makeWorkspaceInit();
        init.workspace.contentstate.toptabs.push(
            {
                id: "preview",
                kind: "preview",
                path: "/repo/preview.md",
                title: "preview.md",
            },
            {
                id: "diff",
                kind: "git-diff",
                reporoot: "/repo",
                path: "src/app.ts",
                mode: "+",
                originalpath: "",
                title: "app.ts",
            }
        );
        render(<WorkspaceApp init={init} />);
        const root = screen.getByTestId("workspace-renderer-root");
        const agent = screen.getByTestId("agent-surface");

        act(() => electronApi.workspaceCommandCallback?.({ type: "activate-terminal", terminalTabId: "terminal-1" }));
        fireEvent.click(screen.getByRole("tab", { name: "README.md" }));
        fireEvent.click(screen.getByRole("tab", { name: "preview.md" }));
        fireEvent.click(screen.getByRole("tab", { name: "app.ts" }));
        fireEvent.click(screen.getByRole("button", { name: "Agent" }));

        expect(screen.getByTestId("workspace-renderer-root")).toBe(root);
        expect(screen.getByTestId("agent-surface")).toBe(agent);
        expect(agent.getAttribute("aria-hidden")).toBe("false");
        expect(electronApi.createTab).not.toHaveBeenCalled();
    });

    it("wires Top Tab close and pointer reorder to the scoped workspace model", async () => {
        const init = makeWorkspaceInit();
        init.workspace.contentstate.toptabs.push({
            id: "notes",
            kind: "preview",
            path: "/repo/notes.md",
            title: "notes.md",
        });
        render(<WorkspaceApp init={init} />);
        const model = WorkspaceModel.getInstance({ windowId: init.windowId, workspaceId: init.workspace.oid });

        fireEvent.pointerDown(screen.getByRole("tab", { name: "README.md" }));
        fireEvent.pointerUp(screen.getByRole("tab", { name: "notes.md" }));
        expect(globalStore.get(model.contentStateAtom).topTabs.map((tab) => tab.id)).toEqual(["notes", "readme"]);

        fireEvent.click(screen.getByRole("button", { name: "Close README.md" }));
        await vi.waitFor(() =>
            expect(globalStore.get(model.contentStateAtom).topTabs.map((tab) => tab.id)).toEqual(["notes"])
        );
        expect(screen.queryByRole("tab", { name: "README.md" })).toBeNull();
    });

    it("reuses the same model and reports the first committed render once", () => {
        const onFirstRender = vi.fn();
        const init = makeWorkspaceInit();
        const view = render(<WorkspaceApp init={init} onFirstRender={onFirstRender} />);
        const firstModel = WorkspaceModel.getInstance({
            windowId: init.windowId,
            workspaceId: init.workspace.oid,
        });

        view.rerender(<WorkspaceApp init={init} onFirstRender={onFirstRender} />);

        expect(
            WorkspaceModel.getInstance({
                windowId: init.windowId,
                workspaceId: init.workspace.oid,
            })
        ).toBe(firstModel);
        expect(onFirstRender).toHaveBeenCalledTimes(1);
    });

    it("disposes the scoped Top Tab controller on ordinary React unmount", () => {
        const init = makeWorkspaceInit();
        const view = render(<WorkspaceApp init={init} />);
        const controller = layout.topTabController;

        expect(controller.openFile("/repo/new.ts")).toBeTruthy();
        view.rerender(<WorkspaceApp init={init} />);
        expect(layout.topTabController).toBe(controller);
        expect(controller.openPreview("/repo/still-mounted.md")).toBeTruthy();
        view.unmount();

        expect(() => controller.openFile("/repo/after-unmount.ts")).toThrow("Workspace Top Tab controller is disposed");
        expect(() => controller.activate("readme")).toThrow("Workspace Top Tab controller is disposed");
        expect(() => controller.dispose()).not.toThrow();
    });

    it("rebuilds the controller when the same workspace receives a newer generation", async () => {
        const firstInit = makeWorkspaceInit();
        const view = render(
            <WorkspaceApp key={`${firstInit.workspace.oid}:${firstInit.generation}`} init={firstInit} />
        );
        const firstController = layout.topTabController;
        const secondInit = makeWorkspaceInit();
        secondInit.generation = 2;
        await act(() =>
            WorkspaceModel.replaceInstance({
                windowId: secondInit.windowId,
                workspaceId: secondInit.workspace.oid,
                initialContentState: secondInit.workspace.contentstate,
                initialTerminalTabIds: secondInit.workspace.terminaltabids,
                initialActiveTerminalTabId: secondInit.workspace.activeterminaltabid,
                initialNavigationRevision: secondInit.workspace.navigationrevision,
                surfaceGeneration: secondInit.generation,
            })
        );

        view.rerender(<WorkspaceApp key={`${secondInit.workspace.oid}:${secondInit.generation}`} init={secondInit} />);
        const secondController = layout.topTabController;

        expect(secondController).not.toBe(firstController);
        expect(() => firstController.openFile("/repo/stale.ts")).toThrow("disposed");
        expect(secondController.openFile("/repo/current.ts")).toBeTruthy();
    });

    it("keeps exactly one controller subscription and teardown registration in StrictMode", () => {
        const originalSub = globalStore.sub.bind(globalStore);
        const activeSubscriptions = new Map<unknown, number>();
        const subSpy = vi.spyOn(globalStore, "sub").mockImplementation(((
            ...args: Parameters<typeof globalStore.sub>
        ) => {
            const targetAtom = args[0];
            activeSubscriptions.set(targetAtom, (activeSubscriptions.get(targetAtom) ?? 0) + 1);
            const unsubscribe = originalSub(...args);
            let active = true;
            return () => {
                if (!active) {
                    return;
                }
                active = false;
                activeSubscriptions.set(targetAtom, (activeSubscriptions.get(targetAtom) ?? 1) - 1);
                unsubscribe();
            };
        }) as typeof globalStore.sub);
        const init = makeWorkspaceInit();
        const view = render(
            <StrictMode>
                <WorkspaceApp init={init} />
            </StrictMode>
        );
        const controller = layout.topTabController;
        const model = WorkspaceModel.getInstance({ windowId: init.windowId, workspaceId: init.workspace.oid });

        expect(activeSubscriptions.get(model.contentStateAtom)).toBe(3);
        expect(model.preReplacementTeardowns.size).toBe(5);
        controller.stop();
        expect(activeSubscriptions.get(model.contentStateAtom)).toBe(2);
        expect(model.preReplacementTeardowns.size).toBe(4);
        controller.start();
        expect(activeSubscriptions.get(model.contentStateAtom)).toBe(3);
        expect(model.preReplacementTeardowns.size).toBe(5);
        view.rerender(
            <StrictMode>
                <WorkspaceApp init={init} />
            </StrictMode>
        );
        expect(layout.topTabController).toBe(controller);
        expect(activeSubscriptions.get(model.contentStateAtom)).toBe(3);
        expect(model.preReplacementTeardowns.size).toBe(5);

        view.unmount();

        expect(activeSubscriptions.get(model.contentStateAtom)).toBe(0);
        expect(model.preReplacementTeardowns.size).toBe(1);
        expect(() => controller.openFile("/repo/after-strict-unmount.ts")).toThrow(
            "Workspace Top Tab controller is disposed"
        );
        subSpy.mockRestore();
    });

    it("exposes an attached controller to descendant mount effects", () => {
        layout.openTopTabOnMount = true;
        const init = makeWorkspaceInit();

        render(
            <StrictMode>
                <WorkspaceApp init={init} />
            </StrictMode>
        );

        expect(layout.openTopTabError).toBeNull();
        expect(layout.openedTopTabId).toBeTruthy();
        const model = WorkspaceModel.getInstance({ windowId: init.windowId, workspaceId: init.workspace.oid });
        expect(
            globalStore
                .get(model.contentStateAtom)
                .topTabs.some((tab) => tab.id === layout.openedTopTabId && tab.path === "/repo/effect-open.ts")
        ).toBe(true);
    });

    it("owns workspace commands for its window and removes the listener on unmount", async () => {
        const init = makeWorkspaceInit();
        const view = render(<WorkspaceApp init={init} />);

        act(() => electronApi.workspaceCommandCallback?.({ type: "activate-top-tab", topTabId: "readme" }));
        expect(screen.getByTestId("file-top-tab-surface-readme").textContent).toContain("README.md");

        act(() => electronApi.workspaceCommandCallback?.({ type: "new-terminal" }));
        await vi.waitFor(() => expect(terminalRpc.create).toHaveBeenCalledOnce());
        expect(electronApi.createTab).not.toHaveBeenCalled();

        act(() => electronApi.workspaceCommandCallback?.({ type: "close-active" }));
        expect(screen.queryByRole("tab", { name: "README.md" })).toBeNull();

        view.unmount();
        expect(electronApi.unsubscribe).toHaveBeenCalledOnce();
    });

    it("responds to a clean workspace close request without deleting descriptors", async () => {
        const init = makeWorkspaceInit();
        render(<WorkspaceApp init={init} />);

        await act(async () => {
            electronApi.workspaceCloseCallback?.({ requestid: "request-1", reason: "window" });
            await Promise.resolve();
        });
        await vi.waitFor(() =>
            expect(electronApi.respondWorkspaceClose).toHaveBeenCalledWith({ requestid: "request-1", allow: true })
        );
        act(() =>
            electronApi.workspaceCloseFinalizeCallback?.({
                requestid: "request-1",
                commit: true,
            })
        );
        const model = WorkspaceModel.getInstance({ windowId: init.windowId, workspaceId: init.workspace.oid });
        expect(globalStore.get(model.contentStateAtom).topTabs).toHaveLength(1);
    });

    it("responds false exactly once when workspace close preparation rejects", async () => {
        const respond = vi.fn();
        await handleWorkspaceCloseRequest(
            { prepareWorkspaceClose: vi.fn().mockRejectedValue(new Error("offline")) } as any,
            respond,
            { requestid: "request-failed", reason: "window" }
        );
        expect(respond).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith({ requestid: "request-failed", allow: false });
    });

    it("does not infer Terminal membership from mixed workspace tab ids", () => {
        const init = makeWorkspaceInit();
        render(<WorkspaceApp init={init} />);
        const model = WorkspaceModel.getInstance({
            windowId: init.windowId,
            workspaceId: init.workspace.oid,
        });

        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-2",
            })
        );
        expect(screen.queryByTestId("terminal-surface")).toBeNull();
        expect(globalStore.get(model.activeTerminalTabIdAtom)).toBe("terminal-1");

        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-1",
            })
        );
        expect(screen.getByTestId("terminal-surface")).toBeTruthy();

        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-from-another-workspace",
            })
        );
        expect(screen.getByTestId("terminal-surface")).toBeTruthy();
        expect(globalStore.get(model.activeTerminalTabIdAtom)).toBe("terminal-1");
    });

    it("contains rejected Terminal IPC commands at the WorkspaceApp listener boundary", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        terminalRpc.close.mockRejectedValueOnce(new Error("close failed"));
        render(<WorkspaceApp init={makeWorkspaceInit()} />);

        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-1",
            })
        );
        act(() => electronApi.workspaceCommandCallback?.({ type: "close-active" }));
        await act(() => Promise.resolve());

        expect(screen.getByTestId("terminal-surface").hidden).toBe(false);
        expect(consoleError).toHaveBeenCalledWith("workspace command close-active failed", expect.any(Error));
        consoleError.mockRestore();
    });

    it("applies the authoritative close fallback without closing the Workspace", async () => {
        terminalRpc.close.mockResolvedValueOnce({
            workspaceid: "workspace-1",
            navigationrevision: 9,
            terminaltabids: [],
            activeterminaltabid: "",
            contentstate: {
                activecontent: { kind: "top-tab", toptabid: "readme" },
                toptabs: [
                    {
                        id: "readme",
                        kind: "file",
                        path: "/repo/README.md",
                        title: "README.md",
                    },
                ],
                lastactivetoptabid: "readme",
            },
        });
        render(<WorkspaceApp init={makeWorkspaceInit()} />);

        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-1",
            })
        );
        act(() => electronApi.workspaceCommandCallback?.({ type: "close-active" }));

        await vi.waitFor(() =>
            expect(screen.getByTestId("file-top-tab-surface-readme").textContent).toContain("README.md")
        );
        expect(electronApi.closeTab).not.toHaveBeenCalled();
        expect(screen.getByTestId("workspace-renderer-root")).toBeTruthy();
    });

    it("falls back from a closed active Terminal to its authoritative neighbor", async () => {
        terminalRpc.close.mockResolvedValueOnce({
            workspaceid: "workspace-1",
            navigationrevision: 9,
            terminaltabids: ["terminal-2"],
            activeterminaltabid: "terminal-2",
            contentstate: {
                activecontent: { kind: "terminal", terminaltabid: "terminal-2" },
                toptabs: [],
                lastactivetoptabid: "",
            },
        });
        const init = makeWorkspaceInit();
        init.workspace.terminaltabids = ["terminal-1", "terminal-2"];
        render(<WorkspaceApp init={init} />);

        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-1",
            })
        );
        act(() => electronApi.workspaceCommandCallback?.({ type: "close-active" }));

        const model = WorkspaceModel.getInstance({ windowId: "window-1", workspaceId: "workspace-1" });
        await vi.waitFor(() =>
            expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({
                kind: "terminal",
                terminalTabId: "terminal-2",
            })
        );
        expect(screen.getByTestId("terminal-surface")).toBeTruthy();
    });

    it("falls back from the final Terminal to Agent when no Top Tab remains", async () => {
        terminalRpc.close.mockResolvedValueOnce({
            workspaceid: "workspace-1",
            navigationrevision: 9,
            terminaltabids: [],
            activeterminaltabid: "",
            contentstate: {
                activecontent: { kind: "agent" },
                toptabs: [],
                lastactivetoptabid: "",
            },
        });
        const init = makeWorkspaceInit();
        init.workspace.contentstate.toptabs = [];
        init.workspace.contentstate.lastactivetoptabid = "";
        render(<WorkspaceApp init={init} />);

        act(() =>
            electronApi.workspaceCommandCallback?.({
                type: "activate-terminal",
                terminalTabId: "terminal-1",
            })
        );
        act(() => electronApi.workspaceCommandCallback?.({ type: "close-active" }));

        await vi.waitFor(() => expect(screen.getByTestId("agent-surface").getAttribute("aria-hidden")).toBe("false"));
        expect(screen.queryByTestId("terminal-surface")).toBeNull();
        expect(screen.getByTestId("workspace-renderer-root")).toBeTruthy();
    });
});
