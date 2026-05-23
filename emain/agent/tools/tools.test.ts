// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the v1 tool baseline. web_fetch hits a real loopback
// HTTP server to keep the test deterministic and offline.

import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_TOOL_NAMES, getDefaultTools } from "./index";
import { listDirTool } from "./list-dir";
import { multiEditTool } from "./multi-edit";
import { readFileTool } from "./read-file";
import { shellExecTool } from "./shell-exec";
import { webFetchTool } from "./web-fetch";
import { writeFileTool } from "./write-file";
import { expandHome, requireAbsolute } from "./_paths";

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "crest-tools-test-"));
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

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
});

describe("read_file", () => {
    it("reads a small file end-to-end", async () => {
        const file = path.join(tmpDir, "hello.txt");
        await fs.writeFile(file, "line 1\nline 2\nline 3\n");
        const result = await readFileTool.execute("tc-1", { filename: file });
        expect((result.content[0] as { type: "text"; text: string }).text).toContain("line 1");
        expect((result.content[0] as { type: "text"; text: string }).text).toContain("line 3");
        expect(result.details.linesReturned).toBeGreaterThan(0);
    });

    it("respects offset + limit", async () => {
        const file = path.join(tmpDir, "many.txt");
        await fs.writeFile(file, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
        const result = await readFileTool.execute("tc-1", { filename: file, offset: 50, limit: 5 });
        expect((result.content[0] as { type: "text"; text: string }).text).toBe("line 50\nline 51\nline 52\nline 53\nline 54");
        expect(result.details.linesReturned).toBe(5);
        expect(result.details.truncated).toBe(true);
    });

    it("rejects non-absolute paths", async () => {
        await expect(readFileTool.execute("tc-1", { filename: "relative.txt" })).rejects.toThrow(
            /absolute/,
        );
    });
});

describe("write_file", () => {
    it("creates a new file in an existing dir", async () => {
        const file = path.join(tmpDir, "new.txt");
        const result = await writeFileTool.execute("tc-1", { filename: file, content: "hello" });
        expect(await fs.readFile(file, "utf8")).toBe("hello");
        expect(result.details.created).toBe(true);
        expect(result.details.bytesWritten).toBe(5);
    });

    it("creates parent directories on demand", async () => {
        const file = path.join(tmpDir, "nested/deep/path/x.txt");
        await writeFileTool.execute("tc-1", { filename: file, content: "y" });
        expect(await fs.readFile(file, "utf8")).toBe("y");
    });

    it("overwrites existing content", async () => {
        const file = path.join(tmpDir, "ex.txt");
        await fs.writeFile(file, "before");
        const result = await writeFileTool.execute("tc-1", { filename: file, content: "after" });
        expect(await fs.readFile(file, "utf8")).toBe("after");
        expect(result.details.created).toBe(false);
    });
});

describe("multi_edit", () => {
    it("applies a single unique replacement", async () => {
        const file = path.join(tmpDir, "code.ts");
        await fs.writeFile(file, "const x = 1;\nconst y = 2;\n");
        await multiEditTool.execute("tc-1", {
            filename: file,
            edits: [{ oldString: "const x = 1;", newString: "const x = 42;" }],
        });
        expect(await fs.readFile(file, "utf8")).toBe("const x = 42;\nconst y = 2;\n");
    });

    it("applies edits in order, each seeing the previous result", async () => {
        const file = path.join(tmpDir, "chain.txt");
        await fs.writeFile(file, "A B C");
        await multiEditTool.execute("tc-1", {
            filename: file,
            edits: [
                { oldString: "A", newString: "X" },
                { oldString: "X B", newString: "Y" }, // depends on first edit's result
            ],
        });
        expect(await fs.readFile(file, "utf8")).toBe("Y C");
    });

    it("throws when oldString isn't unique and replaceAll is false", async () => {
        const file = path.join(tmpDir, "dup.txt");
        await fs.writeFile(file, "x\nx\nx\n");
        await expect(
            multiEditTool.execute("tc-1", {
                filename: file,
                edits: [{ oldString: "x", newString: "y" }],
            }),
        ).rejects.toThrow(/matches/);
    });

    it("handles replaceAll across multiple occurrences", async () => {
        const file = path.join(tmpDir, "rep.txt");
        await fs.writeFile(file, "x\nx\nx\n");
        await multiEditTool.execute("tc-1", {
            filename: file,
            edits: [{ oldString: "x", newString: "y", replaceAll: true }],
        });
        expect(await fs.readFile(file, "utf8")).toBe("y\ny\ny\n");
    });

    it("does not write anything when any edit fails", async () => {
        const file = path.join(tmpDir, "atomic.txt");
        await fs.writeFile(file, "alpha\nbeta\n");
        const original = await fs.readFile(file, "utf8");
        await expect(
            multiEditTool.execute("tc-1", {
                filename: file,
                edits: [
                    { oldString: "alpha", newString: "ALPHA" },
                    { oldString: "missing", newString: "X" },
                ],
            }),
        ).rejects.toThrow(/not found/);
        expect(await fs.readFile(file, "utf8")).toBe(original);
    });
});

describe("list_dir", () => {
    it("lists entries with type markers", async () => {
        await fs.writeFile(path.join(tmpDir, "a.txt"), "x");
        await fs.mkdir(path.join(tmpDir, "subdir"));
        const result = await listDirTool.execute("tc-1", { path: tmpDir });
        expect((result.content[0] as { type: "text"; text: string }).text).toContain("file    a.txt");
        expect((result.content[0] as { type: "text"; text: string }).text).toContain("dir     subdir");
    });

    it("respects maxEntries cap and signals truncation", async () => {
        for (let i = 0; i < 10; i++) await fs.writeFile(path.join(tmpDir, `f${i}.txt`), "");
        const result = await listDirTool.execute("tc-1", { path: tmpDir, maxEntries: 3 });
        expect(result.details.entriesReturned).toBe(3);
        expect(result.details.truncated).toBe(true);
        expect((result.content[0] as { type: "text"; text: string }).text).toContain("more entries truncated");
    });

    it("returns a placeholder for an empty directory", async () => {
        const result = await listDirTool.execute("tc-1", { path: tmpDir });
        expect((result.content[0] as { type: "text"; text: string }).text).toContain("(empty");
    });
});

describe("shell_exec", () => {
    it("captures stdout and exit code from a simple command", async () => {
        const result = await shellExecTool.execute("tc-1", { command: "echo hi" });
        expect((result.content[0] as { type: "text"; text: string }).text).toContain("hi");
        expect(result.details.exitCode).toBe(0);
    });

    it("captures stderr and non-zero exit", async () => {
        const result = await shellExecTool.execute("tc-1", {
            command: "echo oops 1>&2; exit 3",
        });
        expect((result.content[0] as { type: "text"; text: string }).text).toContain("oops");
        expect(result.details.exitCode).toBe(3);
    });

    it("times out long-running commands", async () => {
        const result = await shellExecTool.execute("tc-1", {
            command: "sleep 5",
            timeoutMs: 200,
        });
        expect(result.details.timedOut).toBe(true);
    }, 5_000);

    it("respects the cwd parameter", async () => {
        const result = await shellExecTool.execute("tc-1", {
            command: "pwd",
            cwd: tmpDir,
        });
        expect((result.content[0] as { type: "text"; text: string }).text).toContain(tmpDir);
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
        expect((result.content[0] as { type: "text"; text: string }).text).toContain("hello from server");
        expect(result.details.status).toBe(200);
    });

    it("includes content-type in metadata", async () => {
        const result = await webFetchTool.execute("tc-1", { url: `${baseUrl}/json` });
        expect(result.details.contentType).toContain("application/json");
    });

    it("rejects non-http(s) URLs", async () => {
        await expect(webFetchTool.execute("tc-1", { url: "file:///etc/passwd" })).rejects.toThrow(
            /http/,
        );
    });

    it("truncates large bodies", async () => {
        const result = await webFetchTool.execute("tc-1", { url: `${baseUrl}/big` });
        expect(result.details.truncated).toBe(true);
        expect(result.details.bytesReturned).toBeLessThanOrEqual(1_000_000);
    });
});

describe("tools registry", () => {
    it("getDefaultTools returns all 6 v1 tools", () => {
        const tools = getDefaultTools();
        expect(tools.map((t) => t.name).sort()).toEqual(
            ["list_dir", "multi_edit", "read_file", "shell_exec", "web_fetch", "write_file"].sort(),
        );
    });

    it("DEFAULT_TOOL_NAMES matches getDefaultTools", () => {
        const tools = getDefaultTools();
        expect(new Set(tools.map((t) => t.name))).toEqual(new Set(DEFAULT_TOOL_NAMES));
    });

    it("every default tool declares name, label, description, parameters", () => {
        for (const tool of getDefaultTools()) {
            expect(tool.name).toBeTruthy();
            expect(tool.label).toBeTruthy();
            expect(tool.description).toBeTruthy();
            expect(tool.parameters).toBeDefined();
        }
    });
});
