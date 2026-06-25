import type { RightEditorLspStatus } from "../right-editor-types";

export type RightEditorLanguageServerDefinition = {
    serverId: string;
    displayName: string;
    languages: string[];
    installHint?: string;
};

export type RightEditorBasicEditingStatus = RightEditorLspStatus & {
    serverId: string | null;
    displayName: string;
};

export type RightEditorLspSupport =
    | {
          supported: true;
          server: RightEditorLanguageServerDefinition;
      }
    | {
          supported: false;
          status: RightEditorBasicEditingStatus;
      };

export const rightEditorLanguageServers: RightEditorLanguageServerDefinition[] = [
    {
        serverId: "typescript-language-server",
        displayName: "TypeScript/JavaScript",
        languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    },
    {
        serverId: "gopls",
        displayName: "Go",
        languages: ["go"],
        installHint: "Install gopls: go install golang.org/x/tools/gopls@latest",
    },
];

const languageServerById = new Map(rightEditorLanguageServers.map((server) => [server.serverId, server]));
const languageServerByLanguage = new Map<string, RightEditorLanguageServerDefinition>();

for (const server of rightEditorLanguageServers) {
    for (const language of server.languages) {
        languageServerByLanguage.set(language, server);
    }
}

export function getRightEditorLanguageServer(language: string): RightEditorLanguageServerDefinition | undefined {
    return languageServerByLanguage.get(language);
}

export function getRightEditorLanguageServerById(serverId: string): RightEditorLanguageServerDefinition | undefined {
    return languageServerById.get(serverId);
}

export function isRightEditorLspSupported(language: string, workspaceRoot: string): boolean {
    return Boolean(workspaceRoot && getRightEditorLanguageServer(language));
}

function displayNameForLanguage(language: string): string {
    if (!language) return "Plain Text";
    if (language === "json") return "JSON";
    return language.charAt(0).toUpperCase() + language.slice(1);
}

export function getRightEditorLspSupport(language: string, workspaceRoot: string): RightEditorLspSupport {
    const server = getRightEditorLanguageServer(language);
    if (workspaceRoot && server) {
        return { supported: true, server };
    }
    return {
        supported: false,
        status: {
            language,
            workspaceRoot,
            serverId: null,
            displayName: displayNameForLanguage(language),
            state: "stopped",
            message: "Basic editing",
        },
    };
}
