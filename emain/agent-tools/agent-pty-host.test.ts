// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned: FakePty[] = [];

class FakePty {
    readonly emitter = new EventEmitter();
    killed = false;
    writes: string[] = [];
    resizes: Array<{ cols: number; rows: number }> = [];
    pid = 1234;
    autoExitOnKill = true;

    onData(cb: (data: string) => void) {
        this.emitter.on("data", cb);
        return { dispose: () => this.emitter.off("data", cb) };
    }

    onExit(cb: (event: { exitCode: number; signal?: number }) => void) {
        this.emitter.on("exit", cb);
        return { dispose: () => this.emitter.off("exit", cb) };
    }

    write(input: string) {
        this.writes.push(input);
    }

    resize(cols: number, rows: number) {
        this.resizes.push({ cols, rows });
    }

    kill() {
        this.killed = true;
        if (this.autoExitOnKill) {
            this.emitter.emit("exit", { exitCode: 143 });
        }
    }

    data(output: string) {
        this.emitter.emit("data", output);
    }

    exit(exitCode = 0) {
        this.emitter.emit("exit", { exitCode });
    }
}

vi.mock("node-pty", () => ({
    spawn: vi.fn((_shell: string, _args: string[], _options: unknown) => {
        const pty = new FakePty();
        spawned.push(pty);
        return pty;
    }),
}));

import type { AgentExecutionContext } from "@crest/coding-agent/agent-execution-context";
import * as nodePty from "node-pty";
import { AgentPtyHost } from "./agent-pty-host";

function context(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
    return {
        workspaceId: "workspace-1",
        workspaceDir: "/tmp/agent-pty-host",
        sessionPath: "/tmp/session.jsonl",
        environment: { FROM_CONTEXT: "yes" },
        ...overrides,
    };
}

describe("AgentPtyHost", () => {
    beforeEach(() => {
        spawned.length = 0;
    });

    it("starts a command in a hosted PTY without a Terminal block", async () => {
        const host = new AgentPtyHost({ cols: 12, rows: 4 });

        const snap = await host.start("printf hi", context());
        spawned[0].data("hi\n");

        expect(nodePty.spawn).toHaveBeenCalledWith(
            expect.any(String),
            expect.arrayContaining([expect.stringContaining("printf hi")]),
            expect.objectContaining({
                cwd: "/tmp/agent-pty-host",
                cols: 12,
                rows: 4,
                env: expect.objectContaining({ FROM_CONTEXT: "yes", TERM: expect.any(String) }),
            })
        );
        expect(snap.commandId).toMatch(/[a-f0-9-]{20,}/);
        expect(snap).not.toHaveProperty("blockId");
        expect(host.read(snap.commandId).tail).toContain("hi");
        expect(
            host
                .read(snap.commandId)
                .screen.rows.map((row) => row.text)
                .join("\n")
        ).toContain("hi");
    });

    it("caps transcript and screen memory for large output", async () => {
        const host = new AgentPtyHost({ cols: 20, rows: 5, maxBytes: 80, maxLines: 4 });
        const started = await host.start("long", context());

        for (let i = 0; i < 100; i += 1) {
            spawned[0].data(`line-${i}\n`);
        }

        const snap = host.read(started.commandId);
        expect(snap.tail.split("\n").filter(Boolean)).toHaveLength(4);
        expect(snap.tail).toContain("line-99");
        expect(snap.screen.rows).toHaveLength(5);
        expect(host.getBackingRowCounts(started.commandId)).toEqual({ primary: 5, alt: 5 });
    });

    it("writes, resizes, marks takeover, rejects writes after exit, and stops owned processes", async () => {
        const killTree = vi.fn();
        const host = new AgentPtyHost({ cols: 10, rows: 3, killProcessTree: killTree });
        const started = await host.start("interactive", context());

        await host.write(started.commandId, "yes\n");
        host.resize(started.commandId, 40, 10);
        host.requestUserInput(started.commandId, "needs sudo password");

        expect(spawned[0].writes).toEqual(["yes\n"]);
        expect(spawned[0].resizes).toEqual([{ cols: 40, rows: 10 }]);
        expect(host.read(started.commandId).needsUserInput).toBe(true);

        spawned[0].exit(0);
        expect(host.read(started.commandId)).toMatchObject({ running: false, exitCode: 0 });
        await expect(host.write(started.commandId, "late")).rejects.toThrow(/not running/i);

        const second = await host.start("sleep", context());
        await host.stop(second.commandId);
        expect(spawned[1].killed).toBe(true);
        expect(killTree).toHaveBeenCalledWith(1234);
    });

    it("waits for asynchronous exit during stop", async () => {
        const host = new AgentPtyHost({ killProcessTree: vi.fn(), stopTimeoutMs: 1000 });
        const started = await host.start("sleep", context());
        spawned[0].autoExitOnKill = false;

        let stopped = false;
        const stop = host.stop(started.commandId).then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(spawned[0].killed).toBe(true);

        spawned[0].exit(143);
        await stop;
        expect(host.read(started.commandId).running).toBe(false);
    });

    it("prunes completed commands so historical snapshots are bounded", async () => {
        const host = new AgentPtyHost({ maxCompletedCommands: 2 });

        const first = await host.start("one", context());
        const second = await host.start("two", context());
        const third = await host.start("three", context());
        spawned[0].exit(0);
        spawned[1].exit(0);
        spawned[2].exit(0);

        expect(host.commandCount()).toBe(2);
        expect(() => host.read(first.commandId)).toThrow(/unknown/i);
        expect(host.read(second.commandId).running).toBe(false);
        expect(host.read(third.commandId).running).toBe(false);
    });

    it("clears completed command history while idle without killing a process", async () => {
        const killTree = vi.fn();
        const host = new AgentPtyHost({ killProcessTree: killTree });
        const completed = await host.start("done", context());
        spawned[0].exit(0);

        host.clearCompletedHistory();

        expect(host.snapshots()).toEqual([]);
        expect(() => host.read(completed.commandId)).toThrow(/unknown/i);
        expect(killTree).not.toHaveBeenCalled();
    });

    it("rejects completed-history mutation while a command is running", async () => {
        const host = new AgentPtyHost({ killProcessTree: vi.fn() });
        const running = await host.start("still running", context());

        expect(() => host.clearCompletedHistory()).toThrow(/idle|running/i);
        expect(host.read(running.commandId).running).toBe(true);
        expect(host.snapshots()).toHaveLength(1);
    });

    it("removes failed launches from the registry", async () => {
        vi.mocked(nodePty.spawn).mockImplementationOnce(() => {
            throw new Error("spawn failed");
        });
        const host = new AgentPtyHost();

        await expect(host.start("bad", context())).rejects.toThrow("spawn failed");

        expect(host.commandCount()).toBe(0);
    });

    it("dispose kills all running commands", async () => {
        const host = new AgentPtyHost({ killProcessTree: vi.fn() });
        await host.start("one", context());
        await host.start("two", context());

        await host.dispose();

        expect(spawned.at(-1)?.killed).toBe(true);
        expect(spawned.at(-2)?.killed).toBe(true);
        expect(host.hasRunningCommands()).toBe(false);
    });
});
