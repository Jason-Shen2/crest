// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { memo } from "react";

import {
    ToolDetailSection,
    ToolDisclosure,
    getToolStatus,
    objectString,
    renderToolValuePreview,
    resultOrStatusError,
    resultText,
} from "./tool-ui-shared";

export const ShellToolNames = [
    "bash",
    "exec",
    "exec_command",
    "run_command",
    "shell_exec",
    "functions.exec",
    "functions.exec_command",
    "functions.run_command",
    "functions.shell_exec",
];

export const ShellTool = memo((props: ToolCallMessagePartProps) => {
    const { toolCallId, args, argsText, result, status: partStatus } = props;
    const command = objectString(args, ["command", "cmd"]);
    const status = getToolStatus(props);

    return (
        <ToolDisclosure
            toolCallId={toolCallId}
            kind="shell"
            status={status}
            title="Run command"
            summary={command || "Executing shell command"}
            renderDetails={() => {
                const output = resultText(result) || renderToolValuePreview(resultOrStatusError(result, partStatus));
                return (
                    <>
                        <ToolDetailSection label="Command" name="command">
                            {command || argsText || renderToolValuePreview(args)}
                        </ToolDetailSection>
                        <ToolDetailSection
                            label={status === "error" ? "Error" : "Output"}
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
ShellTool.displayName = "ShellTool";
