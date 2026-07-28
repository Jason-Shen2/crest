// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { Icon } from "@/app/icon/Icon";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isValidElement, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

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
            const value =
                key === "window:magnifiedblockopacity" ? 0.72 : key === "window:magnifiedblocksize" ? 0.95 : 4;
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

vi.mock("@/app/rightbrowser/right-browser", () => ({
    RightBrowser: () => <div aria-label="Right Browser">Right Browser</div>,
}));

vi.mock("@/app/rightterminal/right-terminal", () => ({
    RightTerminal: () => <div aria-label="Right Terminal">Right Terminal</div>,
}));

vi.mock("@/app/sourcecontrol/source-control-panel", () => ({
    SourceControlPanel: () => <div>Source Control Panel</div>,
}));

vi.mock("@/app/observability/observability-panel", () => ({
    ObservabilityPanel: ({ magnified }: { magnified?: boolean }) => (
        <div aria-label="Agent Observability" data-magnified={magnified ? "true" : "false"}>
            Agent Observability
        </div>
    ),
}));

vi.mock("@/app/element/magnify", () => ({
    MagnifyIcon: ({ enabled }: { enabled: boolean }) => <div className="magnify-icon" data-enabled={enabled} />,
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
    shouldAnimateRightToolPanelLayout,
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
            sessionId={undefined}
            onOpenTool={() => null}
            onSelectTool={() => null}
            onCloseTool={() => null}
            onMagnify={() => null}
            onFocusPanel={() => null}
            onBlurPanel={() => null}
        />
    );
}

function countMatches(markup: string, pattern: RegExp): number {
    return markup.match(pattern)?.length ?? 0;
}

function expectNoHardcodedHexColors(markup: string): void {
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}/);
}

function expectNoBackgroundTokensUsedAsText(markup: string): void {
    expect(markup).not.toMatch(/\btext-(muted|secondary)(?=[\s"/])/);
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
        return findElementByAriaLabel(
            (node.type as (props: TestElementProps) => ReactNode)(node.props),
            ariaLabel
        );
    }
    return findElementByAriaLabel(node.props.children, ariaLabel);
}

afterEach(cleanup);

describe("RightToolPanel", () => {
    it("renders the launcher when no tools are open", () => {
        const markup = renderPanel(DefaultRightToolPanelState);

        expect(markup).toContain('aria-label="Right tool panel"');
        expect(markup).toContain("Choose a tool to get started");
        expect(markup).toContain("Browser");
        expect(markup).toContain("Terminal");
        expect(markup).toContain("Code Review");
        expect(markup).toContain("Observability");
        expect(markup).not.toContain("Editor");
        expect(markup).toContain("width:400px");
        expect(markup).toContain('aria-label="Magnify right tool panel"');
        expect(markup).not.toContain('aria-label="Hide right tool panel"');
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
        expect(markup).toContain('aria-label="Right Browser"');
        expect(markup).not.toContain("Browser Tool");
        expect(markup).not.toContain("Choose a tool to get started");
        expect(markup).not.toContain(">Tools<");
    });

    it("passes magnified state only to observability content", () => {
        const normalObservability = renderPanel({
            ...DefaultRightToolPanelState,
            openedTools: ["observability"],
            activeTool: "observability",
        });
        const magnifiedObservability = renderPanel({
            ...DefaultRightToolPanelState,
            openedTools: ["observability"],
            activeTool: "observability",
            magnified: true,
        });
        const magnifiedBrowser = renderPanel({
            ...DefaultRightToolPanelState,
            openedTools: ["browser"],
            activeTool: "browser",
            magnified: true,
        });

        expect(normalObservability).toContain('data-magnified="false"');
        expect(magnifiedObservability).toContain('data-magnified="true"');
        expect(magnifiedBrowser).not.toContain("data-magnified");
    });

    it("uses theme color tokens instead of fixed hex colors for panel chrome", () => {
        const markup = renderToStaticMarkup(
            <>
                <RightToolPanel
                    state={{
                        ...DefaultRightToolPanelState,
                        openedTools: ["editor", "browser", "terminal", "codeReview", "sourceControl", "observability"],
                        activeTool: "browser",
                    }}
                    sessionId={undefined}
                    onOpenTool={() => null}
                    onSelectTool={() => null}
                    onCloseTool={() => null}
                    onMagnify={() => null}
                    onFocusPanel={() => null}
                    onBlurPanel={() => null}
                />
                <RightToolOpenMenu openedTools={["editor"]} onOpenTool={() => null} initiallyOpen />
            </>
        );

        expectNoHardcodedHexColors(markup);
        expectNoBackgroundTokensUsedAsText(markup);
        expect(markup).toContain("bg-panel");
        expect(markup).toContain("bg-fg-overlay");
        expect(markup).toContain("text-foreground");
        expect(markup).toContain("text-muted-foreground");
        expect(markup).toContain("border-border");
    });

    it("renders tool icons through the shared Icon component", () => {
        const markup = renderToStaticMarkup(
            <>
                <RightToolLauncher supportedTools={["editor", "browser"]} onOpenTool={() => null} />
                <RightToolOpenMenu openedTools={["editor"]} onOpenTool={() => null} initiallyOpen />
                <RightToolTabs
                    openedTools={["editor", "browser", "terminal", "codeReview"]}
                    activeTool="browser"
                    onSelectTool={() => null}
                    onCloseTool={() => null}
                />
            </>
        );

        expect(countMatches(markup, /<svg/g)).toBeGreaterThanOrEqual(10);
        expect(markup).not.toContain("<i");
        expect(markup).not.toContain("edit-02");
        expect(markup).not.toContain("globe-02");
    });

    it("renders nothing when hidden", () => {
        const markup = renderPanel({
            ...DefaultRightToolPanelState,
            visible: false,
        });

        expect(markup).toBe("");
    });

    it("renders the focusable right panel root", () => {
        const markup = renderPanel({
            ...DefaultRightToolPanelState,
            openedTools: ["editor"],
            activeTool: "editor",
        });

        expect(markup).toContain('aria-label="Right tool panel"');
        expect(markup).toContain('tabindex="0"');
    });

    it("renders a subtle block-like focus mask for selected panel feedback", () => {
        const markup = renderPanel({
            ...DefaultRightToolPanelState,
            openedTools: ["editor"],
            activeTool: "editor",
        });

        expect(markup).toContain('data-right-tool-panel-focus-mask="true"');
        expect(markup).toContain("rgb(from var(--color-accent) r g b / 45%)");
    });

    it("does not animate ordinary width-only resize while the panel is not magnified", () => {
        expect(
            shouldAnimateRightToolPanelLayout(
                { left: 876, top: 4, width: 400, height: 792 },
                { left: 776, top: 4, width: 500, height: 792 },
                false,
                false
            )
        ).toBe(false);
    });

    it("still animates between normal and magnified panel layouts", () => {
        expect(
            shouldAnimateRightToolPanelLayout(
                { left: 876, top: 4, width: 400, height: 792 },
                { left: 48, top: 48, width: 1824, height: 984 },
                false,
                true
            )
        ).toBe(true);
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
                    <button type="button" aria-label="Magnify right tool panel" onClick={onAction}>
                        <Icon name="arrow-expand-01" size={14} />
                    </button>
                }
            />
        );

        expect(markup).toContain('aria-label="Right tool tabs"');
        expect(markup).toContain('aria-label="Open right tool"');
        expect(markup).toContain('aria-label="Magnify right tool panel"');
        expect(markup).toContain('data-add-placement="tab-strip-end"');
        const actionButton = markup.match(/aria-label="Magnify right tool panel"[^>]*>[\s\S]*?<\/button>/);
        expect(actionButton).not.toBeNull();
        expect(actionButton![0]).toContain("<svg");
        expect(markup).toContain('aria-current="page"');
        expect(markup.indexOf('aria-label="Right tool tabs"')).toBeLessThan(
            markup.indexOf('aria-label="Open right tool"')
        );
        expect(markup.indexOf('aria-label="Open right tool"')).toBeLessThan(
            markup.indexOf('aria-label="Right tool panel actions"')
        );
        expect(markup).not.toContain(">Tools<");
    });

    it("toggles the open tool menu from a square add button and calls action handlers", () => {
        const onOpenTool = vi.fn();
        const onAction = vi.fn();
        const { container } = render(
            <RightToolTopBar
                activeTool="editor"
                openedTools={["editor"]}
                onOpenTool={onOpenTool}
                onSelectTool={() => null}
                onCloseTool={() => null}
                action={
                    <button type="button" aria-label="Magnify right tool panel" onClick={onAction}>
                        <Icon name="arrow-expand-01" size={14} />
                    </button>
                }
            />
        );

        const markup = container.innerHTML;
        // The + button is now a real <button> (not <summary>) and stays square (h-7 w-7, not w-9).
        expect(markup).toContain('aria-label="Open right tool"');
        expect(markup).not.toContain("h-7 w-9");
        expect(markup).toContain("h-7 w-7 cursor-pointer");

        act(() => {
            fireEvent.click(screen.getByLabelText("Magnify right tool panel"));
        });

        expect(onOpenTool).not.toHaveBeenCalled();
        expect(onAction).toHaveBeenCalledTimes(1);
    });

    it("renders an open tool menu with unopened tools only", () => {
        const markup = renderToStaticMarkup(
            <RightToolOpenMenu openedTools={["editor", "terminal"]} onOpenTool={() => null} initiallyOpen />
        );

        expect(markup).toContain('aria-label="Open right tool"');
        expect(markup).toContain('aria-expanded="true"');
        expect(markup).toContain('data-menu-surface="trae"');
        // Menu is positioned by floating-ui via inline style (no static left-0/top-8 Tailwind class).
        expect(markup).toMatch(/style="[^"]*position:\s*absolute/);
        expect(markup).toContain("w-44");
        expect(markup).toContain("p-1");
        expect(markup).toContain("text-xs");
        expect(markup).not.toContain("<details");
        expect(markup).not.toContain("absolute right-0");
        expect(markup).not.toContain("absolute left-0");
        expect(markup).not.toContain("top-8");
        expect(markup).not.toContain("top-9");
        expect(markup).not.toContain("w-52");
        expect(markup).not.toContain("p-1.5");
        expect(markup).not.toContain("text-sm font-medium");
        expect(markup).not.toContain('role="menu"');
        expect(markup).not.toContain('role="menuitem"');
        expect(markup).toContain('aria-label="Open Browser right tool"');
        expect(markup).toContain('aria-label="Open Code Review right tool"');
        expect(markup).toContain('aria-label="Open Observability right tool"');
        expect(markup).not.toContain('aria-label="Open Editor right tool"');
        expect(markup).not.toContain('aria-label="Open Terminal right tool"');
    });

    it("calls onOpenTool when an unopened tool menu item is selected", () => {
        const onOpenTool = vi.fn();
        render(<RightToolOpenMenu openedTools={["editor"]} onOpenTool={onOpenTool} initiallyOpen />);

        act(() => {
            fireEvent.click(screen.getByLabelText("Open Browser right tool"));
        });

        expect(onOpenTool).toHaveBeenCalledWith("browser");
    });

    it("hides the open button when all right tools are already open", () => {
        const markup = renderToStaticMarkup(
            <RightToolTopBar
                activeTool="editor"
                openedTools={["editor", "browser", "terminal", "codeReview", "sourceControl", "observability"]}
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

    it("marks active tabs, keeps icon labels, and declares close visibility behavior", () => {
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
        expect(markup).toContain('data-close-visibility="hover"');
        expect(markup).toContain('data-tab-content-align="center"');
        expect(markup).not.toContain('data-close-visibility="always"');
        expect(markup).not.toContain(" opacity-100");
        expect(markup).toContain("<svg");
        expect(markup).not.toContain("edit-02");
    });

    it("uses adaptive tool tab widths without horizontal scrolling", () => {
        const markup = renderToStaticMarkup(
            <RightToolTabs
                openedTools={["editor", "browser", "terminal", "codeReview"]}
                activeTool="codeReview"
                onSelectTool={() => null}
                onCloseTool={() => null}
            />
        );

        expect(markup).toContain('data-overflow-behavior="no-horizontal-scroll"');
        expect(markup).toContain('data-tab-sizing="adaptive-fill"');
        expect(markup).toContain('data-tab-width="adaptive-by-count"');
        expect(markup).toContain('data-label-collapse="hide-on-narrow"');
        expect(markup).toContain("container-type:inline-size");
        expect(markup).toContain("[@container(max-width:7.5rem)]:hidden");
        expect(markup).not.toContain("overflow-x-auto");
        expect(markup).not.toContain("no-scrollbar");
        expect(markup).not.toContain("scrollbar-width:none");
        expect(markup).not.toContain("basis-0");
        expect(markup).not.toContain("max-width:min");
        expect(markup).not.toContain("h-9");
        expect(markup).not.toContain("min-w-[10rem]");
    });

    it("keeps the add button next to the tab strip instead of pushing it to the far edge", () => {
        const markup = renderToStaticMarkup(
            <RightToolTopBar
                activeTool="editor"
                openedTools={["editor", "browser"]}
                onOpenTool={() => null}
                onSelectTool={() => null}
                onCloseTool={() => null}
            />
        );

        expect(markup).toContain('data-add-placement="tab-strip-end"');
        expect(markup).toContain("flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden");
        expect(markup).not.toContain("overflow-x-auto");
    });

    it("keeps every select and close control rendered for many tabs without clipping the tab strip", () => {
        const markup = renderToStaticMarkup(
            <RightToolTabs
                openedTools={["editor", "browser", "terminal", "codeReview"]}
                activeTool="terminal"
                onSelectTool={() => null}
                onCloseTool={() => null}
            />
        );

        expect(markup).toContain('data-overflow-behavior="no-horizontal-scroll"');
        expect(countMatches(markup, /aria-label="Select /g)).toBe(4);
        expect(countMatches(markup, /aria-label="Close /g)).toBe(4);
        expect(markup).toContain('aria-label="Select Editor"');
        expect(markup).toContain('aria-label="Close Editor"');
        expect(markup).toContain('aria-label="Select Browser"');
        expect(markup).toContain('aria-label="Close Browser"');
        expect(markup).toContain('aria-label="Select Terminal"');
        expect(markup).toContain('aria-label="Close Terminal"');
        expect(markup).toContain('aria-label="Select Code Review"');
        expect(markup).toContain('aria-label="Close Code Review"');
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

    it("renders the terminal content when the terminal tab is active", () => {
        const markup = renderToStaticMarkup(<RightToolContent activeTool="terminal" />);

        expect(markup).toContain('aria-label="Right Terminal"');
    });

    it("renders the observability content when the observability tab is active", () => {
        const markup = renderToStaticMarkup(<RightToolContent activeTool="observability" />);

        expect(markup).toContain('aria-label="Agent Observability"');
    });

    it("renders a magnified backdrop behind the active right tool", () => {
        const markup = renderToStaticMarkup(
            <RightToolPanelMagnifiedOverlay
                state={{
                    ...DefaultRightToolPanelState,
                    openedTools: ["editor", "browser"],
                    activeTool: "editor",
                    magnified: true,
                }}
                onExit={() => null}
            />
        );

        expect(markup).toContain('aria-label="Dismiss magnified right tool panel"');
        expect(markup).toContain("--magnified-block-opacity:0.72");
        expect(markup).toContain("--magnified-block-blur:4px");
        expect(markup).toContain("var(--zindex-layout-magnified-node-backdrop");
        expect(markup).not.toContain('aria-label="Magnified right tool panel"');
        expect(markup).not.toContain('aria-label="Exit magnified right tool panel"');
        expect(markup).not.toContain('aria-label="Right tool tabs"');
    });

    it("renders the right tool panel itself as the magnified shell", () => {
        const markup = renderPanel({
            ...DefaultRightToolPanelState,
            openedTools: ["editor", "browser"],
            activeTool: "editor",
            magnified: true,
        });

        expect(markup).toContain('aria-label="Magnified right tool panel"');
        expect(markup).toContain('role="dialog"');
        expect(markup).toContain("var(--zindex-layout-magnified-node");
        expect(markup).toContain("absolute");
        expect(markup).toContain("width:95%");
        expect(markup).toContain("height:95%");
        expect(markup).not.toContain("fixed inset-8");
        expect(markup).toContain('aria-label="Exit magnified right tool panel"');
        expect(markup).toContain('aria-label="Right tool tabs"');
        expect(markup).toContain('aria-label="Open right tool"');
        expect(markup).toContain("Right Editor Workbench");
        expect(markup).toContain('aria-label="Select Browser"');
        expect(markup).toContain('data-icon-name="magnify"');
        expect(markup).toContain("magnify-icon");
        expect(markup).not.toContain(">Tools<");
    });

    it("renders only the backdrop in the magnified overlay view", () => {
        const onExit = vi.fn();
        const markup = renderToStaticMarkup(
            <RightToolPanelMagnifiedOverlayView
                state={{
                    ...DefaultRightToolPanelState,
                    openedTools: ["editor"],
                    activeTool: "editor",
                    magnified: true,
                }}
                onExit={onExit}
                magnifiedBlockOpacity={0.72}
                magnifiedBlockBlur={4}
            />
        );
        expect(markup).toContain('aria-label="Dismiss magnified right tool panel"');
        expect(markup).not.toContain('aria-label="Exit magnified right tool panel"');
    });

    it("calls onExit when the magnified overlay backdrop is pressed", () => {
        const onExit = vi.fn();
        const markup = renderToStaticMarkup(
            <RightToolPanelMagnifiedOverlayView
                state={{
                    ...DefaultRightToolPanelState,
                    openedTools: ["editor"],
                    activeTool: "editor",
                    magnified: true,
                }}
                onExit={onExit}
                magnifiedBlockOpacity={0.72}
                magnifiedBlockBlur={4}
            />
        );
        expect(markup).toContain('aria-label="Dismiss magnified right tool panel"');
    });
});
