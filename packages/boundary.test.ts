import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const PackagesRoot = path.dirname(fileURLToPath(import.meta.url));
const ForbiddenSpecifier = /^(electron(?:\/|$)|@\/|.*(?:^|\/)emain(?:\/|-|$)|.*(?:^|\/)frontend(?:\/|$))/;
const VitestMockFunctions = new Set(["mock", "doMock", "unmock"]);

function collectTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") {
            continue;
        }

        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectTsFiles(full, out);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
            out.push(full);
        }
    }
    return out;
}

function extractImportSpecifiers(src: string): string[] {
    const sourceFile = ts.createSourceFile("boundary.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const specifiers: string[] = [];

    function pushStringLiteral(node: ts.Node | undefined): void {
        if (node == null) {
            return;
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            specifiers.push(node.text);
        }
    }

    function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node)) {
            pushStringLiteral(node.moduleSpecifier);
        } else if (ts.isExportDeclaration(node)) {
            pushStringLiteral(node.moduleSpecifier);
        } else if (ts.isCallExpression(node)) {
            const expression = node.expression;
            if (expression.kind === ts.SyntaxKind.ImportKeyword) {
                pushStringLiteral(node.arguments[0]);
            } else if (ts.isIdentifier(expression) && expression.text === "require") {
                pushStringLiteral(node.arguments[0]);
            } else if (
                ts.isPropertyAccessExpression(expression) &&
                ts.isIdentifier(expression.expression) &&
                expression.expression.text === "vi" &&
                VitestMockFunctions.has(expression.name.text)
            ) {
                pushStringLiteral(node.arguments[0]);
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return specifiers;
}

describe("package boundary", () => {
    it("extracts specifiers from import-like module references", () => {
        const src = `
            import "electron";
            import { foo } from "@/foo";
            await import("../emain/foo");
            const bar = require("../frontend/bar");
            vi.mock("electron/main");
        `;

        expect(extractImportSpecifiers(src)).toEqual([
            "electron",
            "@/foo",
            "../emain/foo",
            "../frontend/bar",
            "electron/main",
        ]);
    });

    it("packages never import electron, emain, or frontend", () => {
        const offenders: string[] = [];
        for (const file of collectTsFiles(PackagesRoot)) {
            const src = readFileSync(file, "utf8");
            for (const specifier of extractImportSpecifiers(src)) {
                if (ForbiddenSpecifier.test(specifier)) {
                    offenders.push(`${path.relative(PackagesRoot, file)} -> ${specifier}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
