// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ContextReferenceRendererState } from "@/app/store/context-references";
import type { PiAgentMessage, PiTurn } from "@/app/store/use-pi-chat";
import type { XtermPaneModel } from "@/app/xterm/xterm-pane-model";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { atom } from "jotai";
import { readFileSync } from "node:fs";
import { useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatHostApi, AgentChatHostProps, AgentHostState } from "./agent-chat-host";
import type { ContextReferenceBarProps, ThreadProps } from "./assistant-ui";
import { createCrestAssistantRuntimeAdapter, type CrestAssistantRuntimeBridge } from "./assistant-ui/runtime-bridge";

const captured = vi.hoisted(() => ({
    onTurnsChange: null as ((turns: PiTurn[]) => void) | null,
    sessionSelectorProps: null as { onUserMessage?: (message: string) => void; referencesEnabled?: boolean } | null,
    hostProps: null as AgentChatHostProps | null,
    referenceBarProps: null as ContextReferenceBarProps | null,
    threadProps: null as ThreadProps | null,
    runtimeSource: null as Record<string, unknown> | null,
    userConfigState: { config: {} as Record<string, unknown> | null, status: "ok", error: null },
    composerState: {
        text: "draft text",
        quote: undefined as { text: string; messageId: string } | undefined,
        attachments: [
            {
                id: "image-1",
                type: "image",
                name: "preview.png",
                status: { type: "complete" },
                content: [{ type: "image", image: "data:image/png;base64,preview" }],
            },
        ],
    },
    persistedSession: null as AgentSessionMeta | null,
    exposeHostApi: true,
    autoHostStates: {} as Record<string, AgentHostState | undefined>,
    lastAutoHostState: null as AgentHostState | null,
    setComposerText: vi.fn(),
    globalSet: vi.fn(),
    hostApi: {
        submit: vi.fn(),
        abort: vi.fn(),
        discardContextDraft: vi.fn(),
        summarizeContextDraft: vi.fn(),
        retryContextSend: vi.fn(),
    },
}));

vi.mock("@/app/store/ai-catalog", () => ({ CATALOG: [] }));
vi.mock("@/app/store/ai-provider-models", () => ({ providerModelsMapAtom: { read: () => ({}) } }));
vi.mock("@/app/store/ai-resolver", () => ({
    resolveAIConfig: () => ({ ok: false, error: { code: "x", message: "x" } }),
}));
vi.mock("@/app/store/ai-user-config", () => ({
    aiUserConfigAtom: { read: () => captured.userConfigState },
}));
vi.mock("@/app/store/jotaiStore", () => ({ globalStore: { set: captured.globalSet } }));
vi.mock("@/app/store/modalmodel", () => ({ modalsModel: { pushModal: vi.fn() } }));
vi.mock("@/app/store/services", () => ({ ObjectService: { UpdateObjectMeta: vi.fn() } }));
vi.mock("@/app/view/cmdblock/cmdblock-input", () => ({ CmdBlockInput: () => <div data-testid="cmd-input" /> }));
vi.mock("@/app/view/cmdblock/model-picker-popover", () => ({
    ModelPickerInline: () => <div data-testid="model-picker-inline" />,
}));
vi.mock("@/app/view/cmdblock/session-selector", () => ({
    SessionSelector: (props: { onUserMessage?: (message: string) => void; referencesEnabled?: boolean }) => {
        captured.sessionSelectorProps = props;
        return <div data-testid="session-selector" />;
    },
}));
vi.mock("./agent-chat-host", () => ({
    AgentChatHost: (props: AgentChatHostProps) => {
        captured.hostProps = props;
        const autoState = props.sessionMetadata?.path ? captured.autoHostStates[props.sessionMetadata.path] : undefined;
        useEffect(() => {
            if (captured.exposeHostApi) {
                props.onReady?.(captured.hostApi as unknown as AgentChatHostApi);
            }
        }, [props.onReady]);
        useEffect(() => {
            if (autoState && autoState !== captured.lastAutoHostState) {
                captured.lastAutoHostState = autoState;
                props.onStateChange?.(autoState);
            }
        }, [autoState, props.onStateChange]);
        captured.onTurnsChange = props.onTurnsChange ?? null;
        return <div data-testid="agent-chat-host" />;
    },
}));
vi.mock("./agent-command-result", () => ({ AgentCommandResultList: () => <div data-testid="agent-cmd-results" /> }));
vi.mock("./assistant-ui", () => ({
    AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="assistant-runtime-provider">{children}</div>
    ),
    ContextReferenceBar: (props: ContextReferenceBarProps) => {
        captured.referenceBarProps = props;
        return <div data-testid="context-reference-bar" />;
    },
    Thread: (props: ThreadProps) => {
        captured.threadProps = props;
        return (
            <div data-testid="crest-thread">
                {props.beforeComposer}
                {props.modelLabel}
            </div>
        );
    },
    useAui: () => ({ composer: () => ({ setText: captured.setComposerText }) }),
    useCrestAssistantRuntime: (source: Record<string, unknown>) => {
        captured.runtimeSource = source;
        return { runtime: true };
    },
}));
vi.mock("@assistant-ui/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@assistant-ui/react")>();
    return {
        ...actual,
        useAuiState: (selector: (state: unknown) => unknown) =>
            selector({
                composer: captured.composerState,
            }),
    };
});
vi.mock("jotai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("jotai")>();
    return {
        ...actual,
        useAtomValue: (a: { read?: (...args: any[]) => unknown }) => {
            if (typeof a?.read !== "function") return undefined;
            try {
                return actual.getDefaultStore().get(a as any);
            } catch {
                return a.read();
            }
        },
    };
});
vi.mock("@/store/global", () => ({
    useOrefMetaKeyAtom: (_oref: unknown, key: string) => (key === "agent:session" ? captured.persistedSession : null),
    WOS: { makeORef: (type: string, id: string) => ({ type, id }) },
}));

import {
    AgentQueuedMessagesPanel,
    WorkspaceAgentSurface,
    agentContextSendGuidance,
    getAgentQueuedMessageText,
    getLatestAgentContextUsage,
    getNextAgentAttachedPanelState,
    hasActiveAgentAttachedPanel,
    makeEmptyAgentAttachedPanelState,
    mapPiUsageToContextUsage,
    type AgentSurfaceContext,
} from "./agent-surface";

afterEach(() => {
    cleanup();
    captured.hostProps = null;
    captured.referenceBarProps = null;
    captured.threadProps = null;
    captured.runtimeSource = null;
    captured.persistedSession = null;
    captured.exposeHostApi = true;
    captured.autoHostStates = {};
    captured.lastAutoHostState = null;
    captured.composerState.text = "draft text";
    captured.composerState.quote = undefined;
    captured.composerState.attachments = [
        {
            id: "image-1",
            type: "image",
            name: "preview.png",
            status: { type: "complete" },
            content: [{ type: "image", image: "data:image/png;base64,preview" }],
        },
    ];
    captured.setComposerText.mockClear();
    captured.userConfigState.config = {};
    captured.userConfigState.status = "ok";
    for (const fn of Object.values(captured.hostApi)) {
        if (typeof fn === "function" && "mockClear" in fn) {
            (fn as ReturnType<typeof vi.fn>).mockClear();
        }
    }
});

function contextState(overrides: Partial<ContextReferenceRendererState> = {}): ContextReferenceRendererState {
    return {
        targetSessionPath: captured.persistedSession?.path,
        targetGeneration: 0,
        drafts: [],
        reportsByTurn: {},
        sendCapturesById: {},
        enabled: true,
        ...overrides,
    };
}

function draftReference(): ContextReferenceRendererState["drafts"][number] {
    return {
        view: {
            draftId: "draft-1",
            targetSessionPath: "/target.jsonl",
            summaryStatus: "none",
            expiresAt: "2026-07-24T00:00:00.000Z",
            provenance: {
                sourceKind: "turn",
                sourceSessionId: "source",
                sourceSessionPath: "/source.jsonl",
                sourceCwd: "/x",
                sourceTurnId: "turn-1",
                sourceLeafId: "leaf-1",
                sourceMessageEntryIds: ["message-1"],
                preview: "source preview",
                capturedAt: "2026-07-23T00:00:00.000Z",
            },
        },
        deliveryScope: "message",
        requestedRepresentation: "full",
        status: "ready",
    };
}

describe("Agent surface context", () => {
    it("uses a direct workspace surface with only consumed context", () => {
        const source = readFileSync("frontend/app/term/render/agent-surface.tsx", "utf8");
        const context = source.match(/export interface AgentSurfaceContext \{([\s\S]*?)\n\}/)?.[1] ?? "";
        expect(source).toContain("export function WorkspaceAgentSurface");
        expect(source).not.toContain("export interface AgentSlot");
        expect(source).not.toContain("children: (slot:");
        expect(context).toContain("workspaceDir: string");
        expect(context).toContain("liveGitBranch?: string");
        expect(context).toContain("recentCmds: string[]");
        expect(context).toContain("liveConnection: string");
        expect(context).toContain("inAltScreen: boolean");
        expect(context).not.toContain("fontSize:");
        expect(context).not.toContain("commandHistory:");
        expect(context).not.toContain("onModeChange:");
    });
});

type AgentSurfaceModel = Pick<XtermPaneModel, "notificationAtom">;

function fakeModel(): AgentSurfaceModel {
    return {
        notificationAtom: atom(""),
    };
}

const model = fakeModel() as XtermPaneModel;

const context: AgentSurfaceContext = {
    workspaceDir: "/x",
    recentCmds: [],
    liveConnection: "",
    inAltScreen: false,
};

describe("WorkspaceAgentSurface", () => {
    it("persists selector success messages in the terminal notification atom", () => {
        const model = fakeModel() as XtermPaneModel;
        captured.globalSet.mockClear();
        renderToStaticMarkup(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);

        captured.sessionSelectorProps?.onUserMessage?.("Reference added");

        expect(captured.globalSet).toHaveBeenCalledWith(model.notificationAtom, "Reference added");
    });

    it("keeps command attached panels mutually exclusive", () => {
        const commandResult = {
            command: "info",
            status: "success",
            message: "Session switched.",
        } as const;
        const treeRequest = {
            type: "tree",
            listTree: vi.fn(),
            navigateTree: vi.fn(),
        } as any;
        const resumeRequest = {
            type: "resume",
            cwd: "/x",
            listSessions: vi.fn(),
            resumeSession: vi.fn(),
        } as any;

        let state = makeEmptyAgentAttachedPanelState();
        state = getNextAgentAttachedPanelState(state, { type: "showCommandResult", result: commandResult });
        expect(state.commandResults).toEqual([commandResult]);
        expect(state.selectorRequest).toBeNull();
        expect(state.modelPickerOpen).toBe(false);
        expect(hasActiveAgentAttachedPanel(state)).toBe(true);

        state = getNextAgentAttachedPanelState(state, { type: "openSelector", request: treeRequest });
        expect(state.commandResults).toEqual([]);
        expect(state.selectorRequest).toBe(treeRequest);
        expect(state.modelPickerOpen).toBe(false);
        expect(hasActiveAgentAttachedPanel(state)).toBe(true);

        state = getNextAgentAttachedPanelState(state, { type: "openModelPicker" });
        expect(state.commandResults).toEqual([]);
        expect(state.selectorRequest).toBeNull();
        expect(state.modelPickerOpen).toBe(true);
        expect(hasActiveAgentAttachedPanel(state)).toBe(true);

        state = getNextAgentAttachedPanelState(state, { type: "openSelector", request: resumeRequest });
        expect(state.commandResults).toEqual([]);
        expect(state.selectorRequest).toBe(resumeRequest);
        expect(state.modelPickerOpen).toBe(false);

        state = getNextAgentAttachedPanelState(state, { type: "showCommandResult", result: commandResult });
        expect(state.commandResults).toEqual([commandResult]);
        expect(state.selectorRequest).toBeNull();
        expect(state.modelPickerOpen).toBe(false);
    });

    it("does not hide scroll to bottom when no command attached panel is open", () => {
        expect(hasActiveAgentAttachedPanel(makeEmptyAgentAttachedPanelState())).toBe(false);
    });

    it("maps Pi usage into local context ring usage", () => {
        expect(
            mapPiUsageToContextUsage({
                input: 100,
                output: 20,
                cacheRead: 5,
                cacheWrite: 1,
                totalTokens: 126,
            })
        ).toEqual({
            inputTokens: 100,
            outputTokens: 20,
            cachedInputTokens: 6,
            totalTokens: 126,
        });
    });

    it("uses the latest assistant usage from Pi turns for the context ring", () => {
        const turns = [
            {
                turnId: "turn-1",
                responseMessages: [
                    {
                        role: "assistant",
                        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
                    },
                ],
                status: "done",
            },
            {
                turnId: "turn-2",
                responseMessages: [
                    {
                        role: "assistant",
                        usage: { input: 80, output: 15, cacheRead: 5, cacheWrite: 0, totalTokens: 100 },
                    },
                ],
                status: "done",
            },
        ] as PiTurn[];

        expect(getLatestAgentContextUsage(turns)).toEqual({
            inputTokens: 80,
            outputTokens: 15,
            cachedInputTokens: 5,
            totalTokens: 100,
        });
    });

    it("renders the full assistant-ui surface without the legacy activity bar", () => {
        const model = fakeModel() as XtermPaneModel;
        const html = renderToStaticMarkup(
            <WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />
        );
        expect(html).toContain('data-testid="agent-chat-host"');
        expect(html).toContain('data-testid="assistant-runtime-provider"');
        expect(html).toContain('data-testid="crest-thread"');
        expect(html).not.toContain('data-testid="agent-activity-bar"');
        expect(html).not.toContain('data-testid="cmd-input"');
        expect(html).toContain('data-testid="session-selector"');
        expect(html).toContain('data-testid="agent-cmd-results"');
        expect(html).toContain('data-testid="model-picker-inline"');
    });

    it("renders one context bar before command results and delegates actions to the current host API", async () => {
        render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        const state = contextState({
            drafts: [draftReference()],
        });

        act(() => {
            captured.hostProps?.onStateChange?.({
                status: "idle",
                queuedMessages: [],
                context: state,
            });
        });

        expect(screen.getAllByTestId("context-reference-bar")).toHaveLength(1);
        const threadHtml = screen.getByTestId("crest-thread").innerHTML;
        expect(threadHtml.indexOf("context-reference-bar")).toBeLessThan(threadHtml.indexOf("agent-cmd-results"));
        await captured.referenceBarProps?.onSummarizeDraft("draft-1");
        await captured.referenceBarProps?.onDiscardDraft("draft-1");

        expect(captured.hostApi.summarizeContextDraft).toHaveBeenCalledWith("draft-1");
        expect(captured.hostApi.discardContextDraft).toHaveBeenCalledWith("draft-1");
    });

    it("keeps recovery retry authoritative and exposes no bypass callback", async () => {
        render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        act(() => {
            captured.hostProps?.onStateChange?.({
                status: "error",
                queuedMessages: [],
                context: contextState({ drafts: [draftReference()] }),
                contextSendRecovery: {
                    text: "exact request",
                    draftIds: ["draft-1"],
                    errorMessage: "References exceed the context window",
                },
            });
        });

        expect(captured.referenceBarProps?.recovery).toEqual({
            errorMessage: "References exceed the context window",
        });
        await captured.referenceBarProps?.onRetrySend();
        expect(captured.hostApi.retryContextSend).toHaveBeenCalledOnce();
        expect(captured.referenceBarProps).not.toHaveProperty("onBypassSend");
    });

    it("replaces rendered drafts when authoritative session hydration changes", () => {
        render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        act(() => {
            captured.hostProps?.onStateChange?.({
                status: "idle",
                queuedMessages: [],
                context: contextState({ drafts: [draftReference()] }),
            });
        });
        expect(captured.referenceBarProps?.drafts).toHaveLength(1);

        act(() => {
            captured.hostProps?.onStateChange?.({
                status: "idle",
                queuedMessages: [],
                context: contextState({
                    targetGeneration: 1,
                    drafts: [],
                }),
            });
        });
        expect(screen.queryByTestId("context-reference-bar")).toBeNull();
    });

    it("restores rejected composer text exactly through the assistant runtime", () => {
        render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);

        act(() => {
            captured.hostProps?.onRestoreComposerText?.("  preserve me exactly  ");
        });

        expect(captured.setComposerText).toHaveBeenCalledWith("  preserve me exactly  ");
    });

    it("consumes a restore once and does not replay it after user edits or an alt-screen roundtrip", () => {
        captured.persistedSession = {
            id: "session-a",
            path: "/session-a.jsonl",
            cwd: "/x",
            createdAt: "now",
        };
        const view = render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        act(() => {
            captured.hostProps?.onRestoreComposerText?.("failed text");
        });
        expect(captured.setComposerText).toHaveBeenCalledTimes(1);

        captured.composerState.text = "user replacement";
        view.rerender(
            <WorkspaceAgentSurface outerBlockId="outer" model={model} context={{ ...context, inAltScreen: true }} />
        );
        view.rerender(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);

        expect(captured.setComposerText).toHaveBeenCalledTimes(1);
    });

    it("defers an alt-screen restore once in the same session and drops it after a session switch", () => {
        captured.persistedSession = {
            id: "session-a",
            path: "/session-a.jsonl",
            cwd: "/x",
            createdAt: "now",
        };
        const view = render(
            <WorkspaceAgentSurface outerBlockId="outer" model={model} context={{ ...context, inAltScreen: true }} />
        );
        act(() => {
            captured.hostProps?.onRestoreComposerText?.("deferred in alt");
        });
        expect(captured.setComposerText).not.toHaveBeenCalled();

        view.rerender(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        expect(captured.setComposerText).toHaveBeenCalledOnce();

        view.rerender(
            <WorkspaceAgentSurface outerBlockId="outer" model={model} context={{ ...context, inAltScreen: true }} />
        );
        act(() => {
            captured.hostProps?.onRestoreComposerText?.("stale session text");
        });
        captured.persistedSession = {
            id: "session-b",
            path: "/session-b.jsonl",
            cwd: "/x",
            createdAt: "later",
        };
        view.rerender(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);

        expect(captured.setComposerText).toHaveBeenCalledTimes(1);
    });

    it("rejects submit and restores cleared text when the host API is not ready", async () => {
        captured.exposeHostApi = false;
        render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        const adapter = createCrestAssistantRuntimeAdapter(
            captured.runtimeSource as unknown as CrestAssistantRuntimeBridge
        );
        const submitted = adapter.onNew({
            role: "user",
            content: [{ type: "text", text: "already cleared by composer" }],
            parentId: null,
            sourceId: null,
            runConfig: undefined,
            metadata: { custom: {} },
            attachments: [],
            createdAt: new Date(0),
        } as any);

        await expect(submitted).resolves.toBeUndefined();
        await waitFor(() => {
            expect(captured.setComposerText).toHaveBeenCalledWith("already cleared by composer");
        });
        expect(captured.setComposerText).toHaveBeenCalledOnce();
    });

    it("does not pass a live composer preview to the chat host", async () => {
        render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);

        await waitFor(() => expect(captured.hostProps).toBeDefined());
        expect(captured.hostProps).not.toHaveProperty("contextPreview");
    });

    it("does not surface quote changes as a context preview", async () => {
        captured.composerState.quote = {
            text: "quoted\ncontext",
            messageId: "assistant-source",
        };
        render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);

        await waitFor(() => expect(captured.hostProps).toBeDefined());
        expect(captured.hostProps).not.toHaveProperty("contextPreview");
    });

    it("does not gate runtime send on context budget state", async () => {
        render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        act(() => {
            captured.hostProps?.onStateChange?.({
                status: "idle",
                queuedMessages: [],
                context: contextState({ drafts: [draftReference()] }),
            });
        });
        expect(captured.runtimeSource?.isSendDisabled).toBe(false);

        await waitFor(() => expect(captured.runtimeSource?.isSendDisabled).toBe(false));
    });

    it("keeps hydrated references read-only when config is disabled without exposing new reference controls", () => {
        captured.userConfigState.config = { context_references: { enabled: false } };
        const view = render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        act(() => {
            captured.hostProps?.onStateChange?.({
                status: "idle",
                queuedMessages: [],
                context: contextState({ drafts: [draftReference()] }),
            });
        });

        expect(screen.getByTestId("context-reference-bar")).toBeTruthy();
        expect(captured.referenceBarProps?.readOnly).toBe(true);
        expect(captured.sessionSelectorProps?.referencesEnabled).toBe(false);
        expect(captured.hostProps?.contextReferencesEnabled).toBe(false);
        expect(captured.runtimeSource?.isSendDisabled).toBe(true);

        captured.userConfigState.config = { context_references: { enabled: true } };
        view.rerender(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        expect(screen.getByTestId("context-reference-bar")).toBeTruthy();
        expect(captured.referenceBarProps?.drafts).toHaveLength(1);
    });

    it("hides old-session chips and gates send until the new session hydrates without invoking old callbacks", async () => {
        const sessionA: AgentSessionMeta = {
            id: "session-a",
            path: "/session-a.jsonl",
            cwd: "/x",
            createdAt: "now",
        };
        const sessionB: AgentSessionMeta = {
            id: "session-b",
            path: "/session-b.jsonl",
            cwd: "/x",
            createdAt: "later",
        };
        const stateA: AgentHostState = {
            status: "idle",
            queuedMessages: [],
            context: contextState({
                targetSessionPath: sessionA.path,
                drafts: [draftReference()],
            }),
        };
        const stateB: AgentHostState = {
            status: "idle",
            queuedMessages: [],
            context: contextState({
                targetSessionPath: sessionB.path,
                targetGeneration: 1,
                drafts: [{ ...draftReference(), view: { ...draftReference().view, draftId: "draft-b" } }],
            }),
        };
        captured.persistedSession = sessionA;
        captured.autoHostStates = { [sessionA.path]: stateA };
        const view = render(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        await waitFor(() => expect(captured.referenceBarProps?.drafts[0]?.view.draftId).toBe("draft-1"));
        const discardFromSessionA = captured.referenceBarProps?.onDiscardDraft;

        captured.persistedSession = sessionB;
        view.rerender(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        expect(screen.queryByTestId("context-reference-bar")).toBeNull();
        expect(captured.runtimeSource?.isSendDisabled).toBe(true);
        expect(screen.getByText(/context for the selected session is loading/i)).toBeTruthy();
        await expect(discardFromSessionA?.("draft-1")).rejects.toThrow(/still loading/i);
        expect(captured.hostApi.discardContextDraft).not.toHaveBeenCalled();

        captured.autoHostStates = { [sessionB.path]: stateB };
        view.rerender(<WorkspaceAgentSurface outerBlockId="outer" model={model} context={context} />);
        await waitFor(() => expect(captured.referenceBarProps?.drafts[0]?.view.draftId).toBe("draft-b"));
        expect(screen.getByTestId("context-reference-bar")).toBeTruthy();
        await expect(discardFromSessionA?.("draft-1")).rejects.toThrow(/no longer current/i);
        expect(captured.hostApi.discardContextDraft).not.toHaveBeenCalled();
    });

    it("omits the thread in alt-screen", () => {
        const html = renderToStaticMarkup(
            <WorkspaceAgentSurface outerBlockId="outer" model={model} context={{ ...context, inAltScreen: true }} />
        );
        expect(html).toContain('data-testid="agent-chat-host"');
        expect(html).not.toContain('data-testid="agent-cmd-results"');
        expect(html).not.toContain('data-testid="cmd-input"');
        expect(html).not.toContain('data-testid="agent-activity-bar"');
        expect(html).not.toContain('data-testid="context-reference-bar"');
    });

    it("extracts concise text for queued user messages", () => {
        expect(
            getAgentQueuedMessageText({
                role: "user",
                content: [
                    { type: "text", text: "first" },
                    { type: "text", text: "second" },
                ],
            } as PiAgentMessage)
        ).toBe("first second");
    });

    it("renders a collapsible queued message panel without explanatory filler", () => {
        const html = renderToStaticMarkup(
            <AgentQueuedMessagesPanel
                messages={
                    [
                        { role: "user", content: [{ type: "text", text: "接下来接进 composer" }] },
                        { role: "user", content: [{ type: "text", text: "再补一个测试" }] },
                    ] as PiAgentMessage[]
                }
            />
        );

        expect(html).toContain("<details");
        expect(html).toContain("aui-agent-queue-panel");
        expect(html).toContain("2 queued");
        expect(html).toContain("01");
        expect(html).toContain("02");
        expect(html).toContain("接下来接进 composer");
        expect(html).toContain("再补一个测试");
        expect(html).not.toContain("FIFO");
        expect(html).not.toContain("follow-up");
        expect(html).not.toContain("current run");
    });

    it("does not render a queued message panel when the queue is empty", () => {
        const html = renderToStaticMarkup(<AgentQueuedMessagesPanel messages={[]} />);

        expect(html).not.toContain("aui-agent-queue-panel");
    });
});

describe("agent context guidance", () => {
    it.each([
        ["summary_not_ready", /summary/i],
        ["references_sending", /sending/i],
    ] as const)("provides specific guidance for %s", (reason, expected) => {
        expect(agentContextSendGuidance(reason)).toMatch(expected);
    });
});
