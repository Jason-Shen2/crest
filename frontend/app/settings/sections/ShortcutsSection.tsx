// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shortcuts section — curated list of the most-used keybindings, mirroring
// terax ShortcutsSection.tsx layout (group title + rows of label + keys).
//
// Source of truth for the accelerators here is emain/emain-menu.ts; we
// mirror a user-facing subset rather than the full electron menu list.
//
// Editing is intentionally not supported in this iteration — terax supports
// per-shortcut rebinding via a recorder modal which would need a follow-up
// to bring into crest. For now the section is read-only.

import { isMacOS } from "@/util/platformutil";
import { SectionHeader } from "./SectionHeader";

type KeyCombo = string[];

type Shortcut = {
    label: string;
    keys: KeyCombo;
};

type Group = {
    title: string;
    items: Shortcut[];
};

const mac = isMacOS();

function fmt(acc: string): KeyCombo {
    // Convert Electron accelerator string ("CommandOrControl+Shift+K") into a
    // display array. mac shows Command / Option, other platforms show Ctrl.
    const parts = acc.split("+");
    return parts.map((p) => {
        switch (p) {
            case "CommandOrControl":
            case "CmdOrCtrl":
                return mac ? "⌘" : "Ctrl";
            case "Command":
            case "Cmd":
                return mac ? "⌘" : "Ctrl";
            case "Control":
            case "Ctrl":
                return mac ? "⌃" : "Ctrl";
            case "Shift":
                return mac ? "⇧" : "Shift";
            case "Alt":
            case "Option":
                return mac ? "⌥" : "Alt";
            case "Meta":
                return mac ? "⌘" : "Win";
            default:
                return p;
        }
    });
}

const GROUPS: Group[] = [
    {
        title: "Workspace",
        items: [
            { label: "New window", keys: fmt("CommandOrControl+Shift+N") },
            { label: "Switch workspace", keys: mac ? ["⌘", "1-9"] : ["Ctrl", "Alt", "1-9"] },
        ],
    },
    {
        title: "Tabs",
        items: [
            { label: "New tab", keys: mac ? ["⌘", "T"] : ["Alt", "T"] },
            { label: "Close tab", keys: mac ? ["⌘", "W"] : ["Ctrl", "W"] },
            { label: "Reopen closed tab", keys: mac ? ["⇧", "⌘", "T"] : ["Ctrl", "Shift", "T"] },
        ],
    },
    {
        title: "Editor",
        items: [
            { label: "Undo", keys: mac ? ["⌘", "Z"] : ["Ctrl", "Z"] },
            { label: "Redo", keys: mac ? ["⇧", "⌘", "Z"] : ["Ctrl", "Y"] },
            { label: "Cut", keys: mac ? ["⌘", "X"] : ["Ctrl", "X"] },
            { label: "Copy", keys: mac ? ["⌘", "C"] : ["Ctrl", "C"] },
            { label: "Paste", keys: mac ? ["⌘", "V"] : ["Ctrl", "V"] },
            { label: "Select all", keys: mac ? ["⌘", "A"] : ["Ctrl", "A"] },
        ],
    },
    {
        title: "View",
        items: [
            { label: "Toggle fullscreen", keys: mac ? ["⌃", "⌘", "F"] : ["F11"] },
            { label: "Reset zoom", keys: ["Ctrl", "0"] },
            { label: "Zoom in", keys: ["Ctrl", "="] },
            { label: "Zoom out", keys: ["Ctrl", "-"] },
            { label: "Reload", keys: mac ? ["⇧", "⌘", "R"] : ["Ctrl", "Shift", "R"] },
        ],
    },
];

export function ShortcutsSection() {
    return (
        <div className="flex flex-col gap-6">
            <SectionHeader title="Shortcuts" description="View the most-used keyboard shortcuts." />

            <div className="flex flex-col gap-4">
                {GROUPS.map((g) => (
                    <div key={g.title} className="shortcut-group">
                        <div className="text-[12px] font-semibold text-white/80 tracking-wide">{g.title}</div>
                        {g.items.map((item, i) => (
                            <div key={i} className="shortcut-row">
                                <span className="shortcut-label">{item.label}</span>
                                <span className="shortcut-keys">
                                    {item.keys.map((k, j) => (
                                        <span key={j} className="inline-flex items-center gap-1">
                                            {j > 0 ? <span className="shortcut-sep">+</span> : null}
                                            <kbd className="shortcut-key">{k}</kbd>
                                        </span>
                                    ))}
                                </span>
                            </div>
                        ))}
                    </div>
                ))}
            </div>

            <div className="text-[11px] text-white/45">
                Editing shortcuts is not yet supported in the modal — see the
                application menu for the full accelerator list.
            </div>
        </div>
    );
}