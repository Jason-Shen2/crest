// Based on assistant-ui (MIT): https://r.assistant-ui.com/markdown-text.json
"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import {
    type CodeHeaderProps,
    MarkdownTextPrimitive,
    unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
    type SyntaxHighlighterProps,
    useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type FC, memo, useEffect, useState } from "react";
import remarkGfm from "remark-gfm";
import { bundledLanguages, codeToHtml } from "shiki/bundle/web";

import { cn } from "@/util/util";
import { DiffViewer } from "./diff-viewer";
import { TooltipIconButton } from "./tooltip-icon-button";

const SHIKI_THEME = "github-dark-high-contrast";

const SyntaxHighlighter: FC<SyntaxHighlighterProps> = ({ language, code, components: { Pre, Code } }) => {
    const [html, setHtml] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const lang = language && language in bundledLanguages ? language : "plaintext";
        codeToHtml(code, {
            lang,
            theme: SHIKI_THEME,
        })
            .then((full) => {
                if (cancelled) return;
                const start = full.indexOf("<code");
                const open = full.indexOf(">", start);
                const end = full.lastIndexOf("</code>");
                setHtml(start !== -1 && open !== -1 && end !== -1 ? full.slice(open + 1, end) : null);
            })
            .catch(() => {
                if (!cancelled) setHtml(null);
            });
        return () => {
            cancelled = true;
        };
    }, [code, language]);

    if (html == null) {
        return (
            <Pre>
                <Code>{code}</Code>
            </Pre>
        );
    }

    return (
        <Pre>
            <Code dangerouslySetInnerHTML={{ __html: html }} />
        </Pre>
    );
};

const MarkdownTextImpl = () => {
    return (
        <MarkdownTextPrimitive
            remarkPlugins={[remarkGfm]}
            className="aui-md"
            components={defaultComponents}
            componentsByLanguage={{
                diff: {
                    SyntaxHighlighter: DiffViewer,
                },
            }}
            defer
        />
    );
};

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
    const { isCopied, copyToClipboard } = useCopyToClipboard();
    const onCopy = () => {
        if (!code || isCopied) return;
        copyToClipboard(code);
    };

    return (
        <div className="aui-code-header-root border-border/50 bg-[#0d1325] mt-3 flex items-center justify-between rounded-t-xl border border-b-0 px-3.5 py-1.5 text-xs text-zinc-400">
            <span className="aui-code-header-language font-medium lowercase">{language}</span>
            <TooltipIconButton tooltip="Copy" onClick={onCopy}>
                {!isCopied && <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />}
                {isCopied && <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />}
            </TooltipIconButton>
        </div>
    );
};

const useCopyToClipboard = ({
    copiedDuration = 3000,
}: {
    copiedDuration?: number;
} = {}) => {
    const [isCopied, setIsCopied] = useState<boolean>(false);

    const copyToClipboard = (value: string) => {
        if (!value || typeof navigator === "undefined" || !navigator.clipboard) {
            return;
        }

        navigator.clipboard.writeText(value).then(
            () => {
                setIsCopied(true);
                setTimeout(() => setIsCopied(false), copiedDuration);
            },
            () => {}
        );
    };

    return { isCopied, copyToClipboard };
};

const defaultComponents = memoizeMarkdownComponents({
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
    pre: ({ className, ...props }) => (
        <pre
            className={cn(
                "aui-md-pre border-border/50 bg-[#0a0f1d] overflow-auto max-h-[480px] rounded-t-none rounded-b-xl border border-t-0 p-0 text-[13px] leading-relaxed [&>code]:block [&>code]:p-3.5",
                className
            )}
            {...props}
        />
    ),
    code: function Code({ className, ...props }) {
        const isCodeBlock = useIsMarkdownCodeBlock();
        return (
            <code
                className={cn(
                    !isCodeBlock && "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]",
                    isCodeBlock && "shiki shiki-themes font-mono",
                    className
                )}
                {...props}
            />
        );
    },
    CodeHeader,
    SyntaxHighlighter,
});
