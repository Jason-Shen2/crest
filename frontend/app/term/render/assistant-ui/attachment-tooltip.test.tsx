// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    AssistantRuntimeProvider,
    useExternalStoreRuntime,
    type ExternalStoreAdapter,
    type ThreadMessageLike,
} from "@assistant-ui/react";
import type { FC, PropsWithChildren, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/shadcn/ui/tooltip", async () => {
    const React = await vi.importActual<typeof import("react")>("react");
    const TooltipContext = React.createContext(false);

    const TooltipProvider = ({ children }: { children: ReactNode }) =>
        React.createElement(TooltipContext.Provider, { value: true }, children);

    const Tooltip = ({ children }: { children: ReactNode }) => {
        if (!React.useContext(TooltipContext)) {
            throw new Error("Tooltip must be used within TooltipProvider");
        }
        return React.createElement("div", { "data-slot": "tooltip" }, children);
    };

    const TooltipTrigger = ({ children }: { children: ReactNode }) =>
        React.createElement("div", { "data-slot": "tooltip-trigger" }, children);

    const TooltipContent = ({ children }: { children: ReactNode }) =>
        React.createElement("div", { "data-slot": "tooltip-content" }, children);

    return { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
});

const messages: ThreadMessageLike[] = [
    {
        role: "user",
        content: [],
        attachments: [
            {
                id: "user-upload",
                type: "image",
                name: "user-upload.png",
                contentType: "image/png",
                status: { type: "complete" },
                content: [{ type: "image", image: "https://example.com/user.png" }],
            },
        ],
    } as ThreadMessageLike,
];

const RuntimeProvider: FC<PropsWithChildren> = ({ children }) => {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
        messages,
        convertMessage: (message) => message,
        onNew: async () => {},
    } satisfies ExternalStoreAdapter<ThreadMessageLike>);

    return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
};

describe("Attachment tooltip provider", () => {
    it("renders attachment tooltip UI inside a TooltipProvider", async () => {
        const { Thread } = await import("./registry-thread");

        expect(() =>
            renderToStaticMarkup(
                <RuntimeProvider>
                    <Thread />
                </RuntimeProvider>
            )
        ).not.toThrow("Tooltip must be used within TooltipProvider");
    });
});
