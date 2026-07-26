import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import { InMemorySessionRepo } from "@crest/agent/harness/session/memory-repo";
import type { AgentTool } from "@crest/agent/types";
import { buildCliSubagentHarness, CLI_SUBAGENT_TOOL_NAMES } from "./cli-subagent-factory";

function makeStubPtyTool(name: string): AgentTool {
    return {
        name,
        label: name,
        description: `stub ${name}`,
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "stub" }], details: undefined }),
    };
}

const stubTools = [makeStubPtyTool("pty_write"), makeStubPtyTool("pty_read"), makeStubPtyTool("pty_transfer_to_user")];

describe("buildCliSubagentHarness", () => {
    it("mounts exactly the injected PTY tools, in order", async () => {
        const session = await new InMemorySessionRepo().create();
        const sub = buildCliSubagentHarness({
            session,
            model: { id: "test-model" } as any,
            cwd: "/tmp",
            tools: stubTools,
        });
        expect(sub.tools).toEqual(stubTools);
        expect(sub.tools.map((t) => t.name).sort()).toEqual([...CLI_SUBAGENT_TOOL_NAMES].sort());
    });

    it("exposes the underlying harness for prompt/subscribe/abort", async () => {
        const session = await new InMemorySessionRepo().create();
        const sub = buildCliSubagentHarness({
            session,
            model: { id: "test-model" } as any,
            cwd: "/tmp",
            tools: stubTools,
        });
        expect(typeof sub.harness.prompt).toBe("function");
        expect(typeof sub.harness.abort).toBe("function");
    });
});
