// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceAgentModel } from "@/app/workspace/workspace-agent-model";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentContent } from "./agent-content";

const hostProps = vi.hoisted(() => ({
    latest: null as any,
    runtime: null as any,
    skipReady: false,
    simulateMissingSessionSelectorError: false,
    submitResult: true,
    submitError: "",
}));

const selectorProps = vi.hoisted(() => ({
    latest: null as any,
}));

const modelPickerProps = vi.hoisted(() => ({
    latest: null as any,
}));

const modalMocks = vi.hoisted(() => ({
    pushModal: vi.fn(),
}));

const threadProps = vi.hoisted(() => ({ latest: null as any }));
const layoutProps = vi.hoisted(() => ({ openRightTool: vi.fn() }));

vi.mock("@/app/workspace/workspace-layout-model", () => ({
    WorkspaceLayoutModel: { getInstance: () => layoutProps },
}));

vi.mock("./agent-chat-host", () => ({
    AgentChatHost: (props: any) => {
        hostProps.latest = props;
        if (!hostProps.skipReady) {
            props.onReady?.({
                submit: vi.fn((text: string) => {
                    if (hostProps.simulateMissingSessionSelectorError && (text === "/tree" || text === "/fork")) {
                        props.onUserError?.("No agent session yet. Send a prompt before using session commands.");
                    }
                    if (hostProps.submitError) {
                        props.onUserError?.(hostProps.submitError);
                    }
                    return hostProps.submitResult;
                }),
                abort: vi.fn(),
                getTurns: vi.fn(() => []),
            });
        }
        return <div data-testid="agent-chat-host" />;
    },
}));

vi.mock("@/app/view/cmdblock/session-selector", () => ({
    SessionSelector: (props: any) => {
        selectorProps.latest = props;
        return null;
    },
}));

vi.mock("@/app/view/cmdblock/model-picker-popover", () => ({
    ModelPickerInline: (props: any) => {
        modelPickerProps.latest = props;
        return null;
    },
}));

vi.mock("@/app/store/modalmodel", () => ({
    modalsModel: {
        pushModal: modalMocks.pushModal,
    },
}));

vi.mock("./assistant-ui", () => ({
    AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Thread: (props: { beforeComposer?: React.ReactNode }) => {
        threadProps.latest = props;
        return (
            <div data-testid="assistant-thread">
                {props.beforeComposer}
                <textarea aria-label="Prompt" />
            </div>
        );
    },
    useAui: () => ({ composer: () => ({ setText: vi.fn() }) }),
    useCrestAssistantRuntime: (value: unknown) => {
        hostProps.runtime = value;
        return value;
    },
}));

function makeModel(): WorkspaceAgentModel {
    return WorkspaceAgentModel.getInstance({
        windowId: `window-${Math.random()}`,
        workspaceId: "workspace-1",
        generation: 1,
        initialState: {},
        saveCheckpoint: vi.fn().mockResolvedValue({ workspaceid: "workspace-1", revision: 1, state: {} }),
    });
}

afterEach(async () => {
    cleanup();
    hostProps.skipReady = false;
    hostProps.simulateMissingSessionSelectorError = false;
    hostProps.submitResult = true;
    hostProps.submitError = "";
    selectorProps.latest = null;
    modelPickerProps.latest = null;
    modalMocks.pushModal.mockReset();
    layoutProps.openRightTool.mockClear();
    vi.useRealTimers();
    await WorkspaceAgentModel.resetInstances();
});

describe("AgentContent", () => {
    it("opens Settings on Models and closes the model picker from Add", () => {
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        act(() => hostProps.latest.onOpenModelPicker());
        expect(modelPickerProps.latest.open).toBe(true);

        act(() => modelPickerProps.latest.onOpenConfigFile());

        expect(modelPickerProps.latest.open).toBe(false);
        expect(modalMocks.pushModal).toHaveBeenCalledWith("SettingsModal", { initialTab: "models" });
    });

    it("opens the Context right tool through the composer ring callback", () => {
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{ workspaceId: "workspace-1", workspaceDir: "/repo", environment: {} }}
                />
            </Provider>
        );

        act(() => threadProps.latest.onOpenContextInspector());
        expect(layoutProps.openRightTool).toHaveBeenCalledWith("context");
    });

    it("publishes only the host context snapshot matching the current renderer identity", () => {
        const model = makeModel();
        model.selectModel({ provider: "openai", model: "gpt-test", reasoning: "low" });
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{ workspaceId: "workspace-1", workspaceDir: "/repo", environment: {} }}
                />
            </Provider>
        );
        const inspection = globalStore.get(model.contextSnapshotAtom);
        expect(inspection?.status).toBe("loading");
        const persistedStateBeforeSnapshot = globalStore.get(model.stateAtom);
        const snapshot = {
            schemaVersion: 1,
            identity: {
                leafId: null,
                modelKey: inspection.identity.modelKey,
                revision: 1,
            },
            generatedAt: "2026-08-01T00:00:00Z",
            lifecycle: "ready",
            accuracy: "estimated",
            modelLabel: inspection.identity.modelKey,
            contextWindow: 100_000,
            outputReserve: 10_000,
            inputCapacity: 90_000,
            effectiveInputTokens: 20,
            remainingInputTokens: 89_980,
            categories: [],
            items: [],
        } satisfies AgentContextSnapshotView;

        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                contextSnapshot: snapshot,
            });
        });

        expect(globalStore.get(model.contextSnapshotAtom)).toMatchObject({ status: "ready", snapshot });
        expect(globalStore.get(model.stateAtom)).toEqual(persistedStateBeforeSnapshot);
    });

    it("writes session changes to the model but keeps user errors component-local", () => {
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        act(() => {
            hostProps.latest.onSessionChange({ path: "/sessions/agent.json", cwd: "/repo" });
            hostProps.latest.onUserError("missing key");
        });

        expect(globalStore.get(model.stateAtom).activeSession?.path).toBe("/sessions/agent.json");
        expect(globalStore.get(model.errorAtom)).toBe("");
        expect(screen.getByRole("alert").textContent).toContain("missing key");
    });

    it("keeps an unavailable-host submit error component-local", () => {
        hostProps.skipReady = true;
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        act(() => {
            expect(hostProps.runtime.submit("retry")).toBe(false);
        });

        expect(globalStore.get(model.errorAtom)).toBe("");
        expect(screen.getByRole("alert").textContent).toContain("Agent is still starting");
    });

    it("restarts an identical selector success notification without disturbing errors", () => {
        vi.useFakeTimers();
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        act(() => {
            hostProps.latest.onUserError("real failure");
            selectorProps.latest.onUserMessage("Reference added");
        });

        expect(screen.getByRole("alert").textContent).toContain("real failure");
        expect(screen.getByRole("status").textContent).toContain("Reference added");

        act(() => vi.advanceTimersByTime(3_000));
        act(() => selectorProps.latest.onUserMessage("Reference added"));
        act(() => vi.advanceTimersByTime(1_500));

        expect(screen.getByRole("status").textContent).toContain("Reference added");
        expect(screen.getByRole("alert").textContent).toContain("real failure");

        act(() => vi.advanceTimersByTime(2_500));

        expect(screen.getByRole("alert").textContent).toContain("real failure");
        expect(screen.queryByRole("status")).toBeNull();
    });

    it.each([
        ["/tree", "Agent session tree"],
        ["/fork", "Fork agent session"],
    ])("shows the missing-session error from %s without opening its selector", (command, selectorTitle) => {
        hostProps.simulateMissingSessionSelectorError = true;
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        act(() => {
            expect(hostProps.runtime.submit(command)).toBe(true);
        });

        expect(screen.getByRole("alert").textContent).toContain(
            "No agent session yet. Send a prompt before using session commands."
        );
        expect(screen.queryByText(selectorTitle)).toBeNull();
    });

    it("clears an old local user error before a successful new submit", () => {
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );
        act(() => hostProps.latest.onUserError("old local error"));
        expect(screen.getByRole("alert").textContent).toContain("old local error");

        act(() => {
            expect(hostProps.runtime.submit("retry")).toBe(true);
        });

        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("preserves the previous local error when submit returns false without a new error", () => {
        hostProps.submitResult = false;
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );
        act(() => hostProps.latest.onUserError("previous local error"));

        act(() => {
            expect(hostProps.runtime.submit("unhandled")).toBe(false);
        });

        expect(screen.getByRole("alert").textContent).toContain("previous local error");
    });

    it("keeps a new synchronous error when submit returns false", () => {
        hostProps.submitResult = false;
        hostProps.submitError = "new synchronous error";
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );
        act(() => hostProps.latest.onUserError("previous local error"));

        act(() => {
            expect(hostProps.runtime.submit("rejected")).toBe(false);
        });

        expect(screen.getByRole("alert").textContent).toContain("new synchronous error");
        expect(screen.getByRole("alert").textContent).not.toContain("previous local error");
    });

    it("bumps the controlled session revision for repeated explicit clears", async () => {
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        expect(hostProps.latest.sessionMetadata).toBeUndefined();
        expect(hostProps.latest.sessionRevision).toBe(0);
        act(() => hostProps.latest.onSessionChange(undefined));
        await waitFor(() => expect(hostProps.latest.sessionRevision).toBe(1));
        expect(hostProps.latest.sessionMetadata).toBeUndefined();

        act(() => hostProps.latest.onSessionChange(undefined));
        await waitFor(() => expect(hostProps.latest.sessionRevision).toBe(2));
    });

    it("uses the model session generation for sidebar-style A to B to A changes", async () => {
        const model = makeModel();
        const sessionA = { id: "a", path: "/sessions/a.db", cwd: "/repo", createdAt: "now" };
        const sessionB = { id: "b", path: "/sessions/b.db", cwd: "/repo", createdAt: "later" };
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        act(() => model.selectSession(sessionA));
        await waitFor(() => expect(hostProps.latest.sessionRevision).toBe(1));
        act(() => model.selectSession(sessionB));
        await waitFor(() => expect(hostProps.latest.sessionRevision).toBe(2));
        act(() => model.selectSession(sessionA));
        await waitFor(() => expect(hostProps.latest.sessionRevision).toBe(3));

        expect(hostProps.latest.sessionMetadata).toEqual(sessionA);
    });

    it("keeps assistant DOM and draft state mounted across equivalent AgentContent rerenders", () => {
        const model = makeModel();
        const client = {} as any;
        const executionContext = {
            workspaceId: "workspace-1",
            workspaceDir: "/repo",
            environment: {},
        };
        const view = render(
            <Provider store={globalStore}>
                <AgentContent model={model} client={client} executionContext={executionContext} />
            </Provider>
        );
        const surface = screen.getByTestId("agent-content");
        const prompt = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
        fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "draft" } });

        view.rerender(
            <Provider store={globalStore}>
                <AgentContent model={model} client={client} executionContext={executionContext} />
            </Provider>
        );

        expect(screen.getByTestId("agent-content")).toBe(surface);
        expect(screen.getByLabelText("Prompt")).toBe(prompt);
        expect(prompt.value).toBe("draft");
        expect(surface.getAttribute("aria-hidden")).toBeNull();
        expect(surface.getAttribute("style")).toBeNull();
    });

    it("renders one dismissible inline alert with host errors taking priority over model errors", () => {
        const model = makeModel();
        globalStore.set(model.errorAtom, "checkpoint failed");
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        expect(screen.getByRole("alert").textContent).toContain("checkpoint failed");
        act(() => {
            hostProps.latest.onStateChange({
                status: "error",
                errorMessage: "agent request failed",
                queuedMessages: [],
                commands: [],
            });
        });

        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(screen.getByRole("alert").textContent).toContain("agent request failed");
        expect(screen.getByRole("alert").textContent).not.toContain("checkpoint failed");

        fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));

        expect(screen.getByRole("alert").textContent).toContain("checkpoint failed");
        expect(globalStore.get(model.errorAtom)).toBe("checkpoint failed");

        fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));

        expect(screen.queryByRole("alert")).toBeNull();
        expect(globalStore.get(model.errorAtom)).toBe("checkpoint failed");
    });

    it("preserves a model persistence error when the host starts a successful retry", () => {
        const model = makeModel();
        globalStore.set(model.errorAtom, "previous failure");
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        act(() => {
            hostProps.latest.onStateChange({
                status: "streaming",
                errorMessage: undefined,
                queuedMessages: [],
                commands: [],
            });
        });

        expect(screen.getByRole("alert").textContent).toContain("previous failure");
        expect(globalStore.get(model.errorAtom)).toBe("previous failure");
    });

    it("preserves a model persistence error when a submit is accepted", () => {
        const model = makeModel();
        globalStore.set(model.errorAtom, "save checkpoint failed");
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        expect(hostProps.runtime.submit("retry")).toBe(true);

        expect(globalStore.get(model.errorAtom)).toBe("save checkpoint failed");
        expect(screen.getByRole("alert").textContent).toContain("save checkpoint failed");
    });

    it("does not clear a new model error on a same-status streaming update", () => {
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                />
            </Provider>
        );

        act(() => {
            hostProps.latest.onStateChange({
                status: "streaming",
                errorMessage: undefined,
                queuedMessages: [],
                commands: [],
            });
        });
        act(() => {
            globalStore.set(model.errorAtom, "checkpoint failed during the run");
            hostProps.latest.onStateChange({
                status: "streaming",
                errorMessage: undefined,
                queuedMessages: [{ role: "user", content: [{ type: "text", text: "queued" }] }],
                commands: [],
            });
        });

        expect(globalStore.get(model.errorAtom)).toBe("checkpoint failed during the run");
        expect(screen.getByRole("alert").textContent).toContain("checkpoint failed during the run");
    });
});
