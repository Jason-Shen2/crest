// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// extensions/loader.ts — ported from pi's extension loader
// (packages/coding-agent/src/core/extensions/loader.ts, earendil-works/pi,
// MIT). This is the "拷 loader 核心 + 重接线" port: the jiti module load,
// createExtensionAPI registration surface, createExtension record, and the
// discoverExtensionsInDir / resolveExtensionEntries / discoverAndLoadExtensions
// discovery walk are kept as close to upstream as possible.
//
// Re-wiring vs. upstream:
//   - pi runs as a Bun single-file binary that bundles pi-tui/pi-ai/
//     pi-agent-core/pi-coding-agent and exposes them to extensions via
//     jiti `virtualModules`. crest runs headless under Node with those
//     packages stripped, so the Bun branch and all pi-package aliases are
//     dropped; only the `typebox` alias (the one dependency extension tool
//     schemas actually need) is kept.
//   - pi's config.ts constants (CONFIG_DIR_NAME, getAgentDir, isBunBinary)
//     become crest's `.crest` project dir + defaultConfigHome().
//   - utils/paths.resolvePath -> tools/_paths.resolvePath.
//   - createSyntheticSourceInfo -> a trimmed inline builder (see types.ts).
//   - The event-bus / provider-registration / sendMessage plumbing is
//     out of the headless scope and omitted; runner.ts is not ported —
//     the bind/bridge layer (index.ts) wires handlers into AgentHarness.

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import { resolvePath } from "../tools/_paths";
import { waitForChildProcess } from "../tools/_child-process";
import { defaultConfigHome } from "../sessions";
import type {
    EntryRenderer,
    ExecOptions,
    ExecResult,
    Extension,
    ExtensionAPI,
    ExtensionFactory,
    ExtensionRuntime,
    LoadExtensionsResult,
    MessageRenderer,
    RegisteredCommand,
    SourceInfo,
    ToolDefinition,
} from "./types";

/** Project-local config dir name (mirrors pi's `.pi`). */
const PROJECT_CONFIG_DIR = ".crest";

const require = createRequire(import.meta.url);
const ExtensionLoaderDir = path.dirname(fileURLToPath(import.meta.url));

function resolvePiGuiSrcDir(): string {
    const sourceDir = path.join(process.cwd(), "emain", "agent", "extensions", "pi-gui", "src");
    if (fs.existsSync(sourceDir)) {
        return sourceDir;
    }
    return path.join(ExtensionLoaderDir, "pi-gui", "src");
}

/**
 * Get aliases for jiti so extensions can `import { Type } from "typebox"`
 * without the extension directory having its own node_modules. pi aliases
 * its whole bundled package set here; crest only ships typebox for
 * extension tool schemas, so that is the only alias we keep. Extensions
 * that need other npm deps still resolve them from a node_modules beside
 * the extension (jiti's default resolution), exactly like pi.
 */
let _aliases: Record<string, string> | null = null;

function collectPiGuiSubpathAliases(srcDir: string): Record<string, string> {
    const aliases: Record<string, string> = {};
    const visit = (dir: string, relDir = ""): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const absPath = path.join(dir, entry.name);
            const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
            if (entry.isDirectory()) {
                visit(absPath, relPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
            const subpath = relPath.slice(0, -".ts".length).split(path.sep).join("/");
            aliases[`@earendil-works/pi-tui/${subpath}`] = absPath;
        }
    };
    visit(srcDir);
    return aliases;
}

function getAliases(): Record<string, string> {
    if (_aliases) return _aliases;

    const typeboxEntry = require.resolve("typebox");
    const typeboxCompileEntry = require.resolve("typebox/compile");
    const typeboxValueEntry = require.resolve("typebox/value");
    const piGuiSrcDir = resolvePiGuiSrcDir();
    const piGuiEntry = path.join(piGuiSrcDir, "index.ts");

    _aliases = {
        typebox: typeboxEntry,
        "typebox/compile": typeboxCompileEntry,
        "typebox/value": typeboxValueEntry,
        "@sinclair/typebox": typeboxEntry,
        "@sinclair/typebox/compile": typeboxCompileEntry,
        "@sinclair/typebox/value": typeboxValueEntry,
        ...collectPiGuiSubpathAliases(piGuiSrcDir),
        "@earendil-works/pi-tui": piGuiEntry,
    };

    return _aliases;
}

let extensionCacheCwd: string | undefined;
let extensionCacheGeneration = 0;
const extensionCache = new Map<string, ExtensionFactory>();

interface ExtensionCacheToken {
    cwd: string;
    generation: number;
}

export function clearExtensionCache(): void {
    extensionCache.clear();
    extensionCacheCwd = undefined;
    extensionCacheGeneration++;
}

function useExtensionCacheCwd(cwd: string): ExtensionCacheToken {
    const resolvedCwd = resolvePath(cwd);
    if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
        clearExtensionCache();
    }
    extensionCacheCwd = resolvedCwd;
    return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}

/** Trimmed replacement for pi's createSyntheticSourceInfo. */
function createSourceInfo(extensionPath: string, options: { source: string; baseDir?: string }): SourceInfo {
    return {
        source: options.source,
        path: extensionPath,
        baseDir: options.baseDir,
    };
}

/**
 * Run a command for an extension's `pi.exec()`. Replaces pi's execCommand
 * (which depends on pi's exec.ts). Node spawn + the shared
 * waitForChildProcess helper is enough for the headless surface.
 */
function execCommand(command: string, args: string[], cwd: string, options?: ExecOptions): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: options?.env ? { ...process.env, ...options.env } : process.env,
            windowsHide: true,
        });

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        let timer: NodeJS.Timeout | undefined;
        if (options?.timeoutMs && options.timeoutMs > 0) {
            timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
        }

        if (options?.input !== undefined) {
            child.stdin?.on("error", () => {});
            child.stdin?.end(options.input);
        }

        child.on("error", (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
        });

        waitForChildProcess(child)
            .then((code) => {
                if (timer) clearTimeout(timer);
                resolve({ stdout, stderr, code });
            })
            .catch((err) => {
                if (timer) clearTimeout(timer);
                reject(err);
            });
    });
}

/**
 * Create a runtime with throwing stubs for action methods. The bind layer
 * (index.ts) replaces these with AgentHarness-backed implementations once
 * a harness exists — mirrors pi's createExtensionRuntime + bindCore().
 */
export function createExtensionRuntime(): ExtensionRuntime {
    const notInitialized = (): never => {
        throw new Error(
            "Extension runtime not initialized. Action methods cannot be called during extension loading.",
        );
    };
    const state: { staleMessage?: string } = {};
    const assertActive = () => {
        if (state.staleMessage) {
            throw new Error(state.staleMessage);
        }
    };

    const runtime: ExtensionRuntime = {
        appendEntry: notInitialized,
        getActiveTools: notInitialized,
        setActiveTools: notInitialized,
        getAllTools: notInitialized,
        // registerTool() is valid during extension load; refresh is only needed post-bind.
        refreshTools: () => {},
        flagValues: new Map(),
        providerRegistrations: [],
        assertActive,
        invalidate: (message) => {
            state.staleMessage ??=
                message ??
                "This extension ctx is stale after session replacement or reload. Do not reuse a captured pi or ctx after the session was replaced.";
        },
    };

    return runtime;
}

/**
 * Create the ExtensionAPI for an extension. Registration methods write to
 * the extension object; action methods delegate to the shared runtime.
 */
function createExtensionAPI(extension: Extension, runtime: ExtensionRuntime, cwd: string): ExtensionAPI {
    const api: ExtensionAPI = {
        // Registration methods - write to extension
        on(event: string, handler): void {
            runtime.assertActive();
            const list = extension.handlers.get(event) ?? [];
            list.push(handler);
            extension.handlers.set(event, list);
        },

        registerTool(tool: ToolDefinition): void {
            runtime.assertActive();
            extension.tools.set(tool.name, {
                definition: tool,
                sourceInfo: extension.sourceInfo,
            });
            runtime.refreshTools();
        },

        registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
            runtime.assertActive();
            extension.commands.set(name, {
                name,
                sourceInfo: extension.sourceInfo,
                ...options,
            });
        },

        registerShortcut(shortcut, options): void {
            runtime.assertActive();
            extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
        },

        registerFlag(name, options): void {
            runtime.assertActive();
            extension.flags.set(name, { name, extensionPath: extension.path, ...options });
            if (options.default !== undefined && !runtime.flagValues.has(name)) {
                runtime.flagValues.set(name, options.default);
            }
        },

        registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
            runtime.assertActive();
            extension.messageRenderers.set(customType, renderer as MessageRenderer);
        },

        registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
            runtime.assertActive();
            extension.entryRenderers.set(customType, renderer as EntryRenderer);
        },

        // Flag access - checks extension registered it, reads from runtime
        getFlag(name: string): boolean | string | undefined {
            runtime.assertActive();
            if (!extension.flags.has(name)) return undefined;
            return runtime.flagValues.get(name);
        },

        // Action methods - delegate to shared runtime
        appendEntry(customType: string, data?: unknown): void {
            runtime.assertActive();
            runtime.appendEntry(customType, data);
        },

        exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
            runtime.assertActive();
            return execCommand(command, args, options?.cwd ?? cwd, options);
        },

        getActiveTools(): string[] {
            runtime.assertActive();
            return runtime.getActiveTools();
        },

        getAllTools(): string[] {
            runtime.assertActive();
            return runtime.getAllTools();
        },

        setActiveTools(toolNames: string[]): void {
            runtime.assertActive();
            runtime.setActiveTools(toolNames);
        },

        registerProvider(name: string, config: unknown): void {
            runtime.assertActive();
            runtime.providerRegistrations = runtime.providerRegistrations.filter((provider) => provider.name !== name);
            runtime.providerRegistrations.push({ name, config, extensionPath: extension.path });
        },

        unregisterProvider(name: string): void {
            runtime.assertActive();
            runtime.providerRegistrations = runtime.providerRegistrations.filter((provider) => provider.name !== name);
        },
    };

    return api;
}

function isCurrentCacheToken(cacheToken: ExtensionCacheToken | undefined): cacheToken is ExtensionCacheToken {
    return (
        cacheToken !== undefined &&
        extensionCacheCwd === cacheToken.cwd &&
        extensionCacheGeneration === cacheToken.generation
    );
}

async function loadExtensionModule(
    extensionPath: string,
    cacheToken?: ExtensionCacheToken,
): Promise<ExtensionFactory | undefined> {
    if (isCurrentCacheToken(cacheToken)) {
        const cachedFactory = extensionCache.get(extensionPath);
        if (cachedFactory) {
            return cachedFactory;
        }
    }

    const jiti = createJiti(import.meta.url, {
        moduleCache: false,
        alias: getAliases(),
    });

    const module = await jiti.import(extensionPath, { default: true });
    const factory = module as ExtensionFactory;
    if (typeof factory !== "function") {
        return undefined;
    }
    if (isCurrentCacheToken(cacheToken)) {
        extensionCache.set(extensionPath, factory);
    }
    return factory;
}

/** Create an Extension object with empty collections. */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
    const source =
        extensionPath.startsWith("<") && extensionPath.endsWith(">")
            ? extensionPath.slice(1, -1).split(":")[0] || "temporary"
            : "local";
    const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

    return {
        path: extensionPath,
        resolvedPath,
        sourceInfo: createSourceInfo(extensionPath, { source, baseDir }),
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        entryRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
    };
}

async function loadExtension(
    extensionPath: string,
    cwd: string,
    runtime: ExtensionRuntime,
    cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
    const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

    try {
        const factory = await loadExtensionModule(resolvedPath, cacheToken);
        if (!factory) {
            return {
                extension: null,
                error: `Extension does not export a valid factory function: ${extensionPath}`,
            };
        }

        const extension = createExtension(extensionPath, resolvedPath);
        const api = createExtensionAPI(extension, runtime, cwd);
        await factory(api);

        return { extension, error: null };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { extension: null, error: `Failed to load extension: ${message}` };
    }
}

/** Create an Extension from an inline factory function. */
export async function loadExtensionFromFactory(
    factory: ExtensionFactory,
    cwd: string,
    runtime: ExtensionRuntime,
    extensionPath = "<inline>",
): Promise<Extension> {
    const extension = createExtension(extensionPath, extensionPath);
    const resolvedCwd = resolvePath(cwd);
    const api = createExtensionAPI(extension, runtime, resolvedCwd);
    await factory(api);
    return extension;
}

/** Load extensions from a list of resolved paths. */
async function loadExtensionsInternal(
    paths: string[],
    cwd: string,
    runtime?: ExtensionRuntime,
    useCache = false,
): Promise<LoadExtensionsResult> {
    const extensions: Extension[] = [];
    const errors: Array<{ path: string; error: string }> = [];
    const cacheToken = useCache ? useExtensionCacheCwd(cwd) : undefined;
    const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
    const resolvedRuntime = runtime ?? createExtensionRuntime();

    for (const extPath of paths) {
        const { extension, error } = await loadExtension(extPath, resolvedCwd, resolvedRuntime, cacheToken);

        if (error) {
            errors.push({ path: extPath, error });
            continue;
        }

        if (extension) {
            extensions.push(extension);
        }
    }

    return {
        extensions,
        errors,
        runtime: resolvedRuntime,
    };
}

export async function loadExtensions(
    paths: string[],
    cwd: string,
    runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
    return loadExtensionsInternal(paths, cwd, runtime);
}

export async function loadExtensionsCached(
    paths: string[],
    cwd: string,
    runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
    return loadExtensionsInternal(paths, cwd, runtime, true);
}

interface PiManifest {
    extensions?: string[];
    themes?: string[];
    skills?: string[];
    prompts?: string[];
}

type PiManifestResourceField = "skills" | "prompts" | "themes";

function readPiManifest(packageJsonPath: string): PiManifest | null {
    try {
        const content = fs.readFileSync(packageJsonPath, "utf-8");
        const pkg = JSON.parse(content);
        if (pkg.pi && typeof pkg.pi === "object") {
            return pkg.pi as PiManifest;
        }
        return null;
    } catch {
        return null;
    }
}

function resolveManifestResourcePaths(dir: string, field: PiManifestResourceField): string[] {
    const packageJsonPath = path.join(dir, "package.json");
    if (!fs.existsSync(packageJsonPath)) return [];
    const manifest = readPiManifest(packageJsonPath);
    const entries = manifest?.[field];
    if (!entries?.length) return [];
    const resolved: string[] = [];
    for (const entry of entries) {
        const resourcePath = path.resolve(dir, entry);
        if (fs.existsSync(resourcePath)) resolved.push(resourcePath);
    }
    return resolved;
}

function discoverPackageDirsInExtensionDir(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const packageDirs: string[] = [];
    if (fs.existsSync(path.join(dir, "package.json"))) {
        packageDirs.push(dir);
    }
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const entryPath = path.join(dir, entry.name);
            if (fs.existsSync(path.join(entryPath, "package.json"))) {
                packageDirs.push(entryPath);
            }
        }
    } catch {
        return packageDirs;
    }
    return packageDirs;
}

export function discoverExtensionManifestResourcePaths(options: {
    cwd: string;
    configHome?: string;
    paths?: string[];
    field: PiManifestResourceField;
}): string[] {
    const resolvedCwd = resolvePath(options.cwd);
    const seenPackages = new Set<string>();
    const seenResources = new Set<string>();
    const resources: string[] = [];
    const packageDirs: string[] = [];

    for (const dir of defaultExtensionDirs(resolvedCwd, options.configHome ?? defaultConfigHome())) {
        packageDirs.push(...discoverPackageDirsInExtensionDir(dir));
    }

    for (const configuredPath of options.paths ?? []) {
        const resolved = resolvePath(configuredPath, resolvedCwd, { normalizeUnicodeSpaces: true });
        if (!fs.existsSync(resolved)) continue;
        const stat = fs.statSync(resolved);
        const dir = stat.isDirectory() ? resolved : path.dirname(resolved);
        packageDirs.push(...discoverPackageDirsInExtensionDir(dir));
    }

    for (const packageDir of packageDirs) {
        const resolvedPackageDir = path.resolve(packageDir);
        if (seenPackages.has(resolvedPackageDir)) continue;
        seenPackages.add(resolvedPackageDir);
        for (const resourcePath of resolveManifestResourcePaths(resolvedPackageDir, options.field)) {
            const resolvedResourcePath = path.resolve(resourcePath);
            if (seenResources.has(resolvedResourcePath)) continue;
            seenResources.add(resolvedResourcePath);
            resources.push(resourcePath);
        }
    }

    return resources;
}

function isExtensionFile(name: string): boolean {
    return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
    const packageJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
        const manifest = readPiManifest(packageJsonPath);
        if (manifest?.extensions?.length) {
            const entries: string[] = [];
            for (const extPath of manifest.extensions) {
                const resolvedExtPath = path.resolve(dir, extPath);
                if (fs.existsSync(resolvedExtPath)) {
                    entries.push(resolvedExtPath);
                }
            }
            if (entries.length > 0) {
                return entries;
            }
        }
    }

    const indexTs = path.join(dir, "index.ts");
    const indexJs = path.join(dir, "index.js");
    if (fs.existsSync(indexTs)) {
        return [indexTs];
    }
    if (fs.existsSync(indexJs)) {
        return [indexJs];
    }

    return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/x/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/x/package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
    if (!fs.existsSync(dir)) {
        return [];
    }

    const discovered: string[] = [];

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);

            // 1. Direct files: *.ts or *.js
            if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
                discovered.push(entryPath);
                continue;
            }

            // 2 & 3. Subdirectories
            if (entry.isDirectory() || entry.isSymbolicLink()) {
                const subEntries = resolveExtensionEntries(entryPath);
                if (subEntries) {
                    discovered.push(...subEntries);
                }
            }
        }
    } catch {
        return [];
    }

    return discovered;
}

/**
 * Default extension directories for a pane, project-local first then global:
 *   1. <cwd>/.crest/extensions   — project-local extensions
 *   2. <configHome>/extensions   — user-global extensions
 *
 * Mirrors pi's cwd/.pi/extensions + agentDir/extensions locations.
 */
export function defaultExtensionDirs(cwd: string, configHome: string = defaultConfigHome()): string[] {
    return [path.join(cwd, PROJECT_CONFIG_DIR, "extensions"), path.join(configHome, "extensions")];
}

/**
 * Discover and load extensions from standard locations plus any explicitly
 * configured paths. Ported from pi's discoverAndLoadExtensions.
 */
export async function discoverAndLoadExtensions(
    configuredPaths: string[],
    cwd: string,
    configHome: string = defaultConfigHome(),
    runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
    const resolvedCwd = resolvePath(cwd);
    const allPaths: string[] = [];
    const seen = new Set<string>();

    const addPaths = (paths: string[]) => {
        for (const p of paths) {
            const resolved = path.resolve(p);
            if (!seen.has(resolved)) {
                seen.add(resolved);
                allPaths.push(p);
            }
        }
    };

    // 1 & 2. Standard project-local + global extension directories.
    for (const dir of defaultExtensionDirs(resolvedCwd, configHome)) {
        addPaths(discoverExtensionsInDir(dir));
    }

    // 3. Explicitly configured paths.
    for (const p of configuredPaths) {
        const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
            const entries = resolveExtensionEntries(resolved);
            if (entries) {
                addPaths(entries);
                continue;
            }
            addPaths(discoverExtensionsInDir(resolved));
            continue;
        }

        addPaths([resolved]);
    }

    return loadExtensions(allPaths, resolvedCwd, runtime);
}
