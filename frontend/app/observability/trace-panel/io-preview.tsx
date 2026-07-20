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
    copyScopeKey: string;
}

export function IOPreview({
    label,
    value,
    maxPreviewCharacters = DetailPreviewCharacterLimit,
    copyScopeKey,
}: IOPreviewProps) {
    const preview = useMemo(
        () =>
            value == null
                ? { text: "", truncated: false }
                : formatDetailPreview(value, { maxCharacters: maxPreviewCharacters }),
        [maxPreviewCharacters, value]
    );
    const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
    const copyOperationToken = useRef(0);
    const currentCopy = useRef({ value, label, copyScopeKey });
    currentCopy.current = { value, label, copyScopeKey };

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
        const copy = { value, label, copyScopeKey };
        const copyIsCurrent = () =>
            operationToken === copyOperationToken.current &&
            copy.value === currentCopy.current.value &&
            copy.label === currentCopy.current.label &&
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
        <DetailSection
            label={label}
            action={<DetailCopyButton label={label} status={copyStatus} onCopy={() => void copyValue()} />}
        >
            <DetailValue text={preview.text} truncated={preview.truncated} />
        </DetailSection>
    );
}
