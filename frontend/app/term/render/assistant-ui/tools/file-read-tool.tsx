// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";

import {
    ToolDetailSection,
    ToolDisclosure,
    fileNameFromPath,
    getToolStatus,
    objectString,
    renderToolValuePreview,
    resultOrStatusError,
    resultText,
} from "./tool-ui-shared";

export const FileReadToolNames = ["read", "read_file", "read_text_file", "functions.read_file", "functions.read_text_file"];

export const FileReadTool = memo((props: ToolCallMessagePartProps) => {
    const { toolCallId, args, argsText, result, status: partStatus } = props;
    const path = objectString(args, ["path", "file", "file_path", "filepath"]);
    const status = getToolStatus(props);
    const title = path ? `Read ${fileNameFromPath(path)}` : "Read file";
    const summary = path || "Reading file contents";

    return (
        <ToolDisclosure
            toolCallId={toolCallId}
            kind="file-read"
            status={status}
            title={title}
            summary={summary}
            renderDetails={() => {
                const output = resultText(result) || renderToolValuePreview(resultOrStatusError(result, partStatus));
                return (
                    <>
                        <ToolDetailSection label="Arguments" name="args">
                            {argsText || renderToolValuePreview(args)}
                        </ToolDetailSection>
                        <ToolDetailSection label={status === "error" ? "Error" : "Content"} name="result" tone={status === "error" ? "error" : undefined}>
                            {output}
                        </ToolDetailSection>
                    </>
                );
            }}
        />
    );
});
FileReadTool.displayName = "FileReadTool";
