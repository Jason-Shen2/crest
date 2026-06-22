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

vi.mock("@/app/righteditor/right-editor-workbench", () => ({
    RightEditorWorkbench: () => <div>Right Editor Workbench</div>,
}));

import {
    RightToolContent,
    RightToolLauncher,
    RightToolOpenMenu,
    RightToolPanel,
    RightToolPanelMagnifiedOverlay,
    RightToolPanelMagnifiedOverlayView,
    RightToolTabs,
    RightToolTopBar,
} from "./right-tool-panel";
import { DefaultRightToolPanelState, RightToolPanelState } from "./right-tool-panel-state";

type TestElementProps = {
    "aria-label"?: string;
    children?: ReactNode;
    onClick?: (event?: { currentTarget: { closest: (selector: string) => { open: boolean } | null } }) => void;
    onBlurCapture?: (event: {
        currentTarget: { contains: (node: unknown) => boolean };
        relatedTarget: unknown;
    }) => void;
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
    if (typeof node.type === "function") {
        return findElementByAriaLabel(node.type(node.props), ariaLabel);
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
        expect(markup).toContain('aria-label="Open right tool"');
        expect(markup).toContain("Browser Tool");
        expect(markup).not.toContain("Choose a tool to get started");
        expect(markup).not.toContain(">Tools<");
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
    it("renders a reusable top bar with tabs, open button, and action group", () => {
        const onAction = vi.fn();
        const markup = renderToStaticMarkup(
            <RightToolTopBar
                activeTool="browser"
                openedTools={["editor", "browser"]}
                onOpenTool={() => null}
                onSelectTool={() => null}
                onCloseTool={() => null}
                action={
                    <button type="button" aria-label="Hide right tool panel" onClick={onAction}>
                        <i className="fa-solid fa-chevron-right" />
                    </button>
                }
            />
        );

        expect(markup).toContain('aria-label="Right tool tabs"');
        expect(markup).toContain('aria-label="Open right tool"');
        expect(markup).toContain('aria-label="Hide right tool panel"');
        expect(markup).toContain("fa-solid fa-chevron-right");
        expect(markup).toContain('aria-current="page"');
        expect(markup).not.toContain(">Tools<");
    });

    it("toggles the open tool menu from a square add button and calls action handlers", () => {
        const onOpenTool = vi.fn();
        const onAction = vi.fn();
        const topBar = RightToolTopBar({
            activeTool: "editor",
            openedTools: ["editor"],
            onOpenTool,
            onSelectTool: () => null,
            onCloseTool: () => null,
            action: (
                <button type="button" aria-label="Hide right tool panel" onClick={onAction}>
                    <i className="fa-solid fa-chevron-right" />
                </button>
            ),
        });
        const openButton = findElementByAriaLabel(topBar, "Open right tool");
        const actionButton = findElementByAriaLabel(topBar, "Hide right tool panel");

        expect(openButton.type).toBe("summary");
        expect(renderToStaticMarkup(topBar)).toContain("rounded-md");
        expect(actionButton.props.onClick).toBeTypeOf("function");
        actionButton.props.onClick?.();

        expect(onOpenTool).not.toHaveBeenCalled();
        expect(onAction).toHaveBeenCalledTimes(1);
    });

    it("renders an open tool menu with unopened tools only", () => {
        const markup = renderToStaticMarkup(
            <RightToolOpenMenu openedTools={["editor", "terminal"]} onOpenTool={() => null} initiallyOpen />
        );

        expect(markup).toContain("<details");
        expect(markup).toContain("open=\"\"");
        expect(markup).not.toContain('role="menu"');
        expect(markup).not.toContain('role="menuitem"');
        expect(markup).toContain('aria-label="Open Browser right tool"');
        expect(markup).toContain('aria-label="Open Code Review right tool"');
        expect(markup).not.toContain('aria-label="Open Editor right tool"');
        expect(markup).not.toContain('aria-label="Open Terminal right tool"');
    });

    it("calls onOpenTool and closes details when an unopened tool menu item is selected", () => {
        const onOpenTool = vi.fn();
        const menu = RightToolOpenMenu({
            openedTools: ["editor"],
            onOpenTool,
            initiallyOpen: true,
        });
        const browserItem = findElementByAriaLabel(menu, "Open Browser right tool");
        const details = { open: true };

        expect(browserItem.props.onClick).toBeTypeOf("function");
        browserItem.props.onClick?.({
            currentTarget: {
                closest: (selector: string) => (selector === "details" ? details : null),
            },
        });

        expect(onOpenTool).toHaveBeenCalledWith("browser");
        expect(details.open).toBe(false);
    });

    it("hides the open button when all right tools are already open", () => {
        const markup = renderToStaticMarkup(
            <RightToolTopBar
                activeTool="editor"
                openedTools={["editor", "browser", "terminal", "codeReview"]}
                onOpenTool={() => null}
                onSelectTool={() => null}
                onCloseTool={() => null}
            />
        );

        expect(markup).not.toContain('aria-label="Open right tool"');
        expect(markup).not.toContain('role="menu"');
    });

    it("exports launcher cards for the supported tools only", () => {
        const markup = renderToStaticMarkup(
            <RightToolLauncher supportedTools={["editor", "codeReview"]} onOpenTool={() => null} />
        );

        expect(markup).toContain("Editor");
        expect(markup).toContain("Code Review");
        expect(markup).not.toContain("Browser");
        expect(markup).not.toContain("Terminal");
    });

    it("marks active tabs, uses pill styling, and renders close buttons", () => {
        const markup = renderToStaticMarkup(
            <RightToolTabs
                openedTools={["editor", "browser"]}
                activeTool="browser"
                onSelectTool={() => null}
                onCloseTool={() => null}
            />
        );

        expect(markup).toContain('aria-label="Right tool tabs"');
        expect(markup).toContain('aria-label="Select Editor"');
        expect(markup).toContain('aria-label="Select Browser"');
        expect(markup).toContain('aria-current="page"');
        expect(markup).toContain('aria-label="Close Editor"');
        expect(markup).toContain('aria-label="Close Browser"');
        expect(markup).toContain("rounded-md");
        expect(markup).toContain("fa-regular fa-pen-to-square");
    });

    it("renders no tabs when no tools are open", () => {
        const markup = renderToStaticMarkup(
            <RightToolTabs openedTools={[]} onSelectTool={() => null} onCloseTool={() => null} />
        );

        expect(markup).toBe("");
    });

    it("calls select and close handlers from tab pills", () => {
        const onSelectTool = vi.fn();
        const onCloseTool = vi.fn();
        const tabs = RightToolTabs({
            openedTools: ["editor", "browser"],
            activeTool: "browser",
            onSelectTool,
            onCloseTool,
        });
        const selectEditor = findElementByAriaLabel(tabs, "Select Editor");
        const closeBrowser = findElementByAriaLabel(tabs, "Close Browser");

        expect(selectEditor.props.onClick).toBeTypeOf("function");
        selectEditor.props.onClick?.();
        expect(closeBrowser.props.onClick).toBeTypeOf("function");
        closeBrowser.props.onClick?.();

        expect(onSelectTool).toHaveBeenCalledWith("editor");
        expect(onCloseTool).toHaveBeenCalledWith("browser");
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
                onOpenTool={() => null}
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
        expect(markup).toContain('aria-label="Right tool tabs"');
        expect(markup).toContain('aria-label="Open right tool"');
        expect(markup).toContain("Right Editor Workbench");
        expect(markup).toContain('aria-label="Select Browser"');
        expect(markup).not.toContain(">Tools<");
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
            onOpenTool: () => null,
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
            onOpenTool: () => null,
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
