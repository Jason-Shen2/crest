// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    AssistantRuntimeProvider,
    useAui,
    useExternalStoreRuntime,
    type AppendMessage,
    type AssistantClient,
    type ExternalStoreAdapter,
    type ThreadMessageLike,
} from "@assistant-ui/react";
import type { FC, PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CrestComposer } from "./crest-composer";

interface HarnessOptions {
    isRunning?: boolean;
    modelLabel?: string;
    onNew?: (message: AppendMessage) => Promise<void>;
    onCancel?: () => Promise<void>;
    onOpenModelPicker?: () => void;
}

let capturedAui: AssistantClient | undefined;

const RuntimeProvider: FC<PropsWithChildren<HarnessOptions>> = ({
    children,
    isRunning = false,
    onNew = async () => {},
    onCancel,
}) => {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
        messages: [],
        isRunning,
        convertMessage: (message) => message,
        onNew: async (message) => {
            await onNew(message);
        },
        onCancel:
            onCancel == null
                ? undefined
                : async () => {
                      await onCancel();
                  },
    } satisfies ExternalStoreAdapter<ThreadMessageLike>);

    return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
};

const CaptureRuntime = () => {
    capturedAui = useAui();
    return null;
};

function renderComposer(options: HarnessOptions = {}): string {
    capturedAui = undefined;
    return renderToStaticMarkup(
        <RuntimeProvider {...options}>
            <CaptureRuntime />
            <CrestComposer modelLabel={options.modelLabel} onOpenModelPicker={options.onOpenModelPicker} />
        </RuntimeProvider>
    );
}

async function flushRuntimeWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe("CrestComposer assistant-ui runtime integration", () => {
    it("sends textarea text through the real assistant-ui composer runtime", async () => {
        const sentMessages: AppendMessage[] = [];
        const onNew = vi.fn(async (message: AppendMessage) => {
            sentMessages.push(message);
        });
        renderComposer({ onNew });

        capturedAui?.composer().setText("Explain the failing test");
        capturedAui?.composer().send();
        await flushRuntimeWork();

        expect(onNew).toHaveBeenCalledTimes(1);
        expect(sentMessages[0]).toMatchObject({
            role: "user",
            content: [{ type: "text", text: "Explain the failing test" }],
        });
    });

    it("keeps multi-line input intact when sending", async () => {
        const sentMessages: AppendMessage[] = [];
        const onNew = vi.fn(async (message: AppendMessage) => {
            sentMessages.push(message);
        });
        renderComposer({ onNew });

        capturedAui?.composer().setText("first line\nsecond line");
        capturedAui?.composer().send();
        await flushRuntimeWork();

        expect(sentMessages[0]?.content).toEqual([{ type: "text", text: "first line\nsecond line" }]);
    });

    it("disables empty sends but exposes the model picker affordance", () => {
        const onOpenModelPicker = vi.fn();
        const html = renderComposer({ modelLabel: "Claude Sonnet", onOpenModelPicker });

        expect(html).toContain('data-testid="crest-composer"');
        expect(html).toContain("<textarea");
        expect(html).toContain('aria-label="Ask Crest agent"');
        expect(html).toContain('disabled=""');
        expect(html).toContain("Claude Sonnet");
        expect(html).toContain('aria-label="Change agent model"');
    });

    it("shows stop while running and routes cancel through the real thread runtime", async () => {
        const onCancel = vi.fn(async () => {});
        const html = renderComposer({ isRunning: true, onCancel });

        expect(html).toContain("Stop");
        expect(html).toContain('aria-label="Stop agent response"');
        expect(html).not.toContain('aria-label="Send message"');

        capturedAui?.thread().cancelRun();
        await flushRuntimeWork();

        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("disables stop while running when the runtime cannot cancel", () => {
        const html = renderComposer({ isRunning: true });

        expect(html).toContain("Stop");
        expect(html).toContain('aria-label="Stop agent response"');
        expect(html).toMatch(/aria-label="Stop agent response"[^>]*disabled=""/);
        expect(() => capturedAui?.thread().cancelRun()).toThrow("Runtime does not support cancelling runs.");
    });
});
