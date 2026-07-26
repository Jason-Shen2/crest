// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0
//
// TermBlocksViewModel — compatibility shim.  The block registry still
// resolves view type "termblocks" through this model so existing
// block.meta.view fields round-trip; rendering is delegated entirely to
// the pooled xterm engine in frontend/app/xterm/.  The legacy in-file
// implementation (2.7k lines of xterm.js + agent timeline + snackbar
// variants + …) was removed — see git history if you need to revive any of
// it.
//
// The model intentionally exposes a *minimal* public surface: blockId so
// the adapter can address the right outer block, and termFontSizeAtom so
// the view picks up runtime font-size overrides.  Everything else the old
// model owned (block list, output cache, wps subscriptions, polling, alt-
// screen state, agent chat) lives in frontend/app/xterm/xterm-session.ts
// and its renderer pool.

import { getBlockMetaKeyAtom, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { XtermView } from "@/app/xterm/xterm-view";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";

export class TermBlocksViewModel implements ViewModel {
    readonly viewType = "termblocks";
    readonly blockId: string;

    readonly viewIcon = jotai.atom("terminal");
    readonly viewName = jotai.atom("");
    readonly noPadding = jotai.atom(true);

    readonly termFontSizeAtom: jotai.Atom<number>;
    readonly focusRequestAtom = jotai.atom(0);

    disposed = false;

    constructor({ blockId }: ViewModelInitType) {
        this.blockId = blockId;
        const metaAtom = getBlockMetaKeyAtom(blockId, "term:fontsize");
        const settingAtom = getSettingsKeyAtom("term:fontsize");
        this.termFontSizeAtom = jotai.atom((get) => {
            const override = get(metaAtom);
            if (typeof override === "number") return override;
            const fallback = get(settingAtom);
            return typeof fallback === "number" ? fallback : 16;
        });
    }

    get viewComponent(): ViewComponent {
        return TerminalViewAdapter as unknown as ViewComponent;
    }

    giveFocus(): boolean {
        globalStore.set(this.focusRequestAtom, (prev) => prev + 1);
        return true;
    }

    dispose(): void {
        this.disposed = true;
    }
}

// TerminalViewAdapter — bridge from the registry's
// ViewComponentProps<TermBlocksViewModel> shape to the engine-side
// XtermView, pulling just the two pieces of state the view needs.
const TerminalViewAdapter: React.FC<{ model: TermBlocksViewModel }> = ({ model }) => {
    const fontSize = useAtomValue(model.termFontSizeAtom);
    const focusRequest = useAtomValue(model.focusRequestAtom);
    return <XtermView outerBlockId={model.blockId} fontSize={fontSize} focusRequest={focusRequest} />;
};
TerminalViewAdapter.displayName = "TerminalViewAdapter";
