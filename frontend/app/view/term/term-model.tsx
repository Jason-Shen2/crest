// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0
//
// TermViewModel — compatibility shim for the "term" view type.  The block
// registry still resolves `view: "term"` to this class so existing
// block.meta values round-trip; rendering is delegated to the pooled xterm
// engine in frontend/app/xterm/ via the XtermView component, the same engine
// that powers the "termblocks" view type.
//
// The legacy implementation lived in this file plus a dozen siblings
// (term.tsx / termwrap.ts / termutil.ts / term-agent.tsx / …, ~5k LOC
// total) and wrapped @xterm/xterm directly.  All of that was deleted as
// part of Track A of the terminal-engine migration (see
// docs/term-engine-migration.md).
//
// **Surface kept for back-compat** (external consumers — do not remove
// without checking these touch-points):
//   - tabrpcclient.ts:               termRef.current.shellIntegrationStatusAtom
//                                    termRef.current.lastCommandAtom
//   - durable-session-flyover.tsx:   restartSessionWithDurability / forceRestartController
//                                    termDurableStatus / termConfigedDurable
//   - blockframe-header.tsx:         viewType === "term", termConfigedDurable
//   - blockregistry.ts:              the class itself, registered for "term"
//
// **Surface removed** — the legacy model exposed dozens of atoms tied to
// xterm internals (connStatus, shellProcFullStatus, blockJobStatusAtom,
// nodeModel, tabModel, termMode, sessionDurable, …).  Most callers were
// inside the deleted view files.  The few external readers above are the
// only contracts kept.

import { SubBlock } from "@/app/block/block";
import type { BlockNodeModel } from "@/app/block/blocktypes";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { XtermView } from "@/app/xterm/xterm-view";
import {
    atoms,
    getBlockMetaKeyAtom,
    getBlockTermDurableAtom,
    getSettingsKeyAtom,
    WOS,
} from "@/store/global";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import * as React from "react";

// Placeholder atoms returned by the termRef stub.  External readers
// (tabrpcclient.ts builds a context payload by reading these) treat empty
// values as "no shell integration data yet" and skip the field — which is
// the right behavior until the new engine surfaces equivalents via the
// block lifecycle.  A future revision can read from TerminalModel's
// active block to populate these for real.
const PlaceholderShellIntegrationAtom = jotai.atom("none");
const PlaceholderLastCommandAtom = jotai.atom("");

// Shape compatible with the legacy `TermWrap` ref.  Only the two atom
// fields actually read externally are present; everything else (terminal
// instance, hoveredLinkUri, etc.) is gone — anyone reaching deeper into
// this object was inside the deleted view files.
interface TermRefStub {
    shellIntegrationStatusAtom: jotai.Atom<string>;
    lastCommandAtom: jotai.Atom<string>;
}

export class TermViewModel implements ViewModel {
    readonly viewType = "term";
    readonly blockId: string;

    readonly viewIcon = jotai.atom("terminal");
    readonly viewName = jotai.atom("");
    readonly noPadding = jotai.atom(true);

    readonly termFontSizeAtom: jotai.Atom<number>;
    readonly focusRequestAtom = jotai.atom(0);

    // Durable-session UI surface.  `termConfigedDurable` is a real atom
    // reading block.meta["term:durable"]; `termDurableStatus` is the
    // running daemon's status which we leave null for now (Track A
    // doesn't migrate the block-job polling — durable-session-flyover
    // will gracefully show no live status, while the toggle on the block
    // header still works because `termConfigedDurable` is live).
    readonly termDurableStatus: jotai.Atom<BlockJobStatusData | null>;
    readonly termConfigedDurable: jotai.Atom<null | boolean>;

    // External callers (tabrpcclient.ts) reach through `termRef.current.*`
    // for context — keep the shape, point the atoms at placeholders.  The
    // object is a plain literal, not a React.RefObject, because no consumer
    // actually mutates `current`.
    readonly termRef: { current: TermRefStub } = {
        current: {
            shellIntegrationStatusAtom: PlaceholderShellIntegrationAtom,
            lastCommandAtom: PlaceholderLastCommandAtom,
        },
    };

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

        this.termConfigedDurable = getBlockTermDurableAtom(blockId);
        this.termDurableStatus = jotai.atom(null) as jotai.Atom<BlockJobStatusData | null>;
    }

    get viewComponent(): ViewComponent {
        return TermViewAdapter as unknown as ViewComponent;
    }

    // forceRestartController — kept as-is from the legacy model.  The
    // RPC sequence (Destroy then Resync with `forcerestart: true`) is the
    // shell-controller contract; rebuilding it on the new engine would
    // be redundant.  The new TerminalModel inside the rendered view
    // handles its own ControllerResync at mount.
    async forceRestartController(): Promise<void> {
        if (this.disposed) return;
        try {
            await RpcApi.ControllerDestroyCommand(TabRpcClient, this.blockId);
            await RpcApi.ControllerResyncCommand(TabRpcClient, {
                tabid: globalStore.get(atoms.staticTabId),
                blockid: this.blockId,
                forcerestart: true,
            });
        } catch (e) {
            console.warn("term-model: forceRestartController failed", e);
        }
    }

    async restartSessionWithDurability(isDurable: boolean): Promise<void> {
        if (this.disposed) return;
        try {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", this.blockId),
                meta: { "term:durable": isDurable },
            });
            await this.forceRestartController();
        } catch (e) {
            console.warn("term-model: restartSessionWithDurability failed", e);
        }
    }

    giveFocus(): boolean {
        globalStore.set(this.focusRequestAtom, (prev) => prev + 1);
        return true;
    }

    dispose(): void {
        this.disposed = true;
    }
}

// TermViewAdapter — bridges the registry's `ViewComponentProps<TermViewModel>`
// shape into the engine-side XtermView (the pooled xterm engine in
// frontend/app/xterm/).  Adds the "term"-view-only integrations on top:
//
//   - `term:mode = "vdom"` + `term:vdomblockid`     → full-pane VDom replace
//   - `term:vdomtoolbarblockid`                     → VDom subblock as toolbar strip
//
// Workspace stickers (`term:stickers`) are not yet ported — see
// docs/term-engine-migration.md (Track B).
const TermViewAdapter: React.FC<{ model: TermViewModel }> = ({ model }) => {
    const fontSize = useAtomValue(model.termFontSizeAtom);
    const focusRequest = useAtomValue(model.focusRequestAtom);
    const blockId = model.blockId;
    const termMode = useAtomValue(getBlockMetaKeyAtom(blockId, "term:mode")) as string | undefined;
    const vdomBlockId = useAtomValue(getBlockMetaKeyAtom(blockId, "term:vdomblockid")) as string | undefined;
    const vdomToolbarBlockId = useAtomValue(
        getBlockMetaKeyAtom(blockId, "term:vdomtoolbarblockid")
    ) as string | undefined;

    const replaceContent =
        termMode === "vdom" && vdomBlockId ? (
            <VDomSubBlock parentBlockId={blockId} vdomBlockId={vdomBlockId} metaKey="term:vdomblockid" />
        ) : undefined;

    const topSlot = vdomToolbarBlockId ? (
        <div className="shrink-0 border-b border-fg-overlay-2">
            <VDomSubBlock
                parentBlockId={blockId}
                vdomBlockId={vdomToolbarBlockId}
                metaKey="term:vdomtoolbarblockid"
            />
        </div>
    ) : undefined;

    return (
        <XtermView
            outerBlockId={blockId}
            fontSize={fontSize}
            focusRequest={focusRequest}
            replaceContent={replaceContent}
            topSlot={topSlot}
        />
    );
};
TermViewAdapter.displayName = "TermViewAdapter";

// VDomSubBlock — mounts a SubBlock and listens for its closure to scrub
// the parent block's meta key.  Mirrors the legacy term.tsx pattern: host
// block owns the subblock pointer, subblock close → meta clears.
interface VDomSubBlockProps {
    parentBlockId: string;
    vdomBlockId: string;
    // The meta field on parent that points at this subblock.  Cleared on
    // subblock close so we don't leave dangling references.
    metaKey: string;
}

const VDomSubBlock = React.memo(({ parentBlockId, vdomBlockId, metaKey }: VDomSubBlockProps) => {
    React.useEffect(() => {
        const unsub = waveEventSubscribeSingle({
            eventType: "blockclose",
            scope: WOS.makeORef("block", vdomBlockId),
            handler: () => {
                const meta: Record<string, unknown> = { [metaKey]: null };
                if (metaKey === "term:vdomblockid") {
                    meta["term:mode"] = null;
                }
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("block", parentBlockId),
                    meta,
                }).catch(() => {
                    // best-effort cleanup; meta will be reconciled next mount
                });
            },
        });
        return () => unsub();
    }, [parentBlockId, vdomBlockId, metaKey]);

    const nodeModel: BlockNodeModel = React.useMemo(
        () => ({
            blockId: vdomBlockId,
            isFocused: jotai.atom(false),
            isMagnified: jotai.atom(false),
            focusNode: () => {},
            toggleMagnify: () => {},
            onClose: () => {
                RpcApi.DeleteSubBlockCommand(TabRpcClient, { blockid: vdomBlockId }).catch(() => {});
            },
        }),
        [vdomBlockId]
    );

    return <SubBlock nodeModel={nodeModel} />;
});
VDomSubBlock.displayName = "VDomSubBlock";
