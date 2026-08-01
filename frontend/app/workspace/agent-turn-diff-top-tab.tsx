// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import { DiffContentBody, type GitDiffContent } from "@/app/gitdiff/git-diff-pane";
import { useEffect, useRef, useState } from "react";
import type { TopTab } from "./workspace-content-state";

type AgentTurnDiffTab = Extract<TopTab, { kind: "agent-turn-diff" }>;

interface AgentTurnDiffState {
    loading: boolean;
    content: GitDiffContent | null;
    errorMessage: string | null;
}

function messageFromError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function AgentTurnDiffTopTab({ tab, client }: { tab: AgentTurnDiffTab; client?: AgentRuntimeClient }) {
    const [state, setState] = useState<AgentTurnDiffState>({ loading: true, content: null, errorMessage: null });
    const [retryGeneration, setRetryGeneration] = useState(0);
    const requestGeneration = useRef(0);

    useEffect(() => {
        const generation = ++requestGeneration.current;
        setState({ loading: true, content: null, errorMessage: null });
        const request = client
            ? client.getTurnFileDiff({
                  sessionMetadata: {
                      id: tab.sessionId,
                      createdAt: tab.sessionCreatedAt,
                      cwd: tab.sessionCwd,
                      path: tab.sessionPath,
                  },
                  expectedSemanticLeafId: null,
                  turnId: tab.turnId,
                  path: tab.path,
              })
            : Promise.reject(new Error("Agent runtime is unavailable"));
        request
            .then((result) => {
                if (generation !== requestGeneration.current) return;
                if (result.turnId !== tab.turnId || result.path !== tab.path) {
                    throw new Error("Turn diff response does not match the requested checkpoint path");
                }
                setState({
                    loading: false,
                    errorMessage: null,
                    content: {
                        originalContent: result.originalContent,
                        modifiedContent: result.modifiedContent,
                        isBinary: result.isBinary,
                        fallbackPatch: result.fallbackPatch,
                        truncated: result.truncated,
                    },
                });
            })
            .catch((error) => {
                if (generation !== requestGeneration.current) return;
                setState({
                    loading: false,
                    content: null,
                    errorMessage: `Failed to load turn diff: ${messageFromError(error)}`,
                });
            });
        return () => {
            requestGeneration.current++;
        };
    }, [
        client,
        retryGeneration,
        tab.path,
        tab.sessionCreatedAt,
        tab.sessionCwd,
        tab.sessionId,
        tab.sessionPath,
        tab.turnId,
    ]);

    return (
        <DiffContentBody
            loading={state.loading}
            content={state.content}
            errorMessage={state.errorMessage}
            path={tab.path}
            onRetry={() => setRetryGeneration((generation) => generation + 1)}
            retryAriaLabel="Retry turn diff"
        />
    );
}
