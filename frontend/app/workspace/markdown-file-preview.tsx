// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Markdown } from "@/app/element/markdown";
import { getParentLocalPath } from "@/util/local-path";
import { useMemo } from "react";

export interface MarkdownFilePreviewProps {
    path: string;
    text: string;
}

export function MarkdownFilePreview({ path, text }: MarkdownFilePreviewProps) {
    const resolveOpts = useMemo<MarkdownResolveOpts>(() => {
        return { connName: "local", baseDir: getParentLocalPath(path) };
    }, [path]);

    return (
        <div className="h-full min-h-0 overflow-hidden">
            <Markdown key={path} text={text} resolveOpts={resolveOpts} contentClassName="px-4 py-4 sm:px-6 sm:py-5" />
        </div>
    );
}
