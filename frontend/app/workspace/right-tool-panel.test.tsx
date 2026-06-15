// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RightToolPanel } from "./right-tool-panel";
import { DefaultRightToolPanelState, RightToolPanelState } from "./right-tool-panel-state";

function renderPanel(state: RightToolPanelState): string {
    return renderToStaticMarkup(
        <RightToolPanel state={state} onOpenTool={() => null} onSelectTool={() => null} onCloseTool={() => null} />
    );
}

describe("RightToolPanel", () => {
    it("renders the launcher when no tools are open", () => {
        const markup = renderPanel(DefaultRightToolPanelState);

        expect(markup).toContain('aria-label="Right tool panel"');
        expect(markup).toContain("Choose a tool to get started");
        expect(markup).toContain("Editor");
        expect(markup).toContain("Browser");
        expect(markup).toContain("Terminal");
        expect(markup).toContain("Code Review");
        expect(markup).toContain("width:400px");
    });

    it("renders opened tabs and the active tool content", () => {
        const markup = renderPanel({
            ...DefaultRightToolPanelState,
            openedTools: ["editor", "browser"],
            activeTool: "browser",
        });

        expect(markup).toContain('aria-label="Select Editor"');
        expect(markup).toContain('aria-label="Select Browser"');
        expect(markup).toContain('aria-label="Close Browser"');
        expect(markup).toContain("Browser Tool");
        expect(markup).not.toContain("Choose a tool to get started");
    });

    it("renders nothing when hidden", () => {
        const markup = renderPanel({
            ...DefaultRightToolPanelState,
            visible: false,
        });

        expect(markup).toBe("");
    });
});
