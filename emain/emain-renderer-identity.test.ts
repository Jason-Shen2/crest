// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const RendererIdentityModulePath = "./emain-renderer-identity";

describe("resolveWaveRendererKind", () => {
    it("uses authoritative Terminal membership instead of Tab structure", async () => {
        const { resolveWaveRendererKind } = await import(RendererIdentityModulePath);
        const validate = vi.fn(async () => true);

        await expect(resolveWaveRendererKind("workspace-1", "tab-1", validate)).resolves.toBe("terminal");
        expect(validate).toHaveBeenCalledWith("workspace-1", "tab-1");
    });

    it("fails closed for a non-Terminal Tab", async () => {
        const { resolveWaveRendererKind } = await import(RendererIdentityModulePath);

        await expect(resolveWaveRendererKind("workspace-1", "tab-1", async () => false)).rejects.toThrow(
            "tab-1 is not a Terminal Tab"
        );
    });

    it("does not fall back to Terminal when membership validation fails", async () => {
        const { resolveWaveRendererKind } = await import(RendererIdentityModulePath);

        await expect(
            resolveWaveRendererKind("workspace-1", "tab-1", async () => {
                throw new Error("membership unavailable");
            })
        ).rejects.toThrow("membership unavailable");
    });
});
