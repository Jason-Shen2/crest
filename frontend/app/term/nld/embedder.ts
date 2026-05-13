// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// NldClassifier registry.  The active classifier is a process-wide
// singleton because the underlying ONNX model is ~110 MB and we don't
// want to instantiate it per pane.

import * as jotai from "jotai";
import type { NldClassifier } from "./types";

// Set to true when the active classifier reports ready (model + tokenizer
// loaded and one successful inference round-trip).  UI subscribes to
// flip the Auto toggle on once tier-2 is usable.
export const embedderReadyAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;

// No-op classifier used at startup before the real one is wired and in
// tests.  `ready === false` makes the tier-2 path short-circuit to the
// tier-1 verdict (or NEUTRAL when ambiguous), so the input bar still
// works without the classifier.
export class StubClassifier implements NldClassifier {
    readonly ready = false;
    async classify(): Promise<null> {
        return null;
    }
    dispose(): void {}
}

let active: NldClassifier = new StubClassifier();

export function getClassifier(): NldClassifier {
    return active;
}

export function setClassifier(next: NldClassifier): void {
    if (active !== next) {
        active.dispose();
        active = next;
    }
}

// Back-compat aliases — older imports said `getEmbedder` / `setEmbedder`
// / `StubEmbedder`.  Keep one release of aliases for the in-flight
// renames; remove after.
export { getClassifier as getEmbedder };
export { setClassifier as setEmbedder };
export { StubClassifier as StubEmbedder };
