import { describe, expect, it, vi } from "vitest";
import {
    hydrateWorkspaceContentState,
    makeDefaultWorkspaceContentState,
    normalizeFileTabPath,
    reduceWorkspaceContent,
    resolveActiveContent,
    type PersistedWorkspaceContentState,
    type TopTab,
    type WorkspaceContentState,
} from "./workspace-content-state";

const FileOne: TopTab = { id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" };
const FileTwo: TopTab = { id: "file-2", kind: "file", path: "/tmp/b.ts", title: "b.ts" };

function stateWithTabs(
    topTabs: TopTab[],
    activeContent: WorkspaceContentState["activeContent"] = { kind: "agent" }
): WorkspaceContentState {
    return {
        activeContent,
        topTabs,
        lastActiveTopTabId: activeContent.kind === "top-tab" ? activeContent.topTabId : "",
    };
}

function persisted(overrides: Partial<PersistedWorkspaceContentState> = {}): PersistedWorkspaceContentState {
    return {
        activecontent: { kind: "agent" },
        toptabs: [],
        lastactivetoptabid: "",
        ...overrides,
    };
}

describe("workspace content state", () => {
    it("logs only structured non-sensitive metadata for malformed descriptors", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        hydrateWorkspaceContentState(
            {
                activecontent: { kind: "agent" },
                toptabs: [{ id: "secret-id", kind: "file", path: "secret/relative", title: "secret-title" }],
            },
            ""
        );

        expect(warn).toHaveBeenCalledWith("workspace-top-tab-descriptor-dropped", {
            index: 0,
            kind: "file",
            reason: "invalid-path",
        });
        expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret/);
        warn.mockRestore();
    });

    it("logs duplicate IDs and identities without descriptor secrets", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        hydrateWorkspaceContentState(
            {
                activecontent: { kind: "agent" },
                toptabs: [
                    { id: "secret-first", kind: "file", path: "/secret/first.ts", title: "secret-title" },
                    { id: "secret-first", kind: "preview", path: "/secret/preview.md", title: "secret-preview" },
                    { id: "secret-alias", kind: "file", path: "/secret/first.ts", title: "secret-alias-title" },
                ],
            },
            ""
        );

        expect(warn).toHaveBeenNthCalledWith(1, "workspace-top-tab-descriptor-dropped", {
            index: 1,
            kind: "preview",
            reason: "duplicate-id",
        });
        expect(warn).toHaveBeenNthCalledWith(2, "workspace-top-tab-descriptor-dropped", {
            index: 2,
            kind: "file",
            reason: "duplicate-identity",
        });
        expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret/);
        warn.mockRestore();
    });
    it("activates exactly one content branch and remembers the last active top tab", () => {
        const withFile = reduceWorkspaceContent(makeDefaultWorkspaceContentState(), {
            type: "open-top-tab",
            tab: FileOne,
        });
        const terminal = reduceWorkspaceContent(withFile, {
            type: "activate-terminal",
            terminalTabId: "term-1",
        });
        const agent = reduceWorkspaceContent(terminal, { type: "activate-agent" });

        expect(terminal.activeContent).toEqual({ kind: "terminal", terminalTabId: "term-1" });
        expect(terminal.lastActiveTopTabId).toBe("file-1");
        expect(agent.activeContent).toEqual({ kind: "agent" });
        expect(agent.lastActiveTopTabId).toBe("file-1");
    });

    it("preserves Top Tab descriptor identity across navigation-only actions", () => {
        const initial = stateWithTabs([FileOne, FileTwo]);

        const file = reduceWorkspaceContent(initial, { type: "activate-top-tab", topTabId: "file-2" });
        const agent = reduceWorkspaceContent(file, { type: "activate-agent" });

        expect(file.topTabs).not.toBe(initial.topTabs);
        expect(file.topTabs[0]).toBe(initial.topTabs[0]);
        expect(file.topTabs[1]).toBe(initial.topTabs[1]);
        expect(agent.topTabs[0]).toBe(file.topTabs[0]);
        expect(agent.topTabs[1]).toBe(file.topTabs[1]);
    });

    it("deduplicates files by normalized absolute path and keeps the original tab", () => {
        const once = reduceWorkspaceContent(makeDefaultWorkspaceContentState(), {
            type: "open-top-tab",
            tab: { id: "file-1", kind: "file", path: "/tmp/dir/../a.ts", title: "original" },
        });
        const twice = reduceWorkspaceContent(once, {
            type: "open-top-tab",
            tab: { id: "file-2", kind: "file", path: "\\tmp\\a.ts", title: "replacement" },
        });

        expect(twice.topTabs).toEqual([{ id: "file-1", kind: "file", path: "/tmp/dir/../a.ts", title: "original" }]);
        expect(twice.activeContent).toEqual({ kind: "top-tab", topTabId: "file-1" });
        expect(twice.lastActiveTopTabId).toBe("file-1");
    });

    it("deduplicates previews by normalized absolute path and keeps the original tab", () => {
        const once = reduceWorkspaceContent(makeDefaultWorkspaceContentState(), {
            type: "open-top-tab",
            tab: { id: "preview-1", kind: "preview", path: "/tmp/dir/../preview.md", title: "one" },
        });
        const twice = reduceWorkspaceContent(once, {
            type: "open-top-tab",
            tab: { id: "preview-2", kind: "preview", path: "\\tmp\\preview.md", title: "two" },
        });

        expect(twice.topTabs).toEqual([
            { id: "preview-1", kind: "preview", path: "/tmp/dir/../preview.md", title: "one" },
        ]);
        expect(twice.activeContent).toEqual({ kind: "top-tab", topTabId: "preview-1" });
    });

    it("uses collision-safe git diff tuples with ASCII-only Windows and UNC case folding", () => {
        const tabs: TopTab[] = [
            {
                id: "base",
                kind: "git-diff",
                repoRoot: "C:\\Repo\\.\\",
                path: "src/../app.ts",
                mode: "+",
                originalPath: "src/old.ts",
                title: "Base",
            },
            {
                id: "normalized-equivalent",
                kind: "git-diff",
                repoRoot: "c:/repo",
                path: "app.ts",
                mode: "+",
                originalPath: "src/old.ts",
                title: "Equivalent",
            },
            {
                id: "repo-change",
                kind: "git-diff",
                repoRoot: "C:/other",
                path: "app.ts",
                mode: "+",
                originalPath: "src/old.ts",
                title: "Repo",
            },
            {
                id: "path-change",
                kind: "git-diff",
                repoRoot: "C:/repo",
                path: "other.ts",
                mode: "+",
                originalPath: "src/old.ts",
                title: "Path",
            },
            {
                id: "mode-change",
                kind: "git-diff",
                repoRoot: "C:/repo",
                path: "app.ts",
                mode: "-",
                originalPath: "src/old.ts",
                title: "Mode",
            },
            {
                id: "original-change",
                kind: "git-diff",
                repoRoot: "C:/repo",
                path: "app.ts",
                mode: "+",
                originalPath: "src/older.ts",
                title: "Original",
            },
            {
                id: "delimiter-a",
                kind: "git-diff",
                repoRoot: "C:/repo",
                path: "a\0b",
                mode: "+",
                originalPath: "c",
                title: "Delimiter A",
            },
            {
                id: "delimiter-b",
                kind: "git-diff",
                repoRoot: "C:/repo\0a",
                path: "b",
                mode: "+",
                originalPath: "c",
                title: "Delimiter B",
            },
            {
                id: "unicode-drive-a",
                kind: "git-diff",
                repoRoot: "C:/İ",
                path: "file.ts",
                mode: "+",
                originalPath: "",
                title: "Unicode Drive A",
            },
            {
                id: "unicode-drive-b",
                kind: "git-diff",
                repoRoot: "c:/i\u0307",
                path: "file.ts",
                mode: "+",
                originalPath: "",
                title: "Unicode Drive B",
            },
            {
                id: "unicode-unc-a",
                kind: "git-diff",
                repoRoot: "//Server/İ",
                path: "file.ts",
                mode: "+",
                originalPath: "",
                title: "Unicode UNC A",
            },
            {
                id: "unicode-unc-b",
                kind: "git-diff",
                repoRoot: "//server/i\u0307",
                path: "file.ts",
                mode: "+",
                originalPath: "",
                title: "Unicode UNC B",
            },
        ];

        let state = makeDefaultWorkspaceContentState();
        for (const tab of tabs) {
            state = reduceWorkspaceContent(state, { type: "open-top-tab", tab });
        }

        expect(state.topTabs.map((tab) => tab.id)).toEqual([
            "base",
            "repo-change",
            "path-change",
            "mode-change",
            "original-change",
            "delimiter-a",
            "delimiter-b",
            "unicode-drive-a",
            "unicode-drive-b",
            "unicode-unc-a",
            "unicode-unc-b",
        ]);
    });

    it("closes an active top tab by selecting the right neighbor, then the left neighbor", () => {
        const fileThree: TopTab = { id: "file-3", kind: "file", path: "/tmp/c.ts", title: "c.ts" };
        const middle = stateWithTabs([FileOne, FileTwo, fileThree], {
            kind: "top-tab",
            topTabId: "file-2",
        });
        const right = reduceWorkspaceContent(middle, { type: "close-top-tab", topTabId: "file-2" });
        const end = stateWithTabs([FileOne, FileTwo], { kind: "top-tab", topTabId: "file-2" });
        const left = reduceWorkspaceContent(end, { type: "close-top-tab", topTabId: "file-2" });

        expect(right.activeContent).toEqual({ kind: "top-tab", topTabId: "file-3" });
        expect(left.activeContent).toEqual({ kind: "top-tab", topTabId: "file-1" });
    });

    it("falls back from the final active top tab to a valid terminal, then agent", () => {
        const active = stateWithTabs([FileOne], { kind: "top-tab", topTabId: "file-1" });

        expect(
            reduceWorkspaceContent(active, {
                type: "close-top-tab",
                topTabId: "file-1",
                activeTerminalTabId: "term-1",
            }).activeContent
        ).toEqual({ kind: "terminal", terminalTabId: "term-1" });
        expect(reduceWorkspaceContent(active, { type: "close-top-tab", topTabId: "file-1" }).activeContent).toEqual({
            kind: "agent",
        });
    });

    it("treats untyped non-string terminal fallback IDs as absent when closing", () => {
        const active = stateWithTabs([FileOne], { kind: "top-tab", topTabId: "file-1" });
        const closed = reduceWorkspaceContent(active, {
            type: "close-top-tab",
            topTabId: "file-1",
            activeTerminalTabId: 123,
        } as unknown as Parameters<typeof reduceWorkspaceContent>[1]);

        expect(closed.activeContent).toEqual({ kind: "agent" });
        expect(closed.topTabs).toEqual([]);
    });

    it("resolves valid active content before last top tab, terminal, and agent", () => {
        const activeTop = persisted({
            activecontent: { kind: "top-tab", toptabid: "file-2" },
            toptabs: [
                { id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" },
                { id: "file-2", kind: "file", path: "/tmp/b.ts", title: "b.ts" },
            ],
            lastactivetoptabid: "file-1",
        });
        const missingActive = { ...activeTop, activecontent: { kind: "top-tab", toptabid: "missing" } };
        const withoutTopTabs = persisted({
            activecontent: { kind: "terminal", terminaltabid: "missing-terminal" },
        });

        expect(resolveActiveContent(activeTop, "term-1")).toEqual({
            kind: "top-tab",
            topTabId: "file-2",
        });
        expect(resolveActiveContent(missingActive, "term-1")).toEqual({
            kind: "top-tab",
            topTabId: "file-1",
        });
        expect(resolveActiveContent(withoutTopTabs, "term-1")).toEqual({
            kind: "terminal",
            terminalTabId: "term-1",
        });
        expect(resolveActiveContent(withoutTopTabs, "")).toEqual({ kind: "agent" });
    });

    it("treats non-string terminal IDs as absent at hydrate and resolve boundaries", () => {
        const snapshot = persisted({
            activecontent: { kind: "terminal", terminaltabid: "term-1" },
        });
        const invalidTerminalId = 123 as unknown as string;

        expect(resolveActiveContent(snapshot, invalidTerminalId)).toEqual({ kind: "agent" });
        expect(hydrateWorkspaceContentState(snapshot, invalidTerminalId)).toEqual({
            activeContent: { kind: "agent" },
            topTabs: [],
            lastActiveTopTabId: "",
        });
    });

    it("hydrates descriptors and active content without retaining snapshot references", () => {
        const snapshot = persisted({
            activecontent: { kind: "terminal", terminaltabid: "term-1" },
            toptabs: [
                {
                    id: "diff-1",
                    kind: "git-diff",
                    reporoot: "/repo",
                    path: "src/app.ts",
                    mode: "+",
                    originalpath: "",
                    title: "diff",
                },
            ],
        });
        const hydrated = hydrateWorkspaceContentState(snapshot, "term-1");

        expect(hydrated).toEqual({
            activeContent: { kind: "terminal", terminalTabId: "term-1" },
            topTabs: [
                {
                    id: "diff-1",
                    kind: "git-diff",
                    repoRoot: "/repo",
                    path: "src/app.ts",
                    mode: "+",
                    originalPath: "",
                    title: "diff",
                },
            ],
            lastActiveTopTabId: "",
        });
        expect(hydrated.topTabs).not.toBe(snapshot.toptabs);
    });

    it("strictly hydrates a lowercase immutable agent turn diff descriptor", () => {
        const descriptor = {
            id: "turn-diff-1",
            kind: "agent-turn-diff",
            sessionid: "session-1",
            sessioncreatedat: "2026-08-02T12:00:00.000Z",
            sessioncwd: "/repo",
            sessionpath: "/sessions/session-1.db",
            turnid: "turn-1",
            path: "src/app.ts",
            title: "app.ts",
        };
        const hydrated = hydrateWorkspaceContentState(
            persisted({ activecontent: { kind: "top-tab", toptabid: descriptor.id }, toptabs: [descriptor] }),
            ""
        );

        expect(hydrated).toEqual({
            activeContent: { kind: "top-tab", topTabId: "turn-diff-1" },
            topTabs: [
                {
                    id: "turn-diff-1",
                    kind: "agent-turn-diff",
                    sessionId: "session-1",
                    sessionCreatedAt: "2026-08-02T12:00:00.000Z",
                    sessionCwd: "/repo",
                    sessionPath: "/sessions/session-1.db",
                    turnId: "turn-1",
                    path: "src/app.ts",
                    title: "app.ts",
                },
            ],
            lastActiveTopTabId: "turn-diff-1",
        });
        expect(JSON.stringify(descriptor)).not.toMatch(/sessionId|sessionCreatedAt|sessionCwd|sessionPath|turnId/);
    });

    it("keeps immutable tabs from replacement session generations distinct", () => {
        const base = {
            id: "turn-diff-old",
            kind: "agent-turn-diff",
            sessionid: "session-old",
            sessioncreatedat: "2026-08-02T12:00:00.000Z",
            sessioncwd: "/repo",
            sessionpath: "/sessions/session.db",
            turnid: "turn-1",
            path: "src/app.ts",
            title: "app.ts",
        };
        const replacement = {
            ...base,
            id: "turn-diff-new",
            sessionid: "session-new",
            sessioncreatedat: "2026-08-02T13:00:00.000Z",
        };

        const hydrated = hydrateWorkspaceContentState(persisted({ toptabs: [base, replacement] }), "");

        expect(hydrated.topTabs.map((tab) => tab.id)).toEqual(["turn-diff-old", "turn-diff-new"]);
    });

    it.each(["sessionid", "sessioncreatedat", "sessioncwd", "sessionpath", "turnid", "path"])(
        "drops an agent turn diff descriptor missing %s",
        (field) => {
            const descriptor: Record<string, unknown> = {
                id: "turn-diff-1",
                kind: "agent-turn-diff",
                sessionid: "session-1",
                sessioncreatedat: "2026-08-02T12:00:00.000Z",
                sessioncwd: "/repo",
                sessionpath: "/sessions/session-1.db",
                turnid: "turn-1",
                path: "src/app.ts",
                title: "app.ts",
            };
            delete descriptor[field];

            expect(
                hydrateWorkspaceContentState(
                    persisted({
                        activecontent: { kind: "top-tab", toptabid: "turn-diff-1" },
                        toptabs: [descriptor as any],
                    }),
                    ""
                ).topTabs
            ).toEqual([]);
        }
    );

    it.each([
        ["relative session cwd", { sessioncwd: "repo" }],
        ["relative session path", { sessionpath: "sessions/session-1.db" }],
        ["non-canonical session path", { sessionpath: "/sessions/../session-1.db" }],
        ["non-canonical checkpoint path", { path: "src/../app.ts" }],
        ["escaping checkpoint path", { path: "../app.ts" }],
        ["camelcase persisted field", { sessionid: undefined, sessionId: "session-1" }],
    ])("drops an agent turn diff descriptor with %s", (_name, invalid) => {
        const descriptor = {
            id: "turn-diff-1",
            kind: "agent-turn-diff",
            sessionid: "session-1",
            sessioncreatedat: "2026-08-02T12:00:00.000Z",
            sessioncwd: "/repo",
            sessionpath: "/sessions/session-1.db",
            turnid: "turn-1",
            path: "src/app.ts",
            title: "app.ts",
            ...invalid,
        } as any;

        expect(hydrateWorkspaceContentState(persisted({ toptabs: [descriptor] }), "").topTabs).toEqual([]);
    });

    it("matches backend descriptor validation, ID deduplication, and fallback semantics", () => {
        const snapshot = persisted({
            activecontent: { kind: "top-tab", toptabid: "browser" },
            lastactivetoptabid: "invalid-preview",
            toptabs: [
                { id: "", kind: "file", path: "/tmp/no-id", title: "No ID" },
                { id: "missing-file-path", kind: "file", title: "Invalid File" },
                { id: "invalid-preview", kind: "preview", path: "", title: "Invalid Preview" },
                {
                    id: "browser",
                    kind: "browser",
                    url: "https://example.com",
                    title: "Browser",
                },
                {
                    id: "invalid-diff",
                    kind: "git-diff",
                    reporoot: "/repo",
                    path: "src/app.ts",
                    mode: "x",
                    originalpath: "",
                    title: "Invalid Diff",
                },
                { id: "unknown", kind: "unknown", title: "Unknown" },
                { id: "same-id", kind: "file", path: "", title: "Invalid First" },
                { id: "same-id", kind: "file", path: "/tmp/valid", title: "Valid First" },
                { id: "same-id", kind: "preview", path: "/tmp/duplicate", title: "Duplicate" },
                {
                    id: "valid-diff",
                    kind: "git-diff",
                    reporoot: "/repo",
                    path: "src/app.ts",
                    mode: "-",
                    originalpath: "src/old-app.ts",
                    title: "Diff",
                },
            ],
        });

        expect(hydrateWorkspaceContentState(snapshot, "term-1")).toEqual({
            activeContent: { kind: "terminal", terminalTabId: "term-1" },
            topTabs: [
                { id: "same-id", kind: "file", path: "/tmp/valid", title: "Valid First" },
                {
                    id: "valid-diff",
                    kind: "git-diff",
                    repoRoot: "/repo",
                    path: "src/app.ts",
                    mode: "-",
                    originalPath: "src/old-app.ts",
                    title: "Diff",
                },
            ],
            lastActiveTopTabId: "",
        });
    });

    it("drops every persisted browser descriptor", () => {
        const snapshot = persisted({
            activecontent: { kind: "top-tab", toptabid: "browser" },
            lastactivetoptabid: "browser",
            toptabs: [
                {
                    id: "browser",
                    kind: "browser",
                    url: "https://example.com",
                    title: "Browser",
                },
            ],
        });

        expect(hydrateWorkspaceContentState(snapshot, "term-1")).toEqual({
            activeContent: { kind: "terminal", terminalTabId: "term-1" },
            topTabs: [],
            lastActiveTopTabId: "",
        });
    });

    it("filters null descriptors and relative file or preview paths during hydration", () => {
        const snapshot = persisted({
            toptabs: [
                null,
                { id: "relative", kind: "file", path: "src/file.ts", title: "Relative" },
                { id: "drive-relative", kind: "file", path: "C:src/file.ts", title: "Drive Relative" },
                { id: "relative-preview", kind: "preview", path: "preview.md", title: "Preview" },
                { id: "incomplete-unc", kind: "file", path: "\\\\server", title: "Incomplete UNC" },
                { id: "posix", kind: "file", path: "/tmp/file.ts", title: "POSIX" },
                { id: "drive", kind: "file", path: "C:\\repo\\file.ts", title: "Drive" },
                {
                    id: "unc",
                    kind: "preview",
                    path: "\\\\server\\share\\preview.md",
                    title: "UNC",
                },
            ] as unknown as PersistedWorkspaceContentState["toptabs"],
        });

        expect(hydrateWorkspaceContentState(snapshot, "").topTabs).toEqual([
            { id: "posix", kind: "file", path: "/tmp/file.ts", title: "POSIX" },
            { id: "drive", kind: "file", path: "C:\\repo\\file.ts", title: "Drive" },
            {
                id: "unc",
                kind: "preview",
                path: "\\\\server\\share\\preview.md",
                title: "UNC",
            },
        ]);
    });

    it("restores a valid deduplicated active tab just like the backend normalizer", () => {
        const snapshot = persisted({
            activecontent: { kind: "top-tab", toptabid: "file-1" },
            lastactivetoptabid: "file-1",
            toptabs: [
                { id: "file-1", kind: "file", path: "/tmp/first", title: "First" },
                { id: "file-1", kind: "preview", path: "/tmp/second", title: "Second" },
            ],
        });

        expect(hydrateWorkspaceContentState(snapshot, "")).toEqual({
            activeContent: { kind: "top-tab", topTabId: "file-1" },
            topTabs: [{ id: "file-1", kind: "file", path: "/tmp/first", title: "First" }],
            lastActiveTopTabId: "file-1",
        });
    });

    it("reorders tabs and preserves activation", () => {
        const initial = stateWithTabs([FileOne, FileTwo], { kind: "top-tab", topTabId: "file-1" });
        const reordered = reduceWorkspaceContent(initial, {
            type: "reorder-top-tab",
            topTabId: "file-1",
            targetIndex: 1,
        });

        expect(reordered.topTabs.map((tab) => tab.id)).toEqual(["file-2", "file-1"]);
        expect(reordered.activeContent).toEqual({ kind: "top-tab", topTabId: "file-1" });
    });

    it("updates a descriptor without allowing its identity or kind to change", () => {
        const initial = stateWithTabs([FileOne]);
        const renamed = reduceWorkspaceContent(initial, {
            type: "update-top-tab",
            topTabId: "file-1",
            updates: { kind: "file", title: "renamed.ts", path: "/tmp/renamed.ts" },
        });

        expect(renamed.topTabs).toEqual([{ id: "file-1", kind: "file", path: "/tmp/renamed.ts", title: "renamed.ts" }]);
    });

    it("validates kind-specific descriptor updates at runtime", () => {
        const tabs: TopTab[] = [
            FileOne,
            { id: "preview-1", kind: "preview", path: "/tmp/preview", title: "Preview" },
            {
                id: "diff-1",
                kind: "git-diff",
                repoRoot: "/repo",
                path: "src/app.ts",
                mode: "+",
                originalPath: "",
                title: "Diff",
            },
        ];
        const initial = stateWithTabs(tabs);
        const validActions = [
            {
                type: "update-top-tab",
                topTabId: "preview-1",
                updates: { kind: "preview", path: "/tmp/new-preview", title: "New Preview" },
            },
            {
                type: "update-top-tab",
                topTabId: "diff-1",
                updates: {
                    kind: "git-diff",
                    repoRoot: "/new-repo",
                    path: "src/new-app.ts",
                    mode: "-",
                    originalPath: "src/app.ts",
                    title: "New Diff",
                },
            },
        ] as const;

        let updated = initial;
        for (const action of validActions) {
            updated = reduceWorkspaceContent(updated, action);
        }

        expect(updated.topTabs.slice(1)).toEqual([
            { id: "preview-1", kind: "preview", path: "/tmp/new-preview", title: "New Preview" },
            {
                id: "diff-1",
                kind: "git-diff",
                repoRoot: "/new-repo",
                path: "src/new-app.ts",
                mode: "-",
                originalPath: "src/app.ts",
                title: "New Diff",
            },
        ]);
    });

    it("rejects cross-kind, unknown-field, and backend-invalid updates from untyped callers", () => {
        const initial = stateWithTabs([
            FileOne,
            {
                id: "diff-1",
                kind: "git-diff",
                repoRoot: "/repo",
                path: "src/app.ts",
                mode: "+",
                originalPath: "",
                title: "Diff",
            },
        ]);
        const invalidActions = [
            {
                type: "update-top-tab",
                topTabId: "file-1",
                updates: { kind: "browser", url: "https://example.com" },
            },
            {
                type: "update-top-tab",
                topTabId: "file-1",
                updates: { kind: "file", path: "" },
            },
            {
                type: "update-top-tab",
                topTabId: "file-1",
                updates: { kind: "file", url: "https://cross-kind.example" },
            },
            {
                type: "update-top-tab",
                topTabId: "diff-1",
                updates: { kind: "git-diff", mode: "x" },
            },
            {
                type: "update-top-tab",
                topTabId: "diff-1",
                updates: { kind: "git-diff", path: "" },
            },
        ] as unknown as Parameters<typeof reduceWorkspaceContent>[1][];

        for (const action of invalidActions) {
            const next = reduceWorkspaceContent(initial, action);
            expect(next).toEqual(initial);
            expect(next).not.toBe(initial);
            expect(next.topTabs).not.toBe(initial.topTabs);
        }
    });

    it("rejects browser tabs from untyped callers", () => {
        const initial = stateWithTabs([FileOne]);
        const opened = reduceWorkspaceContent(initial, {
            type: "open-top-tab",
            tab: { id: "browser", kind: "browser", url: "https://example.com", title: "Browser" },
        } as unknown as Parameters<typeof reduceWorkspaceContent>[1]);

        expect(opened).toEqual(initial);
        expect(opened).not.toBe(initial);
    });

    it("rejects null and relative top tabs from untyped open or update actions", () => {
        const initial = stateWithTabs([
            FileOne,
            { id: "preview-1", kind: "preview", path: "/tmp/preview", title: "Preview" },
        ]);
        const invalidActions = [
            null,
            { type: "open-top-tab", tab: null },
            {
                type: "open-top-tab",
                tab: { id: "relative", kind: "file", path: "src/file.ts", title: "Relative" },
            },
            {
                type: "open-top-tab",
                tab: { id: "drive-relative", kind: "file", path: "C:src/file.ts", title: "Relative" },
            },
            {
                type: "update-top-tab",
                topTabId: "file-1",
                updates: { kind: "file", path: "src/new.ts" },
            },
            {
                type: "update-top-tab",
                topTabId: "preview-1",
                updates: { kind: "preview", path: "preview.md" },
            },
        ] as unknown as Parameters<typeof reduceWorkspaceContent>[1][];

        for (const action of invalidActions) {
            const next = reduceWorkspaceContent(initial, action);
            expect(next).toEqual(initial);
            expect(next).not.toBe(initial);
            expect(next.topTabs).not.toBe(initial.topTabs);
        }
    });

    it("rejects a file path update that collides with another normalized file identity", () => {
        const initial = stateWithTabs([
            { id: "file-1", kind: "file", path: "/tmp/a.ts", title: "A" },
            { id: "file-2", kind: "file", path: "/tmp/dir/b.ts", title: "B" },
        ]);
        const next = reduceWorkspaceContent(initial, {
            type: "update-top-tab",
            topTabId: "file-2",
            updates: { kind: "file", path: "/tmp/dir/../a.ts", title: "Collision" },
        });

        expect(next).toEqual(initial);
        expect(next).not.toBe(initial);
        expect(next.topTabs).not.toBe(initial.topTabs);
    });

    it("case-folds drive and UNC file identities but keeps POSIX identities case-sensitive", () => {
        const drive = reduceWorkspaceContent(makeDefaultWorkspaceContentState(), {
            type: "open-top-tab",
            tab: { id: "drive-1", kind: "file", path: "C:\\Repo\\A.ts", title: "Drive" },
        });
        const driveDuplicate = reduceWorkspaceContent(drive, {
            type: "open-top-tab",
            tab: { id: "drive-2", kind: "file", path: "c:/repo/a.ts", title: "Duplicate" },
        });
        const unc = reduceWorkspaceContent(driveDuplicate, {
            type: "open-top-tab",
            tab: { id: "unc-1", kind: "file", path: "\\\\Server\\Share\\A.ts", title: "UNC" },
        });
        const uncDuplicate = reduceWorkspaceContent(unc, {
            type: "open-top-tab",
            tab: { id: "unc-2", kind: "file", path: "//server/share/a.ts", title: "Duplicate" },
        });
        const posix = reduceWorkspaceContent(uncDuplicate, {
            type: "open-top-tab",
            tab: { id: "posix-1", kind: "file", path: "/tmp/A.ts", title: "Upper" },
        });
        const posixDistinct = reduceWorkspaceContent(posix, {
            type: "open-top-tab",
            tab: { id: "posix-2", kind: "file", path: "/tmp/a.ts", title: "Lower" },
        });

        expect(driveDuplicate.topTabs.map((tab) => tab.id)).toEqual(["drive-1"]);
        expect(uncDuplicate.topTabs.map((tab) => tab.id)).toEqual(["drive-1", "unc-1"]);
        expect(posixDistinct.topTabs.map((tab) => tab.id)).toEqual(["drive-1", "unc-1", "posix-1", "posix-2"]);
    });

    it("rejects empty terminal IDs and non-finite or fractional reorder indexes", () => {
        const initial = stateWithTabs([FileOne, FileTwo]);
        const actions = [
            { type: "activate-terminal", terminalTabId: "" },
            { type: "reorder-top-tab", topTabId: "file-1", targetIndex: Number.NaN },
            { type: "reorder-top-tab", topTabId: "file-1", targetIndex: Number.POSITIVE_INFINITY },
            { type: "reorder-top-tab", topTabId: "file-1", targetIndex: 0.5 },
        ] as const;

        for (const action of actions) {
            const next = reduceWorkspaceContent(initial, action);
            expect(next).toEqual(initial);
            expect(next).not.toBe(initial);
            expect(next.topTabs).not.toBe(initial.topTabs);
        }
    });

    it("handles invalid IDs deterministically and always returns fresh containers", () => {
        const initial = stateWithTabs([FileOne]);
        const actions = [
            { type: "activate-top-tab", topTabId: "missing" } as const,
            { type: "close-top-tab", topTabId: "missing" } as const,
            { type: "reorder-top-tab", topTabId: "missing", targetIndex: 0 } as const,
            {
                type: "update-top-tab",
                topTabId: "missing",
                updates: { kind: "file", title: "ignored" },
            } as const,
        ];

        for (const action of actions) {
            const next = reduceWorkspaceContent(initial, action);
            expect(next).toEqual(initial);
            expect(next).not.toBe(initial);
            expect(next.topTabs).not.toBe(initial.topTabs);
        }
    });

    it("never mutates input state or tab descriptors", () => {
        const initial = stateWithTabs([FileOne, FileTwo]);
        const before = structuredClone(initial);

        reduceWorkspaceContent(initial, {
            type: "update-top-tab",
            topTabId: "file-1",
            updates: { kind: "file", title: "changed" },
        });
        reduceWorkspaceContent(initial, {
            type: "reorder-top-tab",
            topTabId: "file-1",
            targetIndex: 1,
        });

        expect(initial).toEqual(before);
    });
});

describe("normalizeFileTabPath", () => {
    it.each([
        ["/tmp/./dir/../a.ts", "/tmp/a.ts"],
        ["\\tmp\\dir\\..\\a.ts", "/tmp/a.ts"],
        ["/../../a.ts", "/a.ts"],
        ["../../a.ts", "a.ts"],
        ["C:\\repo\\.\\src\\..\\a.ts", "C:/repo/a.ts"],
        ["C:\\..\\a.ts", "C:/a.ts"],
        ["c:\\repo\\..\\A.ts", "c:/A.ts"],
        ["\\\\server\\share\\..\\a.ts", "//server/share/a.ts"],
        ["\\\\server\\share\\dir\\..\\..\\..\\a.ts", "//server/share/a.ts"],
        ["/", "/"],
        ["", ""],
    ])("normalizes %j within its root boundary", (input, expected) => {
        expect(normalizeFileTabPath(input)).toBe(expected);
    });
});
