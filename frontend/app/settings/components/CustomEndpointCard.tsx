// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// CustomEndpointCard — user-defined OpenAI-compatible provider. Mirrors
// terax-ai's CustomEndpointCard layout 1:1 (collapsed header + expandable
// form with name / base URL / model id / context / API key), adapted to
// crest's data shape:
//
//   userConfig.custom_endpoints[providerId] : UserCustomEndpoint
//
// The entry has a single model synthesized from the user's Model ID +
// Context inputs (terax stores one model per endpoint; crest's catalog
// data shape permits N models but we keep the simpler UX here).
//
// Visual style — terax's shadcn defaults, ported verbatim:
//   - Card surface: `rounded-lg border border-border/60 bg-card/60`
//   - Field row label: `text-[12px] font-medium tracking-tight text-muted-foreground`
//   - Connected badge: `border-border/60 bg-muted/40` outlined pill
//   - Remove × button: `text-muted-foreground hover:text-destructive`
// Required shadcn-style tokens (`--color-card`, `--color-destructive`)
// are added to tailwindsetup.css; existing tokens (`--color-border`,
// `--color-muted-foreground`, `--color-foreground`) were already there.
//
// `bg-muted/40` is translated to `bg-white/[0.04]` because crest's
// --color-muted is a medium gray used for muted *text* (treeview rows,
// breadcrumb separators); a 40% opacity on it would render too bright
// for the surface use case terax targets.  --color-card is the surface.
//
// Save flow:
//   text fields     → blur-to-save via onUpdate patch
//   API key         → SetSecretsCommand + providers[id] entry + writeAIUserConfig
//   name            → blur-to-save patch + idempotent display name
//   × remove        → drop keychain + providers[id] + custom_endpoints[id]
//
// Configured ("Connected") iff providers[providerId]?.tokensecretname
// is set AND the endpoint + models[0].id are non-empty.

import clsx from "clsx";
import { memo, useCallback, useEffect, useState } from "react";

import { Icon } from "@/app/icon/Icon";
import { ProviderIcon } from "@/app/settings/components/ProviderIcon";
import { getApi } from "@/app/store/global";
import type { UserCustomEndpoint } from "@/app/store/ai-types";
import { fireAndForget } from "@/util/util";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CustomEndpointCardProps {
    providerId: string;
    endpoint: UserCustomEndpoint;
    // Keychain secret name the key is stored under. Empty when the user
    // hasn't yet saved a key.
    tokenSecretName: string;
    // True iff a key is currently saved under tokenSecretName.
    hasKey: boolean;
    // True when the user just clicked "+ Add provider → OpenAI
    // Compatible" — opens the form immediately so they can paste the
    // base URL without a second click.
    initiallyEditing?: boolean;
    onUpdate: (patch: Partial<UserCustomEndpoint>) => Promise<void>;
    onRemove: () => Promise<void>;
    onSaveKey: (value: string) => Promise<void>;
    onClearKey: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CustomEndpointCard = memo(function CustomEndpointCard({
    providerId,
    endpoint,
    tokenSecretName,
    hasKey,
    initiallyEditing,
    onUpdate,
    onRemove,
    onSaveKey,
    onClearKey,
}: CustomEndpointCardProps) {
    const [expanded, setExpanded] = useState(
        !endpoint.endpoint.trim() || !!initiallyEditing
    );
    const singleModel = endpoint.models[0];
    const modelId = singleModel?.id ?? "";
    const contextLimit = singleModel?.contextWindow ?? 0;

    const configured = hasKey && !!endpoint.endpoint.trim() && !!modelId.trim();
    const displayName = endpoint.displayname?.trim() || "OpenAI Compatible";

    return (
        <div className="flex flex-col rounded-lg border border-border/60 bg-card/60">
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-2 px-3 py-2 text-left"
            >
                <Icon
                    name="chevron-down"
                    size={12}
                    strokeWidth={2}
                    className={clsx(
                        "shrink-0 text-muted-foreground/60 transition-transform",
                        !expanded && "-rotate-90"
                    )}
                />
                <ProviderIcon provider="openai-compatible" size={15} />
                <span className="truncate text-[13px] font-medium text-foreground">
                    {displayName}
                </span>
                {modelId.trim() ? (
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {modelId}
                    </span>
                ) : null}
                {configured ? (
                    <span className="ml-1 inline-flex h-4 items-center gap-1 rounded-full border border-border/60 bg-white/[0.04] px-1.5 text-[11px] font-normal text-muted-foreground">
                        <Icon name="checkmark-circle-02" size={9} strokeWidth={2} />
                        Connected
                    </span>
                ) : null}
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        fireAndForget(onRemove);
                    }}
                    title="Remove endpoint"
                    className="ml-auto grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
                >
                    <Icon name="cancel-01" size={12} strokeWidth={1.75} />
                </button>
            </button>

            {expanded ? (
                <EndpointForm
                    endpoint={endpoint}
                    tokenSecretName={tokenSecretName}
                    hasKey={hasKey}
                    modelId={modelId}
                    contextLimit={contextLimit}
                    providerId={providerId}
                    onUpdate={onUpdate}
                    onSaveKey={onSaveKey}
                    onClearKey={onClearKey}
                />
            ) : null}
        </div>
    );
});

// ---------------------------------------------------------------------------
// Form body
// ---------------------------------------------------------------------------

function EndpointForm({
    endpoint,
    tokenSecretName,
    hasKey,
    modelId,
    contextLimit,
    providerId,
    onUpdate,
    onSaveKey,
    onClearKey,
}: {
    endpoint: UserCustomEndpoint;
    tokenSecretName: string;
    hasKey: boolean;
    modelId: string;
    contextLimit: number;
    providerId: string;
    onUpdate: (patch: Partial<UserCustomEndpoint>) => Promise<void>;
    onSaveKey: (value: string) => Promise<void>;
    onClearKey: () => Promise<void>;
}) {
    const [nameDraft, setNameDraft] = useState(endpoint.displayname ?? "");
    const [urlDraft, setUrlDraft] = useState(endpoint.endpoint);
    const [modelDraft, setModelDraft] = useState(modelId);
    const [contextDraft, setContextDraft] = useState(
        contextLimit > 0 ? String(contextLimit) : ""
    );
    const [keyDraft, setKeyDraft] = useState("");
    const [testStatus, setTestStatus] = useState<
        "idle" | "testing" | "ok" | "fail"
    >("idle");
    const [testError, setTestError] = useState<string | null>(null);
    const [keySaving, setKeySaving] = useState(false);
    const [keyError, setKeyError] = useState<string | null>(null);

    useEffect(() => setNameDraft(endpoint.displayname ?? ""), [endpoint.displayname]);
    useEffect(() => setUrlDraft(endpoint.endpoint), [endpoint.endpoint]);
    useEffect(() => setModelDraft(modelId), [modelId]);
    useEffect(
        () => setContextDraft(contextLimit > 0 ? String(contextLimit) : ""),
        [contextLimit]
    );

    const handleTest = useCallback(async () => {
        const url = urlDraft.trim();
        if (!url) return;
        setTestStatus("testing");
        setTestError(null);
        try {
            // listProviderModels hits the provider's /models endpoint via the
            // emain-side IPC handler (see emain/aiconfig/list-provider-models.ts).
            // A reachable server returns [] (or model rows); unreachable /
            // auth-failed surfaces an error. We pass tokensecretname when a
            // key is saved — the keychain lookup happens on the emain side.
            await getApi().ai.listProviderModels({
                apitype: endpoint.apitype,
                baseurl: url,
                tokensecretname: hasKey ? tokenSecretName : undefined,
            });
            setTestStatus("ok");
        } catch (e) {
            setTestStatus("fail");
            setTestError(e instanceof Error ? e.message : String(e));
        }
    }, [urlDraft, endpoint.apitype, hasKey, tokenSecretName]);

    const handleSaveKey = useCallback(async () => {
        const v = keyDraft.trim();
        if (!v) return;
        setKeySaving(true);
        setKeyError(null);
        try {
            await onSaveKey(v);
            setKeyDraft("");
        } catch (e) {
            setKeyError(e instanceof Error ? e.message : String(e));
        } finally {
            setKeySaving(false);
        }
    }, [keyDraft, onSaveKey]);

    return (
        <div className="flex flex-col gap-2.5 border-t border-border/40 px-3 py-2.5">
            <FieldRow label="Name">
                <input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={() => {
                        const v = nameDraft.trim();
                        if (v !== (endpoint.displayname ?? "")) {
                            fireAndForget(() => onUpdate({ displayname: v }));
                        }
                    }}
                    placeholder="My endpoint"
                    spellCheck={false}
                    className="h-8 flex-1 rounded-full border border-border/60 bg-transparent px-3 text-[12.5px] font-medium text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/40"
                />
            </FieldRow>

            <FieldRow label="Base URL">
                <div className="flex flex-1 gap-1.5">
                    <input
                        value={urlDraft}
                        onChange={(e) => setUrlDraft(e.target.value)}
                        onBlur={() => {
                            const v = urlDraft.trim();
                            if (v !== endpoint.endpoint) {
                                fireAndForget(() => onUpdate({ endpoint: v }));
                            }
                        }}
                        placeholder="https://api.example.com/v1"
                        spellCheck={false}
                        className="h-8 flex-1 rounded-full border border-border/60 bg-transparent px-3 font-mono text-[12.5px] font-medium text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/40"
                    />
                    <button
                        type="button"
                        onClick={() => fireAndForget(handleTest)}
                        disabled={!urlDraft.trim() || testStatus === "testing"}
                        className="h-8 cursor-pointer rounded-full border border-border/60 bg-transparent px-4 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Test
                    </button>
                </div>
            </FieldRow>

            <FieldRow label="Model ID">
                <input
                    value={modelDraft}
                    onChange={(e) => setModelDraft(e.target.value)}
                    onBlur={() => {
                        const v = modelDraft.trim();
                        if (v !== modelId) {
                            const nextModels = v
                                ? [
                                      {
                                          id: v,
                                          displayName: v,
                                          capabilities: [],
                                          contextWindow: contextLimit,
                                      },
                                  ]
                                : [];
                            fireAndForget(() => onUpdate({ models: nextModels }));
                        }
                    }}
                    placeholder="gpt-4o, qwen3-max, glm-4.6, …"
                    spellCheck={false}
                    className="h-8 flex-1 rounded-full border border-border/60 bg-transparent px-3 font-mono text-[12.5px] font-medium text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/40"
                />
            </FieldRow>

            <FieldRow label="Context">
                <div className="flex flex-1 items-center gap-1.5">
                    <input
                        value={contextDraft}
                        onChange={(e) => setContextDraft(e.target.value)}
                        onBlur={() => {
                            const parsed = parseInt(contextDraft);
                            if (!Number.isFinite(parsed) || parsed < 1000) {
                                setContextDraft(contextLimit > 0 ? String(contextLimit) : "");
                                return;
                            }
                            if (parsed !== contextLimit && modelId.trim()) {
                                fireAndForget(() =>
                                    onUpdate({
                                        models: [
                                            {
                                                id: modelId,
                                                displayName: modelId,
                                                capabilities: [],
                                                contextWindow: parsed,
                                            },
                                        ],
                                    })
                                );
                            }
                        }}
                        placeholder="128000"
                        spellCheck={false}
                        className="h-8 w-28 rounded-full border border-border/60 bg-transparent px-3 font-mono text-[12.5px] font-medium text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/40"
                    />
                    <span className="text-[11px] text-muted-foreground">tokens</span>
                </div>
            </FieldRow>

            <FieldRow label="API key">
                {hasKey ? (
                    <div className="flex flex-1 items-center gap-1.5">
                        <code className="flex-1 truncate rounded-full bg-white/[0.04] px-3 py-1 font-mono text-[11.5px] font-medium text-muted-foreground">
                            {maskSecretName(tokenSecretName)}
                        </code>
                        <button
                            type="button"
                            onClick={() => fireAndForget(onClearKey)}
                            title="Remove key"
                            className="grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:text-destructive"
                        >
                            <Icon name="cancel-01" size={12} strokeWidth={1.75} />
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-1 gap-1.5">
                        <input
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            value={keyDraft}
                            onChange={(e) => {
                                setKeyDraft(e.target.value);
                                if (keyError) setKeyError(null);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    fireAndForget(handleSaveKey);
                                }
                            }}
                            placeholder="Optional — leave empty for unauthenticated endpoints"
className="h-8 flex-1 rounded-full border border-border/60 bg-transparent px-3 font-mono text-[12.5px] font-medium text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/40"
                        />
                        <button
                            type="button"
                            onClick={() => fireAndForget(handleSaveKey)}
                            disabled={keySaving || !keyDraft.trim()}
                            className="h-8 cursor-pointer rounded-full bg-destructive px-4 text-[12px] font-medium text-white transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Save
                        </button>
                    </div>
                )}
            </FieldRow>

            {keyError ? (
                <p className="text-[11px] text-destructive">{keyError}</p>
            ) : null}

            <StatusLine status={testStatus} error={testError} />
        </div>
    );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-[12px] font-medium tracking-tight text-muted-foreground">
                {label}
            </span>
            <div className="flex flex-1 items-center">{children}</div>
        </div>
    );
}

function StatusLine({
    status,
    error,
}: {
    status: "idle" | "testing" | "ok" | "fail";
    error?: string | null;
}) {
    if (status === "idle") return null;
    if (status === "testing") {
        return <span className="text-[11px] text-muted-foreground">Testing…</span>;
    }
    if (status === "ok") {
        return (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Icon name="checkmark-circle-02" size={11} strokeWidth={2} />
                Reachable — server responded.
            </span>
        );
    }
    return (
        <span className="text-[11px] text-destructive/80">
            {error ? `Could not reach: ${error}` : "Could not reach the server."}
        </span>
    );
}

// Mask a secret name (e.g. "OPENAI_COMPAT_abc12345_API_KEY") to a
// readable-but-redacted form, mirroring ProviderKeyCard's maskSecretName.
function maskSecretName(name: string): string {
    if (name.length <= 8) return "•".repeat(name.length);
    return `${name.slice(0, 6)}${"•".repeat(8)}${name.slice(-4)}`;
}