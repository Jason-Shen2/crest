import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const config = require("./electron-builder.config.cjs");
const pkg = require("./package.json");

describe("electron-builder config", () => {
    it("keeps TLS packaging config in the actual builder config", () => {
        expect(pkg.build.asarUnpack).toBeUndefined();
        expect(config.files).toContainEqual({
            from: "node_modules/typescript-language-server",
            to: "node_modules/typescript-language-server",
            filter: ["lib/**/*", "package.json"],
        });
        expect(config.files).toContainEqual({
            from: "node_modules/typescript",
            to: "node_modules/typescript",
            filter: ["lib/**/*", "package.json"],
        });
        expect(config.asarUnpack).toContain("node_modules/typescript-language-server/**");
        expect(config.asarUnpack).toContain("node_modules/typescript/lib/**");
    });
});
