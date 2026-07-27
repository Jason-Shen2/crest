import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceModel } from "./workspace-model";
import { WorkspaceTerminalSync } from "./workspace-terminal-sync";

function workspace(
    oid: string,
    revision: number,
    terminalTabIds: string[],
    activeTerminalTabId = terminalTabIds[0] ?? ""
): Workspace {
    return {
        oid,
        otype: "workspace",
        version: revision + 1,
        navigationrevision: revision,
        terminaltabids: terminalTabIds,
        activeterminaltabid: activeTerminalTabId,
        contentstate: {
            activecontent: activeTerminalTabId
                ? { kind: "terminal", terminaltabid: activeTerminalTabId }
                : { kind: "agent" },
            toptabs: [],
            lastactivetoptabid: "",
        },
    } as Workspace;
}

afterEach(async () => {
    await WorkspaceModel.resetInstances();
});

describe("WorkspaceTerminalSync", () => {
    it("reconciles add/remove/reorder and ignores stale, old-workspace, and equal-different updates", () => {
        const atom = jotai.atom(workspace("ws-1", 0, ["term-1"]));
        const model = WorkspaceModel.make({
            workspaceId: "ws-1",
            initialTerminalTabIds: ["term-1"],
            initialActiveTerminalTabId: "term-1",
        });
        const sync = new WorkspaceTerminalSync(model, atom);
        sync.start();

        globalStore.set(atom, workspace("ws-1", 1, ["term-2", "term-1"], "term-2"));
        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-2", "term-1"]);
        globalStore.set(atom, workspace("ws-1", 0, ["stale"], "stale"));
        globalStore.set(atom, workspace("ws-old", 2, ["old"], "old"));
        globalStore.set(atom, workspace("ws-1", 1, ["different"], "different"));
        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-2", "term-1"]);

        globalStore.set(atom, workspace("ws-1", 2, ["term-1"], "term-1"));
        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-1"]);
        sync.dispose();
        globalStore.set(atom, workspace("ws-1", 3, ["after-dispose"], "after-dispose"));
        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-1"]);
    });

    it("unsubscribes before workspace model replacement and disposed models reject reconciliation", async () => {
        const atom = jotai.atom(workspace("ws-1", 0, ["term-1"]));
        const model = WorkspaceModel.getInstance({
            windowId: "window-1",
            workspaceId: "ws-1",
            initialTerminalTabIds: ["term-1"],
        });
        const sync = new WorkspaceTerminalSync(model, atom);
        sync.start();

        await WorkspaceModel.replaceInstance({
            windowId: "window-1",
            workspaceId: "ws-2",
            initialTerminalTabIds: [],
        });
        globalStore.set(atom, workspace("ws-1", 2, ["late"], "late"));

        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-1"]);
        expect(
            model.reconcileCheckpoint({
                workspaceid: "ws-1",
                navigationrevision: 3,
                terminaltabids: ["late-direct"],
                activeterminaltabid: "late-direct",
                contentstate: {
                    activecontent: { kind: "terminal", terminaltabid: "late-direct" },
                    toptabs: [],
                    lastactivetoptabid: "",
                },
            })
        ).toBe(false);
    });
});
