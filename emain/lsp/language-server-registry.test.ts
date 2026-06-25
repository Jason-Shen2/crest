// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    getLanguageServerDefinition,
    getLanguageServerDefinitionById,
    getLanguageServerDefinitionForLanguage,
} from "./language-server-registry";

describe("language server registry", () => {
    it("maps JS and TS language ids to the TypeScript language server", () => {
        for (const language of ["typescript", "typescriptreact", "javascript", "javascriptreact"]) {
            expect(getLanguageServerDefinitionForLanguage(language)).toEqual(
                expect.objectContaining({
                    serverId: "typescript-language-server",
                    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
                })
            );
        }
    });

    it("maps Go to gopls with an availability check", () => {
        expect(getLanguageServerDefinitionForLanguage("go")).toEqual(
            expect.objectContaining({
                serverId: "gopls",
                command: "gopls",
                args: [],
                availabilityCheck: {
                    command: "gopls",
                    args: ["version"],
                    unavailableMessage: "Install gopls: go install golang.org/x/tools/gopls@latest",
                },
            })
        );
    });

    it("looks up language servers by server id", () => {
        expect(getLanguageServerDefinitionById("typescript-language-server")).toEqual(
            expect.objectContaining({
                command: "typescript-language-server",
                args: ["--stdio"],
            })
        );
        expect(getLanguageServerDefinitionById("missing")).toBeUndefined();
    });

    it("rejects a server id that does not support the requested language", () => {
        expect(() => getLanguageServerDefinition("typescript-language-server", "go")).toThrow(
            "Language go is not supported by language server typescript-language-server"
        );
    });
});
