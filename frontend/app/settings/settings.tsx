// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Settings modal — terax-ai SettingsApp.tsx treatment, adapted to a crest
// modal instead of a separate Tauri window.
//
//   ┌───────────────────────────────────────────────────────┐
//   │        [General] [Themes] [Shortcuts] [Models] [Agents] [About] │
//   ├───────────────────────────────────────────────────────┤
//   │                                                       │
//   │   Section header                                      │
//   │   Description text                                    │
//   │                                                       │
//   │   ┌─ SettingRow ──────────────────────────────────┐   │
//   │   │ Title              [Control]                 │   │
//   │   │ Description                                  │   │
//   │   └──────────────────────────────────────────────┘   │
//   │                                                       │
//   └───────────────────────────────────────────────────────┘
//
// Geometry follows terax SettingsApp.tsx:
//   - header h-11 (44px), bg-card/60, border-b, TabsList h-7 centered
//   - main scrollable, px-8 pt-6 pb-7, content max-w-160 (640px) centered
//   - Each TabsTrigger h-6 (24px) with icon (12px) + label (11.5px)
//
// Crest differences: tabs trigger popovers/modal close on click outside;
// SettingsModal lives in the regular modal layer (modalsModel) so it stacks
// correctly with other modals.

import { Icon } from "@/app/icon/Icon";
import { modalsModel } from "@/app/store/modalmodel";
import clsx from "clsx";
import { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom";
import { AboutSection } from "./sections/AboutSection";
import { AgentsSection } from "./sections/AgentsSection";
import { GeneralSection } from "./sections/GeneralSection";
import { ModelsSection } from "./sections/ModelsSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { ThemesSection } from "./sections/ThemesSection";
import "./settings.scss";

export type SettingsTab = "general" | "themes" | "shortcuts" | "models" | "agents" | "about";

type TabDef = {
    id: SettingsTab;
    label: string;
    icon: string; // Hugeicons name
};

const TABS: TabDef[] = [
    { id: "general", label: "General", icon: "settings-01" },
    { id: "themes", label: "Themes", icon: "palette" },
    { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
    { id: "models", label: "Models", icon: "cpu" },
    { id: "agents", label: "Agents", icon: "brain-01" },
    { id: "about", label: "About", icon: "information-circle" },
];

interface SettingsModalProps {
    initialTab?: SettingsTab;
}

const SettingsModal = ({ initialTab = "general" }: SettingsModalProps) => {
    const [active, setActive] = useState<SettingsTab>(initialTab);

    const handleClose = useCallback(() => {
        modalsModel.popModal();
    }, []);

    // ESC closes the modal.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") handleClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [handleClose]);

    // Lock body scroll while open.
    useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = prev;
        };
    }, []);

    const onBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) handleClose();
    };

    const ActiveSection = TABS.find((t) => t.id === active)?.id;

    return ReactDOM.createPortal(
        <div className="settings-modal-wrapper" onClick={onBackdropClick}>
            <div className="settings-modal" role="dialog" aria-label="Settings">
                <header className="settings-header">
                    <button
                        type="button"
                        className="settings-close"
                        onClick={handleClose}
                        title="Close (ESC)"
                        aria-label="Close"
                    >
                        <Icon name="cancel-01" size={12} />
                    </button>
                    <div className="settings-tabs" role="tablist">
                        {TABS.map((t) => (
                            <button
                                key={t.id}
                                role="tab"
                                aria-selected={active === t.id}
                                type="button"
                                className={clsx("settings-tab", { active: active === t.id })}
                                onClick={() => setActive(t.id)}
                            >
                                <Icon name={t.icon} size={12} />
                                <span>{t.label}</span>
                            </button>
                        ))}
                    </div>
                </header>
                <main className="settings-main">
                    <div className="settings-content">
                        {ActiveSection === "general" && <GeneralSection />}
                        {ActiveSection === "themes" && <ThemesSection />}
                        {ActiveSection === "shortcuts" && <ShortcutsSection />}
                        {ActiveSection === "models" && <ModelsSection />}
                        {ActiveSection === "agents" && <AgentsSection />}
                        {ActiveSection === "about" && <AboutSection />}
                    </div>
                </main>
            </div>
        </div>,
        document.getElementById("main")
    );
};

SettingsModal.displayName = "SettingsModal";

export { SettingsModal, TABS };
export type { TabDef };
