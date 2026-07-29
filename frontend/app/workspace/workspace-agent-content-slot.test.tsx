// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { useAgentSurfaceActivityController } from "@/app/agent/agent-surface-activity";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAgentContentSlot } from "./workspace-agent-content-slot";

const agentContentMock = vi.hoisted(() => ({
    rootRenderCount: 0,
    consumerRenderCount: 0,
    activityEvents: vi.fn(),
}));

vi.mock("@/app/agent/agent-content", () => ({
    AgentContent: () => {
        agentContentMock.rootRenderCount++;
        return <ActivityLifecycleProbe />;
    },
}));

function ActivityLifecycleProbe() {
    agentContentMock.consumerRenderCount++;
    const controller = useAgentSurfaceActivityController();
    useEffect(() => controller.subscribe(agentContentMock.activityEvents), [controller]);
    return <div data-testid="mock-agent-content">Agent</div>;
}

afterEach(() => {
    cleanup();
    agentContentMock.rootRenderCount = 0;
    agentContentMock.consumerRenderCount = 0;
    agentContentMock.activityEvents.mockClear();
});

describe("WorkspaceAgentContentSlot", () => {
    it("renders nothing until the Agent surface has been mounted", () => {
        render(<WorkspaceAgentContentSlot active={true} mounted={false} />);
        expect(screen.queryByTestId("agent-surface")).toBeNull();
    });

    it("commits slot visibility without rerendering Agent activity consumers", async () => {
        const props = {
            mounted: true,
            model: {} as any,
            client: {} as any,
            executionContext: {
                workspaceId: "workspace-1",
                workspaceDir: "/repo",
                environment: {},
            },
        };
        const view = render(<WorkspaceAgentContentSlot {...props} active={true} />);
        const slot = screen.getByTestId("agent-surface");
        const content = screen.getByTestId("mock-agent-content");

        view.rerender(<WorkspaceAgentContentSlot {...props} active={false} />);

        expect(screen.getByTestId("agent-surface")).toBe(slot);
        expect(screen.getByTestId("mock-agent-content")).toBe(content);
        expect(slot.hidden).toBe(true);
        expect(slot.style.display).toBe("none");
        expect(slot.getAttribute("aria-hidden")).toBe("true");
        expect(slot.hasAttribute("inert")).toBe(true);
        expect(agentContentMock.rootRenderCount).toBe(1);
        expect(agentContentMock.consumerRenderCount).toBe(1);
        await waitFor(() => expect(agentContentMock.activityEvents).toHaveBeenCalledWith(false));
        expect(agentContentMock.consumerRenderCount).toBe(1);
    });

    it("renders a fallback label when Agent dependencies are not ready", () => {
        render(<WorkspaceAgentContentSlot active={true} mounted={true} />);
        expect(screen.getByTestId("agent-surface").textContent).toBe("Agent");
    });
});
