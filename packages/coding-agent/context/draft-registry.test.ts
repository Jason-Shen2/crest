// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ContextDraftRegistry, ContextDraftRegistryError, withContextDrafts } from "./draft-registry";
import type { ContextArtifactDraft, ContextGeneratedSummary } from "./types";

function makeDraft(sourceSessionId: string): ContextArtifactDraft {
    return {
        artifact: {
            schemaVersion: 1,
            provenance: {
                sourceKind: "turn",
                sourceSessionId,
                sourceSessionPath: `/sessions/${sourceSessionId}.jsonl`,
                sourceCwd: "/work",
                sourceTurnId: `turn-${sourceSessionId}`,
                sourceLeafId: `leaf-${sourceSessionId}`,
                sourceMessageEntryIds: [`message-${sourceSessionId}`],
                preview: `preview-${sourceSessionId}`,
                capturedAt: "2026-07-22T00:00:00.000Z",
            },
            messages: [{ role: "user", content: [{ type: "text", text: `message-${sourceSessionId}` }] }],
            snapshotSha256: sourceSessionId.padEnd(64, "a").slice(0, 64),
            canonicalByteLength: sourceSessionId.length,
        },
    };
}

function makeSummary(text: string): ContextGeneratedSummary {
    return {
        text,
        summarySha256: text.padEnd(64, "b").slice(0, 64),
        modelKey: "summary-model",
        promptVersion: "v1",
        generatedAt: "2026-07-22T01:00:00.000Z",
    };
}

function makeRegistry(start = 0, ttlMs = 1_000) {
    let now = start;
    let nextId = 0;
    const registry = new ContextDraftRegistry({
        ttlMs,
        now: () => now,
        idFactory: () => `draft-${++nextId}`,
    });
    return {
        registry,
        advance(ms: number) {
            now += ms;
        },
    };
}

function captureError(run: () => unknown): ContextDraftRegistryError {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(ContextDraftRegistryError);
        return error as ContextDraftRegistryError;
    }
    throw new Error("Expected ContextDraftRegistryError");
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("ContextDraftRegistry", () => {
    it("does not expose mutable storage or a general-purpose commit callback", () => {
        const { registry } = makeRegistry();

        expect(registry).not.toHaveProperty("entriesByTarget");
        expect(registry).not.toHaveProperty("commitMany");
    });

    it("keys ownership by the canonical target session path", () => {
        const { registry } = makeRegistry();
        const view = registry.create("/sessions/target-a.jsonl", makeDraft("source-a"));

        expect(registry.peek("/sessions/target-a.jsonl", view.draftId)).toMatchObject({
            draftId: view.draftId,
            targetSessionPath: "/sessions/target-a.jsonl",
        });
        expect(registry.peek("/sessions/target-b.jsonl", view.draftId)).toBeUndefined();

        const error = captureError(() => registry.consumeMany("/sessions/target-b.jsonl", [view.draftId]));
        expect(error.code).toBe("invalid_input");
        expect(registry.peek("/sessions/target-a.jsonl", view.draftId)).toBeDefined();
    });

    it("keeps peek non-consuming and returns only a lightweight view", () => {
        const { registry } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));

        const first = registry.peek("/sessions/target.jsonl", created.draftId);
        const second = registry.peek("/sessions/target.jsonl", created.draftId);

        expect(first).toEqual(second);
        expect(first).not.toHaveProperty("artifact");
        expect(registry.consumeMany("/sessions/target.jsonl", [created.draftId])).toEqual([makeDraft("source")]);
    });

    it("reads full drafts without consuming and keeps clone boundaries", () => {
        const { registry } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));

        const firstRead = registry.readMany("/sessions/target.jsonl", [created.draftId]);
        firstRead[0]!.artifact.provenance.preview = "mutated";
        firstRead[0]!.artifact.messages[0]!.content[0] = { type: "text", text: "mutated" };

        expect(registry.readMany("/sessions/target.jsonl", [created.draftId])).toEqual([makeDraft("source")]);
        expect(registry.peek("/sessions/target.jsonl", created.draftId)).toBeDefined();
    });

    it("supports none, summarizing, failed, and ready summary transitions", () => {
        const { registry } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));
        const generated = makeSummary("summary");

        expect(created.summaryStatus).toBe("none");
        expect(registry.beginSummary("/sessions/target.jsonl", created.draftId).summaryStatus).toBe("summarizing");
        expect(registry.failSummary("/sessions/target.jsonl", created.draftId).summaryStatus).toBe("failed");
        expect(registry.beginSummary("/sessions/target.jsonl", created.draftId).summaryStatus).toBe("summarizing");
        expect(registry.completeSummary("/sessions/target.jsonl", created.draftId, generated).summaryStatus).toBe(
            "ready"
        );
        expect(registry.readMany("/sessions/target.jsonl", [created.draftId])[0]!.artifact.summary).toEqual(generated);
    });

    it("refreshes TTL after validated summary mutations", () => {
        const { registry, advance } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));

        advance(900);
        expect(registry.beginSummary("/sessions/target.jsonl", created.draftId)).toMatchObject({
            summaryStatus: "summarizing",
            expiresAt: new Date(1_900).toISOString(),
        });
        advance(101);
        expect(registry.sweepExpired()).toBe(0);
        expect(
            registry.completeSummary("/sessions/target.jsonl", created.draftId, makeSummary("summary"))
        ).toMatchObject({
            summaryStatus: "ready",
            expiresAt: new Date(2_001).toISOString(),
        });
    });

    it("preserves a prior ready summary when regeneration fails", () => {
        const { registry } = makeRegistry();
        const draft = makeDraft("source");
        const prior = makeSummary("prior");
        draft.artifact.summary = prior;
        const created = registry.create("/sessions/target.jsonl", draft);

        expect(created.summaryStatus).toBe("ready");
        expect(registry.beginSummary("/sessions/target.jsonl", created.draftId).summaryStatus).toBe("summarizing");
        expect(registry.failSummary("/sessions/target.jsonl", created.draftId).summaryStatus).toBe("ready");
        expect(registry.readMany("/sessions/target.jsonl", [created.draftId])[0]!.artifact.summary).toEqual(prior);
    });

    it("protects full reads and summary mutations with ownership and expiry checks", () => {
        const { registry, advance } = makeRegistry();
        const foreign = registry.create("/sessions/target-a.jsonl", makeDraft("foreign"));
        const expired = registry.create("/sessions/target-b.jsonl", makeDraft("expired"));

        expect(() => registry.readMany("/sessions/target-b.jsonl", [foreign.draftId])).toThrowError(
            ContextDraftRegistryError
        );
        expect(() => registry.beginSummary("/sessions/target-b.jsonl", foreign.draftId)).toThrowError(
            ContextDraftRegistryError
        );

        advance(1_000);
        const readError = captureError(() => registry.readMany("/sessions/target-b.jsonl", [expired.draftId]));
        expect(readError.code).toBe("draft_expired");
    });

    it("keeps drafts after noncommitting typed preparation outcomes", () => {
        const { registry } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));

        function previewBudget() {
            const drafts = registry.readMany("/sessions/target.jsonl", [created.draftId]);
            return { status: "budget_exceeded" as const, draftCount: drafts.length };
        }

        expect(previewBudget()).toEqual({ status: "budget_exceeded", draftCount: 1 });
        expect(registry.peek("/sessions/target.jsonl", created.draftId)).toBeDefined();
    });

    it("consumes many drafts atomically", () => {
        const { registry } = makeRegistry();
        const first = registry.create("/sessions/target.jsonl", makeDraft("first"));
        const second = registry.create("/sessions/target.jsonl", makeDraft("second"));

        const error = captureError(() => registry.consumeMany("/sessions/target.jsonl", [first.draftId, "missing"]));
        expect(error.code).toBe("invalid_input");
        expect(registry.peek("/sessions/target.jsonl", first.draftId)).toBeDefined();
        expect(registry.peek("/sessions/target.jsonl", second.draftId)).toBeDefined();

        expect(registry.consumeMany("/sessions/target.jsonl", [first.draftId, second.draftId])).toEqual([
            makeDraft("first"),
            makeDraft("second"),
        ]);
        expect(registry.peek("/sessions/target.jsonl", first.draftId)).toBeUndefined();
        expect(registry.peek("/sessions/target.jsonl", second.draftId)).toBeUndefined();
    });

    it("reports every expired draft ID without consuming valid drafts", () => {
        const { registry, advance } = makeRegistry();
        const expiredFirst = registry.create("/sessions/target.jsonl", makeDraft("expired-first"));
        const expiredSecond = registry.create("/sessions/target.jsonl", makeDraft("expired-second"));
        advance(1_000);
        const valid = registry.create("/sessions/target.jsonl", makeDraft("valid"));

        const error = captureError(() =>
            registry.consumeMany("/sessions/target.jsonl", [expiredFirst.draftId, valid.draftId, expiredSecond.draftId])
        );

        expect(error.code).toBe("draft_expired");
        expect(error.draftIds).toEqual([expiredFirst.draftId, expiredSecond.draftId]);
        expect(registry.peek("/sessions/target.jsonl", valid.draftId)).toBeDefined();
    });

    it("leaves drafts retryable when the commit callback fails", async () => {
        const { registry } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));
        const failure = new Error("storage failed");

        await expect(
            withContextDrafts(registry, "/sessions/target.jsonl", [created.draftId], async () => {
                throw failure;
            })
        ).rejects.toBe(failure);

        expect(registry.peek("/sessions/target.jsonl", created.draftId)).toBeDefined();
    });

    it("consumes drafts only after a successful commit", async () => {
        const { registry } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));
        let visibleDuringCommit = false;

        const result = await withContextDrafts(
            registry,
            "/sessions/target.jsonl",
            [created.draftId],
            async (drafts) => {
                visibleDuringCommit = registry.peek("/sessions/target.jsonl", created.draftId) != null;
                expect(drafts).toEqual([makeDraft("source")]);
                return "committed";
            }
        );

        expect(result).toBe("committed");
        expect(visibleDuringCommit).toBe(true);
        expect(registry.peek("/sessions/target.jsonl", created.draftId)).toBeUndefined();
    });

    it("reserves all drafts before invoking a commit callback", async () => {
        const { registry } = makeRegistry();
        const firstDraft = registry.create("/sessions/target.jsonl", makeDraft("first"));
        const secondDraft = registry.create("/sessions/target.jsonl", makeDraft("second"));
        const entered = deferred<void>();
        const release = deferred<void>();
        let competingCallbackRan = false;

        const firstCommit = withContextDrafts(registry, "/sessions/target.jsonl", [firstDraft.draftId], async () => {
            entered.resolve();
            await release.promise;
            return "committed";
        });
        await entered.promise;

        await expect(
            withContextDrafts(
                registry,
                "/sessions/target.jsonl",
                [secondDraft.draftId, firstDraft.draftId],
                async () => {
                    competingCallbackRan = true;
                }
            )
        ).rejects.toMatchObject({ code: "invalid_input", draftIds: [firstDraft.draftId] });
        expect(competingCallbackRan).toBe(false);
        expect(registry.beginSummary("/sessions/target.jsonl", secondDraft.draftId).summaryStatus).toBe("summarizing");
        registry.failSummary("/sessions/target.jsonl", secondDraft.draftId);

        release.resolve();
        await expect(firstCommit).resolves.toBe("committed");
    });

    it("does not refresh unreserved drafts when a batch reservation fails", async () => {
        const { registry, advance } = makeRegistry();
        const reserved = registry.create("/sessions/target.jsonl", makeDraft("reserved"));
        const unreserved = registry.create("/sessions/target.jsonl", makeDraft("unreserved"));
        const entered = deferred<void>();
        const release = deferred<void>();

        const firstCommit = withContextDrafts(registry, "/sessions/target.jsonl", [reserved.draftId], async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        advance(900);

        await expect(
            withContextDrafts(
                registry,
                "/sessions/target.jsonl",
                [unreserved.draftId, reserved.draftId],
                async () => undefined
            )
        ).rejects.toMatchObject({ code: "invalid_input" });
        release.resolve();
        await firstCommit;
        advance(100);

        expect(registry.sweepExpired()).toBe(1);
    });

    it("releases every reservation and refreshes drafts after commit failure", async () => {
        const { registry, advance } = makeRegistry();
        const first = registry.create("/sessions/target.jsonl", makeDraft("first"));
        const second = registry.create("/sessions/target.jsonl", makeDraft("second"));
        const entered = deferred<void>();
        const release = deferred<void>();
        const failure = new Error("append failed");

        const failedCommit = withContextDrafts(
            registry,
            "/sessions/target.jsonl",
            [first.draftId, second.draftId],
            async () => {
                entered.resolve();
                await release.promise;
                throw failure;
            }
        );
        await entered.promise;
        advance(5_000);
        release.resolve();
        await expect(failedCommit).rejects.toBe(failure);

        await expect(
            withContextDrafts(
                registry,
                "/sessions/target.jsonl",
                [first.draftId, second.draftId],
                async () => "retried"
            )
        ).resolves.toBe("retried");
    });

    it("blocks draft mutations while a durable commit is in flight but allows reads", async () => {
        const { registry } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));
        const entered = deferred<void>();
        const release = deferred<void>();

        const commit = withContextDrafts(registry, "/sessions/target.jsonl", [created.draftId], async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;

        expect(registry.peek("/sessions/target.jsonl", created.draftId)).toBeDefined();
        expect(registry.readMany("/sessions/target.jsonl", [created.draftId])).toEqual([makeDraft("source")]);
        expect(() => registry.beginSummary("/sessions/target.jsonl", created.draftId)).toThrowError(
            ContextDraftRegistryError
        );
        expect(() => registry.consumeMany("/sessions/target.jsonl", [created.draftId])).toThrowError(
            ContextDraftRegistryError
        );
        expect(() => registry.discard("/sessions/target.jsonl", created.draftId)).toThrowError(
            ContextDraftRegistryError
        );
        expect(() => registry.clearTarget("/sessions/target.jsonl")).toThrowError(ContextDraftRegistryError);

        release.resolve();
        await commit;
    });

    it("rejects summarizing drafts before the durable callback runs", async () => {
        const { registry } = makeRegistry();
        const draft = makeDraft("source");
        draft.artifact.summary = makeSummary("prior");
        const created = registry.create("/sessions/target.jsonl", draft);
        let callbackRan = false;

        registry.beginSummary("/sessions/target.jsonl", created.draftId);
        await expect(
            withContextDrafts(registry, "/sessions/target.jsonl", [created.draftId], async () => {
                callbackRan = true;
            })
        ).rejects.toMatchObject({ code: "invalid_input", draftIds: [created.draftId] });
        expect(callbackRan).toBe(false);

        expect(registry.failSummary("/sessions/target.jsonl", created.draftId).summaryStatus).toBe("ready");
        await expect(
            withContextDrafts(registry, "/sessions/target.jsonl", [created.draftId], async () => "committed")
        ).resolves.toBe("committed");
    });

    it("supports explicit discard and clearing one target session", () => {
        const { registry } = makeRegistry();
        const discarded = registry.create("/sessions/target-a.jsonl", makeDraft("discarded"));
        const cleared = registry.create("/sessions/target-a.jsonl", makeDraft("cleared"));
        const retained = registry.create("/sessions/target-b.jsonl", makeDraft("retained"));

        expect(registry.discard("/sessions/target-a.jsonl", discarded.draftId)).toBe(true);
        expect(registry.discard("/sessions/target-a.jsonl", discarded.draftId)).toBe(false);
        expect(registry.clearTarget("/sessions/target-a.jsonl")).toBe(1);

        expect(registry.peek("/sessions/target-a.jsonl", cleared.draftId)).toBeUndefined();
        expect(registry.peek("/sessions/target-b.jsonl", retained.draftId)).toBeDefined();
    });

    it("refreshes the TTL on valid access", () => {
        const { registry, advance } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));

        advance(900);
        expect(registry.peek("/sessions/target.jsonl", created.draftId)?.expiresAt).toBe(new Date(1_900).toISOString());
        advance(900);
        expect(registry.peek("/sessions/target.jsonl", created.draftId)).toBeDefined();
        advance(1_000);
        expect(registry.peek("/sessions/target.jsonl", created.draftId)).toBeUndefined();
    });

    it("defaults the inactivity TTL to 30 minutes", () => {
        let now = 0;
        const registry = new ContextDraftRegistry({
            now: () => now,
            idFactory: () => "draft-default-ttl",
        });
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));

        expect(created.expiresAt).toBe(new Date(30 * 60 * 1_000).toISOString());
        now = 30 * 60 * 1_000;
        expect(registry.peek("/sessions/target.jsonl", created.draftId)).toBeUndefined();
    });

    it("sweeps expired renderer-orphan drafts and empty targets", () => {
        const { registry, advance } = makeRegistry();
        registry.create("/sessions/target-a.jsonl", makeDraft("first"));
        registry.create("/sessions/target-a.jsonl", makeDraft("second"));
        registry.create("/sessions/target-b.jsonl", makeDraft("third"));

        advance(1_000);

        expect(registry.sweepExpired()).toBe(3);
        expect(registry.clearTarget("/sessions/target-a.jsonl")).toBe(0);
        expect(registry.clearTarget("/sessions/target-b.jsonl")).toBe(0);
    });

    it("keeps an expired draft alive while an explicit summary is in flight", () => {
        const { registry, advance } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));

        registry.beginSummary("/sessions/target.jsonl", created.draftId);
        advance(5_000);

        expect(registry.sweepExpired()).toBe(0);
        expect(registry.completeSummary("/sessions/target.jsonl", created.draftId, makeSummary("done"))).toMatchObject({
            summaryStatus: "ready",
        });
        expect(registry.readMany("/sessions/target.jsonl", [created.draftId])[0]!.artifact.summary).toEqual(
            makeSummary("done")
        );
    });

    it("does not sweep a reserved draft while its commit is in flight", async () => {
        const { registry, advance } = makeRegistry();
        const created = registry.create("/sessions/target.jsonl", makeDraft("source"));
        const entered = deferred<void>();
        const release = deferred<void>();

        const commit = withContextDrafts(registry, "/sessions/target.jsonl", [created.draftId], async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        advance(2_000);

        expect(registry.sweepExpired()).toBe(0);
        expect(registry.readMany("/sessions/target.jsonl", [created.draftId])).toHaveLength(1);

        release.resolve();
        await commit;
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid TTL values: %s", (ttlMs) => {
        expect(() => new ContextDraftRegistry({ ttlMs })).toThrowError(ContextDraftRegistryError);
    });
});
