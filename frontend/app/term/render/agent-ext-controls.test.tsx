// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentChatHostApi, AgentCommandExecutionResult } from "./agent-chat-host";
import { AgentFlagsPanel, useAgentExtensionShortcuts } from "./agent-ext-controls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function makeApi(overrides: Partial<AgentChatHostApi>): AgentChatHostApi {
    return {
        submit: vi.fn(),
        send: vi.fn(),
        listTree: vi.fn(),
        listForkPoints: vi.fn(),
        navigateTree: vi.fn(),
        forkSession: vi.fn(),
        cloneSession: vi.fn(),
        abort: vi.fn(),
        respondExtUi: vi.fn(),
        respondWidgetEvent: vi.fn(),
        listShortcuts: vi.fn(async () => []),
        runShortcut: vi.fn(),
        listFlags: vi.fn(async () => []),
        setFlag: vi.fn(),
        getTurns: vi.fn(() => []),
        ...overrides,
    } as AgentChatHostApi;
}

function mount(element: React.ReactNode): {
    container: HTMLDivElement;
    rerender: (next: React.ReactNode) => void;
} {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const rerender = (next: React.ReactNode) => {
        act(() => {
            root.render(next);
        });
    };
    rerender(element);
    MountedRoots.push({ root, container });
    return { container, rerender };
}

async function flushEffects(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

function booleanFlag(value: boolean): AgentFlagInfo {
    return {
        name: "feature.enabled",
        type: "boolean",
        default: false,
        value,
        extensionPath: "/tmp/ext.ts",
    };
}

function stringFlag(value: string): AgentFlagInfo {
    return {
        name: "feature.label",
        type: "string",
        default: "server",
        value,
        extensionPath: "/tmp/ext.ts",
    };
}

function ShortcutsHarness({
    apiRef,
    sessionPath,
}: {
    apiRef: RefObject<AgentChatHostApi | null>;
    sessionPath: string;
}) {
    useAgentExtensionShortcuts(apiRef, "/repo", sessionPath, "block-1");
    return null;
}

afterEach(() => {
    for (const mounted of MountedRoots.splice(0)) {
        act(() => {
            mounted.root.unmount();
        });
        mounted.container.remove();
    }
});

describe("Agent extension controls", () => {
    it("reloads flags and shortcuts when the active session path changes", async () => {
        const listFlags = vi.fn(async () => [booleanFlag(false)]);
        const listShortcuts = vi.fn(async () => []);
        const apiRef = {
            current: makeApi({ listFlags, listShortcuts }),
        } as RefObject<AgentChatHostApi | null>;
        const { rerender } = mount(
            <>
                <AgentFlagsPanel apiRef={apiRef} cwd="/repo" sessionPath="/tmp/a.jsonl" />
                <ShortcutsHarness apiRef={apiRef} sessionPath="/tmp/a.jsonl" />
            </>
        );
        await flushEffects();

        rerender(
            <>
                <AgentFlagsPanel apiRef={apiRef} cwd="/repo" sessionPath="/tmp/b.jsonl" />
                <ShortcutsHarness apiRef={apiRef} sessionPath="/tmp/b.jsonl" />
            </>
        );
        await flushEffects();

        expect(listFlags).toHaveBeenCalledTimes(2);
        expect(listShortcuts).toHaveBeenCalledTimes(2);
    });

    it("ignores a stale flag response from the previous session", async () => {
        const first = deferred<AgentFlagInfo[]>();
        const second = deferred<AgentFlagInfo[]>();
        const listFlags = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const apiRef = {
            current: makeApi({ listFlags }),
        } as RefObject<AgentChatHostApi | null>;
        const { container, rerender } = mount(
            <AgentFlagsPanel apiRef={apiRef} cwd="/repo" sessionPath="/tmp/a.jsonl" />
        );

        rerender(<AgentFlagsPanel apiRef={apiRef} cwd="/repo" sessionPath="/tmp/b.jsonl" />);
        await act(async () => {
            second.resolve([booleanFlag(true)]);
            await Promise.resolve();
        });
        await act(async () => {
            first.resolve([booleanFlag(false)]);
            await Promise.resolve();
        });

        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(true);
    });

    it("rolls back an optimistic boolean value after a noop write", async () => {
        const listFlags = vi.fn(async () => [booleanFlag(false)]);
        const setFlag = vi.fn(async () => ({ status: "noop" as const, message: "not available" }));
        const onUserError = vi.fn();
        const apiRef = {
            current: makeApi({ listFlags, setFlag }),
        } as RefObject<AgentChatHostApi | null>;
        const { container } = mount(
            <AgentFlagsPanel
                apiRef={apiRef}
                cwd="/repo"
                sessionPath="/tmp/a.jsonl"
                onUserError={onUserError}
            />
        );
        await flushEffects();
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;

        await act(async () => {
            checkbox.click();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(setFlag).toHaveBeenCalledWith("feature.enabled", true);
        expect(listFlags).toHaveBeenCalledTimes(2);
        expect(checkbox.checked).toBe(false);
        expect(onUserError).toHaveBeenCalledWith("not available");
    });

    it("serializes rapid writes and reloads only after the latest value is stored", async () => {
        let serverValue = false;
        const first = deferred<AgentCommandExecutionResult>();
        const second = deferred<AgentCommandExecutionResult>();
        const listFlags = vi.fn(async () => [booleanFlag(serverValue)]);
        const setFlag = vi
            .fn()
            .mockImplementationOnce(async (_name: string, value: boolean) => {
                const result = await first.promise;
                serverValue = value;
                return result;
            })
            .mockImplementationOnce(async (_name: string, value: boolean) => {
                const result = await second.promise;
                serverValue = value;
                return result;
            });
        const apiRef = {
            current: makeApi({ listFlags, setFlag }),
        } as RefObject<AgentChatHostApi | null>;
        const { container } = mount(
            <AgentFlagsPanel apiRef={apiRef} cwd="/repo" sessionPath="/tmp/a.jsonl" />
        );
        await flushEffects();
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;

        await act(async () => {
            checkbox.click();
            await Promise.resolve();
        });
        await act(async () => {
            checkbox.click();
            await Promise.resolve();
        });

        expect(setFlag).toHaveBeenCalledTimes(1);
        first.resolve({ status: "success" });
        await flushEffects();
        expect(setFlag).toHaveBeenCalledTimes(2);
        expect(listFlags).toHaveBeenCalledTimes(1);
        second.resolve({ status: "success" });
        await flushEffects();

        expect(setFlag).toHaveBeenNthCalledWith(1, "feature.enabled", true);
        expect(setFlag).toHaveBeenNthCalledWith(2, "feature.enabled", false);
        expect(listFlags).toHaveBeenCalledTimes(2);
        expect(checkbox.checked).toBe(false);
    });

    it("drops queued writes from a session that is no longer active", async () => {
        const first = deferred<AgentCommandExecutionResult>();
        const listFlags = vi.fn(async () => [booleanFlag(false)]);
        const setFlag = vi.fn(async () => first.promise);
        const apiRef = {
            current: makeApi({ listFlags, setFlag }),
        } as RefObject<AgentChatHostApi | null>;
        const { container, rerender } = mount(
            <AgentFlagsPanel apiRef={apiRef} cwd="/repo" sessionPath="/tmp/a.jsonl" />
        );
        await flushEffects();
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;

        await act(async () => {
            checkbox.click();
            await Promise.resolve();
        });
        await act(async () => {
            checkbox.click();
            await Promise.resolve();
        });
        rerender(<AgentFlagsPanel apiRef={apiRef} cwd="/repo" sessionPath="/tmp/b.jsonl" />);
        await flushEffects();
        first.resolve({ status: "success" });
        await flushEffects();

        expect(setFlag).toHaveBeenCalledOnce();
    });

    it("keeps queued writes when only the runtime refresh token changes", async () => {
        const first = deferred<AgentCommandExecutionResult>();
        const listFlags = vi.fn(async () => [booleanFlag(false)]);
        const setFlag = vi
            .fn()
            .mockImplementationOnce(async () => first.promise)
            .mockResolvedValueOnce({ status: "success" });
        const apiRef = {
            current: makeApi({ listFlags, setFlag }),
        } as RefObject<AgentChatHostApi | null>;
        const { container, rerender } = mount(
            <AgentFlagsPanel apiRef={apiRef} cwd="/repo" sessionPath="/tmp/a.jsonl" reloadToken={0} />
        );
        await flushEffects();
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;

        await act(async () => {
            checkbox.click();
            await Promise.resolve();
        });
        await act(async () => {
            checkbox.click();
            await Promise.resolve();
        });
        rerender(<AgentFlagsPanel apiRef={apiRef} cwd="/repo" sessionPath="/tmp/a.jsonl" reloadToken={1} />);
        await flushEffects();
        first.resolve({ status: "success" });
        await flushEffects();

        expect(setFlag).toHaveBeenCalledTimes(2);
    });

    it("restores a controlled string input after a rejected write", async () => {
        const listFlags = vi.fn(async () => [stringFlag("server")]);
        const setFlag = vi.fn(async () => {
            throw new Error("write failed");
        });
        const apiRef = {
            current: makeApi({ listFlags, setFlag }),
        } as RefObject<AgentChatHostApi | null>;
        const { container } = mount(
            <AgentFlagsPanel apiRef={apiRef} cwd="/repo" sessionPath="/tmp/a.jsonl" />
        );
        await flushEffects();
        const input = container.querySelector('input[type="text"]') as HTMLInputElement;
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

        await act(async () => {
            valueSetter?.call(input, "local");
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(setFlag).toHaveBeenCalledWith("feature.label", "local");
        expect(listFlags).toHaveBeenCalledTimes(2);
        expect(input.value).toBe("server");
    });
});
