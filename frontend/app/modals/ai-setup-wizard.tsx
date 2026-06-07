// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AISetupWizard — 2-step modal that gets a fresh user from zero
// configuration to "ready to send agent messages" without ever
// touching ~/.config/crest/ai.json by hand.
//
// Step 1: pick providers (catalog list with checkboxes)
// Step 2: paste API key for each selected provider
//
// On submit: writes ai.json via getApi().ai.writeUserConfig AND saves
// keys to OS keychain via SetSecretsCommand. Both happen atomically
// from the user's perspective — if the keychain write fails we still
// write ai.json (the user can re-enter keys without losing provider
// selection).

import { CATALOG } from "@/app/store/ai-catalog";
import type { AIUserConfig } from "@/app/store/ai-types";
import { aiUserConfigAtom, reloadAIUserConfig, writeAIUserConfig } from "@/app/store/ai-user-config";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";

import { Modal } from "./modal";

type Step = 1 | 2;

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
    openrouter: "openrouter/auto",
};

interface SelectionState {
    providers: Set<string>; // ids of selected catalog providers
    keys: Map<string, string>; // provider id → API key
    defaultProvider: string;
    defaultModel: string;
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

    const canAdvance = step === 1 ? step1Valid : step2Valid;

    // ---------- actions ----------
    const toggleProvider = (pid: string) => {
        setState((s) => {
            const next = new Set(s.providers);
            if (next.has(pid)) next.delete(pid);
            else next.add(pid);
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

    const handleNext = useCallback(() => {
        if (!canAdvance) return;
        setError("");
        if (step === 1) {
            // Seed defaults for step 2: keys default to empty strings.
            // Default model is intentionally automatic: the user can change it later
            // from the picker, so setup only asks for provider credentials.
            setState((s) => {
                const firstProvider = [...s.providers][0];
                const provider = CATALOG.find((p) => p.id === firstProvider);
                return {
                    ...s,
                    defaultProvider: s.defaultProvider || firstProvider || "",
                    defaultModel: s.defaultModel || getDefaultModelId(provider),
                };
            });
            setStep(2);
        }
    }, [canAdvance, step]);

    const handleBack = useCallback(() => {
        setError("");
        if (step === 2) setStep(1);
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
            const firstProvider = state.defaultProvider || [...state.providers][0] || "";
            const providerMeta = CATALOG.find((p) => p.id === firstProvider);
            const firstModel = state.defaultModel || getDefaultModelId(providerMeta);
            if (!firstProvider || !firstModel) {
                throw new Error("No default model is available for the selected provider.");
            }
            const config: AIUserConfig = {
                providers,
                default: {
                    provider: firstProvider,
                    model: firstModel,
                },
            };
            // Save keys first so a partial failure leaves the user with
            // working credentials even if the config write fails.
            if (Object.keys(secrets).length > 0) {
                await RpcApi.SetSecretsCommand(TabRpcClient, secrets);
            }
            // writeAIUserConfig() persists ai.json via electron IPC and
            // refreshes the atom on success — no separate reload call
            // needed (the explicit reload below is defensive in case a
            // future change drops the implicit refresh).
            await writeAIUserConfig(config);
            await reloadAIUserConfig();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }, [canAdvance, state, onClose]);

    // ---------- step body ----------
    const body =
        step === 1 ? (
            <Step1 providers={state.providers} onToggle={toggleProvider} />
        ) : (
            <Step2 providers={state.providers} keys={state.keys} onSetKey={setKey} />
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
            Step {step} of 2 — {step === 1 ? "Pick providers you have API keys for" : "Paste your API keys"}
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
            {step < 2 ? (
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

const Step1 = ({ providers, onToggle }: Step1Props) => {
    // Hide providers the user has already configured — the wizard is
    // strictly an "add new provider" flow now, not a place to manage
    // existing keys (which still lives in ai.json).
    const userConfigState = useAtomValue(aiUserConfigAtom);
    const configured = userConfigState.config?.providers ?? {};
    const available = CATALOG.filter((p) => !configured[p.id]);

    if (available.length === 0) {
        return (
            <div className="flex flex-col gap-2">
                <div className="rounded border border-fg-overlay-2/60 bg-fg-overlay-1/30 px-3 py-4 text-center text-[12px] text-secondary/75">
                    All catalog providers are already configured. Edit
                    <code className="mx-1 rounded bg-fg-overlay-2/50 px-1 py-0.5 font-mono text-[11px]">
                        ~/.config/crest/ai.json
                    </code>
                    to rotate keys or add custom endpoints.
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="mb-1 text-[12px] text-secondary/75">
                Crest is BYO API key. Pick the providers you have keys for; you can add more later.
            </div>
            {available.map((p) => (
                <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-3 rounded border border-fg-overlay-2/60 bg-fg-overlay-1/30 px-3 py-2 hover:bg-fg-overlay-2/40"
                >
                    <input
                        type="checkbox"
                        checked={providers.has(p.id)}
                        onChange={() => onToggle(p.id)}
                        className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--ansi-blue)]"
                    />
                    <div className="text-[13px] font-medium text-foreground">{p.displayName}</div>
                </label>
            ))}
        </div>
    );
};

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
        {[...providers].map((pid) => {
            const meta = CATALOG.find((p) => p.id === pid);
            if (!meta) return null;
            return (
                <div key={pid} className="flex flex-col gap-1">
                    <div className="text-[13px] font-medium text-foreground">{meta.displayName}</div>
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

function getDefaultModelId(provider: (typeof CATALOG)[number] | undefined): string {
    if (!provider) return "";
    return provider.models[0]?.id ?? DEFAULT_MODEL_BY_PROVIDER[provider.id] ?? "";
}

// =========================================================================
// Export wrapper that the modal registry consumes
// =========================================================================

export const AISetupWizard = () => {
    const onClose = useCallback(() => modalsModel.popModal(), []);
    return <AISetupWizardV onClose={onClose} />;
};
AISetupWizard.displayName = "AISetupWizard";
