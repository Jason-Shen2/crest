// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { GitReviewSidebar } from "@/app/codereview/git-panel";
import { MagnifyIcon } from "@/app/element/magnify";
import { Icon } from "@/app/icon/Icon";
import { RightBrowser } from "@/app/rightbrowser/right-browser";
import { RightEditorModel } from "@/app/righteditor/right-editor-model";
import { RightEditorProductionRpc } from "@/app/righteditor/right-editor-rpc";
import { RightEditorWorkbench } from "@/app/righteditor/right-editor-workbench";
import { RightTerminal } from "@/app/rightterminal/right-terminal";
import { SourceControlPanel } from "@/app/sourcecontrol/source-control-panel";
import { getSettingsKeyAtom } from "@/store/global";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import type { CSSProperties, FocusEvent, MouseEvent, ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { RightToolId, RightToolIds, RightToolPanelState } from "./right-tool-panel-state";

type RightToolMetadata = {
    label: string;
    icon: string;
    description: string;
};

const RightToolPanelFocusRingColor = "rgb(from var(--color-accent) r g b / 45%)";

type RightToolPanelLayoutRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export function shouldAnimateRightToolPanelLayout(
    previousRect: RightToolPanelLayoutRect,
    rect: RightToolPanelLayoutRect,
    previousIsMagnified: boolean,
    isMagnified: boolean
): boolean {
    if (!previousIsMagnified && !isMagnified) {
        return false;
    }
    const dx = previousRect.left - rect.left;
    const dy = previousRect.top - rect.top;
    const sx = previousRect.width / rect.width;
    const sy = previousRect.height / rect.height;
    return Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5 || Math.abs(sx - 1) >= 0.01 || Math.abs(sy - 1) >= 0.01;
}

export type RightToolPanelProps = {
    state: RightToolPanelState;
    onOpenTool: (tool: RightToolId) => void;
    onSelectTool: (tool: RightToolId) => void;
    onCloseTool: (tool: RightToolId) => void;
    onMagnify: () => void;
    onFocusPanel: () => void;
    onBlurPanel: () => void;
    className?: string;
};

const RightToolMetadataById: Record<RightToolId, RightToolMetadata> = {
    editor: {
        label: "Editor",
        icon: "edit-02",
        description: "Open files and notes in the side workspace.",
    },
    browser: {
        label: "Browser",
        icon: "globe-02",
        description: "Browse web content without leaving the workspace.",
    },
    terminal: {
        label: "Terminal",
        icon: "terminal",
        description: "Keep a utility terminal attached to the workspace.",
    },
    codeReview: {
        label: "Code Review",
        icon: "git-branch-01",
        description: "Review code changes in a dedicated tool tab.",
    },
    sourceControl: {
        label: "Source Control",
        icon: "git-branch-01",
        description: "Manage Git changes, commits, and branches.",
    },
};

export type RightToolLauncherProps = {
    supportedTools?: RightToolId[];
    onOpenTool: (tool: RightToolId) => void;
};

export type RightToolTabsProps = {
    activeTool?: RightToolId;
    openedTools: RightToolId[];
    onSelectTool: (tool: RightToolId) => void;
    onCloseTool: (tool: RightToolId) => void;
};

export type RightToolOpenMenuProps = {
    openedTools: RightToolId[];
    onOpenTool: (tool: RightToolId) => void;
    initiallyOpen?: boolean;
};

export type RightToolTopBarProps = {
    activeTool?: RightToolId;
    openedTools: RightToolId[];
    onOpenTool: (tool: RightToolId) => void;
    onSelectTool: (tool: RightToolId) => void;
    onCloseTool: (tool: RightToolId) => void;
    action?: ReactNode;
};

export type RightToolContentProps = {
    activeTool?: RightToolId;
};

function disposeRightEditorModelPath(path: string): void {
    void import("@/app/righteditor/monaco-model-registry")
        .then(({ MonacoModelRegistry }) => {
            MonacoModelRegistry.getInstance().disposePath(path);
        })
        .catch(() => undefined);
}

function migrateRightEditorModelPath(oldPath: string, newPath: string): void {
    void import("@/app/righteditor/monaco-model-registry")
        .then(({ MonacoModelRegistry }) => {
            MonacoModelRegistry.getInstance().migratePath(oldPath, newPath);
        })
        .catch(() => undefined);
}

export type RightToolPanelMagnifiedOverlayProps = {
    state: RightToolPanelState;
    onExit: () => void;
};

export type RightToolPanelMagnifiedOverlayViewProps = RightToolPanelMagnifiedOverlayProps & {
    magnifiedBlockOpacity: number;
    magnifiedBlockBlur: number;
};

export function RightToolLauncher({ supportedTools = RightToolIds, onOpenTool }: RightToolLauncherProps) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <div>
                <div className="text-sm font-medium text-primary">Choose a tool to get started</div>
                <div className="mt-1 text-xs text-muted-foreground">Open one tool per type and switch between tabs here.</div>
            </div>
            <div className="grid w-full grid-cols-2 gap-3">
                {supportedTools.map((tool) => {
                    const metadata = RightToolMetadataById[tool];
                    return (
                        <button
                            key={tool}
                            type="button"
                            className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-border bg-fg-overlay-1/40 p-4 text-muted-foreground transition-colors hover:bg-fg-overlay-2 hover:text-foreground"
                            onClick={() => onOpenTool(tool)}
                        >
                            <Icon name={metadata.icon} size={18} />
                            <span className="text-xs font-medium">{metadata.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export function RightToolTopBar({
    activeTool,
    openedTools,
    onOpenTool,
    onSelectTool,
    onCloseTool,
    action,
}: RightToolTopBarProps) {
    const hasAvailableTools = RightToolIds.some((tool) => !openedTools.includes(tool));
    return (
        <div className="flex h-10 shrink-0 items-center gap-2 bg-panel/95 px-2 rounded-t-xl backdrop-blur-sm">
            <div className="flex min-w-0 flex-1 items-center gap-1">
                <RightToolTabs
                    activeTool={activeTool}
                    openedTools={openedTools}
                    onSelectTool={onSelectTool}
                    onCloseTool={onCloseTool}
                />
                {hasAvailableTools ? <RightToolOpenMenu openedTools={openedTools} onOpenTool={onOpenTool} /> : null}
            </div>
            {action != null ? (
                <div aria-label="Right tool panel actions" className="ml-0 flex shrink-0 items-center gap-1">
                    {action}
                </div>
            ) : null}
        </div>
    );
}

export function RightToolOpenMenu({ openedTools, onOpenTool, initiallyOpen }: RightToolOpenMenuProps) {
    const availableTools = RightToolIds.filter((tool) => !openedTools.includes(tool));
    if (availableTools.length === 0) {
        return null;
    }
    const closeDetails = (event: MouseEvent<HTMLElement>) => {
        const details = event.currentTarget.closest("details");
        if (details != null) {
            details.open = false;
        }
    };
    const handleOpenTool = (event: MouseEvent<HTMLButtonElement>, tool: RightToolId) => {
        onOpenTool(tool);
        closeDetails(event);
    };
    return (
        <details
            className="relative flex h-7 shrink-0 items-center"
            data-add-placement="tab-strip-end"
            open={initiallyOpen ? true : undefined}
        >
            <summary
                aria-label="Open right tool"
                className="flex h-full w-7 cursor-pointer list-none items-center justify-center rounded-md border border-transparent bg-fg-overlay-1/60 text-muted-foreground transition-colors hover:border-border hover:bg-fg-overlay-2 hover:text-foreground [&::-webkit-details-marker]:hidden"
            >
                <Icon name="plus" size={14} className="text-xs" />
            </summary>
            <button
                type="button"
                aria-label="Close right tool menu"
                aria-hidden="true"
                data-menu-backdrop="true"
                tabIndex={-1}
                className="fixed inset-0 z-40 cursor-default border-0 bg-transparent p-0"
                onClick={closeDetails}
            />
            <div
                aria-label="Open right tool menu"
                data-menu-surface="trae"
                className="absolute right-0 top-8 z-50 flex w-44 flex-col gap-1 rounded-lg border border-border bg-panel p-1 shadow-2xl"
            >
                {availableTools.map((tool) => {
                    const metadata = RightToolMetadataById[tool];
                    return (
                        <button
                            key={tool}
                            type="button"
                            aria-label={`Open ${metadata.label} right tool`}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-foreground/85 transition-colors hover:bg-fg-overlay-2 hover:text-foreground"
                            onClick={(event) => handleOpenTool(event, tool)}
                        >
                            <Icon name={metadata.icon} size={14} className="shrink-0" />
                            <span>{metadata.label}</span>
                        </button>
                    );
                })}
            </div>
        </details>
    );
}

export function RightToolTabs({ activeTool, openedTools, onSelectTool, onCloseTool }: RightToolTabsProps) {
    if (openedTools.length === 0) {
        return null;
    }
    return (
        <nav
            aria-label="Right tool tabs"
            data-overflow-behavior="no-horizontal-scroll"
            data-tab-sizing="adaptive-fill"
            data-tab-width="adaptive-by-count"
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden pr-1"
        >
            {openedTools.map((tool) => {
                const metadata = RightToolMetadataById[tool];
                const active = tool === activeTool;
                return (
                    <div
                        key={tool}
                        className={cn(
                            "group/tab relative flex h-7 min-w-7 max-w-[14rem] flex-1 items-center rounded-md border text-xs transition-colors",
                            active
                                ? "border-border bg-fg-overlay-2 text-foreground ring-1 ring-border/40"
                                : "border-transparent bg-fg-overlay-1/60 text-muted-foreground hover:border-border hover:bg-fg-overlay-2 hover:text-foreground"
                        )}
                        style={{ containerType: "inline-size" }}
                    >
                        <button
                            type="button"
                            aria-label={`Select ${metadata.label}`}
                            aria-current={active ? "page" : undefined}
                            data-tab-content-align="center"
                            data-label-collapse="hide-on-narrow"
                            className="flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 px-2"
                            onClick={() => onSelectTool(tool)}
                        >
                            <Icon name={metadata.icon} size={14} className="shrink-0 text-[13px]" />
                            <span className="min-w-0 truncate font-medium [@container(max-width:7.5rem)]:hidden">
                                {metadata.label}
                            </span>
                        </button>
                        <button
                            type="button"
                            aria-label={`Close ${metadata.label}`}
                            data-close-visibility="hover"
                            className={cn(
                                "pointer-events-none absolute right-1.5 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 transition-opacity hover:bg-fg-overlay-3 hover:text-foreground focus:pointer-events-auto focus:opacity-100",
                                "opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100"
                            )}
                            onClick={() => onCloseTool(tool)}
                        >
                            <Icon name="xmark" size={14} />
                        </button>
                    </div>
                );
            })}
        </nav>
    );
}

export function RightToolContent({ activeTool }: RightToolContentProps) {
    if (activeTool == null) {
        return <RightToolLauncher onOpenTool={() => null} />;
    }
    if (activeTool === "editor") {
        return (
            <RightEditorWorkbench
                model={RightEditorModel.getInstance(RightEditorProductionRpc, {
                    disposeModelPath: disposeRightEditorModelPath,
                    migrateModelPath: migrateRightEditorModelPath,
                })}
            />
        );
    }
    if (activeTool === "browser") {
        return <RightBrowser />;
    }
    if (activeTool === "terminal") {
        return <RightTerminal />;
    }
    if (activeTool === "codeReview") {
        return <GitReviewSidebar />;
    }
    if (activeTool === "sourceControl") {
        return <SourceControlPanel />;
    }
    return null;
}

function RightToolPanelContent({ state, onOpenTool }: { state: RightToolPanelState; onOpenTool: (tool: RightToolId) => void }) {
    if (state.openedTools.length === 0) {
        return (
            <div className="min-h-0 flex-1 overflow-hidden rounded-b-xl">
                <RightToolLauncher onOpenTool={onOpenTool} />
            </div>
        );
    }
    return (
        <div className="min-h-0 flex-1 overflow-hidden rounded-b-xl">
            <RightToolContent activeTool={state.activeTool} />
        </div>
    );
}

export function RightToolPanelMagnifiedOverlay({
    state,
    onExit,
}: RightToolPanelMagnifiedOverlayProps) {
    const magnifiedBlockOpacity = useAtomValue(getSettingsKeyAtom("window:magnifiedblockopacity")) ?? 0.6;
    const magnifiedBlockBlur = useAtomValue(getSettingsKeyAtom("window:magnifiedblockblurprimarypx")) ?? 10;

    return (
        <RightToolPanelMagnifiedOverlayView
            state={state}
            onExit={onExit}
            magnifiedBlockOpacity={magnifiedBlockOpacity}
            magnifiedBlockBlur={magnifiedBlockBlur}
        />
    );
}

export function RightToolPanelMagnifiedOverlayView({
    state,
    onExit,
    magnifiedBlockOpacity,
    magnifiedBlockBlur,
}: RightToolPanelMagnifiedOverlayViewProps) {
    if (!state.visible || !state.magnified || state.openedTools.length === 0) {
        return null;
    }
    const overlayStyle = {
        "--magnified-block-opacity": magnifiedBlockOpacity,
        "--magnified-block-blur": `${magnifiedBlockBlur}px`,
    } as CSSProperties;
    return (
        <div
            className="absolute inset-0 z-[var(--zindex-layout-magnified-node-backdrop)]"
            style={overlayStyle}
        >
            <button
                type="button"
                aria-label="Dismiss magnified right tool panel"
                className="absolute inset-0 cursor-default transition-opacity duration-200 ease-linear"
                style={{
                    backgroundColor: "rgb(from var(--color-panel) r g b / var(--magnified-block-opacity))",
                    backdropFilter: "blur(var(--magnified-block-blur))",
                }}
                onClick={onExit}
            />
        </div>
    );
}

export function RightToolPanel({
    state,
    onOpenTool,
    onSelectTool,
    onCloseTool,
    onMagnify,
    onFocusPanel,
    onBlurPanel,
    className,
}: RightToolPanelProps) {
    const panelRef = useRef<HTMLElement | null>(null);
    const previousRectRef = useRef<DOMRect | null>(null);
    const previousIsMagnifiedRef = useRef<boolean | null>(null);
    const magnifiedBlockSize = useAtomValue(getSettingsKeyAtom("window:magnifiedblocksize")) ?? 0.95;
    const isMagnified = state.magnified && state.openedTools.length > 0;
    const boundedMagnifiedBlockSize = Math.min(Math.max(magnifiedBlockSize, 0.1), 1);
    const magnifiedBlockMarginPct = ((1 - boundedMagnifiedBlockSize) / 2) * 100;
    const magnifiedBlockSizePct = boundedMagnifiedBlockSize * 100;
    const focusRingStyle = {
        "--right-tool-panel-focus-ring-color": RightToolPanelFocusRingColor,
    } as CSSProperties;
    const panelStyle = isMagnified
        ? ({
              ...focusRingStyle,
              top: `${magnifiedBlockMarginPct}%`,
              left: `${magnifiedBlockMarginPct}%`,
              width: `${magnifiedBlockSizePct}%`,
              height: `${magnifiedBlockSizePct}%`,
          } as CSSProperties)
        : { ...focusRingStyle, width: state.width };

    useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel) return;

        const rect = panel.getBoundingClientRect();
        const previousRect = previousRectRef.current;
        const previousIsMagnified = previousIsMagnifiedRef.current;
        previousRectRef.current = rect;
        previousIsMagnifiedRef.current = isMagnified;

        if (!previousRect || previousIsMagnified == null) return;
        if (!shouldAnimateRightToolPanelLayout(previousRect, rect, previousIsMagnified, isMagnified)) return;

        const dx = previousRect.left - rect.left;
        const dy = previousRect.top - rect.top;
        const sx = previousRect.width / rect.width;
        const sy = previousRect.height / rect.height;

        panel.style.transformOrigin = "top left";
        panel.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
        panel.style.transition = "none";

        const raf = requestAnimationFrame(() => {
            panel.style.transition = "transform 200ms linear";
            panel.style.transform = "";
        });

        const cleanup = () => {
            panel.style.transition = "";
            panel.style.transformOrigin = "";
        };
        panel.addEventListener("transitionend", cleanup, { once: true });

        return () => {
            cancelAnimationFrame(raf);
            panel.removeEventListener("transitionend", cleanup);
        };
    }, [isMagnified, magnifiedBlockSize, state.width]);

    if (!state.visible) {
        return null;
    }

    return (
        <aside
            ref={panelRef}
            aria-label={isMagnified ? "Magnified right tool panel" : "Right tool panel"}
            role={isMagnified ? "dialog" : undefined}
            className={cn(
                "group/right-panel relative m-1 flex h-[calc(100%-0.5rem)] shrink-0 flex-col overflow-hidden rounded-[var(--block-border-radius)] border border-border/60 bg-panel p-px shadow-sm shadow-black/10 backdrop-blur-sm will-change-transform",
                !isMagnified && "transition-shadow hover:shadow-md hover:shadow-black/15",
                isMagnified &&
                    "absolute z-[var(--zindex-layout-magnified-node)] m-0 border-border/80 shadow-2xl shadow-black/20 backdrop-blur-md",
                className
            )}
            data-right-tool-panel-root="true"
            style={panelStyle}
            tabIndex={0}
            onFocus={onFocusPanel}
            onBlurCapture={(event) => {
                if (!didFocusLeaveCurrentTarget(event)) return;
                onBlurPanel();
            }}
        >
            <div
                aria-hidden="true"
                data-right-tool-panel-focus-mask="true"
                className="pointer-events-none absolute inset-0 z-[var(--zindex-block-mask-inner)] rounded-[var(--block-border-radius)] border-2 border-transparent group-focus-within/right-panel:border-[var(--right-tool-panel-focus-ring-color)]"
            />
            <RightToolTopBar
                activeTool={state.activeTool}
                openedTools={state.openedTools}
                onOpenTool={onOpenTool}
                onSelectTool={onSelectTool}
                onCloseTool={onCloseTool}
                action={
                    <button
                        type="button"
                        aria-label={isMagnified ? "Exit magnified right tool panel" : "Magnify right tool panel"}
                        data-icon-name="magnify"
                        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-hoverbg hover:text-foreground"
                        onClick={onMagnify}
                    >
                        <MagnifyIcon enabled={isMagnified} />
                    </button>
                }
            />
            <RightToolPanelContent state={state} onOpenTool={onOpenTool} />
        </aside>
    );
}

function didFocusLeaveCurrentTarget(event: FocusEvent<HTMLElement>): boolean {
    return !event.currentTarget.contains(event.relatedTarget as Node);
}
