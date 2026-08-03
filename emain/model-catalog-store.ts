// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
    ModelCatalogCacheSchemaVersion,
    type ModelCatalogCache,
    type ModelCatalogProviderCache,
    type ModelCatalogStore,
} from "@crest/ai/model-catalog";

const LockStaleMs = 2 * 60 * 1_000;
const LockRetryMs = 20;
const LockWaitMaxMs = 60_000;

export interface FileModelCatalogStoreOptions {
    rename?: (temporaryPath: string, targetPath: string) => Promise<void>;
    uniqueSuffix?: () => string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export class FileModelCatalogStore implements ModelCatalogStore {
    private readonly rename: (temporaryPath: string, targetPath: string) => Promise<void>;
    private readonly uniqueSuffix: () => string;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(
        private readonly cachePath: string,
        options: FileModelCatalogStoreOptions = {}
    ) {
        this.rename = options.rename ?? fs.rename;
        this.uniqueSuffix = options.uniqueSuffix ?? randomUUID;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    async read(): Promise<ModelCatalogCache | undefined> {
        return this.readDocument();
    }

    async writeProvider(providerId: string, state: ModelCatalogProviderCache): Promise<void> {
        await this.ensureDirectory();
        await this.withLock(`${this.cachePath}.write.lock`, async () => {
            const current = (await this.readDocument()) ?? {
                schemaVersion: ModelCatalogCacheSchemaVersion,
                providers: {},
            };
            const next: ModelCatalogCache = {
                schemaVersion: ModelCatalogCacheSchemaVersion,
                providers: {
                    ...current.providers,
                    [providerId]: structuredClone(state),
                },
            };
            await this.atomicWrite(next);
        });
    }

    async withRefreshLock<T>(providerId: string, run: () => Promise<T>): Promise<T> {
        await this.ensureDirectory();
        const lockPath = `${this.cachePath}.refresh-${encodeURIComponent(providerId)}.lock`;
        return this.withLock(lockPath, run);
    }

    private async readDocument(): Promise<ModelCatalogCache | undefined> {
        try {
            const contents = await fs.readFile(this.cachePath, "utf8");
            let parsed: unknown;
            try {
                parsed = JSON.parse(contents);
            } catch (error) {
                if (error instanceof SyntaxError) return undefined;
                throw error;
            }
            return isCacheDocument(parsed) ? parsed : undefined;
        } catch (error) {
            if (isNodeError(error, "ENOENT")) return undefined;
            throw error;
        }
    }

    private async atomicWrite(cache: ModelCatalogCache): Promise<void> {
        const temporaryPath = `${this.cachePath}.tmp-${process.pid}-${this.uniqueSuffix()}`;
        let temporaryFile: fs.FileHandle | undefined;
        try {
            temporaryFile = await fs.open(temporaryPath, "wx", 0o600);
            await temporaryFile.writeFile(JSON.stringify(cache), "utf8");
            await temporaryFile.sync();
            await temporaryFile.close();
            temporaryFile = undefined;
            await this.rename(temporaryPath, this.cachePath);
        } catch (error) {
            await temporaryFile?.close().catch(() => undefined);
            await fs.unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }

    private async withLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
        const lockFile = await this.acquireLock(lockPath);
        try {
            return await run();
        } finally {
            await lockFile.close().catch(() => undefined);
            await fs.unlink(lockPath).catch(() => undefined);
        }
    }

    private async acquireLock(lockPath: string): Promise<fs.FileHandle> {
        const startedAt = this.now();
        for (;;) {
            try {
                const lockFile = await fs.open(lockPath, "wx", 0o600);
                try {
                    await lockFile.writeFile(String(process.pid), "utf8");
                    return lockFile;
                } catch (error) {
                    await lockFile.close().catch(() => undefined);
                    await fs.unlink(lockPath).catch(() => undefined);
                    throw error;
                }
            } catch (error) {
                if (!isNodeError(error, "EEXIST")) throw error;
                await this.removeStaleLock(lockPath);
                if (this.now() - startedAt >= LockWaitMaxMs) {
                    throw new Error(`timed out waiting for model catalog lock ${lockPath}`);
                }
                await this.sleep(LockRetryMs);
            }
        }
    }

    private async removeStaleLock(lockPath: string): Promise<void> {
        try {
            const lock = await fs.stat(lockPath);
            if (this.now() - lock.mtimeMs <= LockStaleMs) return;
            await fs.unlink(lockPath);
        } catch (error) {
            if (!isNodeError(error, "ENOENT")) throw error;
        }
    }

    private async ensureDirectory(): Promise<void> {
        await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    }
}

function isCacheDocument(value: unknown): value is ModelCatalogCache {
    if (!value || typeof value !== "object") return false;
    const cache = value as Partial<ModelCatalogCache>;
    return (
        cache.schemaVersion === ModelCatalogCacheSchemaVersion &&
        !!cache.providers &&
        typeof cache.providers === "object" &&
        !Array.isArray(cache.providers)
    );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code;
}
