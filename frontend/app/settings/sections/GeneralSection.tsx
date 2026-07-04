// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// General section — a curated subset of the most-used app settings. Each
// SettingRow is bound to a `*:settingkey` via env.getSettingsKeyAtom and
// persists via RpcApi.SetConfigCommand on toggle.
//
// Selection mirrors the terax GeneralSection.tsx header card grid style:
// each row is rounded-lg border bg-card/60 with title + description on
// the left and a control on the right.

import { useWaveEnv } from "@/app/waveenv/waveenv";
import { WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useAtomValue } from "jotai";
import { fireAndForget } from "@/util/util";
import { SectionHeader } from "./SectionHeader";
import { SettingRow } from "./SettingRow";
import { Toggle } from "./Toggle";

export type GeneralSectionEnv = WaveEnvSubset<{
    rpc: { SetConfigCommand: WaveEnv["rpc"]["SetConfigCommand"] };
    getSettingsKeyAtom: WaveEnv["getSettingsKeyAtom"];
}>;

export function GeneralSection() {
    const env = useWaveEnv<GeneralSectionEnv>();

    const windowShowMenuBar = useAtomValue(env.getSettingsKeyAtom("window:showmenubar"));
    const tabConfirmClose = useAtomValue(env.getSettingsKeyAtom("tab:confirmclose")) ?? false;
    const hideAiButton = useAtomValue(env.getSettingsKeyAtom("app:hideaibutton"));
    const copyOnSelect = useAtomValue(env.getSettingsKeyAtom("term:copyonselect"));
    const cursorBlink = useAtomValue(env.getSettingsKeyAtom("term:cursorblink"));
    const reducedMotion = useAtomValue(env.getSettingsKeyAtom("window:reducedmotion"));
    const bellSound = useAtomValue(env.getSettingsKeyAtom("term:bellsound"));
    const previewShowHidden = useAtomValue(env.getSettingsKeyAtom("preview:showhiddenfiles"));

    const set = (key: string, value: any) => {
        fireAndForget(() => RpcApi.SetConfigCommand(TabRpcClient, { [key]: value }));
    };

    return (
        <div className="flex flex-col gap-6">
            <SectionHeader
                title="General"
                description="Behavior, terminal, and editor. Changes save automatically."
            />

            <div className="flex flex-col gap-2">
                <h2 className="text-[12px] font-semibold text-white/80 tracking-wide">App</h2>
                <SettingRow
                    title="Show menu bar"
                    description="Display the macOS / Linux menu bar above the terminal."
                >
                    <Toggle
                        on={!!windowShowMenuBar}
                        onChange={(v) => set("window:showmenubar", v)}
                        ariaLabel="Show menu bar"
                    />
                </SettingRow>
                <SettingRow
                    title="Confirm before closing tabs"
                    description="Show a prompt when closing a tab with unsaved content."
                >
                    <Toggle
                        on={!!tabConfirmClose}
                        onChange={(v) => set("tab:confirmclose", v)}
                        ariaLabel="Confirm before closing tabs"
                    />
                </SettingRow>
                <SettingRow
                    title="Hide AI button"
                    description="Hide the Wave AI button in the topbar."
                >
                    <Toggle
                        on={!!hideAiButton}
                        onChange={(v) => set("app:hideaibutton", v)}
                        ariaLabel="Hide AI button"
                    />
                </SettingRow>
            </div>

            <div className="flex flex-col gap-2">
                <h2 className="text-[12px] font-semibold text-white/80 tracking-wide">Terminal</h2>
                <SettingRow
                    title="Copy on select"
                    description="Automatically copy selected text to the clipboard."
                >
                    <Toggle
                        on={!!copyOnSelect}
                        onChange={(v) => set("term:copyonselect", v)}
                        ariaLabel="Copy on select"
                    />
                </SettingRow>
                <SettingRow
                    title="Blinking cursor"
                    description="Animate the terminal cursor when idle."
                >
                    <Toggle
                        on={!!cursorBlink}
                        onChange={(v) => set("term:cursorblink", v)}
                        ariaLabel="Cursor blink"
                    />
                </SettingRow>
                <SettingRow title="Bell sound" description="Audible bell when the terminal outputs BEL.">
                    <Toggle
                        on={!!bellSound}
                        onChange={(v) => set("term:bellsound", v)}
                        ariaLabel="Bell sound"
                    />
                </SettingRow>
            </div>

            <div className="flex flex-col gap-2">
                <h2 className="text-[12px] font-semibold text-white/80 tracking-wide">File explorer</h2>
                <SettingRow
                    title="Show hidden files"
                    description="Include dotfiles (.env, .gitignore, …) in the file explorer."
                >
                    <Toggle
                        on={!!previewShowHidden}
                        onChange={(v) => set("preview:showhiddenfiles", v)}
                        ariaLabel="Show hidden files"
                    />
                </SettingRow>
            </div>

            <div className="flex flex-col gap-2">
                <h2 className="text-[12px] font-semibold text-white/80 tracking-wide">Accessibility</h2>
                <SettingRow
                    title="Reduce motion"
                    description="Disable non-essential animations and transitions."
                >
                    <Toggle
                        on={!!reducedMotion}
                        onChange={(v) => set("window:reducedmotion", v)}
                        ariaLabel="Reduce motion"
                    />
                </SettingRow>
            </div>
        </div>
    );
}