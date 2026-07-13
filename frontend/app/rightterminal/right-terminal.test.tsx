// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockObjectService = vi.hoisted(() => ({
    createBlock: vi.fn(),
    deleteBlock: vi.fn(),
}));

vi.mock("@/app/store/services", () => ({
    ObjectService: {
        CreateBlock: mockObjectService.createBlock,
        DeleteBlock: mockObjectService.deleteBlock,
    },
}));

vi.mock("@/app/term/render/terminal-view", () => ({
    TerminalView: ({ outerBlockId }: { outerBlockId: string }) => <div data-terminal-view={outerBlockId} />,
}));

import { RightTerminalModel } from "./right-terminal";

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe("RightTerminalModel", () => {
    beforeEach(() => {
        RightTerminalModel.resetInstance();
        mockObjectService.createBlock.mockReset();
        mockObjectService.deleteBlock.mockReset();
    });

    it("creates the same shell term block surface as the main workspace terminal", async () => {
        mockObjectService.createBlock.mockResolvedValue("right-terminal-block");
        const model = RightTerminalModel.getInstance();

        model.ensureStarted("/tmp/project");
        await flushPromises();

        expect(mockObjectService.createBlock).toHaveBeenCalledWith(
            {
                meta: {
                    controller: "shell",
                    view: "term",
                    "cmd:cwd": "/tmp/project",
                },
            },
            { termsize: { rows: 24, cols: 80 } }
        );
        expect(globalStore.get(model.blockIdAtom)).toBe("right-terminal-block");
    });

    it("allows reopening while a stale terminal block is still being created", async () => {
        let resolveFirstCreate: (blockId: string) => void = () => null;
        mockObjectService.createBlock
            .mockReturnValueOnce(new Promise<string>((resolve) => {
                resolveFirstCreate = resolve;
            }))
            .mockResolvedValueOnce("fresh-terminal-block");
        const model = RightTerminalModel.getInstance();

        model.ensureStarted();
        model.dispose();
        model.ensureStarted();
        await flushPromises();
        resolveFirstCreate("stale-terminal-block");
        await flushPromises();

        expect(mockObjectService.createBlock).toHaveBeenCalledTimes(2);
        expect(mockObjectService.deleteBlock).toHaveBeenCalledWith("stale-terminal-block");
        expect(globalStore.get(model.blockIdAtom)).toBe("fresh-terminal-block");
    });
});
