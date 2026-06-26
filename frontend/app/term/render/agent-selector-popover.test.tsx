// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentSelectorRequest } from "./agent-chat-host";
import {
    AgentSelectorPanel,
    COMMAND_SELECTOR_POPOVER_CLASSNAME,
    COMMAND_SELECTOR_POPOVER_PLACEMENT,
    COMMAND_SELECTOR_POPOVER_WIDTH_PX,
    commitAgentSelectorPick,
    editorTextFromAgentSelectorResult,
    getInitialAgentSelectorFocusEntryId,
    getAgentSelectorTitle,
    shouldAllowAgentSelectorCancel,
    type AgentSelectorViewState,
} from "./agent-selector-popover";

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
            listSessions: vi.fn(),
            resumeSession,
        };

        await expect(commitAgentSelectorPick(request, "0", [{ id: "0", preview: "/repo", sessionMetadata: resumed }])).resolves.toEqual({
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

        expect(html).toContain("Agent session tree");
        expect(html).toContain("first prompt");
        expect(html).toContain("latest answer");
        expect(html).toContain("Cancel");
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-modal="true"');
        expect(html).toContain('aria-labelledby="agent-selector-tree-title"');
        expect(html).toContain('aria-describedby="agent-selector-tree-description"');
        expect(html).toContain('id="agent-selector-tree-title"');
        expect(html).toContain('id="agent-selector-tree-description"');
        expect(html).toContain('tabindex="-1"');
        expect(html).toContain('data-agent-selector-entry="root"');
        expect(html).toContain('data-agent-selector-current="true"');
    });

    it("uses the same input-anchored popover contract as the model picker", () => {
        expect(COMMAND_SELECTOR_POPOVER_PLACEMENT).toBe("top-end");
        expect(COMMAND_SELECTOR_POPOVER_WIDTH_PX).toBe(340);
        expect(COMMAND_SELECTOR_POPOVER_CLASSNAME).toContain("rounded-md");
        expect(COMMAND_SELECTOR_POPOVER_CLASSNAME).toContain("border-fg-overlay-3");
        expect(COMMAND_SELECTOR_POPOVER_CLASSNAME).toContain("bg-fg-overlay-1");
        expect(COMMAND_SELECTOR_POPOVER_CLASSNAME).toContain("shadow-xl");
        expect(COMMAND_SELECTOR_POPOVER_CLASSNAME).toContain("backdrop-blur");
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

    it("keeps cancellation disabled while a selector pick is committing", () => {
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

        expect(html).toContain('data-agent-selector-cancel-disabled="true"');
        expect(html).toContain("disabled");
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
});
