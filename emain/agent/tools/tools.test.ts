// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the agent tool baseline. The read/write/edit/ls tools
// are pi-derived (cwd-bound factories); shell_exec + web_fetch are
// crest's own. web_fetch hits a real loopback HTTP server to stay
// deterministic and offline.

import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEditTool } from "./edit";
import { createLsTool } from "./ls";
import { createReadTool } from "./read";
import { createWriteTool } from "./write";
import { DEFAULT_TOOL_NAMES, getDefaultTools } from "./index";
import { shellExecTool } from "./shell-exec";
import { webFetchTool } from "./web-fetch";
import { expandHome, requireAbsolute, resolveToCwd } from "./_paths";

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "crest-tools-test-"));
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
    return (result.content[0] as { type: "text"; text: string }).text;
}

describe("_paths", () => {
    it("expandHome leaves absolute paths alone", () => {
        expect(expandHome("/tmp/x")).toBe("/tmp/x");
        expect(expandHome("/")).toBe("/");
    });

    it("expandHome replaces ~ and ~/...", () => {
        expect(expandHome("~")).toBe(os.homedir());
        expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"));
    });

    it("requireAbsolute rejects relative paths", () => {
        expect(() => requireAbsolute("relative/x", "t")).toThrow(/absolute/);
    });

    it("requireAbsolute accepts ~-prefixed paths after expansion", () => {
        expect(requireAbsolute("~/x", "t")).toBe(path.join(os.homedir(), "x"));
    });

    it("resolveToCwd resolves relative paths against cwd", () => {
        expect(resolveToCwd("a/b.txt", "/work")).toBe(path.resolve("/work", "a/b.txt"));
        expect(resolveToCwd("/abs/x", "/work")).toBe(path.resolve("/abs/x"));
    });
});

describe("read", () => {
    it("reads a file via a cwd-relative path", async () => {
        await fs.writeFile(path.join(tmpDir, "hello.txt"), "line 1\nline 2\nline 3\n");
        const tool = createReadTool(tmpDir);
        const result = await tool.execute("tc-1", { path: "hello.txt" });
        expect(text(result)).toContain("line 1");
        expect(text(result)).toContain("line 3");
    });

    it("respects offset + limit and points at the next offset", async () => {
        await fs.writeFile(
            path.join(tmpDir, "many.txt"),
            Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"),
        );
        const tool = createReadTool(tmpDir);
        const result = await tool.execute("tc-1", { path: "many.txt", offset: 50, limit: 5 });
        expect(text(result)).toContain("line 50");
        expect(text(result)).toContain("line 54");
        expect(text(result)).not.toContain("line 55\n");
        expect(text(result)).toContain("offset=55");
    });

    it("throws when offset is beyond end of file", async () => {
        await fs.writeFile(path.join(tmpDir, "short.txt"), "a\nb\n");
        const tool = createReadTool(tmpDir);
        await expect(tool.execute("tc-1", { path: "short.txt", offset: 999 })).rejects.toThrow(/beyond end/);
    });
});

describe("write", () => {
    it("creates a new file (relative path resolved against cwd)", async () => {
        const tool = createWriteTool(tmpDir);
        const result = await tool.execute("tc-1", { path: "new.txt", content: "hello" });
        expect(await fs.readFile(path.join(tmpDir, "new.txt"), "utf8")).toBe("hello");
        expect(text(result)).toContain("5 bytes");
    });

    it("creates parent directories on demand", async () => {
        const tool = createWriteTool(tmpDir);
        await tool.execute("tc-1", { path: "nested/deep/path/x.txt", content: "y" });
        expect(await fs.readFile(path.join(tmpDir, "nested/deep/path/x.txt"), "utf8")).toBe("y");
    });

    it("overwrites existing content", async () => {
        await fs.writeFile(path.join(tmpDir, "ex.txt"), "before");
        const tool = createWriteTool(tmpDir);
        await tool.execute("tc-1", { path: "ex.txt", content: "after" });
        expect(await fs.readFile(path.join(tmpDir, "ex.txt"), "utf8")).toBe("after");
    });
});

describe("edit", () => {
    it("applies a single unique replacement", async () => {
        await fs.writeFile(path.join(tmpDir, "code.ts"), "const x = 1;\nconst y = 2;\n");
        const tool = createEditTool(tmpDir);
        await tool.execute("tc-1", {
            path: "code.ts",
            edits: [{ oldText: "const x = 1;", newText: "const x = 42;" }],
        });
        expect(await fs.readFile(path.join(tmpDir, "code.ts"), "utf8")).toBe("const x = 42;\nconst y = 2;\n");
    });

    it("applies multiple disjoint edits matched against the original", async () => {
        await fs.writeFile(path.join(tmpDir, "multi.txt"), "alpha\nbeta\ngamma\n");
        const tool = createEditTool(tmpDir);
        await tool.execute("tc-1", {
            path: "multi.txt",
            edits: [
                { oldText: "alpha", newText: "A" },
                { oldText: "gamma", newText: "G" },
            ],
        });
        expect(await fs.readFile(path.join(tmpDir, "multi.txt"), "utf8")).toBe("A\nbeta\nG\n");
    });

    it("throws when oldText is not unique", async () => {
        await fs.writeFile(path.join(tmpDir, "dup.txt"), "x\nx\nx\n");
        const tool = createEditTool(tmpDir);
        await expect(
            tool.execute("tc-1", { path: "dup.txt", edits: [{ oldText: "x", newText: "y" }] }),
        ).rejects.toThrow(/occurrences|unique/i);
    });

    it("does not write anything when any edit fails to match", async () => {
        await fs.writeFile(path.join(tmpDir, "atomic.txt"), "alpha\nbeta\n");
        const original = await fs.readFile(path.join(tmpDir, "atomic.txt"), "utf8");
        const tool = createEditTool(tmpDir);
        await expect(
            tool.execute("tc-1", {
                path: "atomic.txt",
                edits: [
                    { oldText: "alpha", newText: "ALPHA" },
                    { oldText: "missing", newText: "X" },
                ],
            }),
        ).rejects.toThrow(/Could not find/i);
        expect(await fs.readFile(path.join(tmpDir, "atomic.txt"), "utf8")).toBe(original);
    });

    it("preserves CRLF line endings", async () => {
        await fs.writeFile(path.join(tmpDir, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
        const tool = createEditTool(tmpDir);
        await tool.execute("tc-1", { path: "crlf.txt", edits: [{ oldText: "two", newText: "TWO" }] });
        expect(await fs.readFile(path.join(tmpDir, "crlf.txt"), "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
    });

    it("returns a diff in details", async () => {
        await fs.writeFile(path.join(tmpDir, "d.txt"), "hello\nworld\n");
        const tool = createEditTool(tmpDir);
        const result = await tool.execute("tc-1", {
            path: "d.txt",
            edits: [{ oldText: "world", newText: "there" }],
        });
        expect(result.details?.diff).toContain("there");
        expect(result.details?.patch).toContain("@@");
    });
});

describe("ls", () => {
    it("lists entries sorted, with '/' suffix for directories", async () => {
        await fs.writeFile(path.join(tmpDir, "a.txt"), "x");
        await fs.mkdir(path.join(tmpDir, "subdir"));
        const tool = createLsTool(tmpDir);
        const result = await tool.execute("tc-1", { path: "." });
        expect(text(result)).toContain("a.txt");
        expect(text(result)).toContain("subdir/");
    });

    it("respects the entry limit and signals it", async () => {
        for (let i = 0; i < 10; i++) await fs.writeFile(path.join(tmpDir, `f${i}.txt`), "");
        const tool = createLsTool(tmpDir);
        const result = await tool.execute("tc-1", { path: ".", limit: 3 });
        expect(result.details?.entryLimitReached).toBe(3);
        expect(text(result)).toContain("entries limit reached");
    });

    it("returns a placeholder for an empty directory", async () => {
        const tool = createLsTool(tmpDir);
        const result = await tool.execute("tc-1", { path: "." });
        expect(text(result)).toContain("(empty");
    });

    it("throws for a non-directory", async () => {
        await fs.writeFile(path.join(tmpDir, "file.txt"), "x");
        const tool = createLsTool(tmpDir);
        await expect(tool.execute("tc-1", { path: "file.txt" })).rejects.toThrow(/Not a directory/);
    });
});

describe("shell_exec", () => {
    it("captures stdout and exit code from a simple command", async () => {
        const result = await shellExecTool.execute("tc-1", { command: "echo hi" });
        expect(text(result)).toContain("hi");
        expect(result.details.exitCode).toBe(0);
    });

    it("captures stderr and non-zero exit", async () => {
        const result = await shellExecTool.execute("tc-1", { command: "echo oops 1>&2; exit 3" });
        expect(text(result)).toContain("oops");
        expect(result.details.exitCode).toBe(3);
    });

    it("times out long-running commands", async () => {
        const result = await shellExecTool.execute("tc-1", { command: "sleep 5", timeoutMs: 200 });
        expect(result.details.timedOut).toBe(true);
        // shell-exec floors timeoutMs at 1000ms and allows a 2000ms
        // SIGKILL grace after SIGTERM, so worst case is ~3s + spawn
        // overhead. The generous vitest budget keeps this from flaking
        // on loaded CI runners (it's ~1s locally).
    }, 20_000);

    it("respects the cwd parameter", async () => {
        const result = await shellExecTool.execute("tc-1", { command: "pwd", cwd: tmpDir });
        expect(text(result)).toContain(tmpDir);
    });
});

describe("web_fetch", () => {
    let server: Server;
    let baseUrl: string;

    beforeEach(async () => {
        await new Promise<void>((resolve) => {
            server = createServer((req, res) => {
                if (req.url === "/ok") {
                    res.writeHead(200, { "content-type": "text/plain" });
                    res.end("hello from server");
                } else if (req.url === "/json") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ greeting: "hi" }));
                } else if (req.url === "/big") {
                    res.writeHead(200, { "content-type": "text/plain" });
                    res.end("x".repeat(2_000_000));
                } else {
                    res.writeHead(404);
                    res.end("nope");
                }
            }).listen(0, "127.0.0.1", () => resolve());
        });
        const addr = server.address();
        if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(() => {
        server.close();
    });

    it("returns body text on 200", async () => {
        const result = await webFetchTool.execute("tc-1", { url: `${baseUrl}/ok` });
        expect(text(result)).toContain("hello from server");
        expect(result.details.status).toBe(200);
    });

    it("includes content-type in metadata", async () => {
        const result = await webFetchTool.execute("tc-1", { url: `${baseUrl}/json` });
        expect(result.details.contentType).toContain("application/json");
    });

    it("rejects non-http(s) URLs", async () => {
        await expect(webFetchTool.execute("tc-1", { url: "file:///etc/passwd" })).rejects.toThrow(/http/);
    });

    it("truncates large bodies", async () => {
        const result = await webFetchTool.execute("tc-1", { url: `${baseUrl}/big` });
        expect(result.details.truncated).toBe(true);
        expect(result.details.bytesReturned).toBeLessThanOrEqual(1_000_000);
    });
});

describe("tools registry", () => {
    it("getDefaultTools(cwd) returns the 6-tool baseline", () => {
        const tools = getDefaultTools(tmpDir);
        expect(tools.map((t) => t.name).sort()).toEqual(
            ["edit", "ls", "read", "shell_exec", "web_fetch", "write"].sort(),
        );
    });

    it("DEFAULT_TOOL_NAMES matches getDefaultTools", () => {
        const tools = getDefaultTools(tmpDir);
        expect(new Set(tools.map((t) => t.name))).toEqual(new Set(DEFAULT_TOOL_NAMES));
    });

    it("every default tool declares name, label, description, parameters", () => {
        for (const tool of getDefaultTools(tmpDir)) {
            expect(tool.name).toBeTruthy();
            expect(tool.label).toBeTruthy();
            expect(tool.description).toBeTruthy();
            expect(tool.parameters).toBeDefined();
        }
    });
});
