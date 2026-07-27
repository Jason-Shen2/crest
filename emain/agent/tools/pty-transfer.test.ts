import { describe, expect, it, vi } from "vitest";
import type { AgentPtyCommandPort } from "../agent-pty-host";
import { createPtyTransferTool } from "./pty-transfer";

function makePort(): AgentPtyCommandPort {
    return {
        commandId: "cmd-real",
        read: vi.fn() as any,
        write: vi.fn(async () => {}),
        resize: vi.fn(),
        requestUserInput: vi.fn(),
        stop: vi.fn(async () => {}),
    };
}

describe("pty_transfer_to_user", () => {
    it("does not require the model to provide a block_id", () => {
        const tool = createPtyTransferTool(makePort());
        expect((tool.parameters as { required?: string[] }).required).not.toContain("command_id");
    });

    it("always reports the bound command even if the model guesses a placeholder command_id", async () => {
        const port = makePort();
        const tool = createPtyTransferTool(port);
        const r = await tool.execute("t1", { command_id: "default", reason: "needs sudo password" });
        expect(r.details).toMatchObject({ transferred: true, command_id: "cmd-real" });
        expect(port.requestUserInput).toHaveBeenCalledWith("needs sudo password");
    });

    it("terminates and echoes the reason", async () => {
        const tool = createPtyTransferTool(makePort());
        const r = await tool.execute("t1", { reason: "needs sudo password" });
        expect(r.terminate).toBe(true);
        expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("needs sudo password") });
        expect(r.details).toMatchObject({ transferred: true, command_id: "cmd-real" });
    });
});
