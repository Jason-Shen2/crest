import { describe, expect, it, vi } from "vitest";

// The PTY tools transitively import emain-wsh (→ electron), which crashes at
// module load under vitest. Mock it away, matching the pty-*/_pty-rpc tests.
vi.mock("../emain-wsh", () => ({ ElectronWshClient: {} }));

import { InMemorySessionRepo } from "@crest/agent/harness/session/memory-repo";
import { buildCliSubagentHarness, CLI_SUBAGENT_TOOL_NAMES } from "./cli-subagent-factory";

describe("buildCliSubagentHarness", () => {
    it("mounts exactly the three PTY tools bound to the blockId", async () => {
        const session = await new InMemorySessionRepo().create();
        const sub = buildCliSubagentHarness({
            session,
            model: { id: "test-model" } as any,
            blockId: "blk1",
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
            blockId: "blk1",
            cwd: "/tmp",
            initialCommand: "pi",
        });
        expect(typeof sub.harness.prompt).toBe("function");
        expect(typeof sub.harness.abort).toBe("function");
    });
});
