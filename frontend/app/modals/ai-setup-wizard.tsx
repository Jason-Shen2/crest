// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AISetupWizard — 3-step modal that gets a fresh user from zero
// configuration to "ready to send agent messages" without ever
// touching ~/.config/crest/ai.json by hand.
//
// Step 1: pick providers (catalog list with checkboxes)
// Step 2: paste API key for each selected provider
// Step 3: pick default model (provider + model + optional reasoning)
//
// On submit: writes ai.json via WriteAIUserConfigCommand AND saves
// keys to OS keychain via SetSecretsCommand. Both happen atomically
// from the user's perspective — if the keychain write fails we still
// write ai.json (the user can re-enter keys without losing provider
// selection).

import { reloadAIUserConfig } from "@/app/store/ai-user-config";
import { CATALOG, ModelEntry, ProviderEntry, ReasoningLevel } from "@/app/store/ai-catalog";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useCallback, useMemo, useState } from "react";

import { Modal } from "./modal";

type Step = 1 | 2 | 3;

interface SelectionState {
    providers: Set<string>; // ids of selected catalog providers
    keys: Map<string, string>; // provider id → API key
    defaultProvider: string;
    defaultModel: string;
    defaultReasoning?: ReasoningLevel;
}

const AISetupWizardV = ({ onClose }: { onClose: () => void }) => {
    const [step, setStep] = useState<Step>(1);
    const [state, setState] = useState<SelectionState>({
        providers: new Set(),
        keys: new Map(),
        defaultProvider: "",
        defaultModel: "",
    });
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string>("");

    // ---------- step validation ----------
    const step1Valid = state.providers.size > 0;
    const step2Valid = useMemo(() => {
        for (const pid of state.providers) {
            const k = state.keys.get(pid) ?? "";
            if (!k.trim()) return false;
        }
        return true;
    }, [state.providers, state.keys]);
    const step3Valid = !!state.defaultProvider && !!state.defaultModel;

    const canAdvance = step === 1 ? step1Valid : step === 2 ? step2Valid : step3Valid;

    // ---------- actions ----------
    const toggleProvider = (pid: string) => {
        setState((s) => {
            const next = new Set(s.providers);
            if (next.has(pid)) next.delete(pid);
            else next.add(pid);
            // Cascade — if we drop the provider currently selected as
            // default, clear that field.
            let defaultProvider = s.defaultProvider;
            let defaultModel = s.defaultModel;
            if (!next.has(defaultProvider)) {
                defaultProvider = "";
                defaultModel = "";
            }
            return { ...s, providers: next, defaultProvider, defaultModel };
        });
    };

    const setKey = (pid: string, value: string) => {
        setState((s) => {
            const next = new Map(s.keys);
            next.set(pid, value);
            return { ...s, keys: next };
        });
    };

    const pickDefault = (provider: string, model: string, reasoning?: ReasoningLevel) => {
        setState((s) => ({
            ...s,
            defaultProvider: provider,
            defaultModel: model,
            defaultReasoning: reasoning,
        }));
    };

    const handleNext = useCallback(() => {
        if (!canAdvance) return;
        setError("");
        if (step === 1) {
            // Seed defaults for step 2: keys default to empty strings.
            // Seed defaults for step 3: first selected provider, its first model.
            setState((s) => {
                const firstProvider = [...s.providers][0];
                const provider = CATALOG.find((p) => p.id === firstProvider);
                const firstModel = provider?.models[0];
                return {
                    ...s,
                    defaultProvider: s.defaultProvider || firstProvider || "",
                    defaultModel: s.defaultModel || firstModel?.id || "",
                };
            });
            setStep(2);
        } else if (step === 2) {
            setStep(3);
        }
    }, [canAdvance, step]);

    const handleBack = useCallback(() => {
        setError("");
        if (step === 2) setStep(1);
        else if (step === 3) setStep(2);
    }, [step]);

    const handleSubmit = useCallback(async () => {
        if (!canAdvance) return;
        setSubmitting(true);
        setError("");
        try {
            // Compose ai.json shape.  Each selected provider gets a
            // tokensecretname pointing at the catalog's canonical
            // keychain name — that's where SetSecretsCommand below
            // writes the actual key.
            const providers: AIUserConfig["providers"] = {};
            const secrets: { [name: string]: string } = {};
            for (const pid of state.providers) {
                const meta = CATALOG.find((p) => p.id === pid);
                if (!meta) continue;
                providers[pid] = { tokensecretname: meta.tokenSecretName };
                const key = (state.keys.get(pid) ?? "").trim();
                if (key) secrets[meta.tokenSecretName] = key;
            }
            const config: AIUserConfig = {
                providers,
                default: {
                    provider: state.defaultProvider,
                    model: state.defaultModel,
                    ...(state.defaultReasoning ? { reasoning: state.defaultReasoning } : {}),
                },
            };
            // Save keys first so a partial failure leaves the user with
            // working credentials even if the config write fails.
            if (Object.keys(secrets).length > 0) {
                await RpcApi.SetSecretsCommand(TabRpcClient, secrets);
            }
            await RpcApi.WriteAIUserConfigCommand(TabRpcClient, config);
            // Refresh the picker atom so the UI picks up the new state
            // immediately (no need to wait for a watcher event).
            await reloadAIUserConfig();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }, [canAdvance, state, onClose]);

    // ---------- step body ----------
    let body: React.ReactNode;
    if (step === 1) body = <Step1 providers={state.providers} onToggle={toggleProvider} />;
    else if (step === 2)
        body = <Step2 providers={state.providers} keys={state.keys} onSetKey={setKey} />;
    else
        body = (
            <Step3
                providers={state.providers}
                pick={pickDefault}
                defaultProvider={state.defaultProvider}
                defaultModel={state.defaultModel}
                defaultReasoning={state.defaultReasoning}
            />
        );

    return (
        <Modal className="w-[520px] max-h-[80vh] overflow-hidden" onClose={onClose}>
            <div className="flex flex-col font-sans">
                <Header step={step} />
                <div className="flex-1 overflow-y-auto px-6 py-5">{body}</div>
                {error && (
                    <div className="border-t border-rose-500/40 bg-rose-500/10 px-6 py-2 text-[12px] text-rose-300">
                        {error}
                    </div>
                )}
                <Footer
                    step={step}
                    canAdvance={canAdvance}
                    submitting={submitting}
                    onBack={handleBack}
                    onNext={handleNext}
                    onSubmit={handleSubmit}
                    onCancel={onClose}
                />
            </div>
        </Modal>
    );
};
AISetupWizardV.displayName = "AISetupWizardV";

// =========================================================================
// Header — title + step indicator
// =========================================================================

const Header = ({ step }: { step: Step }) => (
    <div className="border-b border-fg-overlay-2 px-6 py-4">
        <div className="text-[16px] font-semibold text-foreground">Set up AI agent</div>
        <div className="mt-1 text-[12px] text-secondary/70">
            Step {step} of 3 —{" "}
            {step === 1
                ? "Pick providers you have API keys for"
                : step === 2
                    ? "Paste your API keys"
                    : "Pick the default model"}
        </div>
    </div>
);

// =========================================================================
// Footer — Back / Next / Save buttons
// =========================================================================

interface FooterProps {
    step: Step;
    canAdvance: boolean;
    submitting: boolean;
    onBack: () => void;
    onNext: () => void;
    onSubmit: () => void;
    onCancel: () => void;
}

const Footer = ({ step, canAdvance, submitting, onBack, onNext, onSubmit, onCancel }: FooterProps) => (
    <div className="flex items-center justify-between border-t border-fg-overlay-2 px-6 py-3">
        <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="cursor-pointer rounded border border-fg-overlay-3 px-3 py-1 text-[12px] text-foreground/85 hover:bg-fg-overlay-2/60 disabled:opacity-50"
        >
            Cancel
        </button>
        <div className="flex items-center gap-2">
            {step > 1 && (
                <button
                    type="button"
                    onClick={onBack}
                    disabled={submitting}
                    className="cursor-pointer rounded border border-fg-overlay-3 px-3 py-1 text-[12px] text-foreground/85 hover:bg-fg-overlay-2/60 disabled:opacity-50"
                >
                    ← Back
                </button>
            )}
            {step < 3 ? (
                <button
                    type="button"
                    onClick={onNext}
                    disabled={!canAdvance || submitting}
                    className={cn(
                        "cursor-pointer rounded bg-[var(--ansi-blue)]/85 px-3 py-1 text-[12px] font-medium text-background transition-colors hover:bg-[var(--ansi-blue)]",
                        (!canAdvance || submitting) && "opacity-50 cursor-not-allowed hover:bg-[var(--ansi-blue)]/85"
                    )}
                >
                    Next →
                </button>
            ) : (
                <button
                    type="button"
                    onClick={onSubmit}
                    disabled={!canAdvance || submitting}
                    className={cn(
                        "cursor-pointer rounded bg-[var(--ansi-green)]/85 px-4 py-1 text-[12px] font-medium text-background transition-colors hover:bg-[var(--ansi-green)]",
                        (!canAdvance || submitting) && "opacity-50 cursor-not-allowed hover:bg-[var(--ansi-green)]/85"
                    )}
                >
                    {submitting ? "Saving…" : "Save"}
                </button>
            )}
        </div>
    </div>
);

// =========================================================================
// Step 1 — pick providers
// =========================================================================

interface Step1Props {
    providers: Set<string>;
    onToggle: (id: string) => void;
}

const Step1 = ({ providers, onToggle }: Step1Props) => (
    <div className="flex flex-col gap-2">
        <div className="mb-1 text-[12px] text-secondary/75">
            Crest is BYO API key. Pick the providers you have keys for; you can add more later.
        </div>
        {CATALOG.map((p) => (
            <label
                key={p.id}
                className="flex cursor-pointer items-start gap-3 rounded border border-fg-overlay-2/60 bg-fg-overlay-1/30 px-3 py-2 hover:bg-fg-overlay-2/40"
            >
                <input
                    type="checkbox"
                    checked={providers.has(p.id)}
                    onChange={() => onToggle(p.id)}
                    className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--ansi-blue)]"
                />
                <div className="flex flex-1 flex-col">
                    <div className="text-[13px] font-medium text-foreground">{p.displayName}</div>
                    <div className="text-[11px] text-secondary/70">
                        {p.models.length} model{p.models.length === 1 ? "" : "s"} ·{" "}
                        {p.models.map((m) => m.displayName).slice(0, 3).join(", ")}
                        {p.models.length > 3 && "…"}
                    </div>
                </div>
            </label>
        ))}
    </div>
);

// =========================================================================
// Step 2 — paste API keys
// =========================================================================

interface Step2Props {
    providers: Set<string>;
    keys: Map<string, string>;
    onSetKey: (id: string, value: string) => void;
}

const Step2 = ({ providers, keys, onSetKey }: Step2Props) => (
    <div className="flex flex-col gap-4">
        <div className="text-[12px] text-secondary/75">
            Keys are saved to the OS keychain (macOS Keychain / Linux Secret Service / Windows
            Credential Manager) under the names below. They never touch ai.json.
        </div>
        {[...providers].map((pid) => {
            const meta = CATALOG.find((p) => p.id === pid);
            if (!meta) return null;
            return (
                <div key={pid} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                        <div className="text-[13px] font-medium text-foreground">
                            {meta.displayName}
                        </div>
                        <div className="font-mono text-[10px] text-secondary/60">
                            keychain: {meta.tokenSecretName}
                        </div>
                    </div>
                    <input
                        type="password"
                        value={keys.get(pid) ?? ""}
                        onChange={(e) => onSetKey(pid, e.target.value)}
                        placeholder={`Paste your ${meta.displayName} API key`}
                        autoComplete="off"
                        spellCheck={false}
                        className="w-full rounded border border-fg-overlay-3 bg-background/60 px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-[var(--ansi-blue)]/60"
                    />
                </div>
            );
        })}
    </div>
);

// =========================================================================
// Step 3 — pick default model
// =========================================================================

interface Step3Props {
    providers: Set<string>;
    pick: (provider: string, model: string, reasoning?: ReasoningLevel) => void;
    defaultProvider: string;
    defaultModel: string;
    defaultReasoning?: ReasoningLevel;
}

const Step3 = ({ providers, pick, defaultProvider, defaultModel, defaultReasoning }: Step3Props) => {
    const providerEntries = useMemo(
        () => CATALOG.filter((p) => providers.has(p.id)),
        [providers]
    );
    const currentProvider: ProviderEntry | undefined = providerEntries.find(
        (p) => p.id === defaultProvider
    );
    const currentModel: ModelEntry | undefined = currentProvider?.models.find(
        (m) => m.id === defaultModel
    );
    const reasoningLevels = currentModel?.reasoningLevels;

    return (
        <div className="flex flex-col gap-4">
            <div className="text-[12px] text-secondary/75">
                This is the model used when no per-pane override is set. You can change it any
                time from the picker chip.
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-[11px] uppercase tracking-wider text-secondary/65">
                    Provider
                </label>
                <select
                    value={defaultProvider}
                    onChange={(e) => {
                        const p = providerEntries.find((pp) => pp.id === e.target.value);
                        pick(e.target.value, p?.models[0]?.id ?? "", undefined);
                    }}
                    className="rounded border border-fg-overlay-3 bg-background/60 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-[var(--ansi-blue)]/60"
                >
                    {providerEntries.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.displayName}
                        </option>
                    ))}
                </select>
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-[11px] uppercase tracking-wider text-secondary/65">
                    Model
                </label>
                <select
                    value={defaultModel}
                    onChange={(e) => pick(defaultProvider, e.target.value, undefined)}
                    className="rounded border border-fg-overlay-3 bg-background/60 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-[var(--ansi-blue)]/60"
                >
                    {currentProvider?.models.map((m) => (
                        <option key={m.id} value={m.id}>
                            {m.displayName} ({formatContext(m.contextWindow)})
                        </option>
                    ))}
                </select>
            </div>

            {reasoningLevels && reasoningLevels.length > 0 && (
                <div className="flex flex-col gap-1">
                    <label className="text-[11px] uppercase tracking-wider text-secondary/65">
                        Reasoning effort
                    </label>
                    <div className="flex gap-1">
                        {reasoningLevels.map((lvl) => (
                            <button
                                key={lvl}
                                type="button"
                                onClick={() => pick(defaultProvider, defaultModel, lvl)}
                                className={cn(
                                    "cursor-pointer rounded border px-2 py-1 text-[12px] transition-colors",
                                    defaultReasoning === lvl
                                        ? "border-[var(--ansi-yellow)]/60 bg-[var(--ansi-yellow)]/15 text-[var(--ansi-yellow)]"
                                        : "border-fg-overlay-3 bg-transparent text-foreground/80 hover:bg-fg-overlay-2/60"
                                )}
                            >
                                {lvl}
                            </button>
                        ))}
                        <button
                            type="button"
                            onClick={() => pick(defaultProvider, defaultModel, undefined)}
                            className={cn(
                                "cursor-pointer rounded border px-2 py-1 text-[12px] transition-colors",
                                !defaultReasoning
                                    ? "border-fg-overlay-3 bg-fg-overlay-2/60 text-foreground"
                                    : "border-fg-overlay-3 bg-transparent text-foreground/60 hover:bg-fg-overlay-2/60"
                            )}
                        >
                            default
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

function formatContext(tokens: number): string {
    if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M ctx`;
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
    return `${tokens} ctx`;
}

// =========================================================================
// Export wrapper that the modal registry consumes
// =========================================================================

export const AISetupWizard = () => {
    const onClose = useCallback(() => modalsModel.popModal(), []);
    return <AISetupWizardV onClose={onClose} />;
};
AISetupWizard.displayName = "AISetupWizard";
