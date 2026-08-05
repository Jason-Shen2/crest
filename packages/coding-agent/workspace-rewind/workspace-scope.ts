// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import ignore, { type Ignore } from "ignore";
import { createHash } from "node:crypto";
import { constants, lstatSync, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { WorkspaceGitRunner, WorkspaceGitRunnerError } from "./git-runner";
import type { WorkspaceCoverageReason, WorkspaceSnapshotCoverage } from "./types";
import { verifyCanonicalWorkspaceIdentity, type CanonicalWorkspaceIdentity } from "./workspace-identity";

export interface WorkspaceScopeEntry {
    pathBytes: Buffer;
    path?: string;
    kind: "file" | "symlink" | "excluded";
    tracked: boolean;
    executable?: boolean;
    size?: number;
    exclusionReason?: WorkspaceCoverageReason;
    parentIdentity?: WorkspaceScopeDirectoryIdentity;
    entryIdentity?: WorkspaceScopeEntryIdentity;
}

export interface WorkspaceScopeDirectoryIdentity {
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
}

export interface WorkspaceScopeEntryIdentity extends WorkspaceScopeDirectoryIdentity {
    mode: bigint;
    nlink: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
}

export interface WorkspaceScope {
    root: string;
    entries: WorkspaceScopeEntry[];
    coverage: WorkspaceSnapshotCoverage;
    manifest: WorkspaceScopeManifest;
    directories: WorkspaceScopeDirectoryEvidence[];
}

export interface WorkspaceScopeInput {
    identity: CanonicalWorkspaceIdentity;
    git: WorkspaceGitRunner;
    maxEntries: number;
    maxUntrackedBytes: number;
    signal?: AbortSignal;
}

export interface WorkspaceScopeManifestPath {
    path?: string;
    pathBytesBase64?: string;
}

export interface WorkspaceScopeIgnoreInput extends WorkspaceScopeManifestPath {
    source: "gitignore" | "git-info-exclude" | "git-core-excludes-file";
    contentHash: string;
}

export interface WorkspaceScopeManifest {
    schemaVersion: 1;
    policy: {
        maxEntries: number;
        maxUntrackedBytes: number;
        gitGlobalExcludes: "disabled-by-isolated-runner";
    };
    ignoreInputs: WorkspaceScopeIgnoreInput[];
    nestedRepositoryBoundaries: WorkspaceScopeManifestPath[];
    budgetExhaustion?: WorkspaceScopeBudgetExhaustion;
}

export type WorkspaceScopeBudgetExhaustion = { scope: "workspace-root" };

export type IncrementalWorkspaceScopeEntry =
    | WorkspaceScopeEntry
    | { pathBytes: Buffer; path: string; kind: "absent"; tracked: boolean };

export type IncrementalWorkspaceScopeResult =
    | { status: "captured"; entries: IncrementalWorkspaceScopeEntry[] }
    | { status: "reconcile"; reason: "scope-invalidated" | "unstable-path" | "unsafe-evidence" };

interface IgnoreMatcher {
    basePathBytes: Buffer;
    matcher: Ignore;
}

interface GitClassification {
    tracked: Set<string>;
    ignored: Set<string>;
    ignoredDirectories: Buffer[];
    ignoreInputs: WorkspaceScopeIgnoreInput[];
    trackedHash: string;
    ignoredHash: string;
    indexPath: Buffer;
    indexVersion: FileVersion;
    infoExcludePath: Buffer;
    coreExcludesPath?: Buffer;
}

interface DiscoveryState {
    rootBytes: Buffer;
    entries: WorkspaceScopeEntry[];
    exclusions: WorkspaceSnapshotCoverage["exclusions"];
    git?: GitClassification;
    maxEntries: number;
    maxUntrackedBytes: number;
    eligibleEntryCount: number;
    ignoreInputs: WorkspaceScopeIgnoreInput[];
    nestedRepositoryBoundaries: WorkspaceScopeManifestPath[];
    scannedEntryCount: number;
    scanStopped: boolean;
    directorySnapshots: WorkspaceScopeDirectoryEvidence[];
    signal?: AbortSignal;
}

interface DirectoryIdentity {
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
}

export interface WorkspaceScopeDirectoryEvidence {
    pathBytes: Buffer;
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    entryCount: number;
    namesHash: string;
}

interface FileVersion {
    exists: boolean;
    dev?: bigint;
    ino?: bigint;
    size?: bigint;
    mtimeNs?: bigint;
    ctimeNs?: bigint;
}

interface WorkspaceScopeAttempt {
    scope: WorkspaceScope;
    git?: GitClassification;
    directorySnapshots: WorkspaceScopeDirectoryEvidence[];
}

const ScopeGitTimeoutMs = 30_000;
const IgnoreInputMaxBytes = 1024 * 1024;
const Utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const IncrementalGitPathChunkBytes = 64 * 1024;

class WorkspaceBudgetExceeded extends Error {
    constructor() {
        super("Workspace scope scan budget exceeded");
    }
}

export async function discoverWorkspaceScope(input: WorkspaceScopeInput): Promise<WorkspaceScope> {
    validateLimits(input.maxEntries, input.maxUntrackedBytes);
    for (let attempt = 0; attempt < 2; attempt++) {
        assertScopeActive(input.signal);
        const result = await discoverWorkspaceScopeAttempt(input);
        if (await verifyWorkspaceScope(input, result)) {
            return result.scope;
        }
    }
    throw new Error("Workspace changed repeatedly during scope discovery");
}

export async function classifyIncrementalWorkspacePaths(input: {
    identity: CanonicalWorkspaceIdentity;
    git: WorkspaceGitRunner;
    scope: WorkspaceScopeManifest;
    paths: readonly string[];
    maxEntries: number;
    maxUntrackedBytes: number;
    signal?: AbortSignal;
}): Promise<IncrementalWorkspaceScopeResult> {
    if (input.paths.length === 0) return { status: "captured", entries: [] };
    validateLimits(input.maxEntries, input.maxUntrackedBytes);
    const paths = normalizeIncrementalPaths(input.paths);
    if (paths.some((path) => invalidatesWorkspaceScope(path, input.scope))) {
        return { status: "reconcile", reason: "scope-invalidated" };
    }
    try {
        const rootBytes = Buffer.from(input.identity.canonicalRoot);
        await verifyCanonicalWorkspaceIdentity(input.identity);
        if (!(await verifyIncrementalScopeAuthority(rootBytes, input.scope, input.signal))) {
            return { status: "reconcile", reason: "scope-invalidated" };
        }
        const candidates: IncrementalWorkspaceScopeEntry[] = [];
        let visited = 0;
        for (const path of paths) {
            const result = await enumerateIncrementalPath(rootBytes, Buffer.from(path), input, () => {
                visited += 1;
                if (visited > input.maxEntries) throw new WorkspaceBudgetExceeded();
            });
            if (result === "scope-invalidated") return { status: "reconcile", reason: result };
            if (result === "unsafe-evidence") return { status: "reconcile", reason: result };
            candidates.push(...result);
        }
        const gitWorkspace = await isGitWorkspace(input);
        const { tracked, ignored } = gitWorkspace
            ? await classifyIncrementalGitPaths(
                  input,
                  candidates.map((entry) => entry.path!)
              )
            : {
                  tracked: new Set<string>(),
                  ignored: await classifyIncrementalIgnoredPaths(rootBytes, input.scope, candidates, input.signal),
              };
        const entries: IncrementalWorkspaceScopeEntry[] = [];
        for (const candidate of candidates) {
            const path = candidate.path!;
            const isTracked = tracked.has(path);
            if (ignored.has(path)) {
                entries.push({ ...candidate, kind: "excluded", tracked: isTracked, exclusionReason: "ignored" });
                continue;
            }
            if (candidate.kind === "file" && !isTracked && candidate.size! > input.maxUntrackedBytes) {
                entries.push({
                    ...candidate,
                    kind: "excluded",
                    tracked: false,
                    exclusionReason: "oversized-untracked",
                });
                continue;
            }
            entries.push({ ...candidate, tracked: isTracked });
        }
        await verifyCanonicalWorkspaceIdentity(input.identity);
        if (!(await verifyIncrementalScopeAuthority(rootBytes, input.scope, input.signal))) {
            return { status: "reconcile", reason: "scope-invalidated" };
        }
        entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
        return { status: "captured", entries };
    } catch (error) {
        if (error instanceof WorkspaceBudgetExceeded) return { status: "reconcile", reason: "unsafe-evidence" };
        if (isWorkspaceGitRunnerFailure(error, "aborted")) throw error;
        if (isUnsafeIncrementalEvidence(error)) return { status: "reconcile", reason: "unsafe-evidence" };
        if (isScopeInvalidation(error)) return { status: "reconcile", reason: "scope-invalidated" };
        return { status: "reconcile", reason: "unstable-path" };
    }
}

function normalizeIncrementalPaths(paths: readonly string[]): string[] {
    const values = [...new Set(paths)];
    for (const path of values) {
        if (
            !path ||
            path.includes("\0") ||
            path.includes("\\") ||
            path.startsWith("/") ||
            /^[A-Za-z]:/.test(path) ||
            path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
            Buffer.from(path).toString("utf8") !== path
        ) {
            throw new Error(`unsafe incremental path: ${path}`);
        }
    }
    values.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const accepted = new Set<string>();
    return values.filter((path) => {
        let separator = path.indexOf("/");
        while (separator >= 0) {
            if (accepted.has(path.slice(0, separator))) return false;
            separator = path.indexOf("/", separator + 1);
        }
        accepted.add(path);
        return true;
    });
}

function invalidatesWorkspaceScope(path: string, scope: WorkspaceScopeManifest): boolean {
    if (path.split("/").includes(".git")) return true;
    if (path.endsWith(".gitignore") && (path === ".gitignore" || path.endsWith("/.gitignore"))) return true;
    if (
        scope.ignoreInputs.some(
            (entry) => entry.source === "gitignore" && manifestLocatorBytes(entry).equals(Buffer.from(path))
        )
    ) {
        return true;
    }
    return scope.nestedRepositoryBoundaries.some((entry) => {
        const boundary = decodePath(manifestLocatorBytes(entry));
        return (
            boundary != null &&
            (path === boundary || path.startsWith(`${boundary}/`) || boundary.startsWith(`${path}/`))
        );
    });
}

async function verifyIncrementalScopeAuthority(
    rootBytes: Buffer,
    scope: WorkspaceScopeManifest,
    signal?: AbortSignal
): Promise<boolean> {
    for (const input of scope.ignoreInputs) {
        if (input.source === "gitignore") continue;
        assertScopeActive(signal);
        try {
            const content = await readSafeIgnoreInput(platformPath(manifestLocatorBytes(input)), signal);
            if (hashContent(content) !== input.contentHash) return false;
        } catch (error) {
            if (isMissing(error)) return false;
            throw error;
        }
    }
    return true;
}

async function enumerateIncrementalPath(
    rootBytes: Buffer,
    pathBytes: Buffer,
    input: {
        signal?: AbortSignal;
        maxEntries: number;
    },
    visit: () => void
): Promise<IncrementalWorkspaceScopeEntry[] | "scope-invalidated" | "unsafe-evidence"> {
    assertScopeActive(input.signal);
    const path = decodePath(pathBytes);
    if (path == null) return "unsafe-evidence";
    const parentBytes = dirnameBytes(pathBytes);
    const parent = await readSafeIncrementalParent(rootBytes, parentBytes);
    let metadata: BigIntStats;
    try {
        metadata = await lstat(absolutePath(rootBytes, pathBytes), { bigint: true });
    } catch (error) {
        if (!isMissing(error)) throw error;
        assertSameDirectory(parent, await readDirectoryIdentity(absolutePath(rootBytes, parentBytes)));
        return [{ pathBytes, path, kind: "absent", tracked: false }];
    }
    visit();
    assertSameDirectory(parent, await readDirectoryIdentity(absolutePath(rootBytes, parentBytes)));
    if (metadata.isSymbolicLink()) {
        return [makeIncrementalScopeEntry(pathBytes, path, metadata, parent, "symlink")];
    }
    if (metadata.isFile()) {
        if (metadata.nlink !== 1n) return "unsafe-evidence";
        return [makeIncrementalScopeEntry(pathBytes, path, metadata, parent, "file")];
    }
    if (!metadata.isDirectory()) return "unsafe-evidence";
    const before = await readDirectoryIdentity(absolutePath(rootBytes, pathBytes));
    const children = await readBoundedDirectory(absolutePath(rootBytes, pathBytes), input.maxEntries + 1, input.signal);
    children.sort((left, right) => Buffer.compare(left.name, right.name));
    const entries: IncrementalWorkspaceScopeEntry[] = [];
    for (const child of children) {
        if (!Buffer.isBuffer(child.name)) return "unsafe-evidence";
        if (child.name.equals(Buffer.from(".git")) || child.name.equals(Buffer.from(".gitignore"))) {
            return "scope-invalidated";
        }
        const childPath = appendPath(pathBytes, child.name);
        if (decodePath(childPath) == null) return "unsafe-evidence";
        const result = await enumerateIncrementalPath(rootBytes, childPath, input, visit);
        if (typeof result === "string") return result;
        entries.push(...result);
    }
    assertSameDirectory(before, await readDirectoryIdentity(absolutePath(rootBytes, pathBytes)));
    return entries;
}

async function readSafeIncrementalParent(rootBytes: Buffer, parentBytes: Buffer): Promise<DirectoryIdentity> {
    let current: Buffer = Buffer.alloc(0);
    let identity = await readDirectoryIdentity(rootBytes);
    if (parentBytes.length === 0) return identity;
    for (const segment of splitPathBytes(parentBytes)) {
        current = appendPath(current, segment);
        const metadata = await lstat(absolutePath(rootBytes, current), { bigint: true });
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error("unsafe incremental ancestor");
        }
        identity = {
            dev: metadata.dev,
            ino: metadata.ino,
            birthtimeNs: metadata.birthtimeNs,
            mtimeNs: metadata.mtimeNs,
            ctimeNs: metadata.ctimeNs,
        };
    }
    return identity;
}

function makeIncrementalScopeEntry(
    pathBytes: Buffer,
    path: string,
    metadata: BigIntStats,
    parent: DirectoryIdentity,
    kind: "file" | "symlink"
): WorkspaceScopeEntry {
    return {
        pathBytes,
        path,
        kind,
        tracked: false,
        ...(kind === "file" ? { executable: (metadata.mode & 0o111n) !== 0n } : {}),
        size: Number(metadata.size),
        parentIdentity: directoryIdentityEvidence(parent),
        entryIdentity: entryIdentityEvidence(metadata),
    };
}

async function isGitWorkspace(input: {
    identity: CanonicalWorkspaceIdentity;
    git: WorkspaceGitRunner;
    signal?: AbortSignal;
}): Promise<boolean> {
    try {
        const result = await input.git.run(["rev-parse", "--is-inside-work-tree"], {
            cwd: input.identity.canonicalRoot,
            timeoutMs: ScopeGitTimeoutMs,
            signal: input.signal,
        });
        return stripLineEnding(result.stdout).toString("ascii") === "true";
    } catch (error) {
        if (isWorkspaceGitRunnerFailure(error, "nonzero_exit")) return false;
        throw error;
    }
}

async function classifyIncrementalGitPaths(
    input: { identity: CanonicalWorkspaceIdentity; git: WorkspaceGitRunner; signal?: AbortSignal },
    paths: string[]
): Promise<{ tracked: Set<string>; ignored: Set<string> }> {
    const tracked = new Set<string>();
    for (const chunk of chunkGitPaths(paths)) {
        const result = await input.git.run(["ls-files", "--cached", "-z", "--", ...chunk], {
            cwd: input.identity.canonicalRoot,
            timeoutMs: ScopeGitTimeoutMs,
            signal: input.signal,
        });
        for (const path of splitNul(result.stdout)) tracked.add(decodeGitPath(path));
    }
    const ignored = new Set<string>();
    for (const chunk of chunkGitPaths(paths)) {
        let ignoredOutput: Buffer;
        try {
            ignoredOutput = (
                await input.git.run(["check-ignore", "-z", "--stdin"], {
                    cwd: input.identity.canonicalRoot,
                    stdin: Buffer.concat(chunk.map((path) => Buffer.from(`${path}\0`))),
                    timeoutMs: ScopeGitTimeoutMs,
                    signal: input.signal,
                })
            ).stdout;
        } catch (error) {
            if (!isWorkspaceGitRunnerFailure(error, "nonzero_exit") || error.exitCode !== 1) {
                throw error;
            }
            ignoredOutput = error.stdout;
        }
        for (const path of splitNul(ignoredOutput)) ignored.add(decodeGitPath(path));
    }
    return { tracked, ignored };
}

async function classifyIncrementalIgnoredPaths(
    rootBytes: Buffer,
    scope: WorkspaceScopeManifest,
    entries: IncrementalWorkspaceScopeEntry[],
    signal?: AbortSignal
): Promise<Set<string>> {
    const matchers: IgnoreMatcher[] = [];
    for (const input of scope.ignoreInputs) {
        if (input.source !== "gitignore") continue;
        const pathBytes = manifestLocatorBytes(input);
        const basePathBytes = dirnameBytes(pathBytes);
        if (!entries.some((entry) => relativeToBase(basePathBytes, entry.pathBytes) != null)) continue;
        const content = await readSafeIgnoreInput(absolutePath(rootBytes, pathBytes), signal);
        matchers.push({
            basePathBytes,
            matcher: ignore().add(content.toString("utf8")),
        });
    }
    const ignored = new Set<string>();
    for (const entry of entries) {
        let excluded = false;
        for (const item of matchers) {
            const relative = relativeToBase(item.basePathBytes, entry.pathBytes);
            if (!relative) continue;
            const result = item.matcher.test(relative);
            if (result.ignored) excluded = true;
            if (result.unignored) excluded = false;
        }
        if (excluded) ignored.add(entry.path!);
    }
    return ignored;
}

function chunkGitPaths(paths: string[]): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let bytes = 0;
    for (const path of paths) {
        const pathBytes = Buffer.byteLength(path) + 1;
        if (current.length > 0 && bytes + pathBytes > IncrementalGitPathChunkBytes) {
            chunks.push(current);
            current = [];
            bytes = 0;
        }
        current.push(path);
        bytes += pathBytes;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

function decodeGitPath(path: Buffer): string {
    const value = decodePath(path);
    if (value == null) throw new Error("unsafe non-UTF-8 Git path evidence");
    return value;
}

function dirnameBytes(path: Buffer): Buffer {
    const separator = path.lastIndexOf(0x2f);
    return separator < 0 ? Buffer.alloc(0) : path.subarray(0, separator);
}

function splitPathBytes(path: Buffer): Buffer[] {
    if (path.length === 0) return [];
    const parts: Buffer[] = [];
    let start = 0;
    for (let index = 0; index <= path.length; index++) {
        if (index === path.length || path[index] === 0x2f) {
            parts.push(path.subarray(start, index));
            start = index + 1;
        }
    }
    return parts;
}

function relativeToBase(base: Buffer, path: Buffer): string | undefined {
    if (base.length === 0) return decodePath(path);
    if (path.length <= base.length || !path.subarray(0, base.length).equals(base) || path[base.length] !== 0x2f) {
        return undefined;
    }
    return decodePath(path.subarray(base.length + 1));
}

function isUnsafeIncrementalEvidence(error: unknown): boolean {
    return error instanceof Error && /unsafe|non-UTF-8|capture budget/i.test(error.message);
}

function isScopeInvalidation(error: unknown): boolean {
    return (
        error instanceof Error &&
        /workspace identity chain changed|canonical workspace identity chain/i.test(error.message)
    );
}

function isWorkspaceGitRunnerFailure(
    error: unknown,
    code: WorkspaceGitRunnerError["code"]
): error is WorkspaceGitRunnerError {
    return error instanceof Error && error.name === "WorkspaceGitRunnerError" && "code" in error && error.code === code;
}

async function verifyWorkspaceScope(input: WorkspaceScopeInput, attempt: WorkspaceScopeAttempt): Promise<boolean> {
    assertScopeActive(input.signal);
    if (attempt.git && !(await verifyGitWorkspaceScope(input, attempt))) {
        return false;
    }
    if (!(await verifyWorkspaceScopeDirectories(attempt.scope, input.signal))) {
        return false;
    }
    const rootBytes = Buffer.from(input.identity.canonicalRoot);
    if (!(await verifyIgnoreInputs(rootBytes, attempt.scope.manifest.ignoreInputs, input.signal))) {
        return false;
    }
    if (!attempt.git) {
        return true;
    }
    return (
        (await verifyExternalIgnoreInput(
            attempt.scope.manifest.ignoreInputs,
            "git-info-exclude",
            attempt.git.infoExcludePath,
            input.signal
        )) &&
        (await verifyExternalIgnoreInput(
            attempt.scope.manifest.ignoreInputs,
            "git-core-excludes-file",
            attempt.git.coreExcludesPath,
            input.signal
        ))
    );
}

async function discoverWorkspaceScopeAttempt(input: WorkspaceScopeInput): Promise<WorkspaceScopeAttempt> {
    assertScopeActive(input.signal);
    const rootBytes = Buffer.from(input.identity.canonicalRoot);
    const git = await classifyGitWorkspace(input.identity.canonicalRoot, input.git, input.signal);
    const state: DiscoveryState = {
        rootBytes,
        entries: [],
        exclusions: [],
        git,
        maxEntries: input.maxEntries,
        maxUntrackedBytes: input.maxUntrackedBytes,
        eligibleEntryCount: 0,
        ignoreInputs: git?.ignoreInputs ?? [],
        nestedRepositoryBoundaries: [],
        scannedEntryCount: 0,
        scanStopped: false,
        directorySnapshots: [],
        signal: input.signal,
    };
    try {
        await enumerateDirectory(state, Buffer.alloc(0), []);
    } catch (error) {
        if (!(error instanceof WorkspaceBudgetExceeded)) {
            throw error;
        }
        state.scanStopped = true;
        state.exclusions.push({ scope: "workspace-root", reason: "capture-budget" });
    }
    state.entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
    state.directorySnapshots.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));

    return {
        git,
        directorySnapshots: state.directorySnapshots,
        scope: {
            root: input.identity.canonicalRoot,
            entries: state.entries,
            directories: state.directorySnapshots,
            coverage: {
                complete: state.exclusions.length === 0 && !state.scanStopped,
                eligibleEntryCount: state.eligibleEntryCount,
                newlyHashedBytes: 0,
                exclusions: state.exclusions,
            },
            manifest: {
                schemaVersion: 1,
                policy: {
                    maxEntries: input.maxEntries,
                    maxUntrackedBytes: input.maxUntrackedBytes,
                    gitGlobalExcludes: "disabled-by-isolated-runner",
                },
                ignoreInputs: state.ignoreInputs,
                nestedRepositoryBoundaries: state.nestedRepositoryBoundaries,
                ...(state.scanStopped
                    ? {
                          budgetExhaustion: { scope: "workspace-root" } as const,
                      }
                    : {}),
            },
        },
    };
}

async function classifyGitWorkspace(
    root: string,
    git: WorkspaceGitRunner,
    signal?: AbortSignal
): Promise<GitClassification | undefined> {
    assertScopeActive(signal);
    let inside;
    try {
        inside = await git.run(["rev-parse", "--is-inside-work-tree"], {
            cwd: root,
            timeoutMs: ScopeGitTimeoutMs,
            signal,
        });
    } catch (error) {
        if (error instanceof WorkspaceGitRunnerError && error.code === "nonzero_exit") {
            return undefined;
        }
        throw error;
    }
    if (stripLineEnding(inside.stdout).toString("ascii") !== "true") {
        return undefined;
    }

    const [indexPath, infoExcludePath, coreExcludesPath] = await Promise.all([
        resolveGitPath(git, root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], signal),
        resolveGitPath(git, root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], signal),
        resolveOptionalCoreExcludesPath(git, root, signal),
    ]);
    assertScopeActive(signal);
    const indexVersion = await readOptionalFileVersion(indexPath);
    const ignoreInputs: WorkspaceScopeIgnoreInput[] = [];
    await appendExternalIgnoreInput(ignoreInputs, "git-info-exclude", infoExcludePath, signal);
    await appendExternalIgnoreInput(ignoreInputs, "git-core-excludes-file", coreExcludesPath, signal);
    const [trackedResult, ignoredResult] = await Promise.all([
        git.run(["ls-files", "--cached", "-z"], {
            cwd: root,
            timeoutMs: ScopeGitTimeoutMs,
            signal,
        }),
        git.run(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
            cwd: root,
            timeoutMs: ScopeGitTimeoutMs,
            signal,
        }),
    ]);
    const trackedPaths = splitNul(trackedResult.stdout);
    const ignoredPaths = splitNul(ignoredResult.stdout);
    return {
        tracked: new Set(trackedPaths.map(pathKey)),
        ignored: new Set(ignoredPaths.map((path) => pathKey(trimDirectorySuffix(path)))),
        ignoredDirectories: ignoredPaths.filter((path) => path.at(-1) === 0x2f).map(trimDirectorySuffix),
        ignoreInputs,
        trackedHash: hashContent(trackedResult.stdout),
        ignoredHash: hashContent(ignoredResult.stdout),
        indexPath,
        indexVersion,
        infoExcludePath,
        coreExcludesPath,
    };
}

async function verifyGitWorkspaceScope(input: WorkspaceScopeInput, attempt: WorkspaceScopeAttempt): Promise<boolean> {
    assertScopeActive(input.signal);
    const classification = attempt.git!;
    const [trackedResult, ignoredResult, indexPath, infoExcludePath, coreExcludesPath] = await Promise.all([
        input.git.run(["ls-files", "--cached", "-z"], {
            cwd: input.identity.canonicalRoot,
            timeoutMs: ScopeGitTimeoutMs,
            signal: input.signal,
        }),
        input.git.run(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
            cwd: input.identity.canonicalRoot,
            timeoutMs: ScopeGitTimeoutMs,
            signal: input.signal,
        }),
        resolveGitPath(
            input.git,
            input.identity.canonicalRoot,
            ["rev-parse", "--path-format=absolute", "--git-path", "index"],
            input.signal
        ),
        resolveGitPath(
            input.git,
            input.identity.canonicalRoot,
            ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
            input.signal
        ),
        resolveOptionalCoreExcludesPath(input.git, input.identity.canonicalRoot, input.signal),
    ]);
    if (
        hashContent(trackedResult.stdout) !== classification.trackedHash ||
        hashContent(ignoredResult.stdout) !== classification.ignoredHash ||
        !indexPath.equals(classification.indexPath) ||
        !infoExcludePath.equals(classification.infoExcludePath) ||
        !optionalBufferEquals(coreExcludesPath, classification.coreExcludesPath)
    ) {
        return false;
    }
    assertScopeActive(input.signal);
    if (!sameFileVersion(classification.indexVersion, await readOptionalFileVersion(classification.indexPath))) {
        return false;
    }
    return true;
}

export async function verifyWorkspaceScopeDirectories(
    scope: Pick<WorkspaceScope, "root" | "directories">,
    signal?: AbortSignal
): Promise<boolean> {
    const rootBytes = Buffer.from(scope.root);
    for (const snapshot of scope.directories) {
        assertScopeActive(signal);
        const path = absolutePath(rootBytes, snapshot.pathBytes);
        let identity: DirectoryIdentity;
        try {
            identity = await readDirectoryIdentity(path);
        } catch {
            return false;
        }
        try {
            assertSameDirectory(directoryEvidenceIdentity(snapshot), identity);
        } catch {
            return false;
        }
        const entries = await readBoundedDirectory(path, snapshot.entryCount + 1, signal);
        let identityAfter: DirectoryIdentity;
        try {
            identityAfter = await readDirectoryIdentity(path);
            assertSameDirectory(directoryEvidenceIdentity(snapshot), identityAfter);
        } catch {
            return false;
        }
        if (entries.length !== snapshot.entryCount) {
            return false;
        }
        entries.sort((left, right) => Buffer.compare(left.name, right.name));
        if (hashDirectoryNames(entries) !== snapshot.namesHash) {
            return false;
        }
    }
    return true;
}

async function enumerateDirectory(
    state: DiscoveryState,
    directoryPathBytes: Buffer,
    inheritedMatchers: IgnoreMatcher[]
): Promise<void> {
    assertScopeActive(state.signal);
    const absoluteDirectory = absolutePath(state.rootBytes, directoryPathBytes);
    const before = await readDirectoryIdentity(absoluteDirectory);
    const entryStart = state.entries.length;
    const exclusionStart = state.exclusions.length;
    const ignoreInputStart = state.ignoreInputs.length;
    const boundaryStart = state.nestedRepositoryBoundaries.length;
    const directorySnapshotStart = state.directorySnapshots.length;
    const eligibleStart = state.eligibleEntryCount;
    const scannedStart = state.scannedEntryCount;
    try {
        const matchers = await loadDirectoryIgnoreMatcher(state, directoryPathBytes, inheritedMatchers);
        assertSameDirectory(before, await readDirectoryIdentity(absoluteDirectory));
        const remainingBudget = Math.max(0, state.maxEntries - state.scannedEntryCount);
        const children = await readBoundedDirectory(absoluteDirectory, remainingBudget + 1, state.signal);
        if (children.length > remainingBudget) {
            throw new WorkspaceBudgetExceeded();
        }
        children.sort((left, right) => Buffer.compare(left.name, right.name));

        for (const child of children) {
            assertScopeActive(state.signal);
            const pathBytes = appendPath(directoryPathBytes, child.name);
            if (state.scannedEntryCount >= state.maxEntries) {
                throw new WorkspaceBudgetExceeded();
            }
            state.scannedEntryCount += 1;
            assertSameDirectory(before, await readDirectoryIdentity(absoluteDirectory));
            const absoluteChild = absolutePath(state.rootBytes, pathBytes);
            const metadata = await lstat(absoluteChild, { bigint: true });
            const tracked = state.git?.tracked.has(pathKey(pathBytes)) ?? false;
            const path = decodePath(pathBytes);
            if (path == null) {
                addExclusion(state, pathBytes, undefined, tracked, "non-utf8-path");
                continue;
            }

            if (isRepositoryBoundary(state, pathBytes, child.name, metadata.isDirectory())) {
                state.nestedRepositoryBoundaries.push(manifestPath(pathBytes));
                addExclusion(state, pathBytes, path, tracked, "nested-repository");
                continue;
            }
            if (isIgnored(state, pathBytes, metadata.isDirectory(), matchers)) {
                addExclusion(state, pathBytes, path, tracked, "ignored");
                continue;
            }
            if (metadata.isDirectory()) {
                await enumerateDirectory(state, pathBytes, matchers);
                continue;
            }

            if (metadata.isSymbolicLink()) {
                addEligibleEntry(state, {
                    pathBytes,
                    path,
                    kind: "symlink",
                    tracked,
                    size: Number(metadata.size),
                    parentIdentity: directoryIdentityEvidence(before),
                    entryIdentity: entryIdentityEvidence(metadata),
                });
                continue;
            }
            if (!metadata.isFile()) {
                addExclusion(state, pathBytes, path, tracked, "special-entry");
                continue;
            }
            if (metadata.nlink > 1n) {
                addExclusion(state, pathBytes, path, tracked, "hard-linked");
                continue;
            }
            if (!tracked && metadata.size > BigInt(state.maxUntrackedBytes)) {
                addExclusion(state, pathBytes, path, false, "oversized-untracked");
                Object.assign(state.entries.at(-1)!, {
                    parentIdentity: directoryIdentityEvidence(before),
                    entryIdentity: entryIdentityEvidence(metadata),
                });
                continue;
            }
            addEligibleEntry(state, {
                pathBytes,
                path,
                kind: "file",
                tracked,
                executable: (metadata.mode & 0o111n) !== 0n,
                size: Number(metadata.size),
                parentIdentity: directoryIdentityEvidence(before),
                entryIdentity: entryIdentityEvidence(metadata),
            });
        }
        const after = await readDirectoryIdentity(absoluteDirectory);
        assertSameDirectory(before, after);
        state.directorySnapshots.push({
            pathBytes: directoryPathBytes,
            ...after,
            entryCount: children.length,
            namesHash: hashDirectoryNames(children),
        });
    } catch (error) {
        state.entries.length = entryStart;
        state.exclusions.length = exclusionStart;
        state.ignoreInputs.length = ignoreInputStart;
        state.nestedRepositoryBoundaries.length = boundaryStart;
        state.directorySnapshots.length = directorySnapshotStart;
        state.eligibleEntryCount = eligibleStart;
        state.scannedEntryCount = scannedStart;
        throw error;
    }
}

async function readBoundedDirectory(path: Buffer, limit: number, signal?: AbortSignal): Promise<Array<Dirent<Buffer>>> {
    assertScopeActive(signal);
    const directory = await opendir(path, { encoding: "buffer" as BufferEncoding });
    const entries: Array<Dirent<Buffer>> = [];
    try {
        while (entries.length < limit) {
            assertScopeActive(signal);
            const entry = await directory.read();
            if (!entry) {
                break;
            }
            if (!Buffer.isBuffer(entry.name)) {
                throw new Error("Workspace directory enumerator did not preserve raw path bytes");
            }
            entries.push(entry as unknown as Dirent<Buffer>);
        }
    } finally {
        await directory.close();
    }
    return entries;
}

async function loadDirectoryIgnoreMatcher(
    state: DiscoveryState,
    directoryPathBytes: Buffer,
    inheritedMatchers: IgnoreMatcher[]
): Promise<IgnoreMatcher[]> {
    const gitignorePathBytes = appendPath(directoryPathBytes, Buffer.from(".gitignore"));
    try {
        const rules = await readSafeIgnoreInput(absolutePath(state.rootBytes, gitignorePathBytes), state.signal);
        state.ignoreInputs.push({
            source: "gitignore",
            ...manifestPath(gitignorePathBytes),
            contentHash: hashContent(rules),
        });
        if (state.git) {
            return inheritedMatchers;
        }
        return [
            ...inheritedMatchers,
            {
                basePathBytes: directoryPathBytes,
                matcher: ignore().add(rules.toString("utf8")),
            },
        ];
    } catch (error) {
        if (isMissing(error)) {
            return inheritedMatchers;
        }
        throw error;
    }
}

async function readSafeIgnoreInput(path: Buffer, signal?: AbortSignal): Promise<Buffer> {
    assertScopeActive(signal);
    const before = await lstat(path, { bigint: true });
    if (!isSafeIgnoreInputStat(before)) {
        throw new Error(`unsafe .gitignore input: ${displayPath(path)}`);
    }

    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let content: Buffer;
    try {
        const opened = await handle.stat({ bigint: true });
        if (!isSafeIgnoreInputStat(opened) || !sameIgnoreFileVersion(before, opened)) {
            throw new Error(`unstable .gitignore input: ${displayPath(path)}`);
        }
        content = Buffer.alloc(Number(opened.size));
        let offset = 0;
        while (offset < content.length) {
            assertScopeActive(signal);
            const result = await handle.read(content, offset, content.length - offset, offset);
            if (result.bytesRead === 0) {
                throw new Error(`unstable .gitignore input: ${displayPath(path)}`);
            }
            offset += result.bytesRead;
        }
        const overflow = await handle.read(Buffer.alloc(1), 0, 1, content.length);
        assertScopeActive(signal);
        const openedAfter = await handle.stat({ bigint: true });
        if (overflow.bytesRead !== 0 || !sameIgnoreFileVersion(opened, openedAfter)) {
            throw new Error(`unstable .gitignore input: ${displayPath(path)}`);
        }
    } finally {
        await handle.close();
    }

    const after = await lstat(path, { bigint: true });
    if (!sameIgnoreFileVersion(before, after)) {
        throw new Error(`unstable .gitignore input: ${displayPath(path)}`);
    }
    return content;
}

function isSafeIgnoreInputStat(value: BigIntStats): boolean {
    return value.isFile() && value.nlink === 1n && value.size <= BigInt(IgnoreInputMaxBytes);
}

function sameIgnoreFileVersion(left: BigIntStats, right: BigIntStats): boolean {
    return (
        right.isFile() &&
        right.dev === left.dev &&
        right.ino === left.ino &&
        right.nlink === left.nlink &&
        right.size === left.size &&
        right.mtimeNs === left.mtimeNs &&
        right.ctimeNs === left.ctimeNs
    );
}

async function readOptionalFileVersion(path: Buffer): Promise<FileVersion> {
    try {
        const value = await lstat(path, { bigint: true });
        if (!value.isFile()) {
            throw new Error(`Git index is not a regular file: ${displayPath(path)}`);
        }
        return {
            exists: true,
            dev: value.dev,
            ino: value.ino,
            size: value.size,
            mtimeNs: value.mtimeNs,
            ctimeNs: value.ctimeNs,
        };
    } catch (error) {
        if (isMissing(error)) {
            return { exists: false };
        }
        throw error;
    }
}

function sameFileVersion(left: FileVersion, right: FileVersion): boolean {
    return (
        left.exists === right.exists &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    );
}

async function verifyIgnoreInputs(
    rootBytes: Buffer,
    inputs: WorkspaceScopeIgnoreInput[],
    signal?: AbortSignal
): Promise<boolean> {
    for (const input of inputs) {
        assertScopeActive(signal);
        const locator = manifestLocatorBytes(input);
        const path = input.source === "gitignore" ? absolutePath(rootBytes, locator) : platformPath(locator);
        try {
            const content = await readSafeIgnoreInput(path, signal);
            if (hashContent(content) !== input.contentHash) {
                return false;
            }
        } catch (error) {
            if (isMissing(error)) {
                return false;
            }
            throw error;
        }
    }
    return true;
}

async function verifyExternalIgnoreInput(
    inputs: WorkspaceScopeIgnoreInput[],
    source: "git-info-exclude" | "git-core-excludes-file",
    path: Buffer | undefined,
    signal?: AbortSignal
): Promise<boolean> {
    assertScopeActive(signal);
    const expected = inputs.find(
        (input) => input.source === source && path != null && manifestLocatorBytes(input).equals(path)
    );
    if (!path) {
        return expected == null;
    }
    try {
        const content = await readSafeIgnoreInput(path, signal);
        return expected?.contentHash === hashContent(content);
    } catch (error) {
        if (isMissing(error)) {
            return expected == null;
        }
        throw error;
    }
}

function optionalBufferEquals(left: Buffer | undefined, right: Buffer | undefined): boolean {
    if (!left || !right) {
        return left == null && right == null;
    }
    return left.equals(right);
}

function assertScopeActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new WorkspaceGitRunnerError("aborted", "Workspace scope discovery aborted");
    }
}

function manifestLocatorBytes(value: WorkspaceScopeManifestPath): Buffer {
    if (value.pathBytesBase64 != null) {
        return Buffer.from(value.pathBytesBase64, "base64");
    }
    return Buffer.from(value.path!);
}

async function readDirectoryIdentity(path: Buffer): Promise<DirectoryIdentity> {
    const value = await lstat(path, { bigint: true });
    if (!value.isDirectory()) {
        throw new Error(`Workspace directory changed during scope discovery: ${displayPath(path)}`);
    }
    return {
        dev: value.dev,
        ino: value.ino,
        birthtimeNs: value.birthtimeNs,
        mtimeNs: value.mtimeNs,
        ctimeNs: value.ctimeNs,
    };
}

function assertSameDirectory(expected: DirectoryIdentity, actual: DirectoryIdentity): void {
    if (
        expected.dev !== actual.dev ||
        expected.ino !== actual.ino ||
        expected.birthtimeNs !== actual.birthtimeNs ||
        expected.mtimeNs !== actual.mtimeNs ||
        expected.ctimeNs !== actual.ctimeNs
    ) {
        throw new Error("Workspace directory changed during scope discovery");
    }
}

function directoryEvidenceIdentity(value: WorkspaceScopeDirectoryEvidence): DirectoryIdentity {
    return {
        dev: value.dev,
        ino: value.ino,
        birthtimeNs: value.birthtimeNs,
        mtimeNs: value.mtimeNs,
        ctimeNs: value.ctimeNs,
    };
}

function directoryIdentityEvidence(value: DirectoryIdentity): WorkspaceScopeDirectoryIdentity {
    return {
        dev: value.dev,
        ino: value.ino,
        birthtimeNs: value.birthtimeNs,
    };
}

function entryIdentityEvidence(value: BigIntStats): WorkspaceScopeEntryIdentity {
    return {
        dev: value.dev,
        ino: value.ino,
        birthtimeNs: value.birthtimeNs,
        mode: value.mode,
        nlink: value.nlink,
        size: value.size,
        mtimeNs: value.mtimeNs,
        ctimeNs: value.ctimeNs,
    };
}

function hashDirectoryNames(entries: Array<Dirent<Buffer>>): string {
    const hash = createHash("sha256");
    for (const entry of entries) {
        hash.update(entry.name);
        hash.update(Buffer.from([0]));
    }
    return hash.digest("hex");
}

function displayPath(path: Buffer): string {
    return decodePath(path) ?? path.toString("base64");
}

async function resolveGitPath(
    git: WorkspaceGitRunner,
    root: string,
    args: readonly string[],
    signal?: AbortSignal
): Promise<Buffer> {
    const result = await git.run(args, {
        cwd: root,
        timeoutMs: ScopeGitTimeoutMs,
        signal,
    });
    return stripLineEnding(result.stdout);
}

async function resolveOptionalCoreExcludesPath(
    git: WorkspaceGitRunner,
    root: string,
    signal?: AbortSignal
): Promise<Buffer | undefined> {
    try {
        const result = await git.run(["config", "--path", "--null", "--get", "core.excludesFile"], {
            cwd: root,
            timeoutMs: ScopeGitTimeoutMs,
            signal,
        });
        const value = stripNul(result.stdout);
        if (value.length === 0) {
            return undefined;
        }
        return resolveExternalPath(root, value);
    } catch (error) {
        if (error instanceof WorkspaceGitRunnerError && error.code === "nonzero_exit") {
            return undefined;
        }
        throw error;
    }
}

async function appendExternalIgnoreInput(
    inputs: WorkspaceScopeIgnoreInput[],
    source: "git-info-exclude" | "git-core-excludes-file",
    path: Buffer | undefined,
    signal?: AbortSignal
): Promise<void> {
    assertScopeActive(signal);
    if (!path) {
        return;
    }
    try {
        const content = await readSafeIgnoreInput(path, signal);
        inputs.push({
            source,
            ...manifestPath(path),
            contentHash: hashContent(content),
        });
    } catch (error) {
        if (isMissing(error)) {
            return;
        }
        throw error;
    }
}

function resolveExternalPath(root: string, pathBytes: Buffer): Buffer {
    const path = decodePath(pathBytes);
    if (path != null) {
        return Buffer.from(isAbsolute(path) ? path : resolve(root, path));
    }
    if (sep === "/" && pathBytes.at(0) === 0x2f) {
        return pathBytes;
    }
    return Buffer.concat([Buffer.from(root), Buffer.from(sep), platformPath(pathBytes)]);
}

function isRepositoryBoundary(state: DiscoveryState, pathBytes: Buffer, name: Buffer, directory: boolean): boolean {
    if (name.equals(Buffer.from(".git"))) {
        return true;
    }
    if (!directory || pathBytes.length === 0) {
        return false;
    }
    try {
        const gitMarker = absolutePath(state.rootBytes, appendPath(pathBytes, Buffer.from(".git")));
        return lstatSync(gitMarker) != null;
    } catch (error) {
        if (isMissing(error)) {
            return false;
        }
        throw error;
    }
}

function isIgnored(state: DiscoveryState, pathBytes: Buffer, directory: boolean, matchers: IgnoreMatcher[]): boolean {
    if (state.git) {
        if (state.git.ignored.has(pathKey(pathBytes))) {
            return true;
        }
        return state.git.ignoredDirectories.some((directoryBytes) => pathBytes.equals(directoryBytes));
    }
    let ignored = false;
    for (const item of matchers) {
        const relativeBytes = relativeTo(item.basePathBytes, pathBytes);
        const relative = decodePath(relativeBytes);
        if (relative == null) {
            continue;
        }
        const result = item.matcher.test(`${relative}${directory ? "/" : ""}`);
        if (result.ignored) {
            ignored = true;
        }
        if (result.unignored) {
            ignored = false;
        }
    }
    return ignored;
}

function addEligibleEntry(state: DiscoveryState, entry: WorkspaceScopeEntry): void {
    state.eligibleEntryCount += 1;
    state.entries.push(entry);
}

function addExclusion(
    state: DiscoveryState,
    pathBytes: Buffer,
    path: string | undefined,
    tracked: boolean,
    reason: WorkspaceCoverageReason
): void {
    state.entries.push({
        pathBytes,
        path,
        kind: "excluded",
        tracked,
        exclusionReason: reason,
    });
    state.exclusions.push(path == null ? { pathBytesBase64: pathBytes.toString("base64"), reason } : { path, reason });
}

function absolutePath(rootBytes: Buffer, relativeBytes: Buffer): Buffer {
    if (relativeBytes.length === 0) {
        return rootBytes;
    }
    return Buffer.concat([rootBytes, Buffer.from(sep), platformPath(relativeBytes)]);
}

function platformPath(pathBytes: Buffer): Buffer {
    if (sep === "/") {
        return pathBytes;
    }
    const result = Buffer.from(pathBytes);
    for (let index = 0; index < result.length; index++) {
        if (result[index] === 0x2f) {
            result[index] = sep.charCodeAt(0);
        }
    }
    return result;
}

function appendPath(parent: Buffer, name: Buffer): Buffer {
    if (parent.length === 0) {
        return Buffer.from(name);
    }
    return Buffer.concat([parent, Buffer.from("/"), name]);
}

function relativeTo(parent: Buffer, child: Buffer): Buffer {
    if (parent.length === 0) {
        return child;
    }
    return child.subarray(parent.length + 1);
}

function decodePath(pathBytes: Buffer): string | undefined {
    try {
        return Utf8Decoder.decode(pathBytes);
    } catch {
        return undefined;
    }
}

function manifestPath(pathBytes: Buffer): WorkspaceScopeManifestPath {
    const path = decodePath(pathBytes);
    if (path == null) {
        return { pathBytesBase64: pathBytes.toString("base64") };
    }
    return { path };
}

function pathKey(pathBytes: Buffer): string {
    return pathBytes.toString("base64");
}

function splitNul(value: Buffer): Buffer[] {
    const result: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0) {
            continue;
        }
        result.push(value.subarray(start, index));
        start = index + 1;
    }
    if (start < value.length) {
        result.push(value.subarray(start));
    }
    return result.filter((item) => item.length > 0);
}

function trimDirectorySuffix(pathBytes: Buffer): Buffer {
    if (pathBytes.at(-1) !== 0x2f) {
        return pathBytes;
    }
    return pathBytes.subarray(0, -1);
}

function stripLineEnding(value: Buffer): Buffer {
    if (value.at(-1) === 0x0a) {
        return value.subarray(0, -1);
    }
    return value;
}

function stripNul(value: Buffer): Buffer {
    if (value.at(-1) === 0) {
        return value.subarray(0, -1);
    }
    return value;
}

function hashContent(value: Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function validateLimits(maxEntries: number, maxUntrackedBytes: number): void {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
        throw new Error("maxEntries must be a nonnegative safe integer");
    }
    if (!Number.isSafeInteger(maxUntrackedBytes) || maxUntrackedBytes < 0) {
        throw new Error("maxUntrackedBytes must be a nonnegative safe integer");
    }
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
