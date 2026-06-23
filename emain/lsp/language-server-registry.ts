// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type LanguageServerAvailabilityCheck = {
    command: string;
    args: string[];
    unavailableMessage: string;
};

export type LanguageServerDefinition = {
    serverId: string;
    languages: string[];
    command: string;
    args: string[];
    availabilityCheck?: LanguageServerAvailabilityCheck;
};

export const languageServerDefinitions: LanguageServerDefinition[] = [
    {
        serverId: "typescript-language-server",
        languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
        command: "typescript-language-server",
        args: ["--stdio"],
    },
    {
        serverId: "gopls",
        languages: ["go"],
        command: "gopls",
        args: [],
        availabilityCheck: {
            command: "gopls",
            args: ["version"],
            unavailableMessage: "Install gopls: go install golang.org/x/tools/gopls@latest",
        },
    },
];

const languageServerById = new Map(languageServerDefinitions.map((server) => [server.serverId, server]));
const languageServerByLanguage = new Map<string, LanguageServerDefinition>();

for (const server of languageServerDefinitions) {
    for (const language of server.languages) {
        languageServerByLanguage.set(language, server);
    }
}

export function getLanguageServerDefinitionById(serverId: string): LanguageServerDefinition | undefined {
    return languageServerById.get(serverId);
}

export function getLanguageServerDefinitionForLanguage(language: string): LanguageServerDefinition | undefined {
    return languageServerByLanguage.get(language);
}
