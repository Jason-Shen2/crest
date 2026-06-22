// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const BasenameLanguageMap: Record<string, string> = {
    ".bashrc": "shell",
    ".bash_profile": "shell",
    ".bash_login": "shell",
    ".bash_logout": "shell",
    ".profile": "shell",
    ".zshrc": "shell",
    ".zprofile": "shell",
    ".zshenv": "shell",
    ".zlogin": "shell",
    ".zlogout": "shell",
};

const ExtensionLanguageMap: Record<string, string> = {
    css: "css",
    go: "go",
    html: "html",
    js: "javascript",
    jsx: "javascriptreact",
    json: "json",
    less: "less",
    md: "markdown",
    py: "python",
    rs: "rust",
    scss: "scss",
    sh: "shell",
    ts: "typescript",
    tsx: "typescriptreact",
    yaml: "yaml",
    yml: "yaml",
};

function basename(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx >= 0 ? path.slice(idx + 1) : path;
}

export function getRightEditorLanguage(path: string): string {
    const name = basename(path);
    const basenameLanguage = BasenameLanguageMap[name];
    if (basenameLanguage) return basenameLanguage;
    const dotIdx = name.lastIndexOf(".");
    if (dotIdx < 0) return "plaintext";
    return ExtensionLanguageMap[name.slice(dotIdx + 1).toLowerCase()] ?? "plaintext";
}
