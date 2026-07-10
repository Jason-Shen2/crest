// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { memo } from "react";

import {
    ToolDetailSection,
    ToolDisclosure,
    fileNameFromPath,
    getToolStatus,
    objectString,
    renderToolTextPreview,
    renderToolValuePreview,
    resultOrStatusError,
    resultText,
} from "./tool-ui-shared";

export const FileWriteToolNames = [
    "write",
    "edit",
    "write_file",
    "edit_file",
    "write_text_file",
    "edit_text_file",
    "apply_patch",
    "functions.write_file",
    "functions.edit_file",
    "functions.edit_text_file",
    "functions.apply_patch",
];

export const FileWriteTool = memo((props: ToolCallMessagePartProps) => {
    const { toolCallId, args, argsText, result, status: partStatus } = props;
    const path = objectString(args, ["path", "file", "file_path", "filepath"]);
    const status = getToolStatus(props);
    const title = path ? `Edit ${fileNameFromPath(path)}` : "Modify file";
    const summary = path || "Updating project files";

    return (
        <ToolDisclosure
            toolCallId={toolCallId}
            kind="file-write"
            status={status}
            title={title}
            summary={summary}
            renderDetails={() => {
                const changePreview =
                    objectString(args, ["patch", "content", "oldText", "newText", "old_text", "new_text"]) ||
                    renderToolValuePreview(args);
                const output = resultText(result) || renderToolValuePreview(resultOrStatusError(result, partStatus));
                return (
                    <>
                        <ToolDetailSection label="Arguments" name="args">
                            {argsText || renderToolValuePreview(args)}
                        </ToolDetailSection>
                        <ToolDetailSection label="Change" name="change">
                            {renderToolTextPreview(changePreview)}
                        </ToolDetailSection>
                        <ToolDetailSection
                            label={status === "error" ? "Error" : "Result"}
                            name="result"
                            tone={status === "error" ? "error" : undefined}
                        >
                            {output}
                        </ToolDetailSection>
                    </>
                );
            }}
        />
    );
});
FileWriteTool.displayName = "FileWriteTool";
