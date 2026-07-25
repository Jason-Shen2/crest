import type { AIUserConfigState } from "./ai-user-config";

export interface ContextReferenceUiConfig {
    enabled: boolean;
    maxTokens?: number;
    unavailableReason?: "loading" | "setup_required" | "config_error";
    errorMessage?: string;
}

export function resolveContextReferenceUiConfig(state: AIUserConfigState): ContextReferenceUiConfig {
    if (state.status === "loading") {
        return { enabled: false, unavailableReason: "loading" };
    }
    if (state.status === "malformed" || state.status === "rpc_error") {
        return {
            enabled: false,
            unavailableReason: "config_error",
            ...(state.error ? { errorMessage: state.error } : {}),
        };
    }
    if (state.status === "missing" || state.config == null) {
        return { enabled: false, unavailableReason: "setup_required" };
    }

    const references = state.config.context_references;
    return {
        enabled: references?.enabled !== false,
        ...(references?.max_tokens == null ? {} : { maxTokens: references.max_tokens }),
    };
}

export interface ContextReferenceDraftState {
    view: AgentContextDraftView;
    deliveryScope: AgentContextDeliveryScope;
    requestedRepresentation: AgentContextRepresentation;
    status: "ready" | "summarizing" | "sending" | "error";
    errorMessage?: string;
}

export interface ContextReferenceTargetIdentity {
    targetSessionPath?: string;
    targetGeneration: number;
}

export interface ContextReferenceSendCapture extends ContextReferenceTargetIdentity {
    captureId: string;
    attachments: AgentContextAttachmentDraftInput[];
}

export interface ContextReferenceRendererState extends ContextReferenceTargetIdentity {
    drafts: ContextReferenceDraftState[];
    reportsByTurn: Record<string, AgentContextProjectionReportView>;
    sendCapturesById: Record<string, ContextReferenceSendCapture>;
    enabled: boolean;
}

export type ContextReferenceSendDisabledReason = "feature_disabled" | "summary_not_ready" | "references_sending";

type TargetedAction = ContextReferenceTargetIdentity;

export type ContextReferenceAction =
    | { type: "target_changed"; targetSessionPath?: string }
    | { type: "enabled_changed"; enabled: boolean }
    | ({
          type: "draft_prepared";
          view: AgentContextDraftView;
          deliveryScope?: AgentContextDeliveryScope;
          requestedRepresentation?: AgentContextRepresentation;
      } & TargetedAction)
    | ({ type: "draft_discarded"; draftId: string } & TargetedAction)
    | {
          type: "draft_choice_changed";
          draftId: string;
          deliveryScope?: AgentContextDeliveryScope;
          requestedRepresentation?: AgentContextRepresentation;
      }
    | { type: "summary_began"; draftId: string }
    | ({ type: "summary_succeeded"; draftId: string; view: AgentContextDraftView } & TargetedAction)
    | ({ type: "summary_failed"; draftId: string; errorMessage: string } & TargetedAction)
    | ({ type: "send_began"; captureId: string; draftIds: string[] } & TargetedAction)
    | ({ type: "send_succeeded"; captureId: string } & TargetedAction)
    | ({ type: "send_failed"; captureId: string; errorMessage: string } & TargetedAction)
    | ({ type: "authoritative_state_received"; reports: AgentContextProjectionReportView[] } & TargetedAction)
    | ({ type: "projection_received"; report: AgentContextProjectionReportView } & TargetedAction);

export function createContextReferenceState(targetSessionPath?: string): ContextReferenceRendererState {
    return {
        targetSessionPath,
        targetGeneration: 0,
        drafts: [],
        reportsByTurn: {},
        sendCapturesById: {},
        enabled: true,
    };
}

export function contextTargetIdentity(state: ContextReferenceRendererState): ContextReferenceTargetIdentity {
    return {
        targetSessionPath: state.targetSessionPath,
        targetGeneration: state.targetGeneration,
    };
}

export function contextAttachmentsForSend(drafts: ContextReferenceDraftState[]): AgentContextAttachmentDraftInput[] {
    return drafts
        .filter((draft) => draft.status === "ready" || draft.status === "error")
        .map((draft) => ({
            draftId: draft.view.draftId,
            deliveryScope: draft.deliveryScope,
            requestedRepresentation: draft.requestedRepresentation,
        }));
}

export function contextSendDisabledReason(
    state: ContextReferenceRendererState
): ContextReferenceSendDisabledReason | undefined {
    const visibleDrafts = state.drafts.filter((draft) => draft.status !== "sending");
    if (visibleDrafts.length === 0) {
        return state.drafts.some((draft) => draft.status === "sending") ? "references_sending" : undefined;
    }
    if (!state.enabled) {
        return "feature_disabled";
    }
    if (
        visibleDrafts.some(
            (draft) =>
                draft.status === "summarizing" ||
                (draft.requestedRepresentation === "summary" && draft.view.summaryStatus !== "ready")
        )
    ) {
        return "summary_not_ready";
    }
}

export function reduceContextReferenceState(
    state: ContextReferenceRendererState,
    action: ContextReferenceAction
): ContextReferenceRendererState {
    switch (action.type) {
        case "target_changed":
            if (action.targetSessionPath === state.targetSessionPath) {
                return state;
            }
            return {
                ...createContextReferenceState(action.targetSessionPath),
                targetGeneration: state.targetGeneration + 1,
                enabled: state.enabled,
            };
        case "enabled_changed":
            return action.enabled === state.enabled ? state : { ...state, enabled: action.enabled };
        case "draft_prepared":
            return addPreparedDraft(state, action);
        case "draft_discarded":
            if (!matchesTarget(state, action)) {
                return state;
            }
            return { ...state, drafts: state.drafts.filter((draft) => draft.view.draftId !== action.draftId) };
        case "draft_choice_changed":
            return updateDraft(state, action.draftId, (draft) => {
                if (draft.status !== "ready" && draft.status !== "error") {
                    return draft;
                }
                const requestedRepresentation =
                    action.requestedRepresentation === "summary" && draft.view.summaryStatus !== "ready"
                        ? draft.requestedRepresentation
                        : (action.requestedRepresentation ?? draft.requestedRepresentation);
                return {
                    ...draft,
                    deliveryScope: action.deliveryScope ?? draft.deliveryScope,
                    requestedRepresentation,
                    status: "ready",
                    errorMessage: undefined,
                };
            });
        case "summary_began":
            return updateDraft(state, action.draftId, (draft) => ({
                ...draft,
                requestedRepresentation: "summary",
                status: "summarizing",
                errorMessage: undefined,
            }));
        case "summary_succeeded":
            if (!matchesTarget(state, action) || action.view.summaryStatus !== "ready") {
                return state;
            }
            return updateDraft(state, action.draftId, (draft) => ({
                ...draft,
                view: action.view,
                requestedRepresentation: "summary",
                status: "ready",
                errorMessage: undefined,
            }));
        case "summary_failed":
            if (!matchesTarget(state, action)) {
                return state;
            }
            return updateDraft(state, action.draftId, (draft) => ({
                ...draft,
                status: "error",
                errorMessage: action.errorMessage,
            }));
        case "send_began":
            return beginSend(state, action);
        case "send_succeeded":
            return completeSend(state, action, true);
        case "send_failed":
            return completeSend(state, action, false);
        case "authoritative_state_received":
            if (!matchesTarget(state, action)) {
                return state;
            }
            return { ...state, reportsByTurn: reportsByTurn(action.reports) };
        case "projection_received":
            if (!matchesTarget(state, action)) {
                return state;
            }
            return {
                ...state,
                reportsByTurn: {
                    ...state.reportsByTurn,
                    [action.report.targetTurnId]: action.report,
                },
            };
    }
}

function addPreparedDraft(
    state: ContextReferenceRendererState,
    action: Extract<ContextReferenceAction, { type: "draft_prepared" }>
): ContextReferenceRendererState {
    if (
        !matchesTarget(state, action) ||
        action.view.targetSessionPath !== state.targetSessionPath ||
        state.drafts.some((draft) => draft.view.draftId === action.view.draftId)
    ) {
        return state;
    }
    const requestedRepresentation = action.requestedRepresentation ?? "full";
    return {
        ...state,
        drafts: [
            ...state.drafts,
            {
                view: action.view,
                deliveryScope: action.deliveryScope ?? "message",
                requestedRepresentation,
                status:
                    requestedRepresentation === "summary" && action.view.summaryStatus !== "ready"
                        ? "summarizing"
                        : "ready",
            },
        ],
    };
}

function beginSend(
    state: ContextReferenceRendererState,
    action: Extract<ContextReferenceAction, { type: "send_began" }>
): ContextReferenceRendererState {
    if (!matchesTarget(state, action) || state.sendCapturesById[action.captureId]) {
        return state;
    }
    const requestedIds = new Set(action.draftIds);
    const attachments = contextAttachmentsForSend(state.drafts.filter((draft) => requestedIds.has(draft.view.draftId)));
    const capturedIds = new Set(attachments.map((attachment) => attachment.draftId));
    return {
        ...state,
        drafts: state.drafts.map((draft) =>
            capturedIds.has(draft.view.draftId)
                ? { ...draft, status: "sending" as const, errorMessage: undefined }
                : draft
        ),
        sendCapturesById: {
            ...state.sendCapturesById,
            [action.captureId]: {
                captureId: action.captureId,
                targetSessionPath: state.targetSessionPath,
                targetGeneration: state.targetGeneration,
                attachments,
            },
        },
    };
}

function completeSend(
    state: ContextReferenceRendererState,
    action:
        | Extract<ContextReferenceAction, { type: "send_succeeded" }>
        | Extract<ContextReferenceAction, { type: "send_failed" }>,
    succeeded: boolean
): ContextReferenceRendererState {
    if (!matchesTarget(state, action)) {
        return state;
    }
    const capture = state.sendCapturesById[action.captureId];
    if (!capture || !matchesTarget(state, capture)) {
        return state;
    }
    const capturedIds = new Set(capture.attachments.map((attachment) => attachment.draftId));
    const drafts = succeeded
        ? state.drafts.filter((draft) => !capturedIds.has(draft.view.draftId))
        : state.drafts.map((draft) =>
              capturedIds.has(draft.view.draftId) && draft.status === "sending"
                  ? {
                        ...draft,
                        status: "error" as const,
                        errorMessage: "errorMessage" in action ? action.errorMessage : undefined,
                    }
                  : draft
          );
    const sendCapturesById = { ...state.sendCapturesById };
    delete sendCapturesById[action.captureId];
    return { ...state, drafts, sendCapturesById };
}

function updateDraft(
    state: ContextReferenceRendererState,
    draftId: string,
    update: (draft: ContextReferenceDraftState) => ContextReferenceDraftState
): ContextReferenceRendererState {
    return {
        ...state,
        drafts: state.drafts.map((draft) => (draft.view.draftId === draftId ? update(draft) : draft)),
    };
}

function matchesTarget(state: ContextReferenceTargetIdentity, candidate: ContextReferenceTargetIdentity): boolean {
    return (
        candidate.targetSessionPath === state.targetSessionPath && candidate.targetGeneration === state.targetGeneration
    );
}

function reportsByTurn(reports: AgentContextProjectionReportView[]): Record<string, AgentContextProjectionReportView> {
    return Object.fromEntries(reports.map((report) => [report.targetTurnId, report]));
}
