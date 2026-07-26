// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FrontendRoot = path.resolve(__dirname, "../..");

function resolveFrontendImport(fromFile: string, specifier: string): string | undefined {
    let base: string;
    if (specifier.startsWith("@/")) {
        base = path.join(FrontendRoot, specifier.slice(2));
    } else if (specifier.startsWith(".")) {
        base = path.resolve(path.dirname(fromFile), specifier);
    } else {
        return undefined;
    }
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return undefined;
}

function dependencyGraph(entry: string): string[] {
    const visited = new Set<string>();
    const visit = (file: string) => {
        if (visited.has(file)) return;
        visited.add(file);
        const source = fs.readFileSync(file, "utf8");
        const imports = source.matchAll(
            /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
        );
        for (const match of imports) {
            const dependency = resolveFrontendImport(file, match[1] ?? match[2]);
            if (dependency) visit(dependency);
        }
    };
    visit(entry);
    return [...visited];
}

describe("Terminal Workspace command boundary", () => {
    it("keeps the complete client dependency graph free of content and Workspace UI modules", () => {
        const entry = path.resolve(__dirname, "../store/workspace-command-client.ts");
        const graph = dependencyGraph(entry);
        const relativeGraph = graph.map((file) => path.relative(FrontendRoot, file));

        expect(relativeGraph).not.toEqual(
            expect.arrayContaining([
                expect.stringMatching(/rightbrowser|monaco|preview|app\/workspace\//),
            ])
        );
        expect(fs.readFileSync(entry, "utf8")).toMatch(/getApi\(\)\.sendWorkspaceCommand/);
    });
});
