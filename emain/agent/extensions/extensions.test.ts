// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	bindExtensionRuntime,
	collectExtensionTools,
	createCommandContext,
	createExtensionContext,
	createExtensionRuntime,
	createExtensionUiBridge,
	defaultExtensionDirs,
	getExtensionGraphForRuntime,
	loadAgentExtensions,
	loadExtensionFromFactory,
	renderExtensionEntry,
	renderExtensionMessage,
	renderExtensionSessionEntries,
	wireExtensionHooks,
} from "./index";
import { createExtensionLifecycleHost, extensionToGraphNode } from "./lifecycle";
import { CancellableLoader } from "./pi-gui/src/components/cancellable-loader";
import { Editor } from "./pi-gui/src/components/editor";
import { Loader } from "./pi-gui/src/components/loader";
import { SelectList, type SelectListTheme } from "./pi-gui/src/components/select-list";
import { SettingsList, type SettingsListTheme } from "./pi-gui/src/components/settings-list";
import { Input } from "./pi-gui/src/components/input";
import { Text } from "./pi-gui/src/components/text";
import { Box } from "./pi-gui/src/components/box";
import type { Component, TUI } from "./pi-gui/src/tui";
import { componentToWidget } from "./pi-gui/crest/walker";
import type { ExtensionUiHost, ExtUiRequest } from "./index";
import {
	ExtensionBehaviorRequirementStatuses,
	ExtensionComponentCertificationStatuses,
	ExtensionCompatibilityStatuses,
	type ExtensionBehaviorRequirement,
	type ExtensionComponentCertificationStatus,
	type ExtensionComponentCompatibilityItem,
	type Extension,
	type ExtensionCommandHost,
	type ExtensionCompatibilityItem,
	type ExtensionCompatibilityStatus,
	type ExtensionContextHost,
	type ExtensionGraph,
	type ExtensionGraphError,
	type ExtensionGraphNode,
	ExtensionRuntimeStatuses,
	type ExtensionRuntimeStatus,
	ExtensionScopes,
	type ExtensionScope,
} from "./types";
import type { WidgetNode } from "./pi-gui/crest/widget-tree";
import { registerPiGuiShowcaseExtension } from "./fixtures/pi-gui-showcase-extension";

const TestSelectListTheme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

const TestSettingsListTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

function makeExtensionUiHost(overrides: Partial<ExtensionUiHost> = {}): ExtensionUiHost {
	return {
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		setHeader: () => {},
		setFooter: () => {},
		requestUi: async () => undefined,
		...overrides,
	};
}

function writeExtension(dir: string, name: string, source: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), source);
}

describe("defaultExtensionDirs", () => {
	it("returns cwd/.crest/extensions first, then configHome/extensions", () => {
		const dirs = defaultExtensionDirs("/work/proj", "/tmp/crest-cfg");
		expect(dirs).toEqual([
			join("/work/proj", ".crest", "extensions"),
			join("/tmp/crest-cfg", "extensions"),
		]);
	});
});

describe("extension compatibility status contract", () => {
	it("exposes the baseline taxonomy for matrix entries", () => {
		expectTypeOf<ExtensionCompatibilityItem>().toEqualTypeOf<{
			id: string;
			label: string;
			status: ExtensionCompatibilityStatus;
			notes: string;
		}>();
		expectTypeOf<ExtensionBehaviorRequirement>().toEqualTypeOf<{
			id: string;
			label: string;
			requirement: string;
			status: "covered" | "partial" | "planned" | "not-applicable";
			evidence: string[];
		}>();
		expectTypeOf<ExtensionComponentCompatibilityItem>().toMatchTypeOf<ExtensionCompatibilityItem>();
		expectTypeOf<ExtensionComponentCompatibilityItem["behaviorRequirements"]>().toEqualTypeOf<
			ExtensionBehaviorRequirement[]
		>();
		expectTypeOf<ExtensionComponentCompatibilityItem["behavior"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<ExtensionComponentCompatibilityItem["plannedBehavior"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<ExtensionComponentCompatibilityItem["certification"]>().toEqualTypeOf<
			ExtensionComponentCertificationStatus | undefined
		>();
		const item: ExtensionCompatibilityItem = {
			id: "ctx.ui.custom",
			label: "ctx.ui.custom",
			status: "terminal-surface",
			notes: "Rendered through the terminal fallback backend.",
		};

		expect(ExtensionCompatibilityStatuses).toEqual([
			"native-gui",
			"terminal-surface",
			"accepted-inert",
			"unsupported",
			"not-applicable",
		]);
		expect(ExtensionBehaviorRequirementStatuses).toEqual(["covered", "partial", "planned", "not-applicable"]);
		expect(ExtensionComponentCertificationStatuses).toEqual(["planned", "passing", "unsupported"]);
	});
});

describe("Extension graph types", () => {
	it("exposes scopes, runtime statuses, nodes, errors, and aggregate graph shape", () => {
		expectTypeOf<ExtensionScope>().toEqualTypeOf<"global" | "workspace" | "session" | "headless">();
		expectTypeOf<ExtensionRuntimeStatus>().toEqualTypeOf<
			"discovered" | "loaded" | "active" | "failed" | "disabled" | "disposed"
		>();
		const error = {
			phase: "hook",
			message: "hook failed",
			timestamp: 123,
			stack: "Error: hook failed",
		} satisfies ExtensionGraphError;
		const node = {
			id: "ext.pi",
			name: "Pi Extension",
			version: "1.0.0",
			path: "/work/.crest/extensions/pi.ts",
			scope: "workspace",
			status: "active",
			commands: ["pi-show"],
			tools: ["pi_tool"],
			hooks: ["context"],
			flags: ["pi.enabled"],
			errors: [error],
		} satisfies ExtensionGraphNode;
		const graph = {
			generation: 1,
			nodes: [node],
		} satisfies ExtensionGraph;

		expect(ExtensionScopes).toEqual(["global", "workspace", "session", "headless"]);
		expect(ExtensionRuntimeStatuses).toEqual(["discovered", "loaded", "active", "failed", "disabled", "disposed"]);
		expect(graph.nodes[0].errors[0].timestamp).toBe(123);
	});
});

describe("createExtensionLifecycleHost", () => {
	function makeGraphNode(id: string, status: ExtensionRuntimeStatus = "active"): ExtensionGraphNode {
		return {
			id,
			name: id,
			version: "1.0.0",
			path: `/work/${id}.ts`,
			scope: "workspace",
			status,
			commands: [],
			tools: [],
			hooks: [],
			flags: [],
			errors: [],
		};
	}

	it("tracks graph generations, disposes resources, and marks reloads stale", async () => {
		const runtime = createExtensionRuntime();
		const invalidate = vi.spyOn(runtime, "invalidate");
		const host = createExtensionLifecycleHost(runtime);
		const calls: string[] = [];

		expect(host.getGraph()).toEqual({ generation: 0, nodes: [] });

		const node = makeGraphNode("ext.a");
		host.setNodes([node]);
		expect(host.getGraph()).toEqual({ generation: 0, nodes: [node] });
		node.status = "failed";
		expect(host.getGraph().nodes[0].status).toBe("active");

		const unregisterFirst = host.registerDispose("owner-a", () => {
			calls.push("first");
		});
		host.registerDispose("owner-a", async () => {
			calls.push("second");
		});
		unregisterFirst();

		await host.disposeAll();
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(["second"]);
		expect(host.getGraph()).toEqual({ generation: 0, nodes: [{ ...makeGraphNode("ext.a"), status: "disposed" }] });
		await host.disposeAll();
		expect(host.getGraph()).toEqual({ generation: 0, nodes: [{ ...makeGraphNode("ext.a"), status: "disposed" }] });

		host.setNodes([makeGraphNode("ext.next")]);
		expect(host.getGraph()).toEqual({ generation: 0, nodes: [makeGraphNode("ext.next")] });
		host.registerDispose("owner-next", () => {
			calls.push("reload");
		});
		await host.reloadStart();

		expect(calls).toEqual(["second", "reload"]);
		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(host.getGraph()).toEqual({ generation: 1, nodes: [{ ...makeGraphNode("ext.next"), status: "disposed" }] });
		expect(() => runtime.assertActive()).toThrow("stale after session replacement or reload");
	});

	it("disposes only the selected owner and leaves other owners pending", async () => {
		const runtime = createExtensionRuntime();
		const invalidate = vi.spyOn(runtime, "invalidate");
		const host = createExtensionLifecycleHost(runtime);
		const calls: string[] = [];

		host.registerDispose("owner-a", () => {
			calls.push("a1");
		});
		host.registerDispose("owner-b", () => {
			calls.push("b1");
		});
		host.registerDispose("owner-a", () => {
			calls.push("a2");
		});

		await host.disposeOwner("owner-a");
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(["a2", "a1"]);

		await host.disposeAll();
		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(calls).toEqual(["a2", "a1", "b1"]);
	});

	it("runs every pending disposer before surfacing disposal errors", async () => {
		const host = createExtensionLifecycleHost();
		const calls: string[] = [];
		host.setNodes([makeGraphNode("ext.error")]);
		host.registerDispose("owner-error", () => {
			calls.push("last");
		});
		host.registerDispose("owner-error", () => {
			calls.push("throws");
			throw new Error("dispose failed");
		});
		host.registerDispose("owner-error", async () => {
			calls.push("first");
		});

		await expect(host.disposeAll()).rejects.toThrow("dispose failed");

		expect(calls).toEqual(["first", "throws", "last"]);
		expect(host.getGraph()).toEqual({ generation: 0, nodes: [{ ...makeGraphNode("ext.error"), status: "disposed" }] });
		await expect(host.disposeAll()).resolves.toBeUndefined();
		expect(host.getGraph()).toEqual({ generation: 0, nodes: [{ ...makeGraphNode("ext.error"), status: "disposed" }] });
	});

	it("records load failures as failed graph nodes with timestamped errors", () => {
		const host = createExtensionLifecycleHost();
		const error = new Error("load exploded");
		error.stack = "Error: load exploded\n    at fixture";

		host.recordFailure({
			id: "ext.bad",
			name: "Bad Extension",
			version: "0.1.0",
			path: "/work/.crest/extensions/bad.ts",
			scope: "workspace",
			phase: "load",
			error,
		});

		expect(host.getGraph()).toEqual({
			generation: 0,
			nodes: [
				{
					id: "ext.bad",
					name: "Bad Extension",
					version: "0.1.0",
					path: "/work/.crest/extensions/bad.ts",
					scope: "workspace",
					status: "failed",
					commands: [],
					tools: [],
					hooks: [],
					flags: [],
					errors: [
						{
							phase: "load",
							message: "load exploded",
							stack: "Error: load exploded\n    at fixture",
							timestamp: expect.any(Number),
						},
					],
				},
			],
		});
	});

	it("exposes a read-only graph snapshot for a runtime", () => {
		const runtime = createExtensionRuntime();
		const host = createExtensionLifecycleHost(runtime);
		const dispose = vi.fn();
		host.setNodes([makeGraphNode("ext.readonly")]);
		host.registerDispose("owner-readonly", dispose);

		const graph = getExtensionGraphForRuntime(runtime);
		graph.nodes[0].status = "failed";
		graph.nodes[0].errors.push({ phase: "reload", message: "mutated caller copy", timestamp: 1 });

		expect(getExtensionGraphForRuntime(runtime)).toEqual({ generation: 0, nodes: [makeGraphNode("ext.readonly")] });
		expect(dispose).not.toHaveBeenCalled();
		expect(() => runtime.assertActive()).not.toThrow();
	});
});

describe("extensionToGraphNode", () => {
	it("converts a loaded extension registry into an active graph node with sorted registry keys", () => {
		const extension: Extension = {
			path: "/work/.crest/extensions/graph.ts",
			resolvedPath: "/real/.crest/extensions/graph.ts",
			sourceInfo: { source: "graph", path: "/work/.crest/extensions/graph.ts", baseDir: "/work" },
			commands: new Map([
				["graph.zeta", {} as any],
				["graph.alpha", {} as any],
			]),
			tools: new Map([
				["zeta_tool", {} as any],
				["alpha_tool", {} as any],
			]),
			handlers: new Map([
				["tool_call", [() => undefined]],
				["context", [() => undefined]],
			]),
			flags: new Map([
				["graph.zeta", {} as any],
				["graph.enabled", {} as any],
			]),
			shortcuts: new Map(),
			messageRenderers: new Map(),
			entryRenderers: new Map(),
		};

		expect(extensionToGraphNode(extension, "workspace")).toEqual({
			id: "/work/.crest/extensions/graph.ts",
			name: "/work/.crest/extensions/graph.ts",
			version: "0.0.0",
			path: "/work/.crest/extensions/graph.ts",
			scope: "workspace",
			status: "active",
			commands: ["graph.alpha", "graph.zeta"],
			tools: ["alpha_tool", "zeta_tool"],
			hooks: ["context", "tool_call"],
			flags: ["graph.enabled", "graph.zeta"],
			errors: [],
		});
	});
});

describe("Pi extension compatibility matrix", () => {
	it("lists core Pi API areas with explicit statuses", async () => {
		const { PiApiCompatibilityMatrix } = await import("./compatibility");
		expect(PiApiCompatibilityMatrix.map((item) => item.id)).toEqual([
			"commands",
			"tools",
			"hooks",
			"flags",
			"shortcuts",
			"message-renderers",
			"entry-renderers",
			"providers",
			"ctx-ui",
			"ctx-session",
			"ctx-tools",
			"ctx-runtime-actions",
		]);
		expect(PiApiCompatibilityMatrix.every((item) => item.status.length > 0 && item.notes.length > 0)).toBe(true);
	});

	it("lists standard Pi TUI components with explicit statuses", async () => {
		const { PiTuiComponentCompatibilityMatrix } = await import("./compatibility");
		expect(PiTuiComponentCompatibilityMatrix.map((item) => item.id)).toEqual([
			"text",
			"box",
			"spacer",
			"select-list",
			"settings-list",
			"input",
			"markdown",
			"editor",
			"image",
			"loader",
			"truncated-text",
			"custom-component",
		]);
		expect(PiTuiComponentCompatibilityMatrix.every((item) => item.status.length > 0 && item.notes.length > 0)).toBe(
			true
		);
	});

	it("records behavior parity requirements for every standard Pi TUI component", async () => {
		const { PiTuiComponentCompatibilityMatrix } = await import("./compatibility");
		const matrix = PiTuiComponentCompatibilityMatrix as ExtensionComponentCompatibilityItem[];
		const requirementsById = new Map(matrix.map((item) => [item.id, item.behaviorRequirements.map((req) => req.id)]));
		const byId = new Map(matrix.map((item) => [item.id, item]));
		const plannedComponents = matrix.filter((item) => item.certification === "planned");

		expect(matrix.every((item) => item.behaviorRequirements.length > 0)).toBe(true);
		expect(plannedComponents.map((item) => item.id)).toEqual([]);
		expect(plannedComponents.every((item) => JSON.stringify(item.behavior) === JSON.stringify(item.plannedBehavior))).toBe(
			true
		);
		expect(requirementsById.get("select-list")).toEqual([
			"snapshot-items",
			"pointer-select",
			"keyboard-navigation",
			"filtering",
			"scrolling",
			"focus",
		]);
		expect(requirementsById.get("settings-list")).toEqual([
			"snapshot-values",
			"selection",
			"value-change",
			"activate",
			"cancel",
			"search-submenu-layout",
		]);
		expect(requirementsById.get("input")).toEqual([
			"value-snapshot",
			"text-editing",
			"submit",
			"cancel",
			"selection-ime-clipboard",
		]);
		expect(requirementsById.get("editor")).toEqual([
			"content-snapshot",
			"text-editing",
			"cursor-selection",
			"submit",
			"selection-ime-clipboard",
			"cancel",
		]);
		expect(requirementsById.get("loader")).toEqual(["state-snapshot", "animation", "cancel"]);
		expect(requirementsById.get("custom-component")).toEqual(["terminal-surface-fallback"]);
		expect(matrix.flatMap((item) => item.behaviorRequirements).every((req) => req.requirement && req.evidence.length > 0)).toBe(
			true
		);
		expect(byId.get("select-list")?.behavior).toBeUndefined();
		expect(byId.get("select-list")?.plannedBehavior ?? []).toEqual([]);
		expect(byId.get("input")?.behavior).toBeUndefined();
		expect(byId.get("input")?.plannedBehavior ?? []).toEqual([]);
		expect(byId.get("settings-list")?.behavior).toBeUndefined();
		expect(byId.get("settings-list")?.plannedBehavior ?? []).toEqual([]);
		expect(byId.get("editor")?.behavior).toBeUndefined();
		expect(byId.get("editor")?.plannedBehavior ?? []).toEqual([]);
		expect(byId.get("loader")?.behavior).toBeUndefined();
		expect(byId.get("loader")?.plannedBehavior ?? []).toEqual([]);
		expect(byId.get("custom-component")?.plannedBehavior).toEqual(["terminal-surface-fallback"]);
		expect(byId.get("text")?.plannedBehavior).toBeUndefined();
		expect(byId.get("text")?.behavior).toBeUndefined();
		expect(byId.get("text")?.certification).toBe("passing");
		expect(byId.get("select-list")?.certification).toBe("passing");
		expect(byId.get("custom-component")?.certification).toBe("unsupported");
	});

	it("records M2.1A adapter evidence without overstating behavior certification", async () => {
		const { PiTuiComponentCompatibilityMatrix } = await import("./compatibility");
		const standard = PiTuiComponentCompatibilityMatrix.filter((item) => item.id !== "custom-component");

		for (const item of standard) {
			expect(item.notes).toContain("public adapter contract");
			expect(
				item.behaviorRequirements.some((entry) =>
					entry.evidence.includes("pi-gui/crest/walker.test.ts:adapter-contract")
				)
			).toBe(true);
		}

		expect(PiTuiComponentCompatibilityMatrix.find((item) => item.id === "input")?.certification).toBe("passing");
		expect(PiTuiComponentCompatibilityMatrix.find((item) => item.id === "editor")?.certification).toBe("passing");
		expect(PiTuiComponentCompatibilityMatrix.find((item) => item.id === "loader")?.certification).toBe("passing");
	});

	it("closes the M2.1C behavior compatibility matrix and shares one standard blocker predicate", async () => {
		const { PiTuiComponentCompatibilityMatrix, isStandardComponentCertificationBlocker } = await import(
			"./compatibility"
		);

		const cases: Array<{ label: string; item: ExtensionComponentCompatibilityItem; blocker: boolean }> = [
			{
				label: "standard + certification planned",
				item: {
					id: "text",
					label: "Text",
					status: "native-gui",
					notes: "",
					certification: "planned",
					behaviorRequirements: [],
				},
				blocker: true,
			},
			{
				label: "standard + certification unsupported",
				item: {
					id: "text",
					label: "Text",
					status: "native-gui",
					notes: "",
					certification: "unsupported",
					behaviorRequirements: [],
				},
				blocker: true,
			},
			{
				label: "standard + non-empty plannedBehavior",
				item: {
					id: "text",
					label: "Text",
					status: "native-gui",
					notes: "",
					certification: "passing",
					plannedBehavior: ["something"],
					behaviorRequirements: [],
				},
				blocker: true,
			},
			{
				label: "standard + requirement status planned",
				item: {
					id: "text",
					label: "Text",
					status: "native-gui",
					notes: "",
					certification: "passing",
					behaviorRequirements: [
						{ id: "req", label: "req", requirement: "req", status: "planned", evidence: ["e"] },
					],
				},
				blocker: true,
			},
			{
				label: "standard + requirement status partial",
				item: {
					id: "text",
					label: "Text",
					status: "native-gui",
					notes: "",
					certification: "passing",
					behaviorRequirements: [
						{ id: "req", label: "req", requirement: "req", status: "partial", evidence: ["e"] },
					],
				},
				blocker: true,
			},
			{
				label: "standard + passing + empty plannedBehavior + covered/not-applicable",
				item: {
					id: "text",
					label: "Text",
					status: "native-gui",
					notes: "",
					certification: "passing",
					plannedBehavior: [],
					behaviorRequirements: [
						{ id: "a", label: "a", requirement: "a", status: "covered", evidence: ["e"] },
						{ id: "b", label: "b", requirement: "b", status: "not-applicable", evidence: ["e"] },
					],
				},
				blocker: false,
			},
			{
				label: "custom-component with terminal-surface-fallback",
				item: {
					id: "custom-component",
					label: "Custom Component",
					status: "unsupported",
					notes: "",
					certification: "unsupported",
					plannedBehavior: ["terminal-surface-fallback"],
					behaviorRequirements: [
						{ id: "terminal-surface-fallback", label: "t", requirement: "t", status: "planned", evidence: ["e"] },
					],
				},
				blocker: false,
			},
		];

		for (const testCase of cases) {
			expect(isStandardComponentCertificationBlocker(testCase.item), testCase.label).toBe(testCase.blocker);
		}

		const standard = PiTuiComponentCompatibilityMatrix.filter((item) => item.id !== "custom-component");
		for (const item of standard) {
			expect(item.certification).toBe("passing");
			expect(item.plannedBehavior ?? []).toEqual([]);
			expect(
				item.behaviorRequirements.every(
					(requirement) => requirement.status === "covered" || requirement.status === "not-applicable"
				)
			).toBe(true);
			expect(isStandardComponentCertificationBlocker(item)).toBe(false);
		}

		const editor = PiTuiComponentCompatibilityMatrix.find((item) => item.id === "editor");
		expect(editor?.behaviorRequirements.find((item) => item.id === "cancel")).toMatchObject({
			status: "not-applicable",
		});

		expect(PiTuiComponentCompatibilityMatrix.find((item) => item.id === "custom-component")).toMatchObject({
			certification: "unsupported",
			plannedBehavior: ["terminal-surface-fallback"],
		});
		expect(
			isStandardComponentCertificationBlocker(
				PiTuiComponentCompatibilityMatrix.find((item) => item.id === "custom-component")!
			)
		).toBe(false);
		expect(PiTuiComponentCompatibilityMatrix.some(isStandardComponentCertificationBlocker)).toBe(false);

		const editorText = JSON.stringify(editor);
		expect(editorText).not.toContain("autocomplete");
		expect(editorText).not.toContain("history");
		expect(editorText).not.toContain("large-paste");
	});
});

describe("loadAgentExtensions", () => {
	let root: string;
	let originalDevShowcase: string | undefined;
	let originalConfigHome: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "crest-ext-"));
		originalDevShowcase = process.env.CREST_AGENT_DEV_SHOWCASE;
		originalConfigHome = process.env.WAVETERM_CONFIG_HOME;
		delete process.env.CREST_AGENT_DEV_SHOWCASE;
		delete process.env.WAVETERM_CONFIG_HOME;
	});

	afterEach(() => {
		if (originalDevShowcase === undefined) {
			delete process.env.CREST_AGENT_DEV_SHOWCASE;
		} else {
			process.env.CREST_AGENT_DEV_SHOWCASE = originalDevShowcase;
		}
		if (originalConfigHome === undefined) {
			delete process.env.WAVETERM_CONFIG_HOME;
		} else {
			process.env.WAVETERM_CONFIG_HOME = originalConfigHome;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("returns no extensions when no dirs exist", async () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		const result = await loadAgentExtensions({ cwd, configHome: join(root, "missing-cfg") });
		expect(result.extensions).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("does not load the pi-gui showcase extension by default", async () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });

		expect(result.errors).toEqual([]);
		expect(result.extensions).toEqual([]);
	});

	it("loads a project-local extension and registers its handlers", async () => {
		const cwd = join(root, "proj");
		const extDir = join(cwd, ".crest", "extensions");
		writeExtension(
			extDir,
			"my-ext.ts",
			`export default (pi) => { pi.on("tool_call", () => undefined); };`,
		);
		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].handlers.has("tool_call")).toBe(true);
	});

	it("aliases @earendil-works/pi-tui to the vendored pi-gui fork", async () => {
		const cwd = join(root, "proj");
		const extDir = join(cwd, ".crest", "extensions");
		writeExtension(
			extDir,
			"pi-tui-ext.ts",
			`
				import { Text } from "@earendil-works/pi-tui";
				export default (pi) => {
					const label = new Text("aliased", 0, 0).render(20)[0].trim();
					pi.registerFlag("pi-tui-alias", { type: "string", default: label });
				};
			`
		);

		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });

		expect(result.errors).toEqual([]);
		expect(result.extensions[0].flags.get("pi-tui-alias")?.default).toBe("aliased");
	});

	it("aliases @earendil-works/pi-tui subpath imports to the vendored pi-gui fork", async () => {
		const cwd = join(root, "proj");
		const extDir = join(cwd, ".crest", "extensions");
		writeExtension(
			extDir,
			"pi-tui-subpath-ext.ts",
			`
				import { Text } from "@earendil-works/pi-tui/components/text";
				export default (pi) => {
					const label = new Text("subpath", 0, 0).render(20)[0].trim();
					pi.registerFlag("pi-tui-subpath-alias", { type: "string", default: label });
				};
			`
		);

		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });

		expect(result.errors).toEqual([]);
		expect(result.extensions[0].flags.get("pi-tui-subpath-alias")?.default).toBe("subpath");
	});

	it("exposes crest rich GUI components through the pi-tui alias", async () => {
		const cwd = join(root, "proj");
		const extDir = join(cwd, ".crest", "extensions");
		writeExtension(
			extDir,
			"rich-ext.ts",
			`
				import { Chart, CrestRichComponentKind, DiffView, RichTable } from "@earendil-works/pi-tui";
				export default (pi) => {
					const table = new RichTable({ columns: [{ key: "name", label: "Name" }], rows: [{ name: "pi-gui" }] });
					const diff = new DiffView({ hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: "+new" }] }] });
					const chart = new Chart({ charttype: "bar", series: [{ name: "coverage", points: [{ label: "Text", value: 1 }] }] });
					const markers = [table, diff, chart].map((component) => component[CrestRichComponentKind]).join(",");
					pi.registerFlag("rich-alias", { type: "string", default: markers + "|" + [table, diff, chart].map((c) => c.render(40).join("\\n")).join("|") });
				};
			`
		);

		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });

		expect(result.errors).toEqual([]);
		expect(result.extensions[0].flags.get("rich-alias")?.default).toContain("richtable,diffview,chart");
		expect(result.extensions[0].flags.get("rich-alias")?.default).toContain("pi-gui");
	});

	it("loads fixture extensions that render messages and persistent header/footer widgets", async () => {
		const cwd = join(root, "proj");
		const extDir = join(cwd, ".crest", "extensions");
		writeExtension(
			extDir,
			"renderer-fixture.ts",
			`
				import { Text } from "@earendil-works/pi-tui";
				export default (pi) => {
					pi.registerMessageRenderer("note", (data) => new Text("message:" + data.label, 0, 0));
					pi.on("context", (_event, ctx) => {
						ctx.ui.setHeader(new Text("fixture header", 0, 0));
						ctx.ui.setFooter(new Text("fixture footer", 0, 0));
					});
				};
			`,
		);

		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });
		expect(result.errors).toEqual([]);

		const rendered = renderExtensionMessage(result.extensions, "note", { label: "loaded" }, { width: 80 });
		expect(rendered).toMatchObject({ kind: "text", text: "message:loaded" });

		const uiBridge = createExtensionUiBridge();
		let header: unknown;
		let footer: unknown;
		uiBridge.attach({
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: (value) => {
				header = value;
			},
			setFooter: (value) => {
				footer = value;
			},
			requestUi: async () => undefined,
		});
		const ctx = createExtensionContext(() => cwd, uiBridge);
		await result.extensions[0].handlers.get("context")?.[0]?.({}, ctx);

		expect(header).toMatchObject({ kind: "text", text: "fixture header" });
		expect(footer).toMatchObject({ kind: "text", text: "fixture footer" });
	});

	it("loads fixture extensions with interactive custom terminal fallback widgets", async () => {
		const cwd = join(root, "proj");
		const extDir = join(cwd, ".crest", "extensions");
		writeExtension(
			extDir,
			"fallback-fixture.ts",
			`
				export default (pi) => {
					pi.on("context", (_event, ctx) => {
						return ctx.ui.custom((_tui, _theme, _keys, done) => {
							let count = 0;
							return {
								render: () => ["count:" + count],
								invalidate: () => {},
								handleInput: () => {
									count++;
									done("count:" + count);
								},
							};
						}, { width: 20 });
					});
				};
			`,
		);
		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });
		expect(result.errors).toEqual([]);

		const uiBridge = createExtensionUiBridge();
		const requests: ExtUiRequest[] = [];
		const updates: unknown[] = [];
		uiBridge.attach({
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			updateCustomWidget: (widget) => updates.push(widget),
			requestUi: async (request) => {
				requests.push(request);
				return new Promise(() => {});
			},
		});
		const ctx = createExtensionContext(() => cwd, uiBridge);
		const handlerPromise = result.extensions[0].handlers.get("context")?.[0]?.({}, ctx);

		await Promise.resolve();
		const request = requests[0];
		expect(request?.kind).toBe("custom");
		if (request?.kind !== "custom") throw new Error("expected custom request");
		expect(request.widget).toMatchObject({ kind: "terminal", lines: ["count:0"] });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "key", payload: { data: "x" } })).toMatchObject({ handled: true });
		await expect(handlerPromise).resolves.toBe("count:1");
		expect(updates).toEqual([
			expect.objectContaining({
				kind: "terminal",
				id: request.widget.id,
				lines: ["count:1"],
			}),
		]);
	});

	it("records an error for an extension without a default factory", async () => {
		const cwd = join(root, "proj");
		const extDir = join(cwd, ".crest", "extensions");
		writeExtension(extDir, "bad-ext.ts", `export const notAFactory = 1;`);
		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });
		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("valid factory");
	});

	it("records load failures in the lifecycle graph", async () => {
		const cwd = join(root, "proj");
		const extDir = join(cwd, ".crest", "extensions");
		const badExtPath = join(extDir, "bad-ext.ts");
		writeExtension(extDir, "bad-ext.ts", `export const notAFactory = 1;`);

		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });
		const lifecycleHost = createExtensionLifecycleHost(result.runtime);

		expect(lifecycleHost.getGraph().nodes).toEqual([
			{
				id: badExtPath,
				name: badExtPath,
				version: "0.0.0",
				path: badExtPath,
				scope: "workspace",
				status: "failed",
				commands: [],
				tools: [],
				hooks: [],
				flags: [],
				errors: [
					{
						phase: "load",
						message: expect.stringContaining("valid factory"),
						timestamp: expect.any(Number),
					},
				],
			},
		]);
	});

	it("records default global extension load failures with global scope", async () => {
		const cwd = join(root, "proj");
		const configHome = join(root, "cfg");
		const extDir = join(configHome, "extensions");
		const badExtPath = join(extDir, "bad-global.ts");
		process.env.WAVETERM_CONFIG_HOME = configHome;
		mkdirSync(cwd, { recursive: true });
		writeExtension(extDir, "bad-global.ts", `export const notAFactory = 1;`);

		const result = await loadAgentExtensions({ cwd });
		const lifecycleHost = createExtensionLifecycleHost(result.runtime);
		const node = lifecycleHost.getGraph().nodes.find((node) => node.id === badExtPath);

		expect(node).toMatchObject({
			id: badExtPath,
			path: badExtPath,
			scope: "global",
			status: "failed",
			errors: [{ phase: "load", message: expect.stringContaining("valid factory") }],
		});
	});

	it("seeds active graph nodes while preserving load failure nodes", async () => {
		const cwd = join(root, "proj");
		const extDir = join(cwd, ".crest", "extensions");
		const goodExtPath = join(extDir, "good-ext.ts");
		const badExtPath = join(extDir, "bad-ext.ts");
		writeExtension(
			extDir,
			"good-ext.ts",
			`export default (pi) => { pi.registerFlag("good.enabled", { type: "boolean", default: true }); };`
		);
		writeExtension(extDir, "bad-ext.ts", `export const notAFactory = 1;`);

		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });
		const lifecycleHost = createExtensionLifecycleHost(result.runtime);
		const graph = lifecycleHost.getGraph();
		const goodNode = graph.nodes.find((node) => node.id === goodExtPath);
		const badNode = graph.nodes.find((node) => node.id === badExtPath);

		expect(graph.nodes).toHaveLength(2);
		expect(goodNode).toMatchObject({
			id: goodExtPath,
			scope: "workspace",
			status: "active",
			flags: ["good.enabled"],
			errors: [],
		});
		expect(badNode).toMatchObject({
			id: badExtPath,
			scope: "workspace",
			status: "failed",
			errors: [{ phase: "load", message: expect.stringContaining("valid factory") }],
		});
	});

	it("does not retain graph hosts for discovery-only loads", async () => {
		const cwd = join(root, "proj");
		const extDir = join(cwd, ".crest", "extensions");
		writeExtension(
			extDir,
			"discovery-only.ts",
			`export default (pi) => { pi.registerCommand("discovery", { handler: () => {} }); };`
		);
		const before = getExtensionGraphForRuntime();

		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg"), trackGraph: false });

		expect(result.extensions).toHaveLength(1);
		expect(getExtensionGraphForRuntime()).toEqual(before);
	});

	it("reloads through lifecycle disposal and returns a fresh graph", async () => {
		const cwd = join(root, "proj");
		const configHome = join(root, "cfg");
		const extDir = join(cwd, ".crest", "extensions");
		const reloadablePath = join(extDir, "reloadable.ts");
		writeExtension(
			extDir,
			"reloadable.ts",
			`export default (pi) => { pi.registerFlag("reload.before", { type: "boolean", default: true }); };`
		);
		const first = await loadAgentExtensions({ cwd, configHome });
		const lifecycleHost = createExtensionLifecycleHost(first.runtime);
		const disposed: string[] = [];
		lifecycleHost.registerDispose("session-reload", () => {
			disposed.push("session-reload");
		});
		const beforeGeneration = lifecycleHost.getGraph().generation;

		writeExtension(
			extDir,
			"reloadable.ts",
			`export default (pi) => { pi.registerFlag("reload.after", { type: "boolean", default: true }); };`
		);
		const mod = (await import("./index")) as typeof import("./index") & {
			reloadExtensionsForRuntime?: (options: {
				cwd: string;
				configHome?: string;
				lifecycleHost?: ReturnType<typeof createExtensionLifecycleHost>;
			}) => Promise<ExtensionGraph>;
		};
		expect(mod.reloadExtensionsForRuntime).toBeTypeOf("function");

		const graph = await mod.reloadExtensionsForRuntime!({ cwd, configHome, lifecycleHost });

		expect(disposed).toEqual(["session-reload"]);
		expect(graph.generation).toBe(beforeGeneration + 1);
		expect(graph.nodes).toEqual([
			expect.objectContaining({
				scope: "workspace",
				status: "active",
				flags: ["reload.after"],
			}),
		]);
		const globalReloadableNodes = getExtensionGraphForRuntime().nodes.filter((node) => node.id === reloadablePath);
		expect(globalReloadableNodes).toEqual([
			expect.objectContaining({
				status: "active",
				flags: ["reload.after"],
			}),
		]);
		expect(first.runtime.assertActive).toThrow("stale after session replacement or reload");
	});

	it("captures provider registrations from extension factories", async () => {
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(
			(pi) => {
				pi.registerProvider("corp-ai", { models: [{ id: "corp-fast" }] } as any);
			},
			"/x",
			runtime,
			"<provider-ext>",
		);
		expect(runtime.providerRegistrations).toEqual([
			{ name: "corp-ai", config: { models: [{ id: "corp-fast" }] }, extensionPath: "<provider-ext>" },
		]);
	});

	it("loads the in-tree pi-gui showcase extension through the real loader path", async () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		const result = await loadAgentExtensions({
			cwd,
			configHome: join(root, "cfg"),
			paths: [join(process.cwd(), "emain/agent/extensions/fixtures/pi-gui-showcase-extension.ts")],
		});

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("pi-gui-showcase")).toBe(true);
		expect(result.extensions[0].messageRenderers.has("pi-gui-showcase-message")).toBe(true);
		expect(result.extensions[0].entryRenderers.has("pi-gui-showcase-entry")).toBe(true);
	});

	it("loads the in-tree pi-gui showcase extension when dev showcase is explicitly enabled", async () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		const result = await loadAgentExtensions({
			cwd,
			configHome: join(root, "cfg"),
			includeDevShowcase: true,
		});

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("pi-gui-showcase")).toBe(true);
	});

	it("loads the in-tree pi-gui showcase extension when CREST_AGENT_DEV_SHOWCASE is enabled", async () => {
		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		process.env.CREST_AGENT_DEV_SHOWCASE = "1";

		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("pi-gui-showcase")).toBe(true);
	});
});

describe("collectExtensionTools", () => {
	it("merges tools across extensions, later wins on name clash", async () => {
		const runtime = createExtensionRuntime();
		const toolA = {
			name: "t",
			label: "A",
			description: "first",
			parameters: { type: "object", properties: {} } as any,
			execute: async () => ({ content: [], details: undefined }),
		};
		const toolB = { ...toolA, description: "second" };
		const extA = await loadExtensionFromFactory((pi) => pi.registerTool(toolA as any), "/x", runtime, "<a>");
		const extB = await loadExtensionFromFactory((pi) => pi.registerTool(toolB as any), "/x", runtime, "<b>");
		const tools = collectExtensionTools([extA, extB]);
		expect(tools).toHaveLength(1);
		expect(tools[0].description).toBe("second");
	});
});

describe("bindExtensionRuntime", () => {
	it("keeps base tools when refreshTools sees a newly registered extension tool with the same name", async () => {
		const runtime = createExtensionRuntime();
		const baseTool = {
			name: "shared_tool",
			label: "Base Tool",
			description: "base",
			parameters: { type: "object", properties: {} } as any,
			promptSnippet: "base snippet",
			execute: async () => ({ content: [], details: undefined }),
		};
		const extensionTool = {
			...baseTool,
			label: "Extension Tool",
			description: "extension",
			promptSnippet: "extension snippet",
		};
		const extension = await loadExtensionFromFactory(() => {}, "/x", runtime, "<dynamic>");
		const harness = {
			appendCustomEntry: vi.fn().mockResolvedValue(undefined),
			setActiveTools: vi.fn().mockResolvedValue(undefined),
			setTools: vi.fn().mockResolvedValue(undefined),
		};

		bindExtensionRuntime(runtime, harness as any, [baseTool as any], [extension]);
		extension.tools.set("shared_tool", { definition: extensionTool as any, sourceInfo: extension.sourceInfo });
		runtime.refreshTools();
		await Promise.resolve();

		expect(harness.setTools).toHaveBeenCalledWith([baseTool], ["shared_tool"]);
	});
});

describe("extension renderers", () => {
	it("registers the pi-gui showcase extension command and renderers", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(registerPiGuiShowcaseExtension, "/x", runtime, "<showcase>");

		expect(extension.commands.get("pi-gui-showcase")).toMatchObject({
			name: "pi-gui-showcase",
			description: "Showcase Pi TUI components rendered as Crest GUI widgets",
		});
		expect(extension.messageRenderers.has("pi-gui-showcase-message")).toBe(true);
		expect(extension.entryRenderers.has("pi-gui-showcase-entry")).toBe(true);
	});

	it("renders the pi-gui showcase widgets through the registered command", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(registerPiGuiShowcaseExtension, "/x", runtime, "<showcase>");
		const widgets: WidgetNode[] = [];
		const collectWidget = (widget: WidgetNode | undefined): void => {
			if (!widget) return;
			widgets.push(widget);
			if ("children" in widget) {
				for (const child of widget.children) collectWidget(child);
			}
		};
		const uiBridge = createExtensionUiBridge();
		uiBridge.attach({
			notify: () => {},
			setStatus: () => {},
			setWidget: (_key, value) => {
				if (value && !Array.isArray(value)) collectWidget(value);
			},
			setHeader: collectWidget,
			setFooter: collectWidget,
			requestUi: async (request) => {
				if (request.kind === "custom") collectWidget(request.widget);
				return undefined;
			},
		});
		const ctx = createCommandContext(createExtensionContext(() => "/work", uiBridge));

		await extension.commands.get("pi-gui-showcase")?.handler("", ctx);

		expect(new Set(widgets.map((widget) => widget.kind))).toEqual(
			new Set([
				"text",
				"box",
				"selectlist",
				"settingslist",
				"input",
				"markdown",
				"editor",
				"image",
				"loader",
				"truncatedtext",
				"richtable",
				"diffview",
				"chart",
				"terminal",
			])
		);
	});

	it("showcase records selected, submitted, and cancelled results", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(registerPiGuiShowcaseExtension, "/x", runtime, "<showcase>");
		let nestedWidget: WidgetNode | undefined;
		const uiBridge = createExtensionUiBridge();
		uiBridge.attach({
			notify: () => {},
			setStatus: () => {},
			setWidget: (key, value) => {
				if (key === "nested" && value && !Array.isArray(value)) nestedWidget = value;
			},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async () => undefined,
		});
		const ctx = createCommandContext(createExtensionContext(() => "/work", uiBridge));

		await extension.commands.get("pi-gui-showcase")?.handler("", ctx);

		expect(nestedWidget?.kind).toBe("box");
		if (!nestedWidget || nestedWidget.kind !== "box") throw new Error("expected nested box widget");
		expect(nestedWidget.children[1]).toMatchObject({ kind: "text", text: "Interaction: ready" });
		const listWidget = nestedWidget.children[2];
		const inputWidget = nestedWidget.children[3];
		expect(listWidget.kind).toBe("selectlist");
		expect(inputWidget.kind).toBe("input");

		expect(uiBridge.dispatchWidgetEvent({ nodeid: listWidget.id, type: "select", payload: { index: 1 } })).toMatchObject({ handled: true });
		expect(nestedWidget.kind).toBe("box");
		expect(nestedWidget.children[1]).toMatchObject({ kind: "text", text: "Selected: Input" });

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: inputWidget.id,
			type: "change",
			payload: { value: "typed", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: true });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: inputWidget.id,
			type: "submit",
			payload: { value: "typed", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: true });
		expect(nestedWidget.kind).toBe("box");
		expect(nestedWidget.children[1]).toMatchObject({ kind: "text", text: "Submitted: typed" });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: inputWidget.id, type: "cancel" })).toMatchObject({ handled: true });
		expect(nestedWidget.kind).toBe("box");
		expect(nestedWidget.children[1]).toMatchObject({ kind: "text", text: "Cancelled" });
	});

	it("serializes registered message and entry renderers to pi-gui widgets", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.registerMessageRenderer("notice", (data: any) => new Text(`message:${data.text}`, 0, 0) as any);
				pi.registerEntryRenderer("checkpoint", (data: any) => new Text(`entry:${data.label}`, 0, 0) as any);
			},
			"/x",
			runtime,
			"<renderers>"
		);

		expect(renderExtensionMessage([extension], "notice", { text: "hello" }, { width: 80 })).toMatchObject({
			kind: "text",
			text: "message:hello",
		});
		expect(renderExtensionEntry([extension], "checkpoint", { label: "saved" }, { width: 80 })).toMatchObject({
			kind: "text",
			text: "entry:saved",
		});
	});

	it("serializes custom session entries through registered renderers", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.registerEntryRenderer("checkpoint", (data: any) => new Text(`entry:${data.label}`, 0, 0) as any);
				pi.registerMessageRenderer("notice", (data: any) => new Text(`message:${data.details.label}`, 0, 0) as any);
			},
			"/x",
			runtime,
			"<session-renderers>"
		);

		const rendered = renderExtensionSessionEntries(
			[extension],
			[
				{
					type: "custom",
					id: "entry-1",
					parentId: null,
					timestamp: "t1",
					customType: "checkpoint",
					data: { label: "saved" },
				},
				{
					type: "custom_message",
					id: "message-1",
					parentId: "entry-1",
					timestamp: "t2",
					customType: "notice",
					content: "hello",
					display: true,
					details: { label: "shown" },
				},
			],
			{ width: 80 }
		);

		expect(rendered).toEqual([
			expect.objectContaining({ id: "entry-1", customtype: "checkpoint", source: "entry" }),
			expect.objectContaining({ id: "message-1", customtype: "notice", source: "message" }),
		]);
		expect(rendered[0].widget).toMatchObject({ kind: "text", text: "entry:saved" });
		expect(rendered[1].widget).toMatchObject({ kind: "text", text: "message:shown" });
	});
});

describe("wireExtensionHooks dispatch semantics", () => {
	// A tiny harness stand-in capturing on() registrations so we can invoke
	// the folded handler directly and assert pi accumulation semantics.
	function fakeHarness() {
		const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
		return {
			handlers,
			on(type: string, handler: (event: unknown) => Promise<unknown>) {
				handlers.set(type, handler);
				return () => handlers.delete(type);
			},
		};
	}

	async function makeExtension(factory: (pi: any) => void): Promise<Extension> {
		const runtime = createExtensionRuntime();
		return loadExtensionFromFactory(factory, "/x", runtime, "<test>");
	}

	const ctx = createExtensionContext(() => "/work");

	it("tool_result folds patches across handlers", async () => {
		const ext1 = await makeExtension((pi) =>
			pi.on("tool_result", () => ({ content: [{ type: "text", text: "one" }] })),
		);
		const ext2 = await makeExtension((pi) => pi.on("tool_result", () => ({ isError: true })));
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext1, ext2], ctx);
		const patch = (await harness.handlers.get("tool_result")!({
			type: "tool_result",
			toolCallId: "c1",
			toolName: "t",
			input: {},
			content: [],
			details: undefined,
			isError: false,
		})) as any;
		expect(patch.content).toEqual([{ type: "text", text: "one" }]);
		expect(patch.isError).toBe(true);
	});

	it("tool_result returns undefined when no handler modifies", async () => {
		const ext = await makeExtension((pi) => pi.on("tool_result", () => undefined));
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext], ctx);
		const patch = await harness.handlers.get("tool_result")!({
			type: "tool_result",
			toolCallId: "c1",
			toolName: "t",
			input: {},
			content: [],
			details: undefined,
			isError: false,
		});
		expect(patch).toBeUndefined();
	});

	it("tool_call short-circuits on the first block", async () => {
		let secondCalled = false;
		const ext1 = await makeExtension((pi) => pi.on("tool_call", () => ({ block: true, reason: "no" })));
		const ext2 = await makeExtension((pi) =>
			pi.on("tool_call", () => {
				secondCalled = true;
				return undefined;
			}),
		);
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext1, ext2], ctx);
		const result = (await harness.handlers.get("tool_call")!({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "t",
			input: {},
		})) as any;
		expect(result).toEqual({ block: true, reason: "no" });
		expect(secondCalled).toBe(false);
	});

	it("context chains messages through handlers", async () => {
		const ext1 = await makeExtension((pi) =>
			pi.on("context", (e: any) => ({ messages: [...e.messages, { role: "user", content: "a" }] })),
		);
		const ext2 = await makeExtension((pi) =>
			pi.on("context", (e: any) => ({ messages: [...e.messages, { role: "user", content: "b" }] })),
		);
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext1, ext2], ctx);
		const result = (await harness.handlers.get("context")!({ type: "context", messages: [] })) as any;
		expect(result.messages.map((m: any) => m.content)).toEqual(["a", "b"]);
	});

	it("before_agent_start accumulates messages and chains systemPrompt", async () => {
		const ext1 = await makeExtension((pi) =>
			pi.on("before_agent_start", () => ({ message: { role: "user", content: "m1" } })),
		);
		const ext2 = await makeExtension((pi) =>
			pi.on("before_agent_start", (e: any) => ({ systemPrompt: `${e.systemPrompt} + more` })),
		);
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext1, ext2], ctx);
		const result = (await harness.handlers.get("before_agent_start")!({
			type: "before_agent_start",
			prompt: "p",
			systemPrompt: "base",
			resources: {},
		})) as any;
		expect(result.messages).toHaveLength(1);
		expect(result.systemPrompt).toBe("base + more");
	});

	it("does not register a harness handler for hook types no extension uses", async () => {
		const ext = await makeExtension((pi) => pi.on("tool_call", () => undefined));
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext], ctx);
		expect(harness.handlers.has("tool_call")).toBe(true);
		expect(harness.handlers.has("context")).toBe(false);
		expect(harness.handlers.has("tool_result")).toBe(false);
		expect(harness.handlers.has("before_provider_request")).toBe(false);
		expect(harness.handlers.has("before_provider_payload")).toBe(false);
		expect(harness.handlers.has("session_before_compact")).toBe(false);
		expect(harness.handlers.has("session_before_tree")).toBe(false);
	});

	it("before_provider_request merges header patches across handlers", async () => {
		const ext1 = await makeExtension((pi) =>
			pi.on("before_provider_request", () => ({ streamOptions: { headers: { "x-a": "1" }, maxRetries: 2 } })),
		);
		const ext2 = await makeExtension((pi) =>
			pi.on("before_provider_request", () => ({ streamOptions: { headers: { "x-b": "2" } } })),
		);
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext1, ext2], ctx);
		const result = (await harness.handlers.get("before_provider_request")!({
			type: "before_provider_request",
			model: {},
			sessionId: "s1",
			streamOptions: {},
		})) as any;
		expect(result.streamOptions.headers).toEqual({ "x-a": "1", "x-b": "2" });
		expect(result.streamOptions.maxRetries).toBe(2);
	});

	it("before_provider_request returns undefined when no handler patches", async () => {
		const ext = await makeExtension((pi) => pi.on("before_provider_request", () => undefined));
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext], ctx);
		const result = await harness.handlers.get("before_provider_request")!({
			type: "before_provider_request",
			model: {},
			sessionId: "s1",
			streamOptions: {},
		});
		expect(result).toBeUndefined();
	});

	it("before_provider_payload chains the payload through handlers", async () => {
		const ext1 = await makeExtension((pi) =>
			pi.on("before_provider_payload", (e: any) => ({ payload: { ...e.payload, a: 1 } })),
		);
		const ext2 = await makeExtension((pi) =>
			pi.on("before_provider_payload", (e: any) => ({ payload: { ...e.payload, b: 2 } })),
		);
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext1, ext2], ctx);
		const result = (await harness.handlers.get("before_provider_payload")!({
			type: "before_provider_payload",
			model: {},
			payload: {},
		})) as any;
		expect(result.payload).toEqual({ a: 1, b: 2 });
	});

	it("session_before_compact short-circuits on cancel", async () => {
		let secondCalled = false;
		const ext1 = await makeExtension((pi) => pi.on("session_before_compact", () => ({ cancel: true })));
		const ext2 = await makeExtension((pi) =>
			pi.on("session_before_compact", () => {
				secondCalled = true;
				return undefined;
			}),
		);
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext1, ext2], ctx);
		const result = (await harness.handlers.get("session_before_compact")!({
			type: "session_before_compact",
			preparation: {},
			branchEntries: [],
		})) as any;
		expect(result).toEqual({ cancel: true });
		expect(secondCalled).toBe(false);
	});

	it("session_before_tree returns the first provided summary", async () => {
		const ext1 = await makeExtension((pi) => pi.on("session_before_tree", () => undefined));
		const ext2 = await makeExtension((pi) =>
			pi.on("session_before_tree", () => ({ summary: { summary: "done" }, label: "L" })),
		);
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext1, ext2], ctx);
		const result = (await harness.handlers.get("session_before_tree")!({
			type: "session_before_tree",
			preparation: {},
		})) as any;
		expect(result).toEqual({ summary: { summary: "done" }, label: "L" });
	});
});

describe("wireExtensionHooks observation events", () => {
	// A harness stand-in capturing the single subscribe() listener the bridge
	// registers for notify-only lifecycle events (session_compact, session_tree,
	// model_select, thinking_level_select, resources_update,
	// after_provider_response). These fan out via harness.subscribe (emitOwn),
	// not the per-type harness.on() seam.
	function fakeHarness() {
		const subscribers = new Set<(event: unknown) => Promise<unknown> | unknown>();
		const onHandlers = new Map<string, unknown>();
		return {
			subscribers,
			onHandlers,
			on(type: string, handler: unknown) {
				onHandlers.set(type, handler);
				return () => onHandlers.delete(type);
			},
			subscribe(listener: (event: unknown) => Promise<unknown> | unknown) {
				subscribers.add(listener);
				return () => subscribers.delete(listener);
			},
			async emit(event: unknown) {
				for (const listener of subscribers) await listener(event);
			},
		};
	}

	async function makeExtension(factory: (pi: any) => void): Promise<Extension> {
		const runtime = createExtensionRuntime();
		return loadExtensionFromFactory(factory, "/x", runtime, "<test>");
	}

	const ctx = createExtensionContext(() => "/work");

	it("does not subscribe when no extension observes a lifecycle event", async () => {
		const ext = await makeExtension((pi) => pi.on("tool_call", () => undefined));
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext], ctx);
		expect(harness.subscribers.size).toBe(0);
	});

	it("forwards each observed lifecycle event to matching handlers with ctx", async () => {
		const seen: Array<{ type: string; cwd: string }> = [];
		const ext = await makeExtension((pi) => {
			pi.on("model_select", (e: any, c: any) => {
				seen.push({ type: e.type, cwd: c.cwd });
			});
			pi.on("session_compact", (e: any, c: any) => {
				seen.push({ type: e.type, cwd: c.cwd });
			});
		});
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext], ctx);
		expect(harness.subscribers.size).toBe(1);
		await harness.emit({ type: "model_select", model: {}, previousModel: undefined, source: "set" });
		await harness.emit({ type: "session_compact", compactionEntry: {}, fromHook: false });
		// A non-observed lifecycle event must be ignored.
		await harness.emit({ type: "queue_update", steer: [], followUp: [], nextTurn: [] });
		expect(seen).toEqual([
			{ type: "model_select", cwd: "/work" },
			{ type: "session_compact", cwd: "/work" },
		]);
	});

	it("dispatches one observed event to every extension in registration order", async () => {
		const order: string[] = [];
		const ext1 = await makeExtension((pi) =>
			pi.on("session_tree", () => {
				order.push("ext1");
			}),
		);
		const ext2 = await makeExtension((pi) =>
			pi.on("session_tree", () => {
				order.push("ext2");
			}),
		);
		const harness = fakeHarness();
		wireExtensionHooks(harness as any, [ext1, ext2], ctx);
		await harness.emit({ type: "session_tree", newLeafId: "b", oldLeafId: "a" });
		expect(order).toEqual(["ext1", "ext2"]);
	});
});

describe("createExtensionContext ctx surface", () => {
	it("publishes an initial root only after its complete widget-component revision validates", () => {
		const uiBridge = createExtensionUiBridge();
		const updates: WidgetNode[] = [];
		const root = new Box(0, 0);
		const input = new Input();
		root.addChild(input);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");

		const registration = uiBridge.registerWidgetRoot(widget, root, undefined, {
			update: (next) => updates.push(next),
		});

		expect(registration).toBeDefined();
		expect(updates).toEqual([widget]);
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.children[0].id,
			type: "change",
			payload: { value: "ready", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: true });
	});

	it("rejects an invalid initial root without publishing any candidate target", () => {
		const uiBridge = createExtensionUiBridge();
		const update = vi.fn();
		const root = new Box(0, 0);
		const first = new Input();
		const second = new Input();
		root.addChild(first);
		root.addChild(second);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const invalid = {
			...widget,
			children: [widget.children[0], { ...widget.children[1], id: widget.children[0].id }],
		};

		const registration = uiBridge.registerWidgetRoot(invalid, root, undefined, { update });

		expect(registration).toBeUndefined();
		expect(update).not.toHaveBeenCalled();
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: invalid.children[0].id,
			type: "change",
			payload: { value: "leak", selectionstart: 4, selectionend: 4 },
		})).toMatchObject({ handled: false });
		expect(first.getValue()).toBe("");
		expect(second.getValue()).toBe("");
	});

	it("disposes every unique Bridge-owned factory component when initial candidate validation fails", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const child = new Loader(tui, (text) => text, (text) => text, "child", { frames: ["-"] });
		const childStop = vi.spyOn(child, "stop");
		const root = new Box(0, 0);
		root.addChild(child);
		root.addChild(child);
		const rootInvalidate = vi.spyOn(root, "invalidate");
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const invalid = { ...widget, children: [{ ...widget.children[0], kind: "text" as const, text: "bad", paddingx: 0, paddingy: 0 }] };

		expect(uiBridge.registerWidgetRoot(invalid, root, undefined, { ownership: "bridge-factory" })).toBeUndefined();
		expect(childStop).toHaveBeenCalledTimes(1);
		expect(rootInvalidate).not.toHaveBeenCalled();
	});

	it("does not dispose caller-owned external components when initial candidate validation fails", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const child = new Loader(tui, (text) => text, (text) => text, "child", { frames: ["-"] });
		const childStop = vi.spyOn(child, "stop");
		const root = new Box(0, 0);
		root.addChild(child);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const invalid = { ...widget, children: [] };

		expect(uiBridge.registerWidgetRoot(invalid, root, undefined, { ownership: "caller-external" })).toBeUndefined();
		expect(childStop).not.toHaveBeenCalled();
	});

	it("contains initial serialization failure in the transaction and disposes the Bridge-owned candidate", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const root = new Loader(tui, (text) => text, (text) => text, "initial", { frames: ["-"] });
		const stop = vi.spyOn(root, "stop");
		const update = vi.fn();

		const registration = uiBridge.registerWidgetRoot(
			() => {
				throw new Error("initial serialize failed");
			},
			root,
			undefined,
			{ ownership: "bridge-factory", update },
		);

		expect(registration).toBeUndefined();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(update).not.toHaveBeenCalled();
	});

	it("exposes Box children through a stable public copy", () => {
		const root = new Box(0, 0);
		const input = new Input();
		root.addChild(input);

		const children = root.getChildren();
		children.pop();

		expect(children).toEqual([]);
		expect(root.getChildren()).toEqual([input]);
	});

	it("precollects composite Box children before full serialization failure", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const child = new Loader(tui, (text) => text, (text) => text, "child", { frames: ["-"] });
		const stop = vi.spyOn(child, "stop");
		const root = new Box(0, 0);
		root.addChild(child);
		const update = vi.fn();
		vi.spyOn(root, "getSnapshot").mockImplementation(() => {
			throw new Error("box snapshot failed");
		});

		const registration = uiBridge.registerWidgetRoot(
			() => componentToWidget(root, { width: 80 }),
			root,
			undefined,
			{ update, ownership: "bridge-factory" },
		);

		expect(registration).toBeUndefined();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(update).not.toHaveBeenCalled();
	});

	it("atomically replaces a persistent root only after the replacement revision validates", () => {
		const uiBridge = createExtensionUiBridge();
		const published: WidgetNode[] = [];
		const first = new Input();
		const firstWidget = componentToWidget(first, { width: 80 });
		const firstRegistration = uiBridge.registerWidgetRoot(firstWidget, first, undefined, {
			update: (widget) => published.push(widget),
		});
		if (!firstRegistration) throw new Error("expected first registration");
		const replacement = new Input();
		replacement.setValue("replacement");
		const replacementWidget = componentToWidget(replacement, { width: 80 });

		const replacementRegistration = uiBridge.registerWidgetRoot(replacementWidget, replacement, undefined, {
			update: (widget) => published.push(widget),
			replace: firstRegistration,
		});

		expect(replacementRegistration).toBeDefined();
		expect(published).toEqual([firstWidget, replacementWidget]);
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: firstWidget.id,
			type: "change",
			payload: { value: "stale", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: false });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: replacementWidget.id,
			type: "change",
			payload: { value: "live", selectionstart: 4, selectionend: 4 },
		})).toMatchObject({ handled: true });
		firstRegistration.unregister();
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: replacementWidget.id,
			type: "change",
			payload: { value: "still-live", selectionstart: 10, selectionend: 10 },
		})).toMatchObject({ handled: true });
	});

	it("contains replacement serialization failure and retains the previous root", () => {
		const uiBridge = createExtensionUiBridge();
		const first = new Input();
		const firstWidget = componentToWidget(first, { width: 80 });
		const firstRegistration = uiBridge.registerWidgetRoot(firstWidget, first);
		if (!firstRegistration) throw new Error("expected first registration");
		const tui = { requestRender: () => {} } as any;
		const replacement = new Loader(tui, (text) => text, (text) => text, "replacement", { frames: ["-"] });
		const stop = vi.spyOn(replacement, "stop");

		const rejected = uiBridge.registerWidgetRoot(
			() => {
				throw new Error("replacement serialize failed");
			},
			replacement,
			undefined,
			{ ownership: "bridge-factory", replace: firstRegistration },
		);

		expect(rejected).toBeUndefined();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: firstWidget.id,
			type: "change",
			payload: { value: "retained", selectionstart: 8, selectionend: 8 },
		})).toMatchObject({ handled: true });
	});

	it.each(["widget", "header", "footer"] as const)(
		"retains the previous %s host value when a persistent replacement collides",
		(surface) => {
			const uiBridge = createExtensionUiBridge();
			const published: WidgetNode[] = [];
			const host = makeExtensionUiHost({
				setWidget: (_key, value) => {
					if (value && !Array.isArray(value)) published.push(value);
				},
				setHeader: (value) => {
					if (value) published.push(value);
				},
				setFooter: (value) => {
					if (value) published.push(value);
				},
			});
			uiBridge.attach(host);
			const ctx = createExtensionContext(() => "/work", uiBridge);
			const first = new Input();
			if (surface === "widget") ctx.ui.setWidget("key", first);
			else if (surface === "header") ctx.ui.setHeader(first);
			else ctx.ui.setFooter(first);
			const firstWidget = published.at(-1);
			if (!firstWidget) throw new Error("expected first publication");
			const collision = new Input();
			const collisionWidget = componentToWidget(collision, { width: 80 });
			const collisionRegistration = uiBridge.registerWidgetRoot(
				{ ...collisionWidget, id: firstWidget.id },
				collision,
			);
			expect(collisionRegistration).toBeUndefined();

			const rejected = new Input();
			const rejectedWidget = componentToWidget(rejected, { width: 80 });
			const blocker = new Input();
			expect(uiBridge.registerWidgetRoot({ ...componentToWidget(blocker, { width: 80 }), id: rejectedWidget.id }, blocker))
				.toBeDefined();
			if (surface === "widget") ctx.ui.setWidget("key", rejected);
			else if (surface === "header") ctx.ui.setHeader(rejected);
			else ctx.ui.setFooter(rejected);

			expect(published).toEqual([firstWidget]);
			expect(uiBridge.dispatchWidgetEvent({
				nodeid: firstWidget.id,
				type: "change",
				payload: { value: "retained", selectionstart: 8, selectionend: 8 },
			})).toMatchObject({ handled: true });
		},
	);

	it("retains the previous persistent root and rejects caller-owned external replacement components on validation failure", () => {
		const uiBridge = createExtensionUiBridge();
		const published: WidgetNode[] = [];
		const first = new Input();
		const firstWidget = componentToWidget(first, { width: 80 });
		const firstRegistration = uiBridge.registerWidgetRoot(firstWidget, first, undefined, {
			update: (widget) => published.push(widget),
		});
		if (!firstRegistration) throw new Error("expected first registration");
		const replacement = new Box(0, 0);
		const replacementChild = new Input();
		replacement.addChild(replacementChild);
		const replacementWidget = componentToWidget(replacement, { width: 80 });
		if (replacementWidget.kind !== "box") throw new Error("expected box widget");

		const rejected = uiBridge.registerWidgetRoot(
			{ ...replacementWidget, children: [] },
			replacement,
			undefined,
			{ update: (widget) => published.push(widget), replace: firstRegistration, ownership: "caller-external" },
		);

		expect(rejected).toBeUndefined();
		expect(published).toEqual([firstWidget]);
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: firstWidget.id,
			type: "change",
			payload: { value: "retained", selectionstart: 8, selectionend: 8 },
		})).toMatchObject({ handled: true });
		expect(replacementChild.getValue()).toBe("");
	});

	it("disposes rejected Bridge-owned factory replacement components while retaining the previous root", () => {
		const uiBridge = createExtensionUiBridge();
		const first = new Input();
		const firstWidget = componentToWidget(first, { width: 80 });
		const firstRegistration = uiBridge.registerWidgetRoot(firstWidget, first);
		if (!firstRegistration) throw new Error("expected first registration");
		const tui = { requestRender: () => {} } as any;
		const replacementChild = new Loader(tui, (text) => text, (text) => text, "replacement", { frames: ["-"] });
		const stop = vi.spyOn(replacementChild, "stop");
		const replacement = new Box(0, 0);
		replacement.addChild(replacementChild);
		const replacementWidget = componentToWidget(replacement, { width: 80 });
		if (replacementWidget.kind !== "box") throw new Error("expected box widget");

		expect(uiBridge.registerWidgetRoot(
			{ ...replacementWidget, children: [] },
			replacement,
			undefined,
			{ replace: firstRegistration, ownership: "bridge-factory" },
		)).toBeUndefined();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: firstWidget.id,
			type: "change",
			payload: { value: "retained", selectionstart: 8, selectionend: 8 },
		})).toMatchObject({ handled: true });
	});

	it("disposes removed published components after replacement regardless of candidate origin", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const oldChild = new Loader(tui, (text) => text, (text) => text, "old", { frames: ["-"] });
		const oldStop = vi.spyOn(oldChild, "stop");
		const oldRoot = new Box(0, 0);
		oldRoot.addChild(oldChild);
		const oldWidget = componentToWidget(oldRoot, { width: 80 });
		const oldRegistration = uiBridge.registerWidgetRoot(oldWidget, oldRoot, undefined, {
			ownership: "caller-external",
		});
		if (!oldRegistration) throw new Error("expected old registration");
		const replacement = new Input();
		const replacementWidget = componentToWidget(replacement, { width: 80 });

		expect(uiBridge.registerWidgetRoot(replacementWidget, replacement, undefined, {
			replace: oldRegistration,
			ownership: "caller-external",
		})).toBeDefined();
		expect(oldStop).toHaveBeenCalledTimes(1);
	});

	it("disposes all published unique components once on unregister regardless of candidate origin", () => {
		for (const ownership of ["bridge-factory", "caller-external"] as const) {
			const uiBridge = createExtensionUiBridge();
			const tui = { requestRender: () => {} } as any;
			const child = new Loader(tui, (text) => text, (text) => text, ownership, { frames: ["-"] });
			const stop = vi.spyOn(child, "stop");
			const root = new Box(0, 0);
			root.addChild(child);
			const registration = uiBridge.registerWidgetRoot(componentToWidget(root, { width: 80 }), root, undefined, {
				ownership,
			});
			if (!registration) throw new Error("expected registration");

			registration.unregister();
			registration.unregister();

			expect(stop).toHaveBeenCalledTimes(1);
		}
	});

	it("uses explicit Component disposal when an adapter has no custom disposer", () => {
		const uiBridge = createExtensionUiBridge();
		const dispose = vi.fn();
		const text = Object.assign(new Text("explicit"), { dispose });
		const registration = uiBridge.registerWidgetRoot(componentToWidget(text, { width: 80 }), text);
		if (!registration) throw new Error("expected registration");

		registration.unregister();
		registration.unregister();

		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("rejects a second root for a published component even when its widget id differs", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const shared = new CancellableLoader(tui, (text) => text, (text) => text, "shared", { frames: ["-"] });
		const stop = vi.spyOn(shared, "stop");
		const onAbort = vi.fn();
		shared.onAbort = onAbort;
		const firstWidget = componentToWidget(shared, { width: 80 });
		const rejectedUpdate = vi.fn();
		expect(uiBridge.registerWidgetRoot(firstWidget, shared)).toBeDefined();
		expect(uiBridge.registerWidgetRoot({ ...firstWidget, id: `${firstWidget.id}-second` }, shared, undefined, {
			update: rejectedUpdate,
		})).toBeUndefined();
		expect(rejectedUpdate).not.toHaveBeenCalled();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: firstWidget.id, type: "cancel" })).toMatchObject({ handled: true });
		expect(onAbort).toHaveBeenCalledTimes(1);

		uiBridge.dispose();
		uiBridge.dispose();

		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("invalidates the registered root exactly once after a handled child mutation and before snapshot", () => {
		const uiBridge = createExtensionUiBridge();
		const order: string[] = [];
		const root = new Box(0, 0);
		const input = new Input();
		root.addChild(input);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const originalInvalidate = root.invalidate.bind(root);
		const invalidate = vi.spyOn(root, "invalidate").mockImplementation(() => {
			order.push(`invalidate:${input.getValue()}`);
			originalInvalidate();
		});
		const registration = uiBridge.registerWidgetRoot(widget, root, undefined, {
			update: (next) => {
				if (next.kind !== "box" || next.children[0].kind !== "input") throw new Error("expected nested input");
				order.push(`update:${next.children[0].value}`);
			},
		});
		if (!registration) throw new Error("expected registration");
		order.length = 0;

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.children[0].id,
			type: "change",
			payload: { value: "next", selectionstart: 4, selectionend: 4 },
		})).toMatchObject({ handled: true });

		expect(order).toEqual(["invalidate:next", "update:next"]);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("contains handled root invalidation errors and retains the previous revision", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const loader = new Loader(tui, (text) => text, (text) => text, "retained", { frames: ["-"] });
		const stop = vi.spyOn(loader, "stop");
		const input = new Input();
		const root = new Box(0, 0);
		root.addChild(input);
		root.addChild(loader);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const update = vi.fn();
		expect(uiBridge.registerWidgetRoot(widget, root, undefined, { update })).toBeDefined();
		update.mockClear();
		const originalInvalidate = root.invalidate.bind(root);
		vi.spyOn(root, "invalidate").mockImplementation(() => {
			throw new Error("handled invalidate failed");
		});

		expect(() => {
			expect(uiBridge.dispatchWidgetEvent({
				nodeid: widget.children[0].id,
				type: "change",
				eventid: "renderer-a:failed-refresh",
				payload: { value: "first", selectionstart: 5, selectionend: 5 },
			})).toEqual({ handled: true, published: false });
		}).not.toThrow();
		expect(update).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(input.getSnapshot()).toMatchObject({
			value: "first",
			selectionStart: 5,
			selectionEnd: 5,
		});

		vi.mocked(root.invalidate).mockImplementation(originalInvalidate);
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.children[0].id,
			type: "change",
			eventid: "renderer-a:successful-refresh",
			payload: { value: "second", selectionstart: 6, selectionend: 6 },
		})).toEqual({ handled: true, published: true });
		expect(update).toHaveBeenCalledTimes(1);
		const published = update.mock.calls[0][0] as WidgetNode;
		if (published.kind !== "box") throw new Error("expected published box widget");
		expect((published.children[0] as any).ackid).toBe("renderer-a:successful-refresh");
		expect(input.getSnapshot()).toMatchObject({ value: "second", selectionStart: 6, selectionEnd: 6 });
		expect(stop).not.toHaveBeenCalled();
	});

	it("returns an unhandled unpublished result for invalid and stale widget events", () => {
		const uiBridge = createExtensionUiBridge();
		const input = new Input();
		const widget = componentToWidget(input, { width: 80 });
		const registration = uiBridge.registerWidgetRoot(widget, input);
		if (!registration) throw new Error("expected Input registration");

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "change",
			eventid: "",
			payload: { value: "invalid", selectionstart: 7, selectionend: 7 },
		})).toEqual({ handled: false, published: false });
		registration.unregister();
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "change",
			eventid: "stale-event",
			payload: { value: "stale", selectionstart: 5, selectionend: 5 },
		})).toEqual({ handled: false, published: false });
	});

	it("applies an Input selection-only change and replays it in the acknowledged snapshot", () => {
		const uiBridge = createExtensionUiBridge();
		const input = new Input();
		input.applyGuiEdit("abcdef", 6, 6);
		const updates: WidgetNode[] = [];
		const widget = componentToWidget(input, { width: 80 });
		const registration = uiBridge.registerWidgetRoot(widget, input, undefined, {
			update: (next) => updates.push(next),
		});
		if (!registration) throw new Error("expected Input registration");
		updates.length = 0;

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "change",
			eventid: "selection-only-event",
			payload: { value: "abcdef", selectionstart: 1, selectionend: 4 },
		})).toMatchObject({ handled: true });

		expect(input.getSnapshot()).toMatchObject({
			value: "abcdef",
			cursor: 4,
			selectionStart: 1,
			selectionEnd: 4,
		});
		expect(updates).toEqual([
			expect.objectContaining({
				kind: "input",
				ackid: "selection-only-event",
				value: "abcdef",
				selectionstart: 1,
				selectionend: 4,
			}),
		]);
	});

	it("contains scheduled root invalidation errors and retains the previous revision", async () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const loader = new Loader(tui, (text) => text, (text) => text, "retained", { frames: ["-"] });
		const stop = vi.spyOn(loader, "stop");
		const input = new Input();
		const root = new Box(0, 0);
		root.addChild(input);
		root.addChild(loader);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const update = vi.fn();
		expect(uiBridge.registerWidgetRoot(widget, root, undefined, { update })).toBeDefined();
		update.mockClear();
		const originalInvalidate = root.invalidate.bind(root);
		vi.spyOn(root, "invalidate").mockImplementation(() => {
			throw new Error("scheduled invalidate failed");
		});

		expect(uiBridge.requestWidgetRender(root)).toBe(true);
		await Promise.resolve();
		expect(update).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();

		vi.mocked(root.invalidate).mockImplementation(originalInvalidate);
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.children[0].id,
			type: "change",
			payload: { value: "retained", selectionstart: 8, selectionend: 8 },
		})).toMatchObject({ handled: true });
		expect(update).toHaveBeenCalledTimes(1);
		expect(stop).not.toHaveBeenCalled();
	});

	it("does not invalidate or publish for invalid payloads, unhandled events, or stale ids", () => {
		const uiBridge = createExtensionUiBridge();
		const root = new Box(0, 0);
		const input = new Input();
		root.addChild(input);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const invalidate = vi.spyOn(root, "invalidate");
		const update = vi.fn();
		const registration = uiBridge.registerWidgetRoot(widget, root, undefined, { update });
		if (!registration) throw new Error("expected registration");
		invalidate.mockClear();
		update.mockClear();

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.children[0].id,
			type: "change",
			payload: { value: "bad", selectionstart: 4, selectionend: 3 },
		})).toMatchObject({ handled: false });
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.children[0].id, type: "unknown" })).toMatchObject({ handled: false });
		registration.unregister();
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.children[0].id,
			type: "change",
			payload: { value: "stale", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: false });
		expect(invalidate).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("rejects invalid child pairing without publishing partial targets", () => {
		const makeRoot = () => {
			const root = new Box(0, 0);
			root.addChild(new Input());
			return root;
		};
		const cases: Array<(widget: WidgetNode) => WidgetNode> = [
			(widget) => ({ ...(widget as Extract<WidgetNode, { kind: "box" | "container" }>), children: [] }),
			(widget) => ({
				...(widget as Extract<WidgetNode, { kind: "box" | "container" }>),
				children: [
					...(widget as Extract<WidgetNode, { kind: "box" | "container" }>).children,
					{ kind: "text", id: "extra", text: "extra", paddingx: 0, paddingy: 0 },
				],
			}),
			(widget) => ({
				...(widget as Extract<WidgetNode, { kind: "box" | "container" }>),
				children: [{
					kind: "text",
					id: (widget as Extract<WidgetNode, { kind: "box" | "container" }>).children[0].id,
					text: "wrong kind",
					paddingx: 0,
					paddingy: 0,
				}],
			}),
		];

		for (const mutate of cases) {
			const uiBridge = createExtensionUiBridge();
			const root = makeRoot();
			const widget = componentToWidget(root, { width: 80 });
			expect(uiBridge.registerWidgetRoot(mutate(widget), root)).toBeUndefined();
			uiBridge.dispose();
		}
	});

	it("publishes and removes dynamic submenu targets in the same authoritative root revision", () => {
		const uiBridge = createExtensionUiBridge();
		const updates: WidgetNode[] = [];
		const tui = { requestRender: () => {} } as any;
		let closeSubmenu: (value?: string) => void = () => {};
		const submenu = new CancellableLoader(
			tui,
			(text) => text,
			(text) => text,
			"Choose",
			{ frames: ["-"] },
		);
		submenu.onAbort = () => closeSubmenu();
		const submenuDispose = vi.spyOn(submenu, "dispose");
		const settings = new SettingsList(
			[{ id: "mode", label: "Mode", currentValue: "one", submenu: (_value, done) => {
				closeSubmenu = done;
				return submenu;
			} }],
			2,
			TestSettingsListTheme,
			() => {},
			() => {},
		);
		const rootWidget = componentToWidget(settings, { width: 80 });
		const registration = uiBridge.registerWidgetRoot(rootWidget, settings, undefined, {
			update: (widget) => updates.push(widget),
		});
		if (!registration) throw new Error("expected registration");
		updates.length = 0;
		const submenuWidget = componentToWidget(submenu, { width: 80 });
		expect(uiBridge.dispatchWidgetEvent({ nodeid: submenuWidget.id, type: "cancel" })).toMatchObject({ handled: false });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: rootWidget.id, type: "submit", payload: { index: 0 } })).toMatchObject({ handled: true });
		expect(updates.at(-1)).toMatchObject({ kind: "settingslist", submenu: { id: submenuWidget.id } });
		expect(uiBridge.dispatchWidgetEvent({ nodeid: submenuWidget.id, type: "cancel" })).toMatchObject({ handled: true });
		expect(updates.at(-1)).toMatchObject({ kind: "settingslist", selectedindex: 0 });
		expect((updates.at(-1) as Extract<WidgetNode, { kind: "settingslist" }>).submenu).toBeUndefined();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: submenuWidget.id, type: "cancel" })).toMatchObject({ handled: false });
		expect(submenuDispose).toHaveBeenCalledTimes(1);
	});

	it("retains scheduled external components when reconciliation fails even after factory registration", async () => {
		const uiBridge = createExtensionUiBridge();
		const updates: WidgetNode[] = [];
		const tui = { requestRender: () => {} } as any;
		const rejectedChild = new Loader(tui, (text) => text, (text) => text, "new", { frames: ["-"] });
		const rejectedStop = vi.spyOn(rejectedChild, "stop");
		const list = new SelectList([{ value: "one", label: "One" }], 1, TestSelectListTheme);
		list.onCancel = () => {};
		const root = new Box(0, 0);
		root.addChild(list);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const registration = uiBridge.registerWidgetRoot(widget, root, undefined, {
			update: (next) => updates.push(next),
			ownership: "bridge-factory",
		});
		if (!registration) throw new Error("expected registration");
		updates.length = 0;

		root.addChild(rejectedChild);
		root.addChild(rejectedChild);
		expect(uiBridge.requestWidgetRender(root)).toBe(true);
		await Promise.resolve();

		expect(updates).toEqual([]);
		expect(rejectedStop).not.toHaveBeenCalled();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.children[0].id, type: "cancel" })).toEqual({
			handled: true,
			published: false,
		});
	});

	it("retains caller-owned unpublished components when scheduled reconciliation fails", async () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const rejectedChild = new Loader(tui, (text) => text, (text) => text, "caller", { frames: ["-"] });
		const rejectedStop = vi.spyOn(rejectedChild, "stop");
		const input = new Input();
		input.onEscape = () => {};
		const root = new Box(0, 0);
		root.addChild(input);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		expect(uiBridge.registerWidgetRoot(widget, root)).toBeDefined();

		root.addChild(rejectedChild);
		root.addChild(rejectedChild);
		expect(uiBridge.requestWidgetRender(root)).toBe(true);
		await Promise.resolve();

		expect(rejectedStop).not.toHaveBeenCalled();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.children[0].id, type: "cancel" })).toEqual({
			handled: true,
			published: false,
		});
	});

	it("disposes transaction-created submenu components when an external root handled reconciliation fails", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const rejectedChild = new Loader(tui, (text) => text, (text) => text, "handled", { frames: ["-"] });
		const rejectedStop = vi.spyOn(rejectedChild, "stop");
		const list = new SelectList([{ value: "one", label: "One" }], 1, TestSelectListTheme);
		const root = new Box(0, 0);
		root.addChild(list);
		list.onSelect = () => {
			root.addChild(rejectedChild);
			root.addChild(rejectedChild);
		};
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		expect(uiBridge.registerWidgetRoot(widget, root, undefined, { ownership: "caller-external" })).toBeDefined();

		expect(uiBridge.dispatchWidgetEvent(
			{ nodeid: widget.children[0].id, type: "select", payload: { index: 0 } },
		)).toEqual({ handled: true, published: false });

		expect(rejectedStop).toHaveBeenCalledTimes(1);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.children[0].id, type: "select", payload: { index: 0 } })).toEqual({
			handled: true,
			published: false,
		});
	});

	it("contains refresh child collection failure and retains the previous revision", async () => {
		const uiBridge = createExtensionUiBridge();
		const root = new Box(0, 0);
		const input = new Input();
		input.onEscape = () => {};
		root.addChild(input);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const update = vi.fn();
		expect(uiBridge.registerWidgetRoot(widget, root, undefined, {
			update,
			ownership: "bridge-factory",
		})).toBeDefined();
		update.mockClear();
		vi.spyOn(root, "getSnapshot").mockImplementation(() => {
			throw new Error("refresh children failed");
		});

		expect(uiBridge.requestWidgetRender(root)).toBe(true);
		await Promise.resolve();

		expect(update).not.toHaveBeenCalled();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.children[0].id, type: "cancel" })).toEqual({
			handled: true,
			published: false,
		});
	});

	it("absorbs handled candidate disposal errors and retains the previous revision", () => {
		const uiBridge = createExtensionUiBridge();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const tui = { requestRender: () => {} } as any;
		const rejected = new Loader(tui, (text) => text, (text) => text, "rejected", { frames: ["-"] });
		const error = new Error("rejected cleanup failed");
		vi.spyOn(rejected, "stop").mockImplementation(() => {
			throw error;
		});
		const list = new SelectList([{ value: "one", label: "One" }], 1, TestSelectListTheme);
		list.onSelect = () => {
			root.addChild(rejected);
			root.addChild(rejected);
		};
		list.onCancel = () => {};
		const root = new Box(0, 0);
		root.addChild(list);
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const update = vi.fn();
		expect(uiBridge.registerWidgetRoot(widget, root, undefined, {
			update,
			ownership: "caller-external",
		})).toBeDefined();
		update.mockClear();

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.children[0].id,
			type: "select",
			payload: { index: 0 },
		})).toEqual({ handled: true, published: false });

		expect(update).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith("[extension-ui] widget dispose failed:", error);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.children[0].id, type: "cancel" })).toEqual({
			handled: true,
			published: false,
		});
		errorSpy.mockRestore();
	});

	it("coalesces TUI render requests through the registered root revision", async () => {
		const uiBridge = createExtensionUiBridge();
		const root = new Input();
		const widget = componentToWidget(root, { width: 80 });
		const invalidate = vi.spyOn(root, "invalidate");
		const update = vi.fn();
		expect(uiBridge.registerWidgetRoot(widget, root, undefined, { update })).toBeDefined();
		invalidate.mockClear();
		update.mockClear();

		expect(uiBridge.requestWidgetRender(root)).toBe(true);
		expect(uiBridge.requestWidgetRender(root)).toBe(true);
		expect(uiBridge.requestWidgetRender(root)).toBe(true);
		expect(update).not.toHaveBeenCalled();

		await Promise.resolve();

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledTimes(1);
	});

	it("publishes live Loader frames through asynchronous root revisions", async () => {
		vi.useFakeTimers();
		try {
			const uiBridge = createExtensionUiBridge();
			const target: { component?: Loader } = {};
			const tui = {
				requestRender: () => {
					if (target.component) uiBridge.requestWidgetRender(target.component);
				},
			} as unknown as TUI;
			const loader = new Loader(tui, (text) => text, (text) => text, "Working", {
				frames: ["a", "b", "c"],
				intervalMs: 10,
			});
			target.component = loader;
			const updates: WidgetNode[] = [];
			const registration = uiBridge.registerWidgetRoot(
				componentToWidget(loader, { width: 80 }),
				loader,
				undefined,
				{ update: (widget) => updates.push(widget), ownership: "bridge-factory" },
			);
			if (!registration) throw new Error("expected Loader registration");
			updates.length = 0;

			vi.advanceTimersByTime(10);
			expect(updates).toEqual([]);
			await Promise.resolve();
			expect(updates).toHaveLength(1);
			expect(updates[0]).toMatchObject({ kind: "loader", frame: "b" });

			vi.advanceTimersByTime(20);
			expect(updates).toHaveLength(1);
			await Promise.resolve();
			expect(updates).toHaveLength(2);
			expect(updates[1]).toMatchObject({ kind: "loader", frame: "a" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("disposes Loader variants on unregister and bridge disposal without allowing animation restart", async () => {
		vi.useFakeTimers();
		try {
			for (const LoaderType of [Loader, CancellableLoader] as const) {
				for (const cleanup of ["unregister", "dispose"] as const) {
				const uiBridge = createExtensionUiBridge();
				const target: { component?: Loader } = {};
				const requestRender = vi.fn(() => {
					if (target.component) uiBridge.requestWidgetRender(target.component);
				});
				const tui = {
					requestRender,
				} as unknown as TUI;
				const loader = new LoaderType(tui, (text) => text, (text) => text, cleanup, {
					frames: ["a", "b"],
					intervalMs: 10,
				});
				target.component = loader;
				const dispose = vi.spyOn(loader, "dispose");
				const update = vi.fn();
				const registration = uiBridge.registerWidgetRoot(
					componentToWidget(loader, { width: 80 }),
					loader,
					undefined,
					{ update, ownership: "bridge-factory" },
				);
				if (!registration) throw new Error("expected Loader registration");
				update.mockClear();

				vi.advanceTimersByTime(10);
				if (cleanup === "unregister") {
					registration.unregister();
					registration.unregister();
				} else {
					uiBridge.dispose();
					uiBridge.dispose();
				}
				await Promise.resolve();
				vi.advanceTimersByTime(30);
				await Promise.resolve();

				expect(dispose).toHaveBeenCalledTimes(1);
				expect(update).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
				requestRender.mockClear();
				loader.start();
				loader.setIndicator({ frames: ["x", "y"], intervalMs: 5 });
				vi.advanceTimersByTime(20);
				expect(vi.getTimerCount()).toBe(0);
				expect(requestRender).not.toHaveBeenCalled();
				}
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps plain Loader cancel unhandled and aborts CancellableLoader once without future revisions", async () => {
		vi.useFakeTimers();
		try {
			const uiBridge = createExtensionUiBridge();
			const plain = new Loader(
				{ requestRender: () => {} } as unknown as TUI,
				(text) => text,
				(text) => text,
				"Plain",
				{ frames: ["only"] },
			);
			const plainWidget = componentToWidget(plain, { width: 80 });
			expect(uiBridge.registerWidgetRoot(plainWidget, plain)).toBeDefined();
			expect(uiBridge.dispatchWidgetEvent({ nodeid: plainWidget.id, type: "cancel" })).toEqual({
				handled: false,
				published: false,
			});

			const target: { component?: CancellableLoader } = {};
			const tui = {
				requestRender: () => {
					if (target.component) uiBridge.requestWidgetRender(target.component);
				},
			} as unknown as TUI;
			const loader = new CancellableLoader(tui, (text) => text, (text) => text, "Abortable", {
				frames: ["a", "b"],
				intervalMs: 10,
			});
			target.component = loader;
			const onAbort = vi.fn();
			loader.onAbort = onAbort;
			const updates: WidgetNode[] = [];
			const widget = componentToWidget(loader, { width: 80 });
			expect(uiBridge.registerWidgetRoot(widget, loader, undefined, {
				update: (next) => updates.push(next),
			})).toBeDefined();
			updates.length = 0;

			expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel" })).toMatchObject({
				handled: true,
				published: true,
			});
			expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel" })).toMatchObject({
				handled: true,
				published: true,
			});
			expect(onAbort).toHaveBeenCalledTimes(1);
			expect(updates[0]).toMatchObject({ kind: "loader", aborted: true });
			updates.length = 0;

			vi.advanceTimersByTime(30);
			await Promise.resolve();
			expect(updates).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels queued root work on unregister and bridge disposal", async () => {
		for (const cleanup of ["unregister", "dispose"] as const) {
			const uiBridge = createExtensionUiBridge();
			const root = new Input();
			const update = vi.fn();
			const registration = uiBridge.registerWidgetRoot(componentToWidget(root, { width: 80 }), root, undefined, { update });
			if (!registration) throw new Error("expected registration");
			update.mockClear();
			expect(uiBridge.requestWidgetRender(root)).toBe(true);
			if (cleanup === "unregister") registration.unregister();
			else uiBridge.dispose();

			await Promise.resolve();

			expect(update).not.toHaveBeenCalled();
		}
	});

	it("disposes bridge widget targets once and makes stale registrations inert", () => {
		const uiBridge = createExtensionUiBridge();
		const host: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async () => undefined,
		};
		uiBridge.attach(host);
		const tui = { requestRender: () => {} } as any;
		const loader = new Loader(tui, (text) => text, (text) => text, "Working", { frames: ["-"] });
		const stop = vi.spyOn(loader, "stop");
		const widget: WidgetNode = {
			kind: "loader",
			id: "loader-root",
			label: "Working",
			frame: "-",
			cancellable: false,
		};
		const registration = uiBridge.registerWidgetRoot(widget, loader);
		if (!registration) throw new Error("expected registration");

		uiBridge.dispose();
		uiBridge.dispose();

		expect(stop).toHaveBeenCalledTimes(1);
		expect(uiBridge.host).toBeUndefined();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "submit" })).toMatchObject({ handled: false });
		expect(() => registration.unregister()).not.toThrow();
		expect(uiBridge.registerWidgetRoot(widget, loader)).toBeUndefined();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "submit" })).toMatchObject({ handled: false });
	});

	it("rejects and disposes a repeated Bridge-owned Box adapter child only once", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const loader = new CancellableLoader(tui, (text) => text, (text) => text, "Shared", { frames: ["-"] });
		const dispose = vi.spyOn(loader, "dispose");
		const box = new Box(0, 0);
		box.addChild(loader);
		box.addChild(loader);
		const root = componentToWidget(box, { width: 80 });
		if (root.kind !== "box") throw new Error("expected box widget");
		expect(root.children[0].id).toBe(root.children[1].id);
		const registration = uiBridge.registerWidgetRoot(root, box, undefined, { ownership: "bridge-factory" });

		expect(registration).toBeUndefined();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: root.children[1].id, type: "cancel" })).toMatchObject({ handled: false });
		uiBridge.dispose();
		uiBridge.dispose();

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: root.children[0].id, type: "cancel" })).toMatchObject({ handled: false });
	});

	it("rejects repeated caller-owned Box adapter child mappings without disposal", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const loader = new CancellableLoader(tui, (text) => text, (text) => text, "Shared", { frames: ["-"] });
		const box = new Box(0, 0);
		box.addChild(loader);
		box.addChild(loader);
		const root = componentToWidget(box, { width: 80 });
		if (root.kind !== "box") throw new Error("expected box widget");
		const childId = root.children[0].id;
		expect(root.children[1].id).toBe(childId);
		const dispose = vi.spyOn(loader, "dispose");
		const registration = uiBridge.registerWidgetRoot(root, box, undefined, { ownership: "caller-external" });

		expect(registration).toBeUndefined();

		expect(dispose).not.toHaveBeenCalled();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: root.id, type: "submit" })).toMatchObject({ handled: false });
		expect(uiBridge.dispatchWidgetEvent({ nodeid: childId, type: "cancel" })).toMatchObject({ handled: false });
	});

	it("continues normal unregister after a widget disposer throws", () => {
		const uiBridge = createExtensionUiBridge();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const tui = { requestRender: () => {} } as any;
		const first = new Loader(tui, (text) => text, (text) => text, "First", { frames: ["-"] });
		const second = new Loader(tui, (text) => text, (text) => text, "Second", { frames: ["-"] });
		const error = new Error("stop failed");
		const firstStop = vi.spyOn(first, "stop").mockImplementation(() => {
			throw error;
		});
		const secondStop = vi.spyOn(second, "stop");
		const box = new Box(0, 0);
		box.addChild(first);
		box.addChild(second);
		const root = componentToWidget(box, { width: 80 });
		if (root.kind !== "box") throw new Error("expected box widget");
		const registration = uiBridge.registerWidgetRoot(root, box);
		if (!registration) throw new Error("expected registration");

		expect(() => registration.unregister()).not.toThrow();

		expect(firstStop).toHaveBeenCalledTimes(1);
		expect(secondStop).toHaveBeenCalledTimes(1);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: root.id, type: "submit" })).toMatchObject({ handled: false });
		expect(uiBridge.dispatchWidgetEvent({ nodeid: root.children[0].id, type: "submit" })).toMatchObject({ handled: false });
		expect(uiBridge.dispatchWidgetEvent({ nodeid: root.children[1].id, type: "submit" })).toMatchObject({ handled: false });
		expect(errorSpy).toHaveBeenCalledWith("[extension-ui] widget dispose failed:", error);
		errorSpy.mockRestore();
	});

	it("keeps a resolved custom request fulfilled when widget disposal throws", async () => {
		const uiBridge = createExtensionUiBridge();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async () => "resolved",
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		const tui = { requestRender: () => {} } as any;
		const loader = new Loader(tui, (text) => text, (text) => text, "Settled", { frames: ["-"] });
		const error = new Error("settlement cleanup failed");
		vi.spyOn(loader, "stop").mockImplementation(() => {
			throw error;
		});

		await expect(ctx.ui.custom(() => loader)).resolves.toBe("resolved");
		expect(errorSpy).toHaveBeenCalledWith("[extension-ui] widget dispose failed:", error);
		errorSpy.mockRestore();
	});

	it("degrades gracefully with no host bound", async () => {
		const ctx = createExtensionContext(() => "/work");
		expect(ctx.cwd).toBe("/work");
		expect(ctx.hasUI).toBe(false);
		expect(ctx.isIdle()).toBe(true);
		expect(ctx.signal).toBeUndefined();
		expect(ctx.model).toBeUndefined();
		expect(await ctx.getSystemPrompt()).toBe("");
		expect(await ctx.getContextUsage()).toEqual({ tokens: null, contextWindow: 0, percent: null });
		expect(await ctx.getSessionEntries()).toEqual([]);
		expect(await ctx.getLeafId()).toBeNull();
		// abort/compact are no-ops (must not throw) when unbound.
		expect(() => ctx.abort()).not.toThrow();
		expect(() => ctx.compact()).not.toThrow();
		expect(() => ctx.ui.setHeader(undefined)).not.toThrow();
		expect(() => ctx.ui.setFooter(undefined)).not.toThrow();
		await expect(ctx.ui.custom(() => undefined as any)).resolves.toBeUndefined();
		await expect(ctx.ui.editor("Edit", "draft")).resolves.toBeUndefined();
	});

	it("delegates editor UI requests to the attached UI host", async () => {
		const uiBridge = createExtensionUiBridge();
		const requests: unknown[] = [];
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async (request) => {
				requests.push(request);
				return "edited text";
			},
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);

		await expect(ctx.ui.editor("Edit handoff", "draft")).resolves.toBe("edited text");
		expect(requests).toEqual([{ kind: "editor", title: "Edit handoff", prefill: "draft" }]);
	});

	it("serializes custom UI factories through the attached UI host", async () => {
		const uiBridge = createExtensionUiBridge();
		const requests: ExtUiRequest[] = [];
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async (request) => {
				requests.push(request);
				return "chosen";
			},
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);

		await expect(ctx.ui.custom(() => new Text("native gui", 0, 0), { anchor: "center" })).resolves.toBe("chosen");

		expect(requests).toEqual([
			{
				kind: "custom",
				options: { anchor: "center" },
				widget: {
					kind: "text",
					id: expect.any(String),
					text: "native gui",
					paddingx: 0,
					paddingy: 0,
				},
			},
		]);
	});

	it("contains custom serialization failure and disposes the Bridge-owned candidate", async () => {
		const uiBridge = createExtensionUiBridge();
		const requestUi = vi.fn(async () => undefined);
		uiBridge.attach(makeExtensionUiHost({ requestUi }));
		const ctx = createExtensionContext(() => "/work", uiBridge);
		const tui = { requestRender: () => {} } as any;
		const loader = new Loader(tui, (text) => text, (text) => text, "custom", { frames: ["-"] });
		vi.spyOn(loader, "getSnapshot").mockImplementation(() => {
			throw new Error("custom serialize failed");
		});
		const stop = vi.spyOn(loader, "stop");

		await expect(ctx.ui.custom(() => loader)).resolves.toBeUndefined();

		expect(requestUi).not.toHaveBeenCalled();
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("lets custom UI factories resolve via done", async () => {
		const uiBridge = createExtensionUiBridge();
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async () => "host",
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);

		await expect(
			ctx.ui.custom((_tui, _theme, _keys, done) => {
				done("done-result");
				return new Text("done gui", 0, 0);
			})
		).resolves.toBe("done-result");
	});

	it("provides minimal tui, theme, and keybindings adapters to custom UI factories", async () => {
		const uiBridge = createExtensionUiBridge();
		const requests: ExtUiRequest[] = [];
		const updates: unknown[] = [];
		let resolveHost: (value: unknown) => void = () => {};
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			updateCustomWidget: (widget) => {
				updates.push(widget);
			},
			requestUi: async (request) => {
				requests.push(request);
				return new Promise((resolve) => {
					resolveHost = resolve;
				});
			},
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		let requestRender: (() => void) | undefined;
		let count = 0;

		const customPromise = ctx.ui.custom((tui, theme, keybindings) => {
			if (!tui || typeof (tui as { requestRender?: unknown }).requestRender !== "function") {
				throw new Error("missing tui.requestRender");
			}
			if (!theme || !keybindings) {
				throw new Error("missing theme/keybindings");
			}
			requestRender = (tui as { requestRender: () => void }).requestRender;
			return {
				render: () => [`count:${count}`],
				invalidate: () => {},
			};
		});
		await Promise.resolve();

		count = 1;
		requestRender?.();
		await Promise.resolve();

		expect(requests[0]).toMatchObject({ kind: "custom" });
		expect(updates).toEqual([
			expect.objectContaining({
				kind: "terminal",
				lines: ["count:1"],
			}),
		]);
		resolveHost("host");
		await expect(customPromise).resolves.toBe("host");
	});

	it("routes selectlist widget events back to the live custom component", async () => {
		const uiBridge = createExtensionUiBridge();
		const requests: ExtUiRequest[] = [];
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async (request) => {
				requests.push(request);
				return new Promise(() => {});
			},
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		const customPromise = ctx.ui.custom((_tui, _theme, _keys, done) => {
			const list = new SelectList(
				[
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
				],
				5,
				TestSelectListTheme
			);
			list.onSelect = (item) => done(item.value);
			return list;
		});

		await Promise.resolve();
		const request = requests[0];
		expect(request?.kind).toBe("custom");
		if (request?.kind !== "custom") throw new Error("expected custom request");

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "select", payload: { index: 1 } })).toMatchObject({ handled: true });
		await expect(customPromise).resolves.toBe("b");
	});

	it("keeps SelectList navigation, filter, focus, and activation authoritative through root revisions", () => {
		const uiBridge = createExtensionUiBridge();
		const updates: WidgetNode[] = [];
		const calls: string[] = [];
		const list = new SelectList(
			[
				{ value: "alpha", label: "Alpha" },
				{ value: "Beta", label: "Beta" },
				{ value: "bravo", label: "Bravo" },
				{ value: "charlie", label: "Charlie" },
			],
			2,
			TestSelectListTheme,
		);
		list.onSelectionChange = (item) => calls.push(`change:${item.value}`);
		list.onSelect = (item) => calls.push(`select:${item.value}`);
		list.onCancel = () => calls.push("cancel");
		const widget = componentToWidget(list, { width: 80 });
		const registration = uiBridge.registerWidgetRoot(widget, list, undefined, {
			update: (next) => updates.push(next),
		});
		if (!registration) throw new Error("expected SelectList registration");
		updates.length = 0;

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "focus",
			payload: { focused: true },
		})).toMatchObject({ handled: true });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "change",
			payload: { value: "B" },
		})).toMatchObject({ handled: true });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "key",
			payload: { data: "\x1b[B" },
		})).toMatchObject({ handled: true });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "select",
			payload: { index: 0 },
		})).toMatchObject({ handled: true });
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel" })).toMatchObject({ handled: true });

		expect(updates).toHaveLength(5);
		expect(updates[2]).toMatchObject({
			kind: "selectlist",
			focused: true,
			filter: "B",
			selectedindex: 1,
			visiblestart: 0,
			visibleend: 2,
			nomatch: false,
		});
		expect(updates.at(-1)).toMatchObject({
			kind: "selectlist",
			selectedindex: 0,
		});
		expect(calls).toEqual(["change:bravo", "change:Beta", "select:Beta", "cancel"]);
	});

	it("routes SettingsList cycle and dynamic submenu completion through authoritative root revisions", () => {
		const uiBridge = createExtensionUiBridge();
		const updates: WidgetNode[] = [];
		const calls: string[] = [];
		const submenus: SelectList[] = [];
		const settings = new SettingsList(
			[
				{ id: "mode", label: "Mode", currentValue: "fast", values: ["fast", "safe"] },
				{
					id: "theme",
					label: "Theme",
					currentValue: "dark",
					submenu: (_value, done) => {
						const submenu = new SelectList(
							[
								{ value: "dark", label: "Dark" },
								{ value: "light", label: "Light" },
							],
							2,
							TestSelectListTheme,
						);
						submenu.onSelect = (item) => done(item.value);
						submenu.onCancel = () => done();
						submenus.push(submenu);
						return submenu;
					},
				},
			],
			2,
			TestSettingsListTheme,
			(id, value) => calls.push(`change:${id}:${value}`),
			() => calls.push("cancel"),
			{ enableSearch: true },
		);
		const widget = componentToWidget(settings, { width: 80 });
		const registration = uiBridge.registerWidgetRoot(widget, settings, undefined, {
			update: (next) => updates.push(next),
		});
		if (!registration) throw new Error("expected SettingsList registration");
		updates.length = 0;

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "cycle",
			payload: { direction: 1 },
		})).toMatchObject({ handled: true });
		expect(updates.at(-1)).toMatchObject({
			kind: "settingslist",
			items: [
				expect.objectContaining({ id: "mode", currentvalue: "safe" }),
				expect.objectContaining({ id: "theme", currentvalue: "dark" }),
			],
		});
		const updatesAfterCycle = updates.length;
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "cycle",
			payload: { direction: 0 },
		})).toMatchObject({ handled: false });
		expect(updates).toHaveLength(updatesAfterCycle);
		expect(calls).toEqual(["change:mode:safe"]);

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "select",
			payload: { index: 1 },
		})).toMatchObject({ handled: true });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "submit",
			payload: { index: 1 },
		})).toMatchObject({ handled: true });
		const opened = updates.at(-1) as Extract<WidgetNode, { kind: "settingslist" }>;
		const firstSubmenuId = opened.submenu?.id;
		expect(firstSubmenuId).toBeTypeOf("string");
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel" })).toMatchObject({ handled: false });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: firstSubmenuId!,
			type: "focus",
			payload: { focused: true },
		})).toMatchObject({ handled: true });
		expect(updates.at(-1)).toMatchObject({
			kind: "settingslist",
			submenu: {
				id: firstSubmenuId,
				focused: true,
			},
		});

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: firstSubmenuId!,
			type: "select",
			payload: { index: 1 },
		})).toMatchObject({ handled: true });
		expect(updates.at(-1)).toMatchObject({
			kind: "settingslist",
			selectedindex: 1,
			items: [
				expect.objectContaining({ id: "mode", currentvalue: "safe" }),
				expect.objectContaining({ id: "theme", currentvalue: "light" }),
			],
		});
		expect((updates.at(-1) as Extract<WidgetNode, { kind: "settingslist" }>).submenu).toBeUndefined();
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: firstSubmenuId!,
			type: "select",
			payload: { index: 0 },
		})).toMatchObject({ handled: false });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "submit" })).toMatchObject({ handled: true });
		const reopened = updates.at(-1) as Extract<WidgetNode, { kind: "settingslist" }>;
		const secondSubmenuId = reopened.submenu?.id;
		expect(secondSubmenuId).toBeTypeOf("string");
		expect(secondSubmenuId).not.toBe(firstSubmenuId);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: secondSubmenuId!, type: "cancel" })).toMatchObject({ handled: true });
		expect(updates.at(-1)).toMatchObject({ kind: "settingslist", selectedindex: 1 });
		expect((updates.at(-1) as Extract<WidgetNode, { kind: "settingslist" }>).submenu).toBeUndefined();
		expect(calls).toEqual(["change:mode:safe", "change:theme:light"]);

		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel" })).toMatchObject({ handled: true });
		expect(calls).toEqual(["change:mode:safe", "change:theme:light", "cancel"]);
		expect(submenus).toHaveLength(2);
	});

	it("continues SettingsList root refresh after a synchronous returned disposer throws", () => {
		const uiBridge = createExtensionUiBridge();
		const updates: WidgetNode[] = [];
		const dispose = vi.fn(() => {
			throw new Error("returned dispose failed");
		});
		const reopened = new SelectList(
			[
				{ value: "light", label: "Light" },
				{ value: "dark", label: "Dark" },
			],
			2,
			TestSelectListTheme,
		);
		let factoryCalls = 0;
		let settings: SettingsList;
		settings = new SettingsList(
			[{
				id: "theme",
				label: "Theme",
				currentValue: "dark",
				submenu: (_value, done) => {
					factoryCalls++;
					if (factoryCalls === 1) {
						done("light");
						return {
							render: () => [],
							invalidate: () => {},
							dispose,
						};
					}
					return reopened;
				},
			}],
			1,
			TestSettingsListTheme,
			() => {
				expect(settings.getSnapshot()).toMatchObject({
					submenu: undefined,
					items: [expect.objectContaining({ currentValue: "light" })],
				});
				expect(settings.activateSelected()).toBe(true);
			},
			() => {},
		);
		const widget = componentToWidget(settings, { width: 80 });
		const registration = uiBridge.registerWidgetRoot(widget, settings, undefined, {
			update: (next) => updates.push(next),
		});
		if (!registration) throw new Error("expected SettingsList registration");
		updates.length = 0;

		expect(() => uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "submit",
		})).not.toThrow();

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(updates).toHaveLength(1);
		const refreshed = updates[0] as Extract<WidgetNode, { kind: "settingslist" }>;
		expect(refreshed).toMatchObject({
			kind: "settingslist",
			items: [expect.objectContaining({ currentvalue: "light" })],
			submenu: {
				kind: "selectlist",
				items: [
					expect.objectContaining({ value: "light" }),
					expect.objectContaining({ value: "dark" }),
				],
			},
		});
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: refreshed.submenu!.id,
			type: "focus",
			payload: { focused: true },
		})).toMatchObject({ handled: true });
		expect(updates.at(-1)).toMatchObject({
			submenu: { id: refreshed.submenu!.id, focused: true },
		});
	});

	it("routes input widget submit events back to the live custom component", async () => {
		const uiBridge = createExtensionUiBridge();
		const requests: ExtUiRequest[] = [];
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async (request) => {
				requests.push(request);
				return new Promise(() => {});
			},
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		const customPromise = ctx.ui.custom((_tui, _theme, _keys, done) => {
			const input = new Input();
			input.setValue("draft");
			input.onSubmit = (value) => done(value);
			return input;
		});

		await Promise.resolve();
		const request = requests[0];
		expect(request?.kind).toBe("custom");
		if (request?.kind !== "custom") throw new Error("expected custom request");

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: request.widget.id,
			type: "change",
			payload: { value: "final", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: true });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: request.widget.id,
			type: "submit",
			payload: { value: "final", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: true });
		await expect(customPromise).resolves.toBe("final");
	});

	it("dispatches complete Input changes and submit in FIFO order", () => {
		const uiBridge = createExtensionUiBridge();
		const input = new Input();
		const observed: string[] = [];
		input.onSubmit = (value) => observed.push(`submit:${value}`);
		const widget = componentToWidget(input, { width: 80 });
		const registration = uiBridge.registerWidgetRoot(widget, input, undefined, {
			update: (next) => {
				if (next.kind === "input") observed.push(`snapshot:${next.value}`);
			},
		});
		if (!registration) throw new Error("expected Input registration");
		observed.length = 0;

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "change",
			payload: { value: "first", selectionstart: 1, selectionend: 3 },
		})).toMatchObject({ handled: true });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "change",
			payload: { value: "second", selectionstart: 6, selectionend: 6 },
		})).toMatchObject({ handled: true });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "submit",
			payload: { value: "second", selectionstart: 2, selectionend: 4 },
		})).toMatchObject({ handled: true });

		expect(observed).toEqual([
			"snapshot:first",
			"snapshot:second",
			"submit:second",
			"snapshot:second",
		]);
		expect(input.getSnapshot()).toMatchObject({
			value: "second",
			selectionStart: 2,
			selectionEnd: 4,
		});
	});

	it("publishes handled eventid as ackid only on the target node without polluting siblings", () => {
		const uiBridge = createExtensionUiBridge();
		const root = new Box(0, 0);
		const input = new Input();
		const sibling = new Input();
		root.addChild(input);
		root.addChild(sibling);
		const updates: WidgetNode[] = [];
		const widget = componentToWidget(root, { width: 80 });
		const registration = uiBridge.registerWidgetRoot(widget, root, undefined, {
			update: (next) => updates.push(next),
		});
		if (!registration) throw new Error("expected Input root registration");
		if (widget.kind !== "box") throw new Error("expected box widget");
		const inputWidget = widget.children[0];
		updates.length = 0;

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: inputWidget.id,
			type: "change",
			eventid: "renderer-a:event-7",
			payload: { value: "accepted", selectionstart: 8, selectionend: 8 },
		} as any)).toMatchObject({ handled: true });

		expect(updates).toHaveLength(1);
		const published = updates[0];
		if (published.kind !== "box") throw new Error("expected published box widget");
		expect((published as any).ackid).toBeUndefined();
		expect((published.children[0] as any).ackid).toBe("renderer-a:event-7");
		expect((published.children[1] as any).ackid).toBeUndefined();
	});

	it("publishes and acknowledges an accepted disabled Editor submit", () => {
		const uiBridge = createExtensionUiBridge();
		const editor = new Editor(
			{ requestRender: () => {}, terminal: { rows: 24 } } as any,
			{ borderColor: (text) => text, selectList: TestSelectListTheme },
		);
		editor.disableSubmit = true;
		const submit = vi.fn();
		editor.onSubmit = submit;
		const updates: WidgetNode[] = [];
		const widget = componentToWidget(editor, { width: 80 });
		const registration = uiBridge.registerWidgetRoot(widget, editor, undefined, {
			update: (next) => updates.push(next),
		});
		if (!registration) throw new Error("expected Editor registration");
		updates.length = 0;

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "submit",
			eventid: "renderer-a:disabled-editor",
			payload: { value: "accepted", selectionstart: 2, selectionend: 6 },
		})).toEqual({ handled: true, published: true });

		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			kind: "editor",
			value: "accepted",
			selectionstart: 2,
			selectionend: 6,
			ackid: "renderer-a:disabled-editor",
		});
		expect(submit).not.toHaveBeenCalled();
	});

	it("does not attach ackid to initial or scheduled widget publications", async () => {
		const uiBridge = createExtensionUiBridge();
		const input = new Input();
		const updates: WidgetNode[] = [];
		const registration = uiBridge.registerWidgetRoot(
			componentToWidget(input, { width: 80 }),
			input,
			undefined,
			{ update: (next) => updates.push(next) },
		);
		if (!registration) throw new Error("expected Input registration");

		expect((updates[0] as any).ackid).toBeUndefined();
		input.setValue("scheduled");
		expect(uiBridge.requestWidgetRender(input)).toBe(true);
		await Promise.resolve();

		expect(updates).toHaveLength(2);
		expect(updates[1]).toMatchObject({ kind: "input", value: "scheduled" });
		expect((updates[1] as any).ackid).toBeUndefined();
	});

	it("acks a handled dynamic target without marking its newly published sibling", () => {
		const uiBridge = createExtensionUiBridge();
		const root = new Box(0, 0);
		const input = new Input();
		root.addChild(input);
		input.onSubmit = () => root.addChild(new Input());
		const updates: WidgetNode[] = [];
		const widget = componentToWidget(root, { width: 80 });
		if (widget.kind !== "box") throw new Error("expected box widget");
		const registration = uiBridge.registerWidgetRoot(widget, root, undefined, {
			update: (next) => updates.push(next),
		});
		if (!registration) throw new Error("expected dynamic root registration");
		updates.length = 0;

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.children[0].id,
			type: "submit",
			eventid: "renderer-a:dynamic",
			payload: { value: "done", selectionstart: 4, selectionend: 4 },
		} as any)).toMatchObject({ handled: true });

		const published = updates[0];
		if (published.kind !== "box") throw new Error("expected published box widget");
		expect(published.children).toHaveLength(2);
		expect((published.children[0] as any).ackid).toBe("renderer-a:dynamic");
		expect((published.children[1] as any).ackid).toBeUndefined();
	});

	it("rejects empty, whitespace, non-string, and oversized eventids without mutation or publication", () => {
		const uiBridge = createExtensionUiBridge();
		const input = new Input();
		const update = vi.fn();
		const widget = componentToWidget(input, { width: 80 });
		const registration = uiBridge.registerWidgetRoot(widget, input, undefined, { update });
		if (!registration) throw new Error("expected Input registration");
		update.mockClear();

		for (const eventid of ["", "   ", 1, "x".repeat(257)]) {
			expect(uiBridge.dispatchWidgetEvent({
				nodeid: widget.id,
				type: "change",
				eventid,
				payload: { value: "invalid", selectionstart: 7, selectionend: 7 },
			} as any)).toMatchObject({ handled: false });
		}
		expect(input.getValue()).toBe("");
		expect(update).not.toHaveBeenCalled();
	});

	it("rejects a stale Input target between complete edits", () => {
		const uiBridge = createExtensionUiBridge();
		const input = new Input();
		const submit = vi.fn();
		input.onSubmit = submit;
		const widget = componentToWidget(input, { width: 80 });
		const update = vi.fn();
		const registration = uiBridge.registerWidgetRoot(widget, input, undefined, { update });
		if (!registration) throw new Error("expected Input registration");
		update.mockClear();

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "change",
			payload: { value: "accepted", selectionstart: 8, selectionend: 8 },
		})).toMatchObject({ handled: true });
		registration.unregister();
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "change",
			payload: { value: "stale", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: false });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: widget.id,
			type: "submit",
			payload: { value: "stale", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: false });

		expect(input.getValue()).toBe("accepted");
		expect(submit).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledTimes(1);
	});

	it("routes input widget cancel events back to the live custom component", async () => {
		const uiBridge = createExtensionUiBridge();
		const requests: ExtUiRequest[] = [];
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async (request) => {
				requests.push(request);
				return new Promise(() => {});
			},
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		const customPromise = ctx.ui.custom((_tui, _theme, _keys, done) => {
			const input = new Input();
			input.onEscape = () => done("cancelled");
			return input;
		});

		await Promise.resolve();
		const request = requests[0];
		expect(request?.kind).toBe("custom");
		if (request?.kind !== "custom") throw new Error("expected custom request");

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "cancel" })).toMatchObject({ handled: true });
		await expect(customPromise).resolves.toBe("cancelled");
	});

	it("never falls back standard adapter cancel to root done when the adapter returns unhandled", () => {
		const uiBridge = createExtensionUiBridge();
		const editor = new Editor(
			{ requestRender: () => {} } as any,
			{
				borderColor: (text) => text,
				selectList: TestSelectListTheme,
			},
		);
		const invalidate = vi.spyOn(editor, "invalidate");
		const done = vi.fn();
		const update = vi.fn();
		const widget = componentToWidget(editor, { width: 80 });
		uiBridge.registerWidgetRoot(widget, editor, done, { update });
		update.mockClear();

		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel" })).toMatchObject({ handled: false });
		expect(done).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("passes unknown widget payloads through the bridge without degrading them to undefined", () => {
		const uiBridge = createExtensionUiBridge();
		const input = new Input();
		const escape = vi.fn();
		const invalidate = vi.spyOn(input, "invalidate");
		const update = vi.fn();
		input.onEscape = escape;
		const widget = componentToWidget(input, { width: 80 });
		uiBridge.registerWidgetRoot(widget, input, undefined, { update });
		update.mockClear();

		for (const payload of [null, [], "payload"]) {
			expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel", payload })).toMatchObject({ handled: false });
		}
		expect(escape).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();

		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel", payload: undefined })).toMatchObject({ handled: true });
		expect(escape).toHaveBeenCalledOnce();
		expect(invalidate).toHaveBeenCalledOnce();
		expect(update).toHaveBeenCalledOnce();
	});

	it("keeps cancel fallback only for adapterless terminal fallback targets", () => {
		const uiBridge = createExtensionUiBridge();
		const done = vi.fn();
		const update = vi.fn();
		const component: Component = {
			render: () => ["terminal fallback"],
			invalidate: vi.fn(),
		};
		const widget: WidgetNode = { kind: "terminal", id: "terminal-fallback", lines: ["terminal fallback"] };
		uiBridge.registerWidgetRoot(widget, component, done, { update });
		update.mockClear();

		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel" })).toMatchObject({ handled: true });
		expect(done).toHaveBeenCalledOnce();
		expect(done).toHaveBeenCalledWith(undefined);
		expect(component.invalidate).toHaveBeenCalledOnce();
		expect(update).toHaveBeenCalledOnce();
	});

	it("registers nested targets through adapter children", async () => {
		const uiBridge = createExtensionUiBridge();
		const requests: ExtUiRequest[] = [];
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async (request) => {
				requests.push(request);
				return new Promise(() => {});
			},
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		const customPromise = ctx.ui.custom((_tui, _theme, _keys, done) => {
			const box = new Box(0, 0);
			box.addChild(new Text("first", 0, 0));
			const input = new Input();
			input.setValue("nested");
			input.onSubmit = (value) => done(value);
			box.addChild(input);
			return box;
		});

		await Promise.resolve();
		const request = requests[0];
		expect(request?.kind).toBe("custom");
		if (request?.kind !== "custom") throw new Error("expected custom request");
		expect(request.widget.kind).toBe("box");
		if (request.widget.kind !== "box") throw new Error("expected box widget");
		const child = request.widget.children[1];
		expect(child.kind).toBe("input");

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: child.id,
			type: "submit",
			payload: { value: "nested", selectionstart: 6, selectionend: 6 },
		})).toMatchObject({ handled: true });
		await expect(customPromise).resolves.toBe("nested");
	});

	it("rejects standard events for unmarked lookalikes", () => {
		const uiBridge = createExtensionUiBridge();
		const calls: string[] = [];
		const lookalike = {
			constructor: { name: "Input" },
			setValue: (value: string) => calls.push(`change:${value}`),
			getValue: () => "value",
			onSubmit: (value: string) => calls.push(`submit:${value}`),
			render: () => ["fallback"],
			invalidate: () => {},
		} as unknown as Component;
		const widget: WidgetNode = { kind: "terminal", id: "lookalike", lines: ["fallback"] };
		uiBridge.registerWidgetRoot(widget, lookalike);

		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "change", payload: { value: "next" } })).toMatchObject({ handled: false });
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "submit" })).toMatchObject({ handled: false });
		expect(calls).toEqual([]);
	});

	it("routes terminal fallback key events through handleInput and emits the rerendered widget", async () => {
		const uiBridge = createExtensionUiBridge();
		const requests: ExtUiRequest[] = [];
		const updates: unknown[] = [];
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			updateCustomWidget: (widget) => {
				updates.push(widget);
			},
			requestUi: async (request) => {
				requests.push(request);
				return new Promise(() => {});
			},
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		void ctx.ui.custom(() => {
			let count = 0;
			return {
				render: () => [`count:${count}`],
				invalidate: () => {},
				handleInput: () => {
					count++;
				},
			};
		});

		await Promise.resolve();
		const request = requests[0];
		expect(request?.kind).toBe("custom");
		if (request?.kind !== "custom") throw new Error("expected custom request");
		expect(request.widget).toMatchObject({ kind: "terminal", lines: ["count:0"] });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "key", payload: { data: "x" } })).toMatchObject({ handled: true });

		expect(updates).toEqual([
			expect.objectContaining({
				kind: "terminal",
				id: request.widget.id,
				lines: ["count:1"],
			}),
		]);
	});

	it("closes unknown terminal widgets with done(undefined) on cancel", () => {
		const uiBridge = createExtensionUiBridge();
		const done = vi.fn();
		const component = {
			render: () => ["fallback"],
			invalidate: () => {},
		} as Component;
		const widget = componentToWidget(component, { width: 80 });
		expect(widget.kind).toBe("terminal");
		uiBridge.registerWidgetRoot(widget, component, done);

		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel" })).toMatchObject({ handled: true });
		expect(done).toHaveBeenCalledOnce();
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("keeps Editor cancel outside the standard component and root done contracts", () => {
		const uiBridge = createExtensionUiBridge();
		const done = vi.fn();
		const update = vi.fn();
		const editor = new Editor(
			{ requestRender: vi.fn(), terminal: { rows: 24 } } as any,
			{ borderColor: (text) => text, selectList: TestSelectListTheme },
		);
		const widget = componentToWidget(editor, { width: 80 });
		uiBridge.registerWidgetRoot(widget, editor, done, { update });
		update.mockClear();

		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "cancel" })).toEqual({
			handled: false,
			published: false,
		});
		expect(done).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("keeps bridge traversal and standard event dispatch adapter-owned", async () => {
		const source = await readFile(new URL("./bridge.ts", import.meta.url), "utf8");
		const childrenSource = source.slice(
			source.indexOf("function getComponentChildren"),
			source.indexOf("function getWidgetChildren")
		);
		const dispatchStart = source.indexOf("function dispatchWidgetEventToComponent");
		const dispatchSource = source.slice(dispatchStart, source.indexOf("/**", dispatchStart));

		expect(childrenSource).toContain("getPiGuiAdapter");
		expect(childrenSource).not.toContain("children?: unknown");
		expect(dispatchSource).not.toMatch(
			/setSelectedIndex\?|getSelectedItem\?|setValue\?|getValue\?|onSubmit\?|onSelect\?|onCancel\?/
		);
	});

	it("routes cancellable loader cancel events back to onAbort", async () => {
		const uiBridge = createExtensionUiBridge();
		const requests: ExtUiRequest[] = [];
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async (request) => {
				requests.push(request);
				return new Promise(() => {});
			},
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		const tui = { requestRender: () => {} } as any;
		const customPromise = ctx.ui.custom((_tui, _theme, _keys, done) => {
			const loader = new CancellableLoader(tui, (text) => text, (text) => text, "Abortable", { frames: ["!"] });
			loader.onAbort = () => done("aborted");
			return loader;
		});

		await Promise.resolve();
		const request = requests[0];
		expect(request?.kind).toBe("custom");
		if (request?.kind !== "custom") throw new Error("expected custom request");
		expect(request.widget).toMatchObject({ kind: "loader", cancellable: true });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "cancel" })).toMatchObject({ handled: true });
		await expect(customPromise).resolves.toBe("aborted");
	});

	it("disposes custom Loader widgets when the custom request unregisters", async () => {
		vi.useFakeTimers();
		const uiBridge = createExtensionUiBridge();
		const requests: ExtUiRequest[] = [];
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async (request) => {
				requests.push(request);
				return "closed";
			},
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		const requestRender = vi.fn();
		const tui = { requestRender } as any;
		const loader = new Loader(tui, (text) => text, (text) => text, "Working", { frames: ["-", "\\"] });
		const dispose = vi.spyOn(loader, "dispose");

		await expect(ctx.ui.custom(() => loader)).resolves.toBe("closed");
		expect(requests[0]).toMatchObject({ kind: "custom", widget: expect.objectContaining({ kind: "loader" }) });
		expect(dispose).toHaveBeenCalledTimes(1);
		requestRender.mockClear();
		loader.start();
		loader.setIndicator({ frames: ["x", "y"], intervalMs: 5 });
		vi.advanceTimersByTime(20);
		expect(vi.getTimerCount()).toBe(0);
		expect(requestRender).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("disposes persistent Loader widgets when replaced or cleared", () => {
		const uiBridge = createExtensionUiBridge();
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async () => undefined,
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		const tui = { requestRender: () => {} } as any;
		const first = new Loader(tui, (text) => text, (text) => text, "First", { frames: ["-", "\\"] });
		const second = new Loader(tui, (text) => text, (text) => text, "Second", { frames: ["-", "\\"] });
		const firstStop = vi.spyOn(first, "stop");
		const secondStop = vi.spyOn(second, "stop");

		ctx.ui.setWidget("busy", first);
		expect(firstStop).not.toHaveBeenCalled();

		ctx.ui.setWidget("busy", second);
		expect(firstStop).toHaveBeenCalledTimes(1);
		expect(secondStop).not.toHaveBeenCalled();

		ctx.ui.setWidget("busy", undefined);
		expect(secondStop).toHaveBeenCalledTimes(1);
	});

	it("serializes setWidget/header/footer component values through the attached UI host", () => {
		const uiBridge = createExtensionUiBridge();
		const widgets: unknown[] = [];
		let header: unknown;
		let footer: unknown;
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: (key, value) => widgets.push({ key, value }),
			setHeader: (value) => {
				header = value;
			},
			setFooter: (value) => {
				footer = value;
			},
			requestUi: async () => undefined,
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);

		ctx.ui.setWidget("summary", new Text("widget gui", 0, 0) as any);
		ctx.ui.setHeader(() => new Text("header gui", 0, 0));
		ctx.ui.setFooter(new Text("footer gui", 0, 0));

		expect(widgets).toEqual([
			{
				key: "summary",
				value: {
					kind: "text",
					id: expect.any(String),
					text: "widget gui",
					paddingx: 0,
					paddingy: 0,
				},
			},
		]);
		expect(header).toMatchObject({ kind: "text", text: "header gui" });
		expect(footer).toMatchObject({ kind: "text", text: "footer gui" });
	});

	it("routes persistent setWidget child events back to the live component", () => {
		const uiBridge = createExtensionUiBridge();
		let widget: WidgetNode | undefined;
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: (_key, value) => {
				if (value && !Array.isArray(value)) widget = value;
			},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async () => undefined,
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		let submitted: string | undefined;
		const box = new Box(0, 0);
		const input = new Input();
		input.setValue("persistent");
		input.onSubmit = (value) => {
			submitted = value;
		};
		box.addChild(input);

		ctx.ui.setWidget("inline", box);

		expect(widget?.kind).toBe("box");
		if (!widget || widget.kind !== "box") throw new Error("expected box widget");
		const child = widget.children[0];
		expect(child.kind).toBe("input");

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: child.id,
			type: "submit",
			payload: { value: "persistent", selectionstart: 10, selectionend: 10 },
		})).toMatchObject({ handled: true });
		expect(submitted).toBe("persistent");
	});

	it("rerenders persistent widget roots after child input and select events mutate visible state", () => {
		const uiBridge = createExtensionUiBridge();
		const widgets: WidgetNode[] = [];
		const uiHost: ExtensionUiHost = {
			notify: () => {},
			setStatus: () => {},
			setWidget: (_key, value) => {
				if (value && !Array.isArray(value)) widgets.push(value);
			},
			setHeader: () => {},
			setFooter: () => {},
			requestUi: async () => undefined,
		};
		uiBridge.attach(uiHost);
		const ctx = createExtensionContext(() => "/work", uiBridge);
		const box = new Box(0, 0);
		const status = new Text("Interaction: ready", 0, 0);
		const list = new SelectList(
			[
				{ value: "text", label: "Text" },
				{ value: "input", label: "Input" },
			],
			4,
			TestSelectListTheme
		);
		const input = new Input();
		input.setValue("draft");
		list.onSelect = (item) => status.setText(`Selected: ${item.label}`);
		input.onSubmit = (value) => status.setText(`Submitted: ${value}`);
		input.onEscape = () => status.setText("Cancelled");
		box.addChild(status);
		box.addChild(list);
		box.addChild(input);

		ctx.ui.setWidget("interactive", box);

		const initialWidget = widgets.at(-1);
		expect(initialWidget?.kind).toBe("box");
		if (!initialWidget || initialWidget.kind !== "box") throw new Error("expected box widget");
		const listWidget = initialWidget.children[1];
		const inputWidget = initialWidget.children[2];
		expect(listWidget.kind).toBe("selectlist");
		expect(inputWidget.kind).toBe("input");

		expect(uiBridge.dispatchWidgetEvent({
			nodeid: inputWidget.id,
			type: "change",
			payload: { value: "final", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: true });
		expect(uiBridge.dispatchWidgetEvent({
			nodeid: inputWidget.id,
			type: "submit",
			payload: { value: "final", selectionstart: 5, selectionend: 5 },
		})).toMatchObject({ handled: true });
		const afterSubmit = widgets.at(-1);
		expect(afterSubmit?.kind).toBe("box");
		if (!afterSubmit || afterSubmit.kind !== "box") throw new Error("expected box widget after submit");
		expect(afterSubmit.children[0]).toMatchObject({ kind: "text", text: "Submitted: final" });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: listWidget.id, type: "select", payload: { index: 1 } })).toMatchObject({ handled: true });
		const afterSelect = widgets.at(-1);
		expect(afterSelect?.kind).toBe("box");
		if (!afterSelect || afterSelect.kind !== "box") throw new Error("expected box widget after select");
		expect(afterSelect.children[0]).toMatchObject({ kind: "text", text: "Selected: Input" });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: inputWidget.id, type: "cancel" })).toMatchObject({ handled: true });
		const afterCancel = widgets.at(-1);
		expect(afterCancel?.kind).toBe("box");
		if (!afterCancel || afterCancel.kind !== "box") throw new Error("expected box widget after cancel");
		expect(afterCancel.children[0]).toMatchObject({ kind: "text", text: "Cancelled" });
	});

	it("delegates the read + action surface to the bound host", async () => {
		const signal = new AbortController().signal;
		let aborted = false;
		let compactedWith: string | undefined = "unset";
		const host: ExtensionContextHost = {
			isIdle: () => false,
			getSignal: () => signal,
			getModel: () => ({ provider: "openrouter", id: "m1", contextWindow: 1000 }),
			getSystemPrompt: () => Promise.resolve("SP"),
			getContextUsage: () => Promise.resolve({ tokens: 100, contextWindow: 1000, percent: 0.1 }),
			getSessionEntries: () => Promise.resolve([{ id: "e1" }]),
			getLeafId: () => Promise.resolve("e1"),
			abort: () => {
				aborted = true;
			},
			compact: (instructions) => {
				compactedWith = instructions;
			},
		};
		const ctx = createExtensionContext(() => "/work", undefined, host);
		expect(ctx.isIdle()).toBe(false);
		expect(ctx.signal).toBe(signal);
		expect(ctx.model).toEqual({ provider: "openrouter", id: "m1", contextWindow: 1000 });
		expect(await ctx.getSystemPrompt()).toBe("SP");
		expect(await ctx.getContextUsage()).toEqual({ tokens: 100, contextWindow: 1000, percent: 0.1 });
		expect(await ctx.getSessionEntries()).toEqual([{ id: "e1" }]);
		expect(await ctx.getLeafId()).toBe("e1");
		ctx.abort();
		expect(aborted).toBe(true);
		ctx.compact("focus");
		expect(compactedWith).toBe("focus");
	});
});

describe("createCommandContext", () => {
	it("degrades session-control methods to no-op / cancelled with no command host", async () => {
		const base = createExtensionContext(() => "/work");
		const ctx = createCommandContext(base);
		expect(ctx.cwd).toBe("/work");
		expect(await ctx.waitForIdle()).toBeUndefined();
		expect(await ctx.reload()).toBeUndefined();
		expect(await ctx.navigateTree("t1")).toEqual({ cancelled: true });
		expect(await ctx.newSession()).toEqual({ cancelled: true });
		expect(await ctx.fork("e1")).toEqual({ cancelled: true });
		expect(await ctx.switchSession("/p")).toEqual({ cancelled: true });
		expect(await ctx.sendMessage("hi")).toBeUndefined();
	});

	it("delegates session-control methods to the command host", async () => {
		const calls: string[] = [];
		const commandHost: ExtensionCommandHost = {
			waitForIdle: async () => {
				calls.push("waitForIdle");
			},
			reload: async () => {
				calls.push("reload");
			},
			navigateTree: async (targetId) => {
				calls.push(`navigateTree:${targetId}`);
				return { cancelled: false };
			},
			newSession: async () => {
				calls.push("newSession");
				return { cancelled: false };
			},
			fork: async (entryId) => {
				calls.push(`fork:${entryId}`);
				return { cancelled: false };
			},
			switchSession: async (p) => {
				calls.push(`switchSession:${p}`);
				return { cancelled: false };
			},
			sendMessage: async (text, options) => {
				calls.push(`sendMessage:${text}:${options?.deliverAs ?? "default"}`);
			},
		};
		const base = createExtensionContext(() => "/work");
		const ctx = createCommandContext(base, commandHost);
		await ctx.waitForIdle();
		await ctx.reload();
		expect(await ctx.navigateTree("t1")).toEqual({ cancelled: false });
		expect(await ctx.newSession()).toEqual({ cancelled: false });
		expect(await ctx.fork("e1")).toEqual({ cancelled: false });
		expect(await ctx.switchSession("/p")).toEqual({ cancelled: false });
		await ctx.sendMessage("hi", { deliverAs: "steer" });
		expect(calls).toEqual([
			"waitForIdle",
			"reload",
			"navigateTree:t1",
			"newSession",
			"fork:e1",
			"switchSession:/p",
			"sendMessage:hi:steer",
		]);
	});

	it("keeps the base read surface accessible through the command context", () => {
		const signal = new AbortController().signal;
		const host: ExtensionContextHost = {
			isIdle: () => false,
			getSignal: () => signal,
			getModel: () => ({ provider: "p", id: "m", contextWindow: 10 }),
			getSystemPrompt: () => Promise.resolve("SP"),
			getContextUsage: () => Promise.resolve({ tokens: 1, contextWindow: 10, percent: 0.1 }),
			getSessionEntries: () => Promise.resolve([]),
			getLeafId: () => Promise.resolve(null),
			abort: () => {},
			compact: () => {},
		};
		const base = createExtensionContext(() => "/work", undefined, host);
		const ctx = createCommandContext(base);
		expect(ctx.cwd).toBe("/work");
		expect(ctx.signal).toBe(signal);
		expect(ctx.model).toEqual({ provider: "p", id: "m", contextWindow: 10 });
		expect(ctx.isIdle()).toBe(false);
	});
});
