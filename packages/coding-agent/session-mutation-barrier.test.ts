// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { SessionMutationBarrier } from "./session-mutation-barrier";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("SessionMutationBarrier", () => {
    test("runs operations in FIFO order and reports busy until the queue drains", async () => {
        const barrier = new SessionMutationBarrier();
        const release = deferred();
        const calls: string[] = [];
        const first = barrier.run(async () => {
            calls.push("first");
            await release.promise;
        });
        const second = barrier.run(async () => {
            calls.push("second");
        });

        expect(barrier.isBusy()).toBe(true);
        expect(calls).toEqual(["first"]);
        release.resolve();
        await Promise.all([first, second]);
        await barrier.waitForIdle();
        expect(calls).toEqual(["first", "second"]);
        expect(barrier.isBusy()).toBe(false);
    });

    test("does not serialize independent barriers", async () => {
        const first = new SessionMutationBarrier();
        const second = new SessionMutationBarrier();
        const release = deferred();
        const calls: string[] = [];
        const blocked = first.run(() => release.promise);
        const parallel = second.run(async () => {
            calls.push("parallel");
        });

        await parallel;
        expect(calls).toEqual(["parallel"]);
        release.resolve();
        await blocked;
    });
});
