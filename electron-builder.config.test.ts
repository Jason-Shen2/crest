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
        expect(config.asarUnpack).toContain("node_modules/typescript/**");
    });

    it("packages third-party notices and license texts", () => {
        expect(config.files).toContainEqual({
            from: ".",
            to: ".",
            filter: [
                "NOTICE",
                "NOTICES.md",
                "frontend/app/observability/trace-panel/LICENSE.langfuse",
                "third_party/licenses/elkjs-EPL-2.0.md",
            ],
        });
    });

    it("external native node-pty files are packaged outside ASAR", () => {
        expect(config.files).toContainEqual({
            from: "node_modules/node-pty",
            to: "node_modules/node-pty",
            filter: expect.arrayContaining(["package.json", "build/Release/**/*", "lib/**/*", "prebuilds/**/*"]),
        });
        expect(config.asarUnpack).toContain("node_modules/node-pty/**");
    });
});
