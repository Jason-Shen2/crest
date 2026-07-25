// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentChatHost owns the React hook lifecycle for the active Agent
// session and mirrors the main-owned turns into WorkspaceAgentSurface's assistant-ui
// runtime.
//
// Replaces the pre-pi version which mounted @ai-sdk/react useChat and
// translated UIMessage parts into ai-sdk's WaveUIDataToolUse shape
// via TerminalModel.applyAgentParts. Post-pi: messages live in
// usePiChat state, and WorkspaceAgentSurface bridges those turns into assistant-ui.
//
// Returns null — purely a state-bridge component. UI lives in WorkspaceAgentSurface.

import { useEffect, useRef } from "react";

import type { ResolveError } from "@/app/store/ai-types";
import {
    contextTargetIdentity,
    type ContextReferenceRendererState,
    type ContextReferenceTargetIdentity,
} from "@/app/store/context-references";
import {
    composerRestoreTextFromSendError,
    usePiChat,
    type ContextSendRecovery,
    type PiAgentMessage,
    type PiTurn,
    type UsePiChatModel,
    type UsePiChatPaneContext,
    type UsePiChatReturn,
    type UsePiChatStatus,
} from "@/app/store/use-pi-chat";
import { resolveAgentSlashCommandRoute, type AgentSlashCommandName } from "./agent-slash-command-routing";

export interface AgentChatHostProps {
    outerBlockId: string;
    /** Persisted session metadata from block.meta["agent:session"]. Undefined → first send mints one. */
    sessionMetadata?: AgentSessionMeta;
    /** Called once when usePiChat receives the new metadata after first send. */
    onSessionMinted?: (meta: AgentSessionMeta) => void;
    /** Resolved model selection (provider/model/reasoning) from the picker + resolver. */
    modelSelection?: UsePiChatModel;
    /** Pane context (cwd / git / recent cmds / connection) fed into the system prompt. */
    paneContext: UsePiChatPaneContext;
    /**
     * When the model selection failed to resolve (no API key, unknown model,
     * etc.), this carries the structured error so submit attempts can be
     * routed to an inline error block instead of silently dropped.
     */
    selectionError?: ResolveError | null;
    /** Wired once with a send fn the input bar can call. Mirrors the previous useChat host's pattern. */
    onReady?: (api: AgentChatHostApi) => void;
    /** Called on every turns change so WorkspaceAgentSurface can feed assistant-ui. */
    onTurnsChange?: (turns: PiTurn[]) => void;
    /**
     * Called when the agent's live status or pending queue changes. Drives the
     * activity bar above the input (streaming indicator + Stop + queued chips).
     */
    onStateChange?: (state: AgentHostState) => void;
    /** Per-pane tool allowlist; undefined = main defaults to allowAll (v1). */
    allowedTools?: string[];
    /** Notification atom setter — surface user-facing errors when send can't proceed. */
    onUserError?: (message: string) => void;
    /** Pi-style inline command result feedback for immediate slash commands. */
    onCommandResult?: (result: AgentInlineCommandResult) => void;
    /** Opens the real model picker owned by the input component. */
    onOpenModelPicker?: () => void;
    /** Selector-first command path for /tree, /fork, and /session. */
    onSelectorRequest?: (request: AgentSelectorRequest) => void;
    /** Restores the exact submitted text after an async send failure. */
    onRestoreComposerText?: (text: string) => void;
    /** Renderer config gate; state remains hydrated while context-reference mutations are disabled. */
    contextReferencesEnabled?: boolean;
}

/** Reactive agent state surfaced to the parent for the activity bar. */
export interface AgentHostState {
    status: UsePiChatStatus;
    /** Messages queued behind the current run (ordered steer-first). */
    queuedMessages: PiAgentMessage[];
    context: ContextReferenceRendererState;
    contextSendRecovery?: ContextSendRecovery;
}

export type AgentChatHostContextApi = Pick<
    UsePiChatReturn,
    "prepareContextDraft" | "discardContextDraft" | "summarizeContextDraft" | "retryContextSend"
>;

/** Functions exposed via onReady for the input bar / parent. */
export interface AgentChatHostApi extends AgentChatHostContextApi {
    /** Route agent slash commands, otherwise send a user prompt. */
    submit: (text: string, images?: string[]) => boolean | Promise<boolean>;
    /** Send a user prompt. Idempotent if called twice with the same text — pi will queue. */
    send: (text: string, images?: string[]) => Promise<boolean>;
    /** List the current session tree for selector UI. */
    listTree: () => Promise<AgentTreeResult>;
    /** List forkable user-message points for selector UI. */
    listForkPoints: () => Promise<AgentForkPointView[]>;
    /** Navigate to a selected tree entry. */
    navigateTree: (targetId: string) => Promise<AgentNavigateTreeResult>;
    /** Fork from a selected entry. */
    forkSession: (entryId: string) => Promise<AgentForkSessionResult>;
    /** Clone the current branch immediately. */
    cloneSession: () => Promise<AgentCloneSessionResult>;
    /** Abort the in-flight run, if any. */
    abort: () => void;
    /** Current turns for diagnostics / future selectors. */
    getTurns: () => PiTurn[];
}

export type AgentSelectorRequest =
    | {
          type: "tree";
          listTree: () => Promise<AgentTreeResult>;
          navigateTree: (targetId: string) => Promise<AgentNavigateTreeResult>;
          prepareTurnReference: (
              targetId: string,
              requestedRepresentation: AgentContextRepresentation
          ) => Promise<void>;
      }
    | {
          type: "fork";
          listForkPoints: () => Promise<AgentForkPointView[]>;
          forkSession: (entryId: string) => Promise<AgentForkSessionResult>;
      }
    | {
          type: "session";
          cwd: string;
          currentSessionPath?: string;
          listSessions: (cwd?: string) => Promise<AgentSessionDetail[]>;
          resumeSession: (sessionMetadata: AgentSessionMeta) => Promise<AgentNavigateTreeResult>;
          listReferencePoints: (source: AgentSessionMeta) => Promise<AgentReferencePointView[]>;
          getAddedTurnIds: (source: AgentSessionMeta) => ReadonlySet<string>;
          prepareSessionReference: (
              source: AgentSessionMeta,
              deliveryScope: AgentContextDeliveryScope,
              requestedRepresentation: AgentContextRepresentation
          ) => Promise<void>;
          prepareTurnReference: (
              source: AgentSessionMeta,
              turnId: string,
              deliveryScope: AgentContextDeliveryScope,
              requestedRepresentation: AgentContextRepresentation
          ) => Promise<void>;
      };

export interface AgentCommandExecutionResult {
    status?: "success" | "noop";
    message?: string;
    sessionMetadata?: AgentSessionMeta;
}

type AgentImmediateCommandName = Exclude<
    AgentSlashCommandName,
    "tree" | "fork" | "clone" | "model" | "session" | "resume"
>;

export interface AgentInlineCommandResult {
    command: AgentImmediateCommandName;
    status: "success" | "noop";
    message: string;
    sessionMetadata?: AgentSessionMeta;
}

interface AgentChatHostApiDeps {
    sendPrompt: (text: string, images?: string[]) => boolean | Promise<boolean>;
    abort: () => void;
    getTurns: () => PiTurn[];
    getRuntimeApi: () => AgentRuntimeApi | undefined;
    getSessionMetadata: () => AgentSessionMeta | undefined;
    getContextState?: () => ContextReferenceRendererState;
    getContextTargetIdentity?: () => ContextReferenceTargetIdentity;
    getPaneCwd: () => string;
    /** Parent terminal block ID, used by backend commands that need pane identity. */
    getBlockId: () => string;
    runCommand?: (command: AgentImmediateCommandName, argsText: string) => Promise<AgentCommandExecutionResult>;
    onSessionMinted?: (meta: AgentSessionMeta) => void;
    onCommandResult?: (result: AgentInlineCommandResult) => void;
    onUserError?: (message: string) => void;
    onOpenModelPicker?: () => void;
    onSelectorRequest?: (request: AgentSelectorRequest) => void;
    onRestoreComposerText?: (text: string) => void;
    context?: AgentChatHostContextApi;
}

export function createAgentChatHostApi(deps: AgentChatHostApiDeps): AgentChatHostApi {
    const requireRuntimeApi = (): AgentRuntimeApi => {
        const runtimeApi = deps.getRuntimeApi();
        if (!runtimeApi) {
            throw new Error("Electron agent IPC not available (window.api.agent missing)");
        }
        return runtimeApi;
    };
    const requireSessionMetadata = (): AgentSessionMeta => {
        const sessionMetadata = deps.getSessionMetadata();
        if (!sessionMetadata?.path) {
            throw new Error("No agent session yet. Send a prompt before using session commands.");
        }
        return sessionMetadata;
    };
    const listTree = async (): Promise<AgentTreeResult> => {
        return await requireRuntimeApi().listTree(requireSessionMetadata());
    };
    const listForkPoints = async (): Promise<AgentForkPointView[]> => {
        return await requireRuntimeApi().listForkPoints(requireSessionMetadata());
    };
    const listSessions = async (cwd?: string): Promise<AgentSessionDetail[]> => {
        const runtimeApi = requireRuntimeApi();
        if (cwd) {
            return await runtimeApi.listSessionDetailsForCwd(cwd);
        }
        return await runtimeApi.listAllSessionDetails();
    };
    const listReferencePoints = async (source: AgentSessionMeta): Promise<AgentReferencePointView[]> => {
        return await requireRuntimeApi().listReferencePoints({ sourceSessionPath: source.path });
    };
    const navigateTree = async (targetId: string): Promise<AgentNavigateTreeResult> => {
        return await requireRuntimeApi().navigateTree({
            sessionMetadata: requireSessionMetadata(),
            targetId,
            blockId: deps.getBlockId(),
        });
    };
    const forkSession = async (entryId: string): Promise<AgentForkSessionResult> => {
        const result = await requireRuntimeApi().forkSession({
            sessionMetadata: requireSessionMetadata(),
            cwd: deps.getPaneCwd(),
            entryId,
        });
        deps.onSessionMinted?.(result.sessionMetadata);
        return result;
    };
    const resumeSession = async (sessionMetadata: AgentSessionMeta): Promise<AgentNavigateTreeResult> => {
        deps.onSessionMinted?.(sessionMetadata);
        return { sessionMetadata };
    };
    const requireContext = (): AgentChatHostContextApi => {
        if (!deps.context) {
            throw new Error("Agent context API is not available");
        }
        return deps.context;
    };
    const currentTargetIdentity = (): ContextReferenceTargetIdentity =>
        deps.getContextTargetIdentity?.() ?? {
            targetSessionPath: deps.getSessionMetadata()?.path,
            targetGeneration: 0,
        };
    const assertTargetIdentity = (expected: ContextReferenceTargetIdentity): void => {
        const current = currentTargetIdentity();
        if (
            current.targetSessionPath !== expected.targetSessionPath ||
            current.targetGeneration !== expected.targetGeneration
        ) {
            throw new Error("Agent session changed while the selector was open.");
        }
    };
    const captureSession = (): (() => AgentSessionMeta) => {
        const captured = deps.getSessionMetadata();
        return () => {
            if (!captured?.path) {
                throw new Error("No agent session yet. Send a prompt before using session commands.");
            }
            if (deps.getSessionMetadata()?.path !== captured.path) {
                throw new Error("Agent session changed while the selector was open.");
            }
            return captured;
        };
    };
    const makeTreeSelectorRequest = (): Extract<AgentSelectorRequest, { type: "tree" }> => {
        const getCapturedSession = captureSession();
        return {
            type: "tree",
            listTree: async () => {
                const captured = getCapturedSession();
                const result = await requireRuntimeApi().listTree(captured);
                getCapturedSession();
                return result;
            },
            navigateTree: async (targetId) => {
                const captured = getCapturedSession();
                const result = await requireRuntimeApi().navigateTree({
                    sessionMetadata: captured,
                    targetId,
                    blockId: deps.getBlockId(),
                });
                getCapturedSession();
                return result;
            },
            prepareTurnReference: async (targetId, requestedRepresentation) => {
                const captured = getCapturedSession();
                await requireContext().prepareContextDraft({
                    sourceSessionPath: captured.path,
                    sourceKind: "turn",
                    sourceTurnId: targetId,
                    requestedRepresentation,
                });
                getCapturedSession();
            },
        };
    };
    const makeForkSelectorRequest = (): Extract<AgentSelectorRequest, { type: "fork" }> => {
        const getCapturedSession = captureSession();
        return {
            type: "fork",
            listForkPoints: async () => {
                const captured = getCapturedSession();
                const result = await requireRuntimeApi().listForkPoints(captured);
                getCapturedSession();
                return result;
            },
            forkSession: async (entryId) => {
                const captured = getCapturedSession();
                const result = await requireRuntimeApi().forkSession({
                    sessionMetadata: captured,
                    cwd: deps.getPaneCwd(),
                    entryId,
                });
                getCapturedSession();
                deps.onSessionMinted?.(result.sessionMetadata);
                return result;
            },
        };
    };
    const makeSessionSelectorRequest = (): Extract<AgentSelectorRequest, { type: "session" }> => {
        const expectedTarget = currentTargetIdentity();
        const getAddedTurnIds = (source: AgentSessionMeta): ReadonlySet<string> => {
            const contextState = deps.getContextState?.();
            if (!contextState) return new Set();
            const provenanceItems = contextState.drafts.map((draft) => draft.view.provenance);
            return new Set(
                provenanceItems
                    .filter(
                        (provenance) =>
                            provenance.sourceKind === "turn" &&
                            provenance.sourceSessionPath === source.path &&
                            provenance.sourceTurnId
                    )
                    .map((provenance) => provenance.sourceTurnId!)
            );
        };
        const listCapturedSessions = async (cwd?: string): Promise<AgentSessionDetail[]> => {
            assertTargetIdentity(expectedTarget);
            const sessions = await listSessions(cwd);
            assertTargetIdentity(expectedTarget);
            return sessions;
        };
        const listCapturedReferencePoints = async (source: AgentSessionMeta): Promise<AgentReferencePointView[]> => {
            assertTargetIdentity(expectedTarget);
            const points = await listReferencePoints(source);
            assertTargetIdentity(expectedTarget);
            return points;
        };
        const resumeCapturedSession = async (sessionMetadata: AgentSessionMeta): Promise<AgentNavigateTreeResult> => {
            assertTargetIdentity(expectedTarget);
            await Promise.resolve();
            assertTargetIdentity(expectedTarget);
            return await resumeSession(sessionMetadata);
        };
        const prepareCapturedReference = async (
            source: AgentSessionMeta,
            deliveryScope: AgentContextDeliveryScope,
            requestedRepresentation: AgentContextRepresentation,
            turnId?: string
        ): Promise<void> => {
            assertTargetIdentity(expectedTarget);
            await requireContext().prepareContextDraft({
                sourceSessionPath: source.path,
                sourceKind: turnId ? "turn" : "session",
                ...(turnId ? { sourceTurnId: turnId } : {}),
                deliveryScope,
                requestedRepresentation,
                expectedTarget,
            });
            if (expectedTarget.targetSessionPath) {
                assertTargetIdentity(expectedTarget);
            }
        };
        return {
            type: "session",
            cwd: deps.getPaneCwd(),
            currentSessionPath: expectedTarget.targetSessionPath,
            listSessions: listCapturedSessions,
            resumeSession: resumeCapturedSession,
            listReferencePoints: listCapturedReferencePoints,
            getAddedTurnIds,
            prepareSessionReference: (source, deliveryScope, requestedRepresentation) =>
                prepareCapturedReference(source, deliveryScope, requestedRepresentation),
            prepareTurnReference: (source, turnId, deliveryScope, requestedRepresentation) =>
                prepareCapturedReference(source, deliveryScope, requestedRepresentation, turnId),
        };
    };
    const cloneSession = async (): Promise<AgentCloneSessionResult> => {
        const result = await requireRuntimeApi().cloneSession({
            sessionMetadata: requireSessionMetadata(),
            cwd: deps.getPaneCwd(),
        });
        if (result.sessionMetadata) {
            deps.onSessionMinted?.(result.sessionMetadata);
        }
        if (result.message) {
            deps.onUserError?.(result.message);
        }
        return result;
    };
    const reportAsyncError = (promise: Promise<unknown>): void => {
        void promise.catch((err) => deps.onUserError?.(err instanceof Error ? err.message : String(err)));
    };
    const runImmediateCommand = (command: AgentImmediateCommandName, argsText: string): boolean => {
        if (!deps.runCommand) {
            deps.onUserError?.(`Agent command /${command} is not available yet.`);
            return true;
        }
        reportAsyncError(
            deps.runCommand(command, argsText).then((result) => {
                if (result.sessionMetadata) {
                    deps.onSessionMinted?.(result.sessionMetadata);
                }
                if (result.message) {
                    deps.onCommandResult?.({
                        command,
                        status: result.status ?? "success",
                        message: result.message,
                        sessionMetadata: result.sessionMetadata,
                    });
                }
            })
        );
        return true;
    };
    const isImmediateCommand = (command: AgentSlashCommandName): command is AgentImmediateCommandName => {
        return (
            command !== "tree" &&
            command !== "fork" &&
            command !== "clone" &&
            command !== "model" &&
            command !== "session" &&
            command !== "resume"
        );
    };
    const send = async (text: string, images?: string[]): Promise<boolean> => {
        try {
            return await deps.sendPrompt(text, images);
        } catch (error) {
            if (composerRestoreTextFromSendError(error) != null) {
                deps.onRestoreComposerText?.(text);
            }
            throw error;
        }
    };
    return {
        submit: (text, images) => {
            const route = resolveAgentSlashCommandRoute(text);
            if (!route.handled) {
                return send(text, images);
            }
            if (route.command === "model") {
                deps.onOpenModelPicker?.();
                return true;
            }
            if (route.command === "tree") {
                deps.onSelectorRequest?.(makeTreeSelectorRequest());
                return true;
            }
            if (route.command === "fork") {
                deps.onSelectorRequest?.(makeForkSelectorRequest());
                return true;
            }
            if (route.command === "session") {
                deps.onSelectorRequest?.(makeSessionSelectorRequest());
                return true;
            }
            if (isImmediateCommand(route.command)) {
                return runImmediateCommand(route.command, route.argsText);
            }
            reportAsyncError(cloneSession());
            return true;
        },
        send,
        listTree,
        listForkPoints,
        navigateTree,
        forkSession,
        cloneSession,
        abort: deps.abort,
        getTurns: deps.getTurns,
        prepareContextDraft: (input) => requireContext().prepareContextDraft(input),
        discardContextDraft: (draftId) => requireContext().discardContextDraft(draftId),
        summarizeContextDraft: (draftId) => requireContext().summarizeContextDraft(draftId),
        retryContextSend: () => requireContext().retryContextSend(),
    };
}

export function AgentChatHost({
    outerBlockId,
    sessionMetadata,
    onSessionMinted,
    modelSelection,
    paneContext,
    selectionError,
    onReady,
    onTurnsChange,
    onStateChange,
    allowedTools,
    onUserError,
    onCommandResult,
    onOpenModelPicker,
    onSelectorRequest,
    onRestoreComposerText,
    contextReferencesEnabled,
}: AgentChatHostProps) {
    // usePiChat doesn't accept a undefined modelSelection (send needs
    // provider+model). We feed it a synthetic placeholder when the
    // resolver hasn't produced one yet so the hook can mount; send()
    // below short-circuits with an error before actually calling the
    // hook's send if the real selection isn't ready.
    const effectiveSelection: UsePiChatModel = modelSelection ?? {
        provider: "",
        model: "",
    };

    const chat = usePiChat({
        initialSession: sessionMetadata,
        onSessionMinted,
        paneContext,
        modelSelection: effectiveSelection,
        allowedTools,
        blockId: outerBlockId,
        contextReferencesEnabled,
    });

    const turns = chat.turns;
    const onTurnsChangeRef = useRef(onTurnsChange);
    onTurnsChangeRef.current = onTurnsChange;
    const onUserErrorRef = useRef(onUserError);
    onUserErrorRef.current = onUserError;
    const onCommandResultRef = useRef(onCommandResult);
    onCommandResultRef.current = onCommandResult;
    const onOpenModelPickerRef = useRef(onOpenModelPicker);
    onOpenModelPickerRef.current = onOpenModelPicker;
    const onSessionMintedRef = useRef(onSessionMinted);
    onSessionMintedRef.current = onSessionMinted;
    const onSelectorRequestRef = useRef(onSelectorRequest);
    onSelectorRequestRef.current = onSelectorRequest;
    const onRestoreComposerTextRef = useRef(onRestoreComposerText);
    onRestoreComposerTextRef.current = onRestoreComposerText;
    useEffect(() => {
        onTurnsChangeRef.current?.(turns);
    }, [turns]);

    // Expose the send/abort API to the parent via onReady. Refs keep
    // the callback closure stable across renders while still reading
    // the latest model state, selection error, and chat handle.
    const sendRef = useRef(chat.send);
    const abortRef = useRef(chat.abort);
    const turnsRef = useRef(turns);
    const sessionMetadataRef = useRef(chat.sessionMetadata);
    const paneContextRef = useRef(paneContext);
    const selectionErrorRef = useRef(selectionError);
    const modelSelectionRef = useRef(modelSelection);
    const chatRef = useRef(chat);
    chatRef.current = chat;
    useEffect(() => {
        sendRef.current = chat.send;
        abortRef.current = chat.abort;
        turnsRef.current = turns;
        sessionMetadataRef.current = chat.sessionMetadata;
        paneContextRef.current = paneContext;
        selectionErrorRef.current = selectionError;
        modelSelectionRef.current = modelSelection;
    }, [chat.send, chat.abort, turns, chat.sessionMetadata, paneContext, selectionError, modelSelection]);

    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    // Surface live status + pending queue to the parent (the activity bar).
    const onStateChangeRef = useRef(onStateChange);
    onStateChangeRef.current = onStateChange;
    useEffect(() => {
        onStateChangeRef.current?.({
            status: chat.status,
            queuedMessages: chat.queuedMessages,
            context: chat.contextState,
            contextSendRecovery: chat.contextSendRecovery,
        });
    }, [chat.contextSendRecovery, chat.contextState, chat.queuedMessages, chat.status]);

    // One-shot wiring of the API. Stable identity so re-renders don't
    // tear down whatever the parent stored.
    useEffect(() => {
        const sendPrompt = async (text: string, images?: string[]): Promise<boolean> => {
            const trimmed = text.trim();
            if (!trimmed && (images?.length ?? 0) === 0) return false;
            // Block sends when no model is resolved (e.g. ai.json
            // missing, no API key). Surface the resolver error so
            // the user sees a specific reason rather than nothing.
            if (!modelSelectionRef.current) {
                const msg =
                    selectionErrorRef.current?.message ??
                    "AI is not configured. Open the model picker to set up a provider and pick a model.";
                onUserErrorRef.current?.(msg);
                return false;
            }
            if ((images?.length ?? 0) > 0) {
                await sendRef.current(trimmed, { images });
                return true;
            }
            await sendRef.current(trimmed);
            return true;
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: () => abortRef.current(),
            getTurns: () => turnsRef.current,
            getRuntimeApi: getAgentRuntimeApi,
            getSessionMetadata: () => sessionMetadataRef.current,
            getContextState: () => chatRef.current.contextState,
            getContextTargetIdentity: () => contextTargetIdentity(chatRef.current.contextState),
            getPaneCwd: () => paneContextRef.current.cwd,
            getBlockId: () => outerBlockId,
            onSessionMinted: (meta) => onSessionMintedRef.current?.(meta),
            onCommandResult: (result) => onCommandResultRef.current?.(result),
            onUserError: (message) => onUserErrorRef.current?.(message),
            onOpenModelPicker: () => onOpenModelPickerRef.current?.(),
            onSelectorRequest: (request) => onSelectorRequestRef.current?.(request),
            onRestoreComposerText: (text) => onRestoreComposerTextRef.current?.(text),
            context: {
                prepareContextDraft: (input) => chatRef.current.prepareContextDraft(input),
                discardContextDraft: (draftId) => chatRef.current.discardContextDraft(draftId),
                summarizeContextDraft: (draftId) => chatRef.current.summarizeContextDraft(draftId),
                retryContextSend: () => chatRef.current.retryContextSend(),
            },
            runCommand: async (command, argsText) => {
                const runtimeApi = getAgentRuntimeApi();
                if (!runtimeApi) {
                    throw new Error("Electron agent IPC not available (window.api.agent missing)");
                }
                return await runtimeApi.runCommand({
                    sessionMetadata: sessionMetadataRef.current,
                    cwd: paneContextRef.current.cwd,
                    command,
                    argsText,
                    blockId: outerBlockId,
                });
            },
        });
        onReadyRef.current?.(api);
        // Re-fire when the API identity is stable; we want one-shot,
        // but tolerating an extra fire on remount is harmless because
        // the parent overwrites the ref unconditionally.
    }, []);

    return null;
}

interface AgentRuntimeApi {
    listSessionsForCwd: (cwd: string) => Promise<AgentSessionMeta[]>;
    listSessionDetailsForCwd: (cwd: string, limit?: number) => Promise<AgentSessionDetail[]>;
    listAllSessionDetails: (limit?: number) => Promise<AgentSessionDetail[]>;
    listTree: (sessionMetadata: AgentSessionMeta) => Promise<AgentTreeResult>;
    listForkPoints: (sessionMetadata: AgentSessionMeta) => Promise<AgentForkPointView[]>;
    listReferencePoints: (input: AgentListReferencePointsInput) => Promise<AgentReferencePointView[]>;
    navigateTree: (input: AgentNavigateTreeInput) => Promise<AgentNavigateTreeResult>;
    forkSession: (input: AgentForkSessionInput) => Promise<AgentForkSessionResult>;
    cloneSession: (input: AgentCloneSessionInput) => Promise<AgentCloneSessionResult>;
    runCommand: (input: AgentRunCommandInput) => Promise<AgentCommandExecutionResult>;
}

function getAgentRuntimeApi(): AgentRuntimeApi | undefined {
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { api?: { agent?: AgentRuntimeApi } }).api?.agent;
}
