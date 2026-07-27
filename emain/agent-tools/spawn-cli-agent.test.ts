import { describe, expect, it, vi } from "vitest";

import type { AgentPtyCommandPort } from "@crest/coding-agent/agent-pty-host";
import * as factory from "@crest/coding-agent/cli-subagent-factory";
import { createSpawnCliAgentTool, runSubagentToCompletion } from "./spawn-cli-agent";

function fakeSub(finalText: string) {
    return {
        harness: {
            prompt: vi.fn(async () => ({ role: "assistant", content: [{ type: "text", text: finalText }] })),
            abort: vi.fn(async () => {}),
        },
    } as any;
}

describe("runSubagentToCompletion", () => {
    it("returns the final assistant text as the summary", async () => {
        const sub = fakeSub("dev server listening on 3000");
        const summary = await runSubagentToCompletion(sub, "start dev server");
        expect(summary).toBe("dev server listening on 3000");
        expect(sub.harness.prompt).toHaveBeenCalledWith("start dev server");
    });

    it("aborts and rethrows when the signal is already aborted", async () => {
        const sub = fakeSub("unused");
        const controller = new AbortController();
        controller.abort();
        await expect(runSubagentToCompletion(sub, "task", { signal: controller.signal })).rejects.toThrow();
    });
});

describe("createSpawnCliAgentTool", () => {
    function makeRuntime() {
        const port: AgentPtyCommandPort = {
            commandId: "cmd-new",
            read: vi.fn() as any,
            write: vi.fn(async () => {}),
            resize: vi.fn(),
            requestUserInput: vi.fn(),
            stop: vi.fn(async () => {}),
        };
        return {
            startHostedCommand: vi.fn(async () => ({
                port,
                snapshot: {
                    commandId: "cmd-new",
                    command: "npm run dev",
                    cwd: "/tmp",
                    tail: "",
                    screen: {
                        rows: [],
                        cursor: { row: 0, col: 0, visible: true, shape: "block", blink: false },
                        isAltScreenActive: false,
                    },
                    running: true,
                    cols: 80,
                    rows: 24,
                    needsUserInput: false,
                },
            })),
        };
    }

    it("uses the current model and auth resolver when execution starts", async () => {
        const sub = fakeSub("done");
        vi.spyOn(factory, "buildCliSubagentHarness").mockReturnValue(sub);
        let model = { id: "first" } as any;
        const getModel = vi.fn(() => model);
        const getApiKeyAndHeaders = vi.fn(async () => ({ apiKey: "current" }));
        const runtime = makeRuntime();
        const tool = createSpawnCliAgentTool({
            runtime: runtime as any,
            getModel,
            getExecutionContext: (cwd) => ({
                workspaceId: "workspace-1",
                workspaceDir: cwd,
                connection: "",
                environment: { FROM_WORKSPACE: "yes" },
                recentCmds: [],
            }),
            createSession: async () => ({ getMetadata: async () => ({}) }) as any,
            getApiKeyAndHeaders,
        });
        model = { id: "second" } as any;

        await tool.execute("t1", {
            task: "run current config",
            initial_command: "npm run dev",
            cwd: "/tmp",
        });

        expect(factory.buildCliSubagentHarness).toHaveBeenCalledWith(
            expect.objectContaining({
                model: expect.objectContaining({ id: "second" }),
                getApiKeyAndHeaders,
            })
        );
    });

    it("spawn_cli_agent starts a hosted command, runs the subagent, returns the summary", async () => {
        const sub = fakeSub("listening on 3000");
        vi.spyOn(factory, "buildCliSubagentHarness").mockReturnValue(sub);
        const runtime = makeRuntime();

        const tool = createSpawnCliAgentTool({
            runtime: runtime as any,
            getModel: () => ({ id: "small" }) as any,
            getExecutionContext: (cwd) => ({
                workspaceId: "workspace-1",
                workspaceDir: cwd,
                connection: "",
                environment: { FROM_WORKSPACE: "yes" },
                recentCmds: [],
            }),
            createSession: async () => ({ getMetadata: async () => ({}) }) as any,
        });
        const r = await tool.execute("t1", {
            task: "start dev server and confirm port 3000",
            initial_command: "npm run dev",
            cwd: "/tmp",
        });
        expect(runtime.startHostedCommand).toHaveBeenCalledWith(
            "npm run dev",
            expect.objectContaining({ workspaceId: "workspace-1", workspaceDir: "/tmp" })
        );
        expect(factory.buildCliSubagentHarness).toHaveBeenCalledWith(
            expect.objectContaining({
                cwd: "/tmp",
                tools: expect.any(Array),
            })
        );
        const passedTools = (factory.buildCliSubagentHarness as any).mock.calls[0][0].tools;
        expect(passedTools.map((t: { name: string }) => t.name)).toEqual([
            "pty_write",
            "pty_read",
            "pty_transfer_to_user",
        ]);
        // The command port and initial command reach the subagent through the
        // tool constructors, not the pure factory options.
        const command = (await runtime.startHostedCommand.mock.results[0].value).port;
        await passedTools[0].execute("t2", { input: "echo hi", mode: "raw" });
        expect(command.write).toHaveBeenCalledWith("echo hi");
        const replay = await passedTools[0].execute("t3", { input: "npm run dev", mode: "line" });
        expect(replay.content[0]).toMatchObject({ text: expect.stringContaining("already running") });
        expect(command.write).toHaveBeenCalledTimes(1);
        expect(sub.harness.prompt).toHaveBeenCalledWith(expect.stringContaining("already been started"));
        expect(sub.harness.prompt).toHaveBeenCalledWith(expect.stringContaining("Do not type"));
        expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("3000") });
        expect(r.details).toMatchObject({ commandId: "cmd-new" });
        expect(runtime.startHostedCommand.mock.results[0]).toBeTruthy();
    });

    it("tears down the hosted command when the subagent run fails", async () => {
        const sub = fakeSub("unused");
        sub.harness.prompt = vi.fn(async () => {
            throw new Error("boom");
        });
        vi.spyOn(factory, "buildCliSubagentHarness").mockReturnValue(sub);
        const runtime = makeRuntime();

        const tool = createSpawnCliAgentTool({
            runtime: runtime as any,
            getModel: () => ({ id: "small" }) as any,
            getExecutionContext: (cwd) => ({
                workspaceId: "workspace-1",
                workspaceDir: cwd,
                connection: "",
                environment: { FROM_WORKSPACE: "yes" },
                recentCmds: [],
            }),
            createSession: async () => ({ getMetadata: async () => ({}) }) as any,
        });
        await expect(tool.execute("t1", { task: "t", initial_command: "npm run dev", cwd: "/tmp" })).rejects.toThrow(
            "boom"
        );
        const command = (await runtime.startHostedCommand.mock.results[0].value).port;
        expect(command.stop).toHaveBeenCalledOnce();
    });
});
