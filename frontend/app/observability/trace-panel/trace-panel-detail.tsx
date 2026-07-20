// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TracePanelDetail.

import { ObservationDetailView } from "./observation-detail-view";
import { useTraceData, useTraceSelection } from "./trace-context";
import { TraceDetailView } from "./trace-detail-view";

export function TracePanelDetail() {
    const { detail, observationMap } = useTraceData();
    const { selectedNodeId } = useTraceSelection();
    const observation = selectedNodeId == null ? null : observationMap.get(selectedNodeId);

    return observation == null ? (
        <TraceDetailView detail={detail} />
    ) : (
        <ObservationDetailView trace={detail.trace} observation={observation} />
    );
}
