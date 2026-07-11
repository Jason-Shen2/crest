// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { GitReviewSidebar } from "@/app/codereview/git-panel";
import { Icon } from "@/app/icon/Icon";
import { RightEditorModel } from "@/app/righteditor/right-editor-model";
import { RightEditorProductionRpc } from "@/app/righteditor/right-editor-rpc";
import { RightEditorWorkbench } from "@/app/righteditor/right-editor-workbench";
import { SourceControlPanel } from "@/app/sourcecontrol/source-control-panel";
import { getSettingsKeyAtom } from "@/store/global";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import type { CSSProperties, FocusEvent, MouseEvent, ReactNode } from "react";
import { RightToolId, RightToolIds, RightToolPanelState } from "./right-tool-panel-state";

type RightToolMetadata = {
    label: string;
    icon: string;
    description: string;
};

export type RightToolPanelProps = {
    state: RightToolPanelState;
    onOpenTool: (tool: RightToolId) => void;
    onSelectTool: (tool: RightToolId) => void;
    onCloseTool: (tool: RightToolId) => void;
    onHide: () => void;
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

export type RightToolPanelMagnifiedOverlayProps = Pick<
    RightToolPanelProps,
    "state" | "onOpenTool" | "onSelectTool" | "onCloseTool" | "onFocusPanel" | "onBlurPanel"
> & {
    onExit: () => void;
    className?: string;
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
                <div className="mt-1 text-xs text-secondary">Open one tool per type and switch between tabs here.</div>
            </div>
            <div className="grid w-full grid-cols-2 gap-3">
                {supportedTools.map((tool) => {
                    const metadata = RightToolMetadataById[tool];
                    return (
                        <button
                            key={tool}
                            type="button"
                            className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-border bg-panelbg p-4 text-secondary transition-colors hover:bg-hoverbg hover:text-white"
                            onClick={() => onOpenTool(tool)}
                        >
                            <i className={cn("text-lg", metadata.icon)} />
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
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-[#111113] px-2">
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
                className="flex h-full w-7 cursor-pointer list-none items-center justify-center rounded-md border border-transparent bg-[#202124] text-[#a1a1aa] transition-colors hover:border-[#3f3f46] hover:bg-[#2a2b2f] hover:text-[#f4f4f5] [&::-webkit-details-marker]:hidden"
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
                className="absolute right-0 top-8 z-50 flex w-44 flex-col gap-1 rounded-lg border border-[#34343a] bg-[#1f2023] p-1 shadow-2xl"
            >
                {availableTools.map((tool) => {
                    const metadata = RightToolMetadataById[tool];
                    return (
                        <button
                            key={tool}
                            type="button"
                            aria-label={`Open ${metadata.label} right tool`}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-[#d4d4d8] transition-colors hover:bg-[#2a2b2f] hover:text-[#f4f4f5]"
                            onClick={(event) => handleOpenTool(event, tool)}
                        >
                            <i className={cn("w-3.5 text-center text-xs", metadata.icon)} />
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
                                ? "border-[#4b5563] bg-[#2a2b2f] text-[#f4f4f5] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                                : "border-transparent bg-[#202124] text-[#a1a1aa] hover:border-[#3f3f46] hover:bg-[#27282c] hover:text-[#f4f4f5]"
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
                            <i className={cn("shrink-0 text-[13px]", metadata.icon)} />
                            <span className="min-w-0 truncate font-medium [@container(max-width:7.5rem)]:hidden">
                                {metadata.label}
                            </span>
                        </button>
                        <button
                            type="button"
                            aria-label={`Close ${metadata.label}`}
                            data-close-visibility="hover"
                            className={cn(
                                "pointer-events-none absolute right-1.5 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-[#71717a] transition-opacity hover:bg-[#3f3f46] hover:text-[#f4f4f5] focus:pointer-events-auto focus:opacity-100",
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
    if (activeTool === "codeReview") {
        return <GitReviewSidebar />;
    }
    if (activeTool === "sourceControl") {
        return <SourceControlPanel />;
    }
    const metadata = RightToolMetadataById[activeTool];
    return (
        <div className="flex h-full flex-col gap-2 p-4">
            <div className="flex items-center gap-2 text-primary">
                <i className={cn("text-base", metadata.icon)} />
                <div className="text-sm font-medium">{metadata.label} Tool</div>
            </div>
            <div className="text-xs text-secondary">{metadata.description}</div>
        </div>
    );
}

export function RightToolPanelMagnifiedOverlay({
    state,
    onOpenTool,
    onSelectTool,
    onCloseTool,
    onFocusPanel,
    onBlurPanel,
    onExit,
    className,
}: RightToolPanelMagnifiedOverlayProps) {
    const magnifiedBlockOpacity = useAtomValue(getSettingsKeyAtom("window:magnifiedblockopacity")) ?? 0.6;
    const magnifiedBlockBlur = useAtomValue(getSettingsKeyAtom("window:magnifiedblockblurprimarypx")) ?? 10;

    return (
        <RightToolPanelMagnifiedOverlayView
            state={state}
            onOpenTool={onOpenTool}
            onSelectTool={onSelectTool}
            onCloseTool={onCloseTool}
            onFocusPanel={onFocusPanel}
            onBlurPanel={onBlurPanel}
            onExit={onExit}
            className={className}
            magnifiedBlockOpacity={magnifiedBlockOpacity}
            magnifiedBlockBlur={magnifiedBlockBlur}
        />
    );
}

export function RightToolPanelMagnifiedOverlayView({
    state,
    onOpenTool,
    onSelectTool,
    onCloseTool,
    onFocusPanel,
    onBlurPanel,
    onExit,
    className,
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
        <div className="fixed inset-0 z-[var(--zindex-layout-magnified-node-backdrop)]" style={overlayStyle}>
            <button
                type="button"
                aria-label="Dismiss magnified right tool panel"
                className="absolute inset-0 cursor-default"
                style={{
                    backgroundColor: "rgb(from var(--color-panel) r g b / var(--magnified-block-opacity))",
                    backdropFilter: "blur(var(--magnified-block-blur))",
                }}
                onClick={onExit}
            />
            <div
                aria-label="Magnified right tool panel"
                role="dialog"
                className={cn(
                    "fixed inset-8 z-[var(--zindex-layout-magnified-node)] flex flex-col rounded-lg border border-border bg-panelbg shadow-2xl",
                    className
                )}
                data-right-tool-panel-root="true"
                tabIndex={0}
                onFocus={onFocusPanel}
                onBlurCapture={(event) => {
                    if (!didFocusLeaveCurrentTarget(event)) return;
                    onBlurPanel();
                }}
            >
                <RightToolTopBar
                    activeTool={state.activeTool}
                    openedTools={state.openedTools}
                    onOpenTool={onOpenTool}
                    onSelectTool={onSelectTool}
                    onCloseTool={onCloseTool}
                    action={
                        <button
                            type="button"
                            aria-label="Exit magnified right tool panel"
                            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hoverbg hover:text-white"
                            onClick={onExit}
                        >
                            <Icon name="minimize-01" size={14} />
                        </button>
                    }
                />
                <div className="min-h-0 flex-1 overflow-hidden">
                    <RightToolContent activeTool={state.activeTool} />
                </div>
            </div>
        </div>
    );
}

export function RightToolPanel({
    state,
    onOpenTool,
    onSelectTool,
    onCloseTool,
    onHide,
    onFocusPanel,
    onBlurPanel,
    className,
}: RightToolPanelProps) {
    if (!state.visible) {
        return null;
    }
    const hasOpenedTools = state.openedTools.length > 0;
    return (
        <aside
            aria-label="Right tool panel"
            className={cn("flex h-full shrink-0 flex-col border-l border-border bg-panelbg", className)}
            data-right-tool-panel-root="true"
            style={{ width: state.width }}
            tabIndex={0}
            onFocus={onFocusPanel}
            onBlurCapture={(event) => {
                if (!didFocusLeaveCurrentTarget(event)) return;
                onBlurPanel();
            }}
        >
            <RightToolTopBar
                activeTool={state.activeTool}
                openedTools={state.openedTools}
                onOpenTool={onOpenTool}
                onSelectTool={onSelectTool}
                onCloseTool={onCloseTool}
                action={
                    <button
                        type="button"
                        aria-label="Hide right tool panel"
                        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hoverbg hover:text-white"
                        onClick={onHide}
                    >
                        <Icon name="chevron-right" size={14} />
                    </button>
                }
            />
            <div className="min-h-0 flex-1 overflow-hidden">
                {hasOpenedTools ? (
                    <RightToolContent activeTool={state.activeTool} />
                ) : (
                    <RightToolLauncher onOpenTool={onOpenTool} />
                )}
            </div>
        </aside>
    );
}

function didFocusLeaveCurrentTarget(event: FocusEvent<HTMLElement>): boolean {
    return !event.currentTarget.contains(event.relatedTarget as Node);
}
