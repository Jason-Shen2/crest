// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";

export type RegistryModelsStatus = "idle" | "loading" | "ok" | "error";

export interface RegistryModelsState {
    status: RegistryModelsStatus;
    models: RegistryModelInfo[];
    error?: string;
    fetchedAt: number | null;
}

const EMPTY_STATE: RegistryModelsState = {
    status: "idle",
    models: [],
    fetchedAt: null,
};

export const registryModelsMapAtom = atom<Record<string, RegistryModelsState>>({});

export function registryModelsAtomFor(providerId: string) {
    return atom((get) => get(registryModelsMapAtom)[providerId] ?? EMPTY_STATE);
}

const inflight = new Map<string, Promise<void>>();

function setSlice(providerId: string, next: RegistryModelsState): void {
    const current = globalStore.get(registryModelsMapAtom);
    globalStore.set(registryModelsMapAtom, { ...current, [providerId]: next });
}

export function fetchRegistryModels(providerId: string): Promise<void> {
    const current = globalStore.get(registryModelsMapAtom)[providerId];
    if (current?.status === "ok") return Promise.resolve();
    return runFetch(providerId, false);
}

export function refreshRegistryModels(providerId: string): Promise<void> {
    return runFetch(providerId, true);
}

function runFetch(providerId: string, force: boolean): Promise<void> {
    const existing = inflight.get(providerId);
    if (existing) return existing;

    const previous = globalStore.get(registryModelsMapAtom)[providerId];
    setSlice(providerId, {
        status: "loading",
        models: previous?.models ?? [],
        fetchedAt: previous?.fetchedAt ?? null,
    });

    const request = (async () => {
        try {
            const api = getApi().ai;
            const models = force
                ? await api.refreshRegistryModels(providerId)
                : await api.listRegistryModels(providerId);
            setSlice(providerId, {
                status: "ok",
                models: models ?? [],
                fetchedAt: Date.now(),
            });
        } catch (error) {
            const current = globalStore.get(registryModelsMapAtom)[providerId];
            setSlice(providerId, {
                status: "error",
                models: current?.models ?? previous?.models ?? [],
                error: error instanceof Error ? error.message : String(error),
                fetchedAt: current?.fetchedAt ?? previous?.fetchedAt ?? null,
            });
        } finally {
            inflight.delete(providerId);
        }
    })();
    inflight.set(providerId, request);
    return request;
}
