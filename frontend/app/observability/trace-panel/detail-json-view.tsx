// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useRef, useState } from "react";

import { DetailCopyButton, DetailValue, type CopyStatus } from "./detail-primitives";
import { formatDetailPreview, serializeDetailValue } from "./detail-value";

const JsonPreviewCharacterLimit = 10_000;

export function DetailJsonView({ value, copyScopeKey }: { value: unknown; copyScopeKey: string }) {
    const preview = useMemo(() => formatDetailPreview(value, { maxCharacters: JsonPreviewCharacterLimit }), [value]);
    const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
    const copyOperationToken = useRef(0);
    const currentCopy = useRef({ value, copyScopeKey });
    currentCopy.current = { value, copyScopeKey };

    useEffect(() => {
        copyOperationToken.current += 1;
        setCopyStatus("idle");
        return () => {
            copyOperationToken.current += 1;
        };
    }, [copyScopeKey, value]);

    const copyJson = async () => {
        const operationToken = ++copyOperationToken.current;
        const copy = { value, copyScopeKey };
        const copyIsCurrent = () =>
            operationToken === copyOperationToken.current &&
            copy.value === currentCopy.current.value &&
            copy.copyScopeKey === currentCopy.current.copyScopeKey;
        try {
            if (typeof navigator === "undefined" || navigator.clipboard?.writeText == null) {
                throw new Error("Clipboard API unavailable");
            }
            await navigator.clipboard.writeText(serializeDetailValue(value));
            if (copyIsCurrent()) {
                setCopyStatus("success");
            }
        } catch {
            if (copyIsCurrent()) {
                setCopyStatus("error");
            }
        }
    };

    return (
        <div className="m-3 rounded border border-border bg-fg-overlay-1/20">
            <div className="flex min-h-9 items-center justify-end border-b border-border px-3 py-2">
                <DetailCopyButton label="JSON" status={copyStatus} onCopy={() => void copyJson()} />
            </div>
            <div className="p-3">
                <DetailValue text={preview.text} truncated={preview.truncated} testId="detail-json-preview" />
            </div>
        </div>
    );
}
