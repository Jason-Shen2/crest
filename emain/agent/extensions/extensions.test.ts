// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { Loader } from "./pi-gui/src/components/loader";
import { SelectList, type SelectListTheme } from "./pi-gui/src/components/select-list";
import { Input } from "./pi-gui/src/components/input";
import { Text } from "./pi-gui/src/components/text";
import { Box } from "./pi-gui/src/components/box";
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
		expect(plannedComponents.map((item) => item.id)).toEqual([
			"box",
			"select-list",
			"settings-list",
			"input",
			"markdown",
			"editor",
			"loader",
		]);
		expect(plannedComponents.every((item) => item.notes.includes("M2"))).toBe(true);
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
			"cancel",
		]);
		expect(requirementsById.get("loader")).toEqual(["state-snapshot", "animation", "cancel"]);
		expect(requirementsById.get("custom-component")).toEqual(["terminal-surface-fallback"]);
		expect(matrix.flatMap((item) => item.behaviorRequirements).every((req) => req.requirement && req.evidence.length > 0)).toBe(
			true
		);
		expect(byId.get("select-list")?.behavior).toEqual(["keyboard-navigation", "filtering", "scrolling", "focus"]);
		expect(byId.get("select-list")?.plannedBehavior).toEqual(["keyboard-navigation", "filtering", "scrolling", "focus"]);
		expect(byId.get("input")?.behavior).toEqual(["text-editing", "selection-ime-clipboard"]);
		expect(byId.get("input")?.plannedBehavior).toEqual(["text-editing", "selection-ime-clipboard"]);
		expect(byId.get("settings-list")?.behavior).toEqual(["keyboard-navigation", "search", "submenu", "layout-parity"]);
		expect(byId.get("settings-list")?.plannedBehavior).toEqual(["keyboard-navigation", "search", "submenu", "layout-parity"]);
		expect(byId.get("editor")?.behavior).toEqual(["cancel", "cursor-selection-parity", "selection-ime-clipboard"]);
		expect(byId.get("editor")?.plannedBehavior).toEqual(["cancel", "cursor-selection-parity", "selection-ime-clipboard"]);
		expect(byId.get("loader")?.behavior).toEqual(["animation-cadence"]);
		expect(byId.get("loader")?.plannedBehavior).toEqual(["animation-cadence"]);
		expect(byId.get("custom-component")?.plannedBehavior).toEqual(["terminal-surface-fallback"]);
		expect(byId.get("text")?.plannedBehavior).toBeUndefined();
		expect(byId.get("text")?.behavior).toBeUndefined();
		expect(byId.get("text")?.certification).toBe("passing");
		expect(byId.get("select-list")?.certification).toBe("planned");
		expect(byId.get("custom-component")?.certification).toBe("unsupported");
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
				import { Chart, DiffView, RichTable } from "@earendil-works/pi-tui";
				export default (pi) => {
					const table = new RichTable({ columns: [{ key: "name", label: "Name" }], rows: [{ name: "pi-gui" }] });
					const diff = new DiffView({ hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: "+new" }] }] });
					const chart = new Chart({ charttype: "bar", series: [{ name: "coverage", points: [{ label: "Text", value: 1 }] }] });
					pi.registerFlag("rich-alias", { type: "string", default: [table, diff, chart].map((c) => c.render(40).join("\\n")).join("|") });
				};
			`
		);

		const result = await loadAgentExtensions({ cwd, configHome: join(root, "cfg") });

		expect(result.errors).toEqual([]);
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

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "key", payload: { data: "x" } })).toBe(true);
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

		expect(uiBridge.dispatchWidgetEvent({ nodeid: listWidget.id, type: "select", payload: { index: 1 } })).toBe(true);
		expect(nestedWidget.kind).toBe("box");
		expect(nestedWidget.children[1]).toMatchObject({ kind: "text", text: "Selected: Input" });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: inputWidget.id, type: "change", payload: { value: "typed" } })).toBe(
			true
		);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: inputWidget.id, type: "submit" })).toBe(true);
		expect(nestedWidget.kind).toBe("box");
		expect(nestedWidget.children[1]).toMatchObject({ kind: "text", text: "Submitted: typed" });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: inputWidget.id, type: "cancel" })).toBe(true);
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
		const unregister = uiBridge.registerWidgetRoot(widget, loader);

		uiBridge.dispose();
		uiBridge.dispose();

		expect(stop).toHaveBeenCalledTimes(1);
		expect(uiBridge.host).toBeUndefined();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "submit" })).toBe(false);
		expect(() => unregister()).not.toThrow();
		const staleUnregister = uiBridge.registerWidgetRoot(widget, loader);
		expect(() => staleUnregister()).not.toThrow();
		expect(uiBridge.dispatchWidgetEvent({ nodeid: widget.id, type: "submit" })).toBe(false);
	});

	it("disposes a component registered for both root and child only once", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const loader = new Loader(tui, (text) => text, (text) => text, "Shared", { frames: ["-"] });
		const stop = vi.spyOn(loader, "stop");
		(loader as unknown as { children: Loader[] }).children = [loader];
		const child: WidgetNode = {
			kind: "loader",
			id: "loader-child",
			label: "Shared",
			frame: "-",
			cancellable: false,
		};
		const root: WidgetNode = {
			kind: "box",
			id: "loader-container",
			paddingx: 0,
			paddingy: 0,
			children: [child],
		};
		uiBridge.registerWidgetRoot(root, loader);

		uiBridge.dispose();

		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("unregisters shared component mappings before disposing the component once", () => {
		const uiBridge = createExtensionUiBridge();
		const tui = { requestRender: () => {} } as any;
		const loader = new Loader(tui, (text) => text, (text) => text, "Shared", { frames: ["-"] });
		(loader as unknown as { children: Loader[] }).children = [loader];
		const child: WidgetNode = {
			kind: "loader",
			id: "shared-child",
			label: "Shared",
			frame: "-",
			cancellable: false,
		};
		const root: WidgetNode = {
			kind: "box",
			id: "shared-root",
			paddingx: 0,
			paddingy: 0,
			children: [child],
		};
		const staleDispatches: boolean[] = [];
		const originalStop = loader.stop.bind(loader);
		const stop = vi.spyOn(loader, "stop").mockImplementation(() => {
			staleDispatches.push(uiBridge.dispatchWidgetEvent({ nodeid: child.id, type: "submit" }));
			originalStop();
		});
		const unregister = uiBridge.registerWidgetRoot(root, loader);

		unregister();

		expect(stop).toHaveBeenCalledTimes(1);
		expect(staleDispatches).toEqual([false]);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: root.id, type: "submit" })).toBe(false);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: child.id, type: "submit" })).toBe(false);
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
		const firstWidget: WidgetNode = {
			kind: "loader",
			id: "throwing-first",
			label: "First",
			frame: "-",
			cancellable: false,
		};
		const secondWidget: WidgetNode = {
			kind: "loader",
			id: "throwing-second",
			label: "Second",
			frame: "-",
			cancellable: false,
		};
		const root: WidgetNode = {
			kind: "box",
			id: "throwing-root",
			paddingx: 0,
			paddingy: 0,
			children: [firstWidget, secondWidget],
		};
		const unregister = uiBridge.registerWidgetRoot(root, box);

		expect(() => unregister()).not.toThrow();

		expect(firstStop).toHaveBeenCalledTimes(1);
		expect(secondStop).toHaveBeenCalledTimes(1);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: root.id, type: "submit" })).toBe(false);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: firstWidget.id, type: "submit" })).toBe(false);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: secondWidget.id, type: "submit" })).toBe(false);
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

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "select", payload: { index: 1 } })).toBe(
			true
		);
		await expect(customPromise).resolves.toBe("b");
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

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "change", payload: { value: "final" } })).toBe(
			true
		);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "submit" })).toBe(true);
		await expect(customPromise).resolves.toBe("final");
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

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "cancel" })).toBe(true);
		await expect(customPromise).resolves.toBe("cancelled");
	});

	it("closes custom input widgets with done(undefined) when cancel has no callback", async () => {
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
		const customPromise = ctx.ui.custom(() => new Input());

		await Promise.resolve();
		const request = requests[0];
		expect(request?.kind).toBe("custom");
		if (request?.kind !== "custom") throw new Error("expected custom request");

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "cancel" })).toBe(true);
		await expect(customPromise).resolves.toBeUndefined();
	});

	it("routes nested child widget events back to the matching live component", async () => {
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
		const child = request.widget.children[0];
		expect(child.kind).toBe("input");

		expect(uiBridge.dispatchWidgetEvent({ nodeid: child.id, type: "submit" })).toBe(true);
		await expect(customPromise).resolves.toBe("nested");
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

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "key", payload: { data: "x" } })).toBe(true);

		expect(updates).toEqual([
			expect.objectContaining({
				kind: "terminal",
				id: request.widget.id,
				lines: ["count:1"],
			}),
		]);
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

		expect(uiBridge.dispatchWidgetEvent({ nodeid: request.widget.id, type: "cancel" })).toBe(true);
		await expect(customPromise).resolves.toBe("aborted");
	});

	it("disposes custom Loader widgets when the custom request unregisters", async () => {
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
		const tui = { requestRender: () => {} } as any;
		const loader = new Loader(tui, (text) => text, (text) => text, "Working", { frames: ["-", "\\"] });
		const stop = vi.spyOn(loader, "stop");

		await expect(ctx.ui.custom(() => loader)).resolves.toBe("closed");
		expect(requests[0]).toMatchObject({ kind: "custom", widget: expect.objectContaining({ kind: "loader" }) });
		expect(stop).toHaveBeenCalled();
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

		expect(uiBridge.dispatchWidgetEvent({ nodeid: child.id, type: "submit" })).toBe(true);
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

		expect(uiBridge.dispatchWidgetEvent({ nodeid: inputWidget.id, type: "change", payload: { value: "final" } })).toBe(
			true
		);
		expect(uiBridge.dispatchWidgetEvent({ nodeid: inputWidget.id, type: "submit" })).toBe(true);
		const afterSubmit = widgets.at(-1);
		expect(afterSubmit?.kind).toBe("box");
		if (!afterSubmit || afterSubmit.kind !== "box") throw new Error("expected box widget after submit");
		expect(afterSubmit.children[0]).toMatchObject({ kind: "text", text: "Submitted: final" });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: listWidget.id, type: "select", payload: { index: 1 } })).toBe(true);
		const afterSelect = widgets.at(-1);
		expect(afterSelect?.kind).toBe("box");
		if (!afterSelect || afterSelect.kind !== "box") throw new Error("expected box widget after select");
		expect(afterSelect.children[0]).toMatchObject({ kind: "text", text: "Selected: Input" });

		expect(uiBridge.dispatchWidgetEvent({ nodeid: inputWidget.id, type: "cancel" })).toBe(true);
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
