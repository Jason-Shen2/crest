// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/block/block", () => ({
    SubBlock: () => null,
}));

vi.mock("@/app/term/render/terminal-view", () => ({
    TerminalView: () => null,
}));

import { TermBlocksViewModel } from "@/app/view/termblocks/termblocks";
import { TermViewModel } from "./term-model";

describe("terminal view focus", () => {
    it("requests command input focus through the term view model", () => {
        const model = new TermViewModel({ blockId: "block-1" } as ViewModelInitType);
        const before = globalStore.get(model.focusRequestAtom);

        expect(model.giveFocus()).toBe(true);

        expect(globalStore.get(model.focusRequestAtom)).toBe(before + 1);
    });

    it("requests command input focus through the termblocks view model", () => {
        const model = new TermBlocksViewModel({ blockId: "block-2" } as ViewModelInitType);
        const before = globalStore.get(model.focusRequestAtom);

        expect(model.giveFocus()).toBe(true);

        expect(globalStore.get(model.focusRequestAtom)).toBe(before + 1);
    });
});
