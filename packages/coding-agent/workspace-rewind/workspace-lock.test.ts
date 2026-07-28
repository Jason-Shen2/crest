// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { link, mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { spawn } from "node:child_process";

import { AgentRuntimeRegistry } from "../agent-runtime-registry";
import { makeProcessOwnerIdentity } from "./process-owner";
import { WorkspaceMutationLock } from "./workspace-lock";

const CleanupRoots: string[] = [];

afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function makeLock() {
    const root = await mkdtemp(join(tmpdir(), "crest-workspace-lock-"));
    CleanupRoots.push(root);
    const workspaceRoot = join(root, "store");
    await mkdir(workspaceRoot);
    return new WorkspaceMutationLock({
        workspaceRoot,
        workspaceIdentity: "1".repeat(64),
        workspaceIncarnation: "2".repeat(64),
        processOwner: await makeProcessOwnerIdentity(),
        retryDelayMs: 5,
    });
}

describe("WorkspaceMutationLock", () => {
    test("serializes in-process contenders and publishes private owner state", async () => {
        const lock = await makeLock();
        const release = deferred();
        let secondEntered = false;
        const first = lock.runExclusive(() => release.promise);
        await lock.waitUntilHeldForTest();
        const second = lock.runExclusive(async () => {
            secondEntered = true;
        });

        expect(secondEntered).toBe(false);
        expect((await stat(lock.lockPath)).mode & 0o777).toBe(0o700);
        expect((await stat(join(lock.lockPath, "owner.json"))).mode & 0o777).toBe(0o600);
        const owner = JSON.parse(await readFile(join(lock.lockPath, "owner.json"), "utf8"));
        expect(owner).toMatchObject({
            schemaversion: 1,
            workspaceidentity: "1".repeat(64),
            workspaceincarnation: "2".repeat(64),
            pid: process.pid,
        });

        release.resolve();
        await Promise.all([first, second]);
    });

    test("reclaims an owner whose exact process incarnation is gone", async () => {
        const lock = await makeLock();
        await mkdir(lock.lockPath, { mode: 0o700 });
        await writeFile(
            join(lock.lockPath, "owner.json"),
            JSON.stringify({
                schemaversion: 1,
                workspaceidentity: "1".repeat(64),
                workspaceincarnation: "2".repeat(64),
                pid: process.pid,
                processstarttoken: "stale-token",
                nonce: "a".repeat(64),
                acquiredat: new Date().toISOString(),
            }),
            { mode: 0o600 }
        );

        await expect(lock.runExclusive(async () => "reclaimed")).resolves.toBe("reclaimed");
    });

    test("reclaims a lock owned by a dead process", async () => {
        const lock = await makeLock();
        await mkdir(lock.lockPath, { mode: 0o700 });
        await writeFile(
            join(lock.lockPath, "owner.json"),
            JSON.stringify({
                schemaversion: 1,
                workspaceidentity: "1".repeat(64),
                workspaceincarnation: "2".repeat(64),
                pid: 2 ** 30,
                processstarttoken: "dead-token",
                nonce: "b".repeat(64),
                acquiredat: new Date().toISOString(),
            }),
            { mode: 0o600 }
        );

        await expect(lock.runExclusive(async () => "reclaimed")).resolves.toBe("reclaimed");
    });

    test("fails closed when owner liveness cannot be established", async () => {
        const lock = await makeLock();
        await mkdir(lock.lockPath, { mode: 0o700 });
        await writeFile(join(lock.lockPath, "owner.json"), "not-json", { mode: 0o600 });

        await expect(lock.runExclusive(async () => undefined)).rejects.toThrow(/owner.*unknown|invalid/i);
    });

    test("recovers when a process dies before creating the atomic owner record", async () => {
        const lock = await makeLock();
        await mkdir(lock.lockPath, { mode: 0o700 });

        await expect(lock.runExclusive(async () => "recovered")).resolves.toBe("recovered");
    });

    test("excludes a child process until the current process releases the lock", async () => {
        const lock = await makeLock();
        const release = deferred();
        const held = lock.runExclusive(() => release.promise);
        await lock.waitUntilHeldForTest();
        const script = [
            'import { WorkspaceMutationLock } from "./packages/coding-agent/workspace-rewind/workspace-lock.ts";',
            'import { makeProcessOwnerIdentity } from "./packages/coding-agent/workspace-rewind/process-owner.ts";',
            "(async()=>{",
            `const lock = new WorkspaceMutationLock({workspaceRoot:${JSON.stringify(lock.workspaceRoot)},`,
            `workspaceIdentity:${JSON.stringify(lock.workspaceIdentity)},`,
            `workspaceIncarnation:${JSON.stringify(lock.workspaceIncarnation)},`,
            "processOwner:await makeProcessOwnerIdentity(),retryDelayMs:5});",
            'await lock.runExclusive(async()=>process.stdout.write("acquired"));',
            "})().catch(error=>{console.error(error);process.exitCode=1});",
        ].join("");
        const child = spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), ["-e", script], {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        const exited = childExit(child);
        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr!.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(stdout).toBe("");

        release.resolve();
        await held;
        const code = await exited;
        expect(code, stderr).toBe(0);
        expect(stdout).toBe("acquired");
    });

    test("never acquires across a child process slow owner publication window", async () => {
        const lock = await makeLock();
        const script = [
            'import { mkdir,open,unlink } from "node:fs/promises";',
            'import { makeProcessOwnerIdentity } from "./packages/coding-agent/workspace-rewind/process-owner.ts";',
            "(async()=>{",
            `const lockPath=${JSON.stringify(lock.lockPath)};`,
            `const ownerPath=${JSON.stringify(join(lock.lockPath, "owner.json"))};`,
            "await mkdir(lockPath,{recursive:true,mode:0o700});",
            "const identity=await makeProcessOwnerIdentity();",
            'const handle=await open(ownerPath,"wx",0o600);',
            'process.stdout.write("created\\n");',
            "await new Promise(resolve=>setTimeout(resolve,10));",
            `await handle.writeFile(JSON.stringify({schemaversion:1,workspaceidentity:${JSON.stringify(lock.workspaceIdentity)},workspaceincarnation:${JSON.stringify(lock.workspaceIncarnation)},pid:identity.pid,processstarttoken:identity.processStartToken,nonce:identity.nonce,acquiredat:new Date().toISOString()})+"\\n");`,
            "await handle.sync();",
            'process.stdout.write("published\\n");',
            "await new Promise(resolve=>process.stdin.once('data',resolve));",
            "await handle.close();",
            "await unlink(ownerPath);",
            "})().catch(error=>{console.error(error);process.exitCode=1});",
        ].join("");
        const child = spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), ["-e", script], {
            cwd: process.cwd(),
            stdio: ["pipe", "pipe", "pipe"],
        });
        const exited = childExit(child);
        let output = "";
        child.stdout!.on("data", (chunk) => {
            output += chunk.toString();
        });
        await waitForOutput(() => output, "created\n");
        let entered = false;
        const contender = lock.runExclusive(async () => {
            entered = true;
        });
        await waitForOutput(() => output, "published\n");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(entered).toBe(false);

        child.stdin!.end("\n");
        await contender;
        expect(await exited).toBe(0);
        expect(entered).toBe(true);
    });

    test("reclassifies under reclaim ownership before a delayed child can take over", async () => {
        const lock = await makeLock();
        await mkdir(lock.lockPath, { mode: 0o700 });
        await writeFile(
            join(lock.lockPath, "owner.json"),
            JSON.stringify({
                schemaversion: 1,
                workspaceidentity: lock.workspaceIdentity,
                workspaceincarnation: lock.workspaceIncarnation,
                pid: 2 ** 30,
                processstarttoken: "dead-token",
                nonce: "d".repeat(64),
                acquiredat: new Date().toISOString(),
            }),
            { mode: 0o600 }
        );
        const first = spawnStaleContender(lock, "first");
        const second = spawnStaleContender(lock, "second");
        await Promise.all([
            waitForOutput(() => first.output(), "ready\n"),
            waitForOutput(() => second.output(), "ready\n"),
        ]);

        await writeFile(join(lock.workspaceRoot, "go-first"), "");
        await waitForOutput(() => first.output(), "acquired\n");
        await writeFile(join(lock.workspaceRoot, "go-second"), "");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(second.output()).not.toContain("acquired\n");

        first.child.stdin!.end("\n");
        await waitForOutput(() => second.output(), "acquired\n");
        second.child.stdin!.end("\n");
        expect(await first.exited).toBe(0);
        expect(await second.exited).toBe(0);
    });

    test.each(["transaction-held", "owner-replaced"] as const)(
        "recovers after a reclaiming child crashes at %s",
        async (point) => {
            const lock = await makeLock();
            await writeDeadOwner(lock);
            const child = spawnCrashingReclaimer(lock, point);
            await waitForOutput(() => child.output(), "crash-window\n");
            child.child.kill("SIGKILL");
            await child.exited;

            await expect(lock.runExclusive(async () => "recovered")).resolves.toBe("recovered");
        }
    );

    test("fails closed on a corrupt reclaim transaction database without recreating file guards", async () => {
        const lock = await makeLock();
        await writeDeadOwner(lock);
        await writeFile(join(lock.lockPath, "reclaim.sqlite"), "not sqlite", { mode: 0o600 });

        await expect(lock.runExclusive(async () => undefined)).rejects.toThrow();
    });

    test.each(["symlink", "hardlink", "directory"] as const)(
        "fails closed on an unsafe %s owner record without touching its target",
        async (kind) => {
            const lock = await makeLock();
            await mkdir(lock.lockPath, { mode: 0o700 });
            const target = join(lock.workspaceRoot, `owner-${kind}-target`);
            await writeFile(target, "external", { mode: 0o640 });
            if (kind === "symlink") {
                await symlink(target, lock.ownerPath);
            } else if (kind === "hardlink") {
                await link(target, lock.ownerPath);
            } else {
                await mkdir(lock.ownerPath);
            }

            await expect(lock.runExclusive(async () => undefined)).rejects.toThrow();
            expect(await readFile(target, "utf8")).toBe("external");
            expect((await stat(target)).mode & 0o777).toBe(0o640);
        }
    );

    test.each(["symlink", "hardlink", "directory"] as const)(
        "fails closed on an unsafe %s reclaim database without touching its target",
        async (kind) => {
            const lock = await makeLock();
            await writeDeadOwner(lock);
            const target = join(lock.workspaceRoot, `sqlite-${kind}-target`);
            await writeFile(target, "external", { mode: 0o640 });
            if (kind === "symlink") {
                await symlink(target, lock.reclaimDatabasePath);
            } else if (kind === "hardlink") {
                await link(target, lock.reclaimDatabasePath);
            } else {
                await mkdir(lock.reclaimDatabasePath);
            }

            await expect(lock.runExclusive(async () => undefined)).rejects.toThrow();
            expect(await readFile(target, "utf8")).toBe("external");
            expect((await stat(target)).mode & 0o777).toBe(0o640);
        }
    );

    test("fails closed when lock directory is a symlink without chmodding its target", async () => {
        const lock = await makeLock();
        const target = join(lock.workspaceRoot, "external-lock");
        await mkdir(target, { mode: 0o750 });
        await symlink(target, lock.lockPath);

        await expect(lock.runExclusive(async () => undefined)).rejects.toThrow();
        expect((await stat(target)).mode & 0o777).toBe(0o750);
    });

    test("does not unlink a replacement owner record during release", async () => {
        const lock = await makeLock();
        let entered = false;

        await expect(
            lock.runExclusive(async () => {
                entered = true;
                const original = `${lock.ownerPath}.original`;
                const bytes = await readFile(lock.ownerPath);
                await rename(lock.ownerPath, original);
                await writeFile(lock.ownerPath, bytes, { mode: 0o600 });
            })
        ).rejects.toThrow();
        expect(entered).toBe(true);
        expect(await readFile(lock.ownerPath)).toBeTruthy();
    });

    test("poisons a replaced lock directory before entering the operation", async () => {
        const base = await makeLock();
        const lock = new DirectoryReplacementLock({
            workspaceRoot: base.workspaceRoot,
            workspaceIdentity: base.workspaceIdentity,
            workspaceIncarnation: base.workspaceIncarnation,
            processOwner: base.processOwner,
            retryDelayMs: 5,
        });
        let entered = false;

        await expect(
            lock.runExclusive(async () => {
                entered = true;
            })
        ).rejects.toThrow();
        expect(entered).toBe(false);
    });

    test("rejects inverse workspace-lock to session-lease acquisition", async () => {
        const lock = await makeLock();
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 100 });

        await expect(
            lock.runExclusive(() => registry.withRetainedSessionMutation("/a.db", {}, async () => undefined))
        ).rejects.toThrow(/lock order/i);
    });

    test("does not let a detached async descendant reuse a released holder token", async () => {
        const lock = await makeLock();
        const start = deferred();
        let detached!: Promise<string>;
        await lock.runExclusive(async () => {
            detached = (async () => {
                await start.promise;
                return lock.runExclusive(async () => readFile(join(lock.lockPath, "owner.json"), "utf8"));
            })();
        });

        start.resolve();
        await expect(detached).resolves.toContain(`"workspaceidentity":"${lock.workspaceIdentity}"`);
    });

    test("always releases the in-process FIFO when durable release reports failure", async () => {
        const base = await makeLock();
        const lock = new PostReleaseFailureLock({
            workspaceRoot: base.workspaceRoot,
            workspaceIdentity: base.workspaceIdentity,
            workspaceIncarnation: base.workspaceIncarnation,
            processOwner: base.processOwner,
            retryDelayMs: 5,
        });
        const first = lock.runExclusive(async () => "first");
        const second = lock.runExclusive(async () => "second");

        await expect(first).rejects.toThrow("injected release failure");
        await expect(
            Promise.race([
                second,
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("queued contender hung")), 250)),
            ])
        ).rejects.toThrow(/previous workspace lock release failed/i);
    });
});

async function waitForOutput(read: () => string, expected: string): Promise<void> {
    await vi.waitFor(() => expect(read()).toContain(expected), { timeout: 5_000 });
}

function childExit(child: ReturnType<typeof spawn>): Promise<number | null> {
    return new Promise((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
    });
}

function spawnStaleContender(lock: WorkspaceMutationLock, name: string) {
    const script = [
        'import { access,writeFile } from "node:fs/promises";',
        'import { WorkspaceMutationLock } from "./packages/coding-agent/workspace-rewind/workspace-lock.ts";',
        'import { makeProcessOwnerIdentity } from "./packages/coding-agent/workspace-rewind/process-owner.ts";',
        "(async()=>{",
        `const root=${JSON.stringify(lock.workspaceRoot)};`,
        `const name=${JSON.stringify(name)};`,
        `const lock=new WorkspaceMutationLock({workspaceRoot:root,workspaceIdentity:${JSON.stringify(lock.workspaceIdentity)},workspaceIncarnation:${JSON.stringify(lock.workspaceIncarnation)},processOwner:await makeProcessOwnerIdentity(),retryDelayMs:5});`,
        "const inspect=lock.inspectExistingOwner.bind(lock);let paused=false;",
        "lock.inspectExistingOwner=async()=>{const state=await inspect();",
        'if(state==="stale"&&!paused){paused=true;await writeFile(`${root}/ready-${name}`,"");process.stdout.write("ready\\n");',
        "while(true){try{await access(`${root}/go-${name}`);break}catch{await new Promise(resolve=>setTimeout(resolve,5))}}}",
        "return state};",
        'await lock.runExclusive(async()=>{process.stdout.write("acquired\\n");await new Promise(resolve=>process.stdin.once("data",resolve))});',
        "})().catch(error=>{console.error(error);process.exitCode=1});",
    ].join("");
    const child = spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), ["-e", script], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
        stdout += chunk.toString();
    });
    return { child, exited: childExit(child), output: () => stdout };
}

function spawnCrashingReclaimer(lock: WorkspaceMutationLock, point: "transaction-held" | "owner-replaced") {
    const script = [
        'import { WorkspaceMutationLock } from "./packages/coding-agent/workspace-rewind/workspace-lock.ts";',
        'import { makeProcessOwnerIdentity } from "./packages/coding-agent/workspace-rewind/process-owner.ts";',
        "(async()=>{",
        `const point=${JSON.stringify(point)};`,
        `const lock=new WorkspaceMutationLock({workspaceRoot:${JSON.stringify(lock.workspaceRoot)},workspaceIdentity:${JSON.stringify(lock.workspaceIdentity)},workspaceIncarnation:${JSON.stringify(lock.workspaceIncarnation)},processOwner:await makeProcessOwnerIdentity(),retryDelayMs:5});`,
        'const pause=async()=>{process.stdout.write("crash-window\\n");await new Promise(()=>{})};',
        'if(point==="transaction-held"){const inspect=lock.inspectOwner.bind(lock);let ownerReads=0;',
        "lock.inspectOwner=async(path)=>{if(path===lock.ownerPath&&++ownerReads===2){await pause()}return inspect(path)}}",
        "else {const replace=lock.replaceStaleOwner.bind(lock);",
        "lock.replaceStaleOwner=async owner=>{const result=await replace(owner);await pause();return result}}",
        "await lock.runExclusive(async()=>undefined);",
        "})().catch(error=>{console.error(error);process.exitCode=1});",
    ].join("");
    const child = spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), ["-e", script], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
        stdout += chunk.toString();
    });
    return { child, exited: childExit(child), output: () => stdout };
}

async function writeDeadOwner(lock: WorkspaceMutationLock): Promise<void> {
    await mkdir(lock.lockPath, { mode: 0o700 });
    await writeFile(
        join(lock.lockPath, "owner.json"),
        JSON.stringify({
            schemaversion: 1,
            workspaceidentity: lock.workspaceIdentity,
            workspaceincarnation: lock.workspaceIncarnation,
            pid: 2 ** 30,
            processstarttoken: "dead-token",
            nonce: "e".repeat(64),
            acquiredat: new Date().toISOString(),
        }),
        { mode: 0o600 }
    );
}

class PostReleaseFailureLock extends WorkspaceMutationLock {
    failNextRelease = true;

    override async release(owner: Parameters<WorkspaceMutationLock["release"]>[0]): Promise<void> {
        await super.release(owner);
        if (!this.failNextRelease) {
            return;
        }
        this.failNextRelease = false;
        throw new Error("injected release failure");
    }
}

class DirectoryReplacementLock extends WorkspaceMutationLock {
    override async acquire(...args: Parameters<WorkspaceMutationLock["acquire"]>) {
        const owner = await super.acquire(...args);
        await rename(this.lockPath, `${this.lockPath}.original`);
        await mkdir(this.lockPath, { mode: 0o700 });
        return owner;
    }
}
