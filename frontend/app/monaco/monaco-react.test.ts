// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { replaceEditorModel } from "./monaco-react";

vi.mock("@/app/monaco/monaco-env", () => ({
    loadMonaco: vi.fn(),
}));

vi.mock("monaco-editor", () => ({
    Uri: {
        parse: (uri: string) => ({ toString: () => uri }),
    },
    editor: {
        createModel: vi.fn(),
        create: vi.fn(),
        createDiffEditor: vi.fn(),
        setModelLanguage: vi.fn(),
    },
}));

function makeModel(value: string) {
    const listeners: Array<() => void> = [];
    const contentSub = { dispose: vi.fn() };
    return {
        value,
        disposed: false,
        listeners,
        contentSub,
        getValue: () => value,
        onDidChangeContent: vi.fn((listener: () => void) => {
            listeners.push(listener);
            return contentSub;
        }),
        dispose: vi.fn(function (this: { disposed: boolean }) {
            this.disposed = true;
        }),
    };
}

describe("replaceEditorModel", () => {
    it("switches external models without disposing them and resubscribes to changes", () => {
        const firstModel = makeModel("first");
        const secondModel = makeModel("second");
        const editor = { setModel: vi.fn() };
        const onChange = vi.fn();

        const binding = replaceEditorModel({
            editor: editor as any,
            current: {
                model: firstModel as any,
                ownsModel: false,
                contentSub: firstModel.contentSub as any,
            },
            nextModel: secondModel as any,
            ownsNextModel: false,
            onChange,
            applyingFromProps: { current: false },
        });

        expect(editor.setModel).toHaveBeenCalledWith(secondModel);
        expect(firstModel.contentSub.dispose).toHaveBeenCalledTimes(1);
        expect(firstModel.dispose).not.toHaveBeenCalled();
        expect(secondModel.onDidChangeContent).toHaveBeenCalledTimes(1);

        secondModel.listeners[0]();

        expect(onChange).toHaveBeenCalledWith("second");
        expect(binding.model).toBe(secondModel);
        expect(binding.ownsModel).toBe(false);
    });
});
