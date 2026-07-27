// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Markdown } from "@/app/element/markdown";
import { CSVView } from "@/app/view/preview/csvview";
import { StreamingPreviewContent } from "@/app/view/preview/preview-streaming";
import { useRef } from "react";
import type { WorkspacePreviewResult } from "./preview-repository";

export function PreviewContent({
    result,
    onOpenFile,
    onOpenPath,
}: {
    result: WorkspacePreviewResult;
    onOpenFile(path: string): void;
    onOpenPath?(entry: FileInfo): void;
}) {
    const csvParentRef = useRef<HTMLDivElement>(null);
    switch (result.kind) {
        case "markdown":
            return <Markdown text={result.content} />;
        case "text":
            return <pre className="h-full overflow-auto whitespace-pre-wrap p-3">{result.content}</pre>;
        case "csv":
            return (
                <div className="h-full overflow-auto" ref={csvParentRef}>
                    <CSVView parentRef={csvParentRef} content={result.content} filename={result.path} readonly={true} />
                </div>
            );
        case "directory":
            return (
                <ul aria-label="Directory entries" className="h-full overflow-auto p-2">
                    {result.entries.map((entry) => (
                        <li key={entry.path || entry.name} className="px-2 py-1">
                            <button
                                className="w-full cursor-pointer text-left"
                                type="button"
                                onClick={() => onOpenPath?.(entry)}
                            >
                                {entry.name || entry.path}
                            </button>
                        </li>
                    ))}
                    {result.truncated ? <li className="px-2 py-1 text-secondary">More entries not shown</li> : null}
                </ul>
            );
        case "stream":
            return <StreamingPreviewContent url={result.url} mimeType={result.mimeType} />;
        case "file-only":
            return (
                <div className="flex h-full flex-col items-center justify-center gap-3">
                    <p>
                        {result.reason === "too-large"
                            ? "This file is too large to preview inline."
                            : "This file type cannot be previewed."}
                    </p>
                    <button
                        className="cursor-pointer rounded bg-accent/80 px-3 py-1 text-primary transition-colors hover:bg-accent"
                        type="button"
                        onClick={() => onOpenFile(result.path)}
                    >
                        Open as File
                    </button>
                </div>
            );
    }
}
