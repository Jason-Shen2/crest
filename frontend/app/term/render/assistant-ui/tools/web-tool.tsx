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

export const WebToolNames = [
    "fetch",
    "web_fetch",
    "web_search",
    "search_web",
    "functions.fetch",
    "functions.web_fetch",
    "functions.web_search",
    "functions.search_web",
];

export const WebTool = memo((props: ToolCallMessagePartProps) => {
    const { toolCallId, args, argsText, result, status: partStatus } = props;
    const target = objectString(args, ["url", "query", "q"]);
    const status = getToolStatus(props);

    return (
        <ToolDisclosure
            toolCallId={toolCallId}
            kind="web"
            status={status}
            title={target ? "Fetch web" : "Use web"}
            summary={target || "Gathering web context"}
            renderDetails={() => {
                const output = resultText(result) || renderToolValuePreview(resultOrStatusError(result, partStatus));
                return (
                    <>
                        <ToolDetailSection label="Request" name="args">
                            {argsText || renderToolValuePreview(args)}
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
WebTool.displayName = "WebTool";
