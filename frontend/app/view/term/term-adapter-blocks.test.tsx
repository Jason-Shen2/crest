// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0
//
// D9 view-type merge: the term adapter drives XtermView's `blocks` prop
// from block meta `term:blocks` — on by default, only an explicit false
// disables the command-block decorations.

import { globalStore } from "@/app/store/jotaiStore";
import { Provider, type PrimitiveAtom } from "jotai";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
    xtermProps: [] as Record<string, unknown>[],
    metaAtoms: new Map<string, unknown>(),
}));

vi.mock("@/app/block/block", () => ({
    SubBlock: () => null,
}));

vi.mock("@/app/xterm/xterm-view", () => ({
    XtermView: (props: Record<string, unknown>) => {
        captured.xtermProps.push(props);
        return null;
    },
}));

vi.mock("@/app/xterm/cmdblock-rows", async () => {
    const jotai = await import("jotai");
    return {
        attachCmdRows: vi.fn(),
        detachCmdRows: vi.fn(),
        lastCommandAtom: () => jotai.atom(""),
        shellIntegrationSeenAtom: () => jotai.atom(false),
    };
});

vi.mock("@/store/global", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/store/global")>();
    const jotai = await import("jotai");
    const settingsAtom = jotai.atom(undefined);
    return {
        ...actual,
        getBlockMetaKeyAtom: (blockId: string, key: string) => {
            const cacheKey = blockId + "|" + key;
            let metaAtom = captured.metaAtoms.get(cacheKey);
            if (metaAtom == null) {
                metaAtom = jotai.atom(undefined);
                captured.metaAtoms.set(cacheKey, metaAtom);
            }
            return metaAtom;
        },
        // the real one reads atoms.settingsAtom, which only exists after
        // initGlobal() runs at app boot
        getSettingsKeyAtom: () => settingsAtom,
    };
});

import { getBlockMetaKeyAtom } from "@/store/global";
import { TermViewModel } from "./term-model";

function renderAdapter(blockId: string): Record<string, unknown> {
    captured.xtermProps.length = 0;
    const model = new TermViewModel({ blockId } as ViewModelInitType);
    const ViewComp = model.viewComponent as React.FC<{ model: TermViewModel }>;
    renderToStaticMarkup(
        <Provider store={globalStore}>
            <ViewComp model={model} />
        </Provider>
    );
    expect(captured.xtermProps.length).toBe(1);
    return captured.xtermProps[0];
}

describe("term adapter blocks decorations (D9)", () => {
    it("enables blocks by default when term:blocks is unset", () => {
        const props = renderAdapter("block-default");
        expect(props.blocks).toBe(true);
        expect(props.outerBlockId).toBe("block-default");
    });

    it("disables blocks when term:blocks meta is false", () => {
        const metaAtom = getBlockMetaKeyAtom("block-off", "term:blocks") as PrimitiveAtom<boolean>;
        globalStore.set(metaAtom, false);

        const props = renderAdapter("block-off");
        expect(props.blocks).toBe(false);
    });

    it("keeps blocks on for any non-false meta value", () => {
        const metaAtom = getBlockMetaKeyAtom("block-on", "term:blocks") as PrimitiveAtom<boolean>;
        globalStore.set(metaAtom, true);

        const props = renderAdapter("block-on");
        expect(props.blocks).toBe(true);
    });
});
