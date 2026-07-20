// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createCommandContext,
	createExtensionContext,
	createExtensionUiBridge,
	loadAgentExtensions,
	type ExtensionUiHost,
	type WidgetEvent,
} from "./index";
import { PiTuiComponentCompatibilityMatrix } from "./compatibility";
import type { WidgetNode } from "./pi-gui/crest/widget-tree";

export type PiOfficialExampleCertificationStatus = "passed" | "failed" | "unsupported";

export interface PiOfficialExampleFixture {
	id: string;
	label: string;
	path: string;
	command: string;
	expectedComponentKinds: string[];
	expectedVisibleText?: string[];
	expectedHiddenVisibleText?: string[];
	visibleBehaviors?: PiOfficialExampleVisibleBehavior[];
}

export interface PiOfficialExampleVisibleBehaviorEvent extends Omit<WidgetEvent, "nodeid"> {
	targetKind?: string;
	targetId?: string;
	targetLabel?: string;
}

export interface PiOfficialExampleVisibleBehavior {
	label: string;
	events: PiOfficialExampleVisibleBehaviorEvent[];
	expectedText: string;
	unexpectedText?: string;
}

export interface PiOfficialExampleVisibleAssertion {
	label: string;
	status: "passed" | "failed";
	actualText: string;
	expectedText: string;
}

export interface PiOfficialExampleCertificationResult {
	id: string;
	label: string;
	path: string;
	command: string;
	status: PiOfficialExampleCertificationStatus;
	componentKinds: string[];
	visibleAssertions: PiOfficialExampleVisibleAssertion[];
	unsupportedReasons: string[];
	errors: string[];
}

export interface PiOfficialExampleCertificationReport {
	status: "passed" | "failed";
	total: number;
	passed: number;
	unsupported: number;
	failed: number;
	componentKinds: string[];
	results: PiOfficialExampleCertificationResult[];
}

interface RunPiOfficialExamplesCertificationOptions {
	cwd: string;
	configHome?: string;
	fixtures?: PiOfficialExampleFixture[];
}

const FixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const OfficialExamplesDir = join(FixturesDir, "pi-official-examples");

export const PiOfficialExampleFixtures: PiOfficialExampleFixture[] = [
	{
		id: "select-input",
		label: "Select and input official example",
		path: join(OfficialExamplesDir, "select-input.ts"),
		command: "pi-official-select-input",
		expectedComponentKinds: ["box", "input", "selectlist", "text"],
		expectedVisibleText: ["Select Input Example", "Interaction: ready", "draft", "Alpha", "Beta"],
		visibleBehaviors: [
			{
				label: "selecting an item updates the visible status",
				events: [{ targetKind: "selectlist", type: "select", payload: { index: 1 } }],
				expectedText: "Selected: Beta",
			},
			{
				label: "submitting edited input updates the visible status",
				events: [
					{ targetKind: "input", type: "change", payload: { value: "final answer" } },
					{ targetKind: "input", type: "submit" },
				],
				expectedText: "Submitted: final answer",
			},
		],
	},
	{
		id: "markdown-layout",
		label: "Markdown and layout official example",
		path: join(OfficialExamplesDir, "markdown-layout.ts"),
		command: "pi-official-markdown-layout",
		expectedComponentKinds: ["box", "markdown", "spacer", "text", "truncatedtext"],
		expectedVisibleText: ["Markdown Layout Example", "# Official Markdown Layout", "footer: ready"],
	},
	{
		id: "official-interactive",
		label: "Official interactive components",
		path: join(FixturesDir, "pi-official-interactive-example.ts"),
		command: "pi-official-interactive",
		expectedComponentKinds: [
			"box",
			"cancellable-loader",
			"editor",
			"image",
			"input",
			"loader",
			"selectlist",
			"settingslist",
			"text",
		],
		expectedVisibleText: ["Official Interactive Example", "draft", "Mode", "gui", "edit me"],
	},
	{
		id: "official-custom-unsupported",
		label: "Official custom component fallback",
		path: join(FixturesDir, "pi-official-custom-unsupported-example.ts"),
		command: "pi-official-custom-unsupported",
		expectedComponentKinds: ["terminal"],
		expectedHiddenVisibleText: ["custom upstream tui surface"],
	},
	{
		id: "pi-gui-showcase",
		label: "Pi GUI showcase behavior certification",
		path: join(FixturesDir, "pi-gui-showcase-extension.ts"),
		command: "pi-gui-showcase",
		expectedComponentKinds: [
			"box",
			"chart",
			"diffview",
			"editor",
			"image",
			"input",
			"loader",
			"markdown",
			"richtable",
			"selectlist",
			"settingslist",
			"terminal",
			"text",
			"truncatedtext",
		],
		expectedVisibleText: ["Pi GUI Showcase", "Interaction: ready", "editable", "Text", "Input"],
		visibleBehaviors: [
			{
				label: "selecting showcase item records a visible selected result",
				events: [{ targetKind: "selectlist", type: "select", payload: { index: 1 } }],
				expectedText: "Selected: Input",
			},
			{
				label: "submitting showcase input records a visible submitted result",
				events: [
					{ targetKind: "input", type: "change", payload: { value: "certified value" } },
					{ targetKind: "input", type: "submit" },
				],
				expectedText: "Submitted: certified value",
			},
			{
				label: "cancelling showcase input records a visible cancelled result",
				events: [{ targetKind: "input", type: "cancel" }],
				expectedText: "Cancelled",
			},
		],
	},
];

function widgetComponentKind(widget: WidgetNode): string {
	if (widget.kind === "loader" && widget.cancellable) return "cancellable-loader";
	return widget.kind;
}

function collectWidgetKinds(widget: WidgetNode, kinds: Set<string>): void {
	kinds.add(widgetComponentKind(widget));
	if ("children" in widget) {
		for (const child of widget.children) {
			collectWidgetKinds(child, kinds);
		}
	}
}

function collectWidgetText(widget: WidgetNode, lines: string[]): void {
	if (widget.kind === "text" || widget.kind === "truncatedtext") {
		lines.push(widget.text);
		return;
	}
	if (widget.kind === "input") {
		lines.push(widget.value);
		return;
	}
	if (widget.kind === "markdown") {
		lines.push(widget.source);
		return;
	}
	if (widget.kind === "selectlist") {
		for (const item of widget.items) {
			lines.push(item.label);
			if (item.description) lines.push(item.description);
			lines.push(item.value);
		}
		return;
	}
	if (widget.kind === "settingslist") {
		for (const item of widget.items) {
			lines.push(item.label);
			lines.push(item.currentvalue);
			if (item.description) lines.push(item.description);
		}
		return;
	}
	if (widget.kind === "editor") {
		lines.push(widget.value);
		lines.push(...widget.lines);
		return;
	}
	if (widget.kind === "loader") {
		lines.push(widget.label);
		lines.push(widget.frame);
		return;
	}
	if (widget.kind === "image") {
		lines.push(widget.src);
		lines.push(widget.mimetype);
		if (widget.filename) lines.push(widget.filename);
		return;
	}
	if (widget.kind === "terminal") {
		lines.push(...widget.lines);
		return;
	}
	if ("children" in widget) {
		for (const child of widget.children) {
			collectWidgetText(child, lines);
		}
	}
}

function sortedKinds(widgets: WidgetNode[]): string[] {
	const kinds = new Set<string>();
	for (const widget of widgets) {
		collectWidgetKinds(widget, kinds);
	}
	return [...kinds].sort();
}

function visibleText(widgets: WidgetNode[]): string {
	const lines: string[] = [];
	for (const widget of widgets) {
		collectWidgetText(widget, lines);
	}
	return lines.join("\n");
}

function findWidgetByKind(widget: WidgetNode, kind: string): WidgetNode | undefined {
	if (widgetComponentKind(widget) === kind) return widget;
	if ("children" in widget) {
		for (const child of widget.children) {
			const match = findWidgetByKind(child, kind);
			if (match) return match;
		}
	}
	return undefined;
}

function widgetOwnText(widget: WidgetNode): string[] {
	if (widget.kind === "text" || widget.kind === "truncatedtext") return [widget.text];
	if (widget.kind === "input") return [widget.value];
	if (widget.kind === "markdown") return [widget.source];
	if (widget.kind === "selectlist") return widget.items.flatMap((item) => [item.value, item.label, item.description ?? ""]);
	if (widget.kind === "settingslist") {
		return widget.items.flatMap((item) => [item.id, item.label, item.description ?? "", item.currentvalue, ...(item.values ?? [])]);
	}
	if (widget.kind === "terminal") return widget.lines;
	if (widget.kind === "editor") return [widget.value, ...widget.lines];
	if (widget.kind === "loader") return [widget.label, widget.frame];
	if (widget.kind === "image") return [widget.src, widget.mimetype, widget.filename ?? ""];
	return [];
}

function widgetMatchesTarget(widget: WidgetNode, event: PiOfficialExampleVisibleBehaviorEvent): boolean {
	if (event.targetKind && widgetComponentKind(widget) !== event.targetKind) return false;
	if (event.targetId && widget.id !== event.targetId) return false;
	if (event.targetLabel && !widgetOwnText(widget).includes(event.targetLabel)) return false;
	return Boolean(event.targetKind || event.targetId || event.targetLabel);
}

function findWidgetByTarget(widget: WidgetNode, event: PiOfficialExampleVisibleBehaviorEvent): WidgetNode | undefined {
	if (widgetMatchesTarget(widget, event)) return widget;
	if ("children" in widget) {
		for (const child of widget.children) {
			const match = findWidgetByTarget(child, event);
			if (match) return match;
		}
	}
	return undefined;
}

function findLatestWidgetByTarget(widgets: WidgetNode[], event: PiOfficialExampleVisibleBehaviorEvent): WidgetNode | undefined {
	for (let i = widgets.length - 1; i >= 0; i--) {
		const match = findWidgetByTarget(widgets[i], event);
		if (match) return match;
	}
	return undefined;
}

function findMissingKinds(expectedKinds: string[], actualKinds: string[]): string[] {
	const actual = new Set(actualKinds);
	return expectedKinds.filter((kind) => !actual.has(kind));
}

function unsupportedReasons(componentKinds: string[]): string[] {
	const reasons: string[] = [];
	for (const kind of componentKinds) {
		if (kind === "terminal") {
			reasons.push("terminal fallback widget requires M3 terminal surface certification");
			continue;
		}
		const item = PiTuiComponentCompatibilityMatrix.find((item) => widgetKindCompatibilityId(kind) === item.id);
		if (item?.certification === "planned") {
			const blockers = item.plannedBehavior?.join(", ") || item.behaviorRequirements.map((requirement) => requirement.id).join(", ");
			reasons.push(`planned component certification blocker: ${item.label} (${blockers})`);
		}
	}
	return reasons;
}

function resultStatus(errors: string[], reasons: string[]): PiOfficialExampleCertificationStatus {
	if (errors.length > 0) return "failed";
	if (reasons.length > 0) return "unsupported";
	return "passed";
}

function widgetKindCompatibilityId(kind: string): string {
	if (kind === "cancellable-loader") return "loader";
	if (kind === "container") return "box";
	if (kind === "selectlist") return "select-list";
	if (kind === "settingslist") return "settings-list";
	if (kind === "truncatedtext") return "truncated-text";
	if (kind === "terminal") return "custom-component";
	return kind;
}

async function runFixture(
	fixture: PiOfficialExampleFixture,
	options: RunPiOfficialExamplesCertificationOptions
): Promise<PiOfficialExampleCertificationResult> {
	const errors: string[] = [];
	const visibleAssertions: PiOfficialExampleVisibleAssertion[] = [];
	const widgets = new Map<string, WidgetNode>();
	const observedWidgets: WidgetNode[] = [];
	const currentWidgets = (): WidgetNode[] => [...widgets.values()];
	const setWidgetSlot = (slot: string, value: string[] | WidgetNode | undefined): void => {
		if (!value || Array.isArray(value)) {
			widgets.delete(slot);
			return;
		}
		observedWidgets.push(value);
		widgets.set(slot, value);
	};
	const loadResult = await loadAgentExtensions({
		cwd: options.cwd,
		configHome: options.configHome,
		paths: [fixture.path],
		trackGraph: false,
	});
	for (const error of loadResult.errors) {
		errors.push(`${error.path}: ${error.error}`);
	}

	const extension = loadResult.extensions.find((extension) => extension.commands.has(fixture.command));
	const command = extension?.commands.get(fixture.command);
	if (!command) {
		errors.push(`missing command: ${fixture.command}`);
	}

	if (command) {
		const uiBridge = createExtensionUiBridge();
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: (_key, value) => {
				setWidgetSlot(`widget:${_key}`, value);
			},
			setHeader: (value) => {
				setWidgetSlot("header", value);
			},
			setFooter: (value) => {
				setWidgetSlot("footer", value);
			},
			updateCustomWidget: (widget) => {
				setWidgetSlot(`custom:${widget.id}`, widget);
			},
			resolveCustomWidget: (widgetId) => {
				widgets.delete(`custom:${widgetId}`);
				return true;
			},
			requestUi: async (request) => {
				if (request.kind === "custom") {
					setWidgetSlot(`custom:${request.widget.id}`, request.widget);
					widgets.delete(`custom:${request.widget.id}`);
				}
				return undefined;
			},
		};
		uiBridge.attach(uiHost);
		try {
			const ctx = createCommandContext(createExtensionContext(() => options.cwd, uiBridge));
			await command.handler("", ctx);
		} catch (err) {
			errors.push(err instanceof Error ? err.message : String(err));
		}
		for (const expectedText of fixture.expectedVisibleText ?? []) {
			const actualText = visibleText(currentWidgets());
			const passed = actualText.includes(expectedText);
			visibleAssertions.push({
				label: `visible text: ${expectedText}`,
				status: passed ? "passed" : "failed",
				actualText,
				expectedText,
			});
			if (!passed) errors.push(`missing visible text: ${expectedText}`);
		}
		for (const hiddenText of fixture.expectedHiddenVisibleText ?? []) {
			const actualText = visibleText(currentWidgets());
			const passed = !actualText.includes(hiddenText);
			visibleAssertions.push({
				label: `hidden text after close: ${hiddenText}`,
				status: passed ? "passed" : "failed",
				actualText,
				expectedText: hiddenText,
			});
			if (!passed) errors.push(`visible text should be hidden after close: ${hiddenText}`);
		}
		for (const behavior of fixture.visibleBehaviors ?? []) {
			for (const event of behavior.events) {
				const target = findLatestWidgetByTarget(currentWidgets(), event);
				if (!target) {
					errors.push(`missing visible behavior target: ${event.targetId ?? event.targetLabel ?? event.targetKind ?? "unknown"}`);
					continue;
				}
				const handled = uiBridge.dispatchWidgetEvent({
					nodeid: target.id,
					type: event.type,
					payload: event.payload,
				});
				if (!handled) {
					errors.push(`unhandled visible behavior event: ${behavior.label}`);
				}
			}
			const actualText = visibleText(currentWidgets());
			const passed = actualText.includes(behavior.expectedText);
			visibleAssertions.push({
				label: behavior.label,
				status: passed ? "passed" : "failed",
				actualText,
				expectedText: behavior.expectedText,
			});
			if (!passed) errors.push(`missing visible behavior text: ${behavior.expectedText}`);
			if (behavior.unexpectedText && actualText.includes(behavior.unexpectedText)) {
				visibleAssertions[visibleAssertions.length - 1].status = "failed";
				errors.push(`unexpected visible behavior text: ${behavior.unexpectedText}`);
			}
		}
	}

	const componentKinds = sortedKinds(observedWidgets);
	const missingKinds = findMissingKinds(fixture.expectedComponentKinds, componentKinds);
	for (const kind of missingKinds) {
		errors.push(`missing component kind: ${kind}`);
	}
	const reasons = unsupportedReasons(componentKinds);

	return {
		id: fixture.id,
		label: fixture.label,
		path: fixture.path,
		command: fixture.command,
		status: resultStatus(errors, reasons),
		componentKinds,
		visibleAssertions,
		unsupportedReasons: reasons,
		errors,
	};
}

export async function runPiOfficialExamplesCertification(
	options: RunPiOfficialExamplesCertificationOptions
): Promise<PiOfficialExampleCertificationReport> {
	const fixtures = options.fixtures ?? PiOfficialExampleFixtures;
	const results: PiOfficialExampleCertificationResult[] = [];
	for (const fixture of fixtures) {
		results.push(await runFixture(fixture, options));
	}
	const passed = results.filter((result) => result.status === "passed").length;
	const unsupported = results.filter((result) => result.status === "unsupported").length;
	const failed = results.filter((result) => result.status === "failed").length;
	const componentKinds = [...new Set(results.flatMap((result) => result.componentKinds))].sort();
	return {
		status: failed === 0 && unsupported === 0 ? "passed" : "failed",
		total: results.length,
		passed,
		unsupported,
		failed,
		componentKinds,
		results,
	};
}
