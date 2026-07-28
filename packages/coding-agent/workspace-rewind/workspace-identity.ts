// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { link, mkdir, readFile, realpath, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { WorkspaceGitRunner, WorkspaceGitRunnerError } from "./git-runner";

export interface CanonicalWorkspaceIdentity {
    canonicalRoot: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    storeKey: string;
}

const IdentityDiscoveryTimeoutMs = 10_000;
const RegistryDirectoryName = "workspace-rewind/incarnations";
const SupportedFilesystemTypes: Partial<Record<NodeJS.Platform, ReadonlySet<bigint>>> = {
    darwin: new Set([23n, 26n]),
    linux: new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x794c7630n, 0x2fc12fc1n, 0xf2f52010n]),
};

export async function resolveCanonicalWorkspaceIdentity(root: string): Promise<CanonicalWorkspaceIdentity> {
    const requestedRoot = await realpath(root);
    const requestedStat = await stat(requestedRoot);
    if (!requestedStat.isDirectory()) {
        throw new Error(`Workspace root is not a directory: ${requestedRoot}`);
    }

    const canonicalRoot = await resolveGitRoot(requestedRoot);
    await assertSupportedIdentityFilesystem(canonicalRoot);
    const rootStat = await stat(canonicalRoot, { bigint: true });
    if (!rootStat.isDirectory()) {
        throw new Error(`Workspace root is not a directory: ${canonicalRoot}`);
    }

    const workspaceIdentity = digest(Buffer.from(canonicalRoot));
    const fileIdentity = makeReliableFileIdentity(rootStat);
    const registryKey = digest(Buffer.from(`${workspaceIdentity}\0${fileIdentity}`));
    const nonce = await registerIncarnationNonce(registryKey);
    const verifiedStat = await stat(canonicalRoot, { bigint: true });
    if (makeReliableFileIdentity(verifiedStat) !== fileIdentity) {
        throw new Error(`Workspace root changed during identity resolution: ${canonicalRoot}`);
    }
    const workspaceIncarnation = digest(Buffer.from(`${workspaceIdentity}\0${fileIdentity}\0${nonce}`));

    return {
        canonicalRoot,
        workspaceIdentity,
        workspaceIncarnation,
        storeKey: `${workspaceIdentity}-${workspaceIncarnation}`,
    };
}

async function assertSupportedIdentityFilesystem(root: string): Promise<void> {
    const filesystem = await statfs(root, { bigint: true });
    const supportedTypes = SupportedFilesystemTypes[process.platform];
    const normalizedType = BigInt.asUintN(32, filesystem.type);
    if (!supportedTypes?.has(normalizedType)) {
        throw new Error(
            `unsupported workspace filesystem for reliable incarnation identity: ${process.platform}:${normalizedType}`
        );
    }
}

async function resolveGitRoot(root: string): Promise<string> {
    const git = new WorkspaceGitRunner();
    try {
        const result = await git.run(["rev-parse", "--show-toplevel"], {
            cwd: root,
            timeoutMs: IdentityDiscoveryTimeoutMs,
        });
        const discovered = stripLineEnding(result.stdout).toString("utf8");
        if (!discovered) {
            return root;
        }
        return realpath(discovered);
    } catch (error) {
        if (error instanceof WorkspaceGitRunnerError && error.code === "nonzero_exit") {
            return root;
        }
        throw error;
    }
}

async function registerIncarnationNonce(registryKey: string): Promise<string> {
    const registryRoot = join(resolveCrestDataHome(), RegistryDirectoryName);
    await mkdir(registryRoot, { recursive: true, mode: 0o700 });
    const registryPath = join(registryRoot, registryKey);
    const temporaryPath = join(registryRoot, `.${registryKey}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
    const nonce = randomBytes(32).toString("hex");
    await writeFile(temporaryPath, nonce, { flag: "wx", mode: 0o600 });
    try {
        try {
            await link(temporaryPath, registryPath);
            return nonce;
        } catch (error) {
            if (!isAlreadyExists(error)) {
                throw error;
            }
            return await readRegisteredNonce(registryPath);
        }
    } finally {
        await unlink(temporaryPath).catch(() => undefined);
    }
}

async function readRegisteredNonce(registryPath: string): Promise<string> {
    const nonce = await readFile(registryPath, "utf8");
    if (!/^[0-9a-f]{64}$/.test(nonce)) {
        throw new Error(`Invalid workspace incarnation registry entry: ${registryPath}`);
    }
    return nonce;
}

function resolveCrestDataHome(): string {
    if (process.env.WAVETERM_DATA_HOME) {
        return process.env.WAVETERM_DATA_HOME;
    }
    if (process.env.XDG_DATA_HOME) {
        return join(process.env.XDG_DATA_HOME, "crest");
    }
    if (process.platform === "darwin") {
        return join(homedir(), "Library", "Application Support", "crest");
    }
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
        return join(process.env.LOCALAPPDATA, "crest");
    }
    return join(homedir(), ".local", "share", "crest");
}

function stripLineEnding(value: Buffer): Buffer {
    if (value.at(-1) === 0x0a) {
        value = value.subarray(0, -1);
    }
    return value;
}

function makeReliableFileIdentity(value: BigIntStats): string {
    const futureToleranceNs = 60n * 1_000_000_000n;
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    if (
        !value.isDirectory() ||
        value.dev <= 0n ||
        value.ino <= 0n ||
        value.birthtimeNs <= 0n ||
        value.birthtimeNs > nowNs + futureToleranceNs
    ) {
        throw new Error("Workspace filesystem does not provide a reliable root file identity");
    }
    return [value.dev.toString(), value.ino.toString(), value.birthtimeNs.toString()].join(":");
}

function digest(value: Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function isAlreadyExists(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
