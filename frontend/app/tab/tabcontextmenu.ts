// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getOrefMetaKeyAtom, globalStore } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { makeORef } from "../store/wos";
import type { TabEnv } from "./tab";
import { TabColorLabels, TabColorOrder } from "./tab-color-utils";
import type { VtabMenuItem } from "./vtab-context-menu";

// Color identifiers mirror warp's `TAB_COLOR_OPTIONS` (Red/Green/
// Yellow/Blue/Magenta/Cyan — `app/src/ui_components/color_dot.rs:18`).
// Stored values are these ids (not hexes) so a theme change live-
// recolors every flagged tab.  See `tab-color-utils.ts` for the
// theme-resolved hex lookup.

export function buildTabBarContextMenu(env: TabEnv): ContextMenuItem[] {
    const currentTabBar = globalStore.get(env.getSettingsKeyAtom("app:tabbar")) ?? "top";
    const tabBarSubmenu: ContextMenuItem[] = [
        {
            label: "Top",
            type: "checkbox",
            checked: currentTabBar === "top",
            click: () => fireAndForget(() => env.rpc.SetConfigCommand(TabRpcClient, { "app:tabbar": "top" })),
        },
        {
            label: "Left",
            type: "checkbox",
            checked: currentTabBar === "left",
            click: () => fireAndForget(() => env.rpc.SetConfigCommand(TabRpcClient, { "app:tabbar": "left" })),
        },
    ];
    return [{ label: "Tab Bar Position", type: "submenu", submenu: tabBarSubmenu }];
}

export interface TabContextMenuParams {
    id: string;
    renameRef: React.RefObject<(() => void) | null>;
    env: TabEnv;

    // Copy-metadata inputs.  Each field is optional — when blank
    // (empty/whitespace), the corresponding Copy item is hidden
    // (warp's `copyable_metadata_value`: trim + filter blanks).
    tabTitle?: string; // resolved display title (custom name OR cwd-derived fallback)
    cwd?: string;
    gitBranch?: string;
    // Whether the tab name has been user-customized (i.e. not the
    // "T<n>" auto-generated form).  Drives "Reset tab name" visibility
    // (warp's `if title.is_some()` gate at tab.rs:413).
    hasCustomName?: boolean;

    // Panes-mode flag — flips the title-copy label from "Copy tab
    // title" to "Copy pane title" (warp tab.rs:335 vs 346).
    isPanesMode?: boolean;

    // Position info — drives Move/Close-others visibility.  When all
    // are omitted, the menu degrades to the rename + close + color
    // subset (used by callers that don't track ordering).
    tabIndex?: number;
    totalTabs?: number;
    isVerticalTabs?: boolean;

    // Operation callbacks.  `onCloseTab` is required.  All others are
    // optional — missing means the item is hidden (warp's pattern of
    // conditional `menu_items.push`).
    onCloseTab: () => void;
    onCloseOtherTabs?: () => void;
    onCloseTabsBelow?: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onResetTabName?: () => void;
}

function copyToClipboardItem(label: string, value: string | undefined): ContextMenuItem | null {
    // warp's `Self::copyable_metadata_value` rejects blank-after-trim
    // strings — match that exactly so the menu doesn't surface
    // copy-of-nothing entries.
    if (!value || !value.trim()) return null;
    return {
        label,
        click: () => fireAndForget(() => navigator.clipboard.writeText(value)),
    };
}

export function buildTabContextMenu(params: TabContextMenuParams): ContextMenuItem[];
// Backward-compat overload — the horizontal tab bar (tab.tsx) still
// calls with positional args.  We accept both shapes; the legacy form
// gets the rename + close + color subset.
export function buildTabContextMenu(
    id: string,
    renameRef: React.RefObject<(() => void) | null>,
    onClose: (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null) => void,
    env: TabEnv
): ContextMenuItem[];
export function buildTabContextMenu(
    paramsOrId: TabContextMenuParams | string,
    renameRef?: React.RefObject<(() => void) | null>,
    onClose?: (event: React.MouseEvent<HTMLButtonElement, MouseEvent> | null) => void,
    env?: TabEnv
): ContextMenuItem[] {
    const params: TabContextMenuParams =
        typeof paramsOrId === "string"
            ? {
                  id: paramsOrId,
                  renameRef: renameRef!,
                  env: env!,
                  onCloseTab: () => onClose?.(null),
              }
            : paramsOrId;

    const {
        id,
        renameRef: renameRefParam,
        env: envParam,
        tabTitle,
        cwd,
        gitBranch,
        hasCustomName,
        isPanesMode,
        tabIndex,
        totalTabs,
        isVerticalTabs,
        onCloseTab,
        onCloseOtherTabs,
        onCloseTabsBelow,
        onMoveUp,
        onMoveDown,
        onResetTabName,
    } = params;

    const sections: ContextMenuItem[][] = [];

    // Section 1 — Copy metadata (warp tab.rs:306-376).
    // Order: branch, title, cwd, PR link (PR skipped — not plumbed
    // in crest).  Title label flips to "Copy pane title" in panes
    // mode (warp's display_granularity check at tab.rs:322-347).
    // No `hasCustomName` gate on the title item — warp surfaces it
    // whenever the resolved value is non-blank, even for auto names.
    const copySection: ContextMenuItem[] = [];
    const branchItem = copyToClipboardItem("Copy branch", gitBranch);
    if (branchItem) copySection.push(branchItem);
    const titleItem = copyToClipboardItem(
        isPanesMode ? "Copy pane title" : "Copy tab title",
        tabTitle
    );
    if (titleItem) copySection.push(titleItem);
    const cwdItem = copyToClipboardItem("Copy working directory", cwd);
    if (cwdItem) copySection.push(cwdItem);
    if (copySection.length > 0) sections.push(copySection);

    // Section 2 — Modify tab (warp tab.rs:396-450).
    const modifySection: ContextMenuItem[] = [];
    modifySection.push({ label: "Rename tab", click: () => renameRefParam?.current?.() });
    if (hasCustomName && onResetTabName) {
        modifySection.push({ label: "Reset tab name", click: onResetTabName });
    }
    // Move up/down — labels swap by orientation (warp tab.rs:429-447).
    if (tabIndex != null && totalTabs != null) {
        const notLast = tabIndex < totalTabs - 1;
        const notFirst = tabIndex > 0;
        if (notLast && onMoveDown) {
            modifySection.push({
                label: isVerticalTabs ? "Move Tab Down" : "Move Tab Right",
                click: onMoveDown,
            });
        }
        if (notFirst && onMoveUp) {
            modifySection.push({
                label: isVerticalTabs ? "Move Tab Up" : "Move Tab Left",
                click: onMoveUp,
            });
        }
    }
    sections.push(modifySection);

    // Section 3 — Close (warp tab.rs:483-518).
    const closeSection: ContextMenuItem[] = [];
    closeSection.push({ label: "Close tab", click: onCloseTab });
    if (totalTabs != null && totalTabs > 1 && onCloseOtherTabs) {
        closeSection.push({ label: "Close other tabs", click: onCloseOtherTabs });
    }
    if (tabIndex != null && totalTabs != null) {
        const notLast = tabIndex < totalTabs - 1;
        if (notLast && onCloseTabsBelow) {
            closeSection.push({
                label: isVerticalTabs ? "Close Tabs Below" : "Close Tabs to the Right",
                click: onCloseTabsBelow,
            });
        }
    }
    sections.push(closeSection);

    // Section 4 — Color picker (warp tab.rs:530-540).  Inlined as
    // top-level checkbox items, NOT a submenu — warp's dot picker
    // and legacy ItemsRow both render directly in the menu body
    // (one row of six color affordances).  Electron native menus
    // stack vertically, so the six items appear stacked; semantics
    // still match (each item toggles via `ToggleTabColor`).
    // No separate "None/Default" entry — clicking the currently
    // checked color clears it, matching warp's toggle dispatch.
    const tabORef = makeORef("tab", id);
    const currentFlagColor =
        (globalStore.get(getOrefMetaKeyAtom(tabORef, "tab:flagcolor")) as string | undefined) ?? null;
    const colorSection: ContextMenuItem[] = TabColorOrder.map((id) => {
        const isCurrent = currentFlagColor === id;
        return {
            label: TabColorLabels[id],
            type: "checkbox" as const,
            checked: isCurrent,
            click: () =>
                fireAndForget(() =>
                    envParam.rpc.SetMetaCommand(TabRpcClient, {
                        oref: tabORef,
                        // Toggle: clicking the currently-checked color
                        // clears it (warp ToggleTabColor semantics —
                        // dot_color_option_menu_items dispatch path).
                        meta: { "tab:flagcolor": isCurrent ? null : id },
                    })
                ),
        };
    });
    sections.push(colorSection);

    // Stitch sections together with separators (warp's loop in
    // `menu_items_with_pane_name_target` inserts a Separator before
    // each non-empty section).
    const menu: ContextMenuItem[] = [];
    for (const section of sections) {
        if (section.length === 0) continue;
        if (menu.length > 0) menu.push({ type: "separator" });
        menu.push(...section);
    }
    return menu;
}

// VtabMenuItem-shaped builder used by the custom React context menu
// (vtab-context-menu.tsx).  Mirrors `buildTabContextMenu` 1:1 — same
// sections, same gating, same labels — but emits a `color-row`
// entry instead of stacked checkbox items so we can render warp's
// inline dot picker faithfully.
export function buildVtabMenuItems(params: TabContextMenuParams): VtabMenuItem[] {
    const {
        id,
        renameRef,
        env,
        tabTitle,
        cwd,
        gitBranch,
        hasCustomName,
        isPanesMode,
        tabIndex,
        totalTabs,
        isVerticalTabs,
        onCloseTab,
        onCloseOtherTabs,
        onCloseTabsBelow,
        onMoveUp,
        onMoveDown,
        onResetTabName,
    } = params;

    const sections: VtabMenuItem[][] = [];

    // Section 1 — Copy metadata.
    const copySection: VtabMenuItem[] = [];
    const pushCopy = (label: string, value: string | undefined) => {
        if (!value || !value.trim()) return;
        copySection.push({
            kind: "text",
            label,
            click: () => fireAndForget(() => navigator.clipboard.writeText(value)),
        });
    };
    pushCopy("Copy branch", gitBranch);
    pushCopy(isPanesMode ? "Copy pane title" : "Copy tab title", tabTitle);
    pushCopy("Copy working directory", cwd);
    if (copySection.length > 0) sections.push(copySection);

    // Section 2 — Modify tab.
    const modifySection: VtabMenuItem[] = [];
    modifySection.push({
        kind: "text",
        label: "Rename tab",
        click: () => renameRef?.current?.(),
    });
    if (hasCustomName && onResetTabName) {
        modifySection.push({ kind: "text", label: "Reset tab name", click: onResetTabName });
    }
    if (tabIndex != null && totalTabs != null) {
        const notLast = tabIndex < totalTabs - 1;
        const notFirst = tabIndex > 0;
        if (notLast && onMoveDown) {
            modifySection.push({
                kind: "text",
                label: isVerticalTabs ? "Move Tab Down" : "Move Tab Right",
                click: onMoveDown,
            });
        }
        if (notFirst && onMoveUp) {
            modifySection.push({
                kind: "text",
                label: isVerticalTabs ? "Move Tab Up" : "Move Tab Left",
                click: onMoveUp,
            });
        }
    }
    sections.push(modifySection);

    // Section 3 — Close.
    const closeSection: VtabMenuItem[] = [];
    closeSection.push({ kind: "text", label: "Close tab", click: onCloseTab });
    if (totalTabs != null && totalTabs > 1 && onCloseOtherTabs) {
        closeSection.push({ kind: "text", label: "Close other tabs", click: onCloseOtherTabs });
    }
    if (tabIndex != null && totalTabs != null) {
        const notLast = tabIndex < totalTabs - 1;
        if (notLast && onCloseTabsBelow) {
            closeSection.push({
                kind: "text",
                label: isVerticalTabs ? "Close Tabs Below" : "Close Tabs to the Right",
                click: onCloseTabsBelow,
            });
        }
    }
    sections.push(closeSection);

    // Section 4 — Color picker.  Single inline row (warp's custom-
    // label MenuItem rendering 7 dots).
    const tabORef = makeORef("tab", id);
    const currentFlagColor =
        (globalStore.get(getOrefMetaKeyAtom(tabORef, "tab:flagcolor")) as string | undefined) ?? null;
    sections.push([
        {
            kind: "color-row",
            current: currentFlagColor,
            onSelect: (color) => {
                fireAndForget(() =>
                    env.rpc.SetMetaCommand(TabRpcClient, {
                        oref: tabORef,
                        meta: { "tab:flagcolor": color },
                    })
                );
            },
        },
    ]);

    // Stitch with separators (skip empty sections).
    const out: VtabMenuItem[] = [];
    for (const section of sections) {
        if (section.length === 0) continue;
        if (out.length > 0) out.push({ kind: "separator" });
        out.push(...section);
    }
    return out;
}
