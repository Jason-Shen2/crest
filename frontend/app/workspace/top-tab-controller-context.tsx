// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";
import type { WorkspaceTopTabController } from "./top-tab-controller";

export const WorkspaceTopTabControllerContext = createContext<WorkspaceTopTabController | undefined>(undefined);

export function useWorkspaceTopTabController(): WorkspaceTopTabController {
    const controller = useContext(WorkspaceTopTabControllerContext);
    if (!controller) {
        throw new Error("Workspace Top Tab controller is unavailable");
    }
    return controller;
}
