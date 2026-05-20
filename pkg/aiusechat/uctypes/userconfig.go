// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Types for the AI user config (~/.config/crest/ai.json) and the
// resolved AI config the frontend sends on every request.  Defined in
// uctypes (the leaf types package) so both pkg/aiusechat (IO,
// resolver) and pkg/wshrpc (RPC commands) can reference them without
// triggering an import cycle.
//
// Frontend mirrors live at frontend/app/store/ai-types.ts.  Keep field
// names + JSON tags in sync across the boundary.

package uctypes

// AIUserConfig — backs ~/.config/crest/ai.json.  Mirrors frontend
// UserConfig.  See docs/ai-config-architecture.md §4.
type AIUserConfig struct {
	Providers       map[string]ProviderCredentials  `json:"providers"`
	Default         AISelectionConfig                `json:"default"`
	Profiles        map[string]AISelectionConfig     `json:"profiles,omitempty"`
	CustomModels    []UserCustomModel                `json:"custom_models,omitempty"`
	CustomEndpoints map[string]UserCustomEndpoint    `json:"custom_endpoints,omitempty"`
}

// ProviderCredentials — exactly one of TokenSecretName / Token is
// expected to be set.  Empty TokenSecretName ("") is treated as
// "unauthed local endpoint" by the resolver.
type ProviderCredentials struct {
	TokenSecretName string `json:"tokensecretname,omitempty"`
	Token           string `json:"token,omitempty"`
}

// AISelectionConfig — (provider, model, reasoning?) triple used both
// as the user-config default and as the persisted block.meta
// agent:selection.
type AISelectionConfig struct {
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Reasoning string `json:"reasoning,omitempty"`
}

// UserCustomModel — a model added by the user that isn't in the
// shipped catalog.  `Provider` matches either a catalog provider id
// or a CustomEndpoints key.
type UserCustomModel struct {
	Provider        string   `json:"provider"`
	ID              string   `json:"id"`
	DisplayName     string   `json:"displayname"`
	Description     string   `json:"description,omitempty"`
	Capabilities    []string `json:"capabilities"`
	ContextWindow   int      `json:"contextwindow"`
	ReasoningLevels []string `json:"reasoninglevels,omitempty"`
	APITypeOverride string   `json:"apitypeoverride,omitempty"`
}

// UserCustomEndpoint — an entirely user-defined provider (vLLM,
// LM Studio, Together AI, etc.).
type UserCustomEndpoint struct {
	DisplayName     string                    `json:"displayname"`
	Endpoint        string                    `json:"endpoint"`
	APIType         string                    `json:"apitype"`
	TokenSecretName string                    `json:"tokensecretname"`
	Icon            string                    `json:"icon,omitempty"`
	Models          []UserCustomEndpointModel `json:"models"`
}

// UserCustomEndpointModel — JSON tags use camelCase to match the
// frontend Omit<ModelEntry, "apiTypeOverride"> shape that gets
// written through the WriteAIUserConfig path.
type UserCustomEndpointModel struct {
	ID              string   `json:"id"`
	DisplayName     string   `json:"displayName"`
	Description     string   `json:"description,omitempty"`
	Capabilities    []string `json:"capabilities"`
	ContextWindow   int      `json:"contextWindow"`
	ReasoningLevels []string `json:"reasoningLevels,omitempty"`
}
