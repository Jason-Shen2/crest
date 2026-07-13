// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentSelectorRequest } from "@/app/term/render/agent-chat-host";
import {
    AgentSelectorPanel,
    SessionSelector,
    COMMAND_SELECTOR_INLINE_CLASSNAME,
    commitAgentSelectorPick,
    editorTextFromAgentSelectorResult,
    getAgentSelectorTitle,
    getInitialAgentSelectorFocusEntryId,
    getResumeSessionDisplayText,
    isAgentSelectorGlobalNavigationKey,
    shouldAllowAgentSelectorCancel,
    type AgentSelectorViewState,
} from "./session-selector";

describe("agent selector popover", () => {
    it("commits tree picks through navigateTree", async () => {
        const navigateTree = vi.fn(async () => ({
            sessionMetadata: { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" },
            editorText: "restore this",
        }));
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn(),
            navigateTree,
        };

        await expect(commitAgentSelectorPick(request, "entry-1")).resolves.toEqual({
            sessionMetadata: { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" },
            editorText: "restore this",
        });

        expect(navigateTree).toHaveBeenCalledWith("entry-1");
    });

    it("commits fork picks through forkSession so the host switches session", async () => {
        const forkSession = vi.fn(async () => ({
            sessionMetadata: { id: "s2", createdAt: "now", cwd: "/repo", path: "/tmp/fork.jsonl" },
            selectedText: "previous prompt",
        }));
        const request: AgentSelectorRequest = {
            type: "fork",
            listForkPoints: vi.fn(),
            forkSession,
        };

        await expect(commitAgentSelectorPick(request, "entry-2")).resolves.toEqual({
            sessionMetadata: { id: "s2", createdAt: "now", cwd: "/repo", path: "/tmp/fork.jsonl" },
            selectedText: "previous prompt",
        });

        expect(forkSession).toHaveBeenCalledWith("entry-2");
    });

    it("commits resume picks through resumeSession so the host switches session", async () => {
        const resumed = { id: "s3", createdAt: "now", cwd: "/repo", path: "/tmp/resume.jsonl" };
        const resumeSession = vi.fn(async () => ({ sessionMetadata: resumed }));
        const request: AgentSelectorRequest = {
            type: "resume",
            cwd: "/repo",
            listSessions: vi.fn(),
            resumeSession,
        };

        await expect(
            commitAgentSelectorPick(request, "0", [{ id: "0", preview: "/repo", sessionMetadata: resumed }])
        ).resolves.toEqual({
            sessionMetadata: resumed,
        });

        expect(resumeSession).toHaveBeenCalledWith(resumed);
    });

    it("renders a cancellable tree selector without committing a prompt", () => {
        const state: AgentSelectorViewState = {
            status: "ready",
            entries: [
                {
                    id: "root",
                    role: "user",
                    preview: "first prompt",
                    isLeaf: false,
                    isCurrent: false,
                },
                {
                    id: "leaf",
                    parentId: "root",
                    role: "assistant",
                    label: "current",
                    preview: "latest answer",
                    isLeaf: true,
                    isCurrent: true,
                },
            ],
        };

        const html = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="tree"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
            />
        );

        expect(html).toContain("first prompt");
        expect(html).toContain("latest answer");
        expect(html).toContain('role="listbox"');
        expect(html).toContain('tabindex="-1"');
        expect(html).toContain('data-agent-selector-row="root"');
        expect(html).toContain('data-agent-selector-current="true"');
        expect(html).toContain("focus:outline-none");
    });

    it("uses the same inline-above-input contract as the model picker", () => {
        expect(COMMAND_SELECTOR_INLINE_CLASSNAME).toContain("rounded-2xl");
        expect(COMMAND_SELECTOR_INLINE_CLASSNAME).toContain("border-white/[0.12]");
        expect(COMMAND_SELECTOR_INLINE_CLASSNAME).toContain("bg-[rgba(34,34,36,0.62)]");
        expect(COMMAND_SELECTOR_INLINE_CLASSNAME).toContain("backdrop-blur-2xl");
        expect(COMMAND_SELECTOR_INLINE_CLASSNAME).toContain("shadow-[0_10px_32px_-24px");
        expect(COMMAND_SELECTOR_INLINE_CLASSNAME).not.toContain("border-t");
        expect(COMMAND_SELECTOR_INLINE_CLASSNAME).not.toContain("shadow-xl");
    });

    it("uses lightweight controls instead of stacked filled bars", () => {
        const state: AgentSelectorViewState = {
            status: "ready",
            entries: [{ id: "e1", role: "user", preview: "hello", isCurrent: true }],
        };

        const html = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="tree"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
            />
        );

        expect(html).toContain("data-command-selector-filter-rail");
        expect(html).toContain("data-command-selector-search");
        expect(html).toContain("data-command-selector-list");
        expect(html).toContain("mx-3 overflow-hidden rounded-xl");
        expect(html).toContain("border-white/[0.055]");
        expect(html).not.toContain("mx-3 mt-2 flex items-center gap-2 rounded-xl bg-white/[0.045] px-2 py-1 select-none");
        expect(html).not.toContain("mx-3 my-2 flex cursor-text items-center gap-2 rounded-xl bg-white/[0.045]");
        expect(html).toContain("border-t border-white/[0.06]");
        expect(html).not.toContain("border-b border-fg-overlay-2/80");
        expect(html).not.toContain("bg-fg-overlay-1/60");
    });

    it("renders tree selectors inside the shared command inline frame", () => {
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn(),
            navigateTree: vi.fn(),
        };

        const html = renderToStaticMarkup(<SessionSelector request={request} onClose={() => undefined} />);

        expect(html).toContain("/tree");
        expect(html).toContain('aria-label="Resize /tree menu"');
        expect(html).toContain('data-command-inline-drag-handle="true"');
    });

    it("labels fork selectors by forkable prompt points", () => {
        expect(getAgentSelectorTitle("fork")).toBe("Fork agent session");
    });

    it("labels resume selectors by saved sessions", () => {
        expect(getAgentSelectorTitle("resume")).toBe("Resume agent session");
    });

    it("focuses the most recent fork point by default", () => {
        expect(
            getInitialAgentSelectorFocusEntryId("fork", [
                { id: "oldest-user-message", preview: "first prompt" },
                { id: "recent-user-message", preview: "latest prompt" },
            ])
        ).toBe("recent-user-message");
    });

    it("disables entry buttons while a selector pick is committing", () => {
        expect(shouldAllowAgentSelectorCancel(null)).toBe(true);
        expect(shouldAllowAgentSelectorCancel("entry-1")).toBe(false);

        const html = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="fork"
                state={{ status: "ready", entries: [{ id: "entry-1", preview: "previous prompt" }] }}
                busyEntryId="entry-1"
                onPick={() => undefined}
                onCancel={() => undefined}
            />
        );

        expect(html).toContain("disabled");
        expect(html).toContain("Working…");
    });

    it("extracts tree editorText for input restoration and ignores fork selectedText", () => {
        expect(
            editorTextFromAgentSelectorResult({
                sessionMetadata: { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" },
                editorText: "restore this prompt",
            })
        ).toBe("restore this prompt");
        expect(
            editorTextFromAgentSelectorResult({
                sessionMetadata: { id: "s2", createdAt: "now", cwd: "/repo", path: "/tmp/fork.jsonl" },
                selectedText: "fork target",
            })
        ).toBeUndefined();
    });

    it("uses model-picker-aligned row styles without browser default focus outline", () => {
        const state: AgentSelectorViewState = {
            status: "ready",
            entries: [{ id: "e1", role: "user", preview: "hello", isCurrent: true }],
        };

        const html = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="tree"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
            />
        );

        expect(html).not.toContain("Jump to a previous point");
        expect(html).toContain('data-agent-selector-row="e1"');
        expect(html).toContain("focus:outline-none");
    });

    it("marks the active row for keyboard navigation", () => {
        const state: AgentSelectorViewState = {
            status: "ready",
            entries: [
                { id: "e1", role: "user", preview: "first" },
                { id: "e2", role: "assistant", preview: "second", isCurrent: true },
            ],
        };

        const html = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="tree"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
            />
        );

        expect(html).toContain('data-agent-selector-active="true"');
        expect(html).toContain(">↑<");
        expect(html).toContain(">↓<");
        expect(html).toContain(">↵<");
        expect(html).toContain(">esc<");
    });

    it("renders a resume scope toggle highlighting the active scope", () => {
        const state: AgentSelectorViewState = {
            status: "ready",
            entries: [{ id: "s1", preview: "/repo" }],
        };

        const cwdScoped = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="resume"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
                resumeScope="cwd"
                onToggleResumeScope={() => undefined}
            />
        );
        expect(cwdScoped).toContain("Current Folder");
        expect(cwdScoped).toContain("All");
        expect(cwdScoped).toContain(
            "rounded-lg px-1.5 py-0.5 font-mono transition-colors inline-flex items-center gap-1.5"
        );

        const allScoped = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="resume"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
                resumeScope="all"
                onToggleResumeScope={() => undefined}
            />
        );
        // The active scope gets the accent text color; switching scope moves it.
        expect(cwdScoped.indexOf("text-cyan-300/90")).toBeLessThan(cwdScoped.indexOf("All"));
        expect(allScoped.indexOf("text-cyan-300/90")).toBeGreaterThan(allScoped.indexOf("Current Folder"));
    });

    it("does not use sqlite database filenames as resume row fallback text", () => {
        expect(
            getResumeSessionDisplayText({
                id: "s1",
                path: "/tmp/sessions/2026-07-04T09-22-51Z_s1.db",
                cwd: "/Users/bytedance/Documents/crest",
                createdAt: "2026-07-04T09:22:51.000Z",
                modifiedAt: "2026-07-04T09:23:51.000Z",
                messageCount: 0,
                firstMessage: "",
                previewText: "",
            })
        ).toBe("crest · 2026-07-04 09:22");
    });

    it("recognizes selector navigation keys even when focus is outside the panel", () => {
        expect(isAgentSelectorGlobalNavigationKey("ArrowDown")).toBe(true);
        expect(isAgentSelectorGlobalNavigationKey("ArrowUp")).toBe(true);
        expect(isAgentSelectorGlobalNavigationKey("Enter")).toBe(true);
        expect(isAgentSelectorGlobalNavigationKey("Escape")).toBe(true);
        expect(isAgentSelectorGlobalNavigationKey("a")).toBe(false);
    });

    it("renders resume rows with a fixed grid so active rows align", () => {
        const state: AgentSelectorViewState = {
            status: "ready",
            entries: [
                {
                    id: "s1",
                    preview: "first session",
                    role: "session",
                    timestamp: "2026-07-04T09:23:51.000Z",
                    sessionDetail: {
                        id: "s1",
                        path: "/tmp/sessions/s1.db",
                        cwd: "/repo",
                        createdAt: "2026-07-04T09:22:51.000Z",
                        modifiedAt: "2026-07-04T09:23:51.000Z",
                        messageCount: 1,
                        firstMessage: "first session",
                        previewText: "first session",
                    },
                },
            ],
        };

        const html = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="resume"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
            />
        );

        expect(html).toContain("resume-row-grid");
        expect(html).toContain("resume-row-active");
    });

    it("omits the scope toggle for non-resume selectors", () => {
        const state: AgentSelectorViewState = {
            status: "ready",
            entries: [{ id: "e1", role: "user", preview: "hi" }],
        };
        const html = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="tree"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
            />
        );
        expect(html).not.toContain("Current Folder");
    });
});
