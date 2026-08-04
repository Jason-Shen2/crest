// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { ToastModel } from "@/app/notifications/toast-model";
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
    agentSubmit: vi.fn(),
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

const turnDialogProps = vi.hoisted(() => ({
    latest: null as any,
}));

const recoveryDialogProps = vi.hoisted(() => ({
    latest: null as any,
}));

const quotaBannerProps = vi.hoisted(() => ({
    latest: null as any,
}));

const quotaDialogProps = vi.hoisted(() => ({
    latest: null as any,
}));

const composerProps = vi.hoisted(() => ({
    setText: vi.fn(),
}));

vi.mock("./agent-chat-host", () => ({
    AgentChatHost: (props: any) => {
        hostProps.latest = props;
        hostProps.agentSubmit.mockImplementation((text: string) => {
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
        });
        if (!hostProps.skipReady) {
            props.onReady?.({
                submit: hostProps.agentSubmit,
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

vi.mock("./rewind/diff-review-dialog", () => ({
    DiffReviewDialog: (props: any) => {
        if (props.title.toLowerCase().includes("turn")) {
            turnDialogProps.latest = props;
        } else {
            rewindDialogProps.latest = props;
        }
        return props.open ? (
            <div data-testid="rewind-preview">
                <span>{`${props.title}:${props.loading ? "loading" : "ready"}`}</span>
                {props.warnings?.map((warning: string) => (
                    <span key={warning}>{warning}</span>
                ))}
                {props.files?.map((file: AgentRewindFileRowView) =>
                    file.reason ? <span key={`${file.path}:${file.reason}`}>{file.reason}</span> : null
                )}
                {props.footer}
            </div>
        ) : null;
    },
}));

vi.mock("./rewind/recovery-dialog", () => ({
    RecoveryDialog: (props: any) => {
        recoveryDialogProps.latest = props;
        return props.open ? (
            <div data-testid="recovery-dialog">
                <span>{props.recovery?.operationId}</span>
                {props.recovery?.allowedActions.map((action: string) => (
                    <button key={action} type="button" disabled={props.busy} onClick={() => props.onAction(action)}>
                        {action}
                    </button>
                ))}
                <button type="button" onClick={props.onClose}>
                    Close recovery
                </button>
            </div>
        ) : null;
    },
}));

vi.mock("./rewind/checkpoint-quota-banner", () => ({
    CheckpointQuotaBanner: (props: any) => {
        quotaBannerProps.latest = props;
        return props.quota.status !== "ok" ? (
            <div data-testid="quota-banner">
                <button type="button" disabled={props.busy || props.mutationsDisabled} onClick={props.onCleanup}>
                    Clean up unreferenced snapshots
                </button>
                <button type="button" disabled={props.busy || props.mutationsDisabled} onClick={props.onManage}>
                    Manage checkpoint storage
                </button>
            </div>
        ) : null;
    },
}));

vi.mock("./rewind/checkpoint-quota-dialog", () => ({
    CheckpointQuotaDialog: (props: any) => {
        quotaDialogProps.latest = props;
        return props.open ? (
            <div data-testid="quota-dialog">
                {props.owners.map((owner: AgentCheckpointTrashOwnerView) => (
                    <button
                        disabled={
                            props.maintenanceBusy ||
                            props.phase === "purging" ||
                            props.mutationsDisabled ||
                            props.staleOwnerIds?.includes(owner.sessionId)
                        }
                        key={owner.sessionId}
                        type="button"
                        onClick={() =>
                            props.onPurge({
                                trashedSessionId: owner.sessionId,
                                confirmationToken: owner.confirmationToken,
                            })
                        }
                    >
                        {owner.sessionId}
                    </button>
                ))}
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
        turnChanges: [],
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

function makeTurnPreview(
    kind: "turn-undo" | "turn-redo",
    overrides: Partial<AgentTurnMutationPreviewResult> = {}
): AgentTurnMutationPreviewResult {
    return {
        confirmationToken: "turn-confirmation-token",
        target:
            kind === "turn-undo"
                ? { kind, sourceTurnId: "turn-a" }
                : { kind, sourceTurnId: "turn-a", undoOperationId: "undo-a" },
        semanticLeafId: "leaf-a",
        displayLeafId: "turn-a",
        expectedSemanticLeafId: "leaf-a",
        fileCount: 1,
        files: [
            {
                path: "frontend/card.tsx",
                operation: "write",
                additions: 4,
                deletions: 2,
                conflict: "none",
                coverage: "covered",
                diff: "@@ -1 +1 @@\n-old\n+new",
            },
        ],
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
        getTurnChangeSummary: vi.fn(async (input: AgentTurnTargetInput) => ({
            turnId: input.turnId,
            semanticLeafId: "leaf-a",
            fileCount: 1,
            additions: 4,
            deletions: 2,
            files: [{ path: "frontend/card.tsx", operation: "write", additions: 4, deletions: 2 }],
        })),
        reviewTurnChanges: vi.fn(async (input: AgentTurnTargetInput) => ({
            turnId: input.turnId,
            semanticLeafId: "leaf-a",
            files: [
                {
                    path: "frontend/card.tsx",
                    operation: "write",
                    additions: 4,
                    deletions: 2,
                    conflict: "none",
                    diff: "@@ -1 +1 @@\n-old\n+new",
                },
            ],
        })),
        previewTurnUndo: vi.fn(),
        previewTurnRedo: vi.fn(),
        applyTurnUndo: vi.fn(),
        applyTurnRedo: vi.fn(),
        getWorkspaceRecovery: vi.fn(async () => undefined),
        resolveWorkspaceRecovery: vi.fn(async () => undefined),
        cleanupWorkspaceCheckpoints: vi.fn(async () => ({
            removedUnownedBytes: 0,
            quota: makeRewindState({
                quota: {
                    status: "referenced-over-quota",
                    usedBytes: 6 * 1024 ** 3,
                    softQuotaBytes: 5 * 1024 ** 3,
                    cleanupAvailable: true,
                },
            }).quota,
        })),
        listCheckpointStorageOwners: vi.fn(async () => ({ trashOwners: [] })),
        purgeTrashedSession: vi.fn(async () => ({
            purgedSessionId: "trash-a",
            quota: makeRewindState().quota,
        })),
        ...overrides,
    } as any;
}

function renderRewindContent(
    client = makeRewindClient(),
    props: { onOpenFile?: (path: string) => void; onOpenTurnDiff?: (turnId: string, path: string) => void } = {}
) {
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
                onOpenFile={props.onOpenFile}
                onOpenTurnDiff={props.onOpenTurnDiff}
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
    ToastModel.getInstance().clear();
    hostProps.skipReady = false;
    hostProps.simulateMissingSessionSelectorError = false;
    hostProps.rejectSubmitWithRestore = false;
    hostProps.submitResult = true;
    hostProps.submitError = "";
    selectorProps.latest = null;
    threadProps.latest = null;
    rewindSelectorProps.latest = null;
    rewindDialogProps.latest = null;
    turnDialogProps.latest = null;
    recoveryDialogProps.latest = null;
    quotaBannerProps.latest = null;
    quotaDialogProps.latest = null;
    hostProps.agentSubmit.mockReset();
    composerProps.setText.mockReset();
    vi.useRealTimers();
    await WorkspaceAgentModel.resetInstances();
});

describe("AgentContent", () => {
    it("routes card file clicks to immutable turn diff without changing the ordinary file callback", () => {
        const onOpenFile = vi.fn();
        const onOpenTurnDiff = vi.fn();
        renderRewindContent(makeRewindClient(), { onOpenFile, onOpenTurnDiff });

        expect(threadProps.latest.onOpenFile).toBe(onOpenFile);
        expect(threadProps.latest.onOpenTurnDiff).toBe(onOpenTurnDiff);
    });

    it("provides completed turn cards and opens forward review in the shared diff dialog", async () => {
        const onOpenTurnDiff = vi.fn();
        const { client } = renderRewindContent(makeRewindClient(), { onOpenTurnDiff });
        act(() => {
            hostProps.latest.onTurnsChange([
                {
                    turnId: "turn-a",
                    responseMessages: [],
                    status: "done",
                },
            ]);
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    turnChanges: [{ turnId: "turn-a", action: "undo" }],
                }),
            });
        });

        await waitFor(() => expect(threadProps.latest.turnChanges.cards.has("turn-a")).toBe(true));
        await act(async () => threadProps.latest.turnChanges.openReview("turn-a"));

        expect(client.reviewTurnChanges).toHaveBeenCalledWith({
            sessionMetadata: expect.objectContaining({ path: "/sessions/a.db" }),
            expectedSemanticLeafId: "leaf-a",
            turnId: "turn-a",
        });
        expect(turnDialogProps.latest.title).toBe("Review turn changes");
        expect(turnDialogProps.latest).not.toHaveProperty("description");
        expect(turnDialogProps.latest.files[0].diff).toContain("-old\n+new");
        act(() => turnDialogProps.latest.onSelectedPathChange("frontend/card.tsx"));
        expect(onOpenTurnDiff).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Undo .*file/ })).toBeNull();
    });

    it("locks live mutation footer controls when running, workspace-busy, or recovery-frozen", async () => {
        const { client } = renderRewindContent(
            makeRewindClient({ previewTurnUndo: vi.fn(async () => makeTurnPreview("turn-undo")) })
        );
        act(() => {
            hostProps.latest.onTurnsChange([{ turnId: "turn-a", responseMessages: [], status: "done" }]);
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({ turnChanges: [{ turnId: "turn-a", action: "undo" }] }),
            });
        });
        await waitFor(() => expect(threadProps.latest.turnChanges.cards.has("turn-a")).toBe(true));
        await act(async () => threadProps.latest.turnChanges.openMutation("turn-a"));
        expect(client.previewTurnUndo).toHaveBeenCalledOnce();
        expect(screen.getByRole("button", { name: "Undo 1 file" }).hasAttribute("disabled")).toBe(false);

        act(() => {
            hostProps.latest.onStateChange({
                status: "streaming",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({ turnChanges: [{ turnId: "turn-a", action: "undo" }] }),
            });
        });
        expect(turnDialogProps.latest.locked).toBe(true);
        expect(screen.getByRole("button", { name: "Undo 1 file" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);

        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    turnChanges: [{ turnId: "turn-a", action: "undo" }],
                    busy: true,
                    frozen: true,
                }),
            });
        });
        expect(turnDialogProps.latest.locked).toBe(true);
        expect(screen.getByRole("button", { name: "Undo 1 file" }).hasAttribute("disabled")).toBe(true);
    });

    it("keeps the diff visible while undo applies and toasts only after authoritative completion", async () => {
        let resolveApply!: (result: AgentRewindMutationResult) => void;
        const applyTurnUndo = vi.fn(
            () =>
                new Promise<AgentRewindMutationResult>((resolve) => {
                    resolveApply = resolve;
                })
        );
        const { session } = renderRewindContent(
            makeRewindClient({
                previewTurnUndo: vi.fn(async () => makeTurnPreview("turn-undo")),
                applyTurnUndo,
            })
        );
        act(() => {
            hostProps.latest.onTurnsChange([{ turnId: "turn-a", responseMessages: [], status: "done" }]);
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({ turnChanges: [{ turnId: "turn-a", action: "undo" }] }),
            });
        });
        await waitFor(() => expect(threadProps.latest.turnChanges.cards.has("turn-a")).toBe(true));
        await act(async () => threadProps.latest.turnChanges.openMutation("turn-a"));

        fireEvent.click(screen.getByRole("button", { name: "Undo 1 file" }));
        await waitFor(() => expect(applyTurnUndo).toHaveBeenCalledOnce());
        expect(turnDialogProps.latest.files).toHaveLength(1);
        expect(turnDialogProps.latest.processingLabel).toBe("Undoing 1 file…");
        expect(screen.getByRole("button", { name: "Undoing…" }).hasAttribute("disabled")).toBe(true);

        await act(async () => {
            resolveApply({ sessionMetadata: session, semanticLeafId: "leaf-undone", displayLeafId: "turn-a" });
        });
        expect(globalStore.get(ToastModel.getInstance().toastsAtom)).toHaveLength(0);

        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    semanticLeafId: "leaf-undone",
                    turnChanges: [{ turnId: "turn-a", action: "redo", undoOperationId: "undo-a" }],
                }),
            });
        });
        await waitFor(() => expect(turnDialogProps.latest.open).toBe(false));
        expect(globalStore.get(ToastModel.getInstance().toastsAtom)).toEqual([
            expect.objectContaining({
                source: "crest-agent",
                kind: "completed",
                title: "Changes undone",
                body: "1 file restored.",
            }),
        ]);
    });

    it("keeps checkpoint coverage diagnostics out of the turn undo dialog", async () => {
        const coverageWarnings = [
            ".DS_Store: ignored",
            ".git: nested-repository",
            ".vite: ignored",
            "node_modules: ignored",
        ];
        renderRewindContent(
            makeRewindClient({
                previewTurnUndo: vi.fn(async () => makeTurnPreview("turn-undo", { coverageWarnings })),
            })
        );
        act(() => {
            hostProps.latest.onTurnsChange([{ turnId: "turn-a", responseMessages: [], status: "done" }]);
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({ turnChanges: [{ turnId: "turn-a", action: "undo" }] }),
            });
        });
        await waitFor(() => expect(threadProps.latest.turnChanges.cards.has("turn-a")).toBe(true));

        await act(async () => threadProps.latest.turnChanges.openMutation("turn-a"));

        expect(turnDialogProps.latest.warnings ?? []).toEqual([]);
        for (const warning of coverageWarnings) {
            expect(screen.queryByText(warning)).toBeNull();
        }
    });

    it("shows force only for undo, hard blockers only cancel, and never force-redoes drift", async () => {
        const previewTurnUndo = vi
            .fn()
            .mockResolvedValueOnce(makeTurnPreview("turn-undo", { forceRequired: true }))
            .mockResolvedValueOnce(makeTurnPreview("turn-undo", { hardBlocked: true }));
        const previewTurnRedo = vi.fn(async () => makeTurnPreview("turn-redo", { forceRequired: true }));
        renderRewindContent(makeRewindClient({ previewTurnUndo, previewTurnRedo }));
        act(() => {
            hostProps.latest.onTurnsChange([{ turnId: "turn-a", responseMessages: [], status: "done" }]);
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({ turnChanges: [{ turnId: "turn-a", action: "undo" }] }),
            });
        });
        await waitFor(() => expect(threadProps.latest.turnChanges.cards.has("turn-a")).toBe(true));

        await act(async () => threadProps.latest.turnChanges.openMutation("turn-a"));
        expect(screen.getByRole("button", { name: "Force undo" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Undo 1 file" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        await act(async () => threadProps.latest.turnChanges.openMutation("turn-a"));
        expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Force undo" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Undo 1 file" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    turnChanges: [{ turnId: "turn-a", action: "redo", undoOperationId: "undo-a" }],
                }),
            });
        });
        await act(async () => threadProps.latest.turnChanges.openMutation("turn-a"));
        expect(turnDialogProps.latest).not.toHaveProperty("description");
        expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Force/ })).toBeNull();
        expect(screen.queryByRole("button", { name: "Redo 1 file" })).toBeNull();
    });

    it("freezes writes and renders only authoritative recovery actions until session_state thaws", async () => {
        const recovery: AgentWorkspaceRecoveryView = {
            operationId: "operation-frozen",
            corrupt: false,
            message: "Recovery required",
            paths: [{ path: "src/frozen.ts", classification: "target" }],
            allowedActions: ["retry", "abandon-current"],
        };
        const { client, session } = renderRewindContent(
            makeRewindClient({ getWorkspaceRecovery: vi.fn(async () => recovery) })
        );
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    frozen: true,
                    redo: {
                        operationId: "redo-frozen",
                        messages: ["Frozen prompt"],
                        messageCount: 1,
                        fileCount: 1,
                        files: [],
                    },
                }),
            });
        });

        await waitFor(() => expect(screen.getByTestId("recovery-dialog").textContent).toContain("operation-frozen"));
        expect(hostProps.runtime.isSendDisabled).toBe(false);
        expect(threadProps.latest.rewindBusy).toBe(true);
        expect((screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.queryByText(/force/i)).toBeNull();
        expect(hostProps.runtime.submit("explain the failure")).toBe(false);
        expect(hostProps.runtime.submit("/compact")).toBe(false);
        expect(hostProps.runtime.submit("/tree")).toBe(true);
        expect(hostProps.agentSubmit).toHaveBeenCalledTimes(1);
        expect(hostProps.agentSubmit).toHaveBeenCalledWith("/tree", undefined);

        fireEvent.click(screen.getByRole("button", { name: "retry" }));
        await waitFor(() =>
            expect(client.resolveWorkspaceRecovery).toHaveBeenCalledWith({
                sessionMetadata: session,
                operationId: "operation-frozen",
                action: "retry",
            })
        );
        expect(screen.getByTestId("recovery-dialog")).not.toBeNull();
        expect(screen.getByTestId("agent-chat-host")).not.toBeNull();

        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState(),
            });
        });
        expect(screen.queryByTestId("recovery-dialog")).toBeNull();
        expect(hostProps.runtime.isSendDisabled).toBe(false);
    });

    it("drops stale recovery responses after switching sessions", async () => {
        let resolveRecovery!: (value: AgentWorkspaceRecoveryView) => void;
        const recoveryPromise = new Promise<AgentWorkspaceRecoveryView>((resolve) => {
            resolveRecovery = resolve;
        });
        const { model } = renderRewindContent(makeRewindClient({ getWorkspaceRecovery: vi.fn(() => recoveryPromise) }));
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({ frozen: true }),
            });
        });
        await waitFor(() => expect(recoveryDialogProps.latest?.open).toBe(true));

        act(() => model.selectSession({ id: "b", path: "/sessions/b.db", cwd: "/repo", createdAt: "later" }));
        await waitFor(() => expect(hostProps.latest.sessionMetadata?.path).toBe("/sessions/b.db"));
        await act(async () => {
            resolveRecovery({
                operationId: "stale-operation",
                corrupt: false,
                message: "stale",
                paths: [],
                allowedActions: ["retry"],
            });
            await recoveryPromise;
        });

        expect(screen.queryByText("stale-operation")).toBeNull();
    });

    it("keeps quota UI authoritative and purges only backend trash owners with opaque tokens", async () => {
        const owner: AgentCheckpointTrashOwnerView = {
            sessionId: "trash-a",
            title: "Trash A",
            referencedBytes: 1024,
            confirmationToken: "opaque-token",
        };
        const { client, session } = renderRewindContent(
            makeRewindClient({
                listCheckpointStorageOwners: vi.fn(async () => ({ trashOwners: [owner] })),
            })
        );
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    quota: {
                        status: "referenced-over-quota",
                        usedBytes: 6 * 1024 ** 3,
                        softQuotaBytes: 5 * 1024 ** 3,
                        cleanupAvailable: true,
                    },
                }),
            });
        });

        fireEvent.click(screen.getByRole("button", { name: "Clean up unreferenced snapshots" }));
        await waitFor(() =>
            expect(client.cleanupWorkspaceCheckpoints).toHaveBeenCalledWith({ sessionMetadata: session })
        );
        expect(screen.getByTestId("quota-banner")).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Manage checkpoint storage" }));
        await waitFor(() => expect(screen.getByTestId("quota-dialog")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "trash-a" }));
        await waitFor(() =>
            expect(client.purgeTrashedSession).toHaveBeenCalledWith({
                sessionMetadata: session,
                trashedSessionId: "trash-a",
                confirmationToken: "opaque-token",
            })
        );
        expect(quotaDialogProps.latest.owners).toEqual([owner]);
        expect(Object.keys(client.purgeTrashedSession.mock.calls[0][0]).sort()).toEqual([
            "confirmationToken",
            "sessionMetadata",
            "trashedSessionId",
        ]);
    });

    it("blocks owner refresh while checkpoint cleanup is in flight", async () => {
        let finishCleanup = () => {};
        const cleanup = new Promise<AgentCleanupWorkspaceCheckpointsResult>((resolve) => {
            finishCleanup = () =>
                resolve({
                    removedUnownedBytes: 0,
                    quota: makeRewindState().quota,
                });
        });
        const { client } = renderRewindContent(
            makeRewindClient({
                cleanupWorkspaceCheckpoints: vi.fn(() => cleanup),
            })
        );
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    quota: {
                        status: "soft-quota-exceeded",
                        usedBytes: 6 * 1024 ** 3,
                        softQuotaBytes: 5 * 1024 ** 3,
                        cleanupAvailable: true,
                    },
                }),
            });
        });

        fireEvent.click(screen.getByRole("button", { name: "Clean up unreferenced snapshots" }));
        expect(quotaBannerProps.latest.busy).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Manage checkpoint storage" }));
        expect(client.listCheckpointStorageOwners).not.toHaveBeenCalled();
        await act(async () => quotaBannerProps.latest.onManage());
        expect(client.listCheckpointStorageOwners).not.toHaveBeenCalled();
        act(() => finishCleanup());
        await waitFor(() => expect(quotaBannerProps.latest.busy).toBe(false));
        fireEvent.click(screen.getByRole("button", { name: "Manage checkpoint storage" }));
        await waitFor(() => expect(client.listCheckpointStorageOwners).toHaveBeenCalledOnce());
    });

    it("serializes same-tick cleanup calls through the shared maintenance mutex", async () => {
        let finishCleanup = () => {};
        const cleanup = new Promise<AgentCleanupWorkspaceCheckpointsResult>((resolve) => {
            finishCleanup = () =>
                resolve({
                    removedUnownedBytes: 0,
                    quota: makeRewindState().quota,
                });
        });
        const { client } = renderRewindContent(
            makeRewindClient({
                cleanupWorkspaceCheckpoints: vi.fn(() => cleanup),
            })
        );
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    quota: {
                        status: "soft-quota-exceeded",
                        usedBytes: 6 * 1024 ** 3,
                        softQuotaBytes: 5 * 1024 ** 3,
                        cleanupAvailable: true,
                    },
                }),
            });
        });

        act(() => {
            void quotaBannerProps.latest.onCleanup();
            void quotaBannerProps.latest.onCleanup();
        });
        expect(client.cleanupWorkspaceCheckpoints).toHaveBeenCalledTimes(1);
        expect(quotaBannerProps.latest.busy).toBe(true);
        act(() => finishCleanup());
        await waitFor(() => expect(quotaBannerProps.latest.busy).toBe(false));
    });

    it("blocks every quota mutation while recovery is frozen, including stale callbacks", async () => {
        const owner: AgentCheckpointTrashOwnerView = {
            sessionId: "trash-a",
            title: "Trash A",
            referencedBytes: 1024,
            confirmationToken: "opaque-token",
        };
        const { client } = renderRewindContent(
            makeRewindClient({
                listCheckpointStorageOwners: vi.fn(async () => ({ trashOwners: [owner] })),
            })
        );
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    quota: {
                        status: "referenced-over-quota",
                        usedBytes: 6 * 1024 ** 3,
                        softQuotaBytes: 5 * 1024 ** 3,
                        cleanupAvailable: true,
                    },
                }),
            });
        });
        fireEvent.click(screen.getByRole("button", { name: "Manage checkpoint storage" }));
        await waitFor(() => expect(quotaDialogProps.latest.open).toBe(true));
        client.listCheckpointStorageOwners.mockClear();

        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    frozen: true,
                    quota: {
                        status: "referenced-over-quota",
                        usedBytes: 6 * 1024 ** 3,
                        softQuotaBytes: 5 * 1024 ** 3,
                        cleanupAvailable: true,
                    },
                }),
            });
        });
        expect(quotaBannerProps.latest.mutationsDisabled).toBe(true);
        expect(quotaDialogProps.latest.mutationsDisabled).toBe(true);

        await act(async () => {
            await quotaBannerProps.latest.onCleanup();
            await quotaBannerProps.latest.onManage();
            await quotaDialogProps.latest.onPurge({
                trashedSessionId: owner.sessionId,
                confirmationToken: owner.confirmationToken,
            });
        });
        expect(client.cleanupWorkspaceCheckpoints).not.toHaveBeenCalled();
        expect(client.listCheckpointStorageOwners).not.toHaveBeenCalled();
        expect(client.purgeTrashedSession).not.toHaveBeenCalled();
    });

    it("rejects quota callbacks retained from a previous session scope", async () => {
        const owner: AgentCheckpointTrashOwnerView = {
            sessionId: "trash-a",
            title: "Trash A",
            referencedBytes: 1024,
            confirmationToken: "opaque-token",
        };
        const { client, model } = renderRewindContent(
            makeRewindClient({
                listCheckpointStorageOwners: vi.fn(async () => ({ trashOwners: [owner] })),
            })
        );
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    quota: {
                        status: "referenced-over-quota",
                        usedBytes: 6 * 1024 ** 3,
                        softQuotaBytes: 5 * 1024 ** 3,
                        cleanupAvailable: true,
                    },
                }),
            });
        });
        fireEvent.click(screen.getByRole("button", { name: "Manage checkpoint storage" }));
        await waitFor(() => expect(quotaDialogProps.latest.open).toBe(true));
        const staleCleanup = quotaBannerProps.latest.onCleanup;
        const staleManage = quotaBannerProps.latest.onManage;
        const stalePurge = quotaDialogProps.latest.onPurge;
        const staleClose = quotaDialogProps.latest.onClose;
        client.cleanupWorkspaceCheckpoints.mockClear();
        client.listCheckpointStorageOwners.mockClear();

        act(() => model.selectSession({ id: "b", path: "/sessions/b.db", cwd: "/repo", createdAt: "later" }));
        await waitFor(() => expect(hostProps.latest.sessionMetadata?.path).toBe("/sessions/b.db"));
        await act(async () => {
            await staleCleanup();
            await staleManage();
            await stalePurge({
                trashedSessionId: owner.sessionId,
                confirmationToken: owner.confirmationToken,
            });
            staleClose();
        });
        expect(client.cleanupWorkspaceCheckpoints).not.toHaveBeenCalled();
        expect(client.listCheckpointStorageOwners).not.toHaveBeenCalled();
        expect(client.purgeTrashedSession).not.toHaveBeenCalled();

        await act(async () => quotaBannerProps.latest.onManage());
        expect(client.listCheckpointStorageOwners).toHaveBeenCalledOnce();
    });

    it("serializes purge and authoritative owner refresh without reviving stale tokens", async () => {
        const owner: AgentCheckpointTrashOwnerView = {
            sessionId: "trash-a",
            title: "Trash A",
            referencedBytes: 1024,
            confirmationToken: "opaque-token",
        };
        let finishPurge!: () => void;
        const purge = new Promise<AgentPurgeTrashedSessionResult>((resolve) => {
            finishPurge = () =>
                resolve({
                    purgedSessionId: owner.sessionId,
                    quota: makeRewindState().quota,
                });
        });
        const listOwners = vi
            .fn()
            .mockResolvedValueOnce({ trashOwners: [owner] })
            .mockResolvedValueOnce({ trashOwners: [] });
        const { client } = renderRewindContent(
            makeRewindClient({
                listCheckpointStorageOwners: listOwners,
                purgeTrashedSession: vi.fn(() => purge),
            })
        );
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    quota: {
                        status: "referenced-over-quota",
                        usedBytes: 6 * 1024 ** 3,
                        softQuotaBytes: 5 * 1024 ** 3,
                        cleanupAvailable: true,
                    },
                }),
            });
        });
        fireEvent.click(screen.getByRole("button", { name: "Manage checkpoint storage" }));
        await waitFor(() => expect(quotaDialogProps.latest.owners).toEqual([owner]));
        const request = {
            trashedSessionId: owner.sessionId,
            confirmationToken: owner.confirmationToken,
        };

        act(() => {
            void quotaDialogProps.latest.onPurge(request);
            void quotaDialogProps.latest.onPurge(request);
            quotaDialogProps.latest.onRefresh();
            quotaDialogProps.latest.onClose();
        });

        expect(client.purgeTrashedSession).toHaveBeenCalledTimes(1);
        expect(listOwners).toHaveBeenCalledTimes(1);
        expect(quotaDialogProps.latest.open).toBe(true);

        await act(async () => {
            finishPurge();
            await purge;
        });
        await waitFor(() => expect(listOwners).toHaveBeenCalledTimes(2));
        expect(quotaDialogProps.latest.owners).toEqual([]);
        expect(JSON.stringify(quotaDialogProps.latest.owners)).not.toContain("opaque-token");
    });

    it("prevents cleanup and purge from racing in either same-tick order", async () => {
        const owner: AgentCheckpointTrashOwnerView = {
            sessionId: "trash-a",
            title: "Trash A",
            referencedBytes: 1024,
            confirmationToken: "opaque-token",
        };
        let finishCleanup = () => {};
        const cleanup = new Promise<AgentCleanupWorkspaceCheckpointsResult>((resolve) => {
            finishCleanup = () => resolve({ removedUnownedBytes: 0, quota: makeRewindState().quota });
        });
        let finishPurge = () => {};
        const purge = new Promise<AgentPurgeTrashedSessionResult>((resolve) => {
            finishPurge = () => resolve({ purgedSessionId: owner.sessionId, quota: makeRewindState().quota });
        });
        const { client } = renderRewindContent(
            makeRewindClient({
                cleanupWorkspaceCheckpoints: vi.fn(() => cleanup),
                listCheckpointStorageOwners: vi
                    .fn()
                    .mockResolvedValueOnce({ trashOwners: [owner] })
                    .mockResolvedValueOnce({ trashOwners: [] }),
                purgeTrashedSession: vi.fn(() => purge),
            })
        );
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    quota: {
                        status: "referenced-over-quota",
                        usedBytes: 6 * 1024 ** 3,
                        softQuotaBytes: 5 * 1024 ** 3,
                        cleanupAvailable: true,
                    },
                }),
            });
        });
        await act(async () => quotaBannerProps.latest.onManage());
        const request = {
            trashedSessionId: owner.sessionId,
            confirmationToken: owner.confirmationToken,
        };

        act(() => {
            void quotaBannerProps.latest.onCleanup();
            void quotaDialogProps.latest.onPurge(request);
        });
        expect(client.cleanupWorkspaceCheckpoints).toHaveBeenCalledTimes(1);
        expect(client.purgeTrashedSession).not.toHaveBeenCalled();
        act(() => finishCleanup());
        await waitFor(() => expect(quotaBannerProps.latest.busy).toBe(false));

        act(() => {
            void quotaDialogProps.latest.onPurge(request);
            void quotaBannerProps.latest.onCleanup();
        });
        expect(client.purgeTrashedSession).toHaveBeenCalledTimes(1);
        expect(client.cleanupWorkspaceCheckpoints).toHaveBeenCalledTimes(1);
        act(() => finishPurge());
        await waitFor(() => expect(quotaBannerProps.latest.busy).toBe(false));
    });

    it("keeps a purge owner stale after purge and authoritative refresh both fail", async () => {
        const owner: AgentCheckpointTrashOwnerView = {
            sessionId: "trash-a",
            title: "Trash A",
            referencedBytes: 1024,
            confirmationToken: "opaque-token",
        };
        const listOwners = vi
            .fn()
            .mockResolvedValueOnce({ trashOwners: [owner] })
            .mockRejectedValueOnce(new Error("refresh failed"))
            .mockResolvedValueOnce({
                trashOwners: [{ ...owner, confirmationToken: "fresh-token" }],
            })
            .mockResolvedValueOnce({ trashOwners: [] });
        const { client } = renderRewindContent(
            makeRewindClient({
                listCheckpointStorageOwners: listOwners,
                purgeTrashedSession: vi.fn().mockRejectedValueOnce(new Error("purge failed")).mockResolvedValueOnce({
                    purgedSessionId: owner.sessionId,
                    quota: makeRewindState().quota,
                }),
            })
        );
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    quota: {
                        status: "referenced-over-quota",
                        usedBytes: 6 * 1024 ** 3,
                        softQuotaBytes: 5 * 1024 ** 3,
                        cleanupAvailable: true,
                    },
                }),
            });
        });
        fireEvent.click(screen.getByRole("button", { name: "Manage checkpoint storage" }));
        await waitFor(() => expect(quotaDialogProps.latest.owners).toEqual([owner]));
        const request = {
            trashedSessionId: owner.sessionId,
            confirmationToken: owner.confirmationToken,
        };

        await act(async () => quotaDialogProps.latest.onPurge(request));
        await waitFor(() => expect(quotaDialogProps.latest.phase).toBe("error"));
        expect(quotaDialogProps.latest.owners).toEqual([owner]);
        expect(quotaDialogProps.latest.staleOwnerIds).toEqual([owner.sessionId]);
        await act(async () => quotaDialogProps.latest.onPurge(request));
        expect(client.purgeTrashedSession).toHaveBeenCalledTimes(1);

        await act(async () => quotaDialogProps.latest.onRefresh());
        expect(quotaDialogProps.latest.staleOwnerIds).toEqual([]);
        expect(quotaDialogProps.latest.owners[0].confirmationToken).toBe("fresh-token");
        await act(async () =>
            quotaDialogProps.latest.onPurge({
                trashedSessionId: owner.sessionId,
                confirmationToken: "fresh-token",
            })
        );
        expect(client.purgeTrashedSession).toHaveBeenCalledTimes(2);
    });

    it("uses one rewind controller for message Revert and the slash selector path", async () => {
        const { client } = renderRewindContent();

        fireEvent.click(screen.getByRole("button", { name: "Message Revert" }));
        await waitFor(() =>
            expect(client.previewRewind).toHaveBeenCalledWith(
                expect.objectContaining({ target: { kind: "rewind", targetTurnId: "turn-a" } })
            )
        );
        await waitFor(() =>
            expect(screen.getByTestId("rewind-preview").textContent).toContain("Revert changes?:ready")
        );

        act(() => rewindDialogProps.latest.onOpenChange(false));
        act(() => {
            expect(hostProps.runtime.submit("/rewind")).toBe(true);
        });
        await waitFor(() => expect(screen.getByTestId("rewind-selector").textContent).toContain("Original prompt"));
        fireEvent.click(screen.getByRole("button", { name: "Original prompt" }));

        expect(client.previewRewind).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "Complete reveal" }));
        await waitFor(() => expect(client.previewRewind).toHaveBeenCalledTimes(2));
        expect(threadProps.latest.revealTurnRequest).toBeUndefined();
        await waitFor(() =>
            expect(screen.getByTestId("rewind-preview").textContent).toContain("Revert changes?:ready")
        );
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
        expect(rewindDialogProps.latest).not.toHaveProperty("description");
        fireEvent.click(screen.getByRole("button", { name: "Revert 1 file" }));
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
                        messages: ["Original prompt"],
                        messageCount: 2,
                        fileCount: 1,
                        files: [],
                    },
                }),
            });
        });

        vi.mocked(client.previewRewind).mockResolvedValueOnce(
            makePreview(
                { kind: "rewind", targetTurnId: "turn-a" },
                {
                    forceRequired: true,
                    coverageWarnings: ["checkpoint excluded a socket", "checkpoint excluded generated output"],
                    files: [
                        {
                            path: "src/drift.ts",
                            operation: "write",
                            coverage: "covered",
                            conflict: "forceable-drift",
                            reason: "files changed on disk since the agent last wrote them",
                        },
                    ],
                }
            )
        );
        await act(() => threadProps.latest.onRevertTurn("turn-a"));
        await waitFor(() => expect(screen.getByRole("button", { name: "Force revert" })).not.toBeNull());
        expect(screen.queryByText("checkpoint excluded a socket")).toBeNull();
        expect(screen.queryByText("checkpoint excluded generated output")).toBeNull();
        expect(screen.getAllByText("files changed on disk since the agent last wrote them")).toHaveLength(1);
        expect(screen.queryByRole("button", { name: "Revert 1 file" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Force revert" }));
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
                        messages: ["Original prompt"],
                        messageCount: 2,
                        fileCount: 1,
                        files: [],
                    },
                }),
            });
        });

        await act(() => threadProps.latest.onRevertTurn("turn-a"));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByTestId("rewind-preview")).toBeNull();
    });

    it("shows only Cancel for a hard-blocked conversation revert", async () => {
        const client = makeRewindClient({
            previewRewind: vi.fn(async () =>
                makePreview(
                    { kind: "rewind", targetTurnId: "turn-a" },
                    {
                        hardBlocked: true,
                        files: [
                            {
                                path: "src/blocked.ts",
                                operation: "write",
                                coverage: "unavailable",
                                conflict: "hard-blocker",
                                reason: "checkpoint snapshot is unavailable",
                            },
                        ],
                    }
                )
            ),
        });
        renderRewindContent(client);

        await act(() => threadProps.latest.onRevertTurn("turn-a"));

        expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
        expect(screen.queryByRole("button", { name: /^(Revert|Force revert|Redo)/ })).toBeNull();
    });

    it("never offers Force or Redo for a conversation redo with drift", async () => {
        const client = makeRewindClient({
            previewRewind: vi.fn(async () =>
                makePreview(
                    { kind: "redo" },
                    {
                        forceRequired: true,
                        files: [
                            {
                                path: "src/drift.ts",
                                operation: "write",
                                coverage: "covered",
                                conflict: "forceable-drift",
                                reason: "files changed on disk since the agent last wrote them",
                            },
                        ],
                    }
                )
            ),
        });
        renderRewindContent(client);
        act(() => {
            hostProps.latest.onStateChange({
                status: "idle",
                queuedMessages: [],
                commands: [],
                rewindState: makeRewindState({
                    redo: {
                        operationId: "operation-1",
                        messages: ["Original prompt"],
                        messageCount: 2,
                        fileCount: 1,
                        files: [],
                    },
                }),
            });
        });

        fireEvent.click(screen.getByRole("button", { name: "Redo" }));
        await waitFor(() => expect(screen.getByTestId("rewind-preview")).not.toBeNull());

        expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
        expect(screen.queryByRole("button", { name: /^(Force revert|Redo 1 file)$/ })).toBeNull();
    });

    it("restores authoritative redo above the composer, shares openRedo with /redo, and waits for session_state removal", async () => {
        const { client } = renderRewindContent();
        const redo: AgentRedoView = {
            operationId: "operation-1",
            messages: ["Original prompt"],
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
        const dockTitle = screen.getByText("Changes reverted");
        const dockSummary = screen.getByText("4 messages · 1 file");
        expect(
            !!(dockSummary.compareDocumentPosition(screen.getByLabelText("Prompt")) & Node.DOCUMENT_POSITION_FOLLOWING)
        ).toBe(true);

        fireEvent.click(screen.getByRole("button", { name: "Redo" }));
        await waitFor(() =>
            expect(client.previewRewind).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "redo" } }))
        );
        expect(screen.getByTestId("rewind-preview").textContent).toContain("Redo changes?:ready");
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        act(() => {
            expect(hostProps.runtime.submit("/redo")).toBe(true);
        });
        await waitFor(() => expect(client.previewRewind).toHaveBeenCalledTimes(2));
        fireEvent.click(screen.getByRole("button", { name: "Redo 1 file" }));
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
        expect(screen.queryByText("Changes reverted")).toBeNull();
        expect(screen.queryByText("4 messages · 1 file")).toBeNull();
        expect(thread.contains(dockTitle)).toBe(false);
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
                        messages: ["Session A prompt"],
                        messageCount: 2,
                        fileCount: 0,
                        files: [],
                    },
                }),
            });
        });
        expect(screen.getByText("Changes reverted")).not.toBeNull();
        expect(screen.getByText("2 messages · 0 files")).not.toBeNull();

        act(() => model.selectSession({ id: "b", path: "/sessions/b.db", cwd: "/repo", createdAt: "later" }));

        expect(screen.queryByText("Changes reverted")).toBeNull();
        expect(screen.queryByText("2 messages · 0 files")).toBeNull();
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
