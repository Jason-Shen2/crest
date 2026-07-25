// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// WorkspaceAgentSurface owns the renderer-side Agent conversation UI.
// TerminalView remains the shared chrome/TerminalModel host; this component
// receives only the workspace and live execution context the Agent consumes.

import { CATALOG } from "@/app/store/ai-catalog";
import { providerModelsMapAtom } from "@/app/store/ai-provider-models";
import { resolveAIConfig } from "@/app/store/ai-resolver";
import { AgentSelection, ResolvedAIConfig, ResolveError } from "@/app/store/ai-types";
import { aiUserConfigAtom } from "@/app/store/ai-user-config";
import {
    contextSendDisabledReason,
    createContextReferenceState,
    resolveContextReferenceUiConfig,
    type ContextReferenceSendDisabledReason,
} from "@/app/store/context-references";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { ObjectService } from "@/app/store/services";
import type { PiAgentMessage, PiTurn } from "@/app/store/use-pi-chat";
import { ModelPickerInline } from "@/app/view/cmdblock/model-picker-popover";
import { SessionSelector } from "@/app/view/cmdblock/session-selector";
import { useOrefMetaKeyAtom, WOS } from "@/store/global";
import { useAuiState } from "@assistant-ui/react";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalModel } from "../terminal-model";
import {
    AgentChatHost,
    type AgentChatHostApi,
    type AgentHostState,
    type AgentInlineCommandResult,
    type AgentSelectorRequest,
} from "./agent-chat-host";
import { AgentCommandResultList } from "./agent-command-result";
import {
    AssistantRuntimeProvider,
    ContextReferenceBar,
    Thread,
    useAui,
    useCrestAssistantRuntime,
} from "./assistant-ui";
import type { CrestContextUsage } from "./assistant-ui/context-display";
import { canonicalComposerPayloadFromState, CanonicalComposerSubmissionLease } from "./assistant-ui/runtime-bridge";

export interface WorkspaceAgentSurfaceProps {
    outerBlockId: string;
    model: TerminalModel;
    context: AgentSurfaceContext;
}

export interface AgentSurfaceContext {
    workspaceDir: string;
    liveGitBranch?: string;
    recentCmds: string[];
    liveConnection: string;
    inAltScreen: boolean;
}

export interface AgentAttachedPanelState {
    commandResults: AgentInlineCommandResult[];
    selectorRequest: AgentSelectorRequest | null;
    modelPickerOpen: boolean;
}

export type AgentAttachedPanelAction =
    | { type: "showCommandResult"; result: AgentInlineCommandResult }
    | { type: "dismissCommandResult"; index: number }
    | { type: "openSelector"; request: AgentSelectorRequest }
    | { type: "closeSelector" }
    | { type: "openModelPicker" }
    | { type: "setModelPickerOpen"; open: boolean };

export function makeEmptyAgentAttachedPanelState(): AgentAttachedPanelState {
    return {
        commandResults: [],
        selectorRequest: null,
        modelPickerOpen: false,
    };
}

export function getNextAgentAttachedPanelState(
    state: AgentAttachedPanelState,
    action: AgentAttachedPanelAction
): AgentAttachedPanelState {
    if (action.type === "showCommandResult") {
        return {
            commandResults: [action.result],
            selectorRequest: null,
            modelPickerOpen: false,
        };
    }
    if (action.type === "dismissCommandResult") {
        return {
            ...state,
            commandResults: state.commandResults.filter((_, i) => i !== action.index),
        };
    }
    if (action.type === "openSelector") {
        return {
            commandResults: [],
            selectorRequest: action.request,
            modelPickerOpen: false,
        };
    }
    if (action.type === "closeSelector") {
        return {
            ...state,
            selectorRequest: null,
        };
    }
    if (action.type === "openModelPicker") {
        return {
            commandResults: [],
            selectorRequest: null,
            modelPickerOpen: true,
        };
    }
    if (action.open) {
        return getNextAgentAttachedPanelState(state, { type: "openModelPicker" });
    }
    return {
        ...state,
        modelPickerOpen: false,
    };
}

export function hasActiveAgentAttachedPanel(state: AgentAttachedPanelState): boolean {
    return state.commandResults.length > 0 || state.selectorRequest != null || state.modelPickerOpen;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageField(usage: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) {
        const value = finiteNumber(usage[key]);
        if (value != null) return value;
    }
    return undefined;
}

export function mapPiUsageToContextUsage(usage: unknown): CrestContextUsage | undefined {
    if (!usage || typeof usage !== "object") return undefined;
    const value = usage as Record<string, unknown>;
    const inputTokens = usageField(value, "inputTokens", "input");
    const outputTokens = usageField(value, "outputTokens", "output");
    const cacheRead = usageField(value, "cachedInputTokens", "cacheRead") ?? 0;
    const cacheWrite = usageField(value, "cacheWrite") ?? 0;
    const cachedInputTokens = cacheRead + cacheWrite;
    const reasoningTokens = usageField(value, "reasoningTokens");
    const totalTokens =
        usageField(value, "totalTokens") ??
        (inputTokens ?? 0) + (outputTokens ?? 0) + cachedInputTokens + (reasoningTokens ?? 0);

    if (!inputTokens && !outputTokens && !cachedInputTokens && !reasoningTokens && !totalTokens) return undefined;
    return {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        cachedInputTokens,
        ...(reasoningTokens != null ? { reasoningTokens } : {}),
        totalTokens,
    };
}

export function getLatestAgentContextUsage(turns: PiTurn[]): CrestContextUsage | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        for (let j = turn.responseMessages.length - 1; j >= 0; j--) {
            const message = turn.responseMessages[j];
            if (message.role !== "assistant") continue;
            if (message.stopReason === "aborted" || message.stopReason === "error") continue;
            const usage = mapPiUsageToContextUsage(message.usage);
            if (usage) return usage;
        }
    }
    return undefined;
}

export function agentContextSendGuidance(reason: ContextReferenceSendDisabledReason): string {
    if (reason === "feature_disabled") {
        return "Context references are disabled in ai.json. Remove them or enable context references before sending.";
    }
    if (reason === "summary_not_ready") {
        return "Prepare the missing Summary, or choose Full or Metadata before sending.";
    }
    if (reason === "references_sending") {
        return "These references are already sending. Wait for that request to finish.";
    }
    return "";
}

export function WorkspaceAgentSurface({ outerBlockId, model, context }: WorkspaceAgentSurfaceProps) {
    const [attachedPanelState, setAttachedPanelState] = useState<AgentAttachedPanelState>(
        makeEmptyAgentAttachedPanelState
    );
    const {
        commandResults: agentCommandResults,
        selectorRequest: agentSelectorRequest,
        modelPickerOpen,
    } = attachedPanelState;

    // ---- AI model picker / selection ----
    const userConfigState = useAtomValue(aiUserConfigAtom);
    const contextReferenceUiConfig = useMemo(() => resolveContextReferenceUiConfig(userConfigState), [userConfigState]);
    const contextReferencesEnabled = contextReferenceUiConfig.enabled;
    const blockAgentSelection = useOrefMetaKeyAtom(WOS.makeORef("block", outerBlockId), "agent:selection");
    const activeSelection = useMemo<AgentSelection | null>(() => {
        if (blockAgentSelection?.provider && blockAgentSelection?.model) {
            return {
                provider: blockAgentSelection.provider,
                model: blockAgentSelection.model,
                reasoning: blockAgentSelection.reasoning as "low" | "medium" | "high" | undefined,
            };
        }
        const def = userConfigState.config?.default;
        if (def?.provider && def?.model) {
            return {
                provider: def.provider,
                model: def.model,
                reasoning: def.reasoning as "low" | "medium" | "high" | undefined,
            };
        }
        return null;
    }, [blockAgentSelection, userConfigState.config]);

    const providerModelsMap = useAtomValue(providerModelsMapAtom);
    const modelDisplayLabel = useMemo(() => {
        if (!activeSelection) return "Pick model";
        const provider = CATALOG.find((p) => p.id === activeSelection.provider);
        const modelMeta = provider?.models.find((m) => m.id === activeSelection.model);
        const liveMatch = providerModelsMap[activeSelection.provider]?.models.find(
            (m) => m.id === activeSelection.model
        );
        const fallbackId = stripVendorPrefix(activeSelection.model);
        const base = cleanModelLabel(modelMeta?.displayName ?? liveMatch?.name ?? fallbackId);
        return activeSelection.reasoning ? `${base} · ${activeSelection.reasoning}` : base;
    }, [activeSelection, providerModelsMap]);

    const onSelectionChange = useCallback(
        (next: AgentSelection) => {
            void ObjectService.UpdateObjectMeta(WOS.makeORef("block", outerBlockId), {
                "agent:selection": {
                    provider: next.provider,
                    model: next.model,
                    reasoning: next.reasoning ?? "",
                },
            });
        },
        [outerBlockId]
    );

    const { resolvedAIConfig, aiConfigError } = useMemo<{
        resolvedAIConfig: ResolvedAIConfig | null;
        aiConfigError: ResolveError | null;
    }>(() => {
        if (!activeSelection) {
            return {
                resolvedAIConfig: null,
                aiConfigError: {
                    code: "no_default",
                    message: "No model selected. Open the picker or set a default in ai.json.",
                },
            };
        }
        const r = resolveAIConfig(activeSelection, userConfigState.config ?? undefined, CATALOG);
        if (r.ok) return { resolvedAIConfig: r.config, aiConfigError: null };
        const errResult = r as { ok: false; error: ResolveError };
        return { resolvedAIConfig: null, aiConfigError: errResult.error };
    }, [activeSelection, userConfigState.config]);

    const onOpenAIConfigFile = useCallback(() => {
        modalsModel.pushModal("AISetupWizard");
    }, []);

    // ---- agent wiring ----
    const agentApiRef = useRef<AgentChatHostApi | null>(null);
    const onAgentHostReady = useCallback((api: AgentChatHostApi) => {
        agentApiRef.current = api;
        setAgentApiReady(true);
    }, []);
    const onOpenAgentModelPicker = useCallback(() => {
        setAttachedPanelState((prev) => getNextAgentAttachedPanelState(prev, { type: "openModelPicker" }));
    }, []);
    const onAgentSelectorRequest = useCallback((request: AgentSelectorRequest) => {
        setAttachedPanelState((prev) => getNextAgentAttachedPanelState(prev, { type: "openSelector", request }));
    }, []);
    const onCloseAgentSelector = useCallback(() => {
        setAttachedPanelState((prev) => getNextAgentAttachedPanelState(prev, { type: "closeSelector" }));
    }, []);
    const onModelPickerOpenChange = useCallback((open: boolean) => {
        setAttachedPanelState((prev) => getNextAgentAttachedPanelState(prev, { type: "setModelPickerOpen", open }));
    }, []);
    const composerAnchorRef = useRef<HTMLDivElement>(null);
    const persistedAgentSession = useOrefMetaKeyAtom(WOS.makeORef("block", outerBlockId), "agent:session");
    const agentSession = useMemo<AgentSessionMeta | undefined>(() => {
        if (persistedAgentSession?.path) return persistedAgentSession;
        return undefined;
    }, [persistedAgentSession]);
    const [agentRestoredTextRequest, setAgentRestoredTextRequest] = useState<
        { text: string; requestId: number; sessionPath?: string } | undefined
    >(undefined);
    const agentRestoreSequenceRef = useRef(0);
    const onAgentEditorText = useCallback(
        (text: string) => {
            agentRestoreSequenceRef.current += 1;
            setAgentRestoredTextRequest({
                text,
                requestId: agentRestoreSequenceRef.current,
                sessionPath: agentSession?.path,
            });
        },
        [agentSession?.path]
    );
    const onAgentRestoreApplied = useCallback((requestId: number) => {
        setAgentRestoredTextRequest((current) => (current?.requestId === requestId ? undefined : current));
    }, []);
    useEffect(() => {
        setAgentRestoredTextRequest((current) =>
            current && current.sessionPath !== agentSession?.path ? undefined : current
        );
    }, [agentSession?.path]);
    const [agentState, setAgentState] = useState<AgentHostState>({
        status: "idle",
        queuedMessages: [],
        context: {
            ...createContextReferenceState(),
            enabled: contextReferencesEnabled,
        },
    });
    const submissionLeaseRef = useRef(new CanonicalComposerSubmissionLease());
    const [agentApiReady, setAgentApiReady] = useState(false);
    const onAgentStop = useCallback(() => {
        agentApiRef.current?.abort();
    }, []);
    const onSessionMintedHandler = useCallback(
        (meta: AgentSessionMeta) => {
            void ObjectService.UpdateObjectMeta(WOS.makeORef("block", outerBlockId), { "agent:session": meta });
        },
        [outerBlockId]
    );
    const [agentTurns, setAgentTurns] = useState<PiTurn[]>([]);
    const onAgentTurnsUpdate = useCallback((turns: PiTurn[]) => {
        setAgentTurns(turns);
    }, []);
    const onAgentCommandResult = useCallback((result: AgentInlineCommandResult) => {
        setAttachedPanelState((prev) => getNextAgentAttachedPanelState(prev, { type: "showCommandResult", result }));
    }, []);
    const onDismissCommandResult = useCallback((index: number) => {
        setAttachedPanelState((prev) => getNextAgentAttachedPanelState(prev, { type: "dismissCommandResult", index }));
    }, []);
    const contextTargetMatchesSession = agentState.context.targetSessionPath === agentSession?.path;
    const contextHydrating = !!agentSession?.path && !contextTargetMatchesSession;
    const currentSessionPathRef = useRef(agentSession?.path);
    const currentContextTargetPathRef = useRef(agentState.context.targetSessionPath);
    const currentContextGenerationRef = useRef(agentState.context.targetGeneration);
    currentSessionPathRef.current = agentSession?.path;
    currentContextTargetPathRef.current = agentState.context.targetSessionPath;
    currentContextGenerationRef.current = agentState.context.targetGeneration;
    const contextCallbackIdentity = useMemo(
        () => ({
            targetSessionPath: agentState.context.targetSessionPath,
            targetGeneration: agentState.context.targetGeneration,
        }),
        [agentState.context.targetGeneration, agentState.context.targetSessionPath]
    );
    const requireAgentApi = useCallback((): AgentChatHostApi => {
        const api = agentApiRef.current;
        if (api) {
            return api;
        }
        const message = "Agent is still starting. Try again in a moment.";
        globalStore.set(model.notificationAtom, message);
        throw new Error(message);
    }, [model]);
    const requireCurrentContextApi = useCallback(
        (expected: typeof contextCallbackIdentity): AgentChatHostApi => {
            if (currentContextTargetPathRef.current !== currentSessionPathRef.current) {
                throw new Error("Context for the selected session is still loading.");
            }
            if (
                expected.targetSessionPath !== currentContextTargetPathRef.current ||
                expected.targetGeneration !== currentContextGenerationRef.current
            ) {
                throw new Error("This context control is no longer current.");
            }
            return requireAgentApi();
        },
        [requireAgentApi]
    );

    const onSummarizeContextDraft = useCallback(
        async (draftId: string) => {
            await requireCurrentContextApi(contextCallbackIdentity).summarizeContextDraft(draftId);
        },
        [contextCallbackIdentity, requireCurrentContextApi]
    );
    const onDiscardContextDraft = useCallback(
        async (draftId: string) => {
            await requireCurrentContextApi(contextCallbackIdentity).discardContextDraft(draftId);
        },
        [contextCallbackIdentity, requireCurrentContextApi]
    );
    const onRetryContextSend = useCallback(async () => {
        await requireCurrentContextApi(contextCallbackIdentity).retryContextSend();
    }, [contextCallbackIdentity, requireCurrentContextApi]);

    const onAgentSubmit = useCallback(
        (text: string, images?: string[]) => {
            if (!text && (images?.length ?? 0) === 0) return;
            const api = agentApiRef.current;
            if (!api) {
                const message = "Agent is still starting. Try again in a moment.";
                globalStore.set(model.notificationAtom, message);
                onAgentEditorText(text);
                return Promise.reject(new Error(message));
            }
            if (contextHydrating) {
                const message = "Context for the selected session is still loading.";
                onAgentEditorText(text);
                return Promise.reject(new Error(message));
            }
            return api.submit(text, images);
        },
        [contextHydrating, model, onAgentEditorText]
    );
    const onAgentSubmissionError = useCallback(
        (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            globalStore.set(model.notificationAtom, message);
        },
        [model]
    );
    const contextForSendGate = useMemo(
        () =>
            contextReferencesEnabled
                ? agentState.context
                : {
                      ...agentState.context,
                      enabled: false,
                  },
        [agentState.context, contextReferencesEnabled]
    );
    const contextSendGate = contextSendDisabledReason(contextForSendGate);
    const contextSendGuidance = contextHydrating
        ? "Context for the selected session is loading. Send will be available after hydration finishes."
        : contextSendGate
          ? agentContextSendGuidance(contextSendGate)
          : undefined;
    const assistantRuntimeBridge = useMemo(
        () => ({
            turns: agentTurns,
            status: agentState.status,
            submit: onAgentSubmit,
            abort: onAgentStop,
            onSubmissionError: onAgentSubmissionError,
            submissionLease: submissionLeaseRef.current,
            isSendDisabled: !agentApiReady || contextHydrating || contextSendGate != null,
        }),
        [
            agentApiReady,
            agentTurns,
            agentState.status,
            contextHydrating,
            contextSendGate,
            onAgentSubmit,
            onAgentSubmissionError,
            onAgentStop,
        ]
    );
    const assistantRuntime = useCrestAssistantRuntime(assistantRuntimeBridge);
    const contextUsage = useMemo(() => getLatestAgentContextUsage(agentTurns), [agentTurns]);

    const chatHost = (
        <>
            <AgentChatHost
                outerBlockId={outerBlockId}
                sessionMetadata={agentSession}
                onSessionMinted={onSessionMintedHandler}
                modelSelection={
                    resolvedAIConfig
                        ? {
                              provider: resolvedAIConfig.provider,
                              model: resolvedAIConfig.model,
                              reasoning: resolvedAIConfig.reasoning,
                              token: resolvedAIConfig.token,
                              tokenSecretName: resolvedAIConfig.tokensecretname,
                          }
                        : activeSelection
                          ? {
                                provider: activeSelection.provider,
                                model: activeSelection.model,
                                reasoning: activeSelection.reasoning,
                            }
                          : undefined
                }
                paneContext={{
                    cwd: context.workspaceDir,
                    gitBranch: context.liveGitBranch,
                    recentCmds: context.recentCmds,
                    connection: context.liveConnection,
                }}
                selectionError={aiConfigError}
                onReady={onAgentHostReady}
                onTurnsChange={onAgentTurnsUpdate}
                onStateChange={setAgentState}
                onUserError={(msg) => globalStore.set(model.notificationAtom, msg)}
                onCommandResult={onAgentCommandResult}
                onOpenModelPicker={onOpenAgentModelPicker}
                onSelectorRequest={onAgentSelectorRequest}
                onRestoreComposerText={onAgentEditorText}
                contextReferencesEnabled={contextReferencesEnabled}
            />
            {!context.inAltScreen && (
                <div className="min-h-0 flex-1">
                    <AssistantRuntimeProvider runtime={assistantRuntime}>
                        <AgentComposerSubmissionLeaseObserver submissionLease={submissionLeaseRef.current} />
                        <AgentComposerTextRestore
                            request={agentRestoredTextRequest}
                            sessionPath={agentSession?.path}
                            onApplied={onAgentRestoreApplied}
                        />
                        <Thread
                            modelLabel={modelDisplayLabel}
                            onOpenModelPicker={onOpenAgentModelPicker}
                            modelContextWindow={resolvedAIConfig?.contextwindow}
                            contextUsage={contextUsage}
                            composerAnchorRef={composerAnchorRef}
                            hideScrollToBottom={
                                hasActiveAgentAttachedPanel(attachedPanelState) || agentState.queuedMessages.length > 0
                            }
                            beforeComposer={
                                <>
                                    {contextTargetMatchesSession &&
                                        (agentState.context.drafts.length > 0 || agentState.contextSendRecovery) && (
                                            <ContextReferenceBar
                                                drafts={agentState.context.drafts}
                                                recovery={
                                                    agentState.contextSendRecovery
                                                        ? { errorMessage: agentState.contextSendRecovery.errorMessage }
                                                        : undefined
                                                }
                                                onSummarizeDraft={onSummarizeContextDraft}
                                                onDiscardDraft={onDiscardContextDraft}
                                                onRetrySend={onRetryContextSend}
                                                readOnly={!contextReferencesEnabled || !agentState.context.enabled}
                                                operatorMaxTokens={contextReferenceUiConfig.maxTokens}
                                            />
                                        )}
                                    {contextSendGuidance && (
                                        <p
                                            className="rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs text-muted-foreground"
                                            role="status"
                                        >
                                            {contextSendGuidance}
                                        </p>
                                    )}
                                    <AgentCommandResultList
                                        results={agentCommandResults}
                                        onDismiss={onDismissCommandResult}
                                    />
                                    <SessionSelector
                                        anchorRef={composerAnchorRef}
                                        request={agentSelectorRequest}
                                        referencesEnabled={
                                            contextReferencesEnabled &&
                                            agentState.context.enabled &&
                                            contextTargetMatchesSession
                                        }
                                        onClose={onCloseAgentSelector}
                                        onUserMessage={(msg) => globalStore.set(model.notificationAtom, msg)}
                                        onEditorText={onAgentEditorText}
                                    />
                                    <ModelPickerInline
                                        open={modelPickerOpen}
                                        onOpenChange={onModelPickerOpenChange}
                                        selection={activeSelection}
                                        onSelectionChange={onSelectionChange}
                                        userConfig={userConfigState.config}
                                        userConfigStatus={userConfigState.status}
                                        userConfigError={userConfigState.error}
                                        catalog={CATALOG}
                                        onOpenConfigFile={onOpenAIConfigFile}
                                        anchorRef={composerAnchorRef}
                                    />
                                    <AgentQueuedMessagesPanel messages={agentState.queuedMessages} />
                                </>
                            }
                        />
                    </AssistantRuntimeProvider>
                </div>
            )}
        </>
    );

    return chatHost;
}
WorkspaceAgentSurface.displayName = "WorkspaceAgentSurface";

export function getAgentQueuedMessageText(message: PiAgentMessage): string {
    const textParts: string[] = [];
    let imageCount = 0;
    for (const content of message.content ?? []) {
        if (content.type === "text" && typeof content.text === "string") {
            const text = content.text.trim();
            if (text) textParts.push(text);
            continue;
        }
        if (content.type === "image") {
            imageCount++;
        }
    }
    const text = textParts.join(" ");
    if (text) return text;
    if (imageCount === 1) return "Image attachment";
    if (imageCount > 1) return `${imageCount} image attachments`;
    return "Queued message";
}

export function AgentQueuedMessagesPanel({ messages }: { messages: PiAgentMessage[] }) {
    if (messages.length === 0) return null;

    return (
        <details
            open
            className="aui-agent-queue-panel group overflow-hidden rounded-2xl border border-white/[0.10] bg-[rgba(34,34,36,0.62)] shadow-[0_18px_54px_-34px_rgba(0,0,0,0.68)] backdrop-blur-2xl backdrop-saturate-150"
        >
            <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm select-none [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 items-center gap-2 font-medium text-foreground/80">
                    <span className="grid size-4 place-items-center text-accent/85">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M4 7h16" />
                            <path d="M4 12h10" />
                            <path d="M4 17h7" />
                        </svg>
                    </span>
                    <span>{messages.length} queued</span>
                </span>
                <span className="grid size-6 place-items-center rounded-full text-secondary/55 transition-[background-color,color,transform] duration-100 group-open:rotate-180 group-hover:bg-white/[0.06] group-hover:text-foreground/70">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="m6 9 6 6 6-6" />
                    </svg>
                </span>
            </summary>
            <div className="grid gap-px border-t border-white/[0.065] p-1">
                {messages.map((message, index) => {
                    const text = getAgentQueuedMessageText(message);
                    return (
                        <div
                            key={`${message.timestamp ?? index}-${text}`}
                            className="grid min-h-9 grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm text-foreground/80 hover:bg-white/[0.052]"
                        >
                            <span className="grid size-[22px] shrink-0 place-items-center rounded-lg border border-white/[0.085] bg-white/[0.045] font-mono text-[10px] text-secondary/55">
                                {String(index + 1).padStart(2, "0")}
                            </span>
                            <span className="truncate" title={text}>
                                {text}
                            </span>
                        </div>
                    );
                })}
            </div>
        </details>
    );
}

function AgentComposerTextRestore({
    request,
    sessionPath,
    onApplied,
}: {
    request?: { text: string; requestId: number; sessionPath?: string };
    sessionPath?: string;
    onApplied: (requestId: number) => void;
}) {
    const aui = useAui();
    useEffect(() => {
        if (!request || request.sessionPath !== sessionPath) return;
        aui.composer().setText(request.text);
        onApplied(request.requestId);
    }, [aui, onApplied, request, sessionPath]);
    return null;
}

function AgentComposerSubmissionLeaseObserver({
    submissionLease,
}: {
    submissionLease: CanonicalComposerSubmissionLease;
}) {
    const text = useAuiState((state) => state.composer.text);
    const attachments = useAuiState((state) => state.composer.attachments);
    const quote = useAuiState((state) => state.composer.quote);
    const operationRef = useRef(0);
    const [leaseRevision, setLeaseRevision] = useState(0);
    useEffect(
        () =>
            submissionLease.subscribe(() => {
                setLeaseRevision((current) => current + 1);
            }),
        [submissionLease]
    );
    useEffect(() => {
        operationRef.current += 1;
        const operation = operationRef.current;
        const state = { text, attachments, quote };
        void canonicalComposerPayloadFromState(state)
            .then((payload) => {
                if (operation !== operationRef.current) return;
                submissionLease.registerPreview(state, payload);
            })
            .catch(() => undefined);
        return () => {
            if (operation === operationRef.current) {
                operationRef.current += 1;
            }
        };
    }, [attachments, leaseRevision, quote, submissionLease, text]);
    return null;
}

// stripVendorPrefix — OpenRouter / Together style model ids carry the
// upstream vendor as a slash-prefixed namespace ("anthropic/claude-…").
// The chip should surface just the model name, not the vendor segment.
function stripVendorPrefix(modelId: string): string {
    const i = modelId.lastIndexOf("/");
    if (i < 0 || i === modelId.length - 1) return modelId;
    return modelId.slice(i + 1);
}

// cleanModelLabel — display labels arrive with the provider baked in,
// in two flavors:
//   - " (OpenRouter)" suffix on the curated catalog displayName
//   - "Vendor: " prefix on the live /models name for OpenRouter etc.
// Both look like noise in the chip. Strip them so the chip shows just
// the model. The detail tooltip still surfaces the provider explicitly.
function cleanModelLabel(label: string): string {
    let s = label.replace(/\s*\([^)]*\)\s*$/, "");
    const idx = s.indexOf(": ");
    if (idx > 0 && idx < s.length - 2) {
        s = s.slice(idx + 2);
    }
    return s.trim();
}
