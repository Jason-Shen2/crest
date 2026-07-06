// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as monaco from "monaco-editor";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import { initialize as initializeMonacoVscodeApi } from "@codingame/monaco-vscode-api/services";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import { configureMonacoYaml } from "monaco-yaml";

import { MonacoSchemas } from "@/app/monaco/schemaendpoints";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import ymlWorker from "./yamlworker?worker";

let monacoConfigured = false;
let monacoVscodeServicesPromise: Promise<void> = null;

window.MonacoEnvironment = {
    getWorker(_, label) {
        if (label === "json") {
            return new jsonWorker();
        }
        if (label === "css" || label === "scss" || label === "less") {
            return new cssWorker();
        }
        if (label === "yaml" || label === "yml") {
            return new ymlWorker();
        }
        if (label === "html" || label === "handlebars" || label === "razor") {
            return new htmlWorker();
        }
        if (
            label === "typescript" ||
            label === "typescriptreact" ||
            label === "javascript" ||
            label === "javascriptreact"
        ) {
            return new tsWorker();
        }
        return new editorWorker();
    },
};

export function ensureMonacoVscodeServices(): Promise<void> {
    if (!monacoVscodeServicesPromise) {
        monacoVscodeServicesPromise = initializeMonacoVscodeApi({
            ...getLanguagesServiceOverride(),
            ...getLogServiceOverride(),
            ...getModelServiceOverride(),
            ...getConfigurationServiceOverride(),
        });
    }
    return monacoVscodeServicesPromise;
}

function hasBrowserViewportDimensions() {
    if (window.innerWidth > 0 && window.innerHeight > 0) {
        return true;
    }
    if (document.body?.clientWidth > 0 && document.body.clientHeight > 0) {
        return true;
    }
    return document.documentElement?.clientWidth > 0 && document.documentElement.clientHeight > 0;
}

export function loadMonaco() {
    if (monacoConfigured) {
        if (hasBrowserViewportDimensions()) {
            void ensureMonacoVscodeServices();
        }
        return;
    }
    monacoConfigured = true;
    if (hasBrowserViewportDimensions()) {
        void ensureMonacoVscodeServices();
    }
    monaco.editor.defineTheme("wave-theme-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
            "editor.background": "#00000000",
            "editorStickyScroll.background": "#00000055",
            "minimap.background": "#00000077",
            focusBorder: "#00000000",
        },
    });
    monaco.editor.defineTheme("wave-theme-light", {
        base: "vs",
        inherit: true,
        rules: [],
        colors: {
            "editor.background": "#fefefe",
            focusBorder: "#00000000",
        },
    });
    configureMonacoYaml(monaco, {
        validate: true,
        schemas: [],
    });
    monaco.editor.setTheme("wave-theme-dark");
    // Disable default validation errors for typescript and javascript
    monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
    });
    monaco.json.jsonDefaults.setDiagnosticsOptions({
        validate: true,
        allowComments: false,
        enableSchemaRequest: true,
        schemas: MonacoSchemas,
    });
}
