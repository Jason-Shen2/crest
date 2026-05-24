// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// TS port of pkg/aiusechat/aiconfig.go — atomic read / write of
// `~/.config/crest/ai.json`. Read returns a status-tagged response so
// the renderer can distinguish "fresh install" from "file is broken"
// without resorting to error-string sniffing.
//
// Validation is shape-level only (presence of required fields). The
// frontend resolver still does cross-reference validation (does
// default.provider exist in providers?) because catalog data lives
// there.
//
// Shape mirrors frontend/app/store/ai-types.ts UserConfig — JSON keys
// must stay in sync across the boundary.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getWaveConfigDir } from "../emain-platform";

const AI_USER_CONFIG_FILE = "ai.json";

// Lock so concurrent writes (e.g. picker + wizard at the same time)
// don't tear. Single in-flight writer at a time.
let writeChain: Promise<void> = Promise.resolve();

interface ProviderCredentials {
    tokensecretname?: string;
    token?: string;
}

interface AISelectionConfig {
    provider: string;
    model: string;
    reasoning?: string;
}

// Loose typing — we revalidate shape on write; the renderer's UserConfig
// is the authoritative TS shape. This stays permissive so renderer-only
// fields don't trigger spurious rejections here.
type AIUserConfig = {
    providers: Record<string, ProviderCredentials>;
    default: AISelectionConfig;
    [k: string]: unknown;
};

export type AIUserConfigReadStatus = "ok" | "missing" | "malformed";

export interface AIUserConfigReadResult {
    status: AIUserConfigReadStatus;
    config?: AIUserConfig;
    error?: string;
}

export async function readAIUserConfig(): Promise<AIUserConfigReadResult> {
    const filePath = aiUserConfigPath();
    let data: string;
    try {
        data = await fs.readFile(filePath, "utf8");
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
        return { status: "malformed", error: `read ${filePath}: ${(err as Error).message}` };
    }
    if (!data) return { status: "malformed", error: "file is empty" };
    let cfg: AIUserConfig;
    try {
        cfg = JSON.parse(data) as AIUserConfig;
    } catch (err: unknown) {
        return { status: "malformed", error: (err as Error).message };
    }
    const validationErr = validateAIUserConfig(cfg);
    if (validationErr) return { status: "malformed", error: validationErr };
    return { status: "ok", config: cfg };
}

export async function writeAIUserConfig(cfg: AIUserConfig): Promise<void> {
    if (cfg == null) throw new Error("write ai user config: cfg is nil");
    const validationErr = validateAIUserConfig(cfg);
    if (validationErr) throw new Error(`malformed ai user config: ${validationErr}`);
    const next = writeChain.then(() => doWrite(cfg)).catch(() => doWrite(cfg));
    writeChain = next.catch(() => undefined);
    return next;
}

async function doWrite(cfg: AIUserConfig): Promise<void> {
    const filePath = aiUserConfigPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload = JSON.stringify(cfg, null, 4);
    // Write to a sibling tmp file then atomic rename. Avoids leaving a
    // half-written ai.json if the process dies mid-write.
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o644 });
    await fs.rename(tmp, filePath);
}

function aiUserConfigPath(): string {
    return path.join(getWaveConfigDir(), AI_USER_CONFIG_FILE);
}

function validateAIUserConfig(cfg: AIUserConfig): string | null {
    if (!cfg || typeof cfg !== "object") return "missing required field: providers";
    if (!cfg.providers || typeof cfg.providers !== "object") {
        return "missing required field: providers";
    }
    if (Object.keys(cfg.providers).length === 0) {
        return "providers map is empty — add at least one provider entry";
    }
    if (!cfg.default) return "missing required field: default";
    if (!cfg.default.provider) return "missing required field: default.provider";
    if (!cfg.default.model) return "missing required field: default.model";
    return null;
}
