import {
	type AssistantMessage,
	type ImageContent,
	type Model,
	streamSimple,
	type TextContent,
	type UserMessage,
} from "@crest/ai";
import { runAgentLoop } from "../agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	QueueMode,
	StreamFn,
	ThinkingLevel,
} from "../types";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization";
import { compact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "./compaction/compaction";
import { convertToLlm } from "./messages";
import { formatPromptTemplateInvocation } from "./prompt-templates";
import { formatSkillInvocation } from "./skills";
import type {
	AbortResult,
	AgentHarnessEvent,
	AgentHarnessEventResultMap,
	AgentHarnessFollowUpOptions,
	AgentHarnessOptions,
	AgentHarnessOwnEvent,
	AgentHarnessPhase,
	AgentHarnessPreparedTurn,
	AgentHarnessPromptOptions,
	AgentHarnessProviderContextObservation,
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	AgentHarnessTurnPreparation,
	AgentHarnessTurnPreparationInput,
	ExecutionEnv,
	NavigateTreeResult,
	PendingSessionWrite,
	PromptTemplate,
	Session,
	SessionTreeEntry,
	Skill,
} from "./types";
import { buildSessionContext } from "./session/session";
import {
	AgentHarnessError,
	AgentHarnessTerminalPreparationError,
	BranchSummaryError,
	CompactionError,
	SessionError,
	toError,
} from "./types";

function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
	if (images) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}

function createFailureMessage(model: Model<any>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function cloneStreamOptions(streamOptions?: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		headers: streamOptions?.headers ? { ...streamOptions.headers } : undefined,
		metadata: streamOptions?.metadata ? { ...streamOptions.metadata } : undefined,
	};
}

function mergeHeaders(...headers: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
	const merged: Record<string, string> = {};
	let hasHeaders = false;
	for (const entry of headers) {
		if (!entry) continue;
		Object.assign(merged, entry);
		hasHeaders = true;
	}
	return hasHeaders ? merged : undefined;
}

function joinSystemPrompt(systemPrompt: string, suffix: string): string {
	if (suffix.length === 0) return systemPrompt;
	if (systemPrompt.length === 0) return suffix;
	return `${systemPrompt}\n\n${suffix}`;
}

function messageFingerprint(message: AgentMessage): string | undefined {
	try {
		return JSON.stringify(message);
	} catch {
		return undefined;
	}
}

function alignMessageEntryIds(
	sourceMessages: readonly AgentMessage[],
	sourceEntryIds: readonly (string | undefined)[],
	targetMessages: readonly AgentMessage[],
	knownEntryIds: WeakMap<object, string>,
): Array<string | undefined> {
	const consumed = new Set<number>();
	return targetMessages.map((target) => {
		const known = knownEntryIds.get(target as object);
		if (known) return known;
		let sourceIndex = sourceMessages.findIndex((source, index) => !consumed.has(index) && source === target);
		if (sourceIndex < 0) {
			const targetFingerprint = messageFingerprint(target);
			if (targetFingerprint != null) {
				sourceIndex = sourceMessages.findIndex(
					(source, index) => !consumed.has(index) && messageFingerprint(source) === targetFingerprint,
				);
			}
		}
		if (sourceIndex < 0) return undefined;
		consumed.add(sourceIndex);
		return sourceEntryIds[sourceIndex];
	});
}

function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch?: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);
	if (!patch) return result;

	if (Object.hasOwn(patch, "transport")) result.transport = patch.transport;
	if (Object.hasOwn(patch, "timeoutMs")) result.timeoutMs = patch.timeoutMs;
	if (Object.hasOwn(patch, "maxRetries")) result.maxRetries = patch.maxRetries;
	if (Object.hasOwn(patch, "maxRetryDelayMs")) result.maxRetryDelayMs = patch.maxRetryDelayMs;
	if (Object.hasOwn(patch, "cacheRetention")) result.cacheRetention = patch.cacheRetention;

	if (Object.hasOwn(patch, "headers")) {
		if (patch.headers === undefined) {
			result.headers = undefined;
		} else {
			const headers = { ...(result.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			result.headers = Object.keys(headers).length > 0 ? headers : undefined;
		}
	}

	if (Object.hasOwn(patch, "metadata")) {
		if (patch.metadata === undefined) {
			result.metadata = undefined;
		} else {
			const metadata = { ...(result.metadata ?? {}) };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			result.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
		}
	}

	return result;
}

const SUBSCRIBER_EVENT_TYPE = "*";

type AgentHarnessHandler = (event: any, signal?: AbortSignal) => Promise<any> | any;

function normalizeHarnessError(error: unknown, fallbackCode: AgentHarnessError["code"]): AgentHarnessError {
	if (error instanceof AgentHarnessError) return error;
	const cause = toError(error);
	if (cause instanceof SessionError) return new AgentHarnessError("session", cause.message, cause);
	if (cause instanceof CompactionError) return new AgentHarnessError("compaction", cause.message, cause);
	if (cause instanceof BranchSummaryError) return new AgentHarnessError("branch_summary", cause.message, cause);
	return new AgentHarnessError(fallbackCode, cause.message, cause);
}

function normalizeHookError(error: unknown): AgentHarnessError {
	return normalizeHarnessError(error, "hook");
}

interface AgentHarnessTurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	entries: SessionTreeEntry[];
	messages: AgentMessage[];
	messageEntryIds: Array<string | undefined>;
	providerMessageEntryIds?: Array<string | undefined>;
	leafId: string | null;
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
	systemPrompt: string;
	systemPromptMetadata?: unknown;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
}

interface InFlightFollowUpDrain {
	messages: UserMessage[];
	preparations: Array<AgentHarnessTurnPreparation | undefined>;
	activations: AgentHarnessFollowUpOptions["activate"][];
	cancelled: boolean;
}

export class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	readonly env: ExecutionEnv;
	private session: Session;
	private phase: AgentHarnessPhase = "idle";
	private runAbortController?: AbortController;
	private runPromise?: Promise<void>;
	private pendingSessionWrites: PendingSessionWrite[] = [];
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	private streamOptions: AgentHarnessStreamOptions;
	private transformSessionContext?: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["transformSessionContext"];
	private getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
	private resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	private tools = new Map<string, TTool>();
	private activeToolNames: string[];
	private steerQueue: UserMessage[] = [];
	private steeringQueueMode: QueueMode;
	private followUpQueue: UserMessage[] = [];
	private followUpPreparations: Array<AgentHarnessTurnPreparation | undefined> = [];
	private followUpActivations: AgentHarnessFollowUpOptions["activate"][] = [];
	private preparedProviderRequests: Array<{ userEntryId: string; options: AgentHarnessStreamOptions }> = [];
	private preparedContextTransforms: Array<{ userEntryId: string; messages: AgentMessage[] }> = [];
	private preparedProviderPayloads: Array<{ userEntryId: string; payload: unknown }> = [];
	private preparedProviderReceipts: Array<{ userEntryId: string }> = [];
	private activePreparedProviderUserEntryId: string | undefined;
	private inFlightFollowUpDrain?: InFlightFollowUpDrain;
	private followUpQueueMode: QueueMode;
	private nextTurnQueue: AgentMessage[] = [];
	private preparedUserEntryIds: Array<string | undefined> = [];
	private handlers = new Map<string, Set<AgentHarnessHandler>>();
	private messageEntryIds = new WeakMap<object, string>();
	private observeProviderContext?: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["observeProviderContext"];
	private onProviderContextObservationError?: AgentHarnessOptions<
		TSkill,
		TPromptTemplate,
		TTool
	>["onProviderContextObservationError"];

	constructor(options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>) {
		this.env = options.env;
		this.session = options.session;
		this.resources = options.resources ?? {};
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.transformSessionContext = options.transformSessionContext;
		this.systemPrompt = options.systemPrompt;
		this.getApiKeyAndHeaders = options.getApiKeyAndHeaders;
		this.observeProviderContext = options.observeProviderContext;
		this.onProviderContextObservationError = options.onProviderContextObservationError;
		for (const tool of options.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = options.activeToolNames ?? (options.tools ?? []).map((tool) => tool.name);
		this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
		this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
	}

	private getHandlers(type: string): Set<AgentHarnessHandler> | undefined {
		return this.handlers.get(type);
	}

	private async emitOwn(event: AgentHarnessOwnEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}

	private async emitAny(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}

	private async emitHook<TType extends keyof AgentHarnessEventResultMap>(
		event: Extract<AgentHarnessOwnEvent, { type: TType }>,
	): Promise<AgentHarnessEventResultMap[TType] | undefined> {
		const handlers = this.getHandlers(event.type as TType);
		if (!handlers || handlers.size === 0) return undefined;
		let lastResult: AgentHarnessEventResultMap[TType] | undefined;
		for (const handler of handlers) {
			try {
				const result = await handler(event);
				if (result !== undefined) {
					lastResult = result;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return lastResult;
	}

	private async emitBeforeProviderRequest(
		model: Model<any>,
		sessionId: string,
		streamOptions: AgentHarnessStreamOptions,
	): Promise<AgentHarnessStreamOptions> {
		const handlers = this.getHandlers("before_provider_request");
		let current = cloneStreamOptions(streamOptions);
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({
					type: "before_provider_request",
					model,
					sessionId,
					streamOptions: cloneStreamOptions(current),
				});
				if (result?.streamOptions) {
					current = applyStreamOptionsPatch(current, result.streamOptions);
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitBeforeProviderPayload(model: Model<any>, payload: unknown): Promise<unknown> {
		const handlers = this.getHandlers("before_provider_payload");
		let current = payload;
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({ type: "before_provider_payload", model, payload: current });
				if (result !== undefined) {
					current = result.payload;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitQueueUpdate(): Promise<void> {
		await this.emitOwn({
			type: "queue_update",
			steer: [...this.steerQueue],
			followUp: [...this.followUpQueue],
			nextTurn: [...this.nextTurnQueue],
		});
	}

	private async prepareUserMessage(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		userMessage: UserMessage,
		prepare: AgentHarnessTurnPreparation,
		signal?: AbortSignal,
	): Promise<AgentHarnessPreparedTurn> {
		return await prepare({
			userMessage,
			systemPrompt: turnState.systemPrompt,
			systemPromptMetadata: turnState.systemPromptMetadata,
			messages: turnState.messages.slice(),
			model: turnState.model,
			activeTools: turnState.activeTools.slice(),
			transformProviderRequest: async () => {
				const auth = await this.getApiKeyAndHeaders?.(turnState.model);
				const snapshotOptions: AgentHarnessStreamOptions = {
					...turnState.streamOptions,
					headers: mergeHeaders(turnState.streamOptions.headers, auth?.headers),
				};
				return await this.emitBeforeProviderRequest(
					turnState.model,
					turnState.sessionId,
					snapshotOptions,
				);
			},
			transformContextMessages: async (messages) => {
				const result = await this.emitHook({ type: "context", messages: [...messages] });
				return result?.messages ?? messages;
			},
			transformProviderPayload: async (payload) => await this.emitBeforeProviderPayload(turnState.model, payload),
			signal,
		});
	}

	private async drainFollowUpMessages(): Promise<AgentMessage[]> {
		const requiresPerSendActivation =
			this.followUpPreparations.some((prepare) => prepare != null) ||
			this.followUpActivations.some((activate) => activate != null);
		const count =
			this.followUpQueueMode === "all" && !requiresPerSendActivation
				? this.followUpQueue.length
				: Math.min(1, this.followUpQueue.length);
		const messages = this.followUpQueue.splice(0, count);
		const preparations = this.followUpPreparations.splice(0, count);
		const activations = this.followUpActivations.splice(0, count);
		if (messages.length === 0) return messages;
		const drain: InFlightFollowUpDrain = { messages, preparations, activations, cancelled: false };
		this.inFlightFollowUpDrain = drain;
		try {
			await this.emitQueueUpdate();
			return messages;
		} catch (error) {
			if (!drain.cancelled) {
				this.followUpQueue.unshift(...messages);
				this.followUpPreparations.unshift(...preparations);
				this.followUpActivations.unshift(...activations);
			}
			if (this.inFlightFollowUpDrain === drain) this.inFlightFollowUpDrain = undefined;
			try {
				await this.emitQueueUpdate();
			} catch {
				// The original error remains the actionable failure.
			}
			throw normalizeHookError(error);
		}
	}

	private startRunPromise(): () => void {
		let finish = () => {};
		this.runPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		return () => {
			this.runPromise = undefined;
			finish();
		};
	}

	private async createTurnState(): Promise<AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>> {
		const entries = await this.session.getBranch();
		let context = buildSessionContext(entries);
		if (this.transformSessionContext) {
			context = await this.transformSessionContext({ entries, context });
		}
		const messages = context.messages;
		// When the leaf is positioned on a user message (e.g. after navigating
		// to the first message in a session where parentId=null falls back to
		// the target entry itself), strip that trailing user message from the
		// LLM context. executeTurn will append a fresh user message from the
		// prompt text, so leaving the old user message in context would produce
		// duplicate consecutive user messages that confuse the model.
		if (messages.length > 0 && messages[messages.length - 1]?.role === "user") {
			messages.splice(-1, 1);
			context.messageEntryIds.splice(-1, 1);
		}
		const resources = this.getResources();
		const sessionMetadata = await this.session.getMetadata();
		const leafId = await this.session.getLeafId();
		context.messages.forEach((message, index) => {
			const entryId = context.messageEntryIds[index];
			if (entryId) this.messageEntryIds.set(message as object, entryId);
		});
		const tools = [...this.tools.values()];
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
		let systemPrompt = "You are a helpful assistant.";
		let systemPromptMetadata: unknown;
		if (typeof this.systemPrompt === "string") {
			systemPrompt = this.systemPrompt;
		} else if (this.systemPrompt) {
			const result = await this.systemPrompt({
				env: this.env,
				session: this.session,
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				activeTools,
				resources,
			});
			if (typeof result === "string") {
				systemPrompt = result;
			} else {
				systemPrompt = result.text;
				systemPromptMetadata = result.metadata;
			}
		}
		return {
			entries,
			messages: context.messages,
			messageEntryIds: [...context.messageEntryIds],
			leafId,
			resources,
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: sessionMetadata.id,
			systemPrompt,
			systemPromptMetadata,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools,
			activeTools,
		};
	}

	async createTurnPreparationSnapshot(
		text: string,
		images?: ImageContent[],
	): Promise<AgentHarnessTurnPreparationInput> {
		if (this.phase !== "idle") {
			throw new AgentHarnessError("busy", "AgentHarness is busy");
		}
		const turnState = await this.createTurnState();
		const userMessage = createUserMessage(text, images);
		let messages: AgentMessage[] = [userMessage];
		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: text,
			images,
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		if (beforeResult?.messages) messages = [...messages, ...beforeResult.messages];
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
		const systemPrompt = beforeResult?.systemPrompt ?? turnState.systemPrompt;
		return {
			userMessage,
			systemPrompt,
			systemPromptMetadata: beforeResult?.systemPrompt == null ? turnState.systemPromptMetadata : undefined,
			messages: [...turnState.messages, ...messages],
			model: this.model,
			activeTools,
			transformProviderRequest: async () => {
				const auth = await this.getApiKeyAndHeaders?.(this.model);
				const snapshotOptions: AgentHarnessStreamOptions = {
					...turnState.streamOptions,
					headers: mergeHeaders(turnState.streamOptions.headers, auth?.headers),
				};
				return await this.emitBeforeProviderRequest(this.model, turnState.sessionId, snapshotOptions);
			},
			transformContextMessages: async (contextMessages) => {
				const result = await this.emitHook({ type: "context", messages: [...contextMessages] });
				return result?.messages ?? contextMessages;
			},
			transformProviderPayload: async (payload) => await this.emitBeforeProviderPayload(this.model, payload),
		};
	}

	private createContext(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		systemPrompt?: string,
	): AgentContext {
		return {
			systemPrompt: systemPrompt ?? turnState.systemPrompt,
			messages: turnState.messages.slice(),
			tools: turnState.activeTools.slice(),
		};
	}

	private queueProviderContextObservation(observation: AgentHarnessProviderContextObservation): void {
		const observer = this.observeProviderContext;
		if (!observer) return;
		queueMicrotask(() => {
			try {
				void Promise.resolve(observer(observation)).catch((error) => {
					try {
						this.onProviderContextObservationError?.(toError(error));
					} catch {
						// Inspection diagnostics are isolated from provider execution too.
					}
				});
			} catch (error) {
				try {
					this.onProviderContextObservationError?.(toError(error));
				} catch {
					// Inspection diagnostics are isolated from provider execution too.
				}
			}
		});
	}

	private createStreamFn(getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>): StreamFn {
		return async (model, context, streamOptions) => {
			const turnState = getTurnState();
			const auth = await this.getApiKeyAndHeaders?.(model);
			const snapshotOptions: AgentHarnessStreamOptions = {
				...turnState.streamOptions,
				headers: mergeHeaders(turnState.streamOptions.headers, auth?.headers),
			};
			const expectedUserEntryId = this.activePreparedProviderUserEntryId;
			const preparedRequest = this.preparedProviderRequests[0];
			if (
				preparedRequest &&
				(expectedUserEntryId == null || preparedRequest.userEntryId !== expectedUserEntryId)
			) {
				this.preparedProviderRequests = [];
				throw new AgentHarnessError("invalid_state", "Prepared provider request is out of sequence");
			}
			const requestOptions = preparedRequest
				? this.preparedProviderRequests.shift()!.options
				: await this.emitBeforeProviderRequest(model, turnState.sessionId, snapshotOptions);
			const observeFinalPayload = async (payload: unknown): Promise<unknown> => {
				const observedState = getTurnState();
				let leafId = observedState.leafId;
				try {
					leafId = await this.session.getLeafId();
				} catch (error) {
					try {
						this.onProviderContextObservationError?.(toError(error));
					} catch {
						// Inspection diagnostics are isolated from provider execution too.
					}
				}
				const messageEntryIds =
					observedState.providerMessageEntryIds ??
					alignMessageEntryIds(
						observedState.messages,
						observedState.messageEntryIds,
						context.messages,
						this.messageEntryIds,
					);
				this.queueProviderContextObservation({
					model,
					sessionId: observedState.sessionId,
					leafId,
					systemPrompt: context.systemPrompt,
					systemPromptMetadata: observedState.systemPromptMetadata,
					messages: [...context.messages],
					messageEntryIds,
					entries: [...observedState.entries],
					activeTools: [...observedState.activeTools],
					requestOptions: cloneStreamOptions(requestOptions),
					payload,
				});
				return payload;
			};
			return streamSimple(model, context, {
				cacheRetention: requestOptions.cacheRetention,
				headers: requestOptions.headers,
				maxRetries: requestOptions.maxRetries,
				maxRetryDelayMs: requestOptions.maxRetryDelayMs,
				metadata: requestOptions.metadata,
				onPayload: async (payload) => {
					if (this.preparedProviderPayloads.length > 0) {
						const prepared = this.preparedProviderPayloads[0]!;
						if (expectedUserEntryId == null || prepared.userEntryId !== expectedUserEntryId) {
							this.preparedProviderPayloads = [];
							throw new AgentHarnessError("invalid_state", "Prepared provider payload is out of sequence");
						}
						const preparedPayload = this.preparedProviderPayloads.shift()!.payload;
						this.activePreparedProviderUserEntryId = undefined;
						return await observeFinalPayload(preparedPayload);
					}
					const transformedPayload = await this.emitBeforeProviderPayload(model, payload);
					if (expectedUserEntryId != null) this.activePreparedProviderUserEntryId = undefined;
					return await observeFinalPayload(transformedPayload);
				},
				onResponse: async (response) => {
					const headers = { ...(response.headers as Record<string, string>) };
					await this.emitOwn(
						{ type: "after_provider_response", status: response.status, headers },
						streamOptions?.signal,
					);
				},
				reasoning: streamOptions?.reasoning,
				signal: streamOptions?.signal,
				sessionId: turnState.sessionId,
				timeoutMs: requestOptions.timeoutMs,
				transport: requestOptions.transport,
				apiKey: auth?.apiKey,
			});
		};
	}

	private async drainQueuedMessages(queue: AgentMessage[], mode: QueueMode): Promise<AgentMessage[]> {
		const messages = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
		if (messages.length === 0) return messages;
		try {
			await this.emitQueueUpdate();
			return messages;
		} catch (error) {
			queue.unshift(...messages);
			throw normalizeHookError(error);
		}
	}

	private createLoopConfig(
		getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		setTurnState: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => void,
		initialSystemPromptSuffix = "",
		signal?: AbortSignal,
	): AgentLoopConfig {
		let activeSystemPromptSuffix = initialSystemPromptSuffix;
		const prepareTurn = async (keepSystemPromptSuffix = false) => {
			if (!keepSystemPromptSuffix) activeSystemPromptSuffix = "";
			await this.flushPendingSessionWrites();
			const nextTurnState = await this.createTurnState();
			setTurnState(nextTurnState);
			return {
				context: this.createContext(
					nextTurnState,
					joinSystemPrompt(nextTurnState.systemPrompt, activeSystemPromptSuffix),
				),
				model: nextTurnState.model,
				thinkingLevel: nextTurnState.thinkingLevel,
			};
		};
		const turnState = getTurnState();
		return {
			model: turnState.model,
			reasoning: turnState.thinkingLevel === "off" ? undefined : turnState.thinkingLevel,
			convertToLlm,
			transformContext: async (messages) => {
				let transformedMessages: AgentMessage[] | undefined;
				const receipt = this.preparedProviderReceipts[0];
				if (receipt) {
					const prepared = this.preparedContextTransforms[0];
					if (prepared && prepared.userEntryId !== receipt.userEntryId) {
						this.preparedContextTransforms = [];
						throw new AgentHarnessError("invalid_state", "Prepared context transform is out of sequence");
					}
					this.preparedProviderReceipts.shift();
					this.activePreparedProviderUserEntryId = receipt.userEntryId;
					if (prepared) transformedMessages = this.preparedContextTransforms.shift()!.messages;
				} else if (this.preparedContextTransforms.length > 0) {
					this.preparedContextTransforms = [];
					throw new AgentHarnessError("invalid_state", "Prepared context transform has no matching receipt");
				}
				if (!transformedMessages) {
					const result = await this.emitHook({ type: "context", messages: [...messages] });
					transformedMessages = result?.messages ?? messages;
				}
				const current = getTurnState();
				const inputEntryIds = alignMessageEntryIds(
					current.messages,
					current.messageEntryIds,
					messages,
					this.messageEntryIds,
				);
				const providerMessageEntryIds = alignMessageEntryIds(
					messages,
					inputEntryIds,
					transformedMessages,
					this.messageEntryIds,
				);
				setTurnState({ ...current, providerMessageEntryIds });
				return transformedMessages;
			},
			beforeToolCall: async ({ toolCall, args }) => {
				const result = await this.emitHook({
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
				});
				return result ? { block: result.block, reason: result.reason } : undefined;
			},
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const patch = await this.emitHook({
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
				});
				return patch
					? { content: patch.content, details: patch.details, isError: patch.isError, terminate: patch.terminate }
					: undefined;
			},
			prepareNextTurn: async ({ toolResults }) => await prepareTurn(toolResults.length > 0),
			prepareFollowUpTurn: async () => {
				if (signal?.aborted) {
					throw new AgentHarnessError("invalid_state", "Turn preparation was aborted");
				}
				const drain = this.inFlightFollowUpDrain;
				if (!drain) return await prepareTurn();
				try {
					const activatedPrepare = await drain.activations[0]?.(signal);
					if (signal?.aborted) {
						throw new AgentHarnessError("invalid_state", "Turn preparation was aborted");
					}
					await this.flushPendingSessionWrites();
					const nextTurnState = await this.createTurnState();
					setTurnState(nextTurnState);
					const prepare =
						typeof activatedPrepare === "function" ? activatedPrepare : drain.preparations[0];
					if (!prepare) {
						this.inFlightFollowUpDrain = undefined;
						activeSystemPromptSuffix = "";
						return {
							context: this.createContext(nextTurnState),
							model: nextTurnState.model,
							thinkingLevel: nextTurnState.thinkingLevel,
						};
					}
					const userMessage = drain.messages[0]!;
					const prepared = await this.prepareUserMessage(
						{ ...nextTurnState, messages: [...nextTurnState.messages, userMessage] },
						userMessage,
						prepare,
						signal,
					);
					if (signal?.aborted) {
						throw new AgentHarnessError("invalid_state", "Turn preparation was aborted");
					}
					this.inFlightFollowUpDrain = undefined;
					activeSystemPromptSuffix = prepared.systemPromptSuffix;
					if (prepared.finalProviderRequestOptions !== undefined) {
						this.preparedProviderRequests.push({
							userEntryId: prepared.userEntryId,
							options: prepared.finalProviderRequestOptions,
						});
					}
					if (
						prepared.finalProviderRequestOptions !== undefined ||
						prepared.transformedContextMessages !== undefined ||
						prepared.finalProviderPayload !== undefined
					) {
						this.preparedProviderReceipts.push({ userEntryId: prepared.userEntryId });
					}
					if (prepared.transformedContextMessages !== undefined) {
						this.preparedContextTransforms.push({
							userEntryId: prepared.userEntryId,
							messages: prepared.transformedContextMessages,
						});
					}
					if (prepared.finalProviderPayload !== undefined) {
						this.preparedProviderPayloads.push({
							userEntryId: prepared.userEntryId,
							payload: prepared.finalProviderPayload,
						});
					}
					this.preparedUserEntryIds.push(prepared.userEntryId);
					return {
						context: this.createContext(
							nextTurnState,
							joinSystemPrompt(nextTurnState.systemPrompt, activeSystemPromptSuffix),
						),
						model: nextTurnState.model,
						thinkingLevel: nextTurnState.thinkingLevel,
					};
				} catch (error) {
					const terminal = error instanceof AgentHarnessTerminalPreparationError;
					if (!drain.cancelled && !terminal) {
						this.followUpQueue.unshift(...drain.messages);
						this.followUpPreparations.unshift(...drain.preparations);
						this.followUpActivations.unshift(...drain.activations);
					}
					if (this.inFlightFollowUpDrain === drain) this.inFlightFollowUpDrain = undefined;
					try {
						await this.emitQueueUpdate();
					} catch {
						// The original error remains the actionable failure.
					}
					throw normalizeHookError(terminal ? (error.cause ?? error) : error);
				}
			},
			getSteeringMessages: async () => this.drainQueuedMessages(this.steerQueue, this.steeringQueueMode),
			getFollowUpMessages: async () => await this.drainFollowUpMessages(),
		};
	}

	private validateToolNames(toolNames: string[], tools: Map<string, TTool> = this.tools): void {
		const missing = toolNames.filter((name) => !tools.has(name));
		if (missing.length > 0) throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
	}

	private async flushPendingSessionWrites(): Promise<void> {
		while (this.pendingSessionWrites.length > 0) {
			const write = this.pendingSessionWrites[0]!;
			if (write.type === "message") {
				await this.session.appendMessage(write.message);
			} else if (write.type === "model_change") {
				await this.session.appendModelChange(write.provider, write.modelId);
			} else if (write.type === "thinking_level_change") {
				await this.session.appendThinkingLevelChange(write.thinkingLevel);
			} else if (write.type === "custom") {
				await this.session.appendCustomEntry(write.customType, write.data);
			} else if (write.type === "custom_message") {
				await this.session.appendCustomMessageEntry(write.customType, write.content, write.display, write.details);
			} else if (write.type === "label") {
				await this.session.appendLabel(write.targetId, write.label);
			} else if (write.type === "session_info") {
				await this.session.appendSessionName(write.name ?? "");
			} else if (write.type === "leaf") {
				await this.session.getStorage().setLeafId(write.targetId);
			}
			this.pendingSessionWrites.shift();
		}
	}

	private async handleAgentEvent(event: AgentEvent, signal?: AbortSignal): Promise<void> {
		if (event.type === "message_end") {
			if (event.message.role === "user" && this.preparedUserEntryIds.length > 0) {
				const entryId = this.preparedUserEntryIds.shift();
				if (entryId) {
					this.messageEntryIds.set(event.message as object, entryId);
					await this.emitAny({ ...event, entryId }, signal);
					return;
				}
			}
			const entryId = await this.session.appendMessage(event.message);
			this.messageEntryIds.set(event.message as object, entryId);
			await this.emitAny({ ...event, entryId }, signal);
			return;
		}
		if (event.type === "turn_end") {
			let eventError: unknown;
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				eventError = error;
			}
			const hadPendingMutations = this.pendingSessionWrites.length > 0;
			await this.flushPendingSessionWrites();
			if (eventError) throw eventError;
			await this.emitOwn({ type: "save_point", hadPendingMutations });
			return;
		}
		if (event.type === "agent_end") {
			await this.flushPendingSessionWrites();
			this.phase = "idle";
			await this.emitAny(event, signal);
			await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
			return;
		}
		await this.emitAny(event, signal);
	}

	private async emitRunFailure(
		model: Model<any>,
		error: unknown,
		aborted: boolean,
		signal: AbortSignal,
	): Promise<AgentMessage[]> {
		const failureMessage = createFailureMessage(model, error, aborted);
		await this.handleAgentEvent({ type: "message_start", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "message_end", message: failureMessage }, signal);
		await this.handleAgentEvent({ type: "turn_end", message: failureMessage, toolResults: [] }, signal);
		await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] }, signal);
		return [failureMessage];
	}

	private async executeTurn(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		text: string,
		options?: AgentHarnessPromptOptions,
		queuedUserMessage?: UserMessage,
		existingAbortController?: AbortController,
	): Promise<AssistantMessage> {
		if (options?.prepare && this.nextTurnQueue.length > 0) {
			throw new AgentHarnessError(
				"invalid_state",
				"Cannot prepare a prompt while next-turn messages are pending",
			);
		}
		let activeTurnState = turnState;
		const userMessage = queuedUserMessage ?? createUserMessage(text, options?.images);
		let messages: AgentMessage[] = [userMessage];
		if (this.nextTurnQueue.length > 0) {
			const queuedMessages = this.nextTurnQueue.splice(0);
			try {
				await this.emitQueueUpdate();
			} catch (error) {
				this.nextTurnQueue.unshift(...queuedMessages);
				throw normalizeHookError(error);
			}
			messages = [...queuedMessages, messages[0]!];
		}
		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: text,
			images: options?.images,
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		if (beforeResult?.messages) messages = [...messages, ...beforeResult.messages];
		const currentTools = [...this.tools.values()];
		const effectiveTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool> = {
			...turnState,
			resources: this.getResources(),
			streamOptions: cloneStreamOptions(this.streamOptions),
			systemPrompt: beforeResult?.systemPrompt ?? turnState.systemPrompt,
			systemPromptMetadata: beforeResult?.systemPrompt == null ? turnState.systemPromptMetadata : undefined,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools: currentTools,
			activeTools: this.activeToolNames
				.map((name) => this.tools.get(name))
				.filter((tool): tool is TTool => tool !== undefined),
		};
		activeTurnState = effectiveTurnState;
		const abortController = existingAbortController ?? new AbortController();
		this.runAbortController = abortController;
		let preparedTurn: AgentHarnessPreparedTurn | undefined;
		try {
			preparedTurn = options?.prepare
				? await this.prepareUserMessage(
						{
							...effectiveTurnState,
							messages: [...turnState.messages, ...messages],
						},
						userMessage,
						options.prepare,
						abortController.signal,
					)
				: undefined;
			if (abortController.signal.aborted) {
				throw new AgentHarnessError("invalid_state", "Turn preparation was aborted");
			}
		} catch (error) {
			this.preparedUserEntryIds = [];
			this.preparedProviderRequests = [];
			this.preparedProviderReceipts = [];
			this.activePreparedProviderUserEntryId = undefined;
			this.preparedContextTransforms = [];
			this.preparedProviderPayloads = [];
			this.runAbortController = undefined;
			throw error;
		}
		if (preparedTurn) {
			if (preparedTurn.finalProviderRequestOptions !== undefined) {
				this.preparedProviderRequests.push({
					userEntryId: preparedTurn.userEntryId,
					options: preparedTurn.finalProviderRequestOptions,
				});
			}
			if (
				preparedTurn.finalProviderRequestOptions !== undefined ||
				preparedTurn.transformedContextMessages !== undefined ||
				preparedTurn.finalProviderPayload !== undefined
			) {
				this.preparedProviderReceipts.push({ userEntryId: preparedTurn.userEntryId });
			}
			if (preparedTurn.transformedContextMessages !== undefined) {
				this.preparedContextTransforms.push({
					userEntryId: preparedTurn.userEntryId,
					messages: preparedTurn.transformedContextMessages,
				});
			}
			if (preparedTurn.finalProviderPayload !== undefined) {
				this.preparedProviderPayloads.push({
					userEntryId: preparedTurn.userEntryId,
					payload: preparedTurn.finalProviderPayload,
				});
			}
			for (const message of messages) {
				if (message.role === "user") {
					this.preparedUserEntryIds.push(message === userMessage ? preparedTurn.userEntryId : undefined);
				}
			}
		}

		const getTurnState = () => activeTurnState;
		const setTurnState = (nextTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
			activeTurnState = nextTurnState;
		};
		this.runAbortController = abortController;
		const runResultPromise = (async () => {
			try {
				return await runAgentLoop(
					messages,
					this.createContext(
						effectiveTurnState,
						joinSystemPrompt(
							effectiveTurnState.systemPrompt,
							preparedTurn?.systemPromptSuffix ?? "",
						),
					),
					this.createLoopConfig(
						getTurnState,
						setTurnState,
						preparedTurn?.systemPromptSuffix,
						abortController.signal,
					),
					(event) => this.handleAgentEvent(event, abortController.signal),
					abortController.signal,
					this.createStreamFn(getTurnState),
				);
			} catch (error) {
				try {
					return await this.emitRunFailure(
						activeTurnState.model,
						error,
						abortController.signal.aborted,
						abortController.signal,
					);
				} catch (failureError) {
					const cause = new AggregateError(
						[toError(error), toError(failureError)],
						"Agent run failed and failure reporting failed",
					);
					throw new AgentHarnessError("unknown", cause.message, cause);
				}
			}
		})();
		try {
			const newMessages = await runResultPromise;
			for (let i = newMessages.length - 1; i >= 0; i--) {
				const message = newMessages[i]!;
				if (message.role === "assistant") {
					return message;
				}
			}
			throw new AgentHarnessError("invalid_state", "AgentHarness prompt completed without an assistant message");
		} finally {
			try {
				await this.flushPendingSessionWrites();
			} finally {
				this.preparedUserEntryIds = [];
				this.preparedProviderRequests = [];
				this.preparedProviderReceipts = [];
				this.activePreparedProviderUserEntryId = undefined;
				this.preparedContextTransforms = [];
				this.preparedProviderPayloads = [];
				this.inFlightFollowUpDrain = undefined;
				this.runAbortController = undefined;
			}
		}
	}

	private async promoteQueuedFollowUp(): Promise<AssistantMessage | undefined> {
		while (this.followUpQueue.length > 0) {
			const userMessage = this.followUpQueue.shift()!;
			const prepare = this.followUpPreparations.shift();
			const activate = this.followUpActivations.shift();
			try {
				await this.emitQueueUpdate();
			} catch (error) {
				this.followUpQueue.unshift(userMessage);
				this.followUpPreparations.unshift(prepare);
				this.followUpActivations.unshift(activate);
				throw normalizeHookError(error);
			}
			const abortController = new AbortController();
			this.runAbortController = abortController;
			try {
				const activatedPrepare = await activate?.(abortController.signal);
				if (abortController.signal.aborted) {
					throw new AgentHarnessError("invalid_state", "Turn preparation was aborted");
				}
				const turnState = await this.createTurnState();
				const content = userMessage.content;
				const text =
					typeof content === "string"
						? content
						: content
								.filter((item): item is TextContent => item.type === "text")
								.map((item) => item.text)
								.join("\n");
				const images =
					typeof content === "string"
						? []
						: content.filter((item): item is ImageContent => item.type === "image");
				return await this.executeTurn(
					turnState,
					text,
					{
						...(images.length > 0 ? { images } : {}),
						...(typeof activatedPrepare === "function"
							? { prepare: activatedPrepare }
							: prepare
								? { prepare }
								: {}),
					},
					userMessage,
					abortController,
				);
			} catch (error) {
				this.runAbortController = undefined;
				const terminal = error instanceof AgentHarnessTerminalPreparationError;
				if (terminal) continue;
				if (!abortController.signal.aborted) {
					this.followUpQueue.unshift(userMessage);
					this.followUpPreparations.unshift(prepare);
					this.followUpActivations.unshift(activate);
					try {
						await this.emitQueueUpdate();
					} catch {
						// The original error remains the actionable failure.
					}
				}
				throw error;
			}
		}
		return undefined;
	}

	async prompt(text: string, options?: AgentHarnessPromptOptions): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			return await this.executeTurn(turnState, text, options);
		} catch (error) {
			let failure = error;
			if (error instanceof AgentHarnessTerminalPreparationError) {
				try {
					const promoted = await this.promoteQueuedFollowUp();
					if (promoted) return promoted;
				} catch (promotionError) {
					failure = promotionError;
				}
			}
			this.phase = "idle";
			throw normalizeHarnessError(failure, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async promptReturningEntryId(
		text: string,
		options?: AgentHarnessPromptOptions,
	): Promise<{ assistant: AssistantMessage; userEntryId: string }> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		const baseEntryIds = new Set((await this.session.getBranch()).map((entry) => entry.id));
		try {
			const turnState = await this.createTurnState();
			const assistant = await this.executeTurn(turnState, text, options);
			const branch = await this.session.getBranch();
			const userEntry = branch.find(
				(e) =>
					e.type === "message" &&
					!baseEntryIds.has(e.id) &&
					(e.message as { role?: string }).role === "user",
			);
			if (!userEntry) {
				throw new AgentHarnessError("unknown", "prompt did not produce a user entry");
			}
			return { assistant, userEntryId: userEntry.id };
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async promptWithCustomEntry(
		customType: string,
		data: unknown,
		text: string,
		options?: AgentHarnessPromptOptions,
	): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			await this.session.appendCustomEntry(customType, data);
			const turnState = await this.createTurnState();
			return await this.executeTurn(turnState, text, options);
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
			if (!skill) throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
			return await this.executeTurn(turnState, formatSkillInvocation(skill, additionalInstructions));
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async promptFromTemplate(name: string, args: string[] = []): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			const template = (turnState.resources.promptTemplates ?? []).find((candidate) => candidate.name === name);
			if (!template) throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
			return await this.executeTurn(turnState, formatPromptTemplateInvocation(template, args));
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
		this.steerQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	async followUp(
		text: string,
		options?: AgentHarnessFollowUpOptions,
		prepare?: AgentHarnessTurnPreparation,
	): Promise<void> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
		this.followUpQueue.push(createUserMessage(text, options?.images));
		this.followUpPreparations.push(prepare);
		this.followUpActivations.push(options?.activate);
		await this.emitQueueUpdate();
	}

	async nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		this.nextTurnQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	async appendMessage(message: AgentMessage): Promise<void> {
		try {
			if (this.phase === "idle") {
				await this.session.appendMessage(message);
			} else {
				this.pendingSessionWrites.push({ type: "message", message });
			}
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<void> {
		try {
			await this.session.appendCustomEntry(customType, data);
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	async compact(
		customInstructions?: string,
	): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown }> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "compact() requires idle harness");
		this.phase = "compaction";
		try {
			const model = this.model;
			if (!model) throw new AgentHarnessError("invalid_state", "No model set for compaction");
			const auth = await this.getApiKeyAndHeaders?.(model);
			if (!auth) throw new AgentHarnessError("auth", "No auth available for compaction");
			const branchEntries = await this.session.getBranch();
			const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
			if (!preparationResult.ok) throw preparationResult.error;
			const preparation = preparationResult.value;
			if (!preparation) throw new AgentHarnessError("compaction", "Nothing to compact");
			const hookResult = await this.emitHook({
				type: "session_before_compact",
				preparation,
				branchEntries,
				customInstructions,
				signal: new AbortController().signal,
			});
			if (hookResult?.cancel) throw new AgentHarnessError("compaction", "Compaction cancelled");
			const provided = hookResult?.compaction;
			const compactResult = provided
				? { ok: true as const, value: provided }
				: await compact(
						preparation,
						model,
						auth.apiKey,
						auth.headers,
						customInstructions,
						undefined,
						this.thinkingLevel,
					);
			if (!compactResult.ok) throw compactResult.error;
			const result = compactResult.value;
			const entryId = await this.session.appendCompaction(
				result.summary,
				result.firstKeptEntryId,
				result.tokensBefore,
				result.details,
				provided !== undefined,
			);
			const entry = await this.session.getEntry(entryId);
			if (entry?.type === "compaction") {
				await this.emitOwn({ type: "session_compact", compactionEntry: entry, fromHook: provided !== undefined });
			}
			return result;
		} catch (error) {
			throw normalizeHarnessError(error, "compaction");
		} finally {
			this.phase = "idle";
		}
	}

	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<NavigateTreeResult> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "navigateTree() requires idle harness");
		this.phase = "branch_summary";
		try {
			const oldLeafId = await this.session.getLeafId();
			if (oldLeafId === targetId) return { cancelled: false };
			const targetEntry = await this.session.getEntry(targetId);
			if (!targetEntry) throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
			const { entries, commonAncestorId } = await collectEntriesForBranchSummary(this.session, oldLeafId, targetId);
			const preparation = {
				targetId,
				oldLeafId,
				commonAncestorId,
				entriesToSummarize: entries,
				userWantsSummary: options?.summarize ?? false,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			};
			const signal = new AbortController().signal;
			const hookResult = await this.emitHook({ type: "session_before_tree", preparation, signal });
			if (hookResult?.cancel) return { cancelled: true };
			let summaryEntry: NavigateTreeResult["summaryEntry"];
			let summaryText: string | undefined = hookResult?.summary?.summary;
			let summaryDetails: unknown = hookResult?.summary?.details;
			if (!summaryText && options?.summarize && entries.length > 0) {
				const model = this.model;
				if (!model) throw new AgentHarnessError("invalid_state", "No model set for branch summary");
				const auth = await this.getApiKeyAndHeaders?.(model);
				if (!auth) throw new AgentHarnessError("auth", "No auth available for branch summary");
				const branchSummary = await generateBranchSummary(entries, {
					model,
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: new AbortController().signal,
					customInstructions: hookResult?.customInstructions ?? options?.customInstructions,
					replaceInstructions: hookResult?.replaceInstructions ?? options?.replaceInstructions,
				});
				if (!branchSummary.ok) {
					if (branchSummary.error.code === "aborted") return { cancelled: true };
					throw new AgentHarnessError("branch_summary", branchSummary.error.message, branchSummary.error);
				}
				summaryText = branchSummary.value.summary;
				summaryDetails = {
					readFiles: branchSummary.value.readFiles,
					modifiedFiles: branchSummary.value.modifiedFiles,
				};
			}
			let editorText: string | undefined;
			let newLeafId: string | null;
			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId ?? targetId;
				const content = targetEntry.message.content;
				editorText =
					typeof content === "string"
						? content
						: content
								.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId ?? targetId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				newLeafId = targetId;
			}
			const summaryId = await this.session.moveTo(
				newLeafId,
				summaryText
					? { summary: summaryText, details: summaryDetails, fromHook: hookResult?.summary !== undefined }
					: undefined,
			);
			if (summaryId) {
				const entry = await this.session.getEntry(summaryId);
				if (entry?.type === "branch_summary") summaryEntry = entry;
			}
			await this.emitOwn({
				type: "session_tree",
				newLeafId: await this.session.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromHook: hookResult?.summary !== undefined,
			});
			return { cancelled: false, editorText, summaryEntry };
		} catch (error) {
			throw normalizeHarnessError(error, "branch_summary");
		} finally {
			this.phase = "idle";
		}
	}

	getModel(): Model<any> {
		return this.model;
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	async setModel(model: Model<any>): Promise<void> {
		try {
			const previousModel = this.model;
			if (this.phase === "idle") {
				await this.session.appendModelChange(model.provider, model.id);
			} else {
				this.pendingSessionWrites.push({ type: "model_change", provider: model.provider, modelId: model.id });
			}
			this.model = model;
			await this.emitOwn({ type: "model_select", model, previousModel, source: "set" });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		try {
			const previousLevel = this.thinkingLevel;
			if (this.phase === "idle") {
				await this.session.appendThinkingLevelChange(level);
			} else {
				this.pendingSessionWrites.push({ type: "thinking_level_change", thinkingLevel: level });
			}
			this.thinkingLevel = level;
			await this.emitOwn({ type: "thinking_level_select", level, previousLevel });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	async setActiveTools(toolNames: string[]): Promise<void> {
		try {
			this.validateToolNames(toolNames);
			this.activeToolNames = [...toolNames];
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getSteeringMode(): QueueMode {
		return this.steeringQueueMode;
	}

	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringQueueMode = mode;
	}

	getFollowUpMode(): QueueMode {
		return this.followUpQueueMode;
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpQueueMode = mode;
	}

	getResources(): AgentHarnessResources<TSkill, TPromptTemplate> {
		return {
			skills: this.resources.skills?.slice(),
			promptTemplates: this.resources.promptTemplates?.slice(),
		};
	}

	async setResources(resources: AgentHarnessResources<TSkill, TPromptTemplate>): Promise<void> {
		const previousResources = this.getResources();
		this.resources = {
			skills: resources.skills?.slice(),
			promptTemplates: resources.promptTemplates?.slice(),
		};
		await this.emitOwn({ type: "resources_update", resources: this.getResources(), previousResources });
	}

	getStreamOptions(): AgentHarnessStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	async setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void> {
		this.streamOptions = cloneStreamOptions(streamOptions);
	}

	async setTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
		try {
			const nextTools = new Map(tools.map((tool) => [tool.name, tool]));
			const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;
			this.validateToolNames(nextActiveToolNames, nextTools);
			this.tools = nextTools;
			this.activeToolNames = [...nextActiveToolNames];
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	async abort(): Promise<AbortResult> {
		const clearedSteer = [...this.steerQueue];
		const clearedFollowUp = [...this.followUpQueue];
		if (this.inFlightFollowUpDrain && !this.inFlightFollowUpDrain.cancelled) {
			this.inFlightFollowUpDrain.cancelled = true;
			clearedFollowUp.push(...this.inFlightFollowUpDrain.messages);
		}
		this.steerQueue = [];
		this.followUpQueue = [];
		this.followUpPreparations = [];
		this.followUpActivations = [];
		this.runAbortController?.abort();
		const errors: Error[] = [];
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.waitForIdle();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp });
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Abort completed with errors");
			throw normalizeHarnessError(cause, "hook");
		}
		return { clearedSteer, clearedFollowUp };
	}

	async waitForIdle(): Promise<void> {
		await this.runPromise;
	}

	isIdle(): boolean {
		return this.phase === "idle";
	}

	subscribe(
		listener: (event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		let handlers = this.handlers.get(SUBSCRIBER_EVENT_TYPE);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(SUBSCRIBER_EVENT_TYPE, handlers);
		}
		handlers.add(listener as AgentHarnessHandler);
		return () => handlers!.delete(listener as AgentHarnessHandler);
	}

	on<TType extends keyof AgentHarnessEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHarnessOwnEvent, { type: TType }>,
		) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
	): () => void {
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler as AgentHarnessHandler);
		return () => handlers!.delete(handler as AgentHarnessHandler);
	}
}
