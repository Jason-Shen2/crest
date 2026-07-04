// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeMockWaveEnv } from "@/preview/mock/mockwaveenv";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { setWaveWindowType } from "@/app/store/windowtype";
import { VTab, VTabItem } from "./vtab";
import { VTabBar } from "./vtabbar";

const OriginalCss = globalThis.CSS;
const HexColorRegex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

function renderVTab(tab: VTabItem): string {
    return renderToStaticMarkup(
        <VTab
            tab={tab}
            active={false}
            isDragging={false}
            isReordering={false}
            onSelect={() => null}
            onDragStart={() => null}
            onDragOver={() => null}
            onDrop={() => null}
            onDragEnd={() => null}
        />
    );
}

function renderVTabBar(tabs: Tab[], blocks: Block[]): string {
    const workspaceId = "workspace-vtab-test";
    const env = makeMockWaveEnv({
        tabId: tabs[0]?.oid ?? "",
        mockWaveObjs: {
            [`workspace:${workspaceId}`]: {
                otype: "workspace",
                oid: workspaceId,
                version: 1,
                name: "VTab Test Workspace",
                tabids: tabs.map((tab) => tab.oid),
                activetabid: tabs[0]?.oid ?? "",
                meta: {},
            } as Workspace,
            ...Object.fromEntries(tabs.map((tab) => [`tab:${tab.oid}`, tab])),
            ...Object.fromEntries(blocks.map((block) => [`block:${block.oid}`, block])),
        },
    });
    const workspace = env.mockEnv.mockWaveObjs[`workspace:${workspaceId}`] as Workspace;
    return renderToStaticMarkup(
        <WaveEnvContext.Provider value={env}>
            <VTabBar workspace={workspace} />
        </WaveEnvContext.Provider>
    );
}

function tab(oid: string, name: string, blockids: string[]): Tab {
    return {
        otype: "tab",
        oid,
        version: 1,
        name,
        blockids,
        meta: {},
    } as Tab;
}

function block(oid: string, meta: MetaType): Block {
    return {
        otype: "block",
        oid,
        version: 1,
        meta,
    } as Block;
}

describe("VTab badges", () => {
    beforeAll(() => {
        globalThis.CSS = {
            supports: (_property: string, value: string) => HexColorRegex.test(value),
        } as typeof CSS;
    });

    afterAll(() => {
        globalThis.CSS = OriginalCss;
    });

    it("renders shared badges and a validated flag badge", () => {
        const markup = renderVTab({
            id: "tab-1",
            name: "Build Logs",
            badges: [{ badgeid: "badge-1", icon: "bell", color: "#f59e0b", priority: 2 }],
            flagColor: "#429DFF",
        });

        expect(markup).toContain("#429DFF");
        expect(markup).toContain("#f59e0b");
        expect(markup).toContain("rounded-full");
    });

    it("ignores invalid flag colors", () => {
        const markup = renderVTab({
            id: "tab-2",
            name: "Deploy",
            badges: [{ badgeid: "badge-2", icon: "bell", color: "#4ade80", priority: 2 }],
            flagColor: "definitely-not-a-color",
        });

        expect(markup).not.toContain("definitely-not-a-color");
        expect(markup).not.toContain("fa-flag");
        expect(markup).toContain("#4ade80");
    });
});

describe("VTabBar tab labels", () => {
    beforeAll(() => {
        setWaveWindowType("preview");
    });

    afterAll(() => {
        setWaveWindowType("tab");
    });

    it("uses the first codeeditor block basename for default tabs granularity only when the tab is auto-named", () => {
        const markup = renderVTabBar(
            [
                tab("auto-editor-tab", "T1", ["auto-editor-block"]),
                tab("manual-editor-tab", "Pinned Editor", ["manual-editor-block"]),
                tab("auto-terminal-tab", "T3", ["terminal-block"]),
            ],
            [
                block("auto-editor-block", {
                    view: "codeeditor",
                    file: "/repo/src/editor.ts",
                } as MetaType),
                block("manual-editor-block", {
                    view: "codeeditor",
                    file: "/repo/src/manual.ts",
                } as MetaType),
                block("terminal-block", {
                    view: "term",
                    "cmd:cwd": "/repo",
                } as MetaType),
            ]
        );

        expect(markup).toContain("editor.ts");
        expect(markup).toContain("Pinned Editor");
        expect(markup).not.toContain("manual.ts");
        expect(markup).toContain("/repo");
    });
});
