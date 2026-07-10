// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo } from "react";
import { ThreadPrimitive } from "@assistant-ui/react";

import { CrestAssistantMessage, CrestUserMessage } from "./crest-message";

export const CrestThread = memo(() => {
    return (
        <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col" data-testid="crest-thread">
            <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
                <div className="mx-auto flex min-h-full max-w-3xl flex-col">
                    <ThreadPrimitive.Empty>
                        <div className="flex flex-1 items-center justify-center py-16 text-center text-sm text-secondary/75">
                            Start a conversation with Crest
                        </div>
                    </ThreadPrimitive.Empty>
                    <ThreadPrimitive.Messages>
                        {({ message }) => {
                            if (message.role === "user") return <CrestUserMessage />;
                            if (message.role === "assistant") return <CrestAssistantMessage />;
                            return null;
                        }}
                    </ThreadPrimitive.Messages>
                </div>
            </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
    );
});
CrestThread.displayName = "CrestThread";
