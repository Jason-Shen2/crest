// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AgentContent } from "@/app/agent/agent-content";
import type { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import { AgentSurfaceActivityProvider, makeAgentSurfaceActivityController } from "@/app/agent/agent-surface-activity";
import { memo, useEffect, useState } from "react";
import type { WorkspaceAgentModel } from "./workspace-agent-model";
import { WorkspaceContentSlot } from "./workspace-content-slot";

export interface WorkspaceAgentContentSlotProps {
    active: boolean;
    mounted: boolean;
    model?: WorkspaceAgentModel;
    client?: AgentRuntimeClient;
    executionContext?: AgentExecutionContext;
    onOpenFile?: (path: string) => void;
    onOpenTurnDiff?: (turnId: string, path: string) => void;
}

const StableAgentContent = memo(AgentContent);
StableAgentContent.displayName = "StableAgentContent";

export function WorkspaceAgentContentSlot({
    active,
    mounted,
    model,
    client,
    executionContext,
    onOpenFile,
    onOpenTurnDiff,
}: WorkspaceAgentContentSlotProps) {
    const [activityController] = useState(() => makeAgentSurfaceActivityController(active));

    useEffect(() => {
        activityController.setActive(active);
    }, [active, activityController]);

    if (!mounted) {
        return null;
    }
    return (
        <WorkspaceContentSlot active={active} testId="agent-surface">
            <AgentSurfaceActivityProvider controller={activityController}>
                {model && client && executionContext ? (
                    <StableAgentContent
                        model={model}
                        client={client}
                        executionContext={executionContext}
                        onOpenFile={onOpenFile}
                        onOpenTurnDiff={onOpenTurnDiff}
                    />
                ) : (
                    "Agent"
                )}
            </AgentSurfaceActivityProvider>
        </WorkspaceContentSlot>
    );
}
