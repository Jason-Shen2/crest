// Based on assistant-ui (MIT): https://www.assistant-ui.com/docs/ui/streamdown
"use client";

import {
    StreamdownTextPrimitive,
    type ComponentsByLanguage,
    type StreamdownTextComponents,
    type SyntaxHighlighterProps,
} from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";
import { memo } from "react";

import { cn } from "@/util/util";
import { DiffViewer } from "./diff-viewer";

const SHIKI_THEME = "github-dark-high-contrast";

const MarkdownTextImpl = () => {
    return (
        <StreamdownTextPrimitive
            plugins={{ code }}
            shikiTheme={[SHIKI_THEME, SHIKI_THEME]}
            className="aui-md"
            components={streamdownComponents}
            componentsByLanguage={streamdownComponentsByLanguage}
            controls={{
                code: true,
                table: false,
            }}
            defer
        />
    );
};

export const MarkdownText = memo(MarkdownTextImpl);

function DiffSyntaxHighlighter({ code: diffPatch, language }: SyntaxHighlighterProps) {
    return <DiffViewer code={diffPatch} language={language} viewMode="unified" size="sm" />;
}

const streamdownComponentsByLanguage = {
    diff: { SyntaxHighlighter: DiffSyntaxHighlighter },
    patch: { SyntaxHighlighter: DiffSyntaxHighlighter },
} satisfies ComponentsByLanguage;

const streamdownComponents = {
    h1: ({ className, ...props }) => (
        <h1
            className={cn("aui-md-h1 mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0", className)}
            {...props}
        />
    ),
    h2: ({ className, ...props }) => (
        <h2
            className={cn("aui-md-h2 mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0", className)}
            {...props}
        />
    ),
    h3: ({ className, ...props }) => (
        <h3
            className={cn("aui-md-h3 mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0", className)}
            {...props}
        />
    ),
    h4: ({ className, ...props }) => (
        <h4
            className={cn("aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0", className)}
            {...props}
        />
    ),
    h5: ({ className, ...props }) => (
        <h5 className={cn("aui-md-h5 mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0", className)} {...props} />
    ),
    h6: ({ className, ...props }) => (
        <h6 className={cn("aui-md-h6 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0", className)} {...props} />
    ),
    p: ({ className, ...props }) => (
        <p className={cn("aui-md-p my-3 leading-relaxed first:mt-0 last:mb-0", className)} {...props} />
    ),
    a: ({ className, ...props }) => (
        <a
            className={cn("aui-md-a text-primary hover:text-primary/80 underline underline-offset-2", className)}
            {...props}
        />
    ),
    blockquote: ({ className, ...props }) => (
        <blockquote
            className={cn(
                "aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-3 border-s-2 ps-4",
                className
            )}
            {...props}
        />
    ),
    ul: ({ className, ...props }) => (
        <ul
            className={cn("aui-md-ul marker:text-muted-foreground my-3 ms-5 list-disc [&>li]:mt-1", className)}
            {...props}
        />
    ),
    ol: ({ className, ...props }) => (
        <ol
            className={cn("aui-md-ol marker:text-muted-foreground my-3 ms-5 list-decimal [&>li]:mt-1", className)}
            {...props}
        />
    ),
    hr: ({ className, ...props }) => (
        <hr className={cn("aui-md-hr border-muted-foreground/20 my-3", className)} {...props} />
    ),
    table: ({ className, ...props }) => (
        <table
            className={cn("aui-md-table my-3 w-full border-separate border-spacing-0 overflow-y-auto", className)}
            {...props}
        />
    ),
    th: ({ className, ...props }) => (
        <th
            className={cn(
                "aui-md-th bg-muted px-3 py-1.5 text-start font-medium first:rounded-ss-lg last:rounded-se-lg [[align=center]]:text-center [[align=right]]:text-right",
                className
            )}
            {...props}
        />
    ),
    td: ({ className, ...props }) => (
        <td
            className={cn(
                "aui-md-td border-muted-foreground/20 border-s border-b px-3 py-1.5 text-start last:border-e [[align=center]]:text-center [[align=right]]:text-right",
                className
            )}
            {...props}
        />
    ),
    tr: ({ className, ...props }) => (
        <tr
            className={cn(
                "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg",
                className
            )}
            {...props}
        />
    ),
    li: ({ className, ...props }) => <li className={cn("aui-md-li leading-relaxed", className)} {...props} />,
    strong: ({ className, ...props }) => <strong className={cn("aui-md-strong font-semibold", className)} {...props} />,
    sup: ({ className, ...props }) => (
        <sup className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)} {...props} />
    ),
    inlineCode: ({ className, ...props }) => (
        <code
            className={cn("aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]", className)}
            {...props}
        />
    ),
} satisfies StreamdownTextComponents;
