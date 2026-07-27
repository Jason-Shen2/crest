import { describe, expect, it, vi } from "vitest";

import type { AgentPtyCommandPort, AgentPtySnapshot } from "@crest/coding-agent/agent-pty-host";
import { createPtyReadTool } from "./pty-read";

function makePort(overrides: Partial<AgentPtyCommandPort> = {}): AgentPtyCommandPort {
    return {
        commandId: "cmd-real",
        read: vi.fn(() => ({
            commandId: "cmd-real",
            command: "npm run dev",
            cwd: "/tmp",
            tail: "recent output",
            screen: {
                rows: [{ text: "screen output", cells: [] }],
                cursor: { row: 0, col: 6, visible: true, shape: "block", blink: false },
                isAltScreenActive: false,
            },
            running: true,
            cols: 80,
            rows: 24,
            needsUserInput: false,
        }) as AgentPtySnapshot),
        write: vi.fn(async () => {}),
        resize: vi.fn(() => {}),
        requestUserInput: vi.fn(() => {}),
        stop: vi.fn(async () => {}),
        ...overrides,
    };
}

describe("pty_read", () => {
    it("does not require the model to provide a command_id", () => {
        const tool = createPtyReadTool(makePort());
        expect((tool.parameters as { required?: string[] }).required ?? []).not.toContain("command_id");
    });

    it("always reads the bound command even if the model guesses a placeholder command_id", async () => {
        const port = makePort();
        const tool = createPtyReadTool(port);
        const r = await tool.execute("t1", { command_id: "default", mode: "auto" });
        expect(port.read).toHaveBeenCalledOnce();
        expect(r.details).toMatchObject({ command_id: "cmd-real" });
    });

    it("auto + altscreen=false returns transcript tail", async () => {
        const tool = createPtyReadTool(makePort());
        const r = await tool.execute("t1", { mode: "auto" });
        expect(r.details).toMatchObject({ source: "transcript_tail", is_running: true, approximate: true });
        expect(r.content[0]).toMatchObject({ type: "text", text: "recent output" });
    });

    it("auto + altscreen=true returns hosted screen snapshot without renderer fallback", async () => {
        const tool = createPtyReadTool(
            makePort({
                read: vi.fn(() => ({
                    commandId: "cmd-real",
                    command: "vim",
                    cwd: "/tmp",
                    tail: "vim buffer tail",
                    screen: {
                        rows: [
                            { text: "line one", cells: [] },
                            { text: "line two", cells: [] },
                        ],
                        cursor: { row: 1, col: 4, visible: true, shape: "block", blink: false },
                        isAltScreenActive: true,
                    },
                    running: true,
                    cols: 80,
                    rows: 24,
                    needsUserInput: false,
                }) as AgentPtySnapshot),
            })
        );
        const r = await tool.execute("t1", { mode: "auto" });
        expect(r.details).toMatchObject({
            source: "screen_snapshot",
            is_alt_screen_active: true,
            is_running: true,
        });
        expect((r.content[0] as { text: string }).text).toContain("line one");
        expect((r.content[0] as { text: string }).text).toContain("[cursor: row 2, col 5]");
    });

    it("reports exit_code when finished", async () => {
        const tool = createPtyReadTool(
            makePort({
                read: vi.fn(() => ({
                    commandId: "cmd-real",
                    command: "done",
                    cwd: "/tmp",
                    tail: "done",
                    screen: {
                        rows: [],
                        cursor: { row: 0, col: 0, visible: true, shape: "block", blink: false },
                        isAltScreenActive: false,
                    },
                    running: false,
                    exitCode: 0,
                    cols: 80,
                    rows: 24,
                    needsUserInput: false,
                }) as AgentPtySnapshot),
            })
        );
        const r = await tool.execute("t1", { mode: "transcript" });
        expect(r.details).toMatchObject({ is_running: false, exit_code: 0 });
    });
});
