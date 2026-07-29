// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatHost } from "./agent-chat-host";
import { AgentSurfaceActivityProvider, makeAgentSurfaceActivityController } from "./agent-surface-activity";

const piChatMock = vi.hoisted(() => ({
    latestOptions: null as any,
    rewindState: {
        enabled: true,
        semanticLeafId: "state-1",
        displayLeafId: "user-1",
        eligibleTurnIds: ["user-1"],
        busy: false,
        frozen: false,
        quota: {
            status: "ok",
            usedBytes: 1,
            softQuotaBytes: 5 * 1024 ** 3,
            cleanupAvailable: false,
        },
    } as AgentRewindSessionStateView,
}));

vi.mock("@/app/store/use-pi-chat", () => ({
    usePiChat: (options: any) => {
        piChatMock.latestOptions = options;
        return {
            turns: [],
            status: "idle",
            errorMessage: undefined,
            queuedMessages: [],
            commands: [],
            contextState: {} as any,
            rewindState: piChatMock.rewindState,
            send: vi.fn().mockResolvedValue(undefined),
            abort: vi.fn(),
        };
    },
}));

function renderHost(children?: React.ReactNode) {
    return render(
        children ?? (
            <AgentChatHost
                runtimeClient={{} as any}
                executionContext={{
                    workspaceId: "workspace-1",
                    workspaceDir: "/repo",
                    environment: {},
                }}
                modelSelection={{ provider: "openai", model: "gpt-test" }}
            />
        )
    );
}

afterEach(() => {
    cleanup();
    piChatMock.latestOptions = null;
});

describe("AgentChatHost", () => {
    it("passes stable surface activity controller to usePiChat", () => {
        const controller = makeAgentSurfaceActivityController(false);
        renderHost(
            <AgentSurfaceActivityProvider controller={controller}>
                <AgentChatHost
                    runtimeClient={{} as any}
                    executionContext={{
                        workspaceId: "workspace-1",
                        workspaceDir: "/repo",
                        environment: {},
                    }}
                    modelSelection={{ provider: "openai", model: "gpt-test" }}
                />
            </AgentSurfaceActivityProvider>
        );

        expect(piChatMock.latestOptions.activity).toBe(controller);
        expect(piChatMock.latestOptions).not.toHaveProperty("visible");
    });

    it("surfaces the current authoritative rewind state without carrying a previous host value", async () => {
        const onStateChange = vi.fn();

        renderHost(
            <AgentChatHost
                runtimeClient={{} as any}
                executionContext={{
                    workspaceId: "workspace-1",
                    workspaceDir: "/repo",
                    connection: "",
                    environment: {},
                }}
                modelSelection={{ provider: "openai", model: "gpt-test" }}
                onStateChange={onStateChange}
            />
        );

        await waitFor(() =>
            expect(onStateChange).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    rewindState: piChatMock.rewindState,
                })
            )
        );
    });
});
