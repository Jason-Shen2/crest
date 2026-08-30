// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSelectorRequest } from "@/app/agent/agent-chat-host";
import { TerminalNotification } from "@/app/term/render/terminal-notification";
import {
    AgentSelectorPanel,
    COMMAND_SELECTOR_INLINE_CLASSNAME,
    commitAgentSelectorPick,
    commitAgentTreeReference,
    editorTextFromAgentSelectorResult,
    getAgentSelectorTitle,
    getInitialAgentSelectorFocusEntryId,
    getResumeSessionDisplayText,
    isAgentSelectorGlobalNavigationKey,
    SessionSelector,
    shouldAllowAgentSelectorCancel,
    type AgentSelectorViewState,
} from "./session-selector";

afterEach(cleanup);
beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
});

function makeTreeEntry(overrides: Partial<AgentTreeEntryView> = {}): AgentTreeEntryView {
    return {
        id: "entry-1",
        type: "message",
        role: "user",
        preview: "first prompt",
        isLeaf: false,
        isCurrent: false,
        ...overrides,
    };
}

function makeSessionDetail(overrides: Partial<AgentSessionDetail> = {}): AgentSessionDetail {
    return {
        id: "source-session",
        path: "/tmp/source-session.db",
        cwd: "/repo",
        createdAt: "2026-07-23T09:00:00.000Z",
        modifiedAt: "2026-07-23T09:30:00.000Z",
        messageCount: 2,
        firstMessage: "Source session",
        previewText: "Source session",
        ...overrides,
    };
}

function makeSessionRequest(
    overrides: Partial<Extract<AgentSelectorRequest, { type: "session" }>> = {}
): Extract<AgentSelectorRequest, { type: "session" }> {
    return {
        type: "session",
        cwd: "/repo",
        currentSessionPath: "/tmp/current-session.db",
        listSessions: vi.fn().mockResolvedValue([
            makeSessionDetail(),
            makeSessionDetail({
                id: "current-session",
                path: "/tmp/current-session.db",
                firstMessage: "Current session",
                previewText: "Current session",
            }),
        ]),
        resumeSession: vi.fn().mockResolvedValue({
            sessionMetadata: {
                id: "source-session",
                path: "/tmp/source-session.db",
                cwd: "/repo",
                createdAt: "2026-07-23T09:00:00.000Z",
            },
        }),
        listReferencePoints: vi.fn().mockResolvedValue([
            { entryId: "user-1", preview: "First user turn", timestamp: "2026-07-23T09:01:00.000Z" },
            { entryId: "user-2", preview: "Second user turn", timestamp: "2026-07-23T09:02:00.000Z" },
        ]),
        getAddedTurnIds: vi.fn(() => new Set<string>()),
        prepareSessionReference: vi.fn().mockResolvedValue(undefined),
        prepareTurnReference: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

function selectReferenceFormat(button: HTMLElement, format: "Full" | "Summary" = "Full") {
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: format }));
}

function PersistentReferenceNotificationHarness({ request }: { request: AgentSelectorRequest }) {
    const [activeRequest, setActiveRequest] = useState<AgentSelectorRequest | null>(request);
    const [notification, setNotification] = useState("");

    return (
        <>
            <SessionSelector
                request={activeRequest}
                onClose={() => setActiveRequest(null)}
                onUserMessage={setNotification}
            />
            {notification && <TerminalNotification message={notification} />}
        </>
    );
}

describe("agent selector popover", () => {
    function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        return { promise, resolve, reject };
    }

    it("commits tree picks through navigateTree", async () => {
        const navigateTree = vi.fn(async () => ({
            sessionMetadata: { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" },
            editorText: "restore this",
        }));
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn(),
            navigateTree,
            prepareTurnReference: vi.fn(),
        };

        await expect(commitAgentSelectorPick(request, "entry-1")).resolves.toEqual({
            sessionMetadata: { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" },
            editorText: "restore this",
        });

        expect(navigateTree).toHaveBeenCalledWith("entry-1");
    });

    it("keeps tree reference preparation separate from navigation", async () => {
        const navigateTree = vi.fn();
        const prepareTurnReference = vi.fn().mockResolvedValue(undefined);
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn(),
            navigateTree,
            prepareTurnReference,
        };

        await expect(commitAgentTreeReference(request, "entry-1", "summary")).resolves.toBeUndefined();

        expect(prepareTurnReference).toHaveBeenCalledOnce();
        expect(prepareTurnReference).toHaveBeenCalledWith("entry-1", "summary");
        expect(navigateTree).not.toHaveBeenCalled();
    });

    it("loads tree rows and Enter preserves tree navigation", async () => {
        const navigateTree = vi.fn().mockResolvedValue({
            sessionMetadata: { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" },
        });
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [makeTreeEntry({ isCurrent: true, isLeaf: true })],
                leafId: "entry-1",
            }),
            navigateTree,
            prepareTurnReference: vi.fn(),
        };
        const onClose = vi.fn();

        render(<SessionSelector request={request} onClose={onClose} />);
        const listbox = await screen.findByRole("listbox", { name: "Agent session tree" });
        await waitFor(() => expect(document.querySelector('[data-agent-selector-row="entry-1"]')).toBeTruthy());
        fireEvent.keyDown(listbox, { key: "Enter" });

        await waitFor(() => expect(navigateTree).toHaveBeenCalledWith("entry-1"));
        expect(request.listTree).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("offers references only for backend-referenceable user rows", async () => {
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [
                    makeTreeEntry({ id: "active-user", referenceable: true }),
                    makeTreeEntry({ id: "abandoned-user", parentId: "active-user", preview: "abandoned branch" }),
                    makeTreeEntry({
                        id: "assistant",
                        parentId: "active-user",
                        role: "assistant",
                        preview: "answer",
                        referenceable: true,
                        isCurrent: true,
                        isLeaf: true,
                    }),
                ],
                leafId: "assistant",
            }),
            navigateTree: vi.fn().mockResolvedValue({
                sessionMetadata: { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" },
            }),
            prepareTurnReference: vi.fn(),
        };

        render(<SessionSelector request={request} onClose={() => undefined} />);
        await waitFor(() => expect(document.querySelector('[data-agent-selector-row="active-user"]')).toBeTruthy());
        const activeRow = document.querySelector<HTMLElement>('[data-agent-selector-row="active-user"]');
        const abandonedRow = document.querySelector<HTMLElement>('[data-agent-selector-row="abandoned-user"]');
        const assistantRow = document.querySelector<HTMLElement>('[data-agent-selector-row="assistant"]');

        expect(activeRow).toBeTruthy();
        expect(within(activeRow!).getByRole("button", { name: "Add reference" })).toBeTruthy();
        expect(within(abandonedRow!).queryByRole("button", { name: "Add reference" })).toBeNull();
        expect(within(assistantRow!).queryByRole("button", { name: "Add reference" })).toBeNull();
        expect(screen.getAllByRole("button", { name: "Add reference" })).toHaveLength(1);

        fireEvent.click(abandonedRow!);
        await waitFor(() => expect(request.navigateTree).toHaveBeenCalledWith("abandoned-user"));
    });

    it("renders only the entries returned by backend tree filtering", async () => {
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [makeTreeEntry({ preview: "visible user turn", isCurrent: true, isLeaf: true })],
                leafId: "entry-1",
            }),
            navigateTree: vi.fn(),
            prepareTurnReference: vi.fn(),
        };

        render(<SessionSelector request={request} onClose={() => undefined} />);

        expect(await screen.findByText("visible user turn")).toBeTruthy();
        expect(screen.queryByText("context_projection")).toBeNull();
        expect(screen.queryByText("context_attachment")).toBeNull();
        expect(request.listTree).toHaveBeenCalledOnce();
    });

    it("prepares a tree reference exactly once without navigating or closing early", async () => {
        const preparation = deferred();
        const navigateTree = vi.fn();
        const prepareTurnReference = vi.fn(() => preparation.promise);
        const onClose = vi.fn();
        const onUserMessage = vi.fn();
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [makeTreeEntry({ referenceable: true, isCurrent: true, isLeaf: true })],
                leafId: "entry-1",
            }),
            navigateTree,
            prepareTurnReference,
        };

        render(<SessionSelector request={request} onClose={onClose} onUserMessage={onUserMessage} />);
        selectReferenceFormat(await screen.findByRole("button", { name: "Add reference" }), "Summary");

        expect(prepareTurnReference).toHaveBeenCalledOnce();
        expect(prepareTurnReference).toHaveBeenCalledWith("entry-1", "summary");
        expect(navigateTree).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => preparation.resolve());

        expect(onClose).toHaveBeenCalledOnce();
        expect(onUserMessage).toHaveBeenCalledWith("Reference added");
        const announcement = screen.getByRole("status");
        expect(announcement.getAttribute("aria-live")).toBe("polite");
        expect(announcement.textContent).toBe("Reference added");
    });

    it("keeps the success announcement mounted after closing the selector", async () => {
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [makeTreeEntry({ referenceable: true, isCurrent: true, isLeaf: true })],
                leafId: "entry-1",
            }),
            navigateTree: vi.fn(),
            prepareTurnReference: vi.fn().mockResolvedValue(undefined),
        };

        render(<PersistentReferenceNotificationHarness request={request} />);
        selectReferenceFormat(await screen.findByRole("button", { name: "Add reference" }));

        await waitFor(() => expect(screen.queryByRole("listbox", { name: "Agent session tree" })).toBeNull());
        const notification = screen.getByRole("status");
        expect(notification.textContent).toBe("Reference added");
        expect(notification.getAttribute("aria-live")).toBe("polite");
    });

    it("keeps the tree selector open and shows reference preparation failures", async () => {
        const onClose = vi.fn();
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [makeTreeEntry({ referenceable: true, isCurrent: true, isLeaf: true })],
                leafId: "entry-1",
            }),
            navigateTree: vi.fn(),
            prepareTurnReference: vi.fn().mockRejectedValue(new Error("Source turn is no longer available.")),
        };

        render(<SessionSelector request={request} onClose={onClose} />);
        const button = await screen.findByRole("button", { name: "Add reference" });
        selectReferenceFormat(button);

        expect(onClose).not.toHaveBeenCalled();
        const error = await screen.findByRole("alert");
        expect(error.getAttribute("aria-live")).toBe("assertive");
        expect(error.textContent).toBe("Source turn is no longer available.");
        expect(screen.getByRole("button", { name: "Add reference" })).toBeTruthy();

        fireEvent.mouseDown(document.body);
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("renders the Add reference action as a keyboard-focusable button", async () => {
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [makeTreeEntry({ referenceable: true, isCurrent: true, isLeaf: true })],
                leafId: "entry-1",
            }),
            navigateTree: vi.fn(),
            prepareTurnReference: vi.fn(),
        };

        render(<SessionSelector request={request} onClose={() => undefined} />);
        const button = await screen.findByRole("button", { name: "Add reference" });
        button.focus();

        expect(document.activeElement).toBe(button);
        expect(button.tabIndex).toBe(0);
        expect(button.getAttribute("type")).toBe("button");
        expect(button.className).toContain("min-h-7");
        expect(button.className).toContain("focus-visible:");
    });

    it("keeps tree navigation but hides reference actions when references are disabled", async () => {
        const navigateTree = vi.fn().mockResolvedValue({
            sessionMetadata: { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" },
        });
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [makeTreeEntry({ referenceable: true, isCurrent: true, isLeaf: true })],
                leafId: "entry-1",
            }),
            navigateTree,
            prepareTurnReference: vi.fn(),
        };

        render(<SessionSelector request={request} onClose={() => undefined} referencesEnabled={false} />);
        const listbox = await screen.findByRole("listbox", { name: "Agent session tree" });
        await waitFor(() => expect(document.querySelector('[data-agent-selector-row="entry-1"]')).toBeTruthy());

        expect(screen.queryByRole("button", { name: "Add reference" })).toBeNull();
        fireEvent.keyDown(listbox, { key: "Enter" });
        await waitFor(() => expect(navigateTree).toHaveBeenCalledWith("entry-1"));
        expect(request.prepareTurnReference).not.toHaveBeenCalled();
    });

    it("keeps keyboard activation of Add reference from navigating the row", async () => {
        const navigateTree = vi.fn();
        const prepareTurnReference = vi.fn().mockResolvedValue(undefined);
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [makeTreeEntry({ referenceable: true, isCurrent: true, isLeaf: true })],
                leafId: "entry-1",
            }),
            navigateTree,
            prepareTurnReference,
        };

        render(<SessionSelector request={request} onClose={() => undefined} />);
        const button = await screen.findByRole("button", { name: "Add reference" });
        button.focus();
        fireEvent.keyDown(button, { key: "Enter" });
        fireEvent.click(button);
        fireEvent.click(screen.getByRole("menuitem", { name: "Full" }));

        await waitFor(() => expect(prepareTurnReference).toHaveBeenCalledOnce());
        expect(prepareTurnReference).toHaveBeenCalledWith("entry-1", "full");
        expect(navigateTree).not.toHaveBeenCalled();
    });

    it("serializes rapid keyboard, pointer, and cross-row reference activation", async () => {
        const firstPreparation = deferred();
        const prepareTurnReference = vi
            .fn()
            .mockImplementationOnce(() => firstPreparation.promise)
            .mockResolvedValue(undefined);
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [
                    makeTreeEntry({ id: "entry-1", referenceable: true }),
                    makeTreeEntry({
                        id: "entry-2",
                        parentId: "entry-1",
                        preview: "second prompt",
                        referenceable: true,
                        isCurrent: true,
                        isLeaf: true,
                    }),
                ],
                leafId: "entry-2",
            }),
            navigateTree: vi.fn(),
            prepareTurnReference,
        };

        render(<SessionSelector request={request} onClose={() => undefined} />);
        const buttons = await screen.findAllByRole("button", { name: "Add reference" });
        fireEvent.keyDown(buttons[0], { key: "Enter" });
        selectReferenceFormat(buttons[0]);
        fireEvent.keyDown(buttons[0], { key: " " });
        fireEvent.click(buttons[0]);
        fireEvent.click(buttons[1]);

        expect(prepareTurnReference).toHaveBeenCalledOnce();
        expect(prepareTurnReference).toHaveBeenCalledWith("entry-1", "full");
        expect(buttons[0].hasAttribute("disabled")).toBe(true);
        expect(buttons[1].hasAttribute("disabled")).toBe(true);

        await act(async () => firstPreparation.resolve());
        await waitFor(() => expect(buttons[0].hasAttribute("disabled")).toBe(false));

        selectReferenceFormat(buttons[1], "Summary");
        await waitFor(() => expect(prepareTurnReference).toHaveBeenCalledTimes(2));
        expect(prepareTurnReference).toHaveBeenLastCalledWith("entry-2", "summary");
    });

    it("blocks Escape and outside-click cancellation while reference preparation is pending", async () => {
        const preparation = deferred();
        const onClose = vi.fn();
        const request: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [makeTreeEntry({ referenceable: true, isCurrent: true, isLeaf: true })],
                leafId: "entry-1",
            }),
            navigateTree: vi.fn(),
            prepareTurnReference: vi.fn(() => preparation.promise),
        };

        render(<SessionSelector request={request} onClose={onClose} />);
        selectReferenceFormat(await screen.findByRole("button", { name: "Add reference" }));
        fireEvent.keyDown(window, { key: "Escape" });
        fireEvent.mouseDown(document.body);

        expect(onClose).not.toHaveBeenCalled();

        await act(async () => preparation.resolve());
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("does not let an old reference finally unlock a newer request operation", async () => {
        const oldPreparation = deferred();
        const newPreparation = deferred();
        const onClose = vi.fn();
        const oldRequest: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [
                    makeTreeEntry({ id: "old-entry", preview: "old prompt", referenceable: true, isCurrent: true }),
                ],
                leafId: "old-entry",
            }),
            navigateTree: vi.fn(),
            prepareTurnReference: vi.fn(() => oldPreparation.promise),
        };
        const newRequest: AgentSelectorRequest = {
            type: "tree",
            listTree: vi.fn().mockResolvedValue({
                entries: [
                    makeTreeEntry({ id: "new-entry", preview: "new prompt", referenceable: true, isCurrent: true }),
                ],
                leafId: "new-entry",
            }),
            navigateTree: vi.fn(),
            prepareTurnReference: vi.fn(() => newPreparation.promise),
        };

        const { rerender } = render(<SessionSelector request={oldRequest} onClose={onClose} />);
        selectReferenceFormat(await screen.findByRole("button", { name: "Add reference" }));

        rerender(<SessionSelector request={newRequest} onClose={onClose} />);
        await screen.findByText("new prompt");
        const newButton = screen.getByRole("button", { name: "Add reference" });
        selectReferenceFormat(newButton);
        expect(newButton.hasAttribute("disabled")).toBe(true);

        await act(async () => oldPreparation.resolve());
        expect(newButton.hasAttribute("disabled")).toBe(true);
        expect(newRequest.prepareTurnReference).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => newPreparation.resolve());
        expect(onClose).toHaveBeenCalledOnce();
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
            type: "session",
            cwd: "/repo",
            listSessions: vi.fn(),
            resumeSession,
            listReferencePoints: vi.fn(),
            getAddedTurnIds: vi.fn(() => new Set<string>()),
            prepareSessionReference: vi.fn(),
            prepareTurnReference: vi.fn(),
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

    it("does not commit delayed list results or errors after the selector session becomes stale", async () => {
        const staleList = deferred<AgentTreeResult>();
        let current = true;
        const request = {
            type: "tree" as const,
            listTree: vi.fn(() => staleList.promise),
            navigateTree: vi.fn(),
            isCurrent: () => current,
        };
        const onClose = vi.fn();
        const view = render(<SessionSelector request={request} onClose={onClose} />);

        current = false;
        staleList.resolve({
            entries: [
                {
                    id: "old-entry",
                    type: "message",
                    preview: "old session entry",
                    isLeaf: true,
                    isCurrent: true,
                },
            ],
            leafId: "old-entry",
        });
        await act(async () => {
            await staleList.promise;
        });

        expect(screen.queryByText("old session entry")).toBeNull();
        expect(onClose).not.toHaveBeenCalled();

        const staleError = deferred<AgentTreeResult>();
        current = true;
        const errorRequest = {
            ...request,
            listTree: vi.fn(() => staleError.promise),
            isCurrent: () => current,
        };
        view.rerender(<SessionSelector request={errorRequest} onClose={onClose} />);
        current = false;
        staleError.reject(new Error("old list failed"));
        await act(async () => {
            await Promise.allSettled([staleError.promise]);
        });

        expect(screen.queryByText("old list failed")).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("does not commit delayed navigate results or errors after the selector session becomes stale", async () => {
        const staleNavigate = deferred<AgentNavigateTreeResult>();
        let current = true;
        const onClose = vi.fn();
        const onUserMessage = vi.fn();
        const onEditorText = vi.fn();
        const request = {
            type: "tree" as const,
            listTree: vi.fn(async () => ({
                entries: [
                    {
                        id: "entry-a",
                        type: "message",
                        preview: "navigate old entry",
                        isLeaf: true,
                        isCurrent: true,
                    },
                ],
                leafId: "entry-a",
            })),
            navigateTree: vi.fn(() => staleNavigate.promise),
            isCurrent: () => current,
        };
        const view = render(
            <SessionSelector
                request={request}
                onClose={onClose}
                onUserMessage={onUserMessage}
                onEditorText={onEditorText}
            />
        );
        await screen.findByText("navigate old entry");
        fireEvent.click(screen.getByText("navigate old entry"));
        current = false;
        staleNavigate.resolve({
            sessionMetadata: { id: "a", path: "/a", cwd: "/repo", createdAt: "now" },
            editorText: "old editor text",
        });
        await act(async () => {
            await staleNavigate.promise;
        });

        expect(onEditorText).not.toHaveBeenCalled();
        expect(onUserMessage).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        const staleError = deferred<AgentNavigateTreeResult>();
        current = true;
        const errorRequest = {
            ...request,
            navigateTree: vi.fn(() => staleError.promise),
            isCurrent: () => current,
        };
        view.rerender(
            <SessionSelector
                request={errorRequest}
                onClose={onClose}
                onUserMessage={onUserMessage}
                onEditorText={onEditorText}
            />
        );
        await screen.findByText("navigate old entry");
        fireEvent.click(screen.getByText("navigate old entry"));
        current = false;
        staleError.reject(new Error("old navigate failed"));
        await act(async () => {
            await Promise.allSettled([staleError.promise]);
        });

        expect(screen.queryByText("old navigate failed")).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("does not commit delayed fork results or errors after the selector session becomes stale", async () => {
        const staleFork = deferred<AgentForkSessionResult>();
        let current = true;
        const onClose = vi.fn();
        const onUserMessage = vi.fn();
        const request = {
            type: "fork" as const,
            listForkPoints: vi.fn(async () => [{ entryId: "fork-a", preview: "fork old entry" }]),
            forkSession: vi.fn(() => staleFork.promise),
            isCurrent: () => current,
        };
        const view = render(
            <SessionSelector request={request} onClose={onClose} onUserMessage={onUserMessage} />
        );
        await screen.findByText("fork old entry");
        fireEvent.click(screen.getByText("fork old entry"));
        current = false;
        staleFork.resolve({
            sessionMetadata: { id: "fork", path: "/fork", cwd: "/repo", createdAt: "now" },
        });
        await act(async () => {
            await staleFork.promise;
        });

        expect(onUserMessage).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        const staleError = deferred<AgentForkSessionResult>();
        current = true;
        const errorRequest = {
            ...request,
            forkSession: vi.fn(() => staleError.promise),
            isCurrent: () => current,
        };
        view.rerender(<SessionSelector request={errorRequest} onClose={onClose} onUserMessage={onUserMessage} />);
        await screen.findByText("fork old entry");
        fireEvent.click(screen.getByText("fork old entry"));
        current = false;
        staleError.reject(new Error("old fork failed"));
        await act(async () => {
            await Promise.allSettled([staleError.promise]);
        });

        expect(screen.queryByText("old fork failed")).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("keeps current selector operations fully functional", async () => {
        const onClose = vi.fn();
        const onUserMessage = vi.fn();
        const onEditorText = vi.fn();
        const request = {
            type: "tree" as const,
            listTree: vi.fn(async () => ({
                entries: [
                    {
                        id: "entry-b",
                        type: "message",
                        preview: "current entry",
                        isLeaf: true,
                        isCurrent: true,
                    },
                ],
                leafId: "entry-b",
            })),
            navigateTree: vi.fn(async () => ({
                sessionMetadata: { id: "b", path: "/b", cwd: "/repo", createdAt: "now" },
                editorText: "current editor text",
            })),
            isCurrent: () => true,
        };
        render(
            <SessionSelector
                request={request}
                onClose={onClose}
                onUserMessage={onUserMessage}
                onEditorText={onEditorText}
            />
        );

        await screen.findByText("current entry");
        fireEvent.click(screen.getByText("current entry"));
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());

        expect(onEditorText).toHaveBeenCalledWith("current editor text");
        expect(onUserMessage).toHaveBeenCalledWith("Navigated agent session tree.");
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
        expect(html).not.toContain(
            "mx-3 mt-2 flex items-center gap-2 rounded-xl bg-white/[0.045] px-2 py-1 select-none"
        );
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
            prepareTurnReference: vi.fn(),
        };

        const html = renderToStaticMarkup(<SessionSelector request={request} onClose={() => undefined} />);

        expect(html).toContain("/tree");
        expect(html).toContain('aria-label="Resize /tree menu"');
        expect(html).toContain('data-command-inline-drag-handle="true"');
    });

    it("labels fork selectors by forkable prompt points", () => {
        expect(getAgentSelectorTitle("fork")).toBe("Fork agent session");
    });

    it("labels session selectors as the session manager", () => {
        expect(getAgentSelectorTitle("session")).toBe("Session manager");
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

    it("renders a session scope toggle highlighting the active scope", () => {
        const state: AgentSelectorViewState = {
            status: "ready",
            entries: [{ id: "s1", preview: "/repo" }],
        };

        const cwdScoped = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="session"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
                sessionScope="cwd"
                onToggleSessionScope={() => undefined}
            />
        );
        expect(cwdScoped).toContain("Current Folder");
        expect(cwdScoped).toContain("All");
        expect(cwdScoped).toContain("inline-flex min-h-7 cursor-pointer items-center");

        const allScoped = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="session"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
                sessionScope="all"
                onToggleSessionScope={() => undefined}
            />
        );
        // The active scope gets the accent text color; switching scope moves it.
        expect(cwdScoped.indexOf("text-cyan-300/90")).toBeLessThan(cwdScoped.indexOf("All"));
        expect(allScoped.indexOf("text-cyan-300/90")).toBeGreaterThan(allScoped.indexOf("Current Folder"));
    });

    it("combines session action and scope controls into one flat toolbar", () => {
        const html = renderToStaticMarkup(
            <AgentSelectorPanel
                requestType="session"
                state={{
                    status: "ready",
                    entries: [{ id: "s1", preview: "/repo" }],
                }}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
                sessionManagerView={{ type: "sessions", action: "resume" }}
                sessionScope="cwd"
                onSessionAction={() => undefined}
                onToggleSessionScope={() => undefined}
            />
        );

        expect(html).toContain('data-session-toolbar="true"');
        expect(html).toContain("justify-start");
        expect(html).not.toContain("justify-end");
        expect(html).not.toContain('aria-label="Session action"');
        expect(html).toContain('aria-label="Session scope"');
        expect(html).not.toContain("bg-white/[0.07]");
        expect(html).not.toContain("shadow-[inset_0_0_0_1px");
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

    it("preserves the original resume-row treatment for session rows", () => {
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
                requestType="session"
                state={state}
                busyEntryId={null}
                onPick={() => undefined}
                onCancel={() => undefined}
            />
        );

        expect(html).toContain("resume-row");
        expect(html).toContain("resume-row-grid");
        expect(html).toContain("resume-row-active");
        expect(html).toContain("session-row-actions");
        expect(html).not.toContain("resume-count");
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

    it("renders a keyboard-accessible session manager with row actions", async () => {
        const request = makeSessionRequest();
        render(<SessionSelector request={request} onClose={() => undefined} />);

        expect(await screen.findByRole("region", { name: "Session manager" })).toBeTruthy();
        expect(await screen.findByRole("listbox", { name: "Sessions" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Current Folder" }).getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
        expect(screen.getByRole("textbox", { name: "Filter sessions" })).toBeTruthy();
        const sourceOption = screen.getByRole("option", { name: /Source session/ });
        expect(sourceOption.getAttribute("aria-selected")).toBe("true");
        expect(within(sourceOption).getByRole("button", { name: "Resume Source session" })).toBeTruthy();
        expect(within(sourceOption).getByRole("button", { name: "Add Source session as context" })).toBeTruthy();
    });

    it("shows aligned Resume and Add context actions only on the active session row", async () => {
        render(<SessionSelector request={makeSessionRequest()} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        const current = screen.getByRole("option", { name: /Current session/ });
        expect(screen.queryByRole("group", { name: "Session action" })).toBeNull();
        expect(within(source).getByRole("button", { name: "Resume Source session" })).toBeTruthy();
        expect(within(source).getByRole("button", { name: "Add Source session as context" })).toBeTruthy();
        expect(within(current).queryByRole("button", { name: "Resume Current session" })).toBeNull();
        expect(within(current).queryByRole("button", { name: "Add Current session as context" })).toBeNull();
        expect(source.querySelector(".session-row-actions")?.className).toContain("grid-cols-[64px_92px_3ch]");
        expect(current.querySelector(".session-row-actions")?.className).toContain("grid-cols-[64px_92px_3ch]");
    });

    it("keeps the original resume row layout without message-count metadata", async () => {
        render(<SessionSelector request={makeSessionRequest()} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        expect(source.className).toContain("resume-row");
        expect(source.className).toContain("resume-row-grid");
        expect(source.className).toContain("focus:outline-none");
        expect(source.querySelector(".resume-title")?.textContent).toBe("Source session");
        expect(source.querySelector(".resume-sub")?.textContent).toBe("/repo");
        expect(source.querySelector(".session-row-actions")).toBeTruthy();
        expect(document.querySelector(".resume-count")).toBeNull();
    });

    it("switches the active session row action with Left and Right before Enter", async () => {
        const request = makeSessionRequest();
        render(<SessionSelector request={request} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        const resume = within(source).getByRole("button", { name: "Resume Source session" });
        const addContext = within(source).getByRole("button", { name: "Add Source session as context" });
        fireEvent.mouseEnter(source);
        await waitFor(() => expect(source.getAttribute("aria-selected")).toBe("true"));
        source.focus();

        expect(resume.getAttribute("data-session-action-selected")).toBe("true");
        expect(addContext.hasAttribute("data-session-action-selected")).toBe(false);
        fireEvent.keyDown(source, { key: "ArrowRight" });
        expect(addContext.getAttribute("data-session-action-selected")).toBe("true");
        expect(resume.hasAttribute("data-session-action-selected")).toBe(false);
        fireEvent.keyDown(source, { key: "ArrowLeft" });
        expect(resume.getAttribute("data-session-action-selected")).toBe("true");
        fireEvent.keyDown(source, { key: "ArrowRight" });
        fireEvent.keyDown(source, { key: "Enter" });

        expect(await screen.findByRole("listbox", { name: "Reference turns" })).toBeTruthy();
        expect(request.resumeSession).not.toHaveBeenCalled();
    });

    it("multi-selects source turns before showing context configuration", async () => {
        const request = makeSessionRequest();
        render(<SessionSelector request={request} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));

        const list = await screen.findByRole("listbox", { name: "Reference turns" });
        expect(list.getAttribute("aria-multiselectable")).toBe("true");
        expect(request.listReferencePoints).toHaveBeenCalledWith(
            expect.objectContaining({ path: "/tmp/source-session.db" })
        );
        expect(screen.queryByRole("region", { name: "Context configuration" })).toBeNull();
        expect(screen.queryByText("Add context")).toBeNull();
        const nextButton = screen.getByRole("button", { name: "Next" });
        expect(nextButton.hasAttribute("disabled")).toBe(true);
        const firstTurn = screen.getByRole("option", { name: "First user turn" });
        expect(firstTurn.querySelector(".text-left")).toBeTruthy();
        fireEvent.click(firstTurn);
        expect(firstTurn.getAttribute("aria-selected")).toBe("true");
        const secondTurn = screen.getByRole("option", { name: "Second user turn" });
        fireEvent.click(secondTurn);
        expect(secondTurn.getAttribute("aria-selected")).toBe("true");
        expect(screen.getByText("2 selected")).toBeTruthy();
        expect(nextButton.hasAttribute("disabled")).toBe(false);
        fireEvent.click(nextButton);

        const configuration = screen.getByRole("region", { name: "Context configuration" });
        expect(configuration).toBeTruthy();
        expect(within(configuration).getByRole("radiogroup", { name: "Use in" })).toBeTruthy();
        expect(within(configuration).getByRole("radiogroup", { name: "Include as" })).toBeTruthy();
        expect(screen.getByText("2 turns selected")).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "First user turn" })).toBeNull();
        expect(screen.getByRole("radio", { name: /This message/ }).hasAttribute("checked")).toBe(true);
        expect(screen.getByRole("radio", { name: /Conversation/ }).hasAttribute("checked")).toBe(false);
        expect(screen.getByRole("radio", { name: /Full/ }).hasAttribute("checked")).toBe(true);
        expect(screen.getByRole("radio", { name: /Summary/ }).hasAttribute("checked")).toBe(false);
        expect(screen.queryByRole("radio", { name: /Metadata/ })).toBeNull();
        expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Add to conversation" })).toBeNull();
        expect(screen.getByRole("button", { name: "Add 2 references" })).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(await screen.findByRole("listbox", { name: "Reference turns" })).toBeTruthy();
        expect(request.prepareSessionReference).not.toHaveBeenCalled();
        expect(request.prepareTurnReference).not.toHaveBeenCalled();
    });

    it("adds multiple selected turns with one configured representation", async () => {
        const request = makeSessionRequest();
        const onClose = vi.fn();
        render(<SessionSelector request={request} onClose={onClose} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        const firstTurn = await screen.findByRole("option", { name: "First user turn" });
        fireEvent.click(firstTurn);
        fireEvent.click(screen.getByRole("option", { name: "Second user turn" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("radio", { name: /Conversation/ }));
        fireEvent.click(screen.getByRole("radio", { name: /Summary/ }));
        fireEvent.click(screen.getByRole("button", { name: "Add 2 references" }));

        await waitFor(() => expect(request.prepareTurnReference).toHaveBeenCalledTimes(2));
        expect(request.prepareTurnReference).toHaveBeenNthCalledWith(
            1,
            {
                id: "source-session",
                path: "/tmp/source-session.db",
                cwd: "/repo",
                createdAt: "2026-07-23T09:00:00.000Z",
            },
            "user-1",
            "conversation",
            "summary"
        );
        expect(request.prepareTurnReference).toHaveBeenNthCalledWith(
            2,
            {
                id: "source-session",
                path: "/tmp/source-session.db",
                cwd: "/repo",
                createdAt: "2026-07-23T09:00:00.000Z",
            },
            "user-2",
            "conversation",
            "summary"
        );
        expect(request.prepareSessionReference).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("configures multiple references entirely with the keyboard", async () => {
        const request = makeSessionRequest();
        render(<SessionSelector request={request} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        fireEvent.click(await screen.findByRole("option", { name: "First user turn" }));
        fireEvent.click(screen.getByRole("option", { name: "Second user turn" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        const deliveryGroup = screen.getByRole("radiogroup", { name: "Use in" });
        const representationGroup = screen.getByRole("radiogroup", { name: "Include as" });
        const addButton = screen.getByRole("button", { name: "Add 2 references" });

        await waitFor(() => expect(document.activeElement).toBe(deliveryGroup));
        fireEvent.keyDown(deliveryGroup, { key: "ArrowUp" });
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back" }));
        fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
        expect(document.activeElement).toBe(deliveryGroup);
        fireEvent.keyDown(deliveryGroup, { key: "ArrowRight" });
        expect((screen.getByRole("radio", { name: /Conversation/ }) as HTMLInputElement).checked).toBe(true);
        fireEvent.keyDown(deliveryGroup, { key: "ArrowDown" });
        expect(document.activeElement).toBe(representationGroup);
        fireEvent.keyDown(representationGroup, { key: "ArrowRight" });
        expect((screen.getByRole("radio", { name: /Summary/ }) as HTMLInputElement).checked).toBe(true);
        fireEvent.keyDown(representationGroup, { key: "ArrowDown" });
        expect(document.activeElement).toBe(addButton);
        fireEvent.click(addButton);

        await waitFor(() => expect(request.prepareTurnReference).toHaveBeenCalledTimes(2));
        expect(request.prepareTurnReference).toHaveBeenNthCalledWith(
            1,
            expect.any(Object),
            "user-1",
            "conversation",
            "summary"
        );
        expect(request.prepareTurnReference).toHaveBeenNthCalledWith(
            2,
            expect.any(Object),
            "user-2",
            "conversation",
            "summary"
        );
    });

    it("Enter inside the context configuration commits Add reference", async () => {
        const request = makeSessionRequest();
        render(<SessionSelector request={request} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        fireEvent.click(await screen.findByRole("option", { name: "First user turn" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        const configuration = await screen.findByRole("region", { name: "Context configuration" });
        const deliveryGroup = within(configuration).getByRole("radiogroup", { name: "Use in" });
        await waitFor(() => expect(document.activeElement).toBe(deliveryGroup));
        // Enter from any focus zone inside the configuration should commit.
        fireEvent.keyDown(configuration, { key: "Enter" });

        await waitFor(() => expect(request.prepareTurnReference).toHaveBeenCalledTimes(1));
        expect(request.prepareTurnReference).toHaveBeenCalledWith(
            expect.any(Object),
            "user-1",
            "message",
            "full"
        );
    });

    it("renders the context configuration footer with chip-style key hints", async () => {
        const request = makeSessionRequest();
        render(<SessionSelector request={request} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        fireEvent.click(await screen.findByRole("option", { name: "First user turn" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        const configuration = await screen.findByRole("region", { name: "Context configuration" });
        // Hint labels for the new chip-style footer.
        for (const label of ["choose", "group", "add", "back"]) {
            expect(within(configuration).getByText(label)).toBeTruthy();
        }
        // Plain-text "←→ choose · ↑↓ group · esc back" footer should be gone.
        expect(within(configuration).queryByText(/←→ choose/)).toBeNull();
        // The Add reference primary action is still rendered.
        expect(within(configuration).getByRole("button", { name: "Add reference" })).toBeTruthy();
    });

    it("uses the active theme accent instead of fixed cyan for selection and focus", async () => {
        const request = makeSessionRequest();
        render(<SessionSelector request={request} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        fireEvent.click(await screen.findByRole("option", { name: "First user turn" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        const configuration = screen.getByRole("region", { name: "Context configuration" });
        expect(configuration.innerHTML).not.toContain("cyan-");
        expect(screen.getByRole("radiogroup", { name: "Use in" }).className).toContain("focus-visible:border-accent");
        expect(screen.getByRole("radio", { name: /This message/ }).closest("label")?.innerHTML).toContain(
            "border-accent"
        );
    });

    it("marks composer turns as added and skips them during keyboard multi-selection", async () => {
        const request = makeSessionRequest({
            getAddedTurnIds: vi.fn(() => new Set(["user-1"])),
        });
        render(<SessionSelector request={request} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));

        const firstTurn = await screen.findByRole("option", { name: "First user turn" });
        const secondTurn = screen.getByRole("option", { name: "Second user turn" });
        expect(firstTurn.getAttribute("aria-disabled")).toBe("true");
        expect(within(firstTurn).getByText("Added")).toBeTruthy();
        await waitFor(() => expect(secondTurn.getAttribute("tabindex")).toBe("0"));

        secondTurn.focus();
        fireEvent.keyDown(secondTurn, { key: " " });
        expect(secondTurn.getAttribute("aria-selected")).toBe("true");
        fireEvent.keyDown(secondTurn, { key: "Enter" });
        expect(screen.getByRole("region", { name: "Context configuration" })).toBeTruthy();
    });

    it("keeps successful turns added and retries only failed turns", async () => {
        let secondTurnAttempts = 0;
        const prepareTurnReference = vi.fn(
            async (
                _source: AgentSessionMeta,
                turnId: string,
                _deliveryScope: AgentContextDeliveryScope,
                _representation: AgentContextRepresentation
            ) => {
                if (turnId === "user-2" && secondTurnAttempts++ === 0) {
                    throw new Error("Source turn was deleted.");
                }
            }
        );
        const request = makeSessionRequest({ prepareTurnReference });
        const onClose = vi.fn();
        render(<SessionSelector request={request} onClose={onClose} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        fireEvent.click(await screen.findByRole("option", { name: "First user turn" }));
        fireEvent.click(screen.getByRole("option", { name: "Second user turn" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Add 2 references" }));

        expect((await screen.findByRole("alert")).textContent).toContain("Added 1, failed 1");
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        const firstTurn = await screen.findByRole("option", { name: "First user turn" });
        const secondTurn = screen.getByRole("option", { name: "Second user turn" });
        expect(firstTurn.getAttribute("aria-disabled")).toBe("true");
        expect(within(firstTurn).getByText("Added")).toBeTruthy();
        expect(secondTurn.getAttribute("aria-selected")).toBe("true");

        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Add reference" }));

        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(prepareTurnReference).toHaveBeenCalledTimes(3);
        expect(prepareTurnReference.mock.calls.filter(([, turnId]) => turnId === "user-1")).toHaveLength(1);
        expect(prepareTurnReference.mock.calls.filter(([, turnId]) => turnId === "user-2")).toHaveLength(2);
    });

    it("keeps row Resume but hides Add context when references are disabled", async () => {
        const request = makeSessionRequest();
        render(<SessionSelector request={request} onClose={() => undefined} referencesEnabled={false} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        expect(within(source).getByRole("button", { name: "Resume Source session" })).toBeTruthy();
        expect(within(source).queryByRole("button", { name: "Add Source session as context" })).toBeNull();
        source.focus();
        fireEvent.keyDown(source, { key: "Enter" });
        await waitFor(() =>
            expect(request.resumeSession).toHaveBeenCalledWith(
                expect.objectContaining({ path: "/tmp/source-session.db" })
            )
        );
        expect(request.listReferencePoints).not.toHaveBeenCalled();
    });

    it("moves a roving session option exactly once for each Arrow key", async () => {
        render(<SessionSelector request={makeSessionRequest()} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        const current = screen.getByRole("option", { name: /Current session/ });
        await waitFor(() => expect(document.activeElement).toBe(source));
        expect(source.id).not.toBe("");
        expect(source.tabIndex).toBe(0);
        expect(current.tabIndex).toBe(-1);

        fireEvent.keyDown(source, { key: "ArrowDown" });

        await waitFor(() => expect(document.activeElement).toBe(current));
        expect(source.getAttribute("aria-selected")).toBe("false");
        expect(current.getAttribute("aria-selected")).toBe("true");
        expect(current.tabIndex).toBe(0);
    });

    it("lets scope and row action buttons avoid unintended row commits", async () => {
        const request = makeSessionRequest();
        const onClose = vi.fn();
        render(<SessionSelector request={request} onClose={onClose} />);

        const all = await screen.findByRole("button", { name: "All" });
        all.focus();
        fireEvent.keyDown(all, { key: "Enter" });
        fireEvent.click(all);
        await waitFor(() => expect(request.listSessions).toHaveBeenLastCalledWith(undefined));
        expect(request.resumeSession).not.toHaveBeenCalled();

        const currentFolder = screen.getByRole("button", { name: "Current Folder" });
        currentFolder.focus();
        fireEvent.keyDown(currentFolder, { key: "Enter" });
        fireEvent.click(currentFolder);
        await waitFor(() => expect(request.listSessions).toHaveBeenLastCalledWith("/repo"));

        const source = screen.getByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        expect(request.resumeSession).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("clears a non-empty session search on Escape before closing on the next Escape", async () => {
        const onClose = vi.fn();
        render(<SessionSelector request={makeSessionRequest()} onClose={onClose} />);

        const search = await screen.findByRole("textbox", { name: "Filter sessions" });
        search.focus();
        fireEvent.change(search, { target: { value: "Source" } });
        fireEvent.keyDown(search, { key: "Escape" });

        expect((search as HTMLInputElement).value).toBe("");
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(search, { key: "Escape" });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("uses cwd and all scopes for the shared session list", async () => {
        const listSessions = vi.fn().mockResolvedValue([makeSessionDetail()]);
        const request = makeSessionRequest({ listSessions });
        render(<SessionSelector request={request} onClose={() => undefined} />);

        await waitFor(() => expect(listSessions).toHaveBeenLastCalledWith("/repo"));
        fireEvent.click(screen.getByRole("button", { name: "All" }));
        await waitFor(() => expect(listSessions).toHaveBeenLastCalledWith(undefined));

        fireEvent.click(screen.getByRole("button", { name: "Current Folder" }));
        await waitFor(() => expect(listSessions).toHaveBeenLastCalledWith("/repo"));
    });

    it("resumes a selected session without entering reference detail", async () => {
        const resumeSession = vi.fn().mockResolvedValue({
            sessionMetadata: {
                id: "source-session",
                path: "/tmp/source-session.db",
                cwd: "/repo",
                createdAt: "2026-07-23T09:00:00.000Z",
            },
        });
        const onClose = vi.fn();
        const request = makeSessionRequest({ resumeSession });
        render(<SessionSelector request={request} onClose={onClose} />);

        fireEvent.click(await screen.findByText("Source session"));

        await waitFor(() =>
            expect(resumeSession).toHaveBeenCalledWith({
                id: "source-session",
                path: "/tmp/source-session.db",
                cwd: "/repo",
                createdAt: "2026-07-23T09:00:00.000Z",
            })
        );
        expect(request.listReferencePoints).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("does not allow the current session to be added as context", async () => {
        const request = makeSessionRequest();
        render(<SessionSelector request={request} onClose={() => undefined} />);

        const current = await screen.findByRole("option", { name: /Current session/ });
        fireEvent.mouseEnter(current);
        await waitFor(() => expect(current.getAttribute("aria-selected")).toBe("true"));
        expect(
            within(current).getByRole("button", { name: "Add Current session as context" }).hasAttribute("disabled")
        ).toBe(true);
    });

    it("uses This message and Full by default when adding session context", async () => {
        const request = makeSessionRequest();
        render(<SessionSelector request={request} onClose={() => undefined} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        const firstTurn = await screen.findByRole("option", { name: "First user turn" });
        fireEvent.click(firstTurn);
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Add reference" }));

        await waitFor(() =>
            expect(request.prepareTurnReference).toHaveBeenCalledWith(expect.any(Object), "user-1", "message", "full")
        );
        expect(request.prepareSessionReference).not.toHaveBeenCalled();
    });

    it("Escape returns from configuration before dismissing the session manager", async () => {
        const request = makeSessionRequest();
        const onClose = vi.fn();
        render(<SessionSelector request={request} onClose={onClose} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        const firstTurn = await screen.findByRole("option", { name: "First user turn" });
        fireEvent.click(firstTurn);
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.keyDown(screen.getByRole("region", { name: "Context configuration" }), { key: "Escape" });

        expect(onClose).not.toHaveBeenCalled();
        expect(await screen.findByRole("listbox", { name: "Reference turns" })).toBeTruthy();

        fireEvent.keyDown(screen.getByRole("region", { name: "Session manager" }), { key: "Escape" });
        expect(await screen.findByRole("listbox", { name: "Sessions" })).toBeTruthy();

        fireEvent.keyDown(screen.getByRole("region", { name: "Session manager" }), { key: "Escape" });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("keeps configuration open when adding context fails", async () => {
        const request = makeSessionRequest({
            prepareTurnReference: vi.fn().mockRejectedValue(new Error("Source turn was deleted.")),
        });
        const onClose = vi.fn();
        render(<SessionSelector request={request} onClose={onClose} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        const firstTurn = await screen.findByRole("option", { name: "First user turn" });
        fireEvent.click(firstTurn);
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Add reference" }));

        expect((await screen.findByRole("alert")).textContent).toContain("Added 0, failed 1");
        expect(screen.getByRole("region", { name: "Context configuration" })).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add reference" }));
        expect(onClose).not.toHaveBeenCalled();
    });

    it("keeps detail visible when the source disappears during reference-point loading", async () => {
        const request = makeSessionRequest({
            listReferencePoints: vi.fn().mockRejectedValue(new Error("Source session no longer exists.")),
        });
        const onClose = vi.fn();
        render(<SessionSelector request={request} onClose={onClose} />);

        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));

        expect((await screen.findByRole("alert")).textContent).toContain("Source session no longer exists.");
        expect(screen.getByRole("button", { name: "← Back" })).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("serializes rapid session resume and reference operations", async () => {
        const resumePending = deferred();
        const resumeSession = vi.fn(async () => {
            await resumePending.promise;
            return {
                sessionMetadata: {
                    id: "source-session",
                    path: "/tmp/source-session.db",
                    cwd: "/repo",
                    createdAt: "2026-07-23T09:00:00.000Z",
                },
            };
        });
        const resumeRequest = makeSessionRequest({ resumeSession });
        const onClose = vi.fn();
        const { rerender } = render(<SessionSelector request={resumeRequest} onClose={onClose} />);
        const resumeRow = await screen.findByText("Source session");
        fireEvent.click(resumeRow);
        fireEvent.click(resumeRow);
        expect(resumeSession).toHaveBeenCalledOnce();
        await act(async () => resumePending.resolve());

        const referencePending = deferred();
        const prepareTurnReference = vi.fn(() => referencePending.promise);
        const referenceRequest = makeSessionRequest({ prepareTurnReference });
        rerender(<SessionSelector request={referenceRequest} onClose={onClose} />);
        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        const firstTurn = await screen.findByRole("option", { name: "First user turn" });
        fireEvent.click(firstTurn);
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        const addButton = screen.getByRole("button", { name: "Add reference" });
        fireEvent.click(addButton);
        fireEvent.click(addButton);
        expect(prepareTurnReference).toHaveBeenCalledOnce();

        fireEvent.keyDown(screen.getByRole("region", { name: "Context configuration" }), { key: "Escape" });
        expect(screen.getByRole("button", { name: "Adding…" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("radiogroup", { name: "Use in" }).getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByRole("radiogroup", { name: "Include as" }).getAttribute("aria-disabled")).toBe("true");
        await act(async () => referencePending.resolve());
    });

    it("ignores stale detail results after the selector request changes", async () => {
        let resolveOldPoints!: (points: AgentReferencePointView[]) => void;
        const oldPoints = new Promise<AgentReferencePointView[]>((resolve) => {
            resolveOldPoints = resolve;
        });
        const oldRequest = makeSessionRequest({
            listReferencePoints: vi.fn(() => oldPoints),
        });
        const newRequest = makeSessionRequest({
            listSessions: vi.fn().mockResolvedValue([
                makeSessionDetail({
                    id: "new-source",
                    path: "/tmp/new-source.db",
                    firstMessage: "New source",
                    previewText: "New source",
                }),
            ]),
        });
        const { rerender } = render(<SessionSelector request={oldRequest} onClose={() => undefined} />);
        const source = await screen.findByRole("option", { name: /Source session/ });
        fireEvent.click(within(source).getByRole("button", { name: "Add Source session as context" }));
        expect(oldRequest.listReferencePoints).toHaveBeenCalledOnce();

        rerender(<SessionSelector request={newRequest} onClose={() => undefined} />);
        expect(await screen.findByText("New source")).toBeTruthy();
        await act(async () =>
            resolveOldPoints([{ entryId: "stale-turn", preview: "Stale old turn", timestamp: "2026-07-23" }])
        );

        expect(screen.queryByText("Stale old turn")).toBeNull();
        expect(screen.getByText("New source")).toBeTruthy();
    });
});
