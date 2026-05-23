// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AUTO-GENERATED — do not edit by hand.
// Source:  scripts/sync-ai-models.mjs
// Upstream: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
// Fetched: 2026-05-23T19:04:32.026Z
//
// Re-run via:  task sync:models   (or  node scripts/sync-ai-models.mjs)
//
// Per-provider model lists derived from the LiteLLM registry. Curated
// provider-level entries (endpoint, apitype, token secret name, kind)
// continue to live in ai-catalog.ts; this file supplies only the
// "what models does each provider offer + with what capabilities"
// half.

import type { ApiType, Capability, ModelEntry, ReasoningLevel } from "./ai-catalog";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _GuardImports = ApiType | Capability | ReasoningLevel;

export const MODELS_BY_PROVIDER: Record<string, ModelEntry[]> = {
    "openai": [
        {
            "id": "chatgpt-4o-latest",
            "displayName": "Chatgpt 4o Latest",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 128000
        },
        {
            "id": "gpt-3.5-turbo",
            "displayName": "GPT-3.5-Turbo",
            "capabilities": [
                "tools"
            ],
            "contextWindow": 16385,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-3.5-turbo-0125",
            "displayName": "GPT-3.5-Turbo-0125",
            "capabilities": [
                "tools"
            ],
            "contextWindow": 16385,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-3.5-turbo-1106",
            "displayName": "GPT-3.5-Turbo-1106",
            "capabilities": [
                "tools"
            ],
            "contextWindow": 16385,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-3.5-turbo-16k",
            "displayName": "GPT-3.5-Turbo-16k",
            "capabilities": [],
            "contextWindow": 16385,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4",
            "displayName": "GPT-4",
            "capabilities": [
                "tools"
            ],
            "contextWindow": 8192,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4-0125-preview",
            "displayName": "GPT-4-0125-Preview",
            "capabilities": [
                "tools"
            ],
            "contextWindow": 128000,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4-0314",
            "displayName": "GPT 4.0314",
            "capabilities": [],
            "contextWindow": 8192,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4-0613",
            "displayName": "GPT 4.0613",
            "capabilities": [
                "tools"
            ],
            "contextWindow": 8192,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4-1106-preview",
            "displayName": "GPT-4-1106-Preview",
            "capabilities": [
                "tools"
            ],
            "contextWindow": 128000,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4-turbo",
            "displayName": "GPT-4-Turbo",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 128000,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4-turbo-preview",
            "displayName": "GPT-4-Turbo-Preview",
            "capabilities": [
                "tools"
            ],
            "contextWindow": 128000,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4.1",
            "displayName": "GPT-4.1",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 1047576,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4.1-mini",
            "displayName": "GPT-4.1-Mini",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 1047576,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4.1-nano",
            "displayName": "GPT-4.1-Nano",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 1047576,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4o",
            "displayName": "GPT-4o",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 128000,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4o-mini",
            "displayName": "GPT-4o-Mini",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 128000,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4o-mini-search-preview",
            "displayName": "GPT-4o-Mini-Search-Preview",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 128000,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-4o-search-preview",
            "displayName": "GPT-4o-Search-Preview",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 128000,
            "apiTypeOverride": "openai-chat"
        },
        {
            "id": "gpt-5",
            "displayName": "GPT-5",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 272000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5-chat",
            "displayName": "GPT-5-Chat",
            "capabilities": [
                "images",
                "reasoning"
            ],
            "contextWindow": 128000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5-chat-latest",
            "displayName": "GPT-5-Chat-Latest",
            "capabilities": [
                "images",
                "reasoning"
            ],
            "contextWindow": 128000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5-mini",
            "displayName": "GPT-5-Mini",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 272000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5-nano",
            "displayName": "GPT-5-Nano",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 272000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5.1",
            "displayName": "GPT-5.1",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 272000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5.1-chat-latest",
            "displayName": "GPT-5.1-Chat-Latest",
            "capabilities": [
                "images",
                "reasoning"
            ],
            "contextWindow": 128000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5.2",
            "displayName": "GPT-5.2",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 272000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5.2-chat-latest",
            "displayName": "GPT-5.2-Chat-Latest",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 128000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5.3-chat-latest",
            "displayName": "GPT-5.3-Chat-Latest",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 128000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5.4",
            "displayName": "GPT-5.4",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1050000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5.4-mini",
            "displayName": "GPT-5.4-Mini",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 272000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5.4-nano",
            "displayName": "GPT-5.4-Nano",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 272000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gpt-5.5",
            "displayName": "GPT-5.5",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1050000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "o1",
            "displayName": "o1",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "o3",
            "displayName": "o3",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "o3-mini",
            "displayName": "o3 Mini",
            "capabilities": [
                "tools",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "o4-mini",
            "displayName": "o4 Mini",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        }
    ],
    "anthropic": [
        {
            "id": "claude-3-7-sonnet-20250219",
            "displayName": "Claude 3 7 Sonnet 20250219",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-3-haiku-20240307",
            "displayName": "Claude 3 Haiku 20240307",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 200000
        },
        {
            "id": "claude-3-opus-20240229",
            "displayName": "Claude 3 Opus 20240229",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 200000
        },
        {
            "id": "claude-4-opus-20250514",
            "displayName": "Claude 4 Opus 20250514",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-4-sonnet-20250514",
            "displayName": "Claude 4 Sonnet 20250514",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1000000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-haiku-4-5",
            "displayName": "Claude Haiku 4.5",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-opus-4-1",
            "displayName": "Claude Opus 4.1",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-opus-4-20250514",
            "displayName": "Claude Opus 4.20250514",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-opus-4-5",
            "displayName": "Claude Opus 4.5",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-opus-4-6",
            "displayName": "Claude Opus 4.6",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1000000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-opus-4-7",
            "displayName": "Claude Opus 4.7",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1000000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-sonnet-4-20250514",
            "displayName": "Claude Sonnet 4.20250514",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1000000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-sonnet-4-5",
            "displayName": "Claude Sonnet 4.5",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 200000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "claude-sonnet-4-6",
            "displayName": "Claude Sonnet 4.6",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1000000,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        }
    ],
    "google": [
        {
            "id": "gemini-2.0-flash",
            "displayName": "Gemini 2.0 Flash",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 1048576
        },
        {
            "id": "gemini-2.0-flash-001",
            "displayName": "Gemini 2.0 Flash 001",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 1048576
        },
        {
            "id": "gemini-2.0-flash-lite",
            "displayName": "Gemini 2.0 Flash Lite",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 1048576
        },
        {
            "id": "gemini-2.0-flash-lite-001",
            "displayName": "Gemini 2.0 Flash Lite 001",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 1048576
        },
        {
            "id": "gemini-2.5-computer-use-preview-10-2025",
            "displayName": "Gemini 2.5 Computer Use Preview 10.2025",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 128000
        },
        {
            "id": "gemini-2.5-flash",
            "displayName": "Gemini 2.5 Flash",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-2.5-flash-lite",
            "displayName": "Gemini 2.5 Flash Lite",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-2.5-flash-lite-preview-06-17",
            "displayName": "Gemini 2.5 Flash Lite Preview 06.17",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-2.5-flash-lite-preview-09-2025",
            "displayName": "Gemini 2.5 Flash Lite Preview 09.2025",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-2.5-flash-preview-09-2025",
            "displayName": "Gemini 2.5 Flash Preview 09.2025",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-2.5-pro",
            "displayName": "Gemini 2.5 Pro",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-3-flash-preview",
            "displayName": "Gemini 3 Flash Preview",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-3-pro-preview",
            "displayName": "Gemini 3 Pro Preview",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-3.1-flash-lite",
            "displayName": "Gemini 3.1 Flash Lite",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-3.1-flash-lite-preview",
            "displayName": "Gemini 3.1 Flash Lite Preview",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-3.1-flash-live-preview",
            "displayName": "Gemini 3.1 Flash Live Preview",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 131072
        },
        {
            "id": "gemini-3.1-flash-live-preview",
            "displayName": "Gemini 3.1 Flash Live Preview",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 131072
        },
        {
            "id": "gemini-3.1-pro-preview",
            "displayName": "Gemini 3.1 Pro Preview",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-3.1-pro-preview-customtools",
            "displayName": "Gemini 3.1 Pro Preview Customtools",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-3.5-flash",
            "displayName": "Gemini 3.5 Flash",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-exp-1114",
            "displayName": "Gemini Exp 1114",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 1048576
        },
        {
            "id": "gemini-exp-1206",
            "displayName": "Gemini Exp 1206",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 2097152
        },
        {
            "id": "gemini-exp-1206",
            "displayName": "Gemini Exp 1206",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-flash-latest",
            "displayName": "Gemini Flash Latest",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-flash-latest",
            "displayName": "Gemini Flash Latest",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-flash-lite-latest",
            "displayName": "Gemini Flash Lite Latest",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-flash-lite-latest",
            "displayName": "Gemini Flash Lite Latest",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-gemma-2-27b-it",
            "displayName": "Gemini Gemma 2 27b It",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 8192
        },
        {
            "id": "gemini-gemma-2-9b-it",
            "displayName": "Gemini Gemma 2 9b It",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 8192
        },
        {
            "id": "gemini-pro-latest",
            "displayName": "Gemini Pro Latest",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-pro-latest",
            "displayName": "Gemini Pro Latest",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemini-robotics-er-1.5-preview",
            "displayName": "Gemini Robotics Er 1.5 Preview",
            "capabilities": [
                "tools",
                "images",
                "reasoning"
            ],
            "contextWindow": 1048576,
            "reasoningLevels": [
                "low",
                "medium",
                "high"
            ]
        },
        {
            "id": "gemma-3-27b-it",
            "displayName": "Gemma 3 27b It",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 131072
        },
        {
            "id": "learnlm-1.5-pro-experimental",
            "displayName": "Learnlm 1.5 Pro Experimental",
            "capabilities": [
                "tools",
                "images"
            ],
            "contextWindow": 32767
        },
        {
            "id": "lyria-3-clip-preview",
            "displayName": "Lyria 3 Clip Preview",
            "capabilities": [],
            "contextWindow": 131072
        },
        {
            "id": "lyria-3-pro-preview",
            "displayName": "Lyria 3 Pro Preview",
            "capabilities": [],
            "contextWindow": 131072
        }
    ]
};
