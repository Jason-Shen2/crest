// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
	ExtensionBehaviorRequirement,
	ExtensionBehaviorRequirementStatus,
	ExtensionCompatibilityItem,
	ExtensionComponentCompatibilityItem,
} from "./types";

function requirement(
	id: string,
	label: string,
	requirement: string,
	status: ExtensionBehaviorRequirementStatus,
	evidence: string[]
): ExtensionBehaviorRequirement {
	return { id, label, requirement, status, evidence };
}

/**
 * The single definition of a standard-component certification blocker. Used by
 * both the certification fixture `unsupportedReasons()` and the M2.1C behavior
 * closure gate so neither caller re-derives the condition independently.
 */
export function isStandardComponentCertificationBlocker(item: ExtensionComponentCompatibilityItem): boolean {
	if (item.id === "custom-component") return false;
	if (item.certification !== "passing") return true;
	if ((item.plannedBehavior?.length ?? 0) > 0) return true;
	return item.behaviorRequirements.some(
		(requirement) => requirement.status !== "covered" && requirement.status !== "not-applicable"
	);
}

export const PiApiCompatibilityMatrix: ExtensionCompatibilityItem[] = [
	{
		id: "commands",
		label: "Commands",
		status: "native-gui",
		notes: "Registered commands execute in live sessions and headless fallback.",
	},
	{ id: "tools", label: "Tools", status: "native-gui", notes: "Extension tools merge into the AgentHarness tool set." },
	{ id: "hooks", label: "Hooks", status: "native-gui", notes: "Core hook fold and chain semantics are wired into the harness." },
	{
		id: "flags",
		label: "Flags",
		status: "accepted-inert",
		notes: "Live values exist, but persistence and management UI are not mature yet.",
	},
	{
		id: "shortcuts",
		label: "Shortcuts",
		status: "accepted-inert",
		notes: "Registration exists, but complete GUI shortcut dispatch is not mature yet.",
	},
	{
		id: "message-renderers",
		label: "Message renderers",
		status: "native-gui",
		notes: "Renderer output can be serialized into semantic widgets.",
	},
	{
		id: "entry-renderers",
		label: "Entry renderers",
		status: "native-gui",
		notes: "Entry renderer output can be serialized into semantic widgets.",
	},
	{
		id: "providers",
		label: "Providers",
		status: "accepted-inert",
		notes: "Registration exists, but provider lifecycle and diagnostics need M2 hardening.",
	},
	{
		id: "ctx-ui",
		label: "ctx.ui",
		status: "native-gui",
		notes: "Prompt and custom UI requests work through the Crest UI bridge.",
	},
	{ id: "ctx-session", label: "ctx session", status: "native-gui", notes: "Session context is exposed from the live pane owner." },
	{ id: "ctx-tools", label: "ctx tools", status: "native-gui", notes: "Active tool access is bridged through the runtime." },
	{
		id: "ctx-runtime-actions",
		label: "ctx runtime actions",
		status: "accepted-inert",
		notes: "Some actions are live-session only and need explicit diagnostics.",
	},
];

export const PiTuiComponentCompatibilityMatrix: ExtensionComponentCompatibilityItem[] = [
	{
		id: "text",
		label: "Text",
		status: "native-gui",
		notes: "Renders as native GUI text. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("text-snapshot", "Text snapshot", "Serialize text content and padding into a stable widget node.", "covered", [
				"extensions.test.ts:pi-gui-showcase",
				"pi-gui/crest/walker.test.ts",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
		],
	},
	{
		id: "box",
		label: "Box",
		status: "native-gui",
		notes: "Renders nested children with preserved child order and padding so nested interactions target the correct live component. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("child-layout", "Child layout", "Serialize child order and padding so nested interactions target the correct live component.", "covered", [
				"extensions.test.ts:nested-child-events",
				"pi-gui/crest/walker.test.ts:adapter-contract",
				"certification/pi-official-examples.test.ts:select-input",
			]),
		],
	},
	{
		id: "spacer",
		label: "Spacer",
		status: "native-gui",
		notes: "Renders spacing nodes. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("spacing", "Spacing", "Serialize requested vertical space without changing adjacent widget identity.", "covered", [
				"extensions.test.ts:pi-gui-showcase",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
		],
	},
	{
		id: "select-list",
		label: "SelectList",
		status: "native-gui",
		notes: "Pointer and keyboard selection, filtering, scrolling, and focus route through the live Pi SelectList. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("snapshot-items", "Snapshot items", "Expose item value, label, description, selected index, max visible rows, filter, and focus.", "covered", [
				"pi-gui/crest/walker.test.ts",
				"pi-gui/crest/walker.test.ts:adapter-contract",
				"pi-gui/src/components/behavior-closure.test.ts:copies-selectlist-snapshot",
			]),
			requirement("pointer-select", "Pointer select", "Dispatch GUI selection events to the live Pi onSelect callback.", "covered", [
				"extensions.test.ts:routes-selectlist-widget-events",
				"pi-gui/src/components/behavior-closure.test.ts:selectlist-pointer-order",
			]),
			requirement("keyboard-navigation", "Keyboard navigation", "Arrow keys and enter match Pi selection movement and activation with wraparound.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:selectlist-wrap-navigation",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
			requirement("filtering", "Filtering", "Typing to filter updates visible matches and no-match state through Pi setFilter.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:selectlist-value-prefix-filter",
			]),
			requirement("scrolling", "Scrolling", "Max-visible scrolling preserves selected item visibility.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:selectlist-visible-window",
			]),
			requirement("focus", "Focus", "Focused and blurred states are observable and keyboard routable.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:selectlist-visible-focus",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
		],
	},
	{
		id: "settings-list",
		label: "SettingsList",
		status: "native-gui",
		notes: "Search, selection, immediate value changes, activation, submenu handoff, and cancellation route through the live Pi SettingsList. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("snapshot-values", "Snapshot values", "Expose setting labels, descriptions, current values, available values, and selected index.", "covered", [
				"pi-gui/crest/walker.test.ts",
				"pi-gui/crest/walker.test.ts:adapter-contract",
				"pi-gui/src/components/behavior-closure.test.ts:settingslist-search-snapshot",
			]),
			requirement("selection", "Selection", "GUI selection tracks the same active setting as Pi TUI with wraparound navigation.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:settingslist-wrap-navigation",
				"agent-ext-ui.test.tsx",
			]),
			requirement("value-change", "Value change", "Left/right controls mutate values immediately through Pi onChange callbacks.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:settingslist-value-cycle",
				"agent-ext-ui.test.tsx",
			]),
			requirement("activate", "Activate", "Activation matches Pi's immediate Enter/Space behavior for values and submenus.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:settingslist-submenu-complete",
				"agent-ext-ui.test.tsx",
			]),
			requirement("cancel", "Cancel", "Cancel reports cancellation without rolling back prior immediate changes.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:settingslist-cancel-no-rollback",
				"agent-ext-ui.test.tsx",
			]),
			requirement("search-submenu-layout", "Search, submenu, layout", "Search input, submenu handoff, max-visible scrolling, and layout parity match Pi TUI.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:settingslist-search-visible-range",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
		],
	},
	{
		id: "input",
		label: "Input",
		status: "native-gui",
		notes: "Value snapshot, text editing, submit, cancel, and browser-native selection/IME/clipboard route through the live Pi Input. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("value-snapshot", "Value snapshot", "Expose value, cursor, and focus in the widget node.", "covered", [
				"pi-gui/crest/walker.test.ts",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
			requirement("text-editing", "Text editing", "GUI edits must update the live Pi input value before submit.", "covered", [
				"extensions.test.ts:routes-input-widget-submit-events",
				"pi-gui/src/components/behavior-closure.test.ts:input-text-editing",
			]),
			requirement("submit", "Submit", "Submit must invoke the live Pi onSubmit callback with the current value.", "covered", [
				"extensions.test.ts:routes-input-widget-submit-events",
			]),
			requirement("cancel", "Cancel", "Cancel must invoke the live Pi escape/cancel callback.", "covered", [
				"extensions.test.ts:routes-input-widget-cancel-events",
			]),
			requirement("selection-ime-clipboard", "Selection, IME, clipboard", "Selection, composition, paste, and shortcut editing must match Pi input behavior.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:input-selection-ime-clipboard",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
		],
	},
	{
		id: "markdown",
		label: "Markdown",
		status: "native-gui",
		notes: "Renders Markdown semantically with source rendering parity through the GUI pipeline. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("source-rendering", "Source rendering", "Preserve source Markdown and render through the semantic GUI pipeline.", "covered", [
				"extensions.test.ts:pi-gui-showcase",
				"pi-gui/src/components/behavior-closure.test.ts:markdown-source-rendering",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
		],
	},
	{
		id: "editor",
		label: "Editor",
		status: "native-gui",
		notes: "Displays editor content and routes editing, cursor/selection, submit, and browser-native selection/IME/clipboard; cancel is not applicable because the vendored Pi Editor exposes no cancel callback. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("content-snapshot", "Content snapshot", "Expose editor value, lines, cursor position, focus, and padding.", "covered", [
				"pi-gui/crest/walker.test.ts",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
			requirement("text-editing", "Text editing", "GUI editing must mutate the live Pi editor buffer.", "covered", [
				"pi-gui/crest/walker.test.ts",
				"pi-gui/src/components/behavior-closure.test.ts:editor-text-editing",
				"agent-ext-ui.test.tsx",
			]),
			requirement("cursor-selection", "Cursor and selection", "Cursor motion and selection must match Pi editor semantics.", "covered", [
				"pi-gui/crest/walker.test.ts",
				"pi-gui/src/components/behavior-closure.test.ts:editor-cursor-selection",
				"agent-ext-ui.test.tsx",
			]),
			requirement("submit", "Submit", "Submit must resolve with the current editor contents.", "covered", [
				"pi-gui/crest/walker.test.ts",
				"agent-ext-ui.test.tsx",
			]),
			requirement("selection-ime-clipboard", "Selection, IME, clipboard", "Selection, composition, paste, and shortcut editing must match Pi editor behavior.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:editor-selection-ime-clipboard",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
			requirement("cancel", "Cancel", "The vendored Pi Editor exposes no supported cancel callback, so GUI cancel is not applicable.", "not-applicable", [
				"pi-gui/src/components/behavior-closure.test.ts:editor-cancel-not-applicable",
			]),
		],
	},
	{
		id: "image",
		label: "Image",
		status: "native-gui",
		notes: "Renders image metadata and previews where available. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("image-metadata", "Image metadata", "Expose source, MIME type, filename, and dimensions when available.", "covered", [
				"extensions.test.ts:pi-gui-showcase",
				"pi-gui/crest/walker.test.ts",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
		],
	},
	{
		id: "loader",
		label: "Loader",
		status: "native-gui",
		notes: "Covers both Loader and CancellableLoader state, animation cadence, and cancellation. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("state-snapshot", "State snapshot", "Expose label, current frame, cancellable state, and aborted state.", "covered", [
				"pi-gui/crest/walker.test.ts",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
			requirement("animation", "Animation", "GUI updates must advance frames on the same lifecycle cadence as Pi.", "covered", [
				"pi-gui/src/components/behavior-closure.test.ts:loader-animation-cadence",
			]),
			requirement("cancel", "Cancel", "Cancel must invoke the live CancellableLoader onAbort callback.", "covered", [
				"extensions.test.ts:routes-cancellable-loader-cancel-events",
				"pi-gui/crest/walker.test.ts",
				"agent-ext-ui.test.tsx",
			]),
		],
	},
	{
		id: "truncated-text",
		label: "TruncatedText",
		status: "native-gui",
		notes: "Renders truncated text in GUI. Uses the public adapter contract.",
		certification: "passing",
		behaviorRequirements: [
			requirement("truncation", "Truncation", "Expose the truncated text value and padding expected by the GUI renderer.", "covered", [
				"extensions.test.ts:pi-gui-showcase",
				"pi-gui/crest/walker.test.ts",
				"pi-gui/crest/walker.test.ts:adapter-contract",
			]),
		],
	},
	{
		id: "custom-component",
		label: "Custom Component",
		status: "unsupported",
		notes:
			"Current fallback is debug-grade only; behavior-compatible custom components require the M3 terminal surface. Crest rich extension components like RichTable, DiffView, and Chart are tracked in a separate rich component matrix.",
		plannedBehavior: ["terminal-surface-fallback"],
		certification: "unsupported",
		behaviorRequirements: [
			requirement("terminal-surface-fallback", "Terminal surface fallback", "Unknown components must remain interactive through a terminal-compatible fallback before compatibility can be claimed.", "planned", [
				"docs/pi-gui-design.md:M3",
			]),
		],
	},
];
