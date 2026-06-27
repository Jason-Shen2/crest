// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the agent tool baseline. read/write/edit/ls/bash are
// pi-derived (cwd-bound factories); web_fetch is crest's own. web_fetch
// hits a real loopback HTTP server to stay deterministic and offline.

import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createReadTool } from "./read";
import { createWriteTool } from "./write";
import { DEFAULT_TOOL_NAMES, getDefaultTools } from "./index";
import { webFetchTool } from "./web-fetch";
import { getBashShellConfig } from "./_shell";
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

    it("returns a PNG as an image content block (base64 pass-through)", async () => {
        const png = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
            Buffer.from([0x00, 0x00, 0x00, 0x0d]), // IHDR chunk length (13)
            Buffer.from("IHDR", "ascii"),
            Buffer.alloc(13), // IHDR data
        ]);
        await fs.writeFile(path.join(tmpDir, "pic.png"), png);
        const tool = createReadTool(tmpDir);
        const result = await tool.execute("tc-1", { path: "pic.png" });
        const image = result.content.find((c) => c.type === "image") as
            | { type: "image"; data: string; mimeType: string }
            | undefined;
        expect(image).toBeDefined();
        expect(image!.mimeType).toBe("image/png");
        expect(image!.data).toBe(png.toString("base64"));
        expect(result.content[0].type).toBe("text");
        expect(text(result)).toContain("image/png");
    });

    it("returns a JPEG as an image content block", async () => {
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
        await fs.writeFile(path.join(tmpDir, "pic.jpg"), jpeg);
        const tool = createReadTool(tmpDir);
        const result = await tool.execute("tc-1", { path: "pic.jpg" });
        const image = result.content.find((c) => c.type === "image") as
            | { type: "image"; data: string; mimeType: string }
            | undefined;
        expect(image).toBeDefined();
        expect(image!.mimeType).toBe("image/jpeg");
        expect(image!.data).toBe(jpeg.toString("base64"));
    });

    it("omits an unconvertible BMP with a text-only note", async () => {
        const bmp = Buffer.alloc(70);
        bmp[0] = 0x42; // 'B'
        bmp[1] = 0x4d; // 'M'
        bmp.writeUInt32LE(70, 2); // declared file size
        bmp.writeUInt32LE(54, 10); // pixel data offset
        bmp.writeUInt32LE(40, 14); // DIB header size (BITMAPINFOHEADER)
        bmp.writeUInt16LE(1, 26); // color planes
        bmp.writeUInt16LE(24, 28); // bits per pixel
        await fs.writeFile(path.join(tmpDir, "pic.bmp"), bmp);
        const tool = createReadTool(tmpDir);
        const result = await tool.execute("tc-1", { path: "pic.bmp" });
        expect(result.content.find((c) => c.type === "image")).toBeUndefined();
        expect(result.content[0].type).toBe("text");
        expect(text(result)).toContain("image/bmp");
        expect(text(result)).toContain("omitted");
    });

    it("still reads text files when image detection misses", async () => {
        await fs.writeFile(path.join(tmpDir, "plain.txt"), "hello\nworld\n");
        const tool = createReadTool(tmpDir);
        const result = await tool.execute("tc-1", { path: "plain.txt" });
        expect(result.content.find((c) => c.type === "image")).toBeUndefined();
        expect(text(result)).toContain("hello");
    });
});

describe("write", () => {
    it("creates a new file (relative path resolved against cwd)", async () => {
        const tool = createWriteTool(tmpDir);
        const result = await tool.execute("tc-1", { path: "new.txt", content: "hello" });
        expect(await fs.readFile(path.join(tmpDir, "new.txt"), "utf8")).toBe("hello");
        expect(text(result)).toContain("5 bytes");
        expect(result.details.changeOperation).toMatchObject({
            toolCallId: "tc-1",
            kind: "create",
            path: "new.txt",
            patchStatus: "complete",
        });
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

    it("returns change operation details for review", async () => {
        await fs.writeFile(path.join(tmpDir, "review.txt"), "before\n");
        const tool = createWriteTool(tmpDir);
        const result = await tool.execute("tc-write-review", { path: "review.txt", content: "after\nextra\n" });

        expect(result.details?.changeOperation).toMatchObject({
            toolCallId: "tc-write-review",
            kind: "write",
            path: "review.txt",
            patchStatus: "complete",
            patch: result.details?.patch,
        });
        expect(result.details?.changeOperation.id).toBeTruthy();
        expect(result.details?.patch).toContain("after");
    });

    it("writes with custom operations that do not provide readFile", async () => {
        await fs.writeFile(path.join(tmpDir, "virtual.txt"), "existing-on-disk\n");
        let written = "";
        const tool = createWriteTool(tmpDir, {
            operations: {
                mkdir: async () => {},
                writeFile: async (_absolutePath, content) => {
                    written = content;
                },
            },
        });

        const result = await tool.execute("tc-write-no-read", { path: "virtual.txt", content: "new virtual\n" });

        expect(written).toBe("new virtual\n");
        expect(result.details.patch).toBeUndefined();
        expect(result.details.changeOperation).toMatchObject({
            toolCallId: "tc-write-no-read",
            kind: "write",
            path: "virtual.txt",
            patchStatus: "unavailable",
            patchUnavailableReason: "readFile unavailable",
        });
        expect(result.details.changeOperation.patch).toBeUndefined();
    });

    it("writes when custom readFile throws a non-ENOENT error", async () => {
        let written = "";
        const tool = createWriteTool(tmpDir, {
            operations: {
                mkdir: async () => {},
                readFile: async () => {
                    const error = new Error("permission denied") as Error & { code: string };
                    error.code = "EACCES";
                    throw error;
                },
                writeFile: async (_absolutePath, content) => {
                    written = content;
                },
            },
        });

        const result = await tool.execute("tc-write-read-fails", { path: "unreadable.txt", content: "still writes\n" });

        expect(written).toBe("still writes\n");
        expect(result.details.patch).toBeUndefined();
        expect(result.details.changeOperation).toMatchObject({
            toolCallId: "tc-write-read-fails",
            kind: "write",
            path: "unreadable.txt",
            patchStatus: "unavailable",
            patchUnavailableReason: "permission denied",
        });
        expect(result.details.changeOperation.patch).toBeUndefined();
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

    it("returns change operation details for review", async () => {
        await fs.writeFile(path.join(tmpDir, "review-edit.txt"), "one\ntwo\nthree\n");
        const tool = createEditTool(tmpDir);
        const result = await tool.execute("tc-edit-review", {
            path: "review-edit.txt",
            edits: [{ oldText: "two", newText: "TWO\ninserted" }],
        });

        expect(result.details?.changeOperation).toMatchObject({
            toolCallId: "tc-edit-review",
            kind: "patch",
            path: "review-edit.txt",
            patchStatus: "complete",
        });
        expect(result.details?.changeOperation.id).toBeTruthy();
        expect(result.details?.changeOperation.patch).toBe(result.details?.patch);
        expect(result.details?.changeOperation.patch).toContain("inserted");
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

describe("bash", () => {
    it("captures stdout from a simple command", async () => {
        const tool = createBashTool(tmpDir);
        const result = await tool.execute("tc-1", { command: "echo hi" });
        expect(text(result)).toContain("hi");
    });

    it("throws on non-zero exit, with the output in the message", async () => {
        const tool = createBashTool(tmpDir);
        await expect(tool.execute("tc-1", { command: "echo oops 1>&2; exit 3" })).rejects.toThrow(
            /oops[\s\S]*exited with code 3/,
        );
    });

    it("times out long-running commands (process-tree killed)", async () => {
        const tool = createBashTool(tmpDir);
        await expect(tool.execute("tc-1", { command: "sleep 30", timeout: 1 })).rejects.toThrow(/timed out/);
    }, 20_000);

    it("runs in the bound cwd", async () => {
        const tool = createBashTool(tmpDir);
        const result = await tool.execute("tc-1", { command: "pwd" });
        expect(text(result)).toContain(tmpDir);
    });

    it("streams output via onUpdate", async () => {
        const tool = createBashTool(tmpDir);
        const updates: string[] = [];
        await tool.execute("tc-1", { command: "echo streamed" }, undefined, (partial) => {
            const t = (partial.content[0] as { type: "text"; text?: string } | undefined)?.text;
            if (t) updates.push(t);
        });
        expect(updates.join("")).toContain("streamed");
    });
});

describe("getBashShellConfig", () => {
    it("uses argv transport (-c) for normal bash paths", () => {
        const config = getBashShellConfig("/bin/bash");
        expect(config).toEqual({ shell: "/bin/bash", args: ["-c"] });
        expect(config.commandTransport).toBeUndefined();
    });

    it("uses stdin transport (-s) for legacy WSL system32 bash", () => {
        const config = getBashShellConfig("C:\\Windows\\System32\\bash.exe");
        expect(config).toEqual({
            shell: "C:\\Windows\\System32\\bash.exe",
            args: ["-s"],
            commandTransport: "stdin",
        });
    });

    it("uses stdin transport for the sysnative WSL bash variant", () => {
        const config = getBashShellConfig("C:\\Windows\\Sysnative\\bash.exe");
        expect(config.commandTransport).toBe("stdin");
        expect(config.args).toEqual(["-s"]);
    });

    it("treats Git Bash (not under windows\\system32) as argv transport", () => {
        const config = getBashShellConfig("C:\\Program Files\\Git\\bin\\bash.exe");
        expect(config.commandTransport).toBeUndefined();
        expect(config.args).toEqual(["-c"]);
    });
});

describe("find", () => {
    it("matches files recursively by basename pattern", async () => {
        await fs.writeFile(path.join(tmpDir, "a.ts"), "");
        await fs.mkdir(path.join(tmpDir, "sub"));
        await fs.writeFile(path.join(tmpDir, "sub/c.ts"), "");
        await fs.writeFile(path.join(tmpDir, "note.md"), "");
        const tool = createFindTool(tmpDir);
        const result = await tool.execute("tc-1", { pattern: "*.ts" });
        const out = text(result);
        expect(out).toContain("a.ts");
        expect(out).toContain("sub/c.ts");
        expect(out).not.toContain("note.md");
    });

    it("matches a path-containing glob", async () => {
        await fs.mkdir(path.join(tmpDir, "src"));
        await fs.writeFile(path.join(tmpDir, "src/x.spec.ts"), "");
        await fs.writeFile(path.join(tmpDir, "src/x.ts"), "");
        const tool = createFindTool(tmpDir);
        const result = await tool.execute("tc-1", { pattern: "src/**/*.spec.ts" });
        expect(text(result)).toContain("src/x.spec.ts");
        expect(text(result)).not.toContain("src/x.ts\n");
    });

    it("respects .gitignore", async () => {
        await fs.writeFile(path.join(tmpDir, ".gitignore"), "ignored/\n");
        await fs.mkdir(path.join(tmpDir, "ignored"));
        await fs.writeFile(path.join(tmpDir, "ignored/secret.ts"), "");
        await fs.writeFile(path.join(tmpDir, "kept.ts"), "");
        const tool = createFindTool(tmpDir);
        const result = await tool.execute("tc-1", { pattern: "*.ts" });
        expect(text(result)).toContain("kept.ts");
        expect(text(result)).not.toContain("secret.ts");
    });

    it("returns a placeholder when nothing matches", async () => {
        const tool = createFindTool(tmpDir);
        const result = await tool.execute("tc-1", { pattern: "*.nope" });
        expect(text(result)).toContain("No files found");
    });
});

describe("grep", () => {
    it("finds matching lines with path:line:content", async () => {
        await fs.writeFile(path.join(tmpDir, "f.txt"), "alpha\nbeta\nhello world\n");
        const tool = createGrepTool(tmpDir);
        const result = await tool.execute("tc-1", { pattern: "hello" });
        expect(text(result)).toMatch(/f\.txt:3:hello world/);
    });

    it("treats the pattern as a regex unless literal is set", async () => {
        await fs.writeFile(path.join(tmpDir, "r.txt"), "a.b\naxb\n");
        const tool = createGrepTool(tmpDir);
        const asRegex = await tool.execute("tc-1", { pattern: "a.b" });
        expect(text(asRegex)).toContain("axb"); // '.' matched any char
        const asLiteral = await tool.execute("tc-1", { pattern: "a.b", literal: true });
        expect(text(asLiteral)).toContain("a.b");
        expect(text(asLiteral)).not.toContain("axb");
    });

    it("supports case-insensitive search", async () => {
        await fs.writeFile(path.join(tmpDir, "c.txt"), "HELLO\n");
        const tool = createGrepTool(tmpDir);
        const result = await tool.execute("tc-1", { pattern: "hello", ignoreCase: true });
        expect(text(result)).toContain("HELLO");
    });

    it("filters files by glob", async () => {
        await fs.writeFile(path.join(tmpDir, "x.ts"), "needle\n");
        await fs.writeFile(path.join(tmpDir, "x.md"), "needle\n");
        const tool = createGrepTool(tmpDir);
        const result = await tool.execute("tc-1", { pattern: "needle", glob: "*.ts" });
        expect(text(result)).toContain("x.ts:");
        expect(text(result)).not.toContain("x.md:");
    });

    it("includes context lines", async () => {
        await fs.writeFile(path.join(tmpDir, "ctx.txt"), "one\ntwo\nMATCH\nfour\nfive\n");
        const tool = createGrepTool(tmpDir);
        const result = await tool.execute("tc-1", { pattern: "MATCH", context: 1 });
        expect(text(result)).toContain("two");
        expect(text(result)).toContain("four");
        expect(text(result)).toMatch(/ctx\.txt:3:MATCH/);
    });

    it("returns a placeholder when nothing matches", async () => {
        await fs.writeFile(path.join(tmpDir, "empty.txt"), "nothing here\n");
        const tool = createGrepTool(tmpDir);
        const result = await tool.execute("tc-1", { pattern: "absent" });
        expect(text(result)).toContain("No matches found");
    });

    it("skips binary files", async () => {
        await fs.writeFile(path.join(tmpDir, "bin"), Buffer.from([0x68, 0x00, 0x69, 0x6e])); // has NUL
        await fs.writeFile(path.join(tmpDir, "t.txt"), "in\n");
        const tool = createGrepTool(tmpDir);
        const result = await tool.execute("tc-1", { pattern: "in" });
        expect(text(result)).toContain("t.txt:");
        expect(text(result)).not.toContain("bin:");
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
    it("getDefaultTools(cwd) returns the full tool baseline", () => {
        const tools = getDefaultTools(tmpDir);
        expect(tools.map((t) => t.name).sort()).toEqual(
            ["bash", "edit", "find", "grep", "ls", "read", "web_fetch", "write"].sort(),
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
