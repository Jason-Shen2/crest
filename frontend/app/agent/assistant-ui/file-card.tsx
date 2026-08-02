"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { ChevronsUpDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { getFileIcon } from "@/app/fileexplorer/file-icon";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shadcn/ui/collapsible";
import { cn } from "@/util/util";

const fileCardVariants = cva("overflow-hidden rounded-lg font-mono text-sm", {
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

export interface FileCardProps extends VariantProps<typeof fileCardVariants> {
    filename: string;
    previousFilename?: string;
    additions?: number;
    deletions?: number;
    showIcon?: boolean;
    defaultOpen?: boolean;
    className?: string;
    children: ReactNode;
}

export function FileCard({
    filename,
    previousFilename,
    additions,
    deletions,
    showIcon = true,
    defaultOpen = true,
    variant,
    size,
    className,
    children,
}: FileCardProps) {
    const [open, setOpen] = useState(defaultOpen);
    const basename = filename.split(/[\\/]/).pop() ?? filename;
    const FileIcon = showIcon ? getFileIcon(basename, false, false) : null;
    const renamed = previousFilename && previousFilename !== filename;
    const showStats = additions != null || deletions != null;

    return (
        <Collapsible
            open={open}
            onOpenChange={setOpen}
            data-slot="file-card"
            className={cn(fileCardVariants({ variant, size }), className)}
        >
            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    data-slot="file-card-header"
                    aria-expanded={open}
                    className="bg-[var(--color-code-header-bg)] text-muted-foreground flex w-full cursor-pointer items-center gap-2 border-b border-border/50 px-3.5 py-1.5 text-left text-xs"
                >
                    {FileIcon && <FileIcon data-slot="file-card-file-icon" size={16} className="shrink-0" />}
                    <span className="min-w-0 flex-1 truncate font-mono">
                        {renamed ? (
                            <>
                                <span className="text-destructive">{previousFilename}</span>
                                {" -> "}
                                <span className="text-success">{filename}</span>
                            </>
                        ) : (
                            filename
                        )}
                    </span>
                    {showStats && (
                        <span data-slot="file-card-stats" className="flex gap-2 text-xs">
                            <span className="text-success">+{additions ?? 0}</span>
                            <span className="text-destructive">-{deletions ?? 0}</span>
                        </span>
                    )}
                    <ChevronsUpDownIcon
                        data-slot="file-card-collapse-icon"
                        aria-hidden="true"
                        className="size-4 shrink-0 opacity-60"
                    />
                </button>
            </CollapsibleTrigger>
            <CollapsibleContent data-slot="file-card-content" className="min-w-0 overflow-hidden">
                {children}
            </CollapsibleContent>
        </Collapsible>
    );
}
