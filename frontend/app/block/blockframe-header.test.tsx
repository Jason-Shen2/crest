// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BlockFrame_Header } from "./blockframe-header";

vi.mock("@/app/block/blockutil", () => ({
    blockViewToIcon: () => "",
    blockViewToName: () => "Terminal",
    getViewIconElem: () => null,
    OptMagnifyButton: () => <button title="Magnify Block" />,
    renderHeaderElements: () => [],
}));

vi.mock("@/app/block/connectionbutton", () => ({
    ConnectionButton: () => null,
}));

vi.mock("@/app/block/durable-session-flyover", () => ({
    DurableSessionFlyover: () => null,
}));

vi.mock("@/app/icon/Icon", () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock("@/app/store/badge", () => ({
    getBlockBadgeAtom: () => atom(null),
}));

vi.mock("@/app/store/global", () => ({
    createBlockSplitHorizontally: vi.fn(),
    createBlockSplitVertically: vi.fn(),
    recordTEvent: vi.fn(),
    refocusNode: vi.fn(),
    WOS: {
        getWaveObjectAtom: () => atom(null),
        makeORef: () => "block:test-block",
    },
}));

vi.mock("@/app/store/jotaiStore", () => ({
    globalStore: {
        get: () => false,
    },
}));

vi.mock("@/app/store/keymodel", () => ({
    uxCloseBlock: vi.fn(),
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {},
}));

vi.mock("@/app/waveenv/waveenv", () => ({
    useWaveEnv: () => ({
        getBlockMetaKeyAtom: () => atom(undefined),
        getSettingsKeyAtom: () => atom(false),
        rpc: { ActivityCommand: vi.fn() },
        showContextMenu: vi.fn(),
    }),
}));

vi.mock("@/element/iconbutton", () => ({
    IconButton: ({ decl, className }: { decl: IconButtonDecl; className?: string }) => (
        <button className={className} title={decl.title} data-icon={decl.icon}>
            {decl.title}
        </button>
    ),
}));

function makeNodeModel() {
    return {
        blockId: "test-block",
        dragHandleRef: createRef<HTMLDivElement>(),
        isEphemeral: atom(false),
        isMagnified: atom(false),
        numLeafs: atom(2),
        toggleMagnify: vi.fn(),
    };
}

describe("BlockFrame_Header", () => {
    it("does not render a settings button in the block header", () => {
        const html = renderToStaticMarkup(
            <BlockFrame_Header
                nodeModel={makeNodeModel() as any}
                viewModel={{ viewType: "term" } as any}
                preview={false}
                connBtnRef={createRef<HTMLDivElement>()}
                changeConnModalAtom={atom(false)}
            />
        );

        expect(html).not.toContain("Settings");
        expect(html).not.toContain("block-frame-settings");
    });
});
