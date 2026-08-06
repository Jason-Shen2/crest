// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    _resetAgentRewindProcessOwnerForTests,
    acquireAgentRewindFeature,
    getAgentRewindProcessOwner,
    openAgentRewindFeature,
} from "./agent-rewind-feature";

afterEach(() => {
    _resetAgentRewindProcessOwnerForTests();
});

describe("agent rewind feature", () => {
    it("shares the exact process owner object across concurrent runtimes", async () => {
        const owner = { pid: 42, processStartToken: "start-a", nonce: "nonce-a" };
        const factory = vi.fn(async () => owner);

        const [first, second] = await Promise.all([
            getAgentRewindProcessOwner(factory),
            getAgentRewindProcessOwner(factory),
        ]);

        expect(first).toBe(owner);
        expect(second).toBe(owner);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("opens identity and storage without a rollout environment variable", async () => {
        const owner = { pid: 42, processStartToken: "start-a", nonce: "nonce-a" };
        await getAgentRewindProcessOwner(async () => owner);
        const identity = {
            canonicalRoot: "/workspace",
            workspaceIdentity: "a".repeat(64),
            workspaceIncarnation: "b".repeat(64),
            storeKey: "workspace",
            ancestorIdentityChain: [],
        };
        const store = { identity };
        const resolveIdentity = vi.fn(async () => identity);
        const openStore = vi.fn(async () => store as never);
        const acquireTracker = vi.fn();
        const result = await openAgentRewindFeature({
            workspaceRoot: "/workspace",
            dataRoot: "/data",
            dependencies: { resolveIdentity, openStore, acquireTracker },
        });

        expect(result).toEqual({ state: "enabled", processOwner: owner, store });
        expect(resolveIdentity).toHaveBeenCalledWith("/workspace");
        expect(openStore).toHaveBeenCalledOnce();
        expect(acquireTracker).not.toHaveBeenCalled();
    });

    it("acquires a tracker lease only for a live Agent runtime", async () => {
        const owner = { pid: 42, processStartToken: "start-a", nonce: "nonce-a" };
        await getAgentRewindProcessOwner(async () => owner);
        const identity = {
            canonicalRoot: "/workspace",
            workspaceIdentity: "a".repeat(64),
            workspaceIncarnation: "b".repeat(64),
            storeKey: "workspace",
            ancestorIdentityChain: [],
        };
        const store = { identity };
        const tracker = {};
        const release = vi.fn(async () => undefined);
        const resolveIdentity = vi.fn(async () => identity);
        const openStore = vi.fn();
        const acquireTracker = vi.fn(async () => ({ store, tracker, release }) as never);

        const result = await acquireAgentRewindFeature({
            workspaceRoot: "/workspace",
            dataRoot: "/data",
            dependencies: { resolveIdentity, openStore, acquireTracker },
        });

        expect(result).toEqual({ state: "enabled", processOwner: owner, store, tracker, release });
        expect(openStore).not.toHaveBeenCalled();
        expect(acquireTracker).toHaveBeenCalledWith(
            expect.objectContaining({ dataRoot: "/data", identity, processOwner: owner })
        );
    });
});
