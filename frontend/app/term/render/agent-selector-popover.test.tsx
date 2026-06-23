// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentSelectorRequest } from "./agent-chat-host";
import {
    AgentSelectorPanel,
    commitAgentSelectorPick,
    editorTextFromAgentSelectorResult,
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
        expect(html).toContain('tabindex="-1"');
        expect(html).toContain('data-agent-selector-entry="root"');
        expect(html).toContain('data-agent-selector-current="true"');
    });

    it("labels fork selectors by forkable prompt points", () => {
        expect(getAgentSelectorTitle("fork")).toBe("Fork agent session");
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
