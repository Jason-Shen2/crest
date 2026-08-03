// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WaveEnv } from "@/app/waveenv/waveenv";
import { type Placement } from "@floating-ui/react";
import type * as jotai from "jotai";
import type * as rxjs from "rxjs";

declare global {
    type GlobalAtomsType = {
        builderId: jotai.Atom<string>; // readonly (for builder mode)
        builderAppId: jotai.PrimitiveAtom<string>; // app being edited in builder mode
        uiContext: jotai.Atom<UIContext>; // driven from windowId, tabId
        workspaceId: jotai.Atom<string>; // derived from window WOS object
        workspaceGeneration: jotai.Atom<number>; // workspace renderer generation; 0 outside workspace renderer
        workspace: jotai.Atom<Workspace>; // driven from workspaceId via WOS
        fullConfigAtom: jotai.PrimitiveAtom<FullConfigType>; // driven from WOS, settings -- updated via WebSocket
        settingsAtom: jotai.Atom<SettingsType>; // derrived from fullConfig
        hasConfigErrors: jotai.Atom<boolean>; // derived from fullConfig
        staticTabId?: jotai.Atom<string>;
        isFullScreen: jotai.PrimitiveAtom<boolean>;
        zoomFactorAtom: jotai.PrimitiveAtom<number>;
        controlShiftDelayAtom: jotai.PrimitiveAtom<boolean>;
        prefersReducedMotionAtom: jotai.Atom<boolean>;
        documentHasFocus: jotai.PrimitiveAtom<boolean>;
        updaterStatusAtom: jotai.PrimitiveAtom<UpdaterStatus>;
        modalOpen: jotai.PrimitiveAtom<boolean>;
        allConnStatus: jotai.Atom<ConnStatus[]>;
        reinitVersion: jotai.PrimitiveAtom<number>;
    };

    type ThrottledValueAtom<T> = jotai.WritableAtom<T, [update: jotai.SetStateAction<T>], void>;

    type AtomWithThrottle<T> = {
        currentValueAtom: jotai.Atom<T>;
        throttledValueAtom: ThrottledValueAtom<T>;
    };

    type DebouncedValueAtom<T> = jotai.WritableAtom<T, [update: jotai.SetStateAction<T>], void>;

    type AtomWithDebounce<T> = {
        currentValueAtom: jotai.Atom<T>;
        debouncedValueAtom: DebouncedValueAtom<T>;
    };

    type SplitAtom<Item> = Atom<Atom<Item>[]>;
    type WritableSplitAtom<Item> = WritableAtom<PrimitiveAtom<Item>[], [SplitAtomAction<Item>], void>;

    type TabLayoutData = {
        blockId: string;
    };

    type RendererKind = "workspace" | "terminal" | "builder" | "preview";

    type WorkspaceInitOpts = {
        clientId: string;
        windowId: string;
        workspaceId: string;
        generation: number;
    };

    type WorkspaceReadyStatus = {
        workspaceId: string;
        generation: number;
    };

    type WorkspaceSurfaceState =
        | {
              kind: "agent";
              workspaceId: string;
              generation: number;
              revision: number;
              bounds: Electron.Rectangle;
          }
        | {
              kind: "terminal";
              terminalTabId: string;
              workspaceId: string;
              generation: number;
              revision: number;
              bounds: Electron.Rectangle;
          }
        | {
              kind: "top-tab";
              workspaceId: string;
              generation: number;
              revision: number;
              bounds: Electron.Rectangle;
          };

    type TerminalSurfaceStatus =
        | {
              state: "idle";
              workspaceid: string;
              generation: number;
              revision: number;
          }
        | {
              state: "loading" | "ready";
              workspaceid: string;
              generation: number;
              revision: number;
              terminaltabid: string;
          }
        | {
              state: "error";
              workspaceid: string;
              generation: number;
              revision: number;
              terminaltabid: string;
              message: string;
          };

    type WorkspaceCommand =
        | { type: "open-url"; url: string }
        | { type: "open-file"; path: string }
        | { type: "open-preview"; path: string }
        | {
              type: "open-git-diff";
              repoRoot: string;
              path: string;
              mode: "+" | "-";
              originalPath?: string;
          }
        | { type: "activate-agent" }
        | { type: "activate-terminal"; terminalTabId: string }
        | { type: "activate-terminal-index"; index: number }
        | { type: "activate-top-tab"; topTabId: string }
        | { type: "new-terminal" }
        | { type: "close-active" }
        | { type: "next-content" }
        | { type: "previous-content" }
        | { type: "toggle-left-panel-files" };

    type GlobalInitCommonOptions = {
        platform: NodeJS.Platform;
        windowId: string;
        clientId: string;
        environment: "electron" | "renderer";
    };

    type GlobalInitOptions = GlobalInitCommonOptions &
        (
            | {
                  rendererKind: "workspace";
                  workspaceId: string;
                  generation?: number;
              }
            | {
                  rendererKind: "terminal";
                  tabId: string;
                  primaryTabStartup?: boolean;
              }
            | {
                  rendererKind: "builder";
                  builderId: string;
              }
            | {
                  rendererKind: "preview";
              }
        );

    type WaveInitOpts = {
        tabId: string;
        clientId: string;
        windowId: string;
        activate: boolean;
        rendererKind: "terminal";
        primaryTabStartup?: boolean;
    };

    type BuilderInitOpts = {
        builderId: string;
        clientId: string;
        windowId: string;
    };

    type WaveRuntime = {
        lspWebSocketUrl: string;
    };

    interface Window {
        waveRuntime?: WaveRuntime;
        api?: ElectronApi;
    }

    type ElectronApi = {
        getAuthKey(): string; // get-auth-key
        getIsDev(): boolean; // get-is-dev
        getCursorPoint: () => Electron.Point; // get-cursor-point
        getPlatform: () => NodeJS.Platform; // get-platform
        getEnv: (varName: string) => string; // get-env
        getUserName: () => string; // get-user-name
        getHostName: () => string; // get-host-name
        getDataDir: () => string; // get-data-dir
        getConfigDir: () => string; // get-config-dir
        getHomeDir: () => string; // get-home-dir
        getWebviewPreload: () => string; // get-webview-preload
        getAboutModalDetails: () => AboutModalDetails; // get-about-modal-details
        getZoomFactor: () => number; // get-zoom-factor
        showWorkspaceAppMenu: (workspaceId: string) => void; // workspace-appmenu-show
        showBuilderAppMenu: (builderId: string) => void; // builder-appmenu-show
        showContextMenu: (
            workspaceId: string,
            menu: ElectronContextMenuItem[],
            position?: { x: number; y: number }
        ) => void; // contextmenu-show
        onContextMenuClick: (callback: (id: string | null) => void) => void; // contextmenu-click
        onNavigate: (callback: (url: string) => void) => void;
        onIframeNavigate: (callback: (url: string) => void) => void;
        downloadFile: (path: string) => void; // download
        openExternal: (url: string) => void; // open-external
        onFullScreenChange: (callback: (isFullScreen: boolean) => void) => void; // fullscreen-change
        getIsFullScreen: () => boolean; // get-is-full-screen (sync)
        onZoomFactorChange: (callback: (zoomFactor: number) => void) => void; // zoom-factor-change
        onUpdaterStatusChange: (callback: (status: UpdaterStatus) => void) => void; // app-update-status
        getUpdaterStatus: () => UpdaterStatus; // get-app-update-status
        getUpdaterChannel: () => string; // get-updater-channel
        installAppUpdate: () => void; // install-app-update
        onMenuItemAbout: (callback: () => void) => void; // menu-item-about
        updateWindowControlsOverlay: (rect: Dimensions) => void; // update-window-controls-overlay
        onReinjectKey: (callback: (waveEvent: WaveKeyboardEvent) => void) => () => void; // reinject-key
        setWebviewFocus: (focusedId: number) => void; // webview-focus, focusedId is the getWebContentsId of the webview
        registerGlobalWebviewKeys: (keys: string[]) => void; // register-global-webview-keys
        onControlShiftStateUpdate: (callback: (state: boolean) => void) => () => void; // control-shift-state-update
        createWorkspace: (dir: string) => void; // create-workspace
        selectDirectory: () => Promise<string | null>; // select-directory
        selectFile: () => Promise<string | null>; // select-file
        switchWorkspace: (workspaceId: string) => void; // switch-workspace
        deleteWorkspace: (workspaceId: string) => void; // delete-workspace
        setWindowInitStatus: (
            status: "ready" | "wave-ready" | "workspace-ready" | "workspace-init-failed",
            workspaceReady?: WorkspaceReadyStatus
        ) => void; // set-window-init-status
        onWorkspaceInit: (callback: (initOpts: WorkspaceInitOpts) => void) => void; // workspace-init
        onWorkspaceInitFatal: (callback: (status: WorkspaceReadyStatus) => void) => () => void; // workspace-init-fatal
        sendWorkspaceCommand: (command: WorkspaceCommand) => void; // workspace-command
        onWorkspaceCommand: (callback: (command: WorkspaceCommand) => void) => () => void; // workspace-command
        onWorkspaceCloseRequest: (callback: (request: WorkspaceCloseRequest) => void) => () => void; // workspace-close-request
        respondWorkspaceClose: (response: WorkspaceCloseResponse) => void; // workspace-close-response
        onWorkspaceCloseFinalize: (callback: (finalize: WorkspaceCloseFinalize) => void) => () => void; // workspace-close-finalize
        setWorkspaceSurface: (surface: WorkspaceSurfaceState) => void; // workspace-surface
        setWorkspaceOverlayVisible: (visible: boolean) => void; // workspace-overlay-visible
        onTerminalSurfaceStatus: (callback: (status: TerminalSurfaceStatus) => void) => () => void; // terminal-surface-status
        onWaveInit: (callback: (initOpts: WaveInitOpts) => void) => void; // wave-init
        onBuilderInit: (callback: (initOpts: BuilderInitOpts) => void) => void; // builder-init
        sendLog: (log: string) => void; // fe-log
        onQuicklook: (filePath: string) => void; // quicklook
        openNativePath(filePath: string): void; // open-native-path
        captureScreenshot(rect: Electron.Rectangle): Promise<string>; // capture-screenshot
        setKeyboardChordMode: () => void; // set-keyboard-chord-mode
        clearWebviewStorage: (webContentsId: number) => Promise<void>; // clear-webview-storage
        setWaveAIOpen: (isOpen: boolean) => void; // set-waveai-open
        closeBuilderWindow: () => void; // close-builder-window
        incrementTermCommands: (opts?: { isRemote?: boolean; isWsl?: boolean; isDurable?: boolean }) => void; // increment-term-commands
        nativePaste: () => void; // native-paste
        openBuilder: (appId?: string) => void; // open-builder
        setBuilderWindowAppId: (appId: string) => void; // set-builder-window-appid
        doRefresh: () => void; // do-refresh
        getPathForFile: (file: File) => string; // webUtils.getPathForFile
        saveTextFile: (fileName: string, content: string) => Promise<boolean>; // save-text-file
        setIsActive: () => Promise<void>; // set-is-active
        watchDir: (path: string, callback: (eventType: string, filename: string) => void) => void;
        unwatchDir: (path: string, callback?: (eventType: string, filename: string) => void) => void;
        // AI config / provider model listing IPC. See emain/aiconfig-ipc.ts.
        // Replaces the deleted Go ListProviderModelsCommand /
        // Get|WriteAIUserConfigCommand wshrpcs.
        //
        // Configs are typed as `unknown` here so this ambient surface
        // doesn't depend on the renderer's AIUserConfig shape (defined
        // in frontend/app/store/ai-types.ts). Callers cast at the
        // boundary, where the concrete type is already in scope.
        ai: {
            listProviderModels: (input: ListProviderModelsInput) => Promise<AiProviderModelInfo[]>;
            listRegistryModels: (provider: string) => Promise<RegistryModelInfo[]>;
            refreshRegistryModels: (provider: string) => Promise<RegistryModelInfo[]>;
            onRegistryModelsRefreshed: (callback: (providerId: string) => void) => () => void;
            getUserConfig: () => Promise<AIUserConfigReadResult>;
            writeUserConfig: (cfg: unknown) => Promise<void>;
        };
        // Agent runtime IPC. See emain/agent-ipc.ts + docs/agent-runtime-architecture.md.
        // Event payloads are pi AgentHarnessEvent shapes (text deltas, tool calls,
        // turn boundaries, etc.); usePiChat (task #12) wraps them into React state.
        agent: {
            createSession: (context: WorkspaceAgentRequestContext) => Promise<AgentSessionMeta>;
            listSessions: (context: WorkspaceAgentRequestContext) => Promise<AgentSessionMeta[]>;
            listSessionDetails: (
                context: WorkspaceAgentRequestContext,
                limit?: number
            ) => Promise<AgentSessionDetail[]>;
            listCommands: (context: WorkspaceAgentRequestContext) => Promise<AgentCommandInfo[]>; // agent:list-commands
            getSessionState: (
                context: WorkspaceAgentRequestContext,
                sessionMetadata: AgentSessionMeta
            ) => Promise<unknown>; // agent:get-session-state
            inspectContext: (
                context: WorkspaceAgentRequestContext,
                options: AgentInspectContextOptions
            ) => Promise<AgentInspectContextResult>; // agent:inspect-context
            listTree: (
                context: WorkspaceAgentRequestContext,
                sessionMetadata: AgentSessionMeta
            ) => Promise<AgentTreeResult>; // agent:list-tree
            listForkPoints: (
                context: WorkspaceAgentRequestContext,
                sessionMetadata: AgentSessionMeta
            ) => Promise<AgentForkPointView[]>; // agent:list-fork-points
            navigateTree: (
                context: WorkspaceAgentRequestContext,
                input: AgentNavigateTreeInput
            ) => Promise<AgentNavigateTreeResult>; // agent:navigate-tree
            forkSession: (
                context: WorkspaceAgentRequestContext,
                input: AgentForkSessionInput
            ) => Promise<AgentForkSessionResult>; // agent:fork-session
            cloneSession: (
                context: WorkspaceAgentRequestContext,
                input: AgentCloneSessionInput
            ) => Promise<AgentCloneSessionResult>; // agent:clone-session
            runCommand: (
                context: WorkspaceAgentRequestContext,
                input: AgentRunCommandInput
            ) => Promise<AgentCommandExecutionResult>; // agent:run-command
            prepareContextDraft: (
                context: WorkspaceAgentRequestContext,
                input: AgentPrepareContextDraftInput
            ) => Promise<AgentPrepareContextDraftResult>;
            summarizeContextDraft: (
                context: WorkspaceAgentRequestContext,
                input: AgentSummarizeContextDraftInput
            ) => Promise<AgentSummarizeContextDraftResult>;
            discardContextDraft: (
                context: WorkspaceAgentRequestContext,
                input: AgentDiscardContextDraftInput
            ) => Promise<AgentDiscardContextDraftResult>;
            listReferencePoints: (
                context: WorkspaceAgentRequestContext,
                input: AgentListReferencePointsInput
            ) => Promise<AgentReferencePointView[]>;
            listContextState: (
                context: WorkspaceAgentRequestContext,
                input: AgentListContextStateInput
            ) => Promise<AgentContextState>;
            commandRead: (
                context: WorkspaceAgentRequestContext,
                sessionMetadata: AgentSessionMeta,
                input: { commandId: string }
            ) => Promise<AgentPtySnapshot>; // agent:command-read
            commandWrite: (
                context: WorkspaceAgentRequestContext,
                sessionMetadata: AgentSessionMeta,
                input: { commandId: string; input: string }
            ) => Promise<void>; // agent:command-write
            commandResize: (
                context: WorkspaceAgentRequestContext,
                sessionMetadata: AgentSessionMeta,
                input: { commandId: string; cols: number; rows: number }
            ) => Promise<void>; // agent:command-resize
            commandStop: (
                context: WorkspaceAgentRequestContext,
                sessionMetadata: AgentSessionMeta,
                input: { commandId: string }
            ) => Promise<void>; // agent:command-stop
            renameSession: (
                context: WorkspaceAgentRequestContext,
                input: { sessionMetadata: AgentSessionMeta; name: string }
            ) => Promise<void>; // agent:rename-session
            archiveSession: (
                context: WorkspaceAgentRequestContext,
                sessionMetadata: AgentSessionMeta
            ) => Promise<AgentSessionMeta>; // agent:archive-session
            deleteSession: (context: WorkspaceAgentRequestContext, sessionMetadata: AgentSessionMeta) => Promise<void>; // agent:delete-session
            send: (
                context: WorkspaceAgentRequestContext,
                opts: AgentSendOptions
            ) => Promise<{ sessionMetadata: AgentSessionMeta; turnId: string }>;
            abort: (context: WorkspaceAgentRequestContext, sessionPath: string) => Promise<void>;
            /** Subscribe to events for one session. Returns an unsubscribe fn. */
            subscribe: (
                context: WorkspaceAgentRequestContext,
                sessionPath: string,
                callback: (event: unknown) => void
            ) => () => void;
        };
        agentObservability: {
            listTraces: (sessionId: string) => Promise<Trace[]>;
            getTrace: (traceId: string, sessionId: string) => Promise<TraceDetail | undefined>;
            subscribe: (sessionId: string, callback: (event: TraceEvent) => void) => () => void;
        };
    };

    type WorkspaceCloseRequest = { requestid: string; reason: "window" | "workspace" | "quit" };
    type WorkspaceCloseResponse = { requestid: string; allow: boolean };
    type WorkspaceCloseFinalize = { requestid: string; commit: boolean };

    type TraceStatus = "running" | "success" | "error" | "aborted";

    type Trace = {
        id: string;
        name: string | null;
        timestamp: string;
        environment: string;
        tags: string[];
        release: string | null;
        version: string | null;
        input: unknown;
        output: unknown;
        metadata: Record<string, unknown>;
        sessionId: string | null;
        userId: string | null;
        status: TraceStatus;
        endedAt?: string;
    };

    type Observation = {
        id: string;
        traceId: string;
        type:
            | "SPAN"
            | "EVENT"
            | "GENERATION"
            | "AGENT"
            | "TOOL"
            | "CHAIN"
            | "RETRIEVER"
            | "EVALUATOR"
            | "EMBEDDING"
            | "GUARDRAIL";
        name: string | null;
        startTime: string;
        endTime: string | null;
        parentObservationId: string | null;
        level: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
        statusMessage: string | null;
        version: string | null;
        model: string | null;
        input: unknown;
        output: unknown;
        metadata: Record<string, unknown>;
        latency: number | null;
        timeToFirstToken: number | null;
        usageDetails: Record<string, number>;
        costDetails: Record<string, number>;
        toolCalls: string[] | null;
        toolCallNames: string[] | null;
    };

    type Score = {
        id: string;
        traceId: string;
        observationId: string | null;
        name: string;
        source: "API" | "EVAL" | "ANNOTATION";
        dataType: "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "CORRECTION" | "TEXT";
        value: unknown;
        comment: string | null;
    };

    type TraceDetail = {
        trace: Trace;
        observations: Observation[];
        scores: Score[];
        corrections: Score[];
    };

    type TraceEvent = {
        traceId: string;
        sessionId?: string;
        detail: TraceDetail;
    };

    type AIUserConfigReadResult = {
        status: "ok" | "missing" | "malformed";
        // Renderer casts to its own UserConfig type on receive.
        config?: unknown;
        error?: string;
    };

    type ListProviderModelsInput = {
        apitype: string;
        baseurl?: string;
        apitoken?: string;
        tokensecretname?: string;
        // Optional override for the /models endpoint. Used by minimax
        // (and other Anthropic-compatible providers) whose model list
        // lives on a separate path from the chat URL. See
        // ProviderEntry.modelsEndpoint in ai-catalog.ts.
        modelsendpoint?: string;
    };

    type AiProviderModelInfo = {
        id: string;
        name?: string;
        description?: string;
        context?: number;
        maxoutputtokens?: number;
        promptcost?: number;
        completioncost?: number;
        imagecost?: number;
        requestcost?: number;
        inputmodalities?: string[];
        tokenizer?: string;
        ismoderated?: boolean;
        reasoning?: boolean;
        supportstools?: boolean;
    };

    type RegistryModelInfo = {
        id: string;
        name?: string;
        reasoning: boolean;
        supportstools?: boolean;
        thinkinglevels: string[];
        inputmodalities: string[];
        context?: number;
        maxoutputtokens?: number;
        promptcost?: number;
        completioncost?: number;
    };

    type AgentContextSourceKind = "turn" | "session";
    type AgentContextDeliveryScope = "message" | "conversation";
    type AgentContextRepresentation = "full" | "summary";
    type AgentContextRenderedRepresentation = AgentContextRepresentation | "attention";
    type AgentContextBudgetStatus = "fits" | "references_over_budget" | "base_over_budget" | "counter_unavailable";
    type AgentContextCountAccuracy = "exact" | "conservative_upper_bound" | "estimated";

    type AgentContextProvenanceView = {
        sourceKind: AgentContextSourceKind;
        sourceSessionId: string;
        sourceSessionPath: string;
        sourceSessionTitle?: string;
        sourceCwd: string;
        sourceTurnId?: string;
        sourceLeafId: string | null;
        sourceMessageEntryIds: string[];
        preview: string;
        capturedAt: string;
    };

    type AgentContextDraftView = {
        draftId: string;
        targetSessionPath: string;
        provenance: AgentContextProvenanceView;
        summaryStatus: "none" | "summarizing" | "ready" | "failed";
        expiresAt: string;
    };

    type AgentContextProjectionItemReportView = {
        attachmentEntryId: string;
        artifactEntryId?: string;
        sourceKind?: AgentContextSourceKind;
        sourceSessionId?: string;
        sourceSessionTitle?: string;
        sourceTurnId?: string;
        sourcePreview?: string;
        deliveryScope: AgentContextDeliveryScope;
        requestedRepresentation?: AgentContextRepresentation;
        renderedRepresentation: AgentContextRenderedRepresentation;
        advisoryTokens: number;
        reason: "selected" | "already_present";
    };

    type AgentContextProjectionReportView = {
        schemaVersion: 1;
        transactionId: string;
        targetTurnId: string;
        createdAt: string;
        contextWindow: number;
        effectiveOutputReserve: number;
        inputLimit: number;
        baseInputTokens: number;
        finalInputTokens: number;
        referenceTokens: number;
        countAccuracy: AgentContextCountAccuracy;
        maxReferenceTokens?: number;
        overlaySha256: string;
        items: AgentContextProjectionItemReportView[];
    };

    type AgentContextBudgetItemView = {
        attachmentEntryId?: string;
        draftId?: string;
        representation: AgentContextRenderedRepresentation;
        advisoryTokens: number;
    };

    type AgentContextState = {
        drafts: AgentContextDraftView[];
        contextReports: AgentContextProjectionReportView[];
    };

    type AgentPrepareContextDraftInput = {
        targetSessionPath: string;
        sourceSessionPath: string;
        sourceKind: AgentContextSourceKind;
        sourceTurnId?: string;
    };

    type AgentPrepareContextDraftResult = AgentContextDraftView;

    type AgentSummarizeContextDraftInput = {
        targetSessionPath: string;
        draftId: string;
    };

    type AgentSummarizeContextDraftResult = AgentContextDraftView;

    type AgentDiscardContextDraftInput = {
        targetSessionPath: string;
        draftId: string;
    };

    type AgentDiscardContextDraftResult = {
        discarded: boolean;
    };

    type AgentListContextStateInput = {
        targetSessionPath: string;
    };

    type AgentContextAttachmentDraftInput = {
        draftId: string;
        deliveryScope: AgentContextDeliveryScope;
        requestedRepresentation: AgentContextRepresentation;
    };

    type AgentListReferencePointsInput = {
        sourceSessionPath: string;
    };

    type AgentReferencePointView = {
        entryId: string;
        preview: string;
        timestamp?: string;
    };

    type WorkspaceAgentRequestContext = {
        workspaceId: string;
        generation: number;
    };

    type AgentExecutionContext = {
        workspaceId: string;
        workspaceDir: string;
        sessionPath?: string;
        environment: Record<string, string>;
        gitBranch?: string;
    };

    type AgentPtySnapshot = {
        commandId: string;
        command: string;
        cwd: string;
        tail: string;
        screen: {
            rows: Array<{ text: string; cells: Array<{ char: string }> }>;
            cursor: {
                row: number;
                col: number;
                visible: boolean;
                shape: "block" | "underline" | "bar";
                blink: boolean;
            };
            isAltScreenActive: boolean;
        };
        running: boolean;
        exitCode?: number;
        cols: number;
        rows: number;
        needsUserInput: boolean;
    };

    type AgentSendOptions = {
        /** Existing session metadata, or null to have main mint a new one. */
        sessionMetadata?: AgentSessionMeta | null;
        context: AgentExecutionContext;
        text: string;
        images?: string[];
        provider: string;
        model: string;
        reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
        /**
         * Credential reference from the renderer's ai-resolver. Main turns
         * these into the provider API key (literal token, else a
         * secretstore lookup) — the plaintext key never round-trips.
         */
        token?: string;
        tokenSecretName?: string;
        /**
         * Per-pane tool allowlist. Optional — when omitted, main defaults
         * to allowAll (no UX-gated approval in v1). See
         * packages/coding-agent/permissions.ts and the architecture doc §7.9.
         */
        allowedTools?: string[];
        /** Ordered composer references. Main validates ownership and representation. */
        contextAttachments?: AgentContextAttachmentDraftInput[];
    };

    type AgentInspectContextOptions = Omit<AgentSendOptions, "text" | "images" | "contextAttachments"> & {
        sessionMetadata?: AgentSessionMeta;
    };

    type AgentContextSnapshotLifecycleView =
        | "ready"
        | "in_use"
        | "waiting_for_tool"
        | "updating"
        | "out_of_date"
        | "unavailable";
    type AgentContextSnapshotAccuracyView = "exact" | "estimated" | "unavailable";
    type AgentContextSnapshotCategoryView = "agent_instructions" | "tools" | "conversation" | "added_context";
    type AgentContextSnapshotItemView = {
        id: string;
        category: AgentContextSnapshotCategoryView;
        kind: string;
        title: string;
        preview: string;
        content?: unknown;
        tokens?: number;
        tokenAccuracy: "estimated" | "unavailable";
        source: {
            entryIds?: string[];
            path?: string;
            skillName?: string;
            toolName?: string;
            toolCallId?: string;
            pairedResultEntryId?: string;
            coveredEntryIds?: string[];
            attachmentEntryId?: string;
            artifactEntryId?: string;
        };
        children?: AgentContextSnapshotItemView[];
        diagnostic?: string;
    };
    type AgentContextSnapshotView = {
        schemaVersion: 1;
        identity: {
            sessionPath?: string;
            sessionId?: string;
            leafId: string | null;
            modelKey: string;
            revision: number;
        };
        generatedAt: string;
        lifecycle: AgentContextSnapshotLifecycleView;
        accuracy: AgentContextSnapshotAccuracyView;
        modelLabel: string;
        contextWindow: number;
        outputReserve: number;
        inputCapacity: number;
        effectiveInputTokens?: number;
        remainingInputTokens?: number;
        requestOverheadTokens?: number;
        attributionDeltaTokens?: number;
        categories: Array<{ category: AgentContextSnapshotCategoryView; tokens?: number; itemCount: number }>;
        items: AgentContextSnapshotItemView[];
        diagnostic?: string;
    };
    type AgentInspectContextResult = { snapshot: AgentContextSnapshotView };

    type AgentCommandSource = "builtin" | "skill" | "prompt";

    type AgentBackendCommandName =
        | "tree"
        | "fork"
        | "clone"
        | "new"
        | "resume"
        | "compact"
        | "session"
        | "info"
        | "copy"
        | "export"
        | "import"
        | "reload";

    type AgentCommandAction =
        | { type: "backend"; command: AgentBackendCommandName }
        | { type: "frontend"; action: "openModelPicker" };

    type AgentCommandInfo = {
        name: string;
        description: string;
        argumentHint?: string;
        source: AgentCommandSource;
        action: AgentCommandAction;
    };

    type AgentTreeEntryView = {
        id: string;
        parentId?: string;
        type: string;
        role?: string;
        label?: string;
        stopReason?: string;
        preview: string;
        timestamp?: string;
        isLeaf: boolean;
        isCurrent: boolean;
        referenceable?: boolean;
    };

    type AgentForkPointView = {
        entryId: string;
        preview: string;
        timestamp?: string;
    };

    type AgentSessionDetail = AgentSessionMeta & {
        parentSessionPath?: string;
        modifiedAt: string;
        name?: string;
        messageCount: number;
        firstMessage: string;
        previewText: string;
    };

    type AgentTreeResult = {
        entries: AgentTreeEntryView[];
        leafId: string | null;
    };

    type AgentNavigateTreeInput = {
        sessionMetadata: AgentSessionMeta;
        targetId: string;
    };

    type AgentNavigateTreeResult = {
        sessionMetadata: AgentSessionMeta;
        editorText?: string;
    };

    type AgentForkSessionInput = {
        sessionMetadata: AgentSessionMeta;
        entryId: string;
    };

    type AgentForkSessionResult = {
        sessionMetadata: AgentSessionMeta;
        selectedText?: string;
    };

    type AgentCloneSessionInput = {
        sessionMetadata: AgentSessionMeta;
    };

    type AgentCloneSessionResult = {
        sessionMetadata?: AgentSessionMeta;
        message?: string;
    };

    type AgentCommandExecutionStatus = "success" | "noop";

    type AgentCommandExecutionResult = {
        status: AgentCommandExecutionStatus;
        message: string;
        sessionMetadata?: AgentSessionMeta;
        managerMode?: "session";
    };

    type AgentRunCommandInput = {
        sessionMetadata?: AgentSessionMeta;
        command: AgentBackendCommandName;
        argsText: string;
    };

    type ElectronContextMenuItem = {
        id: string; // unique id, used for communication
        label: string;
        role?: string; // electron role (optional)
        type?: "separator" | "normal" | "submenu" | "checkbox" | "radio" | "header";
        submenu?: ElectronContextMenuItem[];
        checked?: boolean;
        visible?: boolean;
        enabled?: boolean;
        sublabel?: string;
    };

    type ContextMenuItem = {
        label?: string;
        type?: "separator" | "normal" | "submenu" | "checkbox" | "radio" | "header";
        role?: string; // electron role (optional)
        click?: () => void; // not required if role is set
        submenu?: ContextMenuItem[];
        checked?: boolean;
        visible?: boolean;
        enabled?: boolean;
        sublabel?: string;
    };

    type KeyPressDecl = {
        mods: {
            Cmd?: boolean;
            Option?: boolean;
            Shift?: boolean;
            Ctrl?: boolean;
            Alt?: boolean;
            Meta?: boolean;
        };
        key: string;
        keyType: string;
    };

    type SubjectWithRef<T> = rxjs.Subject<T> & { refCount: number; release: () => void };

    type HeaderElem =
        | IconButtonDecl
        | ToggleIconButtonDecl
        | HeaderText
        | HeaderInput
        | HeaderDiv
        | HeaderTextButton
        | ConnectionButton
        | MenuButton;

    type IconButtonCommon = {
        icon: string | React.ReactNode;
        iconColor?: string;
        iconSpin?: boolean;
        className?: string;
        title?: string;
        disabled?: boolean;
        noAction?: boolean;
    };

    type IconButtonDecl = IconButtonCommon & {
        elemtype: "iconbutton";
        click?: (e: React.MouseEvent<any>) => void;
        longClick?: (e: React.MouseEvent<any>) => void;
    };

    type ToggleIconButtonDecl = IconButtonCommon & {
        elemtype: "toggleiconbutton";
        active: jotai.WritableAtom<boolean, [boolean], void>;
    };

    type HeaderTextButton = {
        elemtype: "textbutton";
        text: string;
        className?: string;
        title?: string;
        onClick?: (e: React.MouseEvent<any>) => void;
    };

    type HeaderText = {
        elemtype: "text";
        text: string;
        ref?: React.RefObject<HTMLDivElement>;
        className?: string;
        noGrow?: boolean;
        onClick?: (e: React.MouseEvent<any>) => void;
    };

    type HeaderInput = {
        elemtype: "input";
        value: string;
        className?: string;
        isDisabled?: boolean;
        ref?: React.RefObject<HTMLInputElement>;
        onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
        onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
        onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
        onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
    };

    type HeaderDiv = {
        elemtype: "div";
        className?: string;
        children: HeaderElem[];
        onMouseOver?: (e: React.MouseEvent<any>) => void;
        onMouseOut?: (e: React.MouseEvent<any>) => void;
        onClick?: (e: React.MouseEvent<any>) => void;
    };

    type ConnectionButton = {
        elemtype: "connectionbutton";
        icon: string;
        text: string;
        iconColor: string;
        onClick?: (e: React.MouseEvent<any>) => void;
        connected: boolean;
    };

    type MenuItem = {
        label: string;
        icon?: string | React.ReactNode;
        subItems?: MenuItem[];
        onClick?: (e: React.MouseEvent<any>) => void;
    };

    type MenuButtonProps = {
        items: MenuItem[];
        className?: string;
        text: string;
        title?: string;
        menuPlacement?: Placement;
    };

    type MenuButton = {
        elemtype: "menubutton";
    } & MenuButtonProps;

    type SearchAtoms = {
        searchValue: PrimitiveAtom<string>;
        resultsIndex: PrimitiveAtom<number>;
        resultsCount: PrimitiveAtom<number>;
        isOpen: PrimitiveAtom<boolean>;
        focusInput: PrimitiveAtom<number>;
        regex?: PrimitiveAtom<boolean>;
        caseSensitive?: PrimitiveAtom<boolean>;
        wholeWord?: PrimitiveAtom<boolean>;
    };

    declare type ViewComponentProps<T extends ViewModel> = {
        blockId: string;
        blockRef: React.RefObject<HTMLDivElement>;
        contentRef: React.RefObject<HTMLDivElement>;
        model: T;
    };

    declare type ViewComponent = React.FC<ViewComponentProps>;

    type ViewModelInitType = {
        blockId: string;
        nodeModel: BlockNodeModel;
        tabModel: TabModel;
        waveEnv: WaveEnv;
    };

    type ViewModelClass = new (initOpts: ViewModelInitType) => ViewModel;

    interface ViewModel {
        // The type of view, used for identifying and rendering the appropriate component.
        viewType: string;

        useTermHeader?: jotai.Atom<boolean>;

        hideViewName?: jotai.Atom<boolean>;

        // Icon representing the view, can be a string or an IconButton declaration.
        viewIcon?: jotai.Atom<string | IconButtonDecl>;

        // Display name for the view, used in UI headers.
        viewName?: jotai.Atom<string>;

        // Optional header text or elements for the view.
        viewText?: jotai.Atom<string | HeaderElem[]>;

        termDurableStatus?: jotai.Atom<BlockJobStatusData | null>;
        termConfigedDurable?: jotai.Atom<null | boolean>;

        // Icon button displayed before the title in the header.
        preIconButton?: jotai.Atom<IconButtonDecl>;

        // Icon buttons displayed at the end of the block header.
        endIconButtons?: jotai.Atom<IconButtonDecl[]>;

        // Background styling metadata for the block.
        blockBg?: jotai.Atom<MetaType>;

        noHeader?: jotai.Atom<boolean>;

        // Whether the block manages its own connection (e.g., for remote access).
        manageConnection?: jotai.Atom<boolean>;

        // If true, filters out 'nowsh' connections (when managing connections)
        filterOutNowsh?: jotai.Atom<boolean>;

        // If true, removes padding inside the block content area.
        noPadding?: jotai.Atom<boolean>;

        // Atoms used for managing search functionality within the block.
        searchAtoms?: SearchAtoms;

        // The main view component associated with this ViewModel.
        viewComponent: ViewComponent<ViewModel>;

        // Function to determine if this is a basic terminal block.
        isBasicTerm?: (getFn: jotai.Getter) => boolean;

        // Returns menu items for the settings dropdown.
        getSettingsMenuItems?: () => ContextMenuItem[];

        // Attempts to give focus to the block, returning true if successful.
        giveFocus?: () => boolean;

        // Handles keydown events within the block.
        keyDownHandler?: (e: WaveKeyboardEvent) => boolean;

        // Cleans up resources when the block is disposed.
        dispose?: () => void;
    }

    type UpdaterStatus = "up-to-date" | "checking" | "downloading" | "ready" | "error" | "installing";

    // jotai doesn't export this type :/
    type Loadable<T> = { state: "loading" } | { state: "hasData"; data: T } | { state: "hasError"; error: unknown };

    interface Dimensions {
        width: number;
        height: number;
        left: number;
        top: number;
    }

    type TypeAheadModalType = { [key: string]: boolean };

    interface AboutModalDetails {
        version: string;
        buildTime: number;
    }

    type BlockComponentModel = {
        openSwitchConnection?: () => void;
        viewModel: ViewModel;
    };

    type ConnStatusType = "connected" | "connecting" | "disconnected" | "error" | "init";

    interface SuggestionBaseItem {
        label: string;
        value: string;
        icon?: string | React.ReactNode;
    }

    interface SuggestionConnectionItem extends SuggestionBaseItem {
        status: ConnStatusType;
        iconColor: string;
        onSelect?: (_: string) => void;
        current?: boolean;
    }

    interface SuggestionConnectionScope {
        headerText?: string;
        items: SuggestionConnectionItem[];
    }

    type SuggestionsType = SuggestionConnectionItem | SuggestionConnectionScope;

    type MarkdownResolveOpts = {
        connName: string;
        baseDir: string;
    };

    interface AbstractWshClient {
        recvRpcMessage(msg: RpcMessage): void;
    }

    type ClientRpcEntry = {
        reqId: string;
        startTs: number;
        command: string;
        msgFn: (msg: RpcMessage) => void;
    };

    type TimeSeriesMeta = {
        name?: string;
        color?: string;
        label?: string;
        maxy?: string | number;
        miny?: string | number;
        decimalPlaces?: number;
    };

    interface SuggestionRequestContext {
        widgetid: string;
        reqnum: number;
        dispose?: boolean;
    }

    type SuggestionsFnType = (query: string, reqContext: SuggestionRequestContext) => Promise<FetchSuggestionsResponse>;

    type DraggedFile = {
        uri: string;
        absParent: string;
        relName: string;
        isDir: boolean;
    };

    type ErrorButtonDef = {
        text: string;
        onClick: () => void;
    };

    type ErrorMsg = {
        status: string;
        text: string;
        level?: "error" | "warning";
        buttons?: Array<ErrorButtonDef>;
        closeAction?: () => void;
        showDismiss?: boolean;
    };

    type AIMessage = {
        messageid: string;
        parts: AIMessagePart[];
    };

    type AIMessagePart =
        | {
              type: "text";
              text: string;
          }
        | {
              type: "file";
              mimetype: string; // required
              filename?: string;
              data?: string; // base64 encoded data
              url?: string;
              size?: number;
              previewurl?: string;
          };
}

export {};
