// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom, type PrimitiveAtom } from "jotai";

export const pendingResumeSessionAtom = atom<AgentSessionMeta | null>(null) as PrimitiveAtom<AgentSessionMeta | null>;
