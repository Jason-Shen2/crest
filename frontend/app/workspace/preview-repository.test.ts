// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
    DirectoryPreviewLimit,
    InlinePreviewLimit,
    PreviewTooLargeError,
    ProductionWorkspacePreviewFileApi,
    WorkspacePreviewRepository,
    type WorkspacePreviewFileApi,
} from "./preview-repository";

function makeApi(info: Partial<FileInfo>, content = "hello"): WorkspacePreviewFileApi {
    return {
        fileInfo: vi.fn(async (path) => ({ path, size: content.length, mimetype: "text/plain", ...info })),
        fileList: vi.fn(async () => [{ path: "/repo/a.txt", name: "a.txt" }]),
        fileRead: vi.fn(async () => content),
        getWebServerEndpoint: () => "http://127.0.0.1:1619",
    };
}

describe("WorkspacePreviewRepository", () => {
    it("keeps workspace preview modules independent from legacy Block, TabModel, and WOS state", () => {
        for (const fileName of ["preview-repository.ts", "preview-content.tsx", "preview-top-tab.tsx"]) {
            const source = readFileSync(new URL(fileName, import.meta.url), "utf8");
            expect(source).not.toMatch(/BlockNodeModel|TabModel|store\/wos|from ["'][^"']*\/wos["']/);
        }
    });

    it.each([
        ["Text/Markdown; charset=utf-8", "markdown"],
        ["text/mdx", "markdown"],
        ["text/plain", "text"],
        ["application/json", "text"],
        ["text/csv", "csv"],
    ] as const)("classifies and reads inline %s content", async (mimeType, kind) => {
        const api = makeApi({ mimetype: mimeType });
        const result = await new WorkspacePreviewRepository(api).load("/repo/file");

        expect(result).toMatchObject({ kind, content: "hello" });
        expect(api.fileInfo).toHaveBeenCalledWith("/repo/file");
        expect(api.fileRead).toHaveBeenCalledWith("/repo/file", InlinePreviewLimit);
    });

    it("lists directories after inspecting file info", async () => {
        const api = makeApi({ isdir: true, mimetype: "directory" });
        const result = await new WorkspacePreviewRepository(api).load("/repo");

        expect(result).toMatchObject({ kind: "directory", entries: [{ name: "a.txt" }] });
        expect(api.fileList).toHaveBeenCalledWith("/repo", DirectoryPreviewLimit + 1);
        expect(api.fileRead).not.toHaveBeenCalled();
    });

    it("requests a directory sentinel and records truncation without loading the full directory", async () => {
        const api = makeApi({ isdir: true, mimetype: "directory" });
        const entries = Array.from({ length: DirectoryPreviewLimit + 1 }, (_, index) => ({
            path: `/repo/${index}.txt`,
            name: `${index}.txt`,
        }));
        vi.mocked(api.fileList).mockResolvedValueOnce(entries);

        const result = await new WorkspacePreviewRepository(api).load("/repo");

        expect(api.fileList).toHaveBeenCalledWith("/repo", DirectoryPreviewLimit + 1);
        expect(result).toMatchObject({ kind: "directory", truncated: true });
        if (result.kind !== "directory") {
            throw new Error("Expected directory result");
        }
        expect(result.entries).toHaveLength(DirectoryPreviewLimit);
    });

    it("sends the directory limit through the production FileList API", async () => {
        const list = vi.spyOn(RpcApi, "FileListCommand").mockResolvedValueOnce([]);

        await ProductionWorkspacePreviewFileApi.fileList("/repo", DirectoryPreviewLimit + 1);

        expect(list.mock.calls[0][1]).toEqual({
            path: "/repo",
            opts: { limit: DirectoryPreviewLimit + 1 },
        });
        list.mockRestore();
    });

    it.each([
        ["image/png", "image"],
        ["application/pdf", "pdf"],
        ["video/mp4", "video"],
        ["audio/mpeg", "audio"],
    ] as const)("streams %s without reading it into JavaScript", async (mimeType, mediaKind) => {
        const api = makeApi({ mimetype: mimeType });
        const result = await new WorkspacePreviewRepository(api).load("/repo/a b");

        expect(result).toEqual({
            path: "/repo/a b",
            kind: "stream",
            mediaKind,
            mimeType,
            url: "http://127.0.0.1:1619/wave/stream-file?path=%2Frepo%2Fa%20b",
        });
        expect(api.fileRead).not.toHaveBeenCalled();
    });

    it("returns file-only for text over the 2 MiB inline limit", async () => {
        const api = makeApi({ mimetype: "text/plain", size: InlinePreviewLimit + 1 });
        const result = await new WorkspacePreviewRepository(api).load("/repo/large.txt");

        expect(result).toMatchObject({ kind: "file-only", reason: "too-large" });
        expect(api.fileRead).not.toHaveBeenCalled();
    });

    it("requests one byte beyond the cap and rejects before decoding an oversized read", async () => {
        const bytes = Buffer.alloc(InlinePreviewLimit + 1, 0x61);
        const read = vi.spyOn(RpcApi, "FileReadCommand").mockResolvedValueOnce({ data64: bytes.toString("base64") });

        await expect(
            ProductionWorkspacePreviewFileApi.fileRead("/repo/race.txt", InlinePreviewLimit)
        ).rejects.toBeInstanceOf(PreviewTooLargeError);
        expect(read.mock.calls[0][1]).toEqual({
            info: { path: "/repo/race.txt" },
            at: { offset: 0, size: InlinePreviewLimit + 1 },
        });
        read.mockRestore();
    });

    it("decodes UTF-8 after applying an exact byte cap", async () => {
        const bytes = Buffer.from("😀", "utf8");
        const read = vi.spyOn(RpcApi, "FileReadCommand").mockResolvedValueOnce({ data64: bytes.toString("base64") });

        await expect(ProductionWorkspacePreviewFileApi.fileRead("/repo/utf8.txt", bytes.length)).resolves.toBe("😀");
        expect(read.mock.calls[0][1]).toEqual({
            info: { path: "/repo/utf8.txt" },
            at: { offset: 0, size: bytes.length + 1 },
        });
        read.mockRestore();
    });

    it("turns a stat/read growth race into file-only too-large", async () => {
        const api = makeApi({ mimetype: "text/plain", size: 5 });
        vi.mocked(api.fileRead).mockRejectedValueOnce(new PreviewTooLargeError());

        const result = await new WorkspacePreviewRepository(api).load("/repo/race.txt");

        expect(api.fileRead).toHaveBeenCalledWith("/repo/race.txt", InlinePreviewLimit);
        expect(result).toMatchObject({ kind: "file-only", reason: "too-large" });
    });

    it.each([
        [undefined, "unsupported"],
        [Number.NaN, "unsupported"],
        [-1, "unsupported"],
        [Number.POSITIVE_INFINITY, "unsupported"],
        [InlinePreviewLimit + 1, "too-large"],
    ] as const)("does not read text with invalid or oversized size %s", async (size, reason) => {
        const api = makeApi({ mimetype: "text/plain", size });
        const result = await new WorkspacePreviewRepository(api).load("/repo/file.txt");

        expect(result).toMatchObject({ kind: "file-only", reason });
        expect(api.fileRead).not.toHaveBeenCalled();
    });

    it.each([
        ["/repo/image.PNG", "application/octet-stream", "image", "image/png"],
        ["/repo/report.pdf", "", "pdf", "application/pdf"],
        ["/repo/movie.mp4", "APPLICATION/OCTET-STREAM", "video", "video/mp4"],
        ["/repo/song.mp3", "application/octet-stream; charset=binary", "audio", "audio/mpeg"],
    ] as const)("uses a safe stream MIME fallback for %s", async (path, mimeType, mediaKind, safeMimeType) => {
        const api = makeApi({ mimetype: mimeType, size: 10 });
        const result = await new WorkspacePreviewRepository(api).load(path);

        expect(result).toMatchObject({ kind: "stream", mediaKind, mimeType: safeMimeType });
        expect(api.fileRead).not.toHaveBeenCalled();
    });

    it.each(["relative.txt", "../escape.txt", "https://example.com/a.txt", "wsh://host/a.txt", "file:///tmp/a.txt"])(
        "rejects non-local or relative path %s before RPC",
        async (path) => {
            const api = makeApi({});
            const repository = new WorkspacePreviewRepository(api);

            await expect(repository.load(path)).rejects.toThrow("absolute local filesystem path");
            expect(api.fileInfo).not.toHaveBeenCalled();
            expect(repository.currentPath).toBe("");
            expect(repository.currentResult).toBeUndefined();
        }
    );

    it.each([
        ["/repo/../repo/a.txt", "/repo/a.txt"],
        ["C:\\repo\\folder\\..\\a.txt", "C:/repo/a.txt"],
        ["\\\\server\\share\\folder\\..\\a.txt", "//server/share/a.txt"],
    ])("normalizes absolute local path %s before RPC", async (path, normalized) => {
        const api = makeApi({ mimetype: "text/plain", size: 5 });
        const result = await new WorkspacePreviewRepository(api).load(path);

        expect(api.fileInfo).toHaveBeenCalledWith(normalized);
        expect(result.path).toBe(normalized);
    });

    it("returns file-only for unsupported files without reading them", async () => {
        const api = makeApi({ mimetype: "application/octet-stream" });
        const result = await new WorkspacePreviewRepository(api).load("/repo/archive.bin");

        expect(result).toMatchObject({ kind: "file-only", reason: "unsupported" });
        expect(api.fileRead).not.toHaveBeenCalled();
    });

    it("reports missing files", async () => {
        const api = makeApi({ notfound: true });

        await expect(new WorkspacePreviewRepository(api).load("/repo/missing")).rejects.toThrow(
            "File not found: /repo/missing"
        );
        expect(api.fileRead).not.toHaveBeenCalled();
    });

    it("fences stale loads from the current path and result", async () => {
        let resolveFirst: (value: FileInfo) => void;
        const firstInfo = new Promise<FileInfo>((resolve) => {
            resolveFirst = resolve;
        });
        const api = makeApi({});
        vi.mocked(api.fileInfo)
            .mockImplementationOnce(async () => firstInfo)
            .mockResolvedValueOnce({ path: "/repo/image.png", mimetype: "image/png", size: 10 });
        const repository = new WorkspacePreviewRepository(api);

        const first = repository.load("/repo/readme.md");
        const second = repository.load("/repo/image.png");
        await second;
        resolveFirst({ path: "/repo/readme.md", mimetype: "text/markdown", size: 5 });
        await first;

        expect(repository.currentPath).toBe("/repo/image.png");
        expect(repository.currentResult).toMatchObject({ path: "/repo/image.png", kind: "stream" });
    });

    it("clears the newest current state immediately and leaves it empty on failure", async () => {
        let rejectInfo: (error: Error) => void;
        const nextInfo = new Promise<FileInfo>((_, reject) => {
            rejectInfo = reject;
        });
        const api = makeApi({ mimetype: "image/png" });
        const repository = new WorkspacePreviewRepository(api);
        await repository.load("/repo/first.png");
        vi.mocked(api.fileInfo).mockImplementationOnce(async () => nextInfo);

        const next = repository.load("/repo/next.png");
        expect(repository.currentPath).toBe("");
        expect(repository.currentResult).toBeUndefined();
        rejectInfo(new Error("stat failed"));
        await expect(next).rejects.toThrow("stat failed");
        expect(repository.currentPath).toBe("");
        expect(repository.currentResult).toBeUndefined();
    });

    it("does not let an older failure clear a newer success", async () => {
        let rejectFirst: (error: Error) => void;
        const firstInfo = new Promise<FileInfo>((_, reject) => {
            rejectFirst = reject;
        });
        const api = makeApi({});
        vi.mocked(api.fileInfo)
            .mockImplementationOnce(async () => firstInfo)
            .mockResolvedValueOnce({ path: "/repo/image.png", mimetype: "image/png", size: 10 });
        const repository = new WorkspacePreviewRepository(api);

        const first = repository.load("/repo/old.txt");
        await repository.load("/repo/image.png");
        rejectFirst(new Error("old failed"));
        await expect(first).rejects.toThrow("old failed");

        expect(repository.currentPath).toBe("/repo/image.png");
        expect(repository.currentResult).toMatchObject({ path: "/repo/image.png", kind: "stream" });
    });
});
