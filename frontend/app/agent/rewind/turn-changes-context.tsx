// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { createContext } from "react";
import type { AgentTurnChangesCardState } from "./use-agent-turn-changes";

export interface TurnChangesContextValue {
    cards: ReadonlyMap<string, AgentTurnChangesCardState>;
    openReview(turnId: string): void | Promise<void>;
    openMutation(turnId: string): void | Promise<void>;
}

export const TurnChangesContext = createContext<TurnChangesContextValue | undefined>(undefined);
