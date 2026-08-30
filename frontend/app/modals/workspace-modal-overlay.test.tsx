// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { globalStore } from "@/app/store/jotaiStore";
import { cleanup, render } from "@testing-library/react";
import { Provider } from "jotai";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    modalOpenAtom: null as any,
    setWorkspaceOverlayVisible: vi.fn(),
}));

vi.mock("@/app/store/global", async () => {
    const jotai = await vi.importActual<typeof import("jotai")>("jotai");
    mocks.modalOpenAtom = jotai.atom(false);
    return {
        atoms: { modalOpen: mocks.modalOpenAtom },
        getApi: () => ({ setWorkspaceOverlayVisible: mocks.setWorkspaceOverlayVisible }),
    };
});

import { WorkspaceModalOverlay } from "./workspace-modal-overlay";

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    globalStore.set(mocks.modalOpenAtom, false);
});

describe("WorkspaceModalOverlay", () => {
    it("does not report a transient close during the StrictMode effect replay", () => {
        render(
            <StrictMode>
                <Provider store={globalStore}>
                    <WorkspaceModalOverlay visible />
                </Provider>
            </StrictMode>
        );

        vi.runOnlyPendingTimers();
        expect(mocks.setWorkspaceOverlayVisible).toHaveBeenLastCalledWith(true);
        expect(globalStore.get(mocks.modalOpenAtom)).toBe(true);
    });

    it("reports modal visibility to Electron and clears it when the renderer unmounts", () => {
        const view = render(
            <Provider store={globalStore}>
                <WorkspaceModalOverlay visible={false} />
            </Provider>
        );

        expect(mocks.setWorkspaceOverlayVisible).toHaveBeenLastCalledWith(false);
        expect(globalStore.get(mocks.modalOpenAtom)).toBe(false);

        view.rerender(
            <Provider store={globalStore}>
                <WorkspaceModalOverlay visible />
            </Provider>
        );
        expect(mocks.setWorkspaceOverlayVisible).toHaveBeenLastCalledWith(true);
        expect(globalStore.get(mocks.modalOpenAtom)).toBe(true);

        view.unmount();
        vi.runOnlyPendingTimers();
        expect(mocks.setWorkspaceOverlayVisible).toHaveBeenLastCalledWith(false);
        expect(globalStore.get(mocks.modalOpenAtom)).toBe(false);
    });

    it("keeps the overlay visible when a replacement mounts before the previous instance releases", () => {
        const previous = render(
            <Provider store={globalStore}>
                <WorkspaceModalOverlay visible />
            </Provider>
        );
        const replacement = render(
            <Provider store={globalStore}>
                <WorkspaceModalOverlay visible />
            </Provider>
        );

        previous.unmount();
        vi.runOnlyPendingTimers();

        expect(mocks.setWorkspaceOverlayVisible).toHaveBeenLastCalledWith(true);
        expect(globalStore.get(mocks.modalOpenAtom)).toBe(true);

        replacement.unmount();
        vi.runOnlyPendingTimers();
        expect(mocks.setWorkspaceOverlayVisible).toHaveBeenLastCalledWith(false);
    });
});
