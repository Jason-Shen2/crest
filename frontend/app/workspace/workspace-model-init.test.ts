import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceModelOptionsFromLoadedWorkspace } from "./workspace-model-init";

describe("workspace renderer model initialization", () => {
    it("passes the loaded authoritative terminal inventory into WorkspaceModel replacement", () => {
        const workspace = {
            oid: "ws-1",
            terminaltabids: ["term-1", "term-2"],
            activeterminaltabid: "term-2",
            navigationrevision: 7,
            contentstate: { activecontent: { kind: "terminal", terminaltabid: "term-2" }, toptabs: [] },
        } as Workspace;

        expect(workspaceModelOptionsFromLoadedWorkspace("window-1", workspace, 9)).toMatchObject({
            windowId: "window-1",
            workspaceId: "ws-1",
            surfaceGeneration: 9,
            initialTerminalTabIds: ["term-1", "term-2"],
            initialActiveTerminalTabId: "term-2",
            initialNavigationRevision: 7,
        });
    });

    it("passes initializeCurrentWorkspace generation into loaded Workspace model options", () => {
        const source = fs.readFileSync(path.resolve(__dirname, "../../wave.ts"), "utf8");

        expect(source).toContain(
            "workspaceModelOptionsFromLoadedWorkspace(initOpts.windowId, workspace, initOpts.generation)"
        );
    });

    it("loads the AI user config before rendering the workspace", () => {
        const source = fs.readFileSync(path.resolve(__dirname, "../../wave.ts"), "utf8");

        expect(source).toContain('import { initAIUserConfig } from "@/app/store/ai-user-config";');
        expect(source).toMatch(/globalStore\.set\(atoms\.fullConfigAtom, fullConfig\);\s+initAIUserConfig\(\);/);
    });
});
