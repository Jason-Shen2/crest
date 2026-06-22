// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCodeEditor = vi.hoisted(() => ({
    monacoProps: [] as any[],
}));

vi.mock("@/app/monaco/monaco-react", () => ({
    MonacoCodeEditor: (props: any) => {
        mockCodeEditor.monacoProps.push(props);
        return <div>Monaco Code Editor</div>;
    },
}));

vi.mock("@/app/store/global", () => ({
    useOverrideConfigAtom: () => undefined,
}));

vi.mock("monaco-editor", () => ({}));

import { CodeEditor } from "./codeeditor";

describe("CodeEditor", () => {
    beforeEach(() => {
        mockCodeEditor.monacoProps = [];
    });

    it("passes an external Monaco model through to MonacoCodeEditor", () => {
        const externalModel = { id: "external-model" };

        renderToStaticMarkup(
            <CodeEditor
                blockId="right-editor"
                text="const x = 1;"
                readonly={false}
                language="typescript"
                fileName="/repo/src/app.ts"
                model={externalModel as any}
            />
        );

        expect(mockCodeEditor.monacoProps[0].model).toBe(externalModel);
    });
});
