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
    private readonly modelPathsByUri = new Map<string, Set<string>>();

    static getInstance(): MonacoModelRegistry {
        if (!MonacoModelRegistry.instance) {
            MonacoModelRegistry.instance = new MonacoModelRegistry();
        }
        return MonacoModelRegistry.instance;
    }

    getOrCreateModel(input: ModelInput): monaco.editor.ITextModel {
        loadMonaco();
        const uri = monaco.Uri.parse(input.uri);
        const existingUri = this.modelUrisByPath.get(input.path);
        if (existingUri && existingUri !== input.uri) {
            this.releaseModelPath(input.path, existingUri);
        }
        const existing = monaco.editor.getModel(uri);
        this.modelUrisByPath.set(input.path, input.uri);
        this.getOrCreateModelPaths(input.uri).add(input.path);
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
        const uriText = this.modelUrisByPath.get(path);
        if (!uriText) return;
        const model = monaco.editor.getModel(monaco.Uri.parse(uriText));
        const shouldDispose = this.releaseModelPath(path, uriText);
        if (!shouldDispose) return;
        model?.dispose();
    }

    migratePath(oldPath: string, newPath: string): void {
        this.disposePath(oldPath);
        this.disposePath(newPath);
    }

    disposeAll(): void {
        for (const path of Array.from(this.modelUrisByPath.keys())) {
            this.disposePath(path);
        }
    }

    private getOrCreateModelPaths(uriText: string): Set<string> {
        let paths = this.modelPathsByUri.get(uriText);
        if (!paths) {
            paths = new Set();
            this.modelPathsByUri.set(uriText, paths);
        }
        return paths;
    }

    private releaseModelPath(path: string, uriText: string): boolean {
        this.modelUrisByPath.delete(path);
        const paths = this.modelPathsByUri.get(uriText);
        if (!paths) return true;
        paths.delete(path);
        if (paths.size > 0) return false;
        this.modelPathsByUri.delete(uriText);
        return true;
    }
}
