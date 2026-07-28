"use client";

import { parsePatchFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff, MultiFileDiff } from "@pierre/diffs/react";
import { cva, type VariantProps } from "class-variance-authority";
import { diffLines } from "diff";
import { ChevronsUpDownIcon } from "lucide-react";
import { useMemo, useState, type CSSProperties, type ComponentProps, type FC, type ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shadcn/ui/collapsible";
import { cn } from "@/util/util";

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

const diffViewerVariants = cva("aui-diff-viewer-file overflow-hidden rounded-lg font-mono text-sm", {
    variants: {
        variant: {
            default: "bg-[var(--color-code-bg)] border border-border/50",
            ghost: "bg-transparent",
            muted: "border-muted-foreground/20 bg-muted border",
        },
        size: {
            sm: "text-xs",
            default: "text-sm",
            lg: "text-base",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});

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

function getFileExtension(filename?: string): string {
    const ext = filename?.split(".").pop()?.toLowerCase();
    if (!ext) return "";
    return ext.toUpperCase();
}

function DiffViewerFileBadge({ filename }: { filename?: string }) {
    const ext = getFileExtension(filename);
    if (!ext) return null;

    return (
        <span
            data-slot="diff-viewer-file-badge"
            className="bg-background inline-flex size-5 shrink-0 items-end justify-end rounded-sm border text-[8px] leading-none font-bold"
        >
            <span className="p-0.5">{ext}</span>
        </span>
    );
}

function DiffViewerStats({ additions, deletions }: { additions: number; deletions: number }) {
    return (
        <span data-slot="diff-viewer-stats" className="flex gap-2 text-xs">
            <span className="text-success">+{additions}</span>
            <span className="text-destructive">-{deletions}</span>
        </span>
    );
}

interface DiffViewerHeaderProps extends ComponentProps<"button"> {
    oldName?: string;
    newName?: string;
    additions?: number;
    deletions?: number;
    showIcon?: boolean;
    showStats?: boolean;
    open: boolean;
}

function DiffViewerHeader({
    oldName,
    newName,
    additions = 0,
    deletions = 0,
    showIcon = true,
    showStats = true,
    open,
    className,
    ...props
}: DiffViewerHeaderProps) {
    const displayName = newName || oldName;

    return (
        <button
            type="button"
            data-slot="diff-viewer-header"
            aria-expanded={open}
            className={cn(
                "bg-[var(--color-code-header-bg)] text-muted-foreground flex w-full cursor-pointer items-center gap-2 border-b border-border/50 px-3.5 py-1.5 text-left text-xs",
                className
            )}
            {...props}
        >
            {showIcon && <DiffViewerFileBadge filename={displayName} />}
            <span className="min-w-0 flex-1 truncate font-mono">
                {oldName && newName && oldName !== newName ? (
                    <>
                        <span className="text-destructive">{oldName}</span>
                        {" -> "}
                        <span className="text-success">{newName}</span>
                    </>
                ) : (
                    displayName
                )}
            </span>
            {showStats && (additions > 0 || deletions > 0) && (
                <DiffViewerStats additions={additions} deletions={deletions} />
            )}
            <ChevronsUpDownIcon
                data-slot="diff-viewer-collapse-icon"
                aria-hidden="true"
                className="size-4 shrink-0 opacity-60"
            />
        </button>
    );
}

interface DiffViewerFileProps extends VariantProps<typeof diffViewerVariants> {
    oldName?: string;
    newName?: string;
    additions: number;
    deletions: number;
    showIcon: boolean;
    showStats: boolean;
    children: ReactNode;
}

function DiffViewerFile({
    oldName,
    newName,
    additions,
    deletions,
    showIcon,
    showStats,
    variant,
    size,
    children,
}: DiffViewerFileProps) {
    const [open, setOpen] = useState(true);

    return (
        <Collapsible
            open={open}
            onOpenChange={setOpen}
            data-slot="diff-viewer-file"
            className={diffViewerVariants({ variant, size })}
        >
            <CollapsibleTrigger asChild data-slot="diff-viewer-header">
                <DiffViewerHeader
                    oldName={oldName}
                    newName={newName}
                    additions={additions}
                    deletions={deletions}
                    showIcon={showIcon}
                    showStats={showStats}
                    open={open}
                />
            </CollapsibleTrigger>
            <CollapsibleContent data-slot="diff-viewer-content" className="min-w-0 overflow-hidden">
                {children}
            </CollapsibleContent>
        </Collapsible>
    );
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

export type DiffViewerProps = VariantProps<typeof diffViewerVariants> & {
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
                        <DiffViewerFile
                            key={`${fileDiff.prevName ?? ""}:${fileDiff.name}:${fileIndex}`}
                            oldName={fileDiff.prevName}
                            newName={fileDiff.name}
                            additions={stats.additions}
                            deletions={stats.deletions}
                            showIcon={showIcon}
                            showStats={showStats}
                            variant={variant}
                            size={size}
                        >
                            <FileDiff fileDiff={fileDiff} options={pierreOptions} style={PierreStyle} />
                        </DiffViewerFile>
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
            <DiffViewerFile
                oldName={oldName}
                newName={newName}
                additions={contentStats!.additions}
                deletions={contentStats!.deletions}
                showIcon={showIcon}
                showStats={showStats}
                variant={variant}
                size={size}
            >
                <MultiFileDiff
                    oldFile={{ name: oldName, contents: oldFile!.content }}
                    newFile={{ name: newName, contents: newFile!.content }}
                    options={pierreOptions}
                    style={PierreStyle}
                />
            </DiffViewerFile>
        </div>
    );
};

DiffViewer.displayName = "DiffViewer";

export { DiffViewer };
