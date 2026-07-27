// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { init, parse } from "es-module-lexer";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const FrontendRoot = path.resolve(__dirname, "../..");
const TerminalBootstrapPath = path.join(FrontendRoot, "app/terminal/terminal-bootstrap.ts");
const RendererEntryPath = path.join(FrontendRoot, "renderer-entry.ts");
const RendererAssetsPath = path.resolve(FrontendRoot, "../dist/frontend/assets");
const ForbiddenTerminalModules = [
    "/app/workspace/",
    "/app/topbar/",
    "/app/statusbar/",
    "/app/agent/",
    "/app/view/codeeditor/",
    "/app/view/webview/",
    "/app/view/preview/",
    "/app/gitdiff/",
    "/app/monaco/",
];

function staticImports(filePath: string): string[] {
    const source = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    for (const statement of sourceFile.statements) {
        const isRuntimeImport =
            ts.isImportDeclaration(statement) &&
            !statement.importClause?.isTypeOnly &&
            statement.moduleSpecifier != null;
        const isRuntimeExport =
            ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier != null;
        if (
            (isRuntimeImport || isRuntimeExport) &&
            statement.moduleSpecifier != null &&
            ts.isStringLiteral(statement.moduleSpecifier)
        ) {
            imports.push(statement.moduleSpecifier.text);
        }
    }
    return imports;
}

function resolveProjectImport(importer: string, specifier: string): string {
    if (specifier.startsWith("@/")) {
        return resolveSourceFile(path.join(FrontendRoot, specifier.slice(2)));
    }
    if (specifier.startsWith(".")) {
        return resolveSourceFile(path.resolve(path.dirname(importer), specifier));
    }
    return null;
}

function resolveSourceFile(candidate: string): string {
    for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const resolved = candidate + suffix;
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return resolved;
        }
    }
    return null;
}

function collectStaticClosure(entry: string): string[] {
    const visited = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
        const current = pending.pop();
        if (visited.has(current)) {
            continue;
        }
        visited.add(current);
        for (const specifier of staticImports(current)) {
            const resolved = resolveProjectImport(current, specifier);
            if (resolved != null) {
                pending.push(resolved);
            }
        }
    }
    return Array.from(visited);
}

async function collectBuiltStaticClosure(entry: string): Promise<string[]> {
    await init;
    const visited = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
        const current = pending.pop();
        if (visited.has(current)) {
            continue;
        }
        visited.add(current);
        const source = fs.readFileSync(path.join(RendererAssetsPath, current), "utf8");
        const [imports] = parse(source);
        for (const imported of imports) {
            if (imported.d !== -1) {
                continue;
            }
            const specifier = source.slice(imported.s, imported.e);
            if (specifier.startsWith(".")) {
                pending.push(path.basename(specifier));
            }
        }
    }
    return Array.from(visited);
}

describe("Terminal renderer import boundary", () => {
    it("keeps the renderer entry free of static application imports", () => {
        expect(fs.existsSync(RendererEntryPath)).toBe(true);
        expect(staticImports(RendererEntryPath)).toEqual([]);
        expect(fs.readFileSync(RendererEntryPath, "utf8")).toContain('import("./app/terminal/terminal-bootstrap")');
        expect(fs.readFileSync(RendererEntryPath, "utf8")).toContain('import("./app/legacy/builder-bootstrap")');
        expect(fs.readFileSync(RendererEntryPath, "utf8")).toContain('import("./wave")');
    });

    it("does not own Workspace key registration or a static layout model escape hatch", () => {
        const source = fs.readFileSync(TerminalBootstrapPath, "utf8");

        expect(source).not.toContain("registerGlobalKeys");
        expect(source).not.toContain("registerElectronReinjectKeyHandler");
        expect(source).not.toContain("registerControlShiftStateUpdateHandler");
        expect(source).not.toContain("getLayoutModelForStaticTab");
    });

    it("excludes non-Terminal application modules from the Terminal static dependency closure", () => {
        expect(fs.existsSync(TerminalBootstrapPath)).toBe(true);
        const closure = collectStaticClosure(TerminalBootstrapPath).map((filePath) =>
            filePath.slice(FrontendRoot.length).replaceAll(path.sep, "/")
        );

        for (const forbidden of ForbiddenTerminalModules) {
            expect(closure, `Terminal closure contains ${forbidden}`).not.toEqual(
                expect.arrayContaining([expect.stringContaining(forbidden)])
            );
        }
    });

    it.runIf(fs.existsSync(RendererAssetsPath))(
        "keeps Monaco and forbidden application sources out of the built Terminal chunk closure",
        async () => {
            const terminalEntry = fs
                .readdirSync(RendererAssetsPath)
                .find((fileName) => /^terminal-bootstrap-.*\.js$/.test(fileName));
            expect(terminalEntry).toBeTruthy();
            const closure = await collectBuiltStaticClosure(terminalEntry);
            expect(closure.some((fileName) => fileName.startsWith("monaco-"))).toBe(false);

            for (const fileName of closure) {
                const mapPath = path.join(RendererAssetsPath, `${fileName}.map`);
                if (!fs.existsSync(mapPath)) {
                    continue;
                }
                const sourceMap = JSON.parse(fs.readFileSync(mapPath, "utf8")) as { sources?: string[] };
                for (const forbidden of ForbiddenTerminalModules) {
                    expect(sourceMap.sources ?? [], `${fileName} contains ${forbidden}`).not.toEqual(
                        expect.arrayContaining([expect.stringContaining(forbidden)])
                    );
                }
            }
        }
    );
});
