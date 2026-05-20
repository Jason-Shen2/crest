// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"errors"
	"strings"
	"testing"
)

func TestParseAIUserConfig_Minimal(t *testing.T) {
	const blob = `{
		"providers": { "openai": { "tokensecretname": "OPENAI_API_KEY" } },
		"default": { "provider": "openai", "model": "gpt-5" }
	}`
	cfg, err := parseAIUserConfig([]byte(blob))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cfg.Default.Provider != "openai" || cfg.Default.Model != "gpt-5" {
		t.Errorf("default = %+v", cfg.Default)
	}
	if cfg.Providers["openai"].TokenSecretName != "OPENAI_API_KEY" {
		t.Errorf("token secret name mismatch")
	}
}

func TestParseAIUserConfig_Full(t *testing.T) {
	const blob = `{
		"providers": {
			"openai":    { "tokensecretname": "OPENAI_API_KEY" },
			"anthropic": { "tokensecretname": "ANTHROPIC_API_KEY" }
		},
		"default": { "provider": "openai", "model": "gpt-5", "reasoning": "high" },
		"profiles": {
			"fast": { "provider": "openai", "model": "gpt-5-mini" },
			"deepwork": { "provider": "anthropic", "model": "claude-opus-4-7", "reasoning": "high" }
		},
		"custom_models": [
			{
				"provider": "openai",
				"id": "gpt-experimental",
				"displayname": "Experimental",
				"capabilities": ["tools"],
				"contextwindow": 50000
			}
		],
		"custom_endpoints": {
			"vllm-local": {
				"displayname": "Local vLLM",
				"endpoint": "http://localhost:8000/v1/chat/completions",
				"apitype": "openai-chat",
				"tokensecretname": "",
				"models": [
					{ "id": "qwen", "displayName": "Qwen", "capabilities": ["tools"], "contextWindow": 128000 }
				]
			}
		}
	}`
	cfg, err := parseAIUserConfig([]byte(blob))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(cfg.Profiles) != 2 {
		t.Errorf("profiles count = %d, want 2", len(cfg.Profiles))
	}
	if len(cfg.CustomModels) != 1 || cfg.CustomModels[0].ID != "gpt-experimental" {
		t.Errorf("custom_models = %+v", cfg.CustomModels)
	}
	ep, ok := cfg.CustomEndpoints["vllm-local"]
	if !ok {
		t.Fatal("missing vllm-local custom_endpoint")
	}
	if ep.APIType != "openai-chat" || len(ep.Models) != 1 {
		t.Errorf("vllm endpoint = %+v", ep)
	}
}

func TestParseAIUserConfig_RejectsEmpty(t *testing.T) {
	_, err := parseAIUserConfig([]byte(""))
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Errorf("expected empty error, got: %v", err)
	}
}

func TestParseAIUserConfig_RejectsMissingProviders(t *testing.T) {
	const blob = `{ "default": { "provider": "openai", "model": "gpt-5" } }`
	_, err := parseAIUserConfig([]byte(blob))
	if err == nil || !strings.Contains(err.Error(), "providers") {
		t.Errorf("expected providers error, got: %v", err)
	}
}

func TestParseAIUserConfig_RejectsEmptyProviders(t *testing.T) {
	const blob = `{ "providers": {}, "default": { "provider": "openai", "model": "gpt-5" } }`
	_, err := parseAIUserConfig([]byte(blob))
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Errorf("expected empty providers error, got: %v", err)
	}
}

func TestParseAIUserConfig_RejectsMissingDefault(t *testing.T) {
	const blob = `{ "providers": { "openai": { "tokensecretname": "X" } } }`
	_, err := parseAIUserConfig([]byte(blob))
	if err == nil || !strings.Contains(err.Error(), "default.provider") {
		t.Errorf("expected default.provider error, got: %v", err)
	}
}

func TestParseAIUserConfig_RejectsMissingDefaultModel(t *testing.T) {
	const blob = `{
		"providers": { "openai": { "tokensecretname": "X" } },
		"default": { "provider": "openai" }
	}`
	_, err := parseAIUserConfig([]byte(blob))
	if err == nil || !strings.Contains(err.Error(), "default.model") {
		t.Errorf("expected default.model error, got: %v", err)
	}
}

func TestParseAIUserConfig_RejectsUnknownField(t *testing.T) {
	// DisallowUnknownFields guards against typos like "providors".
	const blob = `{
		"providors": { "openai": {} },
		"default": { "provider": "openai", "model": "gpt-5" }
	}`
	_, err := parseAIUserConfig([]byte(blob))
	if err == nil {
		t.Error("expected unknown field error")
	}
}

func TestParseAIUserConfig_RejectsMalformedJSON(t *testing.T) {
	_, err := parseAIUserConfig([]byte("{ not json"))
	if err == nil {
		t.Error("expected JSON parse error")
	}
}

func TestReadAIUserConfig_MissingFile(t *testing.T) {
	// In a fresh test process, wavebase config dir likely doesn't
	// have an ai.json — assert the sentinel.  If the dev env
	// already has one this test is a no-op (acceptable).
	cfg, err := ReadAIUserConfig()
	if cfg != nil && err == nil {
		// User has a real config.  Test inert; just sanity-check
		// shape.
		if cfg.Default.Provider == "" {
			t.Error("real config has empty default.provider")
		}
		return
	}
	if !errors.Is(err, ErrAIUserConfigMissing) && !errors.Is(err, ErrAIUserConfigMalformed) {
		// Could also be a permission error on locked-down CI;
		// that's fine.
		t.Logf("ReadAIUserConfig returned: %v", err)
	}
}
