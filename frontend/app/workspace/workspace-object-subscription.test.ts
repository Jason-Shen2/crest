// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { WorkspaceObjectSubscription } from "./workspace-object-subscription";

describe("WorkspaceObjectSubscription", () => {
    it("unsubscribes the prior workspace on switch and the current workspace on teardown", () => {
        const owner = new WorkspaceObjectSubscription();
        const unsubscribeFirst = vi.fn();
        const unsubscribeSecond = vi.fn();

        owner.replace(unsubscribeFirst);
        owner.replace(unsubscribeSecond);

        expect(unsubscribeFirst).toHaveBeenCalledOnce();
        expect(unsubscribeSecond).not.toHaveBeenCalled();

        owner.clear();
        owner.clear();

        expect(unsubscribeFirst).toHaveBeenCalledOnce();
        expect(unsubscribeSecond).toHaveBeenCalledOnce();
    });
});
