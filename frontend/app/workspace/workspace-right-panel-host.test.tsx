// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { render } from "@testing-library/react";
import * as jotai from "jotai";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ panelProps: null as any }));

vi.mock("@/app/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    return { atoms: { workspace: jotaiActual.atom({ oid: "workspace-1" }) } };
});
vi.mock("./workspace-layout-model", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    const instance = {
        rightToolPanelAtom: jotaiActual.atom({}),
        getRightToolPanelStateForWorkspace: () => ({
            visible: true,
            width: 400,
            openedTools: ["context"],
            activeTool: "context",
            toolState: {},
            focused: false,
            magnified: false,
        }),
        openRightTool: vi.fn(),
        selectRightTool: vi.fn(),
        closeRightTool: vi.fn(),
        setRightToolPanelMagnified: vi.fn(),
        setRightToolPanelFocused: vi.fn(),
    };
    return {
        WorkspaceLayoutModel: {
            getInstance: () => instance,
        },
    };
});
vi.mock("./right-tool-panel", () => ({
    RightToolPanel: (props: any) => {
        captured.panelProps = props;
        return <div data-testid="panel" />;
    },
    RightToolPanelMagnifiedOverlay: () => null,
}));

import { WorkspaceRightPanelHost } from "./workspace-right-panel-host";

describe("WorkspaceRightPanelHost", () => {
    it("passes the Agent model's immutable context state into the Context right tool", () => {
        const contextState = {
            identity: { workspaceGeneration: 1, sessionGeneration: 0, modelKey: "openai/gpt-5" },
            status: "ready",
        };
        const agentModel = {
            stateAtom: jotai.atom({ activeSession: { path: "/sessions/current.db" } }),
            contextSnapshotAtom: jotai.atom(contextState),
        } as any;

        render(<WorkspaceRightPanelHost agentModel={agentModel} />);

        expect(captured.panelProps.contextState).toBe(contextState);
        expect(captured.panelProps.sessionId).toBe("/sessions/current.db");
    });
});
