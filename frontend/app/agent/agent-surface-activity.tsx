// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface AgentSurfaceActivityController {
    getActive(): boolean;
    setActive(active: boolean): void;
    subscribe(listener: (active: boolean) => void): () => void;
}

export function makeAgentSurfaceActivityController(initialActive: boolean): AgentSurfaceActivityController {
    let active = initialActive;
    const listeners = new Set<(active: boolean) => void>();
    return {
        getActive: () => active,
        setActive: (nextActive) => {
            if (nextActive === active) {
                return;
            }
            active = nextActive;
            [...listeners].forEach((listener) => listener(active));
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

const DefaultAgentSurfaceActivityController = makeAgentSurfaceActivityController(true);
const AgentSurfaceActivityContext = createContext<AgentSurfaceActivityController>(
    DefaultAgentSurfaceActivityController
);

type AgentSurfaceActivityProviderProps =
    | {
          active?: never;
          controller: AgentSurfaceActivityController;
          children: ReactNode;
      }
    | {
          active?: boolean;
          controller?: never;
          children: ReactNode;
      };

export function AgentSurfaceActivityProvider({ active, controller, children }: AgentSurfaceActivityProviderProps) {
    if (active != null && controller != null) {
        throw new Error("AgentSurfaceActivityProvider accepts either controller or active, not both");
    }

    const fallbackControllerRef = useRef<AgentSurfaceActivityController>(null);
    if (fallbackControllerRef.current == null) {
        fallbackControllerRef.current = makeAgentSurfaceActivityController(active ?? true);
    }
    const activityController = controller ?? fallbackControllerRef.current;

    useLayoutEffect(() => {
        if (active == null) {
            return;
        }
        activityController.setActive(active);
    }, [active, activityController]);

    return (
        <AgentSurfaceActivityContext.Provider value={activityController}>
            {children}
        </AgentSurfaceActivityContext.Provider>
    );
}

export function useAgentSurfaceActivityController(): AgentSurfaceActivityController {
    return useContext(AgentSurfaceActivityContext);
}

export function useAgentSurfaceActive(): boolean {
    const activityController = useAgentSurfaceActivityController();
    const [active, setActive] = useState(() => activityController.getActive());

    useEffect(() => {
        setActive(activityController.getActive());
        return activityController.subscribe(setActive);
    }, [activityController]);

    return active;
}
