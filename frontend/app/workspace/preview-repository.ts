// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { RendererRpcClient } from "@/app/store/wshrpcutil";
import { getWebServerEndpoint } from "@/util/endpoints";
import { isAbsoluteLocalPath } from "@/util/local-path";
import { base64ToArray } from "@/util/util";
import { normalizeFileTabPath } from "./workspace-content-state";

export const InlinePreviewLimit = 2 * 1024 * 1024;
export const DirectoryPreviewLimit = 1000;

export class PreviewTooLargeError extends Error {
    constructor() {
        super("Preview content exceeds the inline byte limit");
        this.name = "PreviewTooLargeError";
    }
}

export type WorkspacePreviewResult =
    | {
          path: string;
          kind: "markdown" | "text" | "csv";
          mimeType: string;
          content: string;
      }
    | {
          path: string;
          kind: "directory";
          mimeType: string;
          entries: FileInfo[];
          truncated?: boolean;
      }
    | {
          path: string;
          kind: "stream";
          mediaKind: "image" | "pdf" | "video" | "audio";
          mimeType: string;
          url: string;
      }
    | {
          path: string;
          kind: "file-only";
          mimeType: string;
          reason: "too-large" | "unsupported";
      };

export interface WorkspacePreviewFileApi {
    fileInfo(path: string): Promise<FileInfo>;
    fileList(path: string, limit: number): Promise<FileInfo[]>;
    fileRead(path: string, maxBytes: number): Promise<string>;
    getWebServerEndpoint(): string;
}

export const ProductionWorkspacePreviewFileApi: WorkspacePreviewFileApi = {
    fileInfo: (path) => RpcApi.FileInfoCommand(RendererRpcClient, { info: { path } }),
    fileList: (path, limit) => RpcApi.FileListCommand(RendererRpcClient, { path, opts: { limit } }),
    fileRead: async (path, maxBytes) => {
        const data = await RpcApi.FileReadCommand(RendererRpcClient, {
            info: { path },
            at: { offset: 0, size: maxBytes + 1 },
        });
        const bytes = data?.data64 ? base64ToArray(data.data64) : new Uint8Array();
        if (bytes.length > maxBytes) {
            throw new PreviewTooLargeError();
        }
        return new TextDecoder().decode(bytes);
    },
    getWebServerEndpoint,
};

const TextApplicationMimeTypes = new Set([
    "application/dart",
    "application/graphql",
    "application/javascript",
    "application/liquid",
    "application/sql",
    "application/typescript",
    "application/vnd.dart",
    "application/wasm",
    "application/x-awk",
    "application/x-httpd-php",
    "application/x-javascript",
    "application/x-latex",
    "application/x-pem-file",
    "application/x-php",
    "application/x-python",
    "application/x-ruby",
    "application/x-sh",
    "application/x-typescript",
]);

function inlineKind(mimeType: string, path: string): "markdown" | "text" | "csv" | undefined {
    const normalizedPath = path.toLowerCase();
    if (
        mimeType === "text/markdown" ||
        mimeType === "text/mdx" ||
        normalizedPath.endsWith(".md") ||
        normalizedPath.endsWith(".mdx")
    ) {
        return "markdown";
    }
    if (mimeType === "text/csv" || normalizedPath.endsWith(".csv")) {
        return "csv";
    }
    if (
        mimeType.startsWith("text/") ||
        TextApplicationMimeTypes.has(mimeType) ||
        (mimeType.startsWith("application/") &&
            (mimeType.includes("json") ||
                mimeType.includes("yaml") ||
                mimeType.includes("toml") ||
                mimeType.includes("xml")))
    ) {
        return "text";
    }
    return undefined;
}

function streamKind(mimeType: string): "image" | "pdf" | "video" | "audio" | undefined {
    if (mimeType.startsWith("image/")) {
        return "image";
    }
    if (mimeType === "application/pdf") {
        return "pdf";
    }
    if (mimeType.startsWith("video/")) {
        return "video";
    }
    if (mimeType.startsWith("audio/")) {
        return "audio";
    }
    return undefined;
}

const StreamMimeByExtension: Record<string, string> = {
    ".aac": "audio/aac",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".flac": "audio/flac",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".m4a": "audio/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".oga": "audio/ogg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
};

function normalizeMimeType(mimeType: string, path: string): string {
    const normalized = (mimeType || "").split(";", 1)[0].trim().toLowerCase();
    if (normalized && normalized !== "application/octet-stream") {
        return normalized;
    }
    const lowerPath = path.toLowerCase();
    const extension = Object.keys(StreamMimeByExtension).find((candidate) => lowerPath.endsWith(candidate));
    return extension ? StreamMimeByExtension[extension] : normalized || "application/octet-stream";
}

export function normalizeWorkspacePreviewPath(path: string): string {
    if (!isAbsoluteLocalPath(path)) {
        throw new Error("Preview path must be an absolute local filesystem path");
    }
    return normalizeFileTabPath(path);
}

export class WorkspacePreviewRepository {
    api: WorkspacePreviewFileApi;
    generation = 0;
    currentPath = "";
    currentResult?: WorkspacePreviewResult;

    constructor(api: WorkspacePreviewFileApi = ProductionWorkspacePreviewFileApi) {
        this.api = api;
    }

    async load(path: string): Promise<WorkspacePreviewResult> {
        const generation = ++this.generation;
        this.currentPath = "";
        this.currentResult = undefined;
        const normalizedPath = normalizeWorkspacePreviewPath(path);
        const info = await this.api.fileInfo(normalizedPath);
        if (info?.notfound) {
            throw new Error(`File not found: ${normalizedPath}`);
        }
        if (info?.staterror) {
            throw new Error(info.staterror);
        }
        const mimeType = normalizeMimeType(info?.mimetype, normalizedPath);
        let result: WorkspacePreviewResult;
        if (info?.isdir || mimeType === "directory") {
            const entries = await this.api.fileList(normalizedPath, DirectoryPreviewLimit + 1);
            const truncated = entries.length > DirectoryPreviewLimit;
            result = {
                path: normalizedPath,
                kind: "directory",
                mimeType,
                entries: entries.slice(0, DirectoryPreviewLimit),
                truncated,
            };
        } else {
            const mediaKind = streamKind(mimeType);
            const kind = inlineKind(mimeType, normalizedPath);
            const hasValidInlineSize =
                typeof info?.size === "number" &&
                Number.isFinite(info.size) &&
                info.size >= 0 &&
                info.size <= InlinePreviewLimit;
            if (mediaKind) {
                result = {
                    path: normalizedPath,
                    kind: "stream",
                    mediaKind,
                    mimeType,
                    url: `${this.api.getWebServerEndpoint()}/wave/stream-file?path=${encodeURIComponent(normalizedPath)}`,
                };
            } else if (kind && !hasValidInlineSize) {
                const reason =
                    typeof info?.size === "number" &&
                    Number.isFinite(info.size) &&
                    info.size >= 0 &&
                    info.size > InlinePreviewLimit
                        ? "too-large"
                        : "unsupported";
                result = { path: normalizedPath, kind: "file-only", mimeType, reason };
            } else if (kind && hasValidInlineSize) {
                try {
                    result = {
                        path: normalizedPath,
                        kind,
                        mimeType,
                        content: await this.api.fileRead(normalizedPath, InlinePreviewLimit),
                    };
                } catch (error) {
                    if (!(error instanceof PreviewTooLargeError)) {
                        throw error;
                    }
                    result = { path: normalizedPath, kind: "file-only", mimeType, reason: "too-large" };
                }
            } else {
                result = { path: normalizedPath, kind: "file-only", mimeType, reason: "unsupported" };
            }
        }
        if (generation === this.generation) {
            this.currentPath = normalizedPath;
            this.currentResult = result;
        }
        return result;
    }
}
