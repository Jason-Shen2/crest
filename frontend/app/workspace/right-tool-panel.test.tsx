// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isValidElement, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockSettings = vi.hoisted(() => ({
    atoms: new Map<string, import("jotai").PrimitiveAtom<unknown>>(),
}));

vi.mock("@/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    return {
        getSettingsKeyAtom: (key: string) => {
            let settingAtom = mockSettings.atoms.get(key);
            if (settingAtom != null) {
                return settingAtom;
            }
            const value = key === "window:magnifiedblockopacity" ? 0.72 : 4;
            settingAtom = jotaiActual.atom(value);
            mockSettings.atoms.set(key, settingAtom);
            return settingAtom;
        },
    };
});

vi.mock("@/app/codereview/git-panel", () => ({
    GitReviewSidebar: () => <div>Git Review Sidebar</div>,
}));

import {
    RightToolContent,
    RightToolLauncher,
    RightToolPanel,
    RightToolPanelMagnifiedOverlay,
    RightToolPanelMagnifiedOverlayView,
    RightToolTabs,
} from "./right-tool-panel";
import { DefaultRightToolPanelState, RightToolPanelState } from "./right-tool-panel-state";

type TestElementProps = {
    "aria-label"?: string;
    children?: ReactNode;
    onClick?: () => void;
    onBlurCapture?: (event: { currentTarget: { contains: (node: unknown) => boolean }; relatedTarget: unknown }) => void;
};

function renderPanel(state: RightToolPanelState): string {
    return renderToStaticMarkup(
        <RightToolPanel
            state={state}
            onOpenTool={() => null}
            onSelectTool={() => null}
            onCloseTool={() => null}
            onHide={() => null}
            onFocusPanel={() => null}
            onBlurPanel={() => null}
        />
    );
}

function findElementByAriaLabel(node: ReactNode, ariaLabel: string): ReactElement<TestElementProps> {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findElementByAriaLabel(child, ariaLabel);
            if (found != null) {
                return found;
            }
        }
    }
    if (!isValidElement<TestElementProps>(node)) {
        return undefined;
    }
    if (node.props["aria-label"] === ariaLabel) {
        return node;
    }
    return findElementByAriaLabel(node.props.children, ariaLabel);
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
        expect(markup).toContain('aria-label="Hide right tool panel"');
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

    it("clears panel focus when focus leaves the right panel", () => {
        const onBlurPanel = vi.fn();
        const panel = RightToolPanel({
            state: {
                ...DefaultRightToolPanelState,
                openedTools: ["editor"],
                activeTool: "editor",
            },
            onOpenTool: () => null,
            onSelectTool: () => null,
            onCloseTool: () => null,
            onHide: () => null,
            onFocusPanel: () => null,
            onBlurPanel,
        });
        const panelRoot = findElementByAriaLabel(panel, "Right tool panel");

        expect(panelRoot.props.onBlurCapture).toBeTypeOf("function");
        panelRoot.props.onBlurCapture?.({
            currentTarget: { contains: () => false },
            relatedTarget: {},
        });

        expect(onBlurPanel).toHaveBeenCalledTimes(1);
    });
});

describe("RightToolPanel parts", () => {
    it("exports launcher cards for the supported tools only", () => {
        const markup = renderToStaticMarkup(
            <RightToolLauncher supportedTools={["editor", "codeReview"]} onOpenTool={() => null} />
        );

        expect(markup).toContain("Editor");
        expect(markup).toContain("Code Review");
        expect(markup).not.toContain("Browser");
        expect(markup).not.toContain("Terminal");
    });

    it("marks active tabs and renders close buttons", () => {
        const markup = renderToStaticMarkup(
            <RightToolTabs
                openedTools={["editor", "browser"]}
                activeTool="browser"
                onSelectTool={() => null}
                onCloseTool={() => null}
            />
        );

        expect(markup).toContain('aria-label="Select Editor"');
        expect(markup).toContain('aria-label="Select Browser"');
        expect(markup).toContain('aria-current="page"');
        expect(markup).toContain('aria-label="Close Editor"');
        expect(markup).toContain('aria-label="Close Browser"');
    });

    it("renders the active tool content as a standalone export", () => {
        const markup = renderToStaticMarkup(<RightToolContent activeTool="codeReview" />);

        expect(markup).toContain("Git Review Sidebar");
    });

    it("renders a magnified overlay around the active right tool", () => {
        const markup = renderToStaticMarkup(
            <RightToolPanelMagnifiedOverlay
                state={{
                    ...DefaultRightToolPanelState,
                    openedTools: ["editor", "browser"],
                    activeTool: "editor",
                    magnified: true,
                }}
                onSelectTool={() => null}
                onCloseTool={() => null}
                onFocusPanel={() => null}
                onBlurPanel={() => null}
                onExit={() => null}
            />
        );

        expect(markup).toContain('aria-label="Magnified right tool panel"');
        expect(markup).toContain('aria-label="Dismiss magnified right tool panel"');
        expect(markup).toContain("--magnified-block-opacity:0.72");
        expect(markup).toContain("--magnified-block-blur:4px");
        expect(markup).toContain("var(--zindex-layout-magnified-node");
        expect(markup).toContain('aria-label="Exit magnified right tool panel"');
        expect(markup).toContain("Editor Tool");
        expect(markup).toContain('aria-label="Select Browser"');
    });

    it("calls onExit when the magnified overlay exit button is pressed", () => {
        const onExit = vi.fn();
        const overlay = RightToolPanelMagnifiedOverlayView({
            state: {
                ...DefaultRightToolPanelState,
                openedTools: ["editor"],
                activeTool: "editor",
                magnified: true,
            },
            onSelectTool: () => null,
            onCloseTool: () => null,
            onFocusPanel: () => null,
            onBlurPanel: () => null,
            onExit,
            magnifiedBlockOpacity: 0.72,
            magnifiedBlockBlur: 4,
        });
        const exitButton = findElementByAriaLabel(overlay, "Exit magnified right tool panel");

        expect(exitButton.props.onClick).toBeTypeOf("function");
        exitButton.props.onClick?.();

        expect(onExit).toHaveBeenCalledTimes(1);
    });

    it("calls onExit when the magnified overlay backdrop is pressed", () => {
        const onExit = vi.fn();
        const overlay = RightToolPanelMagnifiedOverlayView({
            state: {
                ...DefaultRightToolPanelState,
                openedTools: ["editor"],
                activeTool: "editor",
                magnified: true,
            },
            onSelectTool: () => null,
            onCloseTool: () => null,
            onFocusPanel: () => null,
            onBlurPanel: () => null,
            onExit,
            magnifiedBlockOpacity: 0.72,
            magnifiedBlockBlur: 4,
        });
        const backdrop = findElementByAriaLabel(overlay, "Dismiss magnified right tool panel");

        expect(backdrop.props.onClick).toBeTypeOf("function");
        backdrop.props.onClick?.();

        expect(onExit).toHaveBeenCalledTimes(1);
    });
});
