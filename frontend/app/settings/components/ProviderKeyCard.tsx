// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ProviderKeyCard — one row in the Providers list.  Mirrors terax-ai
// ProviderKeyCard.tsx verbatim in structure; the only adaptation is that
// the crest renderer can't see the actual key value (it lives in the
// OS keychain, only the emain side reads it), so the "set" view shows
// the secret NAME (e.g. ANTHROPIC_API_KEY) instead of a masked key.
//
// Card layout (top to bottom):
//   1. Header row: ProviderIcon · label · "Connected" badge (if set) ·
//      "Get key" external link · remove (×) icon
//   2a. Set state: masked secret-name + edit pencil + remove (×) buttons
//   2b. Unset state: password input + show/hide eye + Save button + error
//
// Save / Clear flow:
//   - Save key: SetSecretsCommand({ [tokenSecretName]: value }) +
//                writeAIUserConfig({ ..., providers: { [id]: { tokensecretname } } })
//   - Clear:    SetSecretsCommand({ [tokenSecretName]: null }) +
//                writeAIUserConfig dropping the provider entry
//
// Crest differences from terax:
//   - "Set" view shows the secret NAME (the only thing the renderer
//     knows about) instead of a masked key.  When the user clicks
//     "edit", we transition to the password input — no key value
//     pre-fill (we don't have it).
//   - No keyPrefix validation: crest's catalog doesn't carry prefix
//     metadata.  Easy to add later by extending ProviderEntry with
//     `keyPrefix?: string`.
//   - Test-connection button is omitted (no emain IPC for it; LM
//     Studio / Ollama are out of scope for this iteration).

import { Icon } from "@/app/icon/Icon";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { type ReactNode, useEffect, useState } from "react";
import { ProviderIcon, type ProviderId } from "./ProviderIcon";

// Per-provider metadata the catalog doesn't carry.  Keep this small —
// only the bits the settings UI needs.  consoleUrl points at the
// provider's "create an API key" page so the "Get key" link works
// without a deep-link to a specific account portal.
const PROVIDER_META: Record<ProviderId, { label: string; consoleUrl: string }> = {
    openai: { label: "OpenAI", consoleUrl: "https://platform.openai.com/api-keys" },
    anthropic: { label: "Anthropic", consoleUrl: "https://console.anthropic.com/settings/keys" },
    google: {
        label: "Google Gemini",
        consoleUrl: "https://aistudio.google.com/apikey",
    },
    minimax: {
        label: "minimax",
        consoleUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    },
    "minimax-cn": {
        label: "minimax (China)",
        consoleUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    },
    openrouter: { label: "OpenRouter", consoleUrl: "https://openrouter.ai/settings/keys" },
};

type Props = {
    provider: ProviderId;
    // The keychain name the key is (or would be) stored under, e.g.
    // "OPENAI_API_KEY".  When this is non-empty, the card shows the
    // "set" view; when empty, the "unset" editing view.
    tokenSecretName: string;
    // True iff the user actually has a value in the keychain under
    // `tokenSecretName`.  Currently crest's renderer can't read the
    // keychain directly, so this is the same as `tokenSecretName !== ""`
    // — but kept as an explicit prop so the data source can grow
    // (e.g. if emain ever exposes a "is this secret present?" RPC).
    hasKey: boolean;
    onSave: (key: string) => Promise<void>;
    onClear: () => Promise<void>;
    // When set, the card is in "newly added but unconfigured" state —
    // the unset input shows immediately without requiring the user
    // to click "edit" first.
    initiallyEditing?: boolean;
    // The remove (×) button in the header.  In terax this is only
    // present for providers the user explicitly added (not the
    // default-visible ones).  Crest mirrors that semantic.
    onRemove?: () => void;
};

export function ProviderKeyCard({
    provider,
    tokenSecretName,
    hasKey,
    onSave,
    onClear,
    initiallyEditing,
    onRemove,
}: Props) {
    const meta = PROVIDER_META[provider];
    const [editing, setEditing] = useState(!hasKey || !!initiallyEditing);
    const [value, setValue] = useState("");
    const [reveal, setReveal] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // When the underlying config changes (a Save or Clear upstream
    // lands), drop the editing view so the user sees the set state.
    useEffect(() => {
        if (hasKey) setEditing(false);
    }, [hasKey]);

    const submit = async () => {
        const trimmed = value.trim();
        if (!trimmed) {
            setError("Enter your API key.");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await onSave(trimmed);
            setValue("");
            setReveal(false);
        } catch (e) {
            setError(`Failed to save: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
            {/* ---- header row ---- */}
            <div className="flex items-center gap-2">
                <ProviderIcon provider={provider} size={15} />
                <span className="text-[12.5px] font-medium">{meta.label}</span>
                {hasKey ? (
                    <span className="ml-1 inline-flex h-4 items-center gap-1 rounded-full border border-white/10 bg-white/5 px-1.5 text-[10px] font-normal text-white/55">
                        <Icon name="checkmark-circle-02" size={9} strokeWidth={2} />
                        Connected
                    </span>
                ) : null}
                <a
                    href={meta.consoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-white/55 transition-colors hover:text-white"
                >
                    Get key
                    <Icon name="arrow-up-right-01" size={11} strokeWidth={1.75} />
                </a>
                {onRemove ? (
                    <button
                        type="button"
                        onClick={onRemove}
                        title="Remove provider"
                        className="grid size-7 cursor-pointer place-items-center rounded-md text-white/55 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                    >
                        <Icon name="cancel-01" size={12} strokeWidth={1.75} />
                    </button>
                ) : null}
            </div>

            {/* ---- body: editing or set view ---- */}
            {editing ? (
                <EditingBody
                    provider={provider}
                    value={value}
                    setValue={setValue}
                    reveal={reveal}
                    setReveal={setReveal}
                    saving={saving}
                    error={error}
                    setError={setError}
                    hasKey={hasKey}
                    onSubmit={submit}
                    onCancel={() => {
                        setValue("");
                        setReveal(false);
                        setError(null);
                        setEditing(false);
                    }}
                />
            ) : (
                <SetBody
                    tokenSecretName={tokenSecretName}
                    onEdit={() => setEditing(true)}
                    onClear={onClear}
                    canRemove={!onRemove}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// editing body — password input + show/hide + Save
// ---------------------------------------------------------------------------

function EditingBody({
    provider,
    value,
    setValue,
    reveal,
    setReveal,
    saving,
    error,
    setError,
    hasKey,
    onSubmit,
    onCancel,
}: {
    provider: ProviderId;
    value: string;
    setValue: (v: string) => void;
    reveal: boolean;
    setReveal: (v: boolean) => void;
    saving: boolean;
    error: string | null;
    setError: (v: string | null) => void;
    hasKey: boolean;
    onSubmit: () => void;
    onCancel: () => void;
}) {
    const meta = PROVIDER_META[provider];
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
                <div className="relative flex-1">
                    <input
                        type={reveal ? "text" : "password"}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={`Paste your ${meta.label} API key`}
                        value={value}
                        disabled={saving}
                        onChange={(e) => {
                            setValue(e.target.value);
                            if (error) setError(null);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                onSubmit();
                            } else if (e.key === "Escape" && hasKey) {
                                onCancel();
                            }
                        }}
                        className="h-8 w-full rounded-md border border-white/10 bg-black/30 pr-7 pl-2 font-mono text-[11.5px] text-white outline-none transition-colors placeholder:text-white/40 focus:border-emerald-500/50 disabled:opacity-50"
                    />
                    <button
                        type="button"
                        onClick={() => setReveal(!reveal)}
                        tabIndex={-1}
                        className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer text-white/40 hover:text-white"
                        aria-label={reveal ? "Hide key" : "Show key"}
                    >
                        <Icon
                            name={reveal ? "view-off-slash" : "view"}
                            size={12}
                            strokeWidth={1.75}
                        />
                    </button>
                </div>
                <button
                    type="button"
                    onClick={onSubmit}
                    disabled={saving || !value.trim()}
                    className="h-8 cursor-pointer rounded-md bg-emerald-500/85 px-3 text-[11px] font-medium text-black transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? <Spinner /> : null}
                    Save
                </button>
            </div>
            {error ? (
                <p className="text-[10.5px] text-rose-300">{error}</p>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// set body — masked secret-name + edit + remove
// ---------------------------------------------------------------------------

function SetBody({
    tokenSecretName,
    onEdit,
    onClear,
    canRemove,
}: {
    tokenSecretName: string;
    onEdit: () => void;
    onClear: () => Promise<void>;
    canRemove: boolean;
}) {
    return (
        <div className="flex items-center gap-1.5">
            <code className="flex-1 truncate rounded bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-white/55">
                {maskSecretName(tokenSecretName)}
            </code>
            <button
                type="button"
                onClick={onEdit}
                title="Replace"
                className="grid size-7 cursor-pointer place-items-center rounded-md text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
                <Icon name="edit-02" size={12} strokeWidth={1.75} />
            </button>
            {canRemove ? (
                <button
                    type="button"
                    onClick={() => {
                        fireAndForget(onClear);
                    }}
                    title="Remove"
                    className="grid size-7 cursor-pointer place-items-center rounded-md text-white/55 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                >
                    <Icon name="cancel-01" size={12} strokeWidth={1.75} />
                </button>
            ) : null}
        </div>
    );
}

// The "mask" for the set view.  Crest's renderer doesn't see the actual
// key, so we mask the keychain name itself — first 2 + 4 dots + last 2.
// Reads as "configured but not showing" without leaking which secret
// name is in use to a shoulder-surfer.
function maskSecretName(name: string): string {
    if (name.length <= 6) return "•".repeat(name.length);
    return `${name.slice(0, 2)}${"•".repeat(4)}${name.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// spinner — terax uses its own ui/spinner, crest doesn't have one yet.
// This is a minimal replacement sized to fit the Save button (12px).
// ---------------------------------------------------------------------------
function Spinner(): ReactNode {
    return (
        <span
            aria-hidden="true"
            className="mr-1 inline-block size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
        />
    );
}
