// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchRegistryModels, refreshRegistryModels, registryModelsMapAtom } from "./ai-registry-models";

const mocks = vi.hoisted(() => ({
    listRegistryModels: vi.fn(),
    refreshRegistryModels: vi.fn(),
}));

vi.mock("@/app/store/global", () => ({
    getApi: () => ({ ai: mocks }),
}));

const MODEL: RegistryModelInfo = {
    id: "gpt-next",
    name: "GPT Next",
    reasoning: true,
    thinkinglevels: ["low", "medium", "high"],
    inputmodalities: ["text", "image"],
    context: 250_000,
};

describe("renderer registry model state", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        globalStore.set(registryModelsMapAtom, {});
    });

    it("coalesces concurrent requests for one provider", async () => {
        let resolve!: (models: RegistryModelInfo[]) => void;
        mocks.listRegistryModels.mockReturnValue(
            new Promise<RegistryModelInfo[]>((done) => {
                resolve = done;
            })
        );

        const first = fetchRegistryModels("openai");
        const second = fetchRegistryModels("openai");

        expect(mocks.listRegistryModels).toHaveBeenCalledTimes(1);
        resolve([MODEL]);
        await Promise.all([first, second]);
        expect(globalStore.get(registryModelsMapAtom).openai).toMatchObject({
            status: "ok",
            models: [MODEL],
        });
    });

    it("uses a successful session cache until explicitly refreshed", async () => {
        mocks.listRegistryModels.mockResolvedValue([MODEL]);
        mocks.refreshRegistryModels.mockResolvedValue([{ ...MODEL, context: 300_000 }]);

        await fetchRegistryModels("openai");
        await fetchRegistryModels("openai");
        await refreshRegistryModels("openai");

        expect(mocks.listRegistryModels).toHaveBeenCalledTimes(1);
        expect(mocks.refreshRegistryModels).toHaveBeenCalledTimes(1);
        expect(globalStore.get(registryModelsMapAtom).openai.models[0].context).toBe(300_000);
    });

    it("preserves the last successful models when a force refresh fails", async () => {
        mocks.listRegistryModels.mockResolvedValue([MODEL]);
        mocks.refreshRegistryModels.mockRejectedValue(new Error("catalog unavailable"));

        await fetchRegistryModels("openai");
        const fetchedAt = globalStore.get(registryModelsMapAtom).openai.fetchedAt;
        await refreshRegistryModels("openai");

        expect(globalStore.get(registryModelsMapAtom).openai).toEqual({
            status: "error",
            models: [MODEL],
            error: "catalog unavailable",
            fetchedAt,
        });
    });
});
