// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AddProviderMenu — "+ Add provider" trigger + popover listing the
// catalog providers the user hasn't yet connected.  Mirrors
// terax-ai AddProviderMenu in trigger shape and content layout, but
// crest's catalog is a single set of cloud providers (no cloud/local
// split) — see `addable` rendering.
//
// On top of the catalog picks, the menu always exposes a trailing
// "OpenAI Compatible" item that emits `onAddCompat()`.  The parent
// turns that into a fresh `custom_endpoints[uuid]` entry rendered by
// `CustomEndpointCard` instead of a catalog card.  The catalog list
// adapts as the user connects/disconnects providers — when everything
// in the catalog is connected, only the OpenAI-Compatible item
// remains.
//
// The menu emits `onAdd(providerId)` for catalog entries; the parent
// flips that id into its `adding` set, which causes the corresponding
// ProviderKeyCard to appear in `initiallyEditing` mode.

import { Popover, PopoverButton, PopoverContent } from "@/element/popover";
import { Icon } from "@/app/icon/Icon";
import { CATALOG } from "@/app/store/ai-catalog";
import { ProviderIcon, type ProviderId } from "./ProviderIcon";

type Props = {
    // Provider ids the user has not yet connected.  The menu renders
    // exactly these — empty set means "everything is connected, no
    // catalog menu content needed" (the OpenAI-Compatible item is
    // still shown so the user can keep adding custom endpoints).
    addableProviderIds: ProviderId[];
    onAdd: (id: ProviderId) => void;
    onAddCompat: () => void;
};

export function AddProviderMenu({ addableProviderIds, onAdd, onAddCompat }: Props) {
    const addable = addableProviderIds
        .map((id) => CATALOG.find((p) => p.id === id))
        .filter((p) => p != null) as typeof CATALOG;

    return (
        <Popover placement="bottom-end" offset={6}>
            <PopoverButton className="h-7 cursor-pointer gap-1.5 rounded-full border border-border/60 bg-transparent px-3 text-[11px] text-foreground outline-none transition-colors hover:bg-white/[0.04]">
                <Icon name="add-01" size={12} strokeWidth={2} />
                Add provider
            </PopoverButton>
            <PopoverContent className="min-w-55 p-1">
                {addable.map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        onClick={() => onAdd(p.id as ProviderId)}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-white/[0.04]"
                    >
                        <ProviderIcon provider={p.id} size={13} />
                        <span>{p.displayName}</span>
                    </button>
                ))}
                {addable.length > 0 ? (
                    <div className="my-1 h-px bg-border/60" aria-hidden="true" />
                ) : null}
                <button
                    type="button"
                    onClick={onAddCompat}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-white/[0.04]"
                >
                    <ProviderIcon provider="openai-compatible" size={13} />
                    <span>OpenAI Compatible</span>
                </button>
            </PopoverContent>
        </Popover>
    );
}