// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { GitReviewSidebar } from "@/app/codereview/git-panel";
import { RightEditorModel } from "@/app/righteditor/right-editor-model";
import { RightEditorProductionRpc } from "@/app/righteditor/right-editor-rpc";
import { RightEditorWorkbench } from "@/app/righteditor/right-editor-workbench";
import { getSettingsKeyAtom } from "@/store/global";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import type { CSSProperties, FocusEvent } from "react";
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
        icon: "fa-regular fa-pen-to-square",
        description: "Open files and notes in the side workspace.",
    },
    browser: {
        label: "Browser",
        icon: "fa-solid fa-globe",
        description: "Browse web content without leaving the workspace.",
    },
    terminal: {
        label: "Terminal",
        icon: "fa-solid fa-terminal",
        description: "Keep a utility terminal attached to the workspace.",
    },
    codeReview: {
        label: "Code Review",
        icon: "fa-solid fa-code-compare",
        description: "Review code changes in a dedicated tool tab.",
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

export type RightToolTopBarProps = {
    activeTool?: RightToolId;
    openedTools: RightToolId[];
    onOpenTool: (tool: RightToolId) => void;
    onSelectTool: (tool: RightToolId) => void;
    onCloseTool: (tool: RightToolId) => void;
    action: {
        ariaLabel: string;
        iconClassName: string;
        onClick: () => void;
    };
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
    const nextTool = RightToolIds.find((tool) => !openedTools.includes(tool));
    return (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
            <RightToolTabs
                activeTool={activeTool}
                openedTools={openedTools}
                onSelectTool={onSelectTool}
                onCloseTool={onCloseTool}
            />
            <button
                type="button"
                aria-label="Open right tool"
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hoverbg hover:text-white"
                onClick={() => {
                    if (nextTool == null) return;
                    onOpenTool(nextTool);
                }}
            >
                <i className="fa-solid fa-plus" />
            </button>
            <div aria-label="Right tool panel actions" className="ml-auto flex shrink-0 items-center gap-1">
                <button
                    type="button"
                    aria-label={action.ariaLabel}
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hoverbg hover:text-white"
                    onClick={action.onClick}
                >
                    <i className={action.iconClassName} />
                </button>
            </div>
        </div>
    );
}

export function RightToolTabs({ activeTool, openedTools, onSelectTool, onCloseTool }: RightToolTabsProps) {
    return (
        <nav aria-label="Right tool tabs" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {openedTools.map((tool) => {
                const metadata = RightToolMetadataById[tool];
                const active = tool === activeTool;
                return (
                    <div
                        key={tool}
                        className={cn(
                            "flex min-w-0 items-center rounded-full border text-xs transition-colors",
                            active
                                ? "border-accent/40 bg-accent/10 text-white"
                                : "border-transparent bg-transparent text-secondary hover:bg-hoverbg hover:text-white"
                        )}
                    >
                        <button
                            type="button"
                            aria-label={`Select ${metadata.label}`}
                            aria-current={active ? "page" : undefined}
                            className="min-w-0 cursor-pointer truncate py-1 pl-2 pr-1"
                            onClick={() => onSelectTool(tool)}
                        >
                            {metadata.label}
                        </button>
                        <button
                            type="button"
                            aria-label={`Close ${metadata.label}`}
                            className="cursor-pointer py-1 pl-1 pr-2 text-muted hover:text-white"
                            onClick={() => onCloseTool(tool)}
                        >
                            <i className="fa-solid fa-xmark" />
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
                    backgroundColor: "rgb(from var(--block-bg-color) r g b / var(--magnified-block-opacity))",
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
                {RightToolTopBar({
                    activeTool: state.activeTool,
                    openedTools: state.openedTools,
                    onOpenTool,
                    onSelectTool,
                    onCloseTool,
                    action: {
                        ariaLabel: "Exit magnified right tool panel",
                        iconClassName: "fa-solid fa-down-left-and-up-right-to-center",
                        onClick: onExit,
                    },
                })}
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
            {RightToolTopBar({
                activeTool: state.activeTool,
                openedTools: state.openedTools,
                onOpenTool,
                onSelectTool,
                onCloseTool,
                action: {
                    ariaLabel: "Hide right tool panel",
                    iconClassName: "fa-solid fa-chevron-right",
                    onClick: onHide,
                },
            })}
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
