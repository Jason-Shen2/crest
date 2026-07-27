// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// processImage — crest-local image normalization for the read tool.
// Mirrors the ProcessImageResult contract of pi's
// packages/coding-agent/src/utils/image-process.ts (earendil-works/pi,
// MIT) but deliberately omits pi's resize/convert paths.
//
// Deviation from pi: pi's processImage depends on Photon (WASM) for
// image-convert (non-inline formats -> PNG) and image-resize (downscale
// to inline provider limits, via worker_threads). crest avoids
// runtime WASM/native binaries, so this port only implements the
// `autoResizeImages: false` pass-through path: inline-supported formats
// (png/jpeg/gif/webp) are base64-passed through as-is; formats that
// would require conversion (e.g. bmp) are omitted with a clear message.
// TODO(edgeflow/pi): wire up resize/convert if crest later ships a
// WASM-free image codec.

export type ProcessImageResult =
    | {
          ok: true;
          data: string;
          mimeType: string;
          hints: string[];
      }
    | {
          ok: false;
          message: string;
      };

function baseMimeType(mimeType: string): string {
    return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function normalizeSupportedImageMimeType(mimeType: string): string | null {
    switch (baseMimeType(mimeType)) {
        case "image/png":
            return "image/png";
        case "image/jpeg":
        case "image/jpg":
            return "image/jpeg";
        case "image/gif":
            return "image/gif";
        case "image/webp":
            return "image/webp";
        default:
            return null;
    }
}

/**
 * Normalize image bytes for inline transmission to the model.
 *
 * Only the no-resize pass-through path is supported (see file header).
 * Inline-supported formats are returned as base64; anything that would
 * need conversion is reported as omitted.
 */
export function processImage(bytes: Uint8Array, mimeType: string): ProcessImageResult {
    const normalizedMimeType = normalizeSupportedImageMimeType(mimeType);
    if (!normalizedMimeType) {
        return {
            ok: false,
            message: "[Image omitted: could not be converted to a supported inline image format.]",
        };
    }

    return {
        ok: true,
        data: Buffer.from(bytes).toString("base64"),
        mimeType: normalizedMimeType,
        hints: [],
    };
}
