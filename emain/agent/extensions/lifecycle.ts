// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
	Extension,
	ExtensionGraph,
	ExtensionGraphError,
	ExtensionGraphNode,
	ExtensionRuntime,
	ExtensionScope,
} from "./types";

type DisposeFn = () => void | Promise<void>;

interface RecordFailureInput {
	id: string;
	name: string;
	version: string;
	path: string;
	scope: ExtensionScope;
	phase: ExtensionGraphError["phase"];
	error: unknown;
}

export interface ExtensionLifecycleHost {
	getGraph(): ExtensionGraph;
	setNodes(nodes: ExtensionGraphNode[]): void;
	recordFailure(input: RecordFailureInput): void;
	registerDispose(ownerId: string, dispose: DisposeFn): () => void;
	disposeOwner(ownerId: string): Promise<void>;
	disposeAll(): Promise<void>;
	reloadStart(): Promise<void>;
}

interface OwnedDispose {
	ownerId: string;
	dispose: DisposeFn;
}

function cloneNode(node: ExtensionGraphNode): ExtensionGraphNode {
	return {
		...node,
		commands: [...node.commands],
		tools: [...node.tools],
		hooks: [...node.hooks],
		flags: [...node.flags],
		errors: node.errors.map((error) => ({ ...error })),
	};
}

function cloneGraph(graph: ExtensionGraph): ExtensionGraph {
	return {
		generation: graph.generation,
		nodes: graph.nodes.map(cloneNode),
	};
}

function disposedNode(node: ExtensionGraphNode): ExtensionGraphNode {
	return {
		...cloneNode(node),
		status: "disposed",
	};
}

function errorToGraphError(phase: ExtensionGraphError["phase"], error: unknown): ExtensionGraphError {
	return {
		phase,
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
		timestamp: Date.now(),
	};
}

export function extensionToGraphNode(extension: Extension, scope: ExtensionScope): ExtensionGraphNode {
	return {
		id: extension.path,
		name: extension.path,
		version: "0.0.0",
		path: extension.path,
		scope,
		status: "active",
		commands: Array.from(extension.commands.keys()).sort(),
		tools: Array.from(extension.tools.keys()).sort(),
		hooks: Array.from(extension.handlers.keys()).sort(),
		flags: Array.from(extension.flags.keys()).sort(),
		errors: [],
	};
}

const RuntimeHosts = new WeakMap<ExtensionRuntime, ExtensionLifecycleHost>();
const RuntimeLifecycleHosts = new Set<ExtensionLifecycleHost>();

export async function reloadExtensionLifecycleHosts(): Promise<void> {
	const hosts = [...RuntimeLifecycleHosts];
	await Promise.all(hosts.map((host) => host.reloadStart()));
}

function makeExtensionLifecycleHost(runtime?: ExtensionRuntime): ExtensionLifecycleHost {
	let graph: ExtensionGraph = { generation: 0, nodes: [] };
	const disposers = new Map<string, OwnedDispose[]>();

	const markDisposed = () => {
		graph = {
			generation: graph.generation,
			nodes: graph.nodes.map(disposedNode),
		};
	};

	const bumpGeneration = () => {
		graph = {
			generation: graph.generation + 1,
			nodes: graph.nodes,
		};
	};

	const runDisposers = async (pending: OwnedDispose[]) => {
		if (pending.length === 0) return;
		runtime?.invalidate();
		const errors: unknown[] = [];
		for (const { dispose } of pending) {
			try {
				await dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		markDisposed();
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Extension disposers failed");
	};

	const disposeOwner = async (ownerId: string) => {
		const ownerDisposers = disposers.get(ownerId);
		disposers.delete(ownerId);
		const pending = [...(ownerDisposers ?? [])].reverse();
		await runDisposers(pending);
	};

	const disposeAll = async () => {
		const pending = [...disposers.values()].flat().reverse();
		disposers.clear();
		await runDisposers(pending);
	};

	return {
		getGraph() {
			return cloneGraph(graph);
		},
		setNodes(nodes) {
			graph = {
				generation: graph.generation,
				nodes: nodes.map(cloneNode),
			};
		},
		recordFailure(input) {
			const graphError = errorToGraphError(input.phase, input.error);
			let updated = false;
			const nodes: ExtensionGraphNode[] = graph.nodes.map((node) => {
				if (node.id !== input.id) return cloneNode(node);
				updated = true;
				return {
					...cloneNode(node),
					name: input.name,
					version: input.version,
					path: input.path,
					scope: input.scope,
					status: "failed",
					errors: [...node.errors.map((error) => ({ ...error })), graphError],
				};
			});
			if (!updated) {
				const failedNode: ExtensionGraphNode = {
					id: input.id,
					name: input.name,
					version: input.version,
					path: input.path,
					scope: input.scope,
					status: "failed",
					commands: [],
					tools: [],
					hooks: [],
					flags: [],
					errors: [graphError],
				};
				nodes.push(failedNode);
			}
			graph = {
				generation: graph.generation,
				nodes,
			};
		},
		registerDispose(ownerId, dispose) {
			const entry = { ownerId, dispose };
			const ownerDisposers = disposers.get(ownerId) ?? [];
			ownerDisposers.push(entry);
			disposers.set(ownerId, ownerDisposers);
			return () => {
				const current = disposers.get(ownerId);
				if (!current) return;
				const index = current.indexOf(entry);
				if (index >= 0) current.splice(index, 1);
				if (current.length === 0) disposers.delete(ownerId);
			};
		},
		disposeOwner,
		disposeAll,
		async reloadStart() {
			if (disposers.size === 0) {
				runtime?.invalidate();
				markDisposed();
				bumpGeneration();
				return;
			}
			try {
				await disposeAll();
			} finally {
				bumpGeneration();
			}
		},
	};
}

export function createExtensionLifecycleHost(runtime?: ExtensionRuntime): ExtensionLifecycleHost {
	if (!runtime) return makeExtensionLifecycleHost();
	const existing = RuntimeHosts.get(runtime);
	if (existing) return existing;
	const host = makeExtensionLifecycleHost(runtime);
	RuntimeHosts.set(runtime, host);
	RuntimeLifecycleHosts.add(host);
	return host;
}

export function unregisterExtensionLifecycleHost(host: ExtensionLifecycleHost): void {
	RuntimeLifecycleHosts.delete(host);
}

export function unregisterExtensionLifecycleHosts(): void {
	RuntimeLifecycleHosts.clear();
}

export function getExtensionGraphForLifecycleRuntime(runtime?: ExtensionRuntime): ExtensionGraph {
	if (runtime) {
		return createExtensionLifecycleHost(runtime).getGraph();
	}
	const graphs = [...RuntimeLifecycleHosts].map((host) => host.getGraph());
	return {
		generation: graphs.reduce((max, graph) => Math.max(max, graph.generation), 0),
		nodes: graphs.flatMap((graph) => graph.nodes),
	};
}
