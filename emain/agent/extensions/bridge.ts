// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// extensions/bridge.ts — the "重接线" half of the headless extension port.
// pi's runner.ts (packages/coding-agent/src/core/extensions/runner.ts,
// earendil-works/pi, MIT) dispatches extension handlers against pi's own
// AgentSession. crest runs the agent inside AgentHarness, so this file
// re-implements just the dispatch accumulation semantics runner.ts uses and
// wires them onto AgentHarness's typed hook seam (harness.on / .subscribe).
//
// Why a bespoke dispatcher instead of one harness.on() per extension:
// AgentHarness.emitHook is last-writer-wins (agent-harness.ts:236-247) — it
// keeps only the last non-undefined handler result. pi's runner instead folds
// every extension's result into an accumulator (tool_result patches stack,
// context messages chain, before_agent_start messages append + systemPrompt
// chains, tool_call short-circuits on block). To preserve pi semantics we
// register a *single* harness handler per hook type that loops all extensions
// internally and returns the folded result.

import type { AgentHarness } from "../harness/agent-harness";
import type {
	AgentHarnessStreamOptionsPatch,
	BeforeAgentStartEvent,
	BeforeAgentStartResult,
	BeforeProviderPayloadEvent,
	BeforeProviderPayloadResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestResult,
	ContextEvent,
	ContextResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionTreeEntry,
	ToolCallEvent,
	ToolCallResult,
	ToolResultEvent,
	ToolResultPatch,
} from "../harness/types";
import type { AgentMessage, AgentTool } from "../types";
import { getPiGuiAdapter, type WidgetEvent as PiGuiWidgetEvent } from "./pi-gui/crest/adapters";
import { componentToWidget } from "./pi-gui/crest/walker";
import type { RenderedExtensionEntryNode, WidgetNode } from "./pi-gui/crest/widget-tree";
import type { Component } from "./pi-gui/src/tui";
import type {
	Extension,
	ExtensionCommandContext,
	ExtensionCommandHost,
	ExtensionContext,
	ExtensionContextHost,
	ExtensionRuntime,
	ExtensionUI,
} from "./types";

/**
 * An interactive UI request from ctx.ui.confirm / select / input. Emitted by
 * the bridge toward a UI host (the pane session owner); the host prompts the
 * renderer and resolves the returned promise with the user's answer.
 */
export type ExtUiRequest =
	| { kind: "confirm"; title: string; message?: string }
	| { kind: "select"; title: string; options: string[] }
	| { kind: "input"; title: string; initial?: string }
	| { kind: "editor"; title: string; prefill?: string }
	| { kind: "custom"; widget: WidgetNode; options?: unknown };

type ExtensionCustomFactory = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (result?: unknown) => void
) => Component;

export interface WidgetEvent {
	nodeid: string;
	type: string;
	payload?: unknown;
}

interface WidgetTarget {
	component: Component;
	rootComponent: Component;
	done?: (result?: unknown) => void;
	width: number;
	update?: (widget: WidgetNode) => void;
}

function customWidth(options: unknown): number {
	if (!options || typeof options !== "object") return 80;
	const width = (options as { width?: unknown }).width;
	return typeof width === "number" && Number.isFinite(width) ? width : 80;
}

/**
 * The seam an owner (AgentSessionRuntime) implements to service ctx.ui. Single-
 * direction pushes (notify/setStatus/setWidget) fan out to renderer subscribers
 * as events; requestUi does a round-trip: it emits an ext_ui_request event and
 * resolves once the renderer responds via agent:ui-response.
 */
export interface ExtensionUiHost {
	notify(message: string, level: "info" | "warn" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, value: string[] | WidgetNode | undefined): void;
	setHeader(value: WidgetNode | undefined): void;
	setFooter(value: WidgetNode | undefined): void;
	updateCustomWidget?(widget: WidgetNode): void;
	resolveCustomWidget?(widgetId: string, result: unknown): boolean;
	requestUi(request: ExtUiRequest): Promise<unknown>;
}

function isComponent(value: unknown): value is Component {
	return (
		value != null &&
		typeof value === "object" &&
		typeof (value as { render?: unknown }).render === "function" &&
		typeof (value as { invalidate?: unknown }).invalidate === "function"
	);
}

function serializeUiValue(value: unknown, options?: unknown): string[] | WidgetNode | undefined {
	if (value == null) return undefined;
	if (Array.isArray(value)) return value as string[];
	if (isComponent(value)) return componentToWidget(value, { width: customWidth(options) });
	if (typeof value === "function") {
		const component = (value as ExtensionCustomFactory)(undefined, undefined, undefined, () => {});
		return componentToWidget(component, { width: customWidth(options) });
	}
	return undefined;
}

function componentFromUiValue(value: unknown): Component | undefined {
	if (isComponent(value)) return value;
	if (typeof value === "function") {
		return (value as ExtensionCustomFactory)(undefined, undefined, undefined, () => {});
	}
	return undefined;
}

/**
 * Late-bound holder for the UI host. buildAgentHarnessHost creates the extension
 * context (and thus wires ctx.ui) BEFORE the AgentSessionRuntime owner exists, so
 * we hand the context this bridge and attach the real host once the owner is
 * constructed. Until attached, ctx.ui degrades to the headless no-op behavior.
 */
export interface ExtensionUiBridge {
	attach(host: ExtensionUiHost): void;
	readonly host: ExtensionUiHost | undefined;
	registerWidgetRoot(
		widget: WidgetNode,
		component: Component,
		done?: (result?: unknown) => void,
		options?: { width?: number; update?: (widget: WidgetNode) => void }
	): () => void;
	dispatchWidgetEvent(event: WidgetEvent): boolean;
	dispose(): void;
}

export function createExtensionUiBridge(): ExtensionUiBridge {
	let host: ExtensionUiHost | undefined;
	let disposed = false;
	const targets = new Map<string, WidgetTarget>();
	return {
		attach(next: ExtensionUiHost) {
			if (disposed) return;
			host = next;
		},
		get host() {
			return host;
		},
		registerWidgetRoot(widget, component, done, options) {
			if (disposed) return () => {};
			const ids = registerWidgetSubtree(targets, widget, component, {
				rootComponent: component,
				done,
				width: options?.width ?? 80,
				update: options?.update,
			});
			return () => {
				const registeredTargets: WidgetTarget[] = [];
				for (const id of ids) {
					const target = targets.get(id);
					if (target) registeredTargets.push(target);
					targets.delete(id);
				}
				disposeUniqueWidgetTargets(registeredTargets);
			};
		},
		dispatchWidgetEvent(event: WidgetEvent) {
			const target = targets.get(event.nodeid);
			if (!target) return false;
			return dispatchWidgetEventToComponent(target, event);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			host = undefined;
			const registeredTargets = [...targets.values()];
			targets.clear();
			disposeUniqueWidgetTargets(registeredTargets);
		},
	};
}

function disposeUniqueWidgetTargets(targets: Iterable<WidgetTarget>): void {
	const uniqueTargets = new Map<Component, WidgetTarget>();
	for (const target of targets) {
		uniqueTargets.set(target.component, target);
	}
	for (const target of uniqueTargets.values()) {
		try {
			disposeWidgetTarget(target);
		} catch (err) {
			console.error("[extension-ui] widget dispose failed:", err);
		}
	}
}

function disposeWidgetTarget(target: WidgetTarget): void {
	const adapter = getPiGuiAdapter(target.component);
	adapter?.dispose?.(target.component);
}

function getComponentChildren(component: Component): Component[] {
	const children = (component as unknown as { children?: unknown }).children;
	return Array.isArray(children) ? (children as Component[]) : [];
}

function getWidgetChildren(widget: WidgetNode): WidgetNode[] {
	return "children" in widget && Array.isArray(widget.children) ? widget.children : [];
}

function registerWidgetSubtree(
	targets: Map<string, WidgetTarget>,
	widget: WidgetNode,
	component: Component,
	options: Omit<WidgetTarget, "component">
): string[] {
	const ids = [widget.id];
	targets.set(widget.id, { ...options, component });
	const childWidgets = getWidgetChildren(widget);
	const childComponents = getComponentChildren(component);
	for (let i = 0; i < childWidgets.length && i < childComponents.length; i++) {
		ids.push(...registerWidgetSubtree(targets, childWidgets[i], childComponents[i], options));
	}
	return ids;
}

function rerenderWidgetTarget(target: WidgetTarget): void {
	target.rootComponent.invalidate();
	target.update?.(componentToWidget(target.rootComponent, { width: target.width }));
}

function dispatchWidgetEventToComponent(target: WidgetTarget, event: WidgetEvent): boolean {
	const adapter = getPiGuiAdapter(target.component);
	if (adapter) {
		const payload = event.payload != null && typeof event.payload === "object" && !Array.isArray(event.payload)
			? (event.payload as Record<string, unknown>)
			: undefined;
		const result = adapter.dispatch(
			target.component,
			{ nodeid: event.nodeid, type: event.type as PiGuiWidgetEvent["type"], payload },
			{ snapshot: (component) => componentToWidget(component, { width: target.width }) }
		);
		if (result.handled) {
			rerenderWidgetTarget(target);
			return true;
		}
		if (event.type === "cancel" && target.done) {
			target.done(undefined);
			rerenderWidgetTarget(target);
			return true;
		}
		return false;
	}

	const component = target.component as Component & {
		setSelectedIndex?: (index: number) => void;
		getSelectedItem?: () => unknown;
		onSelect?: (item: unknown) => void;
		onCancel?: () => void;
		setValue?: (value: string) => void;
		getValue?: () => string;
		onSubmit?: (value: string) => void;
		onEscape?: () => void;
	};
	if (event.type === "change") {
		const payload = event.payload as { value?: unknown } | undefined;
		if (typeof payload?.value !== "string" || !component.setValue) return false;
		component.setValue(payload.value);
		rerenderWidgetTarget(target);
		return true;
	}
	if (event.type === "submit") {
		if (component.onSubmit && component.getValue) {
			component.onSubmit(component.getValue());
			rerenderWidgetTarget(target);
			return true;
		}
		return false;
	}
	if (event.type === "select") {
		const payload = event.payload as { index?: unknown } | undefined;
		if (typeof payload?.index === "number" && component.setSelectedIndex) {
			component.setSelectedIndex(payload.index);
		}
		const item = component.getSelectedItem?.();
		if (item != null && component.onSelect) {
			component.onSelect(item);
			rerenderWidgetTarget(target);
			return true;
		}
		return false;
	}
	if (event.type === "cancel") {
		if (component.onEscape) {
			component.onEscape();
		} else if (component.onCancel) {
			component.onCancel();
		} else if (typeof component.handleInput === "function") {
			component.handleInput("\x1b");
		} else {
			target.done?.(undefined);
		}
		rerenderWidgetTarget(target);
		return true;
	}
	if (event.type === "key") {
		const payload = event.payload as { data?: unknown } | undefined;
		if (typeof payload?.data !== "string" || typeof component.handleInput !== "function") return false;
		component.handleInput(payload.data);
		rerenderWidgetTarget(target);
		return true;
	}
	return false;
}

/**
 * Build the minimal context handed to extension handlers. When a `uiBridge`
 * with an attached host is present, ctx.ui routes to the renderer (notify →
 * toast, setStatus/setWidget → inline display, confirm/select/input → inline
 * prompt round-trip) and `hasUI` is true. With no host attached (headless /
 * pre-attach), ctx.ui degrades to console.log + auto-accept and `hasUI` is
 * false. `cwd` and `hasUI` are getters so they track the live env.cwd (which
 * buildAgentHarnessHost mutates on update()) and the late-attached host.
 */
export function createExtensionContext(
	getCwd: () => string,
	uiBridge?: ExtensionUiBridge,
	host?: ExtensionContextHost,
): ExtensionContext {
	const persistentWidgetUnregisters = new Map<string, () => void>();
	let headerUnregister: (() => void) | undefined;
	let footerUnregister: (() => void) | undefined;
	const ui: ExtensionUI = {
		notify: (message, level) => {
			const host = uiBridge?.host;
			if (host) {
				host.notify(message, level ?? "info");
				return;
			}
			const tag = level ?? "info";
			console.log(`[extension:${tag}] ${message}`);
		},
		setStatus: (key, text) => {
			uiBridge?.host?.setStatus(key, text);
		},
		setWidget: (key, value) => {
			const host = uiBridge?.host;
			if (!host) return;
			persistentWidgetUnregisters.get(key)?.();
			persistentWidgetUnregisters.delete(key);
			const component = componentFromUiValue(value);
			if (!component) {
				host.setWidget(key, serializeUiValue(value));
				return;
			}
			const width = 80;
			const widget = componentToWidget(component, { width });
			persistentWidgetUnregisters.set(
				key,
				uiBridge.registerWidgetRoot(widget, component, undefined, {
					width,
					update: (updatedWidget) => host.setWidget(key, updatedWidget),
				})
			);
			host.setWidget(key, widget);
		},
		setFooter: (value) => {
			const host = uiBridge?.host;
			if (!host) return;
			footerUnregister?.();
			footerUnregister = undefined;
			const component = componentFromUiValue(value);
			if (!component) {
				host.setFooter(serializeUiValue(value) as WidgetNode | undefined);
				return;
			}
			const width = 80;
			const widget = componentToWidget(component, { width });
			footerUnregister = uiBridge.registerWidgetRoot(widget, component, undefined, {
				width,
				update: (updatedWidget) => host.setFooter(updatedWidget),
			});
			host.setFooter(widget);
		},
		setHeader: (value) => {
			const host = uiBridge?.host;
			if (!host) return;
			headerUnregister?.();
			headerUnregister = undefined;
			const component = componentFromUiValue(value);
			if (!component) {
				host.setHeader(serializeUiValue(value) as WidgetNode | undefined);
				return;
			}
			const width = 80;
			const widget = componentToWidget(component, { width });
			headerUnregister = uiBridge.registerWidgetRoot(widget, component, undefined, {
				width,
				update: (updatedWidget) => host.setHeader(updatedWidget),
			});
			host.setHeader(widget);
		},
		// No host attached → auto-accept confirms, decline pickers (headless).
		confirm: async (title, message) => {
			const host = uiBridge?.host;
			if (!host) return true;
			return (await host.requestUi({ kind: "confirm", title, message })) as boolean;
		},
		select: async <T = string>(title: string, options: T[]): Promise<T | undefined> => {
			const host = uiBridge?.host;
			if (!host) return undefined;
			return (await host.requestUi({ kind: "select", title, options: options as unknown as string[] })) as
				| T
				| undefined;
		},
		input: async (title, initial) => {
			const host = uiBridge?.host;
			if (!host) return undefined;
			return (await host.requestUi({ kind: "input", title, initial })) as string | undefined;
		},
		custom: async <T = unknown>(factory, options): Promise<T | undefined> => {
			const host = uiBridge?.host;
			if (!host || typeof factory !== "function") return undefined;
			let doneCalled = false;
			let doneValue: unknown;
				const target: { widgetId?: string; component?: Component } = {};
			let resolveDone: (result: unknown) => void = () => {};
			const donePromise = new Promise<unknown>((resolve) => {
				resolveDone = resolve;
			});
			const width = customWidth(options);
			const tui = {
				requestRender: () => {
						if (!target.component) return;
						host.updateCustomWidget?.(componentToWidget(target.component, { width }));
				},
			};
			const done = (result?: unknown) => {
				doneCalled = true;
				doneValue = result;
					if (target.widgetId) {
						host.resolveCustomWidget?.(target.widgetId, result);
				}
				resolveDone(result);
			};
				target.component = (factory as ExtensionCustomFactory)(tui, {}, {}, done);
				const widget = componentToWidget(target.component, { width });
				target.widgetId = widget.id;
				const unregister = uiBridge.registerWidgetRoot(widget, target.component, done, {
				width,
				update: (updatedWidget) => host.updateCustomWidget?.(updatedWidget),
			});
			if (doneCalled) {
				unregister();
				return doneValue as T;
			}
			try {
				return (await Promise.race([donePromise, host.requestUi({ kind: "custom", widget, options })])) as T;
			} finally {
				unregister();
			}
		},
		editor: async (title, prefill) => {
			const host = uiBridge?.host;
			if (!host) return undefined;
			return (await host.requestUi({ kind: "editor", title, prefill })) as string | undefined;
		},
	};
	return {
		get cwd() {
			return getCwd();
		},
		get hasUI() {
			return uiBridge?.host != null;
		},
		ui,
		// Harness-backed reads/actions. Degrade gracefully when no host bound:
		// idle → true (optimistic), signal/model/usage → undefined, entries → [],
		// abort/compact → no-op. The bind layer (harness-factory) supplies a host.
		isIdle() {
			return host ? host.isIdle() : true;
		},
		get signal() {
			return host?.getSignal();
		},
		get model() {
			return host?.getModel();
		},
		getSystemPrompt() {
			return host ? host.getSystemPrompt() : Promise.resolve("");
		},
		getContextUsage() {
			return host ? host.getContextUsage() : Promise.resolve({ tokens: null, contextWindow: 0, percent: null });
		},
		getSessionEntries() {
			return host ? host.getSessionEntries() : Promise.resolve([]);
		},
		getLeafId() {
			return host ? host.getLeafId() : Promise.resolve(null);
		},
		abort() {
			host?.abort();
		},
		compact(customInstructions) {
			host?.compact(customInstructions);
		},
	};
}

/**
 * Wrap a base ExtensionContext with command-only session-control methods.
 * pi hands command handlers an ExtensionCommandContext; crest builds it by
 * layering an ExtensionCommandHost (supplied by the live pane owner) over the
 * base context. When no command host is available (headless fallback), the
 * session-control methods degrade to no-ops returning `{ cancelled: true }`.
 */
export function createCommandContext(
	base: ExtensionContext,
	commandHost?: ExtensionCommandHost,
): ExtensionCommandContext {
	const cancelled = (): Promise<{ cancelled: boolean }> => Promise.resolve({ cancelled: true });
	return {
		...base,
		get cwd() {
			return base.cwd;
		},
		get hasUI() {
			return base.hasUI;
		},
		get signal() {
			return base.signal;
		},
		get model() {
			return base.model;
		},
		waitForIdle() {
			return commandHost ? commandHost.waitForIdle() : Promise.resolve();
		},
		reload() {
			return commandHost ? commandHost.reload() : Promise.resolve();
		},
		navigateTree(targetId, options) {
			return commandHost ? commandHost.navigateTree(targetId, options) : cancelled();
		},
		newSession() {
			return commandHost ? commandHost.newSession() : cancelled();
		},
		fork(entryId) {
			return commandHost ? commandHost.fork(entryId) : cancelled();
		},
		switchSession(sessionPath) {
			return commandHost ? commandHost.switchSession(sessionPath) : cancelled();
		},
		sendMessage(text, options) {
			return commandHost ? commandHost.sendMessage(text, options) : Promise.resolve();
		},
	};
}

/** Merge every extension's registered tools into one list (later wins on name clash). */
export function collectExtensionTools(extensions: Extension[]): AgentTool[] {
	const byName = new Map<string, AgentTool>();
	for (const ext of extensions) {
		for (const { definition } of ext.tools.values()) {
			byName.set(definition.name, definition);
		}
	}
	return [...byName.values()];
}

export function mergeBaseAndExtensionTools(baseTools: AgentTool[], extensions: Extension[]): AgentTool[] {
	const baseToolNames = new Set(baseTools.map((tool) => tool.name));
	const extensionTools = collectExtensionTools(extensions).filter((tool) => !baseToolNames.has(tool.name));
	return extensionTools.length > 0 ? [...baseTools, ...extensionTools] : baseTools;
}

interface ExtensionRenderOptions {
	width: number;
}

function renderExtensionWidget(
	extensions: Extension[],
	customType: string,
	data: unknown,
	options: ExtensionRenderOptions,
	kind: "message" | "entry"
): WidgetNode | undefined {
	for (const extension of extensions) {
		const renderer =
			kind === "message"
				? extension.messageRenderers.get(customType)
				: extension.entryRenderers.get(customType);
		if (!renderer) continue;
		const component = renderer(data);
		if (!isComponent(component)) return undefined;
		return componentToWidget(component, options);
	}
	return undefined;
}

export function renderExtensionMessage(
	extensions: Extension[],
	customType: string,
	data: unknown,
	options: ExtensionRenderOptions
): WidgetNode | undefined {
	return renderExtensionWidget(extensions, customType, data, options, "message");
}

export function renderExtensionEntry(
	extensions: Extension[],
	customType: string,
	data: unknown,
	options: ExtensionRenderOptions
): WidgetNode | undefined {
	return renderExtensionWidget(extensions, customType, data, options, "entry");
}

export function renderExtensionSessionEntries(
	extensions: Extension[],
	entries: SessionTreeEntry[],
	options: ExtensionRenderOptions
): RenderedExtensionEntryNode[] {
	const rendered: RenderedExtensionEntryNode[] = [];
	for (const entry of entries) {
		if (entry.type === "custom") {
			const widget = renderExtensionEntry(extensions, entry.customType, entry.data, options);
			if (widget) {
				rendered.push({ id: entry.id, customtype: entry.customType, source: "entry", widget });
			}
			continue;
		}
		if (entry.type === "custom_message" && entry.display) {
			const widget = renderExtensionMessage(
				extensions,
				entry.customType,
				{ content: entry.content, details: entry.details },
				options
			);
			if (widget) {
				rendered.push({ id: entry.id, customtype: entry.customType, source: "message", widget });
			}
		}
	}
	return rendered;
}

function extensionsWithHandler(extensions: Extension[], event: string): boolean {
	for (const ext of extensions) {
		const handlers = ext.handlers.get(event);
		if (handlers && handlers.length > 0) return true;
	}
	return false;
}

/**
 * Replace the loader's throwing-stub runtime action methods with
 * AgentHarness-backed implementations. Mirrors pi's bindCore(): the runtime
 * is created inert during factory load (action methods are illegal then) and
 * bound to real behavior once the harness exists.
 *
 * `baseTools` are crest's own tools; extension tools are merged on top so
 * getAllTools()/refreshTools() report and re-push the full active set.
 */
export function bindExtensionRuntime(
	runtime: ExtensionRuntime,
	harness: AgentHarness,
	baseTools: AgentTool[],
	extensions: Extension[],
): void {
	// Mirror of the harness's active tool names (the harness keeps this
	// private with no getter — agent-harness.ts:182).
	let activeToolNames = mergeBaseAndExtensionTools(baseTools, extensions).map((tool) => tool.name);

	const mergedTools = (): AgentTool[] => mergeBaseAndExtensionTools(baseTools, extensions);

	runtime.appendEntry = (customType, data) => {
		void harness.appendCustomEntry(customType, data).catch((error) => {
			console.warn(`[extension] appendEntry(${customType}) failed:`, error);
		});
	};
	runtime.getActiveTools = () => [...activeToolNames];
	runtime.getAllTools = () => mergedTools().map((tool) => tool.name);
	runtime.setActiveTools = (toolNames) => {
		activeToolNames = [...toolNames];
		void harness.setActiveTools(toolNames).catch((error) => {
			console.warn("[extension] setActiveTools failed:", error);
		});
	};
	// Extensions that register tools inside a handler (rare — most register at
	// load time) need the harness tool map re-pushed. Load-time registrations
	// are already merged by the wire layer before construction.
	runtime.refreshTools = () => {
		void harness.setTools(mergedTools(), activeToolNames).catch((error) => {
			console.warn("[extension] refreshTools failed:", error);
		});
	};
}

/**
 * Wire extension hook handlers onto the harness. One harness handler per hook
 * type folds all extensions' results with pi runner semantics. Returns an
 * unsubscribe that detaches every handler this call registered.
 *
 * Hook coverage: tool_call, tool_result, context, before_agent_start,
 * before_provider_request, before_provider_payload, session_before_compact,
 * session_before_tree (mutating hooks via harness.on), plus the observation
 * events session_compact, session_tree, model_select, thinking_level_select,
 * resources_update, after_provider_response (notify-only via harness.subscribe).
 * Remaining pi extension events (resources_discover, input/user_bash) have no
 * clean AgentHarness equivalent in the headless build and stay inert — handlers
 * for them simply never fire.
 */
export function wireExtensionHooks(
	harness: AgentHarness,
	extensions: Extension[],
	ctx: ExtensionContext,
): () => void {
	const unsubscribers: Array<() => void> = [];

	// tool_call — pi runner.ts:910. Iterate; the first handler that returns a
	// block short-circuits. Only surface a *blocking* result so we never clobber
	// the permission hook (also registered on "tool_call") under the harness's
	// last-writer-wins emitHook — a non-block result would otherwise overwrite
	// an earlier {block:true} from permissions.
	if (extensionsWithHandler(extensions, "tool_call")) {
		unsubscribers.push(
			harness.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallResult | undefined> => {
				for (const ext of extensions) {
					const handlers = ext.handlers.get("tool_call");
					if (!handlers) continue;
					for (const handler of handlers) {
						const result = (await handler(event, ctx)) as ToolCallResult | undefined;
						if (result?.block) return result;
					}
				}
				return undefined;
			}),
		);
	}

	// tool_result — pi runner.ts:860. Stack content/details/isError patches
	// across every handler; return the folded patch only if something changed.
	if (extensionsWithHandler(extensions, "tool_result")) {
		unsubscribers.push(
			harness.on("tool_result", async (event: ToolResultEvent): Promise<ToolResultPatch | undefined> => {
				const current: ToolResultEvent = { ...event };
				let modified = false;
				for (const ext of extensions) {
					const handlers = ext.handlers.get("tool_result");
					if (!handlers) continue;
					for (const handler of handlers) {
						const patch = (await handler(current, ctx)) as ToolResultPatch | undefined;
						if (!patch) continue;
						if (patch.content !== undefined) {
							current.content = patch.content;
							modified = true;
						}
						if (patch.details !== undefined) {
							current.details = patch.details;
							modified = true;
						}
						if (patch.isError !== undefined) {
							current.isError = patch.isError;
							modified = true;
						}
					}
				}
				if (!modified) return undefined;
				return { content: current.content, details: current.details, isError: current.isError };
			}),
		);
	}

	// context — pi runner.ts:962. Chain the message array through each handler.
	if (extensionsWithHandler(extensions, "context")) {
		unsubscribers.push(
			harness.on("context", async (event: ContextEvent): Promise<ContextResult | undefined> => {
				let messages: AgentMessage[] = event.messages;
				let modified = false;
				for (const ext of extensions) {
					const handlers = ext.handlers.get("context");
					if (!handlers) continue;
					for (const handler of handlers) {
						const chained: ContextEvent = { type: "context", messages };
						const result = (await handler(chained, ctx)) as ContextResult | undefined;
						if (result?.messages) {
							messages = result.messages;
							modified = true;
						}
					}
				}
				if (!modified) return undefined;
				return { messages };
			}),
		);
	}

	// before_agent_start — pi runner.ts:1059. Append each handler's `message`
	// into a list and chain `systemPrompt`. pi handlers return the singular
	// `{ message }`; crest's BeforeAgentStartResult carries `messages[]`, so we
	// accumulate here.
	if (extensionsWithHandler(extensions, "before_agent_start")) {
		unsubscribers.push(
			harness.on(
				"before_agent_start",
				async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartResult | undefined> => {
					const messages: AgentMessage[] = [];
					let systemPrompt = event.systemPrompt;
					let systemPromptModified = false;
					for (const ext of extensions) {
						const handlers = ext.handlers.get("before_agent_start");
						if (!handlers) continue;
						for (const handler of handlers) {
							const chained: BeforeAgentStartEvent = { ...event, systemPrompt };
							const result = (await handler(chained, ctx)) as
								| { message?: AgentMessage; messages?: AgentMessage[]; systemPrompt?: string }
								| undefined;
							if (!result) continue;
							if (result.message) messages.push(result.message);
							if (result.messages) messages.push(...result.messages);
							if (result.systemPrompt !== undefined) {
								systemPrompt = result.systemPrompt;
								systemPromptModified = true;
							}
						}
					}
					if (messages.length === 0 && !systemPromptModified) return undefined;
					return {
						messages: messages.length > 0 ? messages : undefined,
						systemPrompt: systemPromptModified ? systemPrompt : undefined,
					};
				},
			),
		);
	}

	// before_provider_request — pi runner.ts. Chain each handler's
	// streamOptions patch (headers/metadata/timeout/retries). The harness folds
	// a single returned patch, so we merge every extension's patch into one:
	// later writers win on scalar fields; header/metadata maps shallow-merge
	// (undefined values delete keys, matching applyStreamOptionsPatch).
	if (extensionsWithHandler(extensions, "before_provider_request")) {
		unsubscribers.push(
			harness.on(
				"before_provider_request",
				async (event: BeforeProviderRequestEvent): Promise<BeforeProviderRequestResult | undefined> => {
					const merged: AgentHarnessStreamOptionsPatch = {};
					let modified = false;
					for (const ext of extensions) {
						const handlers = ext.handlers.get("before_provider_request");
						if (!handlers) continue;
						for (const handler of handlers) {
							const result = (await handler(event, ctx)) as BeforeProviderRequestResult | undefined;
							const patch = result?.streamOptions;
							if (!patch) continue;
							modified = true;
							const { headers, metadata, ...rest } = patch;
							Object.assign(merged, rest);
							if (headers) merged.headers = { ...merged.headers, ...headers };
							if (metadata) merged.metadata = { ...merged.metadata, ...metadata };
						}
					}
					if (!modified) return undefined;
					return { streamOptions: merged };
				},
			),
		);
	}

	// before_provider_payload — pi runner.ts. Chain the provider payload through
	// each handler so extensions can rewrite the outgoing request body.
	if (extensionsWithHandler(extensions, "before_provider_payload")) {
		unsubscribers.push(
			harness.on(
				"before_provider_payload",
				async (event: BeforeProviderPayloadEvent): Promise<BeforeProviderPayloadResult | undefined> => {
					let payload = event.payload;
					let modified = false;
					for (const ext of extensions) {
						const handlers = ext.handlers.get("before_provider_payload");
						if (!handlers) continue;
						for (const handler of handlers) {
							const chained: BeforeProviderPayloadEvent = { ...event, payload };
							const result = (await handler(chained, ctx)) as BeforeProviderPayloadResult | undefined;
							if (result && "payload" in result) {
								payload = result.payload;
								modified = true;
							}
						}
					}
					if (!modified) return undefined;
					return { payload };
				},
			),
		);
	}

	// session_before_compact — pi runner.ts. The first handler that cancels
	// short-circuits; otherwise the first handler that supplies a compaction
	// result wins (a provided summary replaces the model-generated one).
	if (extensionsWithHandler(extensions, "session_before_compact")) {
		unsubscribers.push(
			harness.on(
				"session_before_compact",
				async (event: SessionBeforeCompactEvent): Promise<SessionBeforeCompactResult | undefined> => {
					let compaction: SessionBeforeCompactResult["compaction"];
					for (const ext of extensions) {
						const handlers = ext.handlers.get("session_before_compact");
						if (!handlers) continue;
						for (const handler of handlers) {
							const result = (await handler(event, ctx)) as SessionBeforeCompactResult | undefined;
							if (result?.cancel) return { cancel: true };
							if (result?.compaction && !compaction) compaction = result.compaction;
						}
					}
					if (!compaction) return undefined;
					return { compaction };
				},
			),
		);
	}

	// session_before_tree — pi runner.ts. First cancel short-circuits; otherwise
	// the first handler supplying a summary / instructions / label wins.
	if (extensionsWithHandler(extensions, "session_before_tree")) {
		unsubscribers.push(
			harness.on(
				"session_before_tree",
				async (event: SessionBeforeTreeEvent): Promise<SessionBeforeTreeResult | undefined> => {
					let provided: SessionBeforeTreeResult | undefined;
					for (const ext of extensions) {
						const handlers = ext.handlers.get("session_before_tree");
						if (!handlers) continue;
						for (const handler of handlers) {
							const result = (await handler(event, ctx)) as SessionBeforeTreeResult | undefined;
							if (result?.cancel) return { cancel: true };
							if (result && !provided) provided = result;
						}
					}
					return provided;
				},
			),
		);
	}

	// Observation events — pi runner.ts fans notify-only lifecycle events to
	// extensions. The harness emits these via emitOwn(), which reaches only
	// SUBSCRIBER_EVENT_TYPE listeners (harness.subscribe), NOT the per-type
	// harness.on() seam used by the mutating hooks above. So we register one
	// subscribe() listener that dispatches each observed event to every
	// extension handler for that type. Return values are ignored (notify-only);
	// handlers run in registration order and their errors propagate like any
	// other hook error (harness normalizes them). Only attach the listener when
	// at least one extension observes at least one of these events.
	const OBSERVATION_EVENTS = [
		"session_compact",
		"session_tree",
		"model_select",
		"thinking_level_select",
		"resources_update",
		"after_provider_response",
	] as const;
	if (OBSERVATION_EVENTS.some((type) => extensionsWithHandler(extensions, type))) {
		const observed = new Set<string>(OBSERVATION_EVENTS);
		unsubscribers.push(
			harness.subscribe(async (event) => {
				if (!observed.has(event.type)) return;
				for (const ext of extensions) {
					const handlers = ext.handlers.get(event.type);
					if (!handlers) continue;
					for (const handler of handlers) {
						await handler(event, ctx);
					}
				}
			}),
		);
	}

	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
}
