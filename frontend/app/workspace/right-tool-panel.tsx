// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
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

export type RightToolContentProps = {
    activeTool?: RightToolId;
};

export type RightToolCollapsedToggleProps = {
    onShow: () => void;
    onFocusPanel: () => void;
    className?: string;
};

export type RightToolPanelMagnifiedOverlayProps = Pick<
    RightToolPanelProps,
    "state" | "onSelectTool" | "onCloseTool" | "onFocusPanel"
> & {
    onExit: () => void;
    className?: string;
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

export function RightToolTabs({ activeTool, openedTools, onSelectTool, onCloseTool }: RightToolTabsProps) {
    if (openedTools.length === 0) {
        return null;
    }
    return (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
            {openedTools.map((tool) => {
                const metadata = RightToolMetadataById[tool];
                const active = tool === activeTool;
                return (
                    <div
                        key={tool}
                        className={cn(
                            "flex min-w-0 items-center rounded-md text-xs",
                            active ? "bg-hoverbg text-white" : "text-secondary hover:bg-hoverbg hover:text-white"
                        )}
                    >
                        <button
                            type="button"
                            aria-label={`Select ${metadata.label}`}
                            aria-current={active ? "page" : undefined}
                            className="min-w-0 cursor-pointer truncate px-2 py-1"
                            onClick={() => onSelectTool(tool)}
                        >
                            {metadata.label}
                        </button>
                        <button
                            type="button"
                            aria-label={`Close ${metadata.label}`}
                            className="cursor-pointer px-1.5 py-1 text-muted hover:text-white"
                            onClick={() => onCloseTool(tool)}
                        >
                            <i className="fa-solid fa-xmark" />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

export function RightToolContent({ activeTool }: RightToolContentProps) {
    if (activeTool == null) {
        return <RightToolLauncher onOpenTool={() => null} />;
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

export function RightToolCollapsedToggle({ onShow, onFocusPanel, className }: RightToolCollapsedToggleProps) {
    return (
        <button
            type="button"
            aria-label="Show right tool panel"
            className={cn(
                "flex h-full w-8 shrink-0 cursor-pointer items-center justify-center border-l border-border bg-panelbg text-xs text-secondary hover:bg-hoverbg hover:text-white",
                className
            )}
            onClick={onShow}
            onFocus={onFocusPanel}
        >
            <span className="-rotate-90 whitespace-nowrap">Tools</span>
        </button>
    );
}

export function RightToolPanelMagnifiedOverlay({
    state,
    onSelectTool,
    onCloseTool,
    onFocusPanel,
    onExit,
    className,
}: RightToolPanelMagnifiedOverlayProps) {
    if (!state.visible || !state.magnified || state.openedTools.length === 0) {
        return null;
    }
    return (
        <div
            aria-label="Magnified right tool panel"
            role="dialog"
            className={cn(
                "fixed inset-8 z-50 flex flex-col rounded-lg border border-border bg-panelbg shadow-2xl",
                className
            )}
            tabIndex={0}
            onFocus={onFocusPanel}
        >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-secondary">Tools</div>
                <button
                    type="button"
                    aria-label="Exit magnified right tool panel"
                    className="cursor-pointer rounded px-2 py-1 text-muted hover:bg-hoverbg hover:text-white"
                    onClick={onExit}
                >
                    <i className="fa-solid fa-down-left-and-up-right-to-center" />
                </button>
            </div>
            <RightToolTabs
                activeTool={state.activeTool}
                openedTools={state.openedTools}
                onSelectTool={onSelectTool}
                onCloseTool={onCloseTool}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
                <RightToolContent activeTool={state.activeTool} />
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
            style={{ width: state.width }}
            tabIndex={0}
            onFocus={onFocusPanel}
        >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-secondary">Tools</div>
                <button
                    type="button"
                    aria-label="Hide right tool panel"
                    className="cursor-pointer rounded px-2 py-1 text-muted hover:bg-hoverbg hover:text-white"
                    onClick={onHide}
                >
                    <i className="fa-solid fa-chevron-right" />
                </button>
            </div>
            <RightToolTabs
                activeTool={state.activeTool}
                openedTools={state.openedTools}
                onSelectTool={onSelectTool}
                onCloseTool={onCloseTool}
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
