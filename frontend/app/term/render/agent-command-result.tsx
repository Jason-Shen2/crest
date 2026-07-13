import { XIcon } from "lucide-react";
import { memo, type ReactNode } from "react";
import { COMMAND_INLINE_FRAME_CLASSNAME } from "@/app/view/cmdblock/command-inline-frame";
import type { AgentInlineCommandResult } from "./agent-chat-host";

function splitCommandMessage(message: string): string[] {
    return message.split(/\r?\n/);
}

function ResultFrame({
    children,
    onDismiss,
}: {
    children: ReactNode;
    onDismiss: () => void;
}) {
    return (
        <div className={`${COMMAND_INLINE_FRAME_CLASSNAME} animate-in fade-in slide-in-from-bottom-1 duration-150`}>
            <div className="relative">
                <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={onDismiss}
                    className="absolute right-3 top-2.5 z-10 flex size-6 cursor-pointer items-center justify-center rounded-lg text-secondary/70 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                    <XIcon className="size-3.5" />
                </button>
                {children}
            </div>
        </div>
    );
}

function renderSessionInfo(result: AgentInlineCommandResult) {
    const lines = splitCommandMessage(result.message);
    const title = lines[0] || "Session Info";
    const bodyLines = lines.slice(1);

    return (
        <div className="font-mono text-[12px] leading-relaxed">
            <div className="border-b border-white/[0.07] bg-white/[0.035] px-4 py-3 pr-12 font-semibold text-accent">
                {title}
            </div>
            <div className="space-y-1 px-4 py-4">
                {bodyLines.map((line, index) => {
                    if (!line.trim()) {
                        return <div key={index} className="h-2" />;
                    }
                    const isHeading = !line.includes(":");
                    if (isHeading) {
                        return (
                            <div key={index} className="pt-1 font-semibold uppercase tracking-wide text-accent">
                                {line}
                            </div>
                        );
                    }
                    const [label, ...rest] = line.split(":");
                    return (
                        <div key={index} className="grid grid-cols-[110px_minmax(0,1fr)] gap-3">
                            <span className="text-secondary">{label}:</span>
                            <span className="truncate text-foreground">{rest.join(":").trim()}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function renderCompactResult(result: AgentInlineCommandResult) {
    if (result.status === "noop") {
        return <div className="px-3 py-3 font-mono text-[12px] text-warning">{result.message}</div>;
    }
    return (
        <div className="px-3 py-3 font-mono text-[12px] leading-relaxed">
            <div className="font-semibold text-success">Context compacted</div>
            <div className="mt-1 text-foreground/90">{result.message}</div>
        </div>
    );
}

export const AgentCommandResult = memo(
    ({ result, onDismiss }: { result: AgentInlineCommandResult; onDismiss: () => void }) => {
        let content: ReactNode;
        if (result.command === "session") {
            content = renderSessionInfo(result);
        } else if (result.command === "compact") {
            content = renderCompactResult(result);
        } else if (result.status === "noop") {
            content = <div className="px-3 py-3 font-mono text-[12px] text-warning">{result.message}</div>;
        } else {
            content = <div className="px-3 py-3 font-mono text-[12px] text-secondary">{result.message}</div>;
        }
        return <ResultFrame onDismiss={onDismiss}>{content}</ResultFrame>;
    }
);
AgentCommandResult.displayName = "AgentCommandResult";

export const AgentCommandResultList = memo(
    ({
        results,
        onDismiss,
    }: {
        results: AgentInlineCommandResult[];
        onDismiss: (index: number) => void;
    }) => {
        if (results.length === 0) return null;
        return (
            <div
                data-testid="agent-cmd-results"
                className="flex shrink-0 flex-col gap-2"
            >
                {results.map((result, index) => (
                    <AgentCommandResult
                        key={`${result.command}-${index}`}
                        result={result}
                        onDismiss={() => onDismiss(index)}
                    />
                ))}
            </div>
        );
    }
);
AgentCommandResultList.displayName = "AgentCommandResultList";
