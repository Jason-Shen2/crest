// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Electron-main reader for the safeStorage-encrypted secrets file at
// `<configDir>/secrets.enc`. Previously the Go wavesrv side wrapped this
// (pkg/secretstore/secretstore.go) and reached into Electron via the
// ElectronEncryptCommand wshrpc to do the actual encrypt/decrypt. Now
// that the AI runtime lives in main, we read the file directly here —
// safeStorage is a main-process API, no IPC roundtrip required.
//
// Write path stays in Go for now (the secrets-management UI in
// frontend/app/modals/ai-setup-wizard.tsx submits writes via wshrpc,
// which goes to Go → ElectronEncryptCommand → safeStorage). We only
// need read access here for resolving `tokensecretname` references
// when listing provider /models.

import { safeStorage } from "electron";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getWaveConfigDir } from "../emain-platform";

const SECRETS_FILE_NAME = "secrets.enc";

// Match pkg/secretstore — the file contains JSON {name: value, ...}
// plus a "wave:writets" key we filter out.
const WRITE_TS_KEY = "wave:writets";

interface CacheEntry {
    secrets: Record<string, string>;
    mtimeMs: number;
}

let cache: CacheEntry | null = null;

async function loadSecrets(): Promise<Record<string, string>> {
    const filePath = path.join(getWaveConfigDir(), SECRETS_FILE_NAME);
    let stat;
    try {
        stat = await fs.stat(filePath);
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw err;
    }
    if (cache && cache.mtimeMs === stat.mtimeMs) {
        return cache.secrets;
    }
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("safeStorage encryption is not available");
    }
    const raw = await fs.readFile(filePath, "utf8");
    const buf = Buffer.from(raw, "base64");
    const plaintext = safeStorage.decryptString(buf);
    const parsed = JSON.parse(plaintext) as Record<string, string>;
    cache = { secrets: parsed, mtimeMs: stat.mtimeMs };
    return parsed;
}

/**
 * Resolve a secret by name. Returns null when the file doesn't exist,
 * the name isn't present, or the name matches the reserved metadata
 * key. Throws on decrypt / parse errors so the caller surfaces them.
 */
export async function getSecret(name: string): Promise<string | null> {
    if (!name || name === WRITE_TS_KEY) return null;
    const secrets = await loadSecrets();
    const value = secrets[name];
    return value ?? null;
}

/** Test-only: clear the in-memory cache so the next call re-reads the file. */
export function _resetSecretsCacheForTests(): void {
    cache = null;
}
