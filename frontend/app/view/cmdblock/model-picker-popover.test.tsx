// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { providerModelsMapAtom } from "@/app/store/ai-provider-models";
import { registryModelsMapAtom } from "@/app/store/ai-registry-models";
import { globalStore } from "@/app/store/jotaiStore";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_INLINE_FRAME_CLASSNAME } from "./command-inline-frame";
import { ModelPickerInline } from "./model-picker-popover";

const mocks = vi.hoisted(() => ({
    fetchProviderModels: vi.fn(),
    refreshProviderModels: vi.fn(),
    fetchRegistryModels: vi.fn(),
    refreshRegistryModels: vi.fn(),
}));

vi.mock("@/app/store/ai-provider-models", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/store/ai-provider-models")>()),
    fetchProviderModels: mocks.fetchProviderModels,
    refreshProviderModels: mocks.refreshProviderModels,
}));

vi.mock("@/app/store/ai-registry-models", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/store/ai-registry-models")>()),
    fetchRegistryModels: mocks.fetchRegistryModels,
    refreshRegistryModels: mocks.refreshRegistryModels,
}));

vi.mock("@/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { modalOpen: atom(false) } };
});

beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    globalStore.set(providerModelsMapAtom, {});
    globalStore.set(registryModelsMapAtom, {});
});

afterEach(cleanup);

describe("ModelPickerInline", () => {
    it("renders inside the shared command inline frame", () => {
        const html = renderToStaticMarkup(
            <ModelPickerInline
                open
                onOpenChange={() => undefined}
                selection={null}
                onSelectionChange={vi.fn()}
                userConfig={null}
                userConfigStatus="ok"
                catalog={[]}
            />
        );

        expect(html).toContain("/model");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("rounded-2xl");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("bg-[rgba(34,34,36,0.62)]");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("backdrop-blur-2xl");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).not.toContain("border-t");
        expect(html).toContain('aria-label="Resize /model menu"');
        expect(html).toContain('data-command-inline-drag-handle="true"');
        expect(html).toContain("flex min-w-0 flex-1 items-center gap-3");
        expect(html.indexOf("<span>Add</span>")).toBeLessThan(html.indexOf('data-command-inline-drag-handle="true"'));
        expect(html).not.toContain("absolute inset-0");
    });

    it("uses rounded attached-panel search and hint surfaces", () => {
        const html = renderToStaticMarkup(
            <ModelPickerInline
                open
                onOpenChange={() => undefined}
                selection={null}
                onSelectionChange={vi.fn()}
                userConfig={null}
                userConfigStatus="ok"
                catalog={[]}
            />
        );

        expect(html).toContain("rounded-xl");
        expect(html).toContain("bg-white/[0.045]");
        expect(html).toContain("border-t border-white/[0.06]");
        expect(html).not.toContain("border-b border-fg-overlay-2");
        expect(html).not.toContain("bg-fg-overlay-1/60");
    });

    it("loads and force-refreshes catalog facts and account availability independently", async () => {
        const userConfig = {
            providers: { openai: { tokensecretname: "OPENAI_API_KEY" } },
            default: { provider: "openai", model: "gpt-5" },
        };
        render(
            <Provider store={globalStore}>
                <ModelPickerInline
                    open
                    onOpenChange={() => undefined}
                    selection={{ provider: "openai", model: "gpt-5" }}
                    onSelectionChange={vi.fn()}
                    userConfig={userConfig}
                    userConfigStatus="ok"
                />
            </Provider>
        );

        await waitFor(() => {
            expect(mocks.fetchRegistryModels).toHaveBeenCalledWith("openai");
            expect(mocks.fetchProviderModels).toHaveBeenCalledWith("openai", userConfig);
        });

        fireEvent.mouseDown(screen.getByTitle("Refresh model list"));
        expect(mocks.refreshRegistryModels).toHaveBeenCalledWith("openai");
        expect(mocks.refreshProviderModels).toHaveBeenCalledWith("openai", userConfig);
    });

    it("uses registry metadata, filters by availability, and keeps availability-only ids provisional", async () => {
        const userConfig = {
            providers: { openai: { tokensecretname: "OPENAI_API_KEY" } },
            default: { provider: "openai", model: "gpt-5" },
        };
        const registryState = {
            status: "ok" as const,
            models: [
                {
                    id: "gpt-5",
                    name: "GPT-5 Fresh",
                    reasoning: true,
                    thinkinglevels: ["low", "medium", "high"],
                    inputmodalities: ["text", "image"],
                    context: 250_000,
                },
            ],
            fetchedAt: 1,
        };
        globalStore.set(registryModelsMapAtom, { openai: registryState });
        globalStore.set(providerModelsMapAtom, {
            openai: {
                status: "ok",
                models: [
                    { id: "gpt-5", name: "Stale availability name", context: 100_000 },
                    { id: "deployment-alias", name: "Deployment Alias", context: 999_000 },
                ],
                fetchedAt: 1,
            },
        });

        render(
            <Provider store={globalStore}>
                <ModelPickerInline
                    open
                    onOpenChange={() => undefined}
                    selection={{ provider: "openai", model: "gpt-5" }}
                    onSelectionChange={vi.fn()}
                    userConfig={userConfig}
                    userConfigStatus="ok"
                />
            </Provider>
        );

        expect(await screen.findAllByText("GPT-5 Fresh")).not.toHaveLength(0);
        expect(screen.getByText("Deployment Alias")).toBeTruthy();
        expect(screen.getAllByText(/250k/)).not.toHaveLength(0);
        expect(screen.queryByText(/999k/)).toBeNull();
        expect(globalStore.get(registryModelsMapAtom)).toEqual({ openai: registryState });
    });

    it("keeps filtering with the last good availability after a refresh error", async () => {
        const userConfig = {
            providers: { openai: { tokensecretname: "OPENAI_API_KEY" } },
            default: { provider: "openai", model: "available-model" },
        };
        globalStore.set(providerModelsMapAtom, {
            openai: {
                status: "error",
                models: [{ id: "available-model" }],
                error: "provider unavailable",
                fetchedAt: 1,
            },
        });

        render(
            <Provider store={globalStore}>
                <ModelPickerInline
                    open
                    onOpenChange={() => undefined}
                    selection={{ provider: "openai", model: "available-model" }}
                    onSelectionChange={vi.fn()}
                    userConfig={userConfig}
                    userConfigStatus="ok"
                    catalog={[
                        {
                            id: "openai",
                            displayName: "OpenAI",
                            defaultEndpoint: "https://api.openai.com/v1",
                            defaultApiType: "openai-responses",
                            tokenSecretName: "OPENAI_API_KEY",
                            icon: "stars-01",
                            models: [
                                {
                                    id: "available-model",
                                    displayName: "Available Model",
                                    capabilities: ["tools"],
                                    contextWindow: 100_000,
                                },
                                {
                                    id: "unavailable-model",
                                    displayName: "Unavailable Model",
                                    capabilities: ["tools"],
                                    contextWindow: 100_000,
                                },
                            ],
                        },
                    ]}
                />
            </Provider>
        );

        expect(await screen.findAllByText("Available Model")).not.toHaveLength(0);
        expect(screen.queryByText("Unavailable Model")).toBeNull();
    });

    it("shows no catalog models when availability succeeds with an empty list", async () => {
        const userConfig = {
            providers: { openai: { tokensecretname: "OPENAI_API_KEY" } },
            default: { provider: "openai", model: "catalog-only-model" },
        };
        globalStore.set(providerModelsMapAtom, {
            openai: {
                status: "ok",
                models: [],
                fetchedAt: 1,
            },
        });

        render(
            <Provider store={globalStore}>
                <ModelPickerInline
                    open
                    onOpenChange={() => undefined}
                    selection={{ provider: "openai", model: "catalog-only-model" }}
                    onSelectionChange={vi.fn()}
                    userConfig={userConfig}
                    userConfigStatus="ok"
                    catalog={[
                        {
                            id: "openai",
                            displayName: "OpenAI",
                            defaultEndpoint: "https://api.openai.com/v1",
                            defaultApiType: "openai-responses",
                            tokenSecretName: "OPENAI_API_KEY",
                            icon: "stars-01",
                            models: [
                                {
                                    id: "catalog-only-model",
                                    displayName: "Catalog Only Model",
                                    capabilities: ["tools"],
                                    contextWindow: 100_000,
                                },
                            ],
                        },
                    ]}
                />
            </Provider>
        );

        await waitFor(() => expect(mocks.fetchProviderModels).toHaveBeenCalled());
        expect(screen.queryByText("Catalog Only Model")).toBeNull();
    });
});
