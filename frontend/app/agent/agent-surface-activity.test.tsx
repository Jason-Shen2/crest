// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    AgentSurfaceActivityProvider,
    makeAgentSurfaceActivityController,
    useAgentSurfaceActivityController,
} from "./agent-surface-activity";

afterEach(cleanup);

describe("Agent surface activity controller", () => {
    it("notifies listeners only when activity changes and stops after unsubscribe", () => {
        const controller = makeAgentSurfaceActivityController(true);
        const listener = vi.fn();
        const unsubscribe = controller.subscribe(listener);

        controller.setActive(true);
        controller.setActive(false);
        controller.setActive(false);
        unsubscribe();
        controller.setActive(true);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(false);
        expect(controller.getActive()).toBe(true);
    });

    it("keeps the Context value stable while controller activity changes", () => {
        const controller = makeAgentSurfaceActivityController(true);
        const renderProbe = vi.fn();
        const activityEvents = vi.fn();

        function Probe() {
            renderProbe();
            const activity = useAgentSurfaceActivityController();
            useEffect(() => activity.subscribe(activityEvents), [activity]);
            return null;
        }

        render(
            <AgentSurfaceActivityProvider controller={controller}>
                <Probe />
            </AgentSurfaceActivityProvider>
        );
        expect(renderProbe).toHaveBeenCalledTimes(1);

        act(() => controller.setActive(false));

        expect(activityEvents).toHaveBeenCalledWith(false);
        expect(renderProbe).toHaveBeenCalledTimes(1);
    });

    it("rejects mixed controller and legacy active props", () => {
        const controller = makeAgentSurfaceActivityController(true);

        expect(() =>
            render(
                <AgentSurfaceActivityProvider active={false} controller={controller}>
                    child
                </AgentSurfaceActivityProvider>
            )
        ).toThrow("AgentSurfaceActivityProvider accepts either controller or active, not both");
    });
});
