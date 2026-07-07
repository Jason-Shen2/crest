// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentPane — all the agent-conversation wiring that used to live inline in
// TerminalView.  A pure-terminal block (view: "term") never imports this
// file; the agent block (view: "agent") mounts it via useAgentPane() and
// hands the resulting AgentSlot to TerminalView.  Sharing the underlying
// TerminalModel keeps the engine (blocks / alt-screen / selection) common
// to both forms; only this agent surface differs.

import { CATALOG } from "@/app/store/ai-catalog";
import { providerModelsMapAtom } from "@/app/store/ai-provider-models";
import { resolveAIConfig } from "@/app/store/ai-resolver";
import { AgentSelection, ResolvedAIConfig, ResolveError } from "@/app/store/ai-types";
import { aiUserConfigAtom } from "@/app/store/ai-user-config";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { ObjectService } from "@/app/store/services";
import { indexRunsById, type PiRun } from "@/app/store/use-pi-chat";
import { CmdBlockInput, InputMode } from "@/app/view/cmdblock/cmdblock-input";
import { SessionSelector } from "@/app/view/cmdblock/session-selector";
import { useOrefMetaKeyAtom, WOS } from "@/store/global";
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useRef, useState } from "react";
import type { TerminalModel } from "../terminal-model";
import { AgentActivityBar } from "./agent-activity-bar";
import {
    AgentChatHost,
    type AgentChatHostApi,
    type AgentHostState,
    type AgentInlineCommandResult,
    type AgentSelectorRequest,
} from "./agent-chat-host";
import { AgentCommandResultList } from "./agent-command-result";

export interface AgentSlot {
    chatHost: React.ReactNode;
    commandResults: React.ReactNode;
    activityBar: React.ReactNode;
    inputBar: React.ReactNode;
    agentRunsById: Map<string, PiRun>;
}

// 输入栏渲染需要的、来自 TerminalView 的实时上下文。这些值 TerminalView
// 已经算好（cwd/branch/ssh/history 等），通过 deps 传入避免重复计算。
export interface AgentPaneDeps {
    model: TerminalModel;
    fontSize: number;
    focusRequest: number;
    liveCwd: string;
    home: string;
    branch?: string;
    gitAdded?: number;
    gitRemoved?: number;
    prNumber?: number;
    prTitle?: string;
    kubernetesContext?: string;
    sshHost?: string;
    sshUser?: string;
    workspaceDir: string;
    liveGitBranch?: string;
    recentCmds: string[];
    liveConnection: string;
    commandHistory: string[];
    inputMode: InputMode;
    effectiveMode: "terminal" | "agent";
    onModeChange: (next: InputMode, currentText?: string) => void;
    onInputTextChange: (next: string) => void;
    isRunning: boolean;
    inAltScreen: boolean;
}

export function useAgentPane(outerBlockId: string, model: TerminalModel, deps: AgentPaneDeps): AgentSlot {
    const revision = useAtomValue(model.revisionAtom);
    const [agentCommandResults, setAgentCommandResults] = useState<AgentInlineCommandResult[]>([]);

    // ---- AI model picker / selection ----
    const userConfigState = useAtomValue(aiUserConfigAtom);
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
    const [submitting, setSubmitting] = useState(false);
    const agentApiRef = useRef<AgentChatHostApi | null>(null);
    const onAgentHostReady = useCallback((api: AgentChatHostApi) => {
        agentApiRef.current = api;
    }, []);
    const [modelPickerRequest, setModelPickerRequest] = useState(0);
    const onOpenAgentModelPicker = useCallback(() => {
        setModelPickerRequest((value) => value + 1);
    }, []);
    const [agentSelectorRequest, setAgentSelectorRequest] = useState<AgentSelectorRequest | null>(null);
    const onAgentSelectorRequest = useCallback((request: AgentSelectorRequest) => {
        setAgentSelectorRequest(request);
    }, []);
    const agentSelectorAnchorRef = useRef<HTMLDivElement>(null);
    const [agentRestoredTextRequest, setAgentRestoredTextRequest] = useState<
        { text: string; requestId: number } | undefined
    >(undefined);
    const onAgentEditorText = useCallback((text: string) => {
        setAgentRestoredTextRequest((prev) => ({ text, requestId: (prev?.requestId ?? 0) + 1 }));
    }, []);
    const [agentState, setAgentState] = useState<AgentHostState>({ status: "idle", queuedMessages: [] });
    const onAgentStop = useCallback(() => {
        agentApiRef.current?.abort();
    }, []);
    const persistedAgentSession = useOrefMetaKeyAtom(WOS.makeORef("block", outerBlockId), "agent:session");
    const timelineAgentSessionPath = useMemo(() => model.getFirstAgentSessionPath(), [model, revision]);
    const agentSession = useMemo<AgentSessionMeta | undefined>(() => {
        if (persistedAgentSession?.path) return persistedAgentSession;
        if (!timelineAgentSessionPath) return undefined;
        return { id: "", createdAt: "", cwd: deps.workspaceDir, path: timelineAgentSessionPath };
    }, [persistedAgentSession, timelineAgentSessionPath, deps.workspaceDir]);
    const onSessionMintedHandler = useCallback(
        (meta: AgentSessionMeta) => {
            void ObjectService.UpdateObjectMeta(WOS.makeORef("block", outerBlockId), { "agent:session": meta });
        },
        [outerBlockId]
    );
    const [agentRunsById, setAgentRunsById] = useState<Map<string, PiRun>>(new Map());
    const onAgentRunsUpdate = useCallback(
        (runs: PiRun[]) => {
            setAgentRunsById(indexRunsById(runs));
            model.syncAgentBlocks(new Set(runs.map((r) => r.runId)));
        },
        [model]
    );
    const onAgentCommandResult = useCallback((result: AgentInlineCommandResult) => {
        setAgentCommandResults((prev) => [...prev, result]);
    }, []);

    const onSubmit = useCallback(
        (text: string, mode: InputMode) => {
            if (!text) return;
            if (mode === "agent") {
                const api = agentApiRef.current;
                if (!api) {
                    globalStore.set(model.notificationAtom, "Agent is still starting. Try again in a moment.");
                    return false;
                }
                return api.submit(text);
            }
            setSubmitting(true);
            void model.submitInput(text).finally(() => setSubmitting(false));
        },
        [model]
    );

    const chatHost = (
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
                cwd: deps.workspaceDir,
                gitBranch: deps.liveGitBranch,
                recentCmds: deps.recentCmds,
                connection: deps.liveConnection,
            }}
            selectionError={aiConfigError}
            onReady={onAgentHostReady}
            onRunsChange={onAgentRunsUpdate}
            onStateChange={setAgentState}
            onUserError={(msg) => globalStore.set(model.notificationAtom, msg)}
            onCommandResult={onAgentCommandResult}
            onOpenModelPicker={onOpenAgentModelPicker}
            onSelectorRequest={onAgentSelectorRequest}
        />
    );

    const commandResults = <AgentCommandResultList results={agentCommandResults} />;

    const activityBar = deps.inAltScreen ? null : (
        <AgentActivityBar status={agentState.status} queuedMessages={agentState.queuedMessages} onStop={onAgentStop} />
    );

    const inputBar = deps.inAltScreen ? null : (
        <div ref={agentSelectorAnchorRef}>
            <SessionSelector
                anchorRef={agentSelectorAnchorRef}
                request={agentSelectorRequest}
                onClose={() => setAgentSelectorRequest(null)}
                onUserMessage={(msg) => globalStore.set(model.notificationAtom, msg)}
                onEditorText={onAgentEditorText}
            />
            <CmdBlockInput
                cwd={deps.liveCwd}
                home={deps.home}
                branch={deps.branch}
                gitAdded={deps.gitAdded}
                gitRemoved={deps.gitRemoved}
                prNumber={deps.prNumber}
                prTitle={deps.prTitle}
                kubernetesContext={deps.kubernetesContext}
                sshHost={deps.sshHost}
                sshUser={deps.sshUser}
                mode={deps.inputMode}
                onModeChange={deps.onModeChange}
                onSubmit={onSubmit}
                submitting={submitting}
                disabled={false}
                fontSize={deps.fontSize}
                focusRequest={deps.focusRequest}
                history={deps.commandHistory}
                onTextChange={deps.onInputTextChange}
                restoredTextRequest={agentRestoredTextRequest}
                effectiveMode={deps.effectiveMode}
                modelDisplayLabel={modelDisplayLabel}
                catalog={CATALOG}
                userConfig={userConfigState.config}
                userConfigStatus={userConfigState.status}
                userConfigError={userConfigState.error}
                selection={activeSelection}
                onSelectionChange={onSelectionChange}
                onOpenAIConfigFile={onOpenAIConfigFile}
                openModelPickerRequest={modelPickerRequest}
                placeholder={
                    deps.isRunning
                        ? "Press Ctrl+C in the running block to interrupt, or type the next command"
                        : undefined
                }
            />
        </div>
    );

    return { chatHost, commandResults, activityBar, inputBar, agentRunsById };
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
