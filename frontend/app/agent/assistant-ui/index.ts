// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export { AssistantRuntimeProvider, useAui } from "@assistant-ui/react";
export {
    ContextReferenceBar,
    ContextReferenceDraftChip,
    ContextSendRecoveryRow,
    type ContextReferenceBarProps,
    type ContextReferenceDraftChipProps,
    type ContextSendRecoveryRowProps,
} from "./context-reference-chips";
export { getCrestImageAlt, getCrestToolRenderer } from "./crest-message";
export { MarkdownText } from "./markdown-text";
export {
    Reasoning,
    ReasoningContent,
    ReasoningFade,
    ReasoningGroup,
    ReasoningRoot,
    ReasoningText,
    ReasoningTrigger,
    reasoningVariants,
} from "./reasoning";
export { Composer, ComposerContext, Thread, type ThreadProps } from "./registry-thread";
export { createCrestAssistantRuntimeAdapter, piTurnsToAuiMessages, useCrestAssistantRuntime } from "./runtime-bridge";
export type { CrestAssistantRuntimeBridge } from "./runtime-bridge";
export { ToolGroup, ToolGroupContent, ToolGroupRoot, ToolGroupTrigger, toolGroupVariants } from "./tool-group";
export { ToolFallback } from "./tools/tool-fallback";
