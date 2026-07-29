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
    rejectSubmitWithRestore: false,
    submitResult: true,
    submitError: "",
}));

const selectorProps = vi.hoisted(() => ({
    latest: null as any,
}));

const threadProps = vi.hoisted(() => ({
    latest: null as any,
}));

const rewindSelectorProps = vi.hoisted(() => ({
    latest: null as any,
}));

const rewindDialogProps = vi.hoisted(() => ({
    latest: null as any,
}));

const composerProps = vi.hoisted(() => ({
    setText: vi.fn(),
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
                    if (text === "/rewind") {
                        void props.onRewindRequest?.();
                    }
                    if (text === "/redo") {
                        void props.onRedoRequest?.();
                    }
                    if (hostProps.submitError) {
                        props.onUserError?.(hostProps.submitError);
                    }
                    if (hostProps.rejectSubmitWithRestore) {
                        props.onRestoreComposerText?.({
                            text,
                            sessionPath: props.sessionMetadata?.path,
                            sessionRevision: props.sessionRevision,
                        });
                        return Promise.reject(new Error("send failed"));
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

vi.mock("./assistant-ui", () => ({
    AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Thread: (props: any) => {
        threadProps.latest = props;
        return (
            <div data-testid="assistant-thread">
                {props.beforeComposer}
                {props.onRevertTurn ? (
                    <button type="button" onClick={() => props.onRevertTurn("turn-a")}>
                        Message Revert
                    </button>
                ) : null}
                {props.revealTurnRequest && props.onRevealTurnComplete ? (
                    <button type="button" onClick={() => props.onRevealTurnComplete(props.revealTurnRequest)}>
                        Complete reveal
                    </button>
                ) : null}
                <textarea aria-label="Prompt" />
            </div>
        );
    },
    useAui: () => ({ composer: () => ({ setText: composerProps.setText }) }),
    useCrestAssistantRuntime: (value: unknown) => {
        hostProps.runtime = value;
        return value;
    },
}));

vi.mock("./rewind/rewind-selector", () => ({
    RewindSelector: (props: any) => {
        rewindSelectorProps.latest = props;
        return props.open ? (
            <div data-testid="rewind-selector">
                <span>{props.loading ? "loading" : "ready"}</span>
                {props.points.map((point: AgentRewindPointView) => (
                    <button key={point.turnId} type="button" onClick={() => props.onSelect(point.turnId)}>
                        {point.preview}
                    </button>
                ))}
            </div>
        ) : null;
    },
}));

vi.mock("./rewind/rewind-preview-dialog", () => ({
    RewindPreviewDialog: (props: any) => {
        rewindDialogProps.latest = props;
        return props.open ? (
            <div data-testid="rewind-preview">
                <span>{`${props.operation}:${props.phase}`}</span>
                <button type="button" onClick={props.onCancel}>
                    Cancel preview
                </button>
                <button type="button" onClick={() => props.onConfirm("normal")}>
                    Confirm normal
                </button>
                <button type="button" onClick={() => props.onConfirm("force-drift")}>
                    Confirm force
                </button>
            </div>
        ) : null;
    },
}));

function makeRewindState(overrides: Partial<AgentRewindSessionStateView> = {}): AgentRewindSessionStateView {
    return {
        enabled: true,
        semanticLeafId: "leaf-a",
        displayLeafId: "turn-a",
        eligibleTurnIds: ["turn-a"],
        busy: false,
        frozen: false,
        quota: {
            status: "ok",
            usedBytes: 0,
            softQuotaBytes: 5 * 1024 ** 3,
            cleanupAvailable: false,
        },
        ...overrides,
    };
}

function makePreview(
    target: AgentRewindPreviewResult["target"],
    overrides: Partial<AgentRewindPreviewResult> = {}
): AgentRewindPreviewResult {
    return {
        confirmationToken: "confirmation-token",
        target,
        targetPrompt: "Original prompt",
        semanticLeafId: "leaf-a",
        displayLeafId: "turn-a",
        expectedSemanticLeafId: "leaf-a",
        messageCount: 2,
        fileCount: 1,
        files: [],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
        ...overrides,
    };
}

function makeRewindClient(overrides: Record<string, unknown> = {}) {
    return {
        listRewindPoints: vi.fn(async () => ({
            points: [{ turnId: "turn-a", preview: "Original prompt", eligible: true }],
            semanticLeafId: "leaf-a",
            displayLeafId: "turn-a",
        })),
        previewRewind: vi.fn(async (input: AgentPreviewRewindInput) => makePreview(input.target)),
        rewindTree: vi.fn(async () => ({
            sessionMetadata: { id: "a", path: "/sessions/a.db", cwd: "/repo", createdAt: "now" },
            semanticLeafId: "turn-a",
            displayLeafId: "turn-a",
            editorText: "restored draft",
        })),
        redoRewind: vi.fn(async () => ({
            sessionMetadata: { id: "a", path: "/sessions/a.db", cwd: "/repo", createdAt: "now" },
            semanticLeafId: "leaf-redone",
            displayLeafId: "turn-redone",
        })),
        ...overrides,
    } as any;
}

function renderRewindContent(client = makeRewindClient()) {
    const model = makeModel();
    const session = { id: "a", path: "/sessions/a.db", cwd: "/repo", createdAt: "now" };
    act(() => model.selectSession(session));
    render(
        <Provider store={globalStore}>
            <AgentContent
                model={model}
                client={client}
                executionContext={{
                    workspaceId: "workspace-1",
                    workspaceDir: "/repo",
                    connection: "",
                    environment: {},
                }}
            />
        </Provider>
    );
    act(() => {
        hostProps.latest.onStateChange({
            status: "idle",
            queuedMessages: [],
            commands: [],
            rewindState: makeRewindState(),
        });
    });
    return { client, model, session };
}

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
    hostProps.rejectSubmitWithRestore = false;
    hostProps.submitResult = true;
    hostProps.submitError = "";
    selectorProps.latest = null;
    threadProps.latest = null;
    rewindSelectorProps.latest = null;
    rewindDialogProps.latest = null;
    composerProps.setText.mockReset();
    vi.useRealTimers();
    await WorkspaceAgentModel.resetInstances();
});

describe("AgentContent", () => {
    it("uses one rewind controller for message Revert and the slash selector path", async () => {
        const { client } = renderRewindContent();

        fireEvent.click(screen.getByRole("button", { name: "Message Revert" }));
        await waitFor(() =>
            expect(client.previewRewind).toHaveBeenCalledWith(
                expect.objectContaining({ target: { kind: "rewind", targetTurnId: "turn-a" } })
            )
        );
        expect(screen.getByTestId("rewind-preview").textContent).toContain("rewind:ready");

        act(() => rewindDialogProps.latest.onCancel());
        act(() => {
            expect(hostProps.runtime.submit("/rewind")).toBe(true);
        });
        await waitFor(() => expect(screen.getByTestId("rewind-selector").textContent).toContain("Original prompt"));
        fireEvent.click(screen.getByRole("button", { name: "Original prompt" }));

        expect(client.previewRewind).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "Complete reveal" }));
        await waitFor(() => expect(client.previewRewind).toHaveBeenCalledTimes(2));
        expect(threadProps.latest.revealTurnRequest).toBeUndefined();
        expect(screen.getByTestId("rewind-preview").textContent).toContain("rewind:ready");
    });

    it("cancels a selector reveal whose target never mounts", async () => {
        vi.useFakeTimers();
        const { client } = renderRewindContent();

        act(() => {
            expect(hostProps.runtime.submit("/rewind")).toBe(true);
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        fireEvent.click(screen.getByRole("button", { name: "Original prompt" }));
        expect(screen.getByRole("button", { name: "Complete reveal" })).not.toBeNull();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });

        expect(screen.queryByRole("button", { name: "Complete reveal" })).toBeNull();
        expect(client.previewRewind).not.toHaveBeenCalled();
    });

    it("confirms clean and force rewinds, cancels previews, and restores returned editor text", async () => {
        const { client } = renderRewindContent();

        await act(() => threadProps.latest.onRevertTurn("turn-a"));
        fireEvent.click(screen.getByRole("button", { name: "Confirm normal" }));
        await waitFor(() =>
            expect(client.rewindTree).toHaveBeenCalledWith(expect.objectContaining({ mode: "normal" }))
        );
        await waitFor(() => expect(composerProps.setText).toHaveBeenCalledWith("restored draft"));
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    semanticLeafId: "turn-a",
                    redo: {
                        operationId: "clean-rewind",
                        targetPrompt: "Original prompt",
                        messageCount: 2,
                        fileCount: 1,
                        files: [],
                    },
                }),
            });
        });

        await act(() => threadProps.latest.onRevertTurn("turn-a"));
        fireEvent.click(screen.getByRole("button", { name: "Confirm force" }));
        await waitFor(() =>
            expect(client.rewindTree).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "force-drift" }))
        );
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    semanticLeafId: "turn-a",
                    redo: {
                        operationId: "force-rewind",
                        targetPrompt: "Original prompt",
                        messageCount: 2,
                        fileCount: 1,
                        files: [],
                    },
                }),
            });
        });

        await act(() => threadProps.latest.onRevertTurn("turn-a"));
        fireEvent.click(screen.getByRole("button", { name: "Cancel preview" }));
        expect(screen.queryByTestId("rewind-preview")).toBeNull();
    });

    it("restores authoritative redo above the composer, shares openRedo with /redo, and waits for session_state removal", async () => {
        const { client } = renderRewindContent();
        const redo: AgentRedoView = {
            operationId: "operation-1",
            targetPrompt: "Original prompt",
            messageCount: 4,
            fileCount: 1,
            files: [],
        };
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({ redo }),
            });
        });

        const thread = screen.getByTestId("assistant-thread");
        const dockSummary = screen.getByText("Reverted 4 messages · 1 file");
        expect(
            !!(dockSummary.compareDocumentPosition(screen.getByLabelText("Prompt")) & Node.DOCUMENT_POSITION_FOLLOWING)
        ).toBe(true);

        fireEvent.click(screen.getByRole("button", { name: "Redo" }));
        await waitFor(() =>
            expect(client.previewRewind).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "redo" } }))
        );
        fireEvent.click(screen.getByRole("button", { name: "Cancel preview" }));

        act(() => {
            expect(hostProps.runtime.submit("/redo")).toBe(true);
        });
        await waitFor(() => expect(client.previewRewind).toHaveBeenCalledTimes(2));
        fireEvent.click(screen.getByRole("button", { name: "Confirm normal" }));
        await waitFor(() => expect(client.redoRewind).toHaveBeenCalledOnce());
        expect(screen.getByRole("button", { name: "Redo" }).hasAttribute("disabled")).toBe(true);
        act(() => {
            expect(hostProps.runtime.submit("/redo")).toBe(true);
        });
        expect(client.previewRewind).toHaveBeenCalledTimes(2);
        expect(thread.contains(dockSummary)).toBe(true);

        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState(),
            });
        });
        expect(screen.queryByText("Reverted 4 messages · 1 file")).toBeNull();
    });

    it("hides session A host state synchronously when the controlled session switches to B", async () => {
        const { model, session } = renderRewindContent();
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                sessionPath: session.path,
                sessionRevision: hostProps.latest.sessionRevision,
                rewindState: makeRewindState({
                    redo: {
                        operationId: "operation-a",
                        targetPrompt: "Session A prompt",
                        messageCount: 2,
                        fileCount: 0,
                        files: [],
                    },
                }),
            });
        });
        expect(screen.getByText("Reverted 2 messages · 0 files")).not.toBeNull();

        act(() => model.selectSession({ id: "b", path: "/sessions/b.db", cwd: "/repo", createdAt: "later" }));

        expect(screen.queryByText("Reverted 2 messages · 0 files")).toBeNull();
        expect(threadProps.latest.rewindableTurnIds.size).toBe(0);
        await waitFor(() => expect(hostProps.latest.sessionMetadata?.path).toBe("/sessions/b.db"));
    });

    it("restores each composer request once and never carries a pending request across sessions", async () => {
        const { model } = renderRewindContent();
        const sessionPath = hostProps.latest.sessionMetadata.path;
        const sessionRevision = hostProps.latest.sessionRevision;

        act(() =>
            hostProps.latest.onRestoreComposerText({
                text: "session A draft",
                sessionPath,
                sessionRevision,
            })
        );
        await waitFor(() => expect(composerProps.setText).toHaveBeenCalledTimes(1));
        act(() => {
            hostProps.latest.onStateChange({
                status: "streaming",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState(),
            });
        });
        expect(composerProps.setText).toHaveBeenCalledTimes(1);

        composerProps.setText.mockClear();
        act(() => {
            hostProps.latest.onRestoreComposerText({
                text: "stale session A draft",
                sessionPath,
                sessionRevision,
            });
            model.selectSession({ id: "b", path: "/sessions/b.db", cwd: "/repo", createdAt: "later" });
        });
        await waitFor(() => expect(hostProps.latest.sessionMetadata?.path).toBe("/sessions/b.db"));
        expect(composerProps.setText).not.toHaveBeenCalled();
    });

    it("restores an immediately rejected submit using the dispatch-scoped payload", async () => {
        renderRewindContent();
        hostProps.rejectSubmitWithRestore = true;

        await act(async () => {
            await expect(hostProps.runtime.submit("immediate draft")).rejects.toThrow("send failed");
        });

        expect(composerProps.setText).toHaveBeenCalledOnce();
        expect(composerProps.setText).toHaveBeenCalledWith("immediate draft");
    });

    it("consumes an accepted first-mint restore scope after the session selection batches with the failure", async () => {
        const model = makeModel();
        render(
            <Provider store={globalStore}>
                <AgentContent
                    model={model}
                    client={makeRewindClient()}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        connection: "",
                        environment: {},
                    }}
                />
            </Provider>
        );
        const mintedSession = { id: "minted", path: "/sessions/minted.db", cwd: "/repo", createdAt: "now" };

        act(() => {
            hostProps.latest.onSessionChange(mintedSession);
            hostProps.latest.onRestoreComposerText({
                text: "first draft",
                sessionPath: mintedSession.path,
                sessionRevision: 1,
            });
        });

        await waitFor(() => expect(hostProps.latest.sessionMetadata).toEqual(mintedSession));
        expect(composerProps.setText).toHaveBeenCalledOnce();
        expect(composerProps.setText).toHaveBeenCalledWith("first draft");
    });

    it("ignores an old preview result after switching sessions", async () => {
        let resolvePreview!: (preview: AgentRewindPreviewResult) => void;
        const previewPromise = new Promise<AgentRewindPreviewResult>((resolve) => {
            resolvePreview = resolve;
        });
        const { client, model } = renderRewindContent(makeRewindClient({ previewRewind: vi.fn(() => previewPromise) }));

        fireEvent.click(screen.getByRole("button", { name: "Message Revert" }));
        await waitFor(() => expect(client.previewRewind).toHaveBeenCalledOnce());
        act(() => model.selectSession({ id: "b", path: "/sessions/b.db", cwd: "/repo", createdAt: "later" }));
        await waitFor(() => expect(hostProps.latest.sessionMetadata?.path).toBe("/sessions/b.db"));
        await act(async () => {
            resolvePreview(makePreview({ kind: "rewind", targetTurnId: "turn-a" }));
            await previewPromise;
        });

        expect(screen.queryByTestId("rewind-preview")).toBeNull();
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
