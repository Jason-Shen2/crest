// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// TopBar — terax-ai Header.tsx layout, adapted to crest.
//
// Region layout (5 regions, separated by 1px vertical dividers):
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ ①mac   ② chrome (sidebar + ⋯) │ ③ space pill (Default ▸) │ ④ tabs │ ⑤ search + right chrome │
//   └────────────────────────────────────────────────────────────────────┘
//
// Crest differences from terax:
//   - "left chrome" carries the file-explorer toggle (terax has
//     sidebar + command palette).  We render the explorer toggle
//     plus the agent sessions toggle.
//   - Workspace switcher is a "Spaces · Default ▸" text pill.  The
//     click handler is driven by floating-ui directly (we bypass
//     <PopoverButton> which renders a crest <Button> that injects
//     `wave-button.solid.grey` styles and breaks the pill styling).
//   - Right chrome = right-panel toggle (sidebar-right-01),
//     notifications bell, settings gear.
//   - h-10 (40px) bar, bg-card rgba(34,34,34,0.85) + blur(20px).
//
// Compact mode (width < 720px) is a future enhancement — the
// trigger is `ResizeObserver` on the root, but the visible behavior
// here just keeps the chrome at full density.  Toggle later.

import { Tooltip } from "@/app/element/tooltip";
import { GitHubModel } from "@/app/github/github-model";
import { Icon } from "@/app/icon/Icon";
import { NotificationsModel } from "@/app/notifications/notifications-model";
import { NotificationsPanel } from "@/app/notifications/notifications-panel";
import { atoms } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import { WorkspaceSwitcher } from "@/app/tab/workspaceswitcher";
import { FixedAgentEntry } from "@/app/topbar/fixed-agent-entry";
import { getRightPanelButtonActive, toggleRightPanelFromTopBar } from "@/app/topbar/topbar-right-panel";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import {
    FloatingPortal,
    flip,
    offset,
    shift,
    useClick,
    useDismiss,
    useFloating,
    useInteractions,
} from "@floating-ui/react";
import { useAtomValue } from "jotai";
import type { PointerEventHandler, ReactNode } from "react";
import { memo, useCallback } from "react";
import "./topbar.scss";

// ---- Generic icon button ----
// Mirrors terax's `Button size="icon-sm" variant="ghost"` styling:
// size-7 (28×28) rounded-md, muted → hover:text-foreground +
// hover:bg-accent, with tooltip + click handler.
type ToolbarButtonProps = {
    icon: string;
    label: string;
    active?: boolean;
    badgeCount?: number;
    onClick?: () => void;
};

const ToolbarButton = memo(({ icon, label, active, badgeCount, onClick }: ToolbarButtonProps) => {
    return (
        <Tooltip
            content={label}
            placement="bottom"
            hideOnClick
            divClassName={`topbar-icon-btn ${active ? "is-active" : ""}`}
            divStyle={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            divOnClick={onClick}
        >
            <Icon name={icon} size={15} strokeWidth={1.75} />
            {badgeCount != null && badgeCount > 0 && (
                <span className="topbar-icon-badge">{badgeCount > 99 ? "99+" : badgeCount}</span>
            )}
        </Tooltip>
    );
});
ToolbarButton.displayName = "ToolbarButton";

// ---- Panel anchor for floating popovers (notifications) ----
type PanelAnchorProps = {
    children: React.ReactNode;
    panel: React.ReactNode;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
};

const PanelAnchor = memo(({ children, panel, isOpen, onOpenChange }: PanelAnchorProps) => {
    const { refs, floatingStyles, context } = useFloating({
        open: isOpen,
        onOpenChange,
        placement: "bottom-end",
        middleware: [offset(6), flip(), shift({ padding: 8 })],
    });
    const click = useClick(context);
    const dismiss = useDismiss(context);
    const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);

    return (
        <>
            <div
                ref={refs.setReference}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                {...getReferenceProps()}
            >
                {children}
            </div>
            {isOpen && (
                <FloatingPortal>
                    <div ref={refs.setFloating} style={{ ...floatingStyles, zIndex: 1000 }} {...getFloatingProps()}>
                        {panel}
                    </div>
                </FloatingPortal>
            )}
        </>
    );
});
PanelAnchor.displayName = "PanelAnchor";

// ---- Left chrome: shared panel modes ----
const LeftChrome = memo(({ workspaceId }: { workspaceId: string }) => {
    const model = WorkspaceLayoutModel.getInstance();
    const hydratedLeftPanel = useAtomValue(model.leftPanelAtom);
    const leftPanel = model.getLeftPanelStateForWorkspace(workspaceId, hydratedLeftPanel);
    return (
        <div className="topbar-left-chrome">
            <ToolbarButton
                icon="list-tree"
                label="Files"
                active={leftPanel.visible && leftPanel.mode === "files"}
                onClick={() => model.toggleLeftPanel("files")}
            />
            <ToolbarButton
                icon="message-01"
                label="Agent Sessions"
                active={leftPanel.visible && leftPanel.mode === "sessions"}
                onClick={() => model.toggleLeftPanel("sessions")}
            />
            <ToolbarButton
                icon="terminal"
                label="Terminal"
                active={leftPanel.visible && leftPanel.mode === "terminals"}
                onClick={() => model.toggleLeftPanel("terminals")}
            />
        </div>
    );
});
LeftChrome.displayName = "LeftChrome";

// ---- Search inline (right side, just an icon button) ----
// terax's SearchInline expands to a full input on focus; for this
// iteration we keep it as a single-button trigger that opens the
// CommandPalette modal.  Replace with the full search component
// once it lands.
const SearchInline = memo(() => {
    const onOpen = useCallback(() => {
        modalsModel.isModalOpen("CommandPaletteModal")
            ? modalsModel.popModal()
            : modalsModel.pushModal("CommandPaletteModal");
    }, []);
    return (
        <button type="button" title="Search" className="topbar-search" onClick={onOpen}>
            <Icon name="search-01" size={12} strokeWidth={1.75} />
            <span>Search</span>
            <span className="topbar-search-kbd" aria-label="Command P">
                <span className="topbar-search-kbd-command">⌘</span>
                <span className="topbar-search-kbd-key">P</span>
            </span>
        </button>
    );
});
SearchInline.displayName = "SearchInline";

// ---- Right chrome: right-panel toggle + notifications + settings ----
const RightChrome = memo(() => {
    const ghModel = GitHubModel.getInstance();
    const notifModel = NotificationsModel.getInstance();
    const layoutModel = WorkspaceLayoutModel.getInstance();
    const ghActivePanel = useAtomValue(ghModel.activePanelAtom);
    const notifUnread = useAtomValue(notifModel.unreadCountAtom);
    const workspace = useAtomValue(atoms.workspace);
    const hydratedRightToolPanelState = useAtomValue(layoutModel.rightToolPanelAtom);
    const rightToolPanelState = layoutModel.getRightToolPanelStateForWorkspace(
        workspace?.oid ?? "",
        hydratedRightToolPanelState
    );
    const rightPanelActive = getRightPanelButtonActive(rightToolPanelState);
    return (
        <div className="topbar-right-chrome">
            <ToolbarButton
                icon="sidebar-right-01"
                label="Toggle Right Panel"
                active={rightPanelActive}
                onClick={() => toggleRightPanelFromTopBar(layoutModel, rightToolPanelState.visible)}
            />
            <PanelAnchor
                isOpen={ghActivePanel === "notifications"}
                onOpenChange={(open) => ghModel.togglePanel(open ? "notifications" : null)}
                panel={<NotificationsPanel />}
            >
                <ToolbarButton
                    icon="bell"
                    label="Notifications"
                    active={ghActivePanel === "notifications"}
                    badgeCount={notifUnread}
                />
            </PanelAnchor>
            <ToolbarButton icon="settings-01" label="Settings" onClick={() => modalsModel.pushModal("SettingsModal")} />
        </div>
    );
});
RightChrome.displayName = "RightChrome";

type TopBarProps = {
    workspace: Workspace;
    agentActive?: boolean;
    onActivateAgent?: () => void;
    topTabStrip?: ReactNode;
    onPointerDownCapture?: PointerEventHandler<HTMLDivElement>;
};

export const TopBar = memo(
    ({ workspace, agentActive = false, onActivateAgent, topTabStrip, onPointerDownCapture }: TopBarProps) => {
        const isFullScreen = useAtomValue(atoms.isFullScreen);

        return (
            <div
                className="topbar-root"
                onPointerDownCapture={onPointerDownCapture}
                data-fullscreen={isFullScreen ? "1" : "0"}
            >
                {/* ① mac traffic lights spacer (h-10) */}
                <div className="topbar-traffic-spacer" />

                {/* ② left chrome: file explorer + agent sessions */}
                <LeftChrome workspaceId={workspace.oid} />
                <span className="topbar-vsep" />

                {/* ③ space pill (Default ▸) */}
                <WorkspaceSwitcher />

                {onActivateAgent != null ? <FixedAgentEntry active={agentActive} onActivate={onActivateAgent} /> : null}
                {topTabStrip}

                {/* ④ search + right chrome (notifications + settings) */}
                <div className="topbar-spacer" />
                <SearchInline />
                <span className="topbar-vsep" />
                <RightChrome />
            </div>
        );
    }
);
TopBar.displayName = "TopBar";
