// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

const PurgeTokenTtlMs = 5 * 60 * 1_000;

export interface CheckpointPurgeBinding {
    workspaceIdentity: string;
    workspaceIncarnation: string;
    trashedSessionId: string;
    trashLifecycleGeneration: string;
    canonicalTrashPath: string;
    canonicalDatabaseIdentity: string;
}

interface PurgeTokenRecord {
    binding: CheckpointPurgeBinding;
    expiresAt: number;
}

export class CheckpointPurgeConfirmationRegistry {
    readonly tokens = new Map<string, PurgeTokenRecord>();

    issue(binding: CheckpointPurgeBinding, now = Date.now()): string {
        const token = randomBytes(32).toString("base64url");
        this.tokens.set(token, {
            binding: Object.freeze({ ...binding }),
            expiresAt: now + PurgeTokenTtlMs,
        });
        return token;
    }

    take(token: string, now = Date.now()): CheckpointPurgeBinding {
        const record = this.tokens.get(token);
        if (!record) {
            throw new Error("invalid checkpoint purge confirmation token");
        }
        this.tokens.delete(token);
        if (now >= record.expiresAt) {
            throw new Error("checkpoint purge confirmation token expired");
        }
        return record.binding;
    }
}
