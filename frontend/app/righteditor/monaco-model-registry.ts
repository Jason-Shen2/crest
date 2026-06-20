// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { loadMonaco } from "@/app/monaco/monaco-env";
import * as monaco from "monaco-editor";

type ModelInput = {
    path: string;
    uri: string;
    text: string;
    language: string;
};

export class MonacoModelRegistry {
    private static instance: MonacoModelRegistry = null;
    private readonly modelUrisByPath = new Map<string, string>();

    static getInstance(): MonacoModelRegistry {
        if (!MonacoModelRegistry.instance) {
            MonacoModelRegistry.instance = new MonacoModelRegistry();
        }
        return MonacoModelRegistry.instance;
    }

    getOrCreateModel(input: ModelInput): monaco.editor.ITextModel {
        loadMonaco();
        const uri = monaco.Uri.parse(input.uri);
        const existing = monaco.editor.getModel(uri);
        this.modelUrisByPath.set(input.path, input.uri);
        if (existing) return existing;
        return monaco.editor.createModel(input.text, input.language, uri);
    }

    setLanguage(uriText: string, language: string): void {
        const model = monaco.editor.getModel(monaco.Uri.parse(uriText));
        if (!model) return;
        monaco.editor.setModelLanguage(model, language);
    }

    getModelByPath(path: string): monaco.editor.ITextModel {
        const uriText = this.modelUrisByPath.get(path);
        if (!uriText) return null;
        return monaco.editor.getModel(monaco.Uri.parse(uriText));
    }

    disposePath(path: string): void {
        const model = this.getModelByPath(path);
        this.modelUrisByPath.delete(path);
        model?.dispose();
    }

    disposeAll(): void {
        for (const path of Array.from(this.modelUrisByPath.keys())) {
            this.disposePath(path);
        }
    }
}
