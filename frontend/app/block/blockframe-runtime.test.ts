// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { describe, expect, it } from "vitest";

const RuntimeModulePath = "./blockframe-runtime";

describe("legacy BlockFrame auxiliary panel bridge", () => {
    it("preserves legacy panel visibility and can release the injected handler", async () => {
        const { bindBlockFrameAuxiliaryPanelVisibility, blockFrameAuxiliaryPanelVisibleAtom } = await import(
            RuntimeModulePath
        );
        const legacyPanelVisibleAtom = atom(false);
        const unsubscribe = bindBlockFrameAuxiliaryPanelVisibility(legacyPanelVisibleAtom);

        expect(globalStore.get(blockFrameAuxiliaryPanelVisibleAtom)).toBe(false);
        globalStore.set(legacyPanelVisibleAtom, true);
        expect(globalStore.get(blockFrameAuxiliaryPanelVisibleAtom)).toBe(true);

        unsubscribe();
        globalStore.set(legacyPanelVisibleAtom, false);
        expect(globalStore.get(blockFrameAuxiliaryPanelVisibleAtom)).toBe(true);
    });
});
