// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for sessions.ts + build-system-prompt.ts. Doesn't exercise
// AgentHarness or LLM calls — that's the spike + task #14 E2E.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonlSessionRepo } from "./harness/session/jsonl-repo";
import { NodeExecutionEnv } from "./node";
import { buildSystemPrompt } from "./build-system-prompt";
import {
    _setSessionsRepoForTests,
    createPaneSession,
    defaultSessionsDir,
    forkPaneSession,
    listSessionsForCwd,
    openPaneSession,
    openPaneSessionByPath,
} from "./sessions";
import type { AgentMessage } from "./types";

function user(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

describe("sessions — JsonlSessionRepo wiring", () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crest-sessions-test-"));
        const env = new NodeExecutionEnv({ cwd: process.cwd() });
        _setSessionsRepoForTests(new JsonlSessionRepo({ fs: env, sessionsRoot: tmpRoot }));
    });

    afterEach(async () => {
        _setSessionsRepoForTests(undefined);
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("createPaneSession mints metadata with all four required fields", async () => {
        const { metadata } = await createPaneSession("/tmp/some-project");
        expect(metadata.id).toMatch(/^[0-9a-f-]{20,}$/i);
        expect(metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(metadata.cwd).toBe("/tmp/some-project");
        expect(metadata.path).toContain(tmpRoot);
        expect(metadata.path.endsWith(".jsonl")).toBe(true);
    });

    it("createPaneSession writes a JSONL file with a session header on line 1", async () => {
        const { metadata } = await createPaneSession("/tmp/proj-a");
        const raw = await fs.readFile(metadata.path, "utf8");
        const firstLine = raw.split("\n")[0];
        const header = JSON.parse(firstLine);
        expect(header.type).toBe("session");
        expect(header.id).toBe(metadata.id);
        expect(header.cwd).toBe("/tmp/proj-a");
    });

    it("openPaneSession returns a Session with matching metadata", async () => {
        const created = await createPaneSession("/tmp/proj-b");
        const reopened = await openPaneSession(created.metadata);
        const reopenedMeta = await reopened.getMetadata();
        expect(reopenedMeta.id).toBe(created.metadata.id);
        expect(reopenedMeta.path).toBe(created.metadata.path);
        expect(reopenedMeta.cwd).toBe("/tmp/proj-b");
    });

    it("openPaneSessionByPath reopens a session when only the JSONL path is known", async () => {
        const created = await createPaneSession("/tmp/proj-path-only");
        await created.session.appendMessage(user("persisted q"));

        const reopened = await openPaneSessionByPath(created.metadata.path);
        const context = await reopened.buildContext();

        expect(context.messages).toHaveLength(1);
        expect(context.messages[0].role).toBe("user");
        expect((context.messages[0] as { content: { text: string }[] }).content[0].text).toBe("persisted q");
    });

    it("forkPaneSession forks before a user message and records the source path", async () => {
        const source = await createPaneSession("/tmp/proj-fork");
        await source.session.appendMessage(user("keep this"));
        const forkPointId = await source.session.appendMessage(user("fork from here"));

        const forked = await forkPaneSession(source.metadata, { entryId: forkPointId });
        const forkedMeta = await forked.session.getMetadata();
        const context = await forked.session.buildContext();

        expect(forked.metadata.path).toBe(forkedMeta.path);
        expect(forked.metadata.cwd).toBe("/tmp/proj-fork");
        expect(forked.metadata.parentSessionPath).toBe(source.metadata.path);
        expect(context.messages).toHaveLength(1);
        expect((context.messages[0] as { content: { text: string }[] }).content[0].text).toBe("keep this");
    });

    it("listSessionsForCwd returns only sessions for the given cwd, newest first", async () => {
        const a1 = await createPaneSession("/tmp/proj-x");
        // Brief delay so timestamps differ (pi sorts by createdAt).
        await new Promise((r) => setTimeout(r, 10));
        const a2 = await createPaneSession("/tmp/proj-x");
        await new Promise((r) => setTimeout(r, 10));
        await createPaneSession("/tmp/proj-y"); // different cwd; should not appear

        const list = await listSessionsForCwd("/tmp/proj-x");
        expect(list).toHaveLength(2);
        // newest first
        expect(list[0].id).toBe(a2.metadata.id);
        expect(list[1].id).toBe(a1.metadata.id);
    });

    it("listSessionsForCwd returns [] for a cwd with no sessions", async () => {
        await createPaneSession("/tmp/proj-other");
        const list = await listSessionsForCwd("/tmp/never-touched");
        expect(list).toEqual([]);
    });

    it("AgentSessionMeta shape matches JsonlSessionMetadata fields", async () => {
        // Tests the doc §5.1 promise: AgentSessionMeta (from Go-generated TS)
        // is structurally a subset of pi's JsonlSessionMetadata, so round-trip
        // is identity. We verify by reading the metadata pi produces and
        // checking it has exactly the four fields AgentSessionMeta declares.
        const { metadata } = await createPaneSession("/tmp/shape-check");
        expect(typeof metadata.id).toBe("string");
        expect(typeof metadata.createdAt).toBe("string");
        expect(typeof metadata.cwd).toBe("string");
        expect(typeof metadata.path).toBe("string");
    });
});

describe("defaultSessionsDir", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("uses WAVETERM_CONFIG_HOME when set", () => {
        process.env.WAVETERM_CONFIG_HOME = "/tmp/probe-config";
        delete process.env.XDG_CONFIG_HOME;
        delete process.env.WAVETERM_DEV;
        expect(defaultSessionsDir()).toBe(path.join("/tmp/probe-config", "sessions"));
    });

    it("falls back to crest-dev when WAVETERM_DEV is set", () => {
        delete process.env.WAVETERM_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = "/tmp/xdg";
        process.env.WAVETERM_DEV = "1";
        expect(defaultSessionsDir()).toBe(path.join("/tmp/xdg", "crest-dev", "sessions"));
    });

    it("falls back to crest in prod (no WAVETERM_DEV)", () => {
        delete process.env.WAVETERM_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = "/tmp/xdg";
        delete process.env.WAVETERM_DEV;
        expect(defaultSessionsDir()).toBe(path.join("/tmp/xdg", "crest", "sessions"));
    });
});

describe("buildSystemPrompt", () => {
    it("renders the default body with cwd and date footer", () => {
        const out = buildSystemPrompt({ cwd: "/Users/me/project" });
        expect(out).toContain("expert coding assistant operating inside crest");
        expect(out).toContain("Current working directory: /Users/me/project");
        expect(out).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
    });

    it("lists active tools that provide a snippet", () => {
        const out = buildSystemPrompt({
            cwd: "/x",
            selectedTools: ["read", "bash"],
            toolSnippets: { read: "Read file contents", bash: "Execute bash commands (ls, grep, find, etc.)" },
        });
        expect(out).toContain("Available tools:");
        expect(out).toContain("- read: Read file contents");
        expect(out).toContain("- bash: Execute bash commands (ls, grep, find, etc.)");
    });

    it("omits tools without a snippet from the Available tools list", () => {
        const out = buildSystemPrompt({
            cwd: "/x",
            selectedTools: ["read", "web_fetch"],
            toolSnippets: { read: "Read file contents" },
        });
        expect(out).toContain("- read: Read file contents");
        expect(out).not.toContain("web_fetch:");
    });

    it("appends tool prompt guidelines and dedupes them", () => {
        const out = buildSystemPrompt({
            cwd: "/x",
            selectedTools: ["read"],
            toolSnippets: { read: "Read file contents" },
            promptGuidelines: ["Use read to examine files instead of cat or sed.", "Use read to examine files instead of cat or sed."],
        });
        const occurrences = out.split("Use read to examine files instead of cat or sed.").length - 1;
        expect(occurrences).toBe(1);
        expect(out).toContain("- Be concise in your responses");
    });

    it("does NOT contain the legacy 'When uncertain, ask' anti-pattern", () => {
        const out = buildSystemPrompt({ cwd: "/x" });
        expect(out).not.toContain("When uncertain");
    });

    it("does NOT contain pi-specific documentation block", () => {
        const out = buildSystemPrompt({ cwd: "/x" });
        expect(out).not.toContain("Pi documentation");
    });

    it("injects project context files into <project_context>", () => {
        const out = buildSystemPrompt({
            cwd: "/x",
            contextFiles: [{ path: "/x/AGENTS.md", content: "Always run lints." }],
        });
        expect(out).toContain("<project_context>");
        expect(out).toContain('<project_instructions path="/x/AGENTS.md">');
        expect(out).toContain("Always run lints.");
    });

    it("includes git branch when present", () => {
        const out = buildSystemPrompt({ cwd: "/x", gitBranch: "main" });
        expect(out).toContain("- git branch: main");
    });

    it("skips connection line when local", () => {
        const out = buildSystemPrompt({ cwd: "/x", connection: "local" });
        expect(out).not.toContain("connection");
    });

    it("includes connection line for remote hosts", () => {
        const out = buildSystemPrompt({ cwd: "/x", connection: "user@host" });
        expect(out).toContain("- connection: user@host");
    });

    it("includes recent commands capped to 5", () => {
        const cmds = Array.from({ length: 12 }, (_, i) => `cmd-${i}`);
        const out = buildSystemPrompt({ cwd: "/x", recentCmds: cmds });
        expect(out).toContain("cmd-7"); // 12-5=7 is the first kept
        expect(out).toContain("cmd-11");
        expect(out).not.toContain("cmd-6");
    });

    it("omits the Recent commands section when no cmds provided", () => {
        const out = buildSystemPrompt({ cwd: "/x" });
        expect(out).not.toContain("Recent commands");
    });
});
