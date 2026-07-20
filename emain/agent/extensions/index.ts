// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// extensions/index.ts — high-level entry for the headless extension system.
// Mirrors skills-loader.ts: agent-session setup calls loadAgentExtensions()
// with the pane's cwd; discovery walks <cwd>/.crest/extensions and
// <configHome>/extensions (loader.defaultExtensionDirs), jiti-loads each
// factory, and returns the loaded extensions plus the shared runtime.
//
// The returned runtime starts inert (action methods throw). harness-factory
// binds it to the live AgentHarness (bindExtensionRuntime) and wires the
// hook handlers (wireExtensionHooks) once the harness is constructed.

import path from "node:path";

import { defaultConfigHome } from "../sessions";
import { clearExtensionCache, discoverAndLoadExtensions } from "./loader";
import {
	createExtensionLifecycleHost,
	extensionToGraphNode,
	getExtensionGraphForLifecycleRuntime,
	reloadExtensionLifecycleHosts,
	unregisterExtensionLifecycleHosts,
	type ExtensionLifecycleHost,
} from "./lifecycle";
import type { ExtensionGraph, ExtensionRuntime, ExtensionScope, LoadExtensionsResult } from "./types";

const DevShowcaseExtensionPath = path.join(
	process.cwd(),
	"emain",
	"agent",
	"extensions",
	"fixtures",
	"pi-gui-showcase-extension.ts"
);

function shouldIncludeDevShowcase(option?: boolean): boolean {
	return option === true || process.env.CREST_AGENT_DEV_SHOWCASE === "1";
}

function isPathWithin(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function extensionScope(extensionPath: string, cwd: string, configHome: string): ExtensionScope {
	const resolvedPath = path.resolve(extensionPath);
	const workspaceExtensionsDir = path.resolve(cwd, ".crest", "extensions");
	if (isPathWithin(resolvedPath, workspaceExtensionsDir)) return "workspace";
	const globalExtensionsDir = path.resolve(configHome, "extensions");
	return isPathWithin(resolvedPath, globalExtensionsDir) ? "global" : "workspace";
}

export {
	clearExtensionCache,
	discoverAndLoadExtensions,
	defaultExtensionDirs,
	loadExtensions,
	loadExtensionsCached,
	loadExtensionFromFactory,
	createExtensionRuntime,
	discoverExtensionManifestResourcePaths,
} from "./loader";
export {
	bindExtensionRuntime,
	collectExtensionTools,
	createCommandContext,
	createExtensionContext,
	createExtensionUiBridge,
	mergeBaseAndExtensionTools,
	renderExtensionEntry,
	renderExtensionMessage,
	renderExtensionSessionEntries,
	wireExtensionHooks,
} from "./bridge";
export type { ExtUiRequest, ExtensionUiBridge, ExtensionUiHost, WidgetEvent } from "./bridge";
export type {
	ContextUsage,
	Extension,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandHost,
	ExtensionContext,
	ExtensionContextHost,
	ExtensionFactory,
	ExtensionGraph,
	ExtensionModelInfo,
	ExtensionRuntime,
	LoadExtensionsResult,
	ToolDefinition,
} from "./types";

interface LoadAgentExtensionsOptions {
	cwd: string;
	configHome?: string;
	/** Extra explicitly configured extension paths (files or dirs). */
	paths?: string[];
	/** Dev-only local fixture for manually validating pi-tui to GUI rendering. */
	includeDevShowcase?: boolean;
	/** Discovery-only callers can opt out so read APIs do not retain graph hosts. */
	trackGraph?: boolean;
}

interface ReloadExtensionsForRuntimeOptions extends LoadAgentExtensionsOptions {
	lifecycleHost?: ExtensionLifecycleHost;
}

function seedLifecycleHostGraph(
	lifecycleHost: ExtensionLifecycleHost,
	result: LoadExtensionsResult,
	options: LoadAgentExtensionsOptions,
	configHome: string,
	preserveExisting: boolean
): void {
	if (!preserveExisting) {
		lifecycleHost.setNodes([]);
	}
	for (const { path, error } of result.errors) {
		console.warn(`[agent-ipc] extension load failed at ${path}: ${error}`);
		lifecycleHost.recordFailure({
			id: path,
			name: path,
			version: "0.0.0",
			path,
			scope: extensionScope(path, options.cwd, configHome),
			phase: "load",
			error,
		});
	}
	const existingNodes = lifecycleHost.getGraph().nodes;
	const failedNodeIds = new Set(existingNodes.filter((node) => node.status === "failed").map((node) => node.id));
	const activeNodes = result.extensions
		.filter((extension) => !failedNodeIds.has(extension.path))
		.map((extension) => extensionToGraphNode(extension, extensionScope(extension.path, options.cwd, configHome)));
	lifecycleHost.setNodes([...existingNodes, ...activeNodes]);
}

/**
 * Discover and load extensions for a pane. Runs at agent-session setup.
 * Missing directories are skipped by the loader; per-extension load errors
 * are logged but never throw (one broken extension must not break the pane).
 */
export async function loadAgentExtensions(options: LoadAgentExtensionsOptions): Promise<LoadExtensionsResult> {
	const paths = [...(options.paths ?? [])];
	if (shouldIncludeDevShowcase(options.includeDevShowcase)) {
		paths.push(DevShowcaseExtensionPath);
	}
	const configHome = options.configHome ?? defaultConfigHome();
	const result = await discoverAndLoadExtensions(paths, options.cwd, configHome);
	if (options.trackGraph === false) {
		for (const { path, error } of result.errors) {
			console.warn(`[agent-ipc] extension load failed at ${path}: ${error}`);
		}
		return result;
	}
	const lifecycleHost = createExtensionLifecycleHost(result.runtime);
	seedLifecycleHostGraph(lifecycleHost, result, options, configHome, true);
	return result;
}

export function getExtensionGraphForRuntime(runtime?: ExtensionRuntime): ExtensionGraph {
	return getExtensionGraphForLifecycleRuntime(runtime);
}

export async function reloadExtensionsForRuntime(options: ReloadExtensionsForRuntimeOptions): Promise<ExtensionGraph> {
	if (options.lifecycleHost) {
		await options.lifecycleHost.reloadStart();
	} else {
		await reloadExtensionLifecycleHosts();
		unregisterExtensionLifecycleHosts();
	}

	clearExtensionCache();
	const result = await loadAgentExtensions({
		...options,
		trackGraph: false,
	});
	if (options.lifecycleHost) {
		seedLifecycleHostGraph(
			options.lifecycleHost,
			result,
			options,
			options.configHome ?? defaultConfigHome(),
			false
		);
		return options.lifecycleHost.getGraph();
	}
	const transientHost = createExtensionLifecycleHost();
	seedLifecycleHostGraph(transientHost, result, options, options.configHome ?? defaultConfigHome(), false);
	return transientHost.getGraph();
}
