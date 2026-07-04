// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ChatModelPicker — defaults row trigger + popover content for picking
// the default model.  Mirrors terax-ai DefaultModelPicker in both
// layout and behavior:
//
//   - Trigger: provider icon + model label + provider hint + arrow-down
//   - Content: vertical list grouped by provider, each group prefixed
//     with a small uppercase label.  Only providers the user has
//     configured (have a keychain secret) are shown — there's no
//     point offering a model you can't authenticate to.
//
// On select: writeAIUserConfig with the new { default: { provider, model } }.
//
// Notes:
//   - The default model lives in UserConfig.default, not in a per-tab
//     preference.  Writes are full-config; we read the current
//     aiUserConfigAtom and merge the new default before calling
//     writeAIUserConfig.
//   - "Reasoning" level is not exposed here — picker only chooses
//     the model triple (provider, model).  Reasoning is set from the
//     model picker in the chat input (see frontend/app/view/cmdblock/
//     model-picker-popover.tsx).

import { Popover, PopoverButton, PopoverContent } from "@/element/popover";
import { Icon } from "@/app/icon/Icon";
import { CATALOG, findModel, type ModelEntry, type ProviderEntry } from "@/app/store/ai-catalog";
import { writeAIUserConfig } from "@/app/store/ai-user-config";
import type { UserConfig } from "@/app/store/ai-types";
import { useAtomValue } from "jotai";
import { useCallback } from "react";
import { aiUserConfigAtom } from "@/app/store/ai-user-config";
import { ProviderIcon } from "./ProviderIcon";

type Props = {
    defaultModel: { provider: string; model: string };
    configuredProviderIds: Set<string>;
};

export function ChatModelPicker({ defaultModel, configuredProviderIds }: Props) {
    const userConfigState = useAtomValue(aiUserConfigAtom);
    const userConfig = userConfigState.config;

    const handleSelect = useCallback(
        async (providerId: string, modelId: string) => {
            if (!userConfig) return;
            const next: UserConfig = { ...userConfig, default: { provider: providerId, model: modelId } };
            await writeAIUserConfig(next);
        },
        [userConfig]
    );

    const currentProvider = CATALOG.find((p) => p.id === defaultModel.provider);
    const currentModel = currentProvider ? findModel(defaultModel.provider, defaultModel.model) : null;
    const hasAny = configuredProviderIds.size > 0;

    return (
        <Popover placement="bottom-start" offset={6}>
            <PopoverButton
                className={`h-8 flex-1 justify-between gap-2 border border-white/10 bg-white/[0.04] px-2.5 text-[11.5px] text-white outline-none hover:bg-white/[0.08] ${
                    hasAny ? "" : "cursor-not-allowed opacity-50"
                }`}
                disabled={!hasAny}
            >
                <span className="flex items-center gap-2 truncate">
                    {currentProvider ? (
                        <ProviderIcon provider={currentProvider.id as any} size={13} />
                    ) : null}
                    <span className="truncate">{currentModel?.displayName ?? defaultModel.model}</span>
                    <span className="text-white/45">· {currentProvider?.displayName ?? defaultModel.provider}</span>
                </span>
                <Icon name="arrow-down-01" size={11} strokeWidth={2} className="opacity-70" />
            </PopoverButton>
            <PopoverContent className="min-w-70 max-h-72 overflow-y-auto p-1">
                {CATALOG.filter((p) => configuredProviderIds.has(p.id)).map((p) => {
                    const models = p.models;
                    if (models.length === 0) return null;
                    return (
                        <ProviderGroup
                            key={p.id}
                            provider={p}
                            currentModelId={defaultModel.model}
                            onSelect={(modelId) => handleSelect(p.id, modelId)}
                        />
                    );
                })}
            </PopoverContent>
        </Popover>
    );
}

function ProviderGroup({
    provider,
    currentModelId,
    onSelect,
}: {
    provider: ProviderEntry;
    currentModelId: string;
    onSelect: (modelId: string) => void;
}) {
    return (
        <div className="px-1 pt-1.5 first:pt-1">
            <div className="mb-0.5 flex items-center gap-1.5 px-2 text-[10px] font-medium tracking-wide text-white/45 uppercase">
                <ProviderIcon provider={provider.id as any} size={11} />
                <span>{provider.displayName}</span>
            </div>
            {provider.models.map((m) => (
                <ModelRow
                    key={m.id}
                    model={m}
                    selected={m.id === currentModelId}
                    onClick={() => onSelect(m.id)}
                />
            ))}
        </div>
    );
}

function ModelRow({ model, selected, onClick }: { model: ModelEntry; selected: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-white/[0.06] ${
                selected ? "bg-white/[0.08]" : ""
            }`}
        >
            <span className="flex flex-1 flex-col">
                <span>{model.displayName}</span>
                {model.description ? (
                    <span className="text-[10px] text-white/45">{model.description}</span>
                ) : null}
            </span>
        </button>
    );
}
