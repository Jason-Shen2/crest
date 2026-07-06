// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { atoms } from "@/store/global";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findGitDiffTab, openGitDiffTab } from "./open-git-diff-tab";

const mockServices = vi.hoisted(() => ({
    CreateTabWithBlock: vi.fn(),
}));

const mockElectronApi = vi.hoisted(() => ({
    setActiveTab: vi.fn(),
}));

vi.mock("@/app/store/windowtype", () => ({
    isPreviewWindow: () => true,
    setWaveWindowType: vi.fn(),
}));

vi.mock("@/app/store/services", () => ({
    WorkspaceService: mockServices,
}));

vi.mock("@/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    return {
        atoms: {
            workspace: jotaiActual.atom(null),
        },
        getApi: () => mockElectronApi,
        globalStore: (await vi.importActual<typeof import("@/app/store/jotaiStore")>("@/app/store/jotaiStore"))
            .globalStore,
    };
});

describe("open git diff tab from source control", () => {
    let consoleWarn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.restoreAllMocks();
        consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        mockServices.CreateTabWithBlock.mockReset();
        mockElectronApi.setActiveTab.mockReset();
        globalStore.set(atoms.workspace as any, {
            oid: "workspace-1",
            tabids: ["tab-1", "tab-2", "tab-3"],
        } as Workspace);
        updateWaveObject<Tab>("tab", "tab-1", {
            blockids: ["block-1"],
        });
        updateWaveObject<Tab>("tab", "tab-2", {
            blockids: ["block-2"],
        });
        updateWaveObject<Tab>("tab", "tab-3", {
            blockids: ["block-3"],
        });
        updateWaveObject<Block>("block", "block-1", {
            meta: { view: "termblocks", "cmd:cwd": "/repo" },
        });
        updateWaveObject<Block>("block", "block-2", {
            meta: {
                view: "gitdiff",
                "gitdiff:repo": "/repo",
                "gitdiff:path": "src/app.ts",
                "gitdiff:mode": "-",
                "gitdiff:originalpath": "",
                connection: "",
            },
        });
        updateWaveObject<Block>("block", "block-3", {
            meta: {
                view: "gitdiff",
                "gitdiff:repo": "/repo",
                "gitdiff:path": "src/app.ts",
                "gitdiff:mode": "+",
                "gitdiff:originalpath": "",
                connection: "",
            },
        });
    });

    afterEach(() => {
        consoleWarn.mockRestore();
        vi.restoreAllMocks();
    });

    it("finds an existing gitdiff tab for the same repo, path, and mode", async () => {
        await expect(findGitDiffTab({ repoRoot: "/repo", path: "src/app.ts", mode: "-" })).resolves.toBe("tab-2");
    });

    it("activates an existing gitdiff tab instead of creating a duplicate", async () => {
        const result = await openGitDiffTab({ repoRoot: "/repo", path: "src/app.ts", mode: "-" });

        expect(result).toEqual({ tabId: "tab-2", created: false });
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledWith("tab-2");
        expect(mockServices.CreateTabWithBlock).not.toHaveBeenCalled();
    });

    it("keeps staged and unstaged diffs in separate tabs", async () => {
        const result = await openGitDiffTab({ repoRoot: "/repo", path: "src/app.ts", mode: "+" });

        expect(result).toEqual({ tabId: "tab-3", created: false });
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledWith("tab-3");
        expect(mockServices.CreateTabWithBlock).not.toHaveBeenCalled();
    });

    it("does not reuse a renamed diff tab with a different original path", async () => {
        updateWaveObject<Block>("block", "block-2", {
            meta: {
                view: "gitdiff",
                "gitdiff:repo": "/repo",
                "gitdiff:path": "src/app.ts",
                "gitdiff:mode": "-",
                "gitdiff:originalpath": "src/old-app.ts",
                connection: "",
            },
        });
        mockServices.CreateTabWithBlock.mockResolvedValue("tab-4");

        const result = await openGitDiffTab({
            repoRoot: "/repo",
            path: "src/app.ts",
            mode: "-",
            originalPath: "src/other-app.ts",
        });

        expect(result).toEqual({ tabId: "tab-4", created: true });
        expect(mockServices.CreateTabWithBlock).toHaveBeenCalledWith("workspace-1", "", false, {
            meta: expect.objectContaining({
                "gitdiff:originalpath": "src/other-app.ts",
            }),
        });
    });

    it("creates a gitdiff tab when the matching diff is not already open", async () => {
        mockServices.CreateTabWithBlock.mockResolvedValue("tab-4");

        const result = await openGitDiffTab({
            repoRoot: "/repo",
            path: "src/new.ts",
            mode: "-",
            originalPath: "src/old.ts",
        });

        expect(result).toEqual({ tabId: "tab-4", created: true });
        expect(mockServices.CreateTabWithBlock).toHaveBeenCalledWith("workspace-1", "", false, {
            meta: {
                view: "gitdiff",
                "gitdiff:repo": "/repo",
                "gitdiff:path": "src/new.ts",
                "gitdiff:mode": "-",
                "gitdiff:originalpath": "src/old.ts",
                connection: "",
            },
        });
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledWith("tab-4");
    });

    it("deduplicates concurrent creates for the same repo, path, mode, and workspace", async () => {
        globalStore.set(atoms.workspace as any, {
            oid: "workspace-1",
            tabids: [],
        } as Workspace);
        const createTab = deferred<string>();
        mockServices.CreateTabWithBlock.mockReturnValue(createTab.promise);

        const firstOpen = openGitDiffTab({ repoRoot: "/repo", path: "src/new.ts", mode: "-" });
        const secondOpen = openGitDiffTab({ repoRoot: "/repo", path: "src/new.ts", mode: "-" });
        await Promise.resolve();

        expect(mockServices.CreateTabWithBlock).toHaveBeenCalledTimes(1);

        createTab.resolve("tab-4");
        const [firstResult, secondResult] = await Promise.all([firstOpen, secondOpen]);

        expect(firstResult).toEqual({ tabId: "tab-4", created: true });
        expect(secondResult).toEqual({ tabId: "tab-4", created: true });
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledTimes(1);
        expect(mockElectronApi.setActiveTab).toHaveBeenCalledWith("tab-4");
    });
});

function updateWaveObject<T extends WaveObj>(otype: string, oid: string, obj: Partial<T>): void {
    const value = {
        otype,
        oid,
        version: Date.now(),
        meta: {},
        ...obj,
    } as T;
    const oref = WOS.makeORef(otype, oid);
    WOS.mockObjectForPreview(oref, value);
    WOS.getWaveObjectAtom<T>(oref);
    WOS.setObjectValue(value);
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
