// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { setWaveWindowType } from "@/app/store/windowtype";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeMockWaveEnv } from "@/preview/mock/mockwaveenv";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VTab, VTabItem } from "./vtab";
import { resetVTabName, VTabBar } from "./vtabbar";

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

function tab(oid: string, name: string, blockids: string[], meta: MetaType = {}): Tab {
    return {
        otype: "tab",
        oid,
        version: 1,
        name,
        blockids,
        meta,
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

    it("preserves a manual tab name T1 when tab:autoname is false", () => {
        const markup = renderVTabBar(
            [
                tab("manual-t1-tab", "T1", ["manual-t1-block"], {
                    "tab:autoname": false,
                } as MetaType),
            ],
            [
                block("manual-t1-block", {
                    view: "codeeditor",
                    file: "/repo/src/not-the-tab-title.ts",
                } as MetaType),
            ]
        );

        expect(markup).toContain("T1");
        expect(markup).not.toContain("not-the-tab-title.ts");
    });

    it("resets manual codeeditor tab names back to auto-derived labels", async () => {
        const tabId = "manual-editor-reset-tab";
        const blockId = "manual-editor-reset-block";
        const updateTabName = vi.fn().mockResolvedValue(undefined);
        const setMeta = vi.fn().mockResolvedValue(undefined);

        await resetVTabName(
            {
                rpc: {
                    UpdateTabNameCommand: updateTabName,
                    SetMetaCommand: setMeta,
                },
            } as any,
            tabId,
            "T1"
        );

        expect(updateTabName.mock.calls[0]?.slice(1)).toEqual([tabId, "T1"]);
        expect(setMeta.mock.calls[0]?.[1]).toEqual({
            oref: `tab:${tabId}`,
            meta: { "tab:autoname": true },
        });
        expect(updateTabName.mock.invocationCallOrder[0]).toBeLessThan(
            setMeta.mock.invocationCallOrder[0]
        );

        const manualMarkup = renderVTabBar(
            [
                tab(tabId, "T1", [blockId], {
                    "tab:autoname": false,
                } as MetaType),
            ],
            [
                block(blockId, {
                    view: "codeeditor",
                    file: "/repo/src/restored-label.ts",
                } as MetaType),
            ]
        );
        const resetMarkup = renderVTabBar(
            [
                tab(tabId, "T1", [blockId], {
                    "tab:autoname": true,
                } as MetaType),
            ],
            [
                block(blockId, {
                    view: "codeeditor",
                    file: "/repo/src/restored-label.ts",
                } as MetaType),
            ]
        );

        expect(manualMarkup).toContain("T1");
        expect(manualMarkup).not.toContain("restored-label.ts");
        expect(resetMarkup).toContain("restored-label.ts");
        expect(resetMarkup).not.toContain(">T1<");
    });
});
