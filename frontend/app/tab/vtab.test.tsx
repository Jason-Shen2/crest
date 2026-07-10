// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { setWaveWindowType } from "@/app/store/windowtype";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeMockWaveEnv } from "@/preview/mock/mockwaveenv";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Tab as TabComponent } from "./tab";
import { VTab, VTabItem } from "./vtab";
import { blockViewToUIcon, resolvePaneVTabItem, VTabBar, resetVTabName } from "./vtabbar";

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

function renderTab(tabData: Tab, blocks: Block[] = []): string {
    const env = makeMockWaveEnv({
        tabId: tabData.oid,
        mockWaveObjs: {
            [`tab:${tabData.oid}`]: tabData,
            ...Object.fromEntries(blocks.map((blockData) => [`block:${blockData.oid}`, blockData])),
        },
    });
    return renderToStaticMarkup(
        <WaveEnvContext.Provider value={env}>
            <TabComponent
                id={tabData.oid}
                active={false}
                showDivider={false}
                isDragging={false}
                tabWidth={160}
                isNew={false}
                onSelect={() => null}
                onClose={() => null}
                onDragStart={() => null}
                onLoaded={() => null}
            />
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
                tab("auto-editor-tab", "", ["auto-editor-block"], {
                    "tab:autoname": true,
                } as MetaType),
                tab("manual-editor-tab", "Pinned Editor", ["manual-editor-block"]),
                tab("auto-terminal-tab", "", ["terminal-block"], {
                    "tab:autoname": true,
                } as MetaType),
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

    it("does not expose generated names while auto tab block metadata is pending", () => {
        const markup = renderVTabBar(
            [
                tab("pending-auto-tab", "T1", ["pending-auto-block"], {
                    "tab:autoname": true,
                } as MetaType),
            ],
            [
                block("pending-auto-block", {
                    view: "term",
                } as MetaType),
            ]
        );

        expect(markup).toContain("Terminal");
        expect(markup).not.toContain(">T1<");
    });

    it("mock tab rename preserves meta and marks the tab name manual", async () => {
        const tabId = "mock-rename-tab";
        const env = makeMockWaveEnv({
            tabId,
            mockWaveObjs: {
                [`tab:${tabId}`]: tab(tabId, "T1", [], {
                    "tab:autoname": true,
                    "tab:color": "blue",
                } as MetaType),
            },
        });

        await env.rpc.UpdateTabNameCommand(null as any, tabId, "Manual name");

        const updated = globalStore.get(env.wos.getWaveObjectAtom<Tab>(`tab:${tabId}`));
        expect(updated.name).toBe("Manual name");
        expect(updated.meta).toEqual({
            "tab:autoname": false,
            "tab:color": "blue",
        });
    });

    it("resets manual codeeditor tab names back to auto-derived labels", async () => {
        const tabId = "manual-editor-reset-tab";
        const blockId = "manual-editor-reset-block";
        const updateTabName = vi.fn().mockResolvedValue(undefined);
        const setMeta = vi.fn().mockResolvedValue(undefined);
        const resetTabName = vi.fn().mockResolvedValue(undefined);

        await resetVTabName(
            {
                rpc: {
                    UpdateTabNameCommand: updateTabName,
                    SetMetaCommand: setMeta,
                    ResetTabNameCommand: resetTabName,
                },
            } as any,
            tabId,
            ""
        );

        expect(resetTabName.mock.calls[0]?.slice(1)).toEqual([tabId, ""]);
        expect(updateTabName).not.toHaveBeenCalled();
        expect(setMeta).not.toHaveBeenCalled();

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

describe("pane tab metadata", () => {
    it("treats agent panes like terminal panes for cwd labels and git metadata", () => {
        const tabItem = resolvePaneVTabItem({
            view: "agent",
            cwdShort: "/repo",
            gitBranchName: "main",
            isRepo: true,
            primaryInfo: "workingdir",
            compactSubtitle: "branch",
            viewMode: "expanded",
            blockMeta: {},
            flagColor: null,
            showDiffStats: false,
        });

        expect(tabItem.name).toBe("/repo");
        expect(tabItem.subtitle).toBe("/repo");
        expect(tabItem.metadataLeftKind).toBe("branch");
        expect(tabItem.metadataLeftValue).toBe("main");
        expect(tabItem.iconName).toBe("sparkle");
    });

    it("uses the agent icon in panes mode", () => {
        expect(blockViewToUIcon("agent")).toBe("sparkle");
    });
});

describe("Tab labels", () => {
    it("renders the first codeeditor block basename for auto-named tabs", () => {
        const markup = renderTab(
            tab("top-auto-editor-tab", "T1", ["top-auto-editor-block"], {
                "tab:autoname": true,
            } as MetaType),
            [
                block("top-auto-editor-block", {
                    view: "codeeditor",
                    file: "/repo/src/app.ts",
                } as MetaType),
            ]
        );

        expect(markup).toContain("app.ts");
        expect(markup).not.toContain(">T1<");
    });

    it("preserves manual tab names when tab:autoname is false", () => {
        const markup = renderTab(
            tab("top-manual-editor-tab", "Pinned Editor", ["top-manual-editor-block"], {
                "tab:autoname": false,
            } as MetaType),
            [
                block("top-manual-editor-block", {
                    view: "codeeditor",
                    file: "/repo/src/app.ts",
                } as MetaType),
            ]
        );

        expect(markup).toContain("Pinned Editor");
        expect(markup).not.toContain("app.ts");
    });

    it("preserves T-number tab names when tab:autoname is missing", () => {
        const markup = renderTab(
            tab("top-legacy-editor-tab", "T7", ["top-legacy-editor-block"]),
            [
                block("top-legacy-editor-block", {
                    view: "codeeditor",
                    file: "/repo/src/legacy.ts",
                } as MetaType),
            ]
        );

        expect(markup).toContain("T7");
        expect(markup).not.toContain("legacy.ts");
    });
});
