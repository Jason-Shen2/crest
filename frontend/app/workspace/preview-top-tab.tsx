// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { PreviewContent } from "./preview-content";
import {
    normalizeWorkspacePreviewPath,
    type WorkspacePreviewRepository,
    type WorkspacePreviewResult,
} from "./preview-repository";
import type { WorkspaceTopTabController } from "./top-tab-controller";
import type { TopTab } from "./workspace-content-state";

type PreviewTab = Extract<TopTab, { kind: "preview" }>;

function resolveDirectoryEntryPath(parentPath: string, entry: FileInfo): string | undefined {
    const normalizedParent = normalizeWorkspacePreviewPath(parentPath);
    const childPart = entry.path || entry.name;
    if (!childPart) {
        return undefined;
    }
    const slashChild = childPart.replace(/\\/g, "/");
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(slashChild) && !/^[A-Za-z]:\//.test(slashChild)) {
        return undefined;
    }
    const absoluteChild =
        slashChild.startsWith("/") || /^[A-Za-z]:\//.test(slashChild)
            ? normalizeWorkspacePreviewPath(slashChild)
            : normalizeWorkspacePreviewPath(`${normalizedParent}/${slashChild}`);
    const caseInsensitive = /^[A-Za-z]:\//.test(normalizedParent) || normalizedParent.startsWith("//");
    const comparableParent = caseInsensitive ? normalizedParent.toLowerCase() : normalizedParent;
    const comparableChild = caseInsensitive ? absoluteChild.toLowerCase() : absoluteChild;
    if (!comparableChild.startsWith(`${comparableParent.replace(/\/$/, "")}/`)) {
        return undefined;
    }
    return absoluteChild;
}

export function PreviewTopTab({
    tab,
    repository,
    controller,
}: {
    tab: PreviewTab;
    repository: WorkspacePreviewRepository;
    controller: WorkspaceTopTabController;
}) {
    const [retryGeneration, setRetryGeneration] = useState(0);
    const [result, setResult] = useState<WorkspacePreviewResult>();
    const [error, setError] = useState("");
    const requestGeneration = useRef(0);

    useEffect(() => {
        const generation = ++requestGeneration.current;
        setResult(undefined);
        setError("");
        void repository.load(tab.path).then(
            (loaded) => {
                if (generation === requestGeneration.current) {
                    setResult(loaded);
                }
            },
            (loadError) => {
                if (generation === requestGeneration.current) {
                    setError(loadError instanceof Error ? loadError.message : String(loadError));
                }
            }
        );
        return () => {
            requestGeneration.current++;
        };
    }, [repository, retryGeneration, tab.path]);

    if (error) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3" role="alert">
                <p>{error}</p>
                <button
                    aria-label="Retry preview"
                    className="cursor-pointer rounded px-3 py-1"
                    type="button"
                    onClick={() => setRetryGeneration((generation) => generation + 1)}
                >
                    Retry
                </button>
            </div>
        );
    }
    if (!result) {
        return (
            <div className="flex h-full items-center justify-center" role="status">
                Loading preview…
            </div>
        );
    }
    return (
        <PreviewContent
            result={result}
            onOpenFile={(path) => controller.openFile(path)}
            onOpenPath={(entry) => {
                const path = resolveDirectoryEntryPath(result.path, entry);
                if (path) {
                    controller.openPreview(path);
                }
            }}
        />
    );
}
