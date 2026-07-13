// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { PiAgentMessage, PiTurn } from "@/app/store/use-pi-chat";
import { atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TerminalModel } from "../terminal-model";

const captured = vi.hoisted(() => ({
    onTurnsChange: null as ((turns: PiTurn[]) => void) | null,
}));

vi.mock("@/app/store/ai-catalog", () => ({ CATALOG: [] }));
vi.mock("@/app/store/ai-provider-models", () => ({ providerModelsMapAtom: { read: () => ({}) } }));
vi.mock("@/app/store/ai-resolver", () => ({
    resolveAIConfig: () => ({ ok: false, error: { code: "x", message: "x" } }),
}));
vi.mock("@/app/store/ai-user-config", () => ({
    aiUserConfigAtom: { read: () => ({ config: null, status: "loaded", error: null }) },
}));
vi.mock("@/app/store/jotaiStore", () => ({ globalStore: { set: vi.fn() } }));
vi.mock("@/app/store/modalmodel", () => ({ modalsModel: { pushModal: vi.fn() } }));
vi.mock("@/app/store/services", () => ({ ObjectService: { UpdateObjectMeta: vi.fn() } }));
vi.mock("@/app/view/cmdblock/cmdblock-input", () => ({ CmdBlockInput: () => <div data-testid="cmd-input" /> }));
vi.mock("@/app/view/cmdblock/model-picker-popover", () => ({
    ModelPickerInline: () => <div data-testid="model-picker-inline" />,
}));
vi.mock("@/app/view/cmdblock/session-selector", () => ({
    SessionSelector: () => <div data-testid="session-selector" />,
}));
vi.mock("./agent-chat-host", () => ({
    AgentChatHost: ({
        onReady,
        onTurnsChange,
    }: {
        onReady?: (api: unknown) => void;
        onTurnsChange?: (turns: unknown[]) => void;
    }) => {
        onReady?.({ submit: vi.fn(), abort: vi.fn() });
        captured.onTurnsChange = onTurnsChange as ((turns: PiTurn[]) => void) | null;
        onTurnsChange?.([{ turnId: "turn-1" }]);
        return <div data-testid="agent-chat-host" />;
    },
}));
vi.mock("./agent-command-result", () => ({ AgentCommandResultList: () => <div data-testid="agent-cmd-results" /> }));
vi.mock("./assistant-ui", () => ({
    AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="assistant-runtime-provider">{children}</div>
    ),
    Thread: ({ modelLabel, beforeComposer }: { modelLabel?: string; beforeComposer?: React.ReactNode }) => (
        <div data-testid="crest-thread">
            {beforeComposer}
            {modelLabel}
        </div>
    ),
    useAui: () => ({ composer: () => ({ setText: vi.fn() }) }),
    useCrestAssistantRuntime: () => ({ runtime: true }),
}));
vi.mock("jotai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("jotai")>();
    return {
        ...actual,
        useAtomValue: (a: { read?: (...args: any[]) => unknown }) => {
            if (typeof a?.read !== "function") return undefined;
            try {
                return actual.getDefaultStore().get(a as any);
            } catch {
                return a.read();
            }
        },
    };
});
vi.mock("@/store/global", () => ({
    useOrefMetaKeyAtom: () => null,
    WOS: { makeORef: (type: string, id: string) => ({ type, id }) },
}));

import {
    AgentQueuedMessagesPanel,
    getAgentQueuedMessageText,
    getLatestAgentContextUsage,
    getNextAgentAttachedPanelState,
    hasActiveAgentAttachedPanel,
    makeEmptyAgentAttachedPanelState,
    mapPiUsageToContextUsage,
    useAgentPane,
    type AgentPaneDeps,
} from "./agent-pane";

type AgentPaneModel = Pick<
    TerminalModel,
    "revisionAtom" | "notificationAtom" | "submitInput"
>;

function fakeModel(): AgentPaneModel {
    return {
        revisionAtom: atom(1),
        notificationAtom: atom(""),
        submitInput: vi.fn().mockResolvedValue(undefined),
    };
}

const model = fakeModel() as TerminalModel;

const deps: AgentPaneDeps = {
    model,
    fontSize: 16,
    focusRequest: 0,
    liveCwd: "/x",
    home: "/home",
    workspaceDir: "/x",
    recentCmds: [],
    liveConnection: "",
    commandHistory: [],
    inputMode: "agent",
    effectiveMode: "agent",
    onModeChange: () => {},
    onInputTextChange: () => {},
    isRunning: false,
    inAltScreen: false,
};

describe("useAgentPane", () => {
    it("keeps command attached panels mutually exclusive", () => {
        const commandResult = {
            command: "session",
            status: "success",
            message: "Session switched.",
        } as const;
        const treeRequest = {
            type: "tree",
            listTree: vi.fn(),
            navigateTree: vi.fn(),
        } as any;
        const resumeRequest = {
            type: "resume",
            cwd: "/x",
            listSessions: vi.fn(),
            resumeSession: vi.fn(),
        } as any;

        let state = makeEmptyAgentAttachedPanelState();
        state = getNextAgentAttachedPanelState(state, { type: "showCommandResult", result: commandResult });
        expect(state.commandResults).toEqual([commandResult]);
        expect(state.selectorRequest).toBeNull();
        expect(state.modelPickerOpen).toBe(false);
        expect(hasActiveAgentAttachedPanel(state)).toBe(true);

        state = getNextAgentAttachedPanelState(state, { type: "openSelector", request: treeRequest });
        expect(state.commandResults).toEqual([]);
        expect(state.selectorRequest).toBe(treeRequest);
        expect(state.modelPickerOpen).toBe(false);
        expect(hasActiveAgentAttachedPanel(state)).toBe(true);

        state = getNextAgentAttachedPanelState(state, { type: "openModelPicker" });
        expect(state.commandResults).toEqual([]);
        expect(state.selectorRequest).toBeNull();
        expect(state.modelPickerOpen).toBe(true);
        expect(hasActiveAgentAttachedPanel(state)).toBe(true);

        state = getNextAgentAttachedPanelState(state, { type: "openSelector", request: resumeRequest });
        expect(state.commandResults).toEqual([]);
        expect(state.selectorRequest).toBe(resumeRequest);
        expect(state.modelPickerOpen).toBe(false);

        state = getNextAgentAttachedPanelState(state, { type: "showCommandResult", result: commandResult });
        expect(state.commandResults).toEqual([commandResult]);
        expect(state.selectorRequest).toBeNull();
        expect(state.modelPickerOpen).toBe(false);
    });

    it("does not hide scroll to bottom when no command attached panel is open", () => {
        expect(hasActiveAgentAttachedPanel(makeEmptyAgentAttachedPanelState())).toBe(false);
    });

    it("maps Pi usage into local context ring usage", () => {
        expect(
            mapPiUsageToContextUsage({
                input: 100,
                output: 20,
                cacheRead: 5,
                cacheWrite: 1,
                totalTokens: 126,
            })
        ).toEqual({
            inputTokens: 100,
            outputTokens: 20,
            cachedInputTokens: 6,
            totalTokens: 126,
        });
    });

    it("uses the latest assistant usage from Pi turns for the context ring", () => {
        const turns = [
            {
                turnId: "turn-1",
                responseMessages: [
                    {
                        role: "assistant",
                        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
                    },
                ],
                status: "done",
            },
            {
                turnId: "turn-2",
                responseMessages: [
                    {
                        role: "assistant",
                        usage: { input: 80, output: 15, cacheRead: 5, cacheWrite: 0, totalTokens: 100 },
                    },
                ],
                status: "done",
            },
        ] as PiTurn[];

        expect(getLatestAgentContextUsage(turns)).toEqual({
            inputTokens: 80,
            outputTokens: 15,
            cachedInputTokens: 5,
            totalTokens: 100,
        });
    });

    it("produces a full assistant-ui agent slot without the legacy activity bar", () => {
        let captured: ReturnType<typeof useAgentPane> | null = null;
        const model = fakeModel() as TerminalModel;
        const probeDeps = { ...deps, model };
        function LocalProbe({ onSlot }: { onSlot: (slot: ReturnType<typeof useAgentPane>) => void }) {
            const slot = useAgentPane("outer", model, probeDeps);
            onSlot(slot);
            return (
                <>
                    {slot.chatHost}
                    {slot.inputBar}
                    {slot.commandResults}
                </>
            );
        }
        const html = renderToStaticMarkup(<LocalProbe onSlot={(s) => (captured = s)} />);
        expect(html).toContain('data-testid="agent-chat-host"');
        expect(html).toContain('data-testid="assistant-runtime-provider"');
        expect(html).toContain('data-testid="crest-thread"');
        expect(html).not.toContain('data-testid="agent-activity-bar"');
        expect(html).not.toContain('data-testid="cmd-input"');
        expect(html).toContain('data-testid="session-selector"');
        expect(html).toContain('data-testid="agent-cmd-results"');
        expect(html).toContain('data-testid="model-picker-inline"');
        expect(captured!.replacesBlockList).toBe(true);
    });

    it("omits activity bar and input bar in alt-screen", () => {
        const altDeps = { ...deps, inAltScreen: true };
        function AltProbe() {
            const slot = useAgentPane("outer", altDeps.model, altDeps);
            return (
                <>
                    {slot.chatHost}
                    {slot.commandResults}
                    {slot.inputBar}
                </>
            );
        }
        const html = renderToStaticMarkup(<AltProbe />);
        expect(html).toContain('data-testid="agent-chat-host"');
        expect(html).not.toContain('data-testid="agent-cmd-results"');
        expect(html).not.toContain('data-testid="cmd-input"');
        expect(html).not.toContain('data-testid="agent-activity-bar"');
    });

    it("extracts concise text for queued user messages", () => {
        expect(
            getAgentQueuedMessageText({
                role: "user",
                content: [
                    { type: "text", text: "first" },
                    { type: "text", text: "second" },
                ],
            } as PiAgentMessage)
        ).toBe("first second");
    });

    it("renders a collapsible queued message panel without explanatory filler", () => {
        const html = renderToStaticMarkup(
            <AgentQueuedMessagesPanel
                messages={[
                    { role: "user", content: [{ type: "text", text: "接下来接进 composer" }] },
                    { role: "user", content: [{ type: "text", text: "再补一个测试" }] },
                ] as PiAgentMessage[]}
            />
        );

        expect(html).toContain("<details");
        expect(html).toContain("aui-agent-queue-panel");
        expect(html).toContain("2 queued");
        expect(html).toContain("01");
        expect(html).toContain("02");
        expect(html).toContain("接下来接进 composer");
        expect(html).toContain("再补一个测试");
        expect(html).not.toContain("FIFO");
        expect(html).not.toContain("follow-up");
        expect(html).not.toContain("current run");
    });

    it("does not render a queued message panel when the queue is empty", () => {
        const html = renderToStaticMarkup(<AgentQueuedMessagesPanel messages={[]} />);

        expect(html).not.toContain("aui-agent-queue-panel");
    });
});
