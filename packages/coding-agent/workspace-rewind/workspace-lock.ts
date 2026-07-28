// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { encodeDurableJson } from "./durability";
import { readProcessStartToken, type ProcessOwnerIdentity } from "./process-owner";

interface WorkspaceLockOwnerV1 {
    schemaversion: 1;
    workspaceidentity: string;
    workspaceincarnation: string;
    pid: number;
    processstarttoken: string;
    nonce: string;
    acquiredat: string;
}

interface WorkspaceMutationLockOptions {
    workspaceRoot: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    processOwner: ProcessOwnerIdentity;
    retryDelayMs?: number;
}

interface LockContext {
    workspaces: Map<string, { identity: string; token: symbol }>;
}

interface PathIdentity {
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
}

interface DirectoryAnchor {
    handle: FileHandle;
    identity: PathIdentity;
}

const LockContextStorage = new AsyncLocalStorage<LockContext>();
const InProcessTails = new Map<string, Promise<void>>();
const ActiveWorkspaceLockTokens = new Set<symbol>();
const InProcessReleaseFailures = new Map<string, unknown>();
const InProcessIntegrityFailures = new Map<string, unknown>();

export class WorkspaceMutationLock {
    readonly lockPath: string;
    readonly workspaceRoot: string;
    readonly ownerPath: string;
    readonly reclaimDatabasePath: string;
    readonly workspaceIdentity: string;
    readonly workspaceIncarnation: string;
    readonly processOwner: ProcessOwnerIdentity;
    readonly retryDelayMs: number;
    heldWaiters = new Set<() => void>();
    activeDirectoryAnchor?: DirectoryAnchor;
    ownerIdentityByNonce = new Map<string, PathIdentity>();
    lastInspectedOwnerIdentity?: PathIdentity;

    constructor(options: WorkspaceMutationLockOptions) {
        if (
            !isAbsolute(options.workspaceRoot) ||
            !/^[0-9a-f]{64}$/.test(options.workspaceIdentity) ||
            !/^[0-9a-f]{64}$/.test(options.workspaceIncarnation)
        ) {
            throw new Error("Invalid workspace mutation lock identity");
        }
        if (
            !Number.isSafeInteger(options.processOwner.pid) ||
            options.processOwner.pid <= 0 ||
            !options.processOwner.processStartToken ||
            !/^[0-9a-f]{64}$/.test(options.processOwner.nonce)
        ) {
            throw new Error("Invalid workspace mutation lock process owner");
        }
        this.workspaceRoot = options.workspaceRoot;
        this.lockPath = join(options.workspaceRoot, "lock");
        this.ownerPath = join(this.lockPath, "owner.json");
        this.reclaimDatabasePath = join(this.lockPath, "reclaim.sqlite");
        this.workspaceIdentity = options.workspaceIdentity;
        this.workspaceIncarnation = options.workspaceIncarnation;
        this.processOwner = options.processOwner;
        this.retryDelayMs = options.retryDelayMs ?? 25;
    }

    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        this.assertSupportedPlatform();
        const context = LockContextStorage.getStore();
        const inherited = context?.workspaces.get(this.lockPath);
        const identity = `${this.workspaceIdentity}:${this.workspaceIncarnation}`;
        if (inherited && ActiveWorkspaceLockTokens.has(inherited.token)) {
            if (inherited.identity !== identity) {
                throw new Error("Workspace lock identity changed during reentrant acquisition");
            }
            return operation();
        }
        const previous = InProcessTails.get(this.lockPath) ?? Promise.resolve();
        let releaseTurn!: () => void;
        const turn = new Promise<void>((resolve) => {
            releaseTurn = resolve;
        });
        InProcessTails.set(this.lockPath, turn);
        await previous;
        let owner: WorkspaceLockOwnerV1 | undefined;
        const activeToken = Symbol(this.lockPath);
        let result: T;
        let operationError: unknown;
        let operationFailed = false;
        try {
            const integrityFailure = InProcessIntegrityFailures.get(this.lockPath);
            if (integrityFailure) {
                throw new Error("Workspace lock path is poisoned", { cause: integrityFailure });
            }
            const previousReleaseFailure = InProcessReleaseFailures.get(this.lockPath);
            if (previousReleaseFailure) {
                throw new Error("Previous workspace lock release failed", {
                    cause: previousReleaseFailure,
                });
            }
            this.activeDirectoryAnchor = await this.openDirectoryAnchor();
            owner = await this.acquire();
            await this.assertDirectoryAnchor();
            const nextContext: LockContext = {
                workspaces: new Map(context?.workspaces ?? []),
            };
            nextContext.workspaces.set(this.lockPath, { identity, token: activeToken });
            ActiveWorkspaceLockTokens.add(activeToken);
            for (const waiter of this.heldWaiters) {
                waiter();
            }
            this.heldWaiters.clear();
            result = await LockContextStorage.run(nextContext, operation);
        } catch (error) {
            operationFailed = true;
            operationError = error;
        }
        ActiveWorkspaceLockTokens.delete(activeToken);
        let releaseError: unknown;
        if (owner) {
            try {
                await this.release(owner);
            } catch (error) {
                releaseError = error;
                InProcessReleaseFailures.set(this.lockPath, error);
            }
        }
        if (this.activeDirectoryAnchor) {
            try {
                await this.activeDirectoryAnchor.handle.close();
            } catch (error) {
                const integrityError = new Error("Workspace lock directory handle close failed", {
                    cause: error,
                });
                InProcessIntegrityFailures.set(this.lockPath, integrityError);
                releaseError ??= integrityError;
            }
            this.activeDirectoryAnchor = undefined;
        }
        if (InProcessTails.get(this.lockPath) === turn) {
            InProcessTails.delete(this.lockPath);
        }
        releaseTurn();
        if (releaseError) {
            if (operationFailed) {
                throw new AggregateError([operationError, releaseError], "Workspace lock operation and release failed");
            }
            throw releaseError;
        }
        if (operationFailed) {
            throw operationError;
        }
        return result!;
    }

    async waitUntilHeldForTest(): Promise<void> {
        try {
            await readFile(this.ownerPath);
            return;
        } catch (error) {
            if (!isCode(error, "ENOENT")) {
                throw error;
            }
        }
        await new Promise<void>((resolve) => {
            this.heldWaiters.add(resolve);
        });
    }

    async acquire(): Promise<WorkspaceLockOwnerV1> {
        await this.assertDirectoryAnchor();
        while (true) {
            const record = this.makeOwner();
            try {
                await this.writeOwner(record);
                return record;
            } catch (error) {
                if (!isCode(error, "EEXIST")) {
                    throw error;
                }
            }
            const state = await this.inspectExistingOwner();
            if (state === "unknown") {
                throw new Error("Workspace lock owner liveness is unknown");
            }
            if (state === "stale") {
                const reclaimed = await this.reclaimInTransaction(record);
                if (reclaimed) {
                    return reclaimed;
                }
                continue;
            }
            if (state === "absent") {
                continue;
            }
            await delay(this.retryDelayMs);
        }
    }

    makeOwner(): WorkspaceLockOwnerV1 {
        return {
            schemaversion: 1,
            workspaceidentity: this.workspaceIdentity,
            workspaceincarnation: this.workspaceIncarnation,
            pid: this.processOwner.pid,
            processstarttoken: this.processOwner.processStartToken,
            nonce: randomBytes(32).toString("hex"),
            acquiredat: new Date().toISOString(),
        };
    }

    async writeOwner(record: WorkspaceLockOwnerV1): Promise<void> {
        const identity = await this.writeOwnerAt(this.ownerPath, record);
        this.ownerIdentityByNonce.set(record.nonce, identity);
    }

    async writeOwnerAt(path: string, record: WorkspaceLockOwnerV1): Promise<PathIdentity> {
        await this.assertDirectoryAnchor();
        const handle = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | this.noFollowFlag(),
            0o600
        );
        let identity: PathIdentity | undefined;
        try {
            const stats = await handle.stat({ bigint: true });
            this.assertPrivateRegularFile(stats, "workspace lock owner");
            identity = identityOf(stats);
            await handle.writeFile(encodeDurableJson(record));
            await handle.chmod(0o600);
            await handle.sync();
            await this.assertPathIdentity(path, identity);
            await this.assertDirectoryAnchor();
        } catch (error) {
            if (identity) {
                await this.unlinkIfSame(path, identity).catch(() => undefined);
            }
            throw error;
        } finally {
            await handle.close().catch(() => undefined);
        }
        await this.syncLockDirectory();
        return identity!;
    }

    async inspectExistingOwner(): Promise<"live" | "stale" | "unknown" | "absent"> {
        return this.inspectOwner(this.ownerPath);
    }

    async inspectOwner(path: string): Promise<"live" | "stale" | "unknown" | "absent"> {
        let opened: { bytes: Buffer; identity: PathIdentity };
        try {
            opened = await this.readPrivateFile(path, "workspace lock owner");
        } catch (error) {
            if (isCode(error, "ENOENT") || error instanceof WorkspaceLockPathAbsentError) {
                this.lastInspectedOwnerIdentity = undefined;
                return "absent";
            }
            this.poison("Unsafe workspace lock owner record", error);
        }
        this.lastInspectedOwnerIdentity = opened!.identity;
        const publicationIdentity = opened!.identity;
        const publicationDeadline = Date.now() + 500;
        let bytes = opened!.bytes;
        let owner: WorkspaceLockOwnerV1 | undefined;
        while (!owner) {
            try {
                owner = decodeOwner(bytes);
            } catch {
                if (Date.now() >= publicationDeadline) {
                    return "unknown";
                }
                await delay(Math.max(this.retryDelayMs, 10));
                try {
                    const retried = await this.readPrivateFile(path, "workspace lock owner");
                    if (!sameIdentity(retried.identity, publicationIdentity)) {
                        this.poison("Workspace lock owner changed during publication");
                    }
                    bytes = retried.bytes;
                } catch (error) {
                    if (error instanceof WorkspaceLockPathAbsentError || isCode(error, "ENOENT")) {
                        return "absent";
                    }
                    if (error instanceof WorkspaceLockIntegrityError) {
                        throw error;
                    }
                    return "unknown";
                }
            }
        }
        if (
            owner.workspaceidentity !== this.workspaceIdentity ||
            owner.workspaceincarnation !== this.workspaceIncarnation
        ) {
            return "unknown";
        }
        try {
            process.kill(owner.pid, 0);
        } catch (error) {
            return isCode(error, "ESRCH") ? "stale" : "unknown";
        }
        try {
            const currentToken = await readProcessStartToken(owner.pid);
            if (!(await this.ownerPathStillPresent(path, publicationIdentity))) {
                return "absent";
            }
            await this.assertDirectoryAnchor();
            return currentToken === owner.processstarttoken ? "live" : "stale";
        } catch (error) {
            if (error instanceof WorkspaceLockIntegrityError) {
                throw error;
            }
            return this.reclassifyOwnerAfterLivenessRace(path, publicationIdentity, owner.pid);
        }
    }

    async ownerPathStillPresent(path: string, expected: PathIdentity): Promise<boolean> {
        let stats: BigIntStats;
        try {
            stats = await lstat(path, { bigint: true });
        } catch (error) {
            if (isCode(error, "ENOENT")) {
                return false;
            }
            this.poison("Workspace lock owner identity is unavailable", error);
        }
        if (stats!.isSymbolicLink() || !sameIdentity(identityOf(stats!), expected)) {
            this.poison("Workspace lock owner identity changed");
        }
        return true;
    }

    async reclassifyOwnerAfterLivenessRace(
        path: string,
        expected: PathIdentity,
        pid: number
    ): Promise<"stale" | "unknown" | "absent"> {
        if (!(await this.ownerPathStillPresent(path, expected))) {
            return "absent";
        }
        await this.assertDirectoryAnchor();
        try {
            process.kill(pid, 0);
            return "unknown";
        } catch (error) {
            return isCode(error, "ESRCH") ? "stale" : "unknown";
        }
    }

    async reclaimInTransaction(record: WorkspaceLockOwnerV1): Promise<WorkspaceLockOwnerV1 | undefined> {
        const databaseFile = await this.prepareReclaimDatabase();
        const { DatabaseSync } = await import("node:sqlite");
        await this.assertOpenPrivateFile(
            databaseFile.handle,
            this.reclaimDatabasePath,
            databaseFile.identity,
            "workspace reclaim database"
        );
        await this.assertDirectoryAnchor();
        let database: import("node:sqlite").DatabaseSync;
        try {
            database = new DatabaseSync(this.reclaimDatabasePath);
        } catch (error) {
            await databaseFile.handle.close();
            this.poison("Unable to open workspace reclaim transaction", error);
        }
        await this.assertOpenPrivateFile(
            databaseFile.handle,
            this.reclaimDatabasePath,
            databaseFile.identity,
            "workspace reclaim database"
        );
        await this.validateSqliteSidecars();
        let transactionStarted = false;
        let result: WorkspaceLockOwnerV1 | undefined;
        let failure: unknown;
        try {
            database.exec("PRAGMA busy_timeout = 30000");
            database.exec("BEGIN IMMEDIATE");
            transactionStarted = true;
            await this.assertOpenPrivateFile(
                databaseFile.handle,
                this.reclaimDatabasePath,
                databaseFile.identity,
                "workspace reclaim database"
            );
            await this.validateSqliteSidecars();
            const state = await this.inspectOwner(this.ownerPath);
            if (state === "unknown") {
                throw new Error("Workspace lock owner liveness is unknown");
            }
            if (state === "stale") {
                result = await this.replaceStaleOwner(record);
            }
            await this.assertOpenPrivateFile(
                databaseFile.handle,
                this.reclaimDatabasePath,
                databaseFile.identity,
                "workspace reclaim database"
            );
            await this.validateSqliteSidecars();
        } catch (error) {
            failure = error;
        }
        if (transactionStarted) {
            try {
                database.exec("ROLLBACK");
            } catch (error) {
                failure ??= error;
            }
        }
        try {
            database!.close();
        } catch (error) {
            failure ??= error;
        }
        try {
            await this.assertOpenPrivateFile(
                databaseFile.handle,
                this.reclaimDatabasePath,
                databaseFile.identity,
                "workspace reclaim database"
            );
            await this.validateSqliteSidecars();
        } catch (error) {
            failure ??= error;
        }
        await databaseFile.handle.close().catch((error) => {
            failure ??= error;
        });
        if (failure) {
            throw failure;
        }
        return result;
    }

    async replaceStaleOwner(record: WorkspaceLockOwnerV1): Promise<WorkspaceLockOwnerV1> {
        const staleIdentity = this.lastInspectedOwnerIdentity;
        if (!staleIdentity) {
            this.poison("Workspace stale owner identity is unavailable");
        }
        const candidate = join(this.lockPath, `.owner-${process.pid}-${randomBytes(12).toString("hex")}`);
        const candidateIdentity = await this.writeOwnerAt(candidate, record);
        try {
            await this.assertPathIdentity(this.ownerPath, staleIdentity!);
            await this.assertPathIdentity(candidate, candidateIdentity);
            await this.assertDirectoryAnchor();
            await rename(candidate, this.ownerPath);
            await this.assertPathIdentity(this.ownerPath, candidateIdentity);
            await this.syncLockDirectory();
            this.ownerIdentityByNonce.set(record.nonce, candidateIdentity);
            return record;
        } finally {
            await this.unlinkIfSame(candidate, candidateIdentity).catch(() => undefined);
        }
    }

    async prepareReclaimDatabase(): Promise<{ handle: FileHandle; identity: PathIdentity }> {
        await this.assertDirectoryAnchor();
        let handle: FileHandle;
        let created = false;
        try {
            handle = await open(
                this.reclaimDatabasePath,
                constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | this.noFollowFlag(),
                0o600
            );
            created = true;
        } catch (error) {
            if (!isCode(error, "EEXIST")) {
                this.poison("Unable to create workspace reclaim database", error);
            }
            try {
                handle = await open(this.reclaimDatabasePath, constants.O_RDWR | this.noFollowFlag());
            } catch (openError) {
                this.poison("Unsafe workspace reclaim database", openError);
            }
        }
        try {
            let stats = await handle!.stat({ bigint: true });
            this.assertPrivateRegularFile(stats, "workspace reclaim database", created);
            const identity = identityOf(stats);
            await this.assertPathIdentity(this.reclaimDatabasePath, identity);
            if (created) {
                await handle!.chmod(0o600);
                stats = await handle!.stat({ bigint: true });
                this.assertPrivateRegularFile(stats, "workspace reclaim database");
            }
            await handle.sync();
            await this.assertOpenPrivateFile(handle, this.reclaimDatabasePath, identity, "workspace reclaim database");
            await this.syncLockDirectory();
            return { handle: handle!, identity };
        } catch (error) {
            await handle!.close().catch(() => undefined);
            this.poison("Unsafe workspace reclaim database", error);
        }
    }

    async release(owner: WorkspaceLockOwnerV1): Promise<void> {
        const expectedIdentity = this.ownerIdentityByNonce.get(owner.nonce);
        if (!expectedIdentity) {
            this.poison("Workspace lock owner identity is unavailable");
        }
        let current: WorkspaceLockOwnerV1;
        try {
            const opened = await this.readPrivateFile(this.ownerPath, "workspace lock owner");
            if (!sameIdentity(opened.identity, expectedIdentity!)) {
                this.poison("Workspace lock owner was replaced");
            }
            current = decodeOwner(opened.bytes);
        } catch {
            throw new Error("Workspace lock ownership was lost");
        }
        if (current.nonce !== owner.nonce) {
            throw new Error("Workspace lock ownership was replaced");
        }
        await this.assertPathIdentity(this.ownerPath, expectedIdentity!);
        await this.assertDirectoryAnchor();
        await unlink(this.ownerPath);
        await this.syncLockDirectory();
        this.ownerIdentityByNonce.delete(owner.nonce);
    }

    async openDirectoryAnchor(): Promise<DirectoryAnchor> {
        let created = false;
        try {
            await mkdir(this.lockPath, { mode: 0o700 });
            created = true;
        } catch (error) {
            if (!isCode(error, "EEXIST")) {
                this.poison("Unable to create workspace lock directory", error);
            }
        }
        let pathStats: BigIntStats;
        try {
            pathStats = await lstat(this.lockPath, { bigint: true });
        } catch (error) {
            this.poison("Unable to inspect workspace lock directory", error);
        }
        if (!pathStats!.isDirectory() || pathStats!.isSymbolicLink()) {
            this.poison("Unsafe workspace lock directory");
        }
        let handle: FileHandle;
        try {
            handle = await open(this.lockPath, constants.O_RDONLY | this.directoryFlag() | this.noFollowFlag());
        } catch (error) {
            this.poison("Unable to anchor workspace lock directory", error);
        }
        try {
            let handleStats = await handle!.stat({ bigint: true });
            if (!handleStats.isDirectory() || !sameIdentity(identityOf(handleStats), identityOf(pathStats!))) {
                this.poison("Workspace lock directory identity changed");
            }
            if (created) {
                await handle!.chmod(0o700);
                handleStats = await handle!.stat({ bigint: true });
            }
            if (fileMode(handleStats) !== 0o700) {
                this.poison("Workspace lock directory is not private");
            }
            const anchor = { handle: handle!, identity: identityOf(handleStats) };
            this.activeDirectoryAnchor = anchor;
            await this.assertDirectoryAnchor();
            await this.syncLockDirectory();
            return anchor;
        } catch (error) {
            await handle!.close().catch(() => undefined);
            this.activeDirectoryAnchor = undefined;
            if (error instanceof WorkspaceLockIntegrityError) {
                throw error;
            }
            this.poison("Unsafe workspace lock directory", error);
        }
    }

    async assertDirectoryAnchor(): Promise<void> {
        const anchor = this.activeDirectoryAnchor;
        if (!anchor) {
            this.poison("Workspace lock directory is not anchored");
        }
        let handleStats: BigIntStats;
        let pathStats: BigIntStats;
        try {
            [handleStats, pathStats] = await Promise.all([
                anchor!.handle.stat({ bigint: true }),
                lstat(this.lockPath, { bigint: true }),
            ]);
        } catch (error) {
            this.poison("Workspace lock directory identity is unavailable", error);
        }
        if (
            !handleStats!.isDirectory() ||
            !pathStats!.isDirectory() ||
            pathStats!.isSymbolicLink() ||
            fileMode(handleStats!) !== 0o700 ||
            !sameIdentity(identityOf(handleStats!), anchor!.identity) ||
            !sameIdentity(identityOf(pathStats!), anchor!.identity)
        ) {
            this.poison("Workspace lock directory identity changed");
        }
    }

    async readPrivateFile(path: string, label: string): Promise<{ bytes: Buffer; identity: PathIdentity }> {
        await this.assertDirectoryAnchor();
        const handle = await open(path, constants.O_RDONLY | this.noFollowFlag());
        try {
            const stats = await handle.stat({ bigint: true });
            if (stats.isFile() && stats.nlink === 0n) {
                try {
                    await lstat(path);
                } catch (error) {
                    if (isCode(error, "ENOENT")) {
                        throw new WorkspaceLockPathAbsentError();
                    }
                    this.poison("Workspace lock owner identity is unavailable", error);
                }
                this.poison("Workspace lock owner identity changed");
            }
            this.assertPrivateRegularFile(stats, label);
            const identity = identityOf(stats);
            await this.assertPathIdentity(path, identity);
            const bytes = await handle.readFile();
            await this.assertPathIdentity(path, identity);
            await this.assertDirectoryAnchor();
            return { bytes, identity };
        } finally {
            await handle.close();
        }
    }

    assertPrivateRegularFile(stats: BigIntStats, label: string, allowInitialMode = false): void {
        if (!stats.isFile() || stats.nlink !== 1n) {
            this.poison(`${label} is not a private regular file`);
        }
        if (!allowInitialMode && fileMode(stats) !== 0o600) {
            this.poison(`${label} has unsafe permissions`);
        }
    }

    async assertOpenPrivateFile(
        handle: FileHandle,
        path: string,
        expected: PathIdentity,
        label: string
    ): Promise<void> {
        let stats: BigIntStats;
        try {
            stats = await handle.stat({ bigint: true });
        } catch (error) {
            this.poison(`${label} descriptor identity is unavailable`, error);
        }
        this.assertPrivateRegularFile(stats!, label);
        if (!sameIdentity(identityOf(stats!), expected)) {
            this.poison(`${label} descriptor identity changed`);
        }
        await this.assertPathIdentity(path, expected);
        await this.assertDirectoryAnchor();
    }

    async assertPathIdentity(path: string, expected: PathIdentity): Promise<void> {
        let stats: BigIntStats;
        try {
            stats = await lstat(path, { bigint: true });
        } catch (error) {
            this.poison("Workspace lock path identity is unavailable", error);
        }
        if (stats!.isSymbolicLink() || !sameIdentity(identityOf(stats!), expected)) {
            this.poison("Workspace lock path identity changed");
        }
    }

    async unlinkIfSame(path: string, expected: PathIdentity): Promise<void> {
        let stats: BigIntStats;
        try {
            stats = await lstat(path, { bigint: true });
        } catch (error) {
            if (isCode(error, "ENOENT")) {
                return;
            }
            this.poison("Workspace lock path identity is unavailable", error);
        }
        if (stats!.isSymbolicLink() || !sameIdentity(identityOf(stats!), expected)) {
            this.poison("Workspace lock path identity changed");
        }
        await this.assertDirectoryAnchor();
        await unlink(path);
        await this.syncLockDirectory();
    }

    async validateSqliteSidecars(): Promise<void> {
        for (const suffix of ["-journal", "-wal", "-shm"]) {
            const path = `${this.reclaimDatabasePath}${suffix}`;
            let handle: FileHandle;
            try {
                handle = await open(path, constants.O_RDONLY | this.noFollowFlag());
            } catch (error) {
                if (isCode(error, "ENOENT")) {
                    continue;
                }
                this.poison("Unsafe workspace reclaim database sidecar", error);
            }
            try {
                const stats = await handle!.stat({ bigint: true });
                this.assertPrivateRegularFile(stats, "workspace reclaim database sidecar");
                await this.assertPathIdentity(path, identityOf(stats));
            } finally {
                await handle!.close();
            }
        }
        await this.assertDirectoryAnchor();
    }

    async syncLockDirectory(): Promise<void> {
        await this.assertDirectoryAnchor();
        try {
            await this.activeDirectoryAnchor!.handle.sync();
        } catch (error) {
            if (!isUnsupportedDirectorySync(error)) {
                this.poison("Workspace lock directory sync failed", error);
            }
        }
    }

    assertSupportedPlatform(): void {
        if (process.platform === "win32" || constants.O_NOFOLLOW == null || constants.O_DIRECTORY == null) {
            throw new Error("Workspace mutation lock requires no-follow directory descriptors");
        }
    }

    noFollowFlag(): number {
        if (constants.O_NOFOLLOW == null) {
            throw new Error("Workspace mutation lock no-follow is unavailable");
        }
        return constants.O_NOFOLLOW;
    }

    directoryFlag(): number {
        if (constants.O_DIRECTORY == null) {
            throw new Error("Workspace mutation lock directory descriptors are unavailable");
        }
        return constants.O_DIRECTORY;
    }

    poison(message: string, cause?: unknown): never {
        const error = new WorkspaceLockIntegrityError(message, cause);
        InProcessIntegrityFailures.set(this.lockPath, error);
        throw error;
    }
}

class WorkspaceLockIntegrityError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message, cause == null ? undefined : { cause });
        this.name = "WorkspaceLockIntegrityError";
    }
}

class WorkspaceLockPathAbsentError extends Error {}

export function assertWorkspaceLockNotHeld(): void {
    const context = LockContextStorage.getStore();
    if ([...(context?.workspaces.values() ?? [])].some(({ token }) => ActiveWorkspaceLockTokens.has(token))) {
        throw new Error("Lock order violation: session lease cannot be acquired while holding workspace lock");
    }
}

function decodeOwner(bytes: Buffer): WorkspaceLockOwnerV1 {
    let value: unknown;
    try {
        value = JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new Error("Invalid workspace lock owner");
    }
    if (
        !isRecord(value) ||
        Object.keys(value).sort().join(",") !==
            "acquiredat,nonce,pid,processstarttoken,schemaversion,workspaceidentity,workspaceincarnation"
    ) {
        throw new Error("Invalid workspace lock owner");
    }
    const owner = value as unknown as WorkspaceLockOwnerV1;
    if (
        owner.schemaversion !== 1 ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        !/^[0-9a-f]{64}$/.test(owner.workspaceidentity) ||
        !/^[0-9a-f]{64}$/.test(owner.workspaceincarnation) ||
        !owner.processstarttoken ||
        !/^[0-9a-f]{64}$/.test(owner.nonce) ||
        Number.isNaN(Date.parse(owner.acquiredat))
    ) {
        throw new Error("Invalid workspace lock owner");
    }
    return owner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function identityOf(stats: BigIntStats): PathIdentity {
    return {
        dev: stats.dev,
        ino: stats.ino,
        birthtimeNs: stats.birthtimeNs,
    };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function fileMode(stats: BigIntStats): number {
    return Number(stats.mode & 0o777n);
}

function isCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
    return ["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].some((code) => isCode(error, code));
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
