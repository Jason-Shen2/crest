// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceTopTabController } from "./top-tab-controller";
import { WorkspaceTopTabControllerContext, useWorkspaceTopTabController } from "./top-tab-controller-context";

describe("WorkspaceTopTabControllerContext", () => {
    it("resolves the controller scoped to its provider", () => {
        const controller: WorkspaceTopTabController = {
            openFile: vi.fn(),
            openPreview: vi.fn(),
            openGitDiff: vi.fn(),
            openAgentTurnDiff: vi.fn(),
            activate: vi.fn(),
            close: vi.fn(),
            relocateFile: vi.fn(),
        };
        const wrapper = ({ children }: PropsWithChildren) => (
            <WorkspaceTopTabControllerContext.Provider value={controller}>
                {children}
            </WorkspaceTopTabControllerContext.Provider>
        );

        const { result } = renderHook(() => useWorkspaceTopTabController(), { wrapper });

        expect(result.current).toBe(controller);
    });

    it("rejects use outside a Workspace provider", () => {
        expect(() => renderHook(() => useWorkspaceTopTabController())).toThrow(
            "Workspace Top Tab controller is unavailable"
        );
    });
});
