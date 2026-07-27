// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const FrontendRoot = path.resolve(__dirname);
const StylesModulePath = path.join(FrontendRoot, "renderer-styles.ts");

function staticImports(filePath: string): string[] {
    const source = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    return sourceFile.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
            return [];
        }
        return [statement.moduleSpecifier.text];
    });
}

describe("renderer global styles", () => {
    it("loads the shared global stylesheet module for every renderer bootstrap", () => {
        expect(fs.existsSync(StylesModulePath)).toBe(true);
        if (!fs.existsSync(StylesModulePath)) {
            return;
        }

        expect(staticImports(StylesModulePath)).toEqual([
            "@xterm/xterm/css/xterm.css",
            "overlayscrollbars/overlayscrollbars.css",
            "./app/app.scss",
            "./tailwindsetup.css",
        ]);

        const rendererBootstraps = [
            [path.join(FrontendRoot, "wave.ts"), "./renderer-styles"],
            [path.join(FrontendRoot, "app/terminal/terminal-bootstrap.ts"), "../../renderer-styles"],
            [path.join(FrontendRoot, "app/legacy/builder-bootstrap.ts"), "../../renderer-styles"],
        ];
        for (const [bootstrapPath, stylesImport] of rendererBootstraps) {
            expect(staticImports(bootstrapPath), bootstrapPath).toContain(stylesImport);
        }

        const appImports = staticImports(path.join(FrontendRoot, "app/app.tsx"));
        for (const legacyStyleImport of [
            "overlayscrollbars/overlayscrollbars.css",
            "./app.scss",
            "../tailwindsetup.css",
        ]) {
            expect(appImports).not.toContain(legacyStyleImport);
        }
    });
});
