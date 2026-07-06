import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceControlFileEntry, SourceControlModel } from "./source-control-model";

const mockOpenGitDiffTab = vi.hoisted(() => vi.fn());

vi.mock("@/app/fileexplorer/file-explorer-atoms", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    return {
        workspaceDirAtom: jotaiActual.atom(""),
    };
});

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {},
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { routeid: "tab" },
}));

vi.mock("./open-git-diff-tab", () => ({
    openGitDiffTab: mockOpenGitDiffTab,
}));

describe("SourceControlModel", () => {
    beforeEach(() => {
        mockOpenGitDiffTab.mockReset();
        mockOpenGitDiffTab.mockResolvedValue({ tabId: "tab-1", created: true });
        const model = SourceControlModel.getInstance();
        globalStore.set(model.selectedpathAtom, null);
        globalStore.set(model.repoAtom, null);
        globalStore.set(model.viewAtom, "changes");
    });

    it("keeps the selected source control view across panel remounts", () => {
        const model = SourceControlModel.getInstance();

        expect(globalStore.get(model.viewAtom)).toBe("changes");
        globalStore.set(model.viewAtom, "graph");
        expect(globalStore.get(SourceControlModel.getInstance().viewAtom)).toBe("graph");

        globalStore.set(model.viewAtom, "changes");
    });

    it("selects an unstaged entry and opens an unstaged git diff tab", () => {
        const model = SourceControlModel.getInstance();
        globalStore.set(model.repoAtom, { reporoot: "/repo" } as GitRepoInfo);

        model.selectEntry(makeEntry({ path: "src/app.ts", unstaged: true, staged: false }));

        expect(globalStore.get(model.selectedpathAtom)).toBe("src/app.ts");
        expect(mockOpenGitDiffTab).toHaveBeenCalledWith({
            repoRoot: "/repo",
            path: "src/app.ts",
            mode: "-",
            originalPath: null,
        });
    });

    it("selects a staged entry and opens a staged git diff tab with original path", () => {
        const model = SourceControlModel.getInstance();
        globalStore.set(model.repoAtom, { reporoot: "/repo" } as GitRepoInfo);

        model.selectEntry(
            makeEntry({ path: "src/new.ts", originalpath: "src/old.ts", unstaged: false, staged: true })
        );

        expect(globalStore.get(model.selectedpathAtom)).toBe("src/new.ts");
        expect(mockOpenGitDiffTab).toHaveBeenCalledWith({
            repoRoot: "/repo",
            path: "src/new.ts",
            mode: "+",
            originalPath: "src/old.ts",
        });
    });

    it("keeps selection but does not open a diff when there is no repo", () => {
        const model = SourceControlModel.getInstance();

        model.selectEntry(makeEntry({ path: "src/app.ts" }));

        expect(globalStore.get(model.selectedpathAtom)).toBe("src/app.ts");
        expect(mockOpenGitDiffTab).not.toHaveBeenCalled();
    });
});

function makeEntry(overrides: Partial<SourceControlFileEntry>): SourceControlFileEntry {
    return {
        key: overrides.path ?? "src/app.ts",
        path: "src/app.ts",
        originalpath: null,
        statuscode: "M",
        statuslabel: "Modified",
        checkstate: "unchecked",
        staged: false,
        unstaged: true,
        untracked: false,
        indexstatus: " ",
        worktreestatus: "M",
        ...overrides,
    };
}
