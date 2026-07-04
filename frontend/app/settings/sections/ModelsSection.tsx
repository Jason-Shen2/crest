// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Models section — 1:1 transcription of terax-ai ModelsSection.tsx,
// adapted to crest's ProviderEntry / ai.json / keychain IPC.
//
// Layout (top to bottom):
//   1. SectionHeader
//   2. Defaults block — chat model picker (skips Autocomplete row —
//      not yet a crest concept).  Hidden when no provider is
//      configured AND nothing is being added.
//   3. Providers block — "Providers" label + Add provider menu on the
//      right, then a list of provider cards (catalog + custom
//      endpoints).  Empty state when nothing is visible.
//
// Crest differences from terax:
//   - No Voice block (no STT in crest).
//   - No Autocomplete row (not a crest concept yet).
//   - No local providers (LM Studio, MLX, Ollama) — catalog is
//     cloud-only.  Custom OpenAI-compatible endpoints fill the
//     "self-hosted / third-party" niche instead.
//   - Test-connection for custom endpoints uses listProviderModels
//     (existing emain IPC) rather than a terax-specific `lm_ping`.
//   - "Configured" is determined by `cfg.providers[id].tokensecretname`
//     being set, NOT by reading the keychain value.  The renderer
//     never sees the actual key (it lives in the OS keychain, only
//     the emain side reads it).
//   - On first-save, if no default model is set, we auto-pick the
//     new provider's first model.  This is required by the emain
//     config validator (`default.provider` and `default.model`
//     must both be present).

import { Icon } from "@/app/icon/Icon";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { CATALOG, type ProviderEntry } from "@/app/store/ai-catalog";
import { aiUserConfigAtom, writeAIUserConfig } from "@/app/store/ai-user-config";
import type { UserConfig, UserCustomEndpoint } from "@/app/store/ai-types";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { AddProviderMenu } from "../components/AddProviderMenu";
import { ChatModelPicker } from "../components/ChatModelPicker";
import { CustomEndpointCard } from "../components/CustomEndpointCard";
import { FieldRow } from "../components/FieldRow";
import { Label } from "../components/Label";
import { ProviderIcon, type ProviderId } from "../components/ProviderIcon";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { SectionHeader } from "./SectionHeader";

// Provider ids that are still "being added" by the user — they show
// up in the list with initiallyEditing=true so the user can paste a
// key, but aren't part of the persisted config yet.
type AddingSet = Set<ProviderId>;

// Custom endpoint key prefix. The remainder is the endpoint UUID;
// full keychain secret names look like OPENAI_COMPAT_<8-char-uuid>_API_KEY.
const CUSTOM_ENDPOINT_KEY_PREFIX = "OPENAI_COMPAT_";
const CUSTOM_ENDPOINT_KEY_SUFFIX = "_API_KEY";

export function ModelsSection() {
    const userConfigState = useAtomValue(aiUserConfigAtom);
    const [adding, setAdding] = useState<AddingSet>(new Set());

    // ai.json might be `missing` or `malformed` (first run, or broken
    // file).  Render a banner with a recovery prompt in that case —
    // we can't write a partial config because the emain validator
    // requires `default.provider` and `default.model`.
    if (userConfigState.status !== "ok" || !userConfigState.config) {
        return <ModelsUnavailable status={userConfigState.status} error={userConfigState.error} />;
    }

    const userConfig = userConfigState.config;

    // ---- provider visibility ----
    // Configured = has an entry in the providers map.  "Configured"
    // is the source of truth the renderer has — the actual keychain
    // entry is the emain's responsibility.
    const configuredIds = useMemo<Set<ProviderId>>(() => {
        const ids = new Set<ProviderId>();
        for (const p of CATALOG) {
            if (userConfig.providers[p.id]?.tokensecretname) {
                ids.add(p.id as ProviderId);
            }
        }
        return ids;
    }, [userConfig.providers]);

    // Visible = configured ∪ adding.  Only catalog providers in this set;
    // custom endpoints are rendered separately below.
    const visibleIds = useMemo<Set<ProviderId>>(() => {
        const ids = new Set<ProviderId>(configuredIds);
        for (const id of adding) ids.add(id);
        return ids;
    }, [configuredIds, adding]);

    const addableProviderIds = useMemo<ProviderId[]>(
        () =>
            CATALOG.filter((p) => !visibleIds.has(p.id as ProviderId)).map((p) => p.id as ProviderId),
        [visibleIds]
    );

    // Custom endpoints already persisted. Insertion order preserved by the
    // Record's natural iteration. We synthesize a stable list once per
    // config change so child components get stable references.
    const customEndpointEntries = useMemo(() => {
        const eps = userConfig.custom_endpoints ?? {};
        return Object.entries(eps).map(([id, endpoint]) => ({ id, endpoint }));
    }, [userConfig.custom_endpoints]);

    // Has anything at all — drives empty-state visibility.
    const hasAnything = visibleIds.size > 0 || customEndpointEntries.length > 0;

    // ---- custom endpoint helpers ----
    // Add a fresh empty endpoint entry. UUID-derived key becomes the
    // provider id used everywhere (resolver, picker, /models IPC);
    // tokensecretname is synthesized to give the keychain a stable
    // namespace.
    const handleAddCompat = useCallback(async () => {
        if (!userConfig) return;
        const id = crypto.randomUUID().slice(0, 8);
        const tokensecretname = `${CUSTOM_ENDPOINT_KEY_PREFIX}${id}${CUSTOM_ENDPOINT_KEY_SUFFIX}`;
        const ep: UserCustomEndpoint = {
            displayname: "",
            endpoint: "",
            apitype: "openai-chat",
            tokensecretname,
            icon: "code",
            models: [],
        };
        const nextCustom = { ...(userConfig.custom_endpoints ?? {}), [id]: ep };
        await writeAIUserConfig({ ...userConfig, custom_endpoints: nextCustom });
    }, [userConfig]);

    const handleUpdateCustom = useCallback(
        async (id: string, patch: Partial<UserCustomEndpoint>) => {
            if (!userConfig) return;
            const cur = userConfig.custom_endpoints?.[id];
            if (!cur) return;
            const next = { ...cur, ...patch };
            await writeAIUserConfig({
                ...userConfig,
                custom_endpoints: { ...userConfig.custom_endpoints, [id]: next },
            });
        },
        [userConfig]
    );

    const handleRemoveCustom = useCallback(
        async (id: string) => {
            if (!userConfig) return;
            const cur = userConfig.custom_endpoints?.[id];
            if (!cur) return;
            // Drop the keychain entry, the providers[] entry, and the
            // custom_endpoints entry — in that order so a partial failure
            // can't strand a secret the user thinks they removed.
            await RpcApi.SetSecretsCommand(TabRpcClient, { [cur.tokensecretname]: null });
            const { [id]: _, ...restEndpoints } = userConfig.custom_endpoints ?? {};
            const { [id]: __, ...restProviders } = userConfig.providers ?? {};
            const nextConfig: UserConfig = {
                ...userConfig,
                custom_endpoints: restEndpoints,
                providers: restProviders,
            };
            // If the removed endpoint was the default selection, fall back
            // to the first remaining catalog provider's first model so the
            // emain validator (default.provider + default.model required)
            // doesn't choke on the next save.
            if (userConfig.default?.provider === id) {
                const firstCatalog = CATALOG.find((p) =>
                    nextConfig.providers?.[p.id]?.tokensecretname
                );
                const fallbackModel = firstCatalog?.models[0]?.id ?? "";
                nextConfig.default = {
                    provider: firstCatalog?.id ?? "",
                    model: fallbackModel,
                };
            }
            await writeAIUserConfig(nextConfig);
        },
        [userConfig]
    );

    const handleSaveCustomKey = useCallback(
        async (id: string, value: string) => {
            if (!userConfig) return;
            const cur = userConfig.custom_endpoints?.[id];
            if (!cur) return;
            await RpcApi.SetSecretsCommand(TabRpcClient, { [cur.tokensecretname]: value });
            const nextProviders = {
                ...userConfig.providers,
                [id]: { tokensecretname: cur.tokensecretname },
            };
            await writeAIUserConfig({ ...userConfig, providers: nextProviders });
        },
        [userConfig]
    );

    const handleClearCustomKey = useCallback(
        async (id: string) => {
            if (!userConfig) return;
            const cur = userConfig.custom_endpoints?.[id];
            if (!cur) return;
            await RpcApi.SetSecretsCommand(TabRpcClient, { [cur.tokensecretname]: null });
            const { [id]: _, ...restProviders } = userConfig.providers ?? {};
            await writeAIUserConfig({ ...userConfig, providers: restProviders });
        },
        [userConfig]
    );

    // ---- save / clear handlers ----
    // Save flow:
    //   1. Write the literal value to OS keychain under the catalog's
    //      canonical secret name.
    //   2. Persist the secret-name reference into ai.json.
    //   3. If no default model is set yet, auto-pick the new
    //      provider's first model.  Validator requires a default.
    //   4. Drop the provider from the `adding` set (now configured).
    const handleSave = useCallback(
        async (provider: ProviderEntry, value: string) => {
            const trimmed = value.trim();
            if (!trimmed) throw new Error("key is empty");
            await RpcApi.SetSecretsCommand(TabRpcClient, { [provider.tokenSecretName]: trimmed });
            const nextProviders = { ...userConfig.providers, [provider.id]: { tokensecretname: provider.tokenSecretName } };
            const needsDefault = !userConfig.default?.provider || !userConfig.default?.model;
            const next: UserConfig = {
                ...userConfig,
                providers: nextProviders,
                default: needsDefault
                    ? { provider: provider.id, model: provider.models[0]?.id ?? "" }
                    : userConfig.default,
            };
            await writeAIUserConfig(next);
            setAdding((prev) => {
                if (!prev.has(provider.id as ProviderId)) return prev;
                const next = new Set(prev);
                next.delete(provider.id as ProviderId);
                return next;
            });
        },
        [userConfig]
    );

    // Clear flow: drop the keychain entry (null = delete) and remove the
    // providers[id] entry.  If the cleared provider was the default, fall
    // back to the first remaining configured provider's first model.
    const handleClear = useCallback(
        async (provider: ProviderEntry) => {
            await RpcApi.SetSecretsCommand(TabRpcClient, { [provider.tokenSecretName]: null });
            const { [provider.id]: _, ...restProviders } = userConfig.providers;
            const next: UserConfig = { ...userConfig, providers: restProviders };
            if (userConfig.default?.provider === provider.id) {
                const remainingIds = Object.keys(restProviders);
                const nextDefaultProvider = remainingIds[0] ?? CATALOG[0]?.id ?? "";
                const nextDefaultProviderEntry = CATALOG.find((p) => p.id === nextDefaultProvider);
                next.default = {
                    provider: nextDefaultProvider,
                    model: nextDefaultProviderEntry?.models[0]?.id ?? "",
                };
            }
            await writeAIUserConfig(next);
        },
        [userConfig]
    );

    const handleAdd = useCallback((id: ProviderId) => {
        setAdding((prev) => new Set(prev).add(id));
    }, []);

    const handleRemoveAdding = useCallback((id: ProviderId) => {
        setAdding((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    }, []);

    return (
        <div className="flex flex-col gap-7">
            <SectionHeader
                title="Models"
                description="Connect the providers you use. Keys live in your OS keychain and are used only by Crest."
            />

            {configuredIds.size > 0 || customEndpointEntries.length > 0 ? (
                <DefaultsBlock
                    defaultModel={{
                        provider: userConfig.default?.provider ?? "",
                        model: userConfig.default?.model ?? "",
                    }}
                    configuredIds={configuredIds}
                />
            ) : null}

            <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                    <Label>Providers</Label>
                    <AddProviderMenu
                        addableProviderIds={addableProviderIds}
                        onAdd={handleAdd}
                        onAddCompat={() => fireAndForget(handleAddCompat)}
                    />
                </div>

                {!hasAnything ? (
                    <ProvidersEmptyState />
                ) : (
                    <div className="flex flex-col gap-2">
                        {CATALOG.filter((p) => visibleIds.has(p.id as ProviderId)).map((p) => {
                            const isConfigured = configuredIds.has(p.id as ProviderId);
                            const isAdding = adding.has(p.id as ProviderId);
                            return (
                                <ProviderKeyCard
                                    key={p.id}
                                    provider={p.id as ProviderId}
                                    tokenSecretName={isConfigured ? userConfig.providers[p.id].tokensecretname ?? "" : p.tokenSecretName}
                                    hasKey={isConfigured}
                                    initiallyEditing={isAdding && !isConfigured}
                                    onSave={(v) => handleSave(p, v)}
                                    onClear={() => handleClear(p)}
                                    onRemove={
                                        isAdding && !isConfigured
                                            ? () => handleRemoveAdding(p.id as ProviderId)
                                            : isConfigured
                                              ? () => {
                                                    fireAndForget(() => handleClear(p));
                                                }
                                              : undefined
                                    }
                                />
                            );
                        })}
                        {customEndpointEntries.map(({ id, endpoint }) => {
                            const creds = userConfig.providers[id];
                            const hasKey = !!creds?.tokensecretname;
                            // "Newly added" means the user just clicked + Add
                            // provider → OpenAI Compatible; in that case the
                            // entry's endpoint URL is empty and we want the
                            // form open immediately so they can paste it.
                            const isNewlyAdded =
                                !hasKey && !endpoint.endpoint.trim();
                            return (
                                <CustomEndpointCard
                                    key={id}
                                    providerId={id}
                                    endpoint={endpoint}
                                    tokenSecretName={
                                        creds?.tokensecretname ?? endpoint.tokensecretname
                                    }
                                    hasKey={hasKey}
                                    initiallyEditing={isNewlyAdded}
                                    onUpdate={(patch) => handleUpdateCustom(id, patch)}
                                    onRemove={() => handleRemoveCustom(id)}
                                    onSaveKey={(v) => handleSaveCustomKey(id, v)}
                                    onClearKey={() => handleClearCustomKey(id)}
                                />
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Defaults block — chat model picker card.
// ---------------------------------------------------------------------------

function DefaultsBlock({
    defaultModel,
    configuredIds,
}: {
    defaultModel: { provider: string; model: string };
    configuredIds: Set<ProviderId>;
}) {
    return (
        <div className="flex flex-col gap-3">
            <Label>Defaults</Label>
            <div className="flex flex-col gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
                <FieldRow label="Chat model">
                    <ChatModelPicker
                        defaultModel={defaultModel}
                        configuredProviderIds={configuredIds}
                    />
                </FieldRow>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Empty state — no providers connected, no providers being added.
// ---------------------------------------------------------------------------

function ProvidersEmptyState() {
    return (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/40 px-4 py-8 text-center">
            <p className="text-[12px] text-muted-foreground">No providers connected yet.</p>
            <p className="mt-0.5 text-[10.5px] text-muted-foreground/70">
                Click &quot;Add provider&quot; to connect a cloud model source or a custom OpenAI-compatible endpoint.
            </p>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Unavailable state — ai.json missing / malformed / rpc_error.
// ---------------------------------------------------------------------------

function ModelsUnavailable({ status, error }: { status: string; error?: string }) {
    if (status === "loading") {
        return (
            <div className="flex flex-col gap-7">
                <SectionHeader
                    title="Models"
                    description="Connect the providers you use. Keys live in your OS keychain."
                />
                <div className="text-[12px] text-white/55">Loading…</div>
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-7">
            <SectionHeader
                title="Models"
                description="Connect the providers you use. Keys live in your OS keychain."
            />
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-200">
                <div className="font-medium">AI config unavailable</div>
                <div className="mt-1 text-[11px] text-rose-300/80">
                    {status === "missing"
                        ? "No ai.json found. Create one via the AI setup wizard, or restart Crest to bootstrap."
                        : `Couldn't read ai.json (${status}${error ? `: ${error}` : ""}). Fix the file or restart Crest.`}
                </div>
            </div>
        </div>
    );
}