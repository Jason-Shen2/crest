// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWorkspaceTopTabController } from "./top-tab-controller";
import type { TopTab } from "./workspace-content-state";

const TurnDiffTabId = "00000000-0000-4000-8000-000000000001";
const DistinctTurnDiffTabIds = [
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004",
    "00000000-0000-4000-8000-000000000005",
    "00000000-0000-4000-8000-000000000006",
    "00000000-0000-4000-8000-000000000007",
] as const;

afterEach(() => {
    vi.unstubAllGlobals();
});

function makeModel(initialTabs: TopTab[] = []) {
    let teardown: () => void = () => {};
    const contentStateAtom = atom({
        activeContent: { kind: "agent" } as const,
        topTabs: initialTabs,
        lastActiveTopTabId: "",
    });
    return {
        model: {
            contentStateAtom,
            openTopTab: vi.fn((tab: TopTab) => {
                const current = globalStore.get(contentStateAtom);
                globalStore.set(contentStateAtom, { ...current, topTabs: [...current.topTabs, tab] });
            }),
            activateTopTab: vi.fn(),
            closeTopTab: vi.fn((topTabId: string) => {
                const current = globalStore.get(contentStateAtom);
                globalStore.set(contentStateAtom, {
                    ...current,
                    topTabs: current.topTabs.filter((tab) => tab.id !== topTabId),
                });
            }),
            updateTopTab: vi.fn((topTabId: string, updates: Partial<TopTab>) => {
                const current = globalStore.get(contentStateAtom);
                globalStore.set(contentStateAtom, {
                    ...current,
                    topTabs: current.topTabs.map((tab) =>
                        tab.id === topTabId ? ({ ...tab, ...updates } as TopTab) : tab
                    ),
                });
            }),
            registerPreReplacementTeardown: vi.fn((callback: () => void) => {
                teardown = callback;
                return () => {};
            }),
        },
        get tabs() {
            return globalStore.get(contentStateAtom).topTabs;
        },
        dispose: () => teardown(),
    };
}

describe("WorkspaceTopTabController", () => {
    it("rejects relocating a warm File onto a cold File descriptor identity", () => {
        const fixture = makeModel([
            { id: "warm", kind: "file", path: "/repo/warm.ts", title: "warm.ts" },
            { id: "cold", kind: "file", path: "/repo/cold.ts", title: "cold.ts" },
        ]);
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();

        expect(controller.relocateFile("warm", "/repo/cold.ts")).toBe(false);
        expect(fixture.model.updateTopTab).not.toHaveBeenCalled();
        expect(fixture.tabs[0].path).toBe("/repo/warm.ts");
    });

    it("constructs without subscribing or registering workspace teardown", () => {
        const fixture = makeModel();
        const subscribe = vi.spyOn(globalStore, "sub");
        const controller = makeWorkspaceTopTabController(fixture.model);

        expect(subscribe).not.toHaveBeenCalled();
        expect(fixture.model.registerPreReplacementTeardown).not.toHaveBeenCalled();
        expect(() => controller.openFile("/repo/not-attached.ts")).toThrow("Workspace Top Tab controller is disposed");

        controller.start();
        expect(fixture.model.registerPreReplacementTeardown).toHaveBeenCalledOnce();
        subscribe.mockRestore();
    });

    it("generates one stable ID for a normalized File identity", () => {
        const fixture = makeModel();
        const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue("file-id");
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();

        const first = controller.openFile("/repo/src/app.ts");
        const second = controller.openFile("/repo/src/../src/app.ts");

        expect(first).toBe("file-id");
        expect(second).toBe(first);
        expect(randomUUID).toHaveBeenCalledOnce();
        expect(fixture.model.openTopTab).toHaveBeenCalledOnce();
        expect(fixture.tabs).toEqual([{ id: "file-id", kind: "file", path: "/repo/src/app.ts", title: "app.ts" }]);
        expect(fixture.model.activateTopTab).toHaveBeenCalledWith("file-id");
    });

    it("preserves successful open and activate results when tracing clocks and marks throw", () => {
        vi.stubGlobal("performance", {
            now: () => {
                throw new Error("clock failed");
            },
            mark: () => {
                throw new Error("mark failed");
            },
        });
        const fixture = makeModel();
        vi.spyOn(crypto, "randomUUID").mockReturnValue("file-id");
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();

        expect(controller.openFile("/repo/a.ts")).toBe("file-id");
        expect(() => controller.activate("file-id")).not.toThrow();
        expect(fixture.model.activateTopTab).toHaveBeenCalledWith("file-id");
    });

    it("deduplicates concurrent File, Preview, and full Git Diff identities independently", () => {
        const fixture = makeModel();
        vi.spyOn(crypto, "randomUUID")
            .mockReturnValueOnce("file-id")
            .mockReturnValueOnce("preview-id")
            .mockReturnValueOnce("diff-id")
            .mockReturnValueOnce("diff-original-id");
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();

        expect(controller.openFile("/repo/a.ts")).toBe(controller.openFile("/repo/./a.ts"));
        expect(controller.openPreview("/repo/a.ts")).toBe(controller.openPreview("/repo/./a.ts"));
        expect(controller.openGitDiff({ repoRoot: "/repo", path: "a.ts", mode: "+", originalPath: "old/a.ts" })).toBe(
            controller.openGitDiff({
                repoRoot: "/repo/.",
                path: "./a.ts",
                mode: "+",
                originalPath: "old/./a.ts",
            })
        );
        expect(controller.openGitDiff({ repoRoot: "/repo", path: "a.ts", mode: "+", originalPath: "older/a.ts" })).toBe(
            "diff-original-id"
        );
        expect(fixture.model.openTopTab).toHaveBeenCalledTimes(4);
    });

    it("deduplicates immutable turn diffs by canonical session path, turn, and checkpoint path", () => {
        const fixture = makeModel();
        vi.spyOn(crypto, "randomUUID").mockReturnValue(TurnDiffTabId);
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();
        const sessionMetadata = {
            id: "session-1",
            createdAt: "2026-08-02T12:00:00.000Z",
            cwd: "/repo",
            path: "/sessions/session-1.db",
        };

        const first = controller.openAgentTurnDiff({ sessionMetadata, turnId: "turn-1", path: "src/app.ts" });
        const second = controller.openAgentTurnDiff({
            sessionMetadata: { ...sessionMetadata, path: "/sessions/./session-1.db" },
            turnId: "turn-1",
            path: "src/app.ts",
        });

        expect(second).toBe(first);
        expect(fixture.tabs).toEqual([
            {
                id: TurnDiffTabId,
                kind: "agent-turn-diff",
                sessionId: "session-1",
                sessionCreatedAt: "2026-08-02T12:00:00.000Z",
                sessionCwd: "/repo",
                sessionPath: "/sessions/session-1.db",
                turnId: "turn-1",
                path: "src/app.ts",
                title: "app.ts",
            },
        ]);
        expect(fixture.model.activateTopTab).toHaveBeenCalledWith(TurnDiffTabId);
    });

    it("keeps different immutable turn diff identities distinct", () => {
        const fixture = makeModel();
        vi.spyOn(crypto, "randomUUID")
            .mockReturnValueOnce(DistinctTurnDiffTabIds[0])
            .mockReturnValueOnce(DistinctTurnDiffTabIds[1])
            .mockReturnValueOnce(DistinctTurnDiffTabIds[2])
            .mockReturnValueOnce(DistinctTurnDiffTabIds[3])
            .mockReturnValueOnce(DistinctTurnDiffTabIds[4])
            .mockReturnValueOnce(DistinctTurnDiffTabIds[5]);
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();
        const sessionMetadata = { id: "s1", createdAt: "now", cwd: "/repo", path: "/sessions/a.db" };

        controller.openAgentTurnDiff({ sessionMetadata, turnId: "t1", path: "src/a.ts" });
        controller.openAgentTurnDiff({
            sessionMetadata: { ...sessionMetadata, path: "/sessions/b.db" },
            turnId: "t1",
            path: "src/a.ts",
        });
        controller.openAgentTurnDiff({
            sessionMetadata: { ...sessionMetadata, id: "s2" },
            turnId: "t1",
            path: "src/a.ts",
        });
        controller.openAgentTurnDiff({
            sessionMetadata: { ...sessionMetadata, createdAt: "later" },
            turnId: "t1",
            path: "src/a.ts",
        });
        controller.openAgentTurnDiff({ sessionMetadata, turnId: "t2", path: "src/a.ts" });
        controller.openAgentTurnDiff({ sessionMetadata, turnId: "t1", path: "src/b.ts" });

        expect(fixture.tabs.map((tab) => tab.id)).toEqual(DistinctTurnDiffTabIds);
    });

    it("activates an existing identity without creating another descriptor", () => {
        const fixture = makeModel([
            { id: "persisted-preview", kind: "preview", path: "/repo/README.md", title: "README.md" },
        ]);
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();

        expect(controller.openPreview("/repo/./README.md")).toBe("persisted-preview");
        expect(fixture.model.openTopTab).not.toHaveBeenCalled();
        expect(fixture.model.activateTopTab).toHaveBeenCalledWith("persisted-preview");
    });

    it("rejects operations after workspace disposal and clears owned identities", async () => {
        const fixture = makeModel();
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();
        controller.openFile("/repo/a.ts");

        fixture.dispose();

        expect(() => controller.openFile("/repo/b.ts")).toThrow("Workspace Top Tab controller is disposed");
        expect(() => controller.activate("missing")).toThrow("Workspace Top Tab controller is disposed");
        await expect(controller.close("missing")).rejects.toThrow("Workspace Top Tab controller is disposed");
    });

    it("reports whether close removed a controller-owned Top Tab", async () => {
        const fixture = makeModel();
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();
        const id = controller.openFile("/repo/a.ts");

        await expect(controller.close(id)).resolves.toBe(true);
        await expect(controller.close(id)).resolves.toBe(false);
    });

    it.each([
        [
            "relative File",
            (controller: ReturnType<typeof makeWorkspaceTopTabController>) => controller.openFile("src/a.ts"),
        ],
        ["empty Preview", (controller: ReturnType<typeof makeWorkspaceTopTabController>) => controller.openPreview("")],
        [
            "empty Git Diff",
            (controller: ReturnType<typeof makeWorkspaceTopTabController>) =>
                controller.openGitDiff({ repoRoot: "", path: "", mode: "+" }),
        ],
        [
            "invalid Git Diff mode",
            (controller: ReturnType<typeof makeWorkspaceTopTabController>) =>
                controller.openGitDiff({ repoRoot: "/repo", path: "a.ts", mode: "invalid" as any }),
        ],
    ])("rejects %s input without allocating or caching an ID", (_name, open) => {
        const fixture = makeModel();
        const randomUUID = vi.spyOn(crypto, "randomUUID");
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();

        expect(() => open(controller)).toThrow("Invalid Top Tab descriptor");
        expect(fixture.model.openTopTab).not.toHaveBeenCalled();
        expect(randomUUID).not.toHaveBeenCalled();
    });

    it("does not cache a phantom ID when the model silently rejects a descriptor", () => {
        const fixture = makeModel();
        fixture.model.openTopTab.mockImplementation(() => {});
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();

        expect(() => controller.openFile("/repo/rejected.ts")).toThrow("Workspace model rejected Top Tab");
        expect(() => controller.openFile("/repo/rejected.ts")).toThrow("Workspace model rejected Top Tab");
        expect(fixture.model.openTopTab).toHaveBeenCalledTimes(2);
        expect(fixture.model.activateTopTab).not.toHaveBeenCalled();
    });

    it("does not cache a phantom ID when the model throws", () => {
        const fixture = makeModel();
        fixture.model.openTopTab.mockImplementation(() => {
            throw new Error("model failed");
        });
        const controller = makeWorkspaceTopTabController(fixture.model);
        controller.start();

        expect(() => controller.openFile("/repo/throws.ts")).toThrow("model failed");
        expect(() => controller.openFile("/repo/throws.ts")).toThrow("model failed");
        expect(fixture.model.openTopTab).toHaveBeenCalledTimes(2);
        expect(fixture.model.activateTopTab).not.toHaveBeenCalled();
    });
});
