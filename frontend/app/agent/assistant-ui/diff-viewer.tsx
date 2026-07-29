"use client";

import { parsePatchFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff, MultiFileDiff } from "@pierre/diffs/react";
import { diffLines } from "diff";
import { useMemo, type CSSProperties, type FC } from "react";

import { cn } from "@/util/util";
import { FileCard, type FileCardProps } from "./file-card";

const PierreUnsafeCss = `
:host {
    --diffs-bg: var(--color-code-bg);
}

[data-diff] {
    --diffs-bg-deletion-override: light-dark(
        color-mix(in lab, var(--diffs-bg) 33.333%, var(--diffs-deletion-base)),
        color-mix(in lab, var(--diffs-bg) 60%, var(--diffs-deletion-base))
    );
    --diffs-bg-addition-override: light-dark(
        color-mix(in lab, var(--diffs-bg) 33.333%, var(--diffs-addition-base)),
        color-mix(in lab, var(--diffs-bg) 60%, var(--diffs-addition-base))
    );
}

[data-diff-header],
[data-diff] {
    [data-separator] {
        height: 24px;
    }

    [data-column-number] {
        background-color: var(--diffs-bg);
        cursor: default !important;
    }

    &[data-interactive-line-numbers] [data-column-number] {
        cursor: default !important;
    }

    &[data-interactive-lines] [data-line] {
        cursor: auto !important;
    }

    [data-code] {
        overflow-x: auto !important;
        overflow-y: clip !important;
    }
}
`;

const PierreStyle = {
    "--diffs-font-family": "var(--font-mono)",
    "--diffs-font-size": "inherit",
    "--diffs-line-height": "24px",
    "--diffs-tab-size": 2,
    "--diffs-gap-block": 0,
    "--diffs-min-number-column-width": "4ch",
} as CSSProperties;

function makePierreOptions(
    viewMode: NonNullable<DiffViewerProps["viewMode"]>,
    showLineNumbers: boolean
): FileDiffOptions<undefined> {
    return {
        themeType: "system",
        disableLineNumbers: !showLineNumbers,
        overflow: "wrap",
        diffStyle: viewMode,
        diffIndicators: "bars",
        lineHoverHighlight: "both",
        disableBackground: false,
        expansionLineCount: 20,
        hunkSeparators: "line-info-basic",
        lineDiffType: viewMode === "split" ? "word-alt" : "none",
        maxLineDiffLength: 1000,
        tokenizeMaxLineLength: 1000,
        disableFileHeader: true,
        unsafeCSS: PierreUnsafeCss,
    };
}

function getPatchStats(fileDiff: FileDiffMetadata): { additions: number; deletions: number } {
    return fileDiff.hunks.reduce(
        (stats, hunk) => ({
            additions: stats.additions + hunk.additionLines,
            deletions: stats.deletions + hunk.deletionLines,
        }),
        { additions: 0, deletions: 0 }
    );
}

function getContentStats(oldContent: string, newContent: string): { additions: number; deletions: number } {
    return diffLines(oldContent, newContent).reduce(
        (stats, change) => ({
            additions: stats.additions + (change.added ? (change.count ?? 0) : 0),
            deletions: stats.deletions + (change.removed ? (change.count ?? 0) : 0),
        }),
        { additions: 0, deletions: 0 }
    );
}

export type DiffViewerProps = Pick<FileCardProps, "variant" | "size"> & {
    code?: string;
    language?: string;
    patch?: string;
    oldFile?: { content: string; name?: string };
    newFile?: { content: string; name?: string };
    viewMode?: "split" | "unified";
    showLineNumbers?: boolean;
    showIcon?: boolean;
    showStats?: boolean;
    className?: string;
    components?: Record<string, unknown>;
};

const DiffViewer: FC<DiffViewerProps> = ({
    code,
    language: _language,
    components: _components,
    patch,
    oldFile,
    newFile,
    viewMode = "unified",
    showLineNumbers = true,
    showIcon = true,
    showStats = true,
    variant,
    size,
    className,
}) => {
    const diffPatch = patch ?? code;
    const pierreOptions = useMemo(() => makePierreOptions(viewMode, showLineNumbers), [showLineNumbers, viewMode]);
    const parsedFiles = useMemo(() => {
        if (!diffPatch) return [];

        try {
            return parsePatchFiles(diffPatch).flatMap((parsedPatch) => parsedPatch.files);
        } catch {
            return [];
        }
    }, [diffPatch]);
    const contentStats = useMemo(() => {
        if (!oldFile || !newFile) return null;
        return getContentStats(oldFile.content, newFile.content);
    }, [newFile, oldFile]);

    if (parsedFiles.length === 0 && (!oldFile || !newFile)) {
        return (
            <pre data-slot="diff-viewer" className={cn("bg-muted rounded-lg p-4", className)}>
                No diff content provided
            </pre>
        );
    }

    if (parsedFiles.length > 0) {
        return (
            <div
                data-slot="diff-viewer"
                data-view-mode={viewMode}
                data-variant={variant ?? "default"}
                data-size={size ?? "default"}
                className={cn("my-3 flex min-w-0 flex-col gap-3", className)}
            >
                {parsedFiles.map((fileDiff, fileIndex) => {
                    const stats = getPatchStats(fileDiff);

                    return (
                        <FileCard
                            key={`${fileDiff.prevName ?? ""}:${fileDiff.name}:${fileIndex}`}
                            filename={fileDiff.name}
                            previousFilename={fileDiff.prevName}
                            additions={showStats ? stats.additions : undefined}
                            deletions={showStats ? stats.deletions : undefined}
                            showIcon={showIcon}
                            variant={variant}
                            size={size}
                        >
                            <FileDiff fileDiff={fileDiff} options={pierreOptions} style={PierreStyle} />
                        </FileCard>
                    );
                })}
            </div>
        );
    }

    const oldName = oldFile!.name ?? "old-file";
    const newName = newFile!.name ?? oldFile!.name ?? "new-file";

    return (
        <div
            data-slot="diff-viewer"
            data-view-mode={viewMode}
            data-variant={variant ?? "default"}
            data-size={size ?? "default"}
            className={cn("my-3 min-w-0", className)}
        >
            <FileCard
                filename={newName}
                previousFilename={oldName}
                additions={showStats ? contentStats!.additions : undefined}
                deletions={showStats ? contentStats!.deletions : undefined}
                showIcon={showIcon}
                variant={variant}
                size={size}
            >
                <MultiFileDiff
                    oldFile={{ name: oldName, contents: oldFile!.content }}
                    newFile={{ name: newName, contents: newFile!.content }}
                    options={pierreOptions}
                    style={PierreStyle}
                />
            </FileCard>
        </div>
    );
};

DiffViewer.displayName = "DiffViewer";

export { DiffViewer };
