import { memo } from "react";
import type { AgentInlineCommandResult } from "./agent-chat-host";

function splitCommandMessage(message: string): string[] {
    return message.split(/\r?\n/);
}

function renderSessionInfo(result: AgentInlineCommandResult) {
    const lines = splitCommandMessage(result.message);
    const title = lines[0] || "Session Info";
    const bodyLines = lines.slice(1);

    return (
        <div className="my-3 border-y border-fg-overlay-2/50 py-3 font-mono text-[12px] leading-relaxed">
            <div className="font-semibold text-accent">{title}</div>
            <div className="mt-2 space-y-1">
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
        return <div className="my-2 font-mono text-[12px] text-warning">{result.message}</div>;
    }
    return (
        <div className="my-3 border-l border-accent/40 pl-3 font-mono text-[12px] leading-relaxed">
            <div className="font-semibold text-success">Context compacted</div>
            <div className="mt-1 text-foreground/90">{result.message}</div>
        </div>
    );
}

export const AgentCommandResult = memo(({ result }: { result: AgentInlineCommandResult }) => {
    if (result.command === "session") {
        return renderSessionInfo(result);
    }
    if (result.command === "compact") {
        return renderCompactResult(result);
    }
    if (result.status === "noop") {
        return <div className="my-2 font-mono text-[12px] text-warning">{result.message}</div>;
    }
    return <div className="my-2 font-mono text-[12px] text-secondary">{result.message}</div>;
});
AgentCommandResult.displayName = "AgentCommandResult";

export const AgentCommandResultList = memo(({ results }: { results: AgentInlineCommandResult[] }) => {
    if (results.length === 0) return null;
    return (
        <div className="shrink-0 px-3 pb-2">
            {results.map((result, index) => (
                <AgentCommandResult key={`${result.command}-${index}`} result={result} />
            ))}
        </div>
    );
});
AgentCommandResultList.displayName = "AgentCommandResultList";
