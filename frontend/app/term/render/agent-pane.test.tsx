// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { atom } from "jotai";
import { describe, expect, it, vi } from "vitest";
import type { PiRun } from "@/app/store/use-pi-chat";
import type { TerminalModel } from "../terminal-model";

const captured = vi.hoisted(() => ({
    onRunsChange: null as ((runs: PiRun[]) => void) | null,
}));

vi.mock("@/app/store/ai-catalog", () => ({ CATALOG: [] }));
vi.mock("@/app/store/ai-provider-models", () => ({ providerModelsMapAtom: { read: () => ({}) } }));
vi.mock("@/app/store/ai-resolver", () => ({ resolveAIConfig: () => ({ ok: false, error: { code: "x", message: "x" } }) }));
vi.mock("@/app/store/ai-user-config", () => ({ aiUserConfigAtom: { read: () => ({ config: null, status: "loaded", error: null }) } }));
vi.mock("@/app/store/jotaiStore", () => ({ globalStore: { set: vi.fn() } }));
vi.mock("@/app/store/modalmodel", () => ({ modalsModel: { pushModal: vi.fn() } }));
vi.mock("@/app/store/services", () => ({ ObjectService: { UpdateObjectMeta: vi.fn() } }));
vi.mock("@/app/store/use-pi-chat", () => ({
    indexRunsById: (runs: PiRun[]) => new Map(runs.map((run) => [run.runId, run])),
}));
vi.mock("@/app/view/cmdblock/cmdblock-input", () => ({ CmdBlockInput: () => <div data-testid="cmd-input" /> }));
vi.mock("@/app/view/cmdblock/session-selector", () => ({ SessionSelector: () => <div data-testid="session-selector" /> }));
vi.mock("./agent-activity-bar", () => ({ AgentActivityBar: () => <div data-testid="agent-activity-bar" /> }));
vi.mock("./agent-chat-host", () => ({
    AgentChatHost: (props: { onRunsChange: (runs: PiRun[]) => void }) => {
        captured.onRunsChange = props.onRunsChange;
        return <div data-testid="agent-chat-host" />;
    },
}));
vi.mock("./agent-command-result", () => ({ AgentCommandResultList: () => <div data-testid="agent-cmd-results" /> }));
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

import { useAgentPane, type AgentPaneDeps } from "./agent-pane";

type AgentPaneModel = Pick<
    TerminalModel,
    "revisionAtom" | "notificationAtom" | "getFirstAgentSessionPath" | "syncAgentBlocks" | "submitInput"
>;

function fakeModel(): AgentPaneModel {
    return {
        revisionAtom: atom(1),
        notificationAtom: atom(""),
        getFirstAgentSessionPath: () => "",
        syncAgentBlocks: vi.fn(),
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

function Probe({ onSlot }: { onSlot: (slot: ReturnType<typeof useAgentPane>) => void }) {
    const slot = useAgentPane("outer", deps.model, deps);
    onSlot(slot);
    return (
        <>
            {slot.chatHost}
            {slot.activityBar}
            {slot.inputBar}
            {slot.commandResults}
        </>
    );
}

describe("useAgentPane", () => {
    it("produces a full agent slot with all surfaces", () => {
        let captured: ReturnType<typeof useAgentPane> | null = null;
        const html = renderToStaticMarkup(<Probe onSlot={(s) => (captured = s)} />);
        expect(html).toContain('data-testid="agent-chat-host"');
        expect(html).toContain('data-testid="agent-activity-bar"');
        expect(html).toContain('data-testid="cmd-input"');
        expect(html).toContain('data-testid="session-selector"');
        expect(html).toContain('data-testid="agent-cmd-results"');
        expect(captured!.agentRunsById).toBeInstanceOf(Map);
    });

    it("syncs agent runs by id through the host update callback", () => {
        renderToStaticMarkup(<Probe onSlot={() => {}} />);

        captured.onRunsChange?.([{ runId: "run-1" } as PiRun]);

        expect(model.syncAgentBlocks).toHaveBeenCalledWith(new Set(["run-1"]));
    });

    it("omits activity bar and input bar in alt-screen", () => {
        const altDeps = { ...deps, inAltScreen: true };
        function AltProbe() {
            const slot = useAgentPane("outer", altDeps.model, altDeps);
            return (
                <>
                    {slot.chatHost}
                    {slot.commandResults}
                    {slot.activityBar}
                    {slot.inputBar}
                </>
            );
        }
        const html = renderToStaticMarkup(<AltProbe />);
        expect(html).toContain('data-testid="agent-chat-host"');
        expect(html).toContain('data-testid="agent-cmd-results"');
        expect(html).not.toContain('data-testid="cmd-input"');
        expect(html).not.toContain('data-testid="agent-activity-bar"');
    });
});
