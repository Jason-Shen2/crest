// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

const RegistryModulePath = "@/app/block/blockregistry";
const TerminalRegistryModulePath = "@/app/block/terminal-blockregistry";

describe("Terminal block registry", () => {
    beforeEach(async () => {
        window.api = {
            getHomeDir: () => "/home/test",
        } as ElectronApi;
        const { clearBlockViewModels } = await import(RegistryModulePath);
        clearBlockViewModels();
    });

    it("registers only Terminal-compatible block views", async () => {
        const { getRegisteredBlockViewTypes } = await import(RegistryModulePath);
        const { registerTerminalBlockViewModels } = await import(TerminalRegistryModulePath);

        registerTerminalBlockViewModels();

        expect(getRegisteredBlockViewTypes()).toEqual(["term", "termblocks"]);
    });
});
