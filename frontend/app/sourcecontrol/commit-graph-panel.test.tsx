import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CommitDetailForTest, CommitRowForTest, commitRowClickActionForTest } from "./commit-graph-panel";

vi.mock("@/app/icon/Icon", () => ({
    Icon: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {},
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {},
}));

describe("CommitDetail", () => {
    it("renders terax-style commit metadata actions and files", () => {
        const html = renderToStaticMarkup(
            <CommitDetailForTest
                commit={{
                    sha: "33a2cf2764",
                    shortsha: "33a2cf2",
                    author: "zhenxing.shen",
                    authoremail: "zhenxing.shen@bytedance.com",
                    timestampsecs: 1782528060,
                    parents: [],
                    subject: "docs: trim generic Promise/event explanations, keep refactor-relevant causality",
                    fileschanged: 1,
                    insertions: 3,
                    deletions: 2,
                }}
                filesEntry={{
                    state: "loaded",
                    files: [
                        {
                            path: "docs/agent-timeline-single-source.md",
                            originalpath: "",
                            status: "M",
                            statuslabel: "Modified",
                            added: 3,
                            removed: 2,
                            isbinary: false,
                        },
                    ],
                }}
                remoteWeb={{
                    host: "github",
                    hostname: "github.com",
                    owner: "owner",
                    repo: "repo",
                    baseUrl: "https://github.com/owner/repo",
                }}
                onCopySha={() => undefined}
                onOpenFile={() => undefined}
                onRetryFiles={() => undefined}
            />
        );

        expect(html).toContain("Copy SHA");
        expect(html).toContain("View on GitHub");
        expect(html).toContain("Files");
        expect(html).toContain("agent-timeline-single-source.md");
        expect(html).toContain("Modified");
        expect(html).toContain("+3");
        expect(html).toContain("−2");
    });

    it("does not use a fullscreen overlay that blocks commit row hover", () => {
        const source = readFileSync(new URL("./commit-graph-panel.tsx", import.meta.url), "utf8");

        expect(source).not.toContain("fixed inset-0 z-40");
        expect(source).not.toContain('aria-label="Close commit detail"');
    });

    it("uses a readable near-opaque background for the commit detail popover", () => {
        const source = readFileSync(new URL("./commit-graph-panel.tsx", import.meta.url), "utf8");

        expect(source).toContain("bg-background/95");
        expect(source).not.toContain('backgroundColor: "var(--color-panel)"');
    });
});

describe("CommitRow", () => {
    it("clears the current selection before allowing another commit selection", () => {
        expect(commitRowClickActionForTest(null, false)).toBe("select");
        expect(commitRowClickActionForTest("33a2cf2764", false)).toBe("clear");
        expect(commitRowClickActionForTest(null, true)).toBe("clear");
    });

    it("renders terax-style changes column after date", () => {
        const html = renderToStaticMarkup(
            <CommitRowForTest
                commit={{
                    sha: "33a2cf2764",
                    shortsha: "33a2cf2",
                    author: "zhenxing.shen",
                    authoremail: "zhenxing.shen@bytedance.com",
                    timestampsecs: 1782528060,
                    parents: [],
                    subject: "docs: update commit graph",
                    fileschanged: 2,
                    insertions: 3,
                    deletions: 2,
                }}
                graphRow={null}
                maxLaneCount={1}
                start={0}
                active={false}
                onClick={() => undefined}
                onHoverEnter={() => undefined}
                onHoverLeave={() => undefined}
            />
        );

        expect(html).toContain("file-01");
        expect(html).toContain(">2<");
        expect(html).toContain("+3");
        expect(html).toContain("−2");
    });
});
