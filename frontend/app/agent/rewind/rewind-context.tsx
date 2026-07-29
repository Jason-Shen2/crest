// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";

export interface ThreadRewindContextValue {
    rewindableTurnIds: ReadonlySet<string>;
    latestRewindableTurnId?: string;
    busy: boolean;
    onRevertTurn?: (turnId: string) => void;
}

const EmptyThreadRewindContext: ThreadRewindContextValue = {
    rewindableTurnIds: new Set(),
    busy: false,
};

export const ThreadRewindContext = createContext<ThreadRewindContextValue>(EmptyThreadRewindContext);

export function useThreadRewind(): ThreadRewindContextValue {
    return useContext(ThreadRewindContext);
}
