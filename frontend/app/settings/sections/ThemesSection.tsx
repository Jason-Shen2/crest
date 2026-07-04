// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Themes section — visual mirrors terax ThemesSection.tsx header layout,
// body is a theme card grid populated from crest's built-in themes.
//
// Each card: small swatch (linear-gradient using the theme's 8 ANSI colors
// as a row) + display name. Click sets the theme via ThemeModel (which
// persists "term:theme" and applies it live).

import { atoms } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { ThemeModel } from "@/app/theme/theme-model";
import { getBuiltinThemes } from "@/app/theme/registry/themes";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import clsx from "clsx";
import { SectionHeader } from "./SectionHeader";

export function ThemesSection() {
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const themes = useMemo(() => getBuiltinThemes(fullConfig?.termthemes ?? {}), [fullConfig?.termthemes]);
    const activeKey = fullConfig?.settings?.["term:theme"];

    const entries = useMemo(
        () =>
            Object.entries(themes)
                .map(([key, theme]) => ({
                    key,
                    name: theme["display:name"] || key,
                    order: theme["display:order"] ?? Number.MAX_SAFE_INTEGER,
                    theme,
                }))
                .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name))),
        [themes]
    );

    return (
        <div className="flex flex-col gap-6">
            <SectionHeader
                title="Themes"
                description="Pick a terminal palette. Changes apply immediately and persist across reloads."
            />

            <div className="theme-grid">
                {entries.map(({ key, name, theme }) => {
                    const swatchBg = `linear-gradient(90deg, ${theme.black}, ${theme.red}, ${theme.green}, ${theme.yellow}, ${theme.blue}, ${theme.magenta}, ${theme.cyan}, ${theme.white})`;
                    return (
                        <button
                            key={key}
                            type="button"
                            className={clsx("theme-card", { active: key === activeKey })}
                            onClick={() => {
                                ThemeModel.getInstance().applyTheme(key, theme);
                                fireAndForget(() => RpcApi.SetConfigCommand(TabRpcClient, { "term:theme": key }));
                            }}
                            aria-pressed={key === activeKey}
                        >
                            <div className="theme-card-swatch" style={{ background: swatchBg }} />
                            <div className="theme-card-label">{name}</div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}