// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse IOPreview.

import { useEffect, useMemo, useRef, useState } from "react";

import { DetailCopyButton, DetailSection, DetailValue, type CopyStatus } from "./detail-primitives";
import { formatDetailPreview, serializeDetailValue } from "./detail-value";

const DetailPreviewCharacterLimit = 10_000;

export interface IOPreviewProps {
    label: string;
    value: unknown;
    maxPreviewCharacters?: number;
    copyScopeKey?: string;
}

export function IOPreview({
    label,
    value,
    maxPreviewCharacters = DetailPreviewCharacterLimit,
    copyScopeKey,
}: IOPreviewProps) {
    const serialized = useMemo(() => (value == null ? "" : serializeDetailValue(value)), [value]);
    const preview = useMemo(
        () =>
            value == null
                ? { text: "", truncated: false }
                : formatDetailPreview(value, { maxCharacters: maxPreviewCharacters }),
        [maxPreviewCharacters, value]
    );
    const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
    const copyOperationToken = useRef(0);
    const currentSerialized = useRef(serialized);
    currentSerialized.current = serialized;

    useEffect(() => {
        copyOperationToken.current += 1;
        setCopyStatus("idle");
        return () => {
            copyOperationToken.current += 1;
        };
    }, [copyScopeKey, label, value]);

    if (value == null) {
        return null;
    }

    const copyValue = async () => {
        const operationToken = ++copyOperationToken.current;
        try {
            if (typeof navigator === "undefined" || navigator.clipboard?.writeText == null) {
                throw new Error("Clipboard API unavailable");
            }
            await navigator.clipboard.writeText(serialized);
            if (operationToken === copyOperationToken.current && serialized === currentSerialized.current) {
                setCopyStatus("success");
            }
        } catch {
            if (operationToken === copyOperationToken.current && serialized === currentSerialized.current) {
                setCopyStatus("error");
            }
        }
    };

    return (
        <DetailSection
            label={label}
            action={<DetailCopyButton label={label} status={copyStatus} onCopy={() => void copyValue()} />}
        >
            <DetailValue text={preview.text} truncated={preview.truncated} />
        </DetailSection>
    );
}
