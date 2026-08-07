// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import type { AgentHarness, AgentHarnessEvent } from "@crest/agent/harness/types";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionMutationBarrier } from "../session-mutation-barrier";
import { registerWorkspaceCheckpointManager } from "./checkpoint-manager";
import { WorkspaceGitRunner } from "./git-runner";
import { decodeWorkspaceCheckpointEntry } from "./session-state";
import { initializeWorkspaceCheckpointSnapshotSource } from "./snapshot-source";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import type { WorkspaceCheckpointV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";

const execFileAsync = promisify(execFile);
const cleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function ancestorIdentityChain(path: string): Promise<CanonicalWorkspaceIdentity["ancestorIdentityChain"]> {
    const paths: string[] = [];
    let cursor = path;
    while (true) {
        paths.unshift(cursor);
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    return Promise.all(
        paths.map(async (absolutePath) => {
            const state = await lstat(absolutePath, { bigint: true });
            return {
                absolutePath,
                dev: state.dev.toString(),
                ino: state.ino.toString(),
                birthtimeNs: state.birthtimeNs.toString(),
            };
        })
    );
}

async function makeFixture(label: string, gitRepository = false) {
    const root = await mkdtemp(join(tmpdir(), `crest-rewind-tool-${label}-`));
    cleanupRoots.push(root);
    const workspaceRoot = await realpath(await mkdir(join(root, "workspace"), { recursive: true }));
    if (gitRepository) {
        await execFileAsync("git", ["init", "-q"], { cwd: workspaceRoot });
        await execFileAsync("git", ["config", "user.email", "rewind@example.test"], { cwd: workspaceRoot });
        await execFileAsync("git", ["config", "user.name", "Rewind Test"], { cwd: workspaceRoot });
    }
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspaceRoot,
        workspaceIdentity: Buffer.from(`identity-${label}`).toString("hex").padEnd(64, "0").slice(0, 64),
        workspaceIncarnation: Buffer.from(`incarnation-${label}`).toString("hex").padEnd(64, "0").slice(0, 64),
        storeKey: `tool-${label}`,
        ancestorIdentityChain: await ancestorIdentityChain(workspaceRoot),
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: {
            pid: process.pid,
            processStartToken: `tool-${label}`,
            nonce: "4".repeat(64),
        },
    });
    const repo = new SqliteSessionRepo({ sessionsRoot: join(root, "sessions") });
    const session = await repo.create({ cwd: workspaceRoot, id: `session-${label}` });
    const listeners = new Set<(event: AgentHarnessEvent) => void | Promise<void>>();
    const harness = {
        subscribe(listener: (event: AgentHarnessEvent) => void | Promise<void>) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    } as unknown as AgentHarness;
    let hostedPtyRunning = false;
    const snapshotSource = await initializeWorkspaceCheckpointSnapshotSource({
        store,
        legacyCapture: store,
    });
    const manager = registerWorkspaceCheckpointManager({
        harness,
        session,
        sessionId: `session-${label}`,
        workspaceRoot,
        store,
        snapshotSource,
        mutationBarrier: new SessionMutationBarrier(),
        hasRunningHostedCommands: () => hostedPtyRunning,
        processOwner: {
            pid: process.pid,
            processStartToken: `tool-${label}`,
            nonce: "4".repeat(64),
        },
        onCheckpointCommitted: async () => {},
    });
    const emit = async (event: AgentHarnessEvent) => {
        for (const listener of listeners) await listener(event);
    };
    return {
        root,
        workspaceRoot,
        store,
        session,
        manager,
        emit,
        setHostedPtyRunning(value: boolean) {
            hostedPtyRunning = value;
        },
    };
}

async function runTurn(
    value: Awaited<ReturnType<typeof makeFixture>>,
    label: string,
    writer: () => Promise<void>,
    metadataEvents: AgentHarnessEvent[] = []
): Promise<WorkspaceCheckpointV1> {
    const boundaryToken = `boundary-${label}`;
    await value.emit({
        type: "session_before_user_turn",
        boundaryToken,
        userMessage: { role: "user", content: label },
    } as AgentHarnessEvent);
    const turnId = await value.session.appendMessage({
        role: "user",
        content: label,
        timestamp: Date.now(),
    } as never);
    await value.emit({
        type: "session_user_turn_committed",
        boundaryToken,
        userEntryId: turnId,
    } as AgentHarnessEvent);
    await value.manager.beforeWorkspaceTool("unknown_workspace_writer");
    await writer();
    for (const event of metadataEvents) await value.emit(event);
    await value.emit({
        type: "session_user_turn_terminal",
        boundaryToken,
        reason: "agent_end",
    } as AgentHarnessEvent);
    const checkpoints = (await value.session.getEntries())
        .map(decodeWorkspaceCheckpointEntry)
        .filter((checkpoint): checkpoint is WorkspaceCheckpointV1 => checkpoint != null);
    return checkpoints.at(-1)!;
}

function pathChanges(checkpoint: WorkspaceCheckpointV1): string[] {
    return checkpoint.status === "available" ? checkpoint.changes.map((change) => change.path).sort() : [];
}

describe("turn-boundary workspace capture is tool-independent", () => {
    it("captures only when a potentially-writing operation starts and when its turn ends", async () => {
        const value = await makeFixture("default-source");
        const capture = vi.spyOn(value.store, "capture");
        const diff = vi.spyOn(value.store, "diff");

        const checkpoint = await runTurn(value, "default-source", () =>
            writeFile(join(value.workspaceRoot, "result.txt"), "default")
        );

        expect(checkpoint.status).toBe("available");
        expect(capture.mock.calls.map(([options]) => options.profile)).toEqual(["terminal", "terminal"]);
        if (checkpoint.status !== "available") {
            throw new Error("Expected an available checkpoint");
        }
        expect(diff).toHaveBeenCalledWith(checkpoint.before, checkpoint.after);
        await value.manager.dispose();
    }, 30_000);

    it("captures shell, PTY-shaped direct, CLI child-process, and unknown future writes without metadata", async () => {
        const value = await makeFixture("writers");
        const checkpoint = await runTurn(
            value,
            "all-writers",
            async () => {
                await execFileAsync("sh", ["-c", "printf bash > bash.txt"], { cwd: value.workspaceRoot });
                // This fixture exercises the checkpoint authority boundary, not
                // node-pty transport. Production PTY/CLI wiring is covered by
                // emain/agent-tools/agent-pty-host.test.ts and
                // emain/agent-tools/spawn-cli-agent.test.ts.
                await writeFile(join(value.workspaceRoot, "pty.txt"), "hosted-pty");
                await execFileAsync(process.execPath, ["-e", "require('fs').writeFileSync('cli.txt','subagent')"], {
                    cwd: value.workspaceRoot,
                });
                await writeFile(join(value.workspaceRoot, "future.txt"), "future-tool");
            },
            [
                { type: "tool_execution_end", toolName: "write", result: { changed: ["wrong.txt"] } } as never,
                { type: "tool_execution_end", toolName: "future_mutator", result: {} } as never,
            ]
        );

        expect(checkpoint.status).toBe("available");
        expect(pathChanges(checkpoint)).toEqual(["bash.txt", "cli.txt", "future.txt", "pty.txt"]);
        expect(JSON.stringify(checkpoint)).not.toMatch(/toolName|wrong\.txt|forged\.txt/);
        await value.manager.dispose();
    }, 30_000);

    it("produces the same manifest after write/edit metadata is altered or removed", async () => {
        const withMetadata = await makeFixture("metadata");
        const withoutMetadata = await makeFixture("no-metadata");
        const first = await runTurn(
            withMetadata,
            "metadata",
            () => writeFile(join(withMetadata.workspaceRoot, "result.txt"), "same bytes"),
            [{ type: "tool_execution_end", toolName: "edit", result: { path: "forged.txt" } } as never]
        );
        const second = await runTurn(withoutMetadata, "no-metadata", () =>
            writeFile(join(withoutMetadata.workspaceRoot, "result.txt"), "same bytes")
        );

        expect(pathChanges(first)).toEqual(["result.txt"]);
        expect(pathChanges(second)).toEqual(pathChanges(first));
        await Promise.all([withMetadata.manager.dispose(), withoutMetadata.manager.dispose()]);
    }, 30_000);

    it("marks the checkpoint unavailable while a transferred hosted PTY remains active", async () => {
        // `hasRunningHostedCommands` is the production checkpoint-manager
        // boundary owned by AgentPtyHost; its runtime wiring has a dedicated
        // test in emain/agent-tools/agent-pty-host.test.ts.
        const value = await makeFixture("active-pty");
        value.setHostedPtyRunning(true);
        const checkpoint = await runTurn(value, "active-pty", () =>
            writeFile(join(value.workspaceRoot, "still-running.txt"), "partial")
        );

        expect(checkpoint).toMatchObject({
            status: "unavailable",
            reasonCode: "hosted_pty_running",
        });
        await value.manager.dispose();
    }, 30_000);

    it("records workspace incarnation replacement as unavailable instead of an available empty checkpoint", async () => {
        const value = await makeFixture("incarnation-replaced");
        const displaced = `${value.workspaceRoot}-displaced`;
        const checkpoint = await runTurn(value, "incarnation-replaced", async () => {
            await rename(value.workspaceRoot, displaced);
            await mkdir(value.workspaceRoot);
        });

        expect(checkpoint).toMatchObject({
            status: "unavailable",
            reasonCode: "git_unavailable",
        });
        expect(checkpoint).not.toHaveProperty("changes");
        await value.manager.dispose();
    }, 30_000);

    it("has Git/non-Git manifest parity and never touches user HEAD, index, or stash metadata", async () => {
        const git = await makeFixture("git", true);
        const plain = await makeFixture("plain");
        await writeFile(join(git.workspaceRoot, "tracked.txt"), "committed");
        await execFileAsync("git", ["add", "tracked.txt"], { cwd: git.workspaceRoot });
        await execFileAsync("git", ["commit", "-qm", "base"], { cwd: git.workspaceRoot });
        await writeFile(join(git.workspaceRoot, "tracked.txt"), "stashed");
        await execFileAsync("git", ["stash", "push", "-qm", "user-stash"], { cwd: git.workspaceRoot });

        const gitPaths = ["HEAD", "index", join("refs", "stash")].map((path) => join(git.workspaceRoot, ".git", path));
        const before = await Promise.all(
            gitPaths.map(async (path) => ({
                bytes: await readFile(path),
                mtimeNs: (await stat(path, { bigint: true })).mtimeNs,
            }))
        );
        const gitCheckpoint = await runTurn(git, "git-write", () =>
            writeFile(join(git.workspaceRoot, "result.txt"), "same bytes")
        );
        const plainCheckpoint = await runTurn(plain, "plain-write", () =>
            writeFile(join(plain.workspaceRoot, "result.txt"), "same bytes")
        );
        const after = await Promise.all(
            gitPaths.map(async (path) => ({
                bytes: await readFile(path),
                mtimeNs: (await stat(path, { bigint: true })).mtimeNs,
            }))
        );

        expect(pathChanges(gitCheckpoint)).toEqual(["result.txt"]);
        expect(pathChanges(plainCheckpoint)).toEqual(pathChanges(gitCheckpoint));
        expect(after).toEqual(before);
        await Promise.all([git.manager.dispose(), plain.manager.dispose()]);
    }, 30_000);
});
