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

function plannedBehavior(behavior: string[]): { behavior: string[]; plannedBehavior: string[] } {
	return { behavior: [...behavior], plannedBehavior: [...behavior] };
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
		notes: "Renders as native GUI text.",
		certification: "passing",
		behaviorRequirements: [
			requirement("text-snapshot", "Text snapshot", "Serialize text content and padding into a stable widget node.", "covered", [
				"extensions.test.ts:pi-gui-showcase",
				"pi-gui/crest/walker.test.ts",
			]),
		],
	},
	{
		id: "box",
		label: "Box",
		status: "native-gui",
		notes: "Renders nested children; full child layout parity remains an M2 certification blocker.",
		...plannedBehavior(["child-layout"]),
		certification: "planned",
		behaviorRequirements: [
			requirement("child-layout", "Child layout", "Serialize child order and padding so nested interactions target the correct live component.", "partial", [
				"extensions.test.ts:nested-child-events",
				"docs/pi-gui-design.md:M2",
			]),
		],
	},
	{
		id: "spacer",
		label: "Spacer",
		status: "native-gui",
		notes: "Renders spacing nodes.",
		certification: "passing",
		behaviorRequirements: [
			requirement("spacing", "Spacing", "Serialize requested vertical space without changing adjacent widget identity.", "covered", [
				"extensions.test.ts:pi-gui-showcase",
			]),
		],
	},
	{
		id: "select-list",
		label: "SelectList",
		status: "native-gui",
		notes: "Basic pointer interaction exists; keyboard, filtering, scrolling, and focus parity remain M2 certification blockers.",
		...plannedBehavior(["keyboard-navigation", "filtering", "scrolling", "focus"]),
		certification: "planned",
		behaviorRequirements: [
			requirement("snapshot-items", "Snapshot items", "Expose item value, label, description, selected index, max visible rows, filter, and focus.", "covered", [
				"pi-gui/crest/walker.test.ts",
			]),
			requirement("pointer-select", "Pointer select", "Dispatch GUI selection events to the live Pi onSelect callback.", "covered", [
				"extensions.test.ts:routes-selectlist-widget-events",
			]),
			requirement("keyboard-navigation", "Keyboard navigation", "Arrow keys and enter must match Pi selection movement and activation.", "planned", [
				"docs/pi-gui-design.md:M2",
			]),
			requirement("filtering", "Filtering", "Typing to filter must update visible matches and no-match state like Pi TUI.", "planned", [
				"docs/pi-gui-design.md:M2",
			]),
			requirement("scrolling", "Scrolling", "Max-visible scrolling must preserve selected item visibility.", "planned", [
				"docs/pi-gui-design.md:M2",
			]),
			requirement("focus", "Focus", "Focused and blurred states must be observable and keyboard routable.", "planned", [
				"docs/pi-gui-design.md:M2",
			]),
		],
	},
	{
		id: "settings-list",
		label: "SettingsList",
		status: "native-gui",
		notes: "Displays settings and routes immediate value changes, activation, and cancellation; full keyboard/search/submenu/layout parity remains an M2 certification blocker.",
		...plannedBehavior(["keyboard-navigation", "search", "submenu", "layout-parity"]),
		certification: "planned",
		behaviorRequirements: [
			requirement("snapshot-values", "Snapshot values", "Expose setting labels, descriptions, current values, available values, and selected index.", "covered", [
				"pi-gui/crest/walker.test.ts",
			]),
			requirement("selection", "Selection", "GUI selection must track the same active setting as Pi TUI.", "partial", [
				"pi-gui/crest/walker.test.ts",
				"agent-ext-ui.test.tsx",
			]),
			requirement("value-change", "Value change", "Left/right or equivalent controls must mutate values immediately through Pi callbacks.", "partial", [
				"pi-gui/crest/walker.test.ts",
				"agent-ext-ui.test.tsx",
			]),
			requirement("activate", "Activate", "Activation must match Pi's immediate Enter/Space behavior for values and submenus.", "partial", [
				"pi-gui/crest/walker.test.ts",
				"agent-ext-ui.test.tsx",
			]),
			requirement("cancel", "Cancel", "Cancel must report cancellation without implying pending edit rollback.", "covered", [
				"pi-gui/crest/walker.test.ts",
				"agent-ext-ui.test.tsx",
			]),
			requirement("search-submenu-layout", "Search, submenu, layout", "Search input, submenu handoff, max-visible scrolling, and layout parity must match Pi TUI.", "planned", [
				"docs/pi-gui-design.md:M2",
			]),
		],
	},
	{
		id: "input",
		label: "Input",
		status: "native-gui",
		notes: "Basic submit/cancel exists; text editing, IME, selection, and clipboard parity remain M2 certification blockers.",
		...plannedBehavior(["text-editing", "selection-ime-clipboard"]),
		certification: "planned",
		behaviorRequirements: [
			requirement("value-snapshot", "Value snapshot", "Expose value, cursor, and focus in the widget node.", "covered", [
				"pi-gui/crest/walker.test.ts",
			]),
			requirement("text-editing", "Text editing", "GUI edits must update the live Pi input value before submit.", "partial", [
				"extensions.test.ts:routes-input-widget-submit-events",
			]),
			requirement("submit", "Submit", "Submit must invoke the live Pi onSubmit callback with the current value.", "covered", [
				"extensions.test.ts:routes-input-widget-submit-events",
			]),
			requirement("cancel", "Cancel", "Cancel must invoke the live Pi escape/cancel callback.", "covered", [
				"extensions.test.ts:routes-input-widget-cancel-events",
			]),
			requirement("selection-ime-clipboard", "Selection, IME, clipboard", "Selection, composition, paste, and shortcut editing must match Pi input behavior.", "planned", [
				"docs/pi-gui-design.md:M2",
			]),
		],
	},
	{
		id: "markdown",
		label: "Markdown",
		status: "native-gui",
		notes: "Renders Markdown semantically; source rendering parity remains an M2 certification blocker.",
		...plannedBehavior(["source-rendering"]),
		certification: "planned",
		behaviorRequirements: [
			requirement("source-rendering", "Source rendering", "Preserve source Markdown and render through the semantic GUI pipeline.", "partial", [
				"extensions.test.ts:pi-gui-showcase",
				"docs/pi-gui-design.md:M2",
			]),
		],
	},
	{
		id: "editor",
		label: "Editor",
		status: "native-gui",
		notes: "Displays editor content and routes basic editing, key dispatch, and submit; cancel remains an M2 certification blocker because the Pi Editor component has no supported cancel callback.",
		...plannedBehavior(["cancel", "cursor-selection-parity", "selection-ime-clipboard"]),
		certification: "planned",
		behaviorRequirements: [
			requirement("content-snapshot", "Content snapshot", "Expose editor value, lines, cursor position, focus, and padding.", "covered", [
				"pi-gui/crest/walker.test.ts",
			]),
			requirement("text-editing", "Text editing", "GUI editing must mutate the live Pi editor buffer.", "partial", [
				"pi-gui/crest/walker.test.ts",
				"agent-ext-ui.test.tsx",
			]),
			requirement("cursor-selection", "Cursor and selection", "Cursor motion and selection must match Pi editor semantics.", "partial", [
				"pi-gui/crest/walker.test.ts",
				"agent-ext-ui.test.tsx",
			]),
			requirement("submit", "Submit", "Submit must resolve with the current editor contents.", "covered", [
				"pi-gui/crest/walker.test.ts",
				"agent-ext-ui.test.tsx",
			]),
			requirement("cancel", "Cancel", "Cancel must be dispatched only after the Pi Editor exposes a supported cancel callback.", "planned", [
				"docs/pi-gui-design.md:M2",
			]),
		],
	},
	{
		id: "image",
		label: "Image",
		status: "native-gui",
		notes: "Renders image metadata and previews where available.",
		certification: "passing",
		behaviorRequirements: [
			requirement("image-metadata", "Image metadata", "Expose source, MIME type, filename, and dimensions when available.", "covered", [
				"extensions.test.ts:pi-gui-showcase",
				"pi-gui/crest/walker.test.ts",
			]),
		],
	},
	{
		id: "loader",
		label: "Loader",
		status: "native-gui",
		notes: "Covers both Loader and CancellableLoader state and cancellation; animation cadence remains an M2 certification blocker until backed by timer tests.",
		...plannedBehavior(["animation-cadence"]),
		certification: "planned",
		behaviorRequirements: [
			requirement("state-snapshot", "State snapshot", "Expose label, current frame, cancellable state, and aborted state.", "covered", [
				"pi-gui/crest/walker.test.ts",
			]),
			requirement("animation", "Animation", "GUI updates must advance frames on the same lifecycle cadence as Pi.", "planned", [
				"docs/pi-gui-design.md:M2",
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
		notes: "Renders truncated text in GUI.",
		certification: "passing",
		behaviorRequirements: [
			requirement("truncation", "Truncation", "Expose the truncated text value and padding expected by the GUI renderer.", "covered", [
				"extensions.test.ts:pi-gui-showcase",
				"pi-gui/crest/walker.test.ts",
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
