// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export function AgentPtyScreenView({ snapshot }: { snapshot: AgentPtySnapshot }) {
    const cursor = snapshot.screen.cursor;
    return (
        <div
            className="relative overflow-auto rounded-lg bg-black/45 p-2 font-mono text-xs leading-5 text-foreground"
            data-alt-screen={String(snapshot.screen.isAltScreenActive)}
            data-testid="agent-pty-screen"
        >
            {snapshot.screen.rows.map((row, index) => (
                <div className="min-h-5 whitespace-pre" data-testid="agent-pty-row" key={index}>
                    {row.text}
                </div>
            ))}
            {cursor.visible ? (
                <span
                    className="pointer-events-none absolute inline-block h-4 w-2 bg-accent/70"
                    data-col={cursor.col}
                    data-row={cursor.row}
                    data-shape={cursor.shape}
                    data-testid="agent-pty-cursor"
                    style={{
                        left: `${0.5 + cursor.col * 0.6}rem`,
                        top: `${0.5 + cursor.row * 1.25}rem`,
                    }}
                />
            ) : null}
        </div>
    );
}
