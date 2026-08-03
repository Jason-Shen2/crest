// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchProviderModels, providerModelsMapAtom, refreshProviderModels } from "./ai-provider-models";
import { registryModelsMapAtom } from "./ai-registry-models";

const mocks = vi.hoisted(() => ({ listProviderModels: vi.fn() }));

vi.mock("@/app/store/global", () => ({
    getApi: () => ({ ai: mocks }),
}));

const CONFIG = {
    providers: { openai: { tokensecretname: "OPENAI_API_KEY" } },
    default: { provider: "openai", model: "gpt-5" },
};

describe("provider availability state", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        globalStore.set(providerModelsMapAtom, {});
        globalStore.set(registryModelsMapAtom, {});
    });

    it("coalesces account availability requests per provider", async () => {
        let resolve!: (models: AiProviderModelInfo[]) => void;
        mocks.listProviderModels.mockReturnValue(
            new Promise<AiProviderModelInfo[]>((done) => {
                resolve = done;
            })
        );

        const first = fetchProviderModels("openai", CONFIG);
        const second = fetchProviderModels("openai", CONFIG);
        expect(mocks.listProviderModels).toHaveBeenCalledTimes(1);

        resolve([{ id: "gpt-5" }]);
        await Promise.all([first, second]);
    });

    it("coalesces a manual refresh with an in-flight availability request", async () => {
        let resolve!: (models: AiProviderModelInfo[]) => void;
        mocks.listProviderModels.mockReturnValue(
            new Promise<AiProviderModelInfo[]>((done) => {
                resolve = done;
            })
        );

        const initial = fetchProviderModels("openai", CONFIG);
        const refresh = refreshProviderModels("openai", CONFIG);

        expect(mocks.listProviderModels).toHaveBeenCalledTimes(1);
        resolve([{ id: "gpt-5" }]);
        await Promise.all([initial, refresh]);
        expect(globalStore.get(providerModelsMapAtom).openai.models).toEqual([{ id: "gpt-5" }]);
    });

    it("preserves availability and never writes catalog facts when refresh fails", async () => {
        mocks.listProviderModels.mockResolvedValueOnce([{ id: "gpt-5" }]);
        await fetchProviderModels("openai", CONFIG);
        const fetchedAt = globalStore.get(providerModelsMapAtom).openai.fetchedAt;
        const registryBefore = globalStore.get(registryModelsMapAtom);

        mocks.listProviderModels.mockRejectedValueOnce(new Error("invalid account token"));
        await refreshProviderModels("openai", CONFIG);

        expect(globalStore.get(providerModelsMapAtom).openai).toEqual({
            status: "error",
            models: [{ id: "gpt-5" }],
            error: "invalid account token",
            fetchedAt,
        });
        expect(globalStore.get(registryModelsMapAtom)).toBe(registryBefore);
    });
});
