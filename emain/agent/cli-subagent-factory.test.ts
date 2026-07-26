import { describe, expect, it, vi } from "vitest";

import type { AgentPtyCommandPort } from "./agent-pty-host";
import { buildCliSubagentHarness, CLI_SUBAGENT_TOOL_NAMES } from "./cli-subagent-factory";
import { InMemorySessionRepo } from "./harness/session/memory-repo";

function makeCommand(): AgentPtyCommandPort {
    return {
        commandId: "cmd1",
        read: vi.fn() as any,
        write: vi.fn(async () => {}),
        resize: vi.fn(),
        requestUserInput: vi.fn(),
        stop: vi.fn(async () => {}),
    };
}

describe("buildCliSubagentHarness", () => {
    it("mounts exactly the three PTY tools bound to the command", async () => {
        const session = await new InMemorySessionRepo().create();
        const sub = buildCliSubagentHarness({
            session,
            model: { id: "test-model" } as any,
            command: makeCommand(),
            cwd: "/tmp",
            initialCommand: "pi",
        });
        const names = sub.tools.map((t) => t.name).sort();
        expect(names).toEqual([...CLI_SUBAGENT_TOOL_NAMES].sort());
    });

    it("exposes the underlying harness for prompt/subscribe/abort", async () => {
        const session = await new InMemorySessionRepo().create();
        const sub = buildCliSubagentHarness({
            session,
            model: { id: "test-model" } as any,
            command: makeCommand(),
            cwd: "/tmp",
            initialCommand: "pi",
        });
        expect(typeof sub.harness.prompt).toBe("function");
        expect(typeof sub.harness.abort).toBe("function");
    });
});
