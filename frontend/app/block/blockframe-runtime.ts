// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type Atom } from "jotai";

export const blockFrameAuxiliaryPanelVisibleAtom = atom(false);

export function bindBlockFrameAuxiliaryPanelVisibility(sourceAtom: Atom<boolean>): () => void {
    const sync = () => {
        globalStore.set(blockFrameAuxiliaryPanelVisibleAtom, globalStore.get(sourceAtom));
    };
    sync();
    return globalStore.sub(sourceAtom, sync);
}
