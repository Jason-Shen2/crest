"use client";

import { parsePatchFiles } from "@pierre/diffs";
import type { ToolCallMessagePartComponent, ToolCallMessagePartProps } from "@assistant-ui/react";

import { Code } from "@/app/element/streamdown";
import { DiffViewer } from "../diff-viewer";
import { FileCard } from "../file-card";
import { ToolFallback } from "./tool-fallback";

function record(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    return value as Record<string, unknown>;
}

function completed(props: ToolCallMessagePartProps): boolean {
    return props.status?.type === "complete" && !props.isError;
}

function editData(props: ToolCallMessagePartProps): { path: string; patch: string } | undefined {
    if (!completed(props)) return;

    const result = record(props.result);
    const details = record(result?.details);
    const operation = record(details?.changeOperation);
    const args = record(props.args);
    const path =
        (typeof operation?.path === "string" && operation.path) ||
        (typeof args?.path === "string" && args.path) ||
        "";
    const patch = typeof details?.patch === "string" ? details.patch : "";
    if (!path || !patch) return;

    try {
        if (parsePatchFiles(patch).flatMap((item) => item.files).length === 0) return;
    } catch {
        return;
    }
    return { path, patch };
}

function writeData(props: ToolCallMessagePartProps): { path: string; content: string } | undefined {
    if (!completed(props)) return;

    const args = record(props.args);
    if (typeof args?.path !== "string" || typeof args.content !== "string") return;
    return { path: args.path, content: args.content };
}

export const EditToolCard: ToolCallMessagePartComponent = (props) => {
    const data = editData(props);
    if (!data) return <ToolFallback {...props} />;
    return <DiffViewer patch={data.patch} viewMode="unified" size="sm" />;
};

export const WriteToolCard: ToolCallMessagePartComponent = (props) => {
    const data = writeData(props);
    if (!data) return <ToolFallback {...props} />;

    const extension = data.path.split(".").pop()?.toLowerCase() || "text";
    return (
        <div data-slot="write-file-card" className="my-3 min-w-0">
            <FileCard filename={data.path} size="sm">
                <pre className="m-0 max-h-[32rem] overflow-auto p-4 text-xs leading-6">
                    <Code className={`language-${extension}`}>{data.content}</Code>
                </pre>
            </FileCard>
        </div>
    );
};
