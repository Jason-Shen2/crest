// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const GitOidPattern = /^[0-9a-f]{40}$/;

export async function writeDurableJson(path: string, value: unknown): Promise<void> {
    assertAbsolutePath(path);
    const bytes = encodeDurableJson(value);
    const temporaryPath = join(dirname(path), `.${randomBytes(16).toString("hex")}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    } catch (error) {
        await handle.close();
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
    await handle.close();
    try {
        await rename(temporaryPath, path);
        await syncDirectory(dirname(path));
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

export async function removeDurableFile(path: string): Promise<void> {
    assertAbsolutePath(path);
    try {
        await unlink(path);
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return;
        }
        throw error;
    }
    await syncDirectory(dirname(path));
}

export function encodeDurableJson(value: unknown): Buffer {
    const encoded = JSON.stringify(sortJson(value));
    if (encoded == null) {
        throw new Error("Value is not canonical JSON");
    }
    return Buffer.from(`${encoded}\n`);
}

export async function ensureDurableGitObjects(
    storePath: string,
    objectIds: readonly string[],
    verifiedPackedObjectIds: ReadonlySet<string> = new Set()
): Promise<void> {
    assertAbsolutePath(storePath);
    const directories = new Set<string>();
    for (const objectId of new Set(objectIds)) {
        if (!GitOidPattern.test(objectId)) {
            throw new Error("Invalid Git object id");
        }
        const directory = join(storePath, "objects", objectId.slice(0, 2));
        const path = join(directory, objectId.slice(2));
        let handle;
        try {
            handle = await open(path, "r");
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT" && verifiedPackedObjectIds.has(objectId)) {
                continue;
            }
            throw error;
        }
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
        directories.add(directory);
    }
    for (const directory of directories) {
        await syncDirectory(directory);
    }
    if (directories.size > 0) {
        await syncDirectory(join(storePath, "objects"));
    }
}

async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
        await handle.sync();
    } catch (error) {
        if (!isUnsupportedDirectorySync(error)) {
            throw error;
        }
    } finally {
        await handle.close();
    }
}

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortJson);
    }
    if (
        value === undefined ||
        typeof value === "function" ||
        typeof value === "symbol" ||
        typeof value === "bigint" ||
        (typeof value === "number" && !Number.isFinite(value))
    ) {
        throw new Error("Value is not canonical JSON");
    }
    if (!isRecord(value)) {
        return value;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Value is not canonical JSON");
    }
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, sortJson(value[key])])
    );
}

function assertAbsolutePath(path: string): void {
    if (!isAbsolute(path)) {
        throw new Error("Durable path must be absolute");
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
    return isNodeError(error) && ["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(error.code ?? "");
}
