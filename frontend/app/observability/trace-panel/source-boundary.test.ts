// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const TracePanelRoot = join(process.cwd(), "frontend/app/observability/trace-panel");
const ForbiddenPathSegments = ["langfuse"];
const ForbiddenProductionContent = [
    "@/src",
    "langfusetrace",
    "langfuseobservation",
    "adapter",
    "shim",
    "usequeryparam",
    "posthog",
    "comment",
    "dataset",
    "annotation",
];

function listPaths(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory() ? [path, ...listPaths(path)] : [path];
    });
}

function isProductionSource(path: string): boolean {
    return /\.(?:ts|tsx)$/i.test(path) && !/\.test(?:-d)?\.(?:ts|tsx)$/i.test(path);
}

function findForbiddenTerms(source: string): string[] {
    const normalizedSource = source.toLocaleLowerCase("en-US");
    return ForbiddenProductionContent.filter((term) => normalizedSource.includes(term));
}

describe("Trace Panel source boundary", () => {
    it("does not contain a Langfuse source island path", () => {
        const forbiddenPaths = listPaths(TracePanelRoot)
            .map((path) => relative(TracePanelRoot, path))
            .filter((path) => {
                const segments = path.split(sep).map((segment) => segment.toLocaleLowerCase("en-US"));
                return ForbiddenPathSegments.some((segment) => segments.includes(segment));
            });

        expect(forbiddenPaths).toEqual([]);
    });

    it("does not contain forbidden production content", () => {
        const violations = listPaths(TracePanelRoot)
            .filter(isProductionSource)
            .flatMap((path) =>
                findForbiddenTerms(readFileSync(path, "utf8")).map(
                    (term) => `${relative(TracePanelRoot, path)}: ${term}`
                )
            );

        expect(violations).toEqual([]);
    });

    it("matches forbidden content case-insensitively", () => {
        expect(findForbiddenTerms("PoStHoG and CoMmEnT")).toEqual(["posthog", "comment"]);
    });

    it("scans only production TypeScript sources", () => {
        expect(isProductionSource("span-content.tsx")).toBe(true);
        expect(isProductionSource("source-boundary.TEST.TS")).toBe(false);
        expect(isProductionSource("io-preview.TEST-D.TS")).toBe(false);
    });
});
