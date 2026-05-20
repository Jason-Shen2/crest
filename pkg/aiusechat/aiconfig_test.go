// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"errors"
	"testing"

	"github.com/s-zx/crest/pkg/aiusechat/uctypes"
)

// withFakeSecretstore swaps the package-level secretLookup variable
// for the duration of the test.  Restores on cleanup so tests can run
// in any order without leaking state.
func withFakeSecretstore(t *testing.T, lookup func(name string) (string, bool, error)) {
	t.Helper()
	orig := secretLookup
	secretLookup = lookup
	t.Cleanup(func() { secretLookup = orig })
}

func TestBuildAIOptsFromConfig_TokenLiteral(t *testing.T) {
	// Literal token bypasses secretstore entirely.  The lookup fn
	// installed here would fail the test if called.
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		t.Fatalf("secretstore should not be called when literal Token is set; called with %q", name)
		return "", false, nil
	})
	cfg := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		Token:    "sk-literal",
	}
	opts, err := BuildAIOptsFromConfig(cfg)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if opts.APIToken != "sk-literal" {
		t.Errorf("APIToken = %q, want sk-literal", opts.APIToken)
	}
}

func TestBuildAIOptsFromConfig_TokenSecretstore(t *testing.T) {
	called := false
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		called = true
		if name != "OPENAI_API_KEY" {
			t.Errorf("secretLookup called with %q, want OPENAI_API_KEY", name)
		}
		return "sk-from-keychain", true, nil
	})
	cfg := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		TokenSecretName: "OPENAI_API_KEY",
	}
	opts, err := BuildAIOptsFromConfig(cfg)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !called {
		t.Error("secretLookup was never called")
	}
	if opts.APIToken != "sk-from-keychain" {
		t.Errorf("APIToken = %q, want sk-from-keychain", opts.APIToken)
	}
}

func TestBuildAIOptsFromConfig_SecretstoreTrimsWhitespace(t *testing.T) {
	// Secretstore values often have trailing newlines (when written
	// via shell pipelines) — we trim so the auth header doesn't get
	// corrupted.  Mirrors the legacy buildAIOptsFromSettings behavior.
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		return "  sk-with-noise\n", true, nil
	})
	cfg := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		TokenSecretName: "OPENAI_API_KEY",
	}
	opts, _ := BuildAIOptsFromConfig(cfg)
	if opts.APIToken != "sk-with-noise" {
		t.Errorf("APIToken = %q, want trimmed", opts.APIToken)
	}
}

func TestBuildAIOptsFromConfig_LiteralBeatsSecretname(t *testing.T) {
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		t.Fatalf("secretstore must not be consulted when Token literal is set")
		return "", false, nil
	})
	cfg := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		Token:           "sk-lit",
		TokenSecretName: "SHOULD_BE_IGNORED",
	}
	opts, _ := BuildAIOptsFromConfig(cfg)
	if opts.APIToken != "sk-lit" {
		t.Errorf("APIToken = %q, want sk-lit", opts.APIToken)
	}
}

func TestBuildAIOptsFromConfig_EmptySecretnameMeansUnauthed(t *testing.T) {
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		t.Fatalf("secretstore must not be called when TokenSecretName is empty")
		return "", false, nil
	})
	cfg := AIConfigRequest{
		Provider: "vllm-local", Model: "qwen",
		Endpoint:        "http://localhost:8000/v1/chat/completions",
		APIType:         "openai-chat",
		TokenSecretName: "",
	}
	opts, err := BuildAIOptsFromConfig(cfg)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if opts.APIToken != "" {
		t.Errorf("APIToken should be empty for unauthed local endpoint, got %q", opts.APIToken)
	}
}

func TestBuildAIOptsFromConfig_SecretMissing(t *testing.T) {
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		return "", false, nil
	})
	cfg := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		TokenSecretName: "OPENAI_API_KEY",
	}
	_, err := BuildAIOptsFromConfig(cfg)
	if err == nil {
		t.Fatal("expected error when secret not found, got nil")
	}
}

func TestBuildAIOptsFromConfig_SecretEmptyValue(t *testing.T) {
	// Exists in keychain but the value is empty (e.g. user wrote a
	// blank entry) — treat as missing.
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		return "   \n", true, nil
	})
	cfg := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		TokenSecretName: "OPENAI_API_KEY",
	}
	_, err := BuildAIOptsFromConfig(cfg)
	if err == nil {
		t.Fatal("expected error when secret value is blank")
	}
}

func TestBuildAIOptsFromConfig_SecretstoreError(t *testing.T) {
	wantErr := errors.New("keychain locked")
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		return "", false, wantErr
	})
	cfg := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		TokenSecretName: "OPENAI_API_KEY",
	}
	_, err := BuildAIOptsFromConfig(cfg)
	if err == nil || !errors.Is(err, wantErr) {
		t.Fatalf("expected error to wrap %v, got %v", wantErr, err)
	}
}

func TestBuildAIOptsFromConfig_FieldMapping(t *testing.T) {
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		return "tok", true, nil
	})
	cfg := AIConfigRequest{
		Provider:        "anthropic",
		Model:           "claude-opus-4-7",
		Endpoint:        "https://api.anthropic.com/v1/messages",
		APIType:         "anthropic-messages",
		Capabilities:    []string{"tools", "images", "reasoning"},
		ContextWindow:   1000000,
		Reasoning:       "high",
		TokenSecretName: "ANTHROPIC_API_KEY",
	}
	opts, err := BuildAIOptsFromConfig(cfg)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if opts.Provider != "anthropic" {
		t.Errorf("Provider = %q", opts.Provider)
	}
	if opts.Model != "claude-opus-4-7" {
		t.Errorf("Model = %q", opts.Model)
	}
	if opts.Endpoint != "https://api.anthropic.com/v1/messages" {
		t.Errorf("Endpoint = %q", opts.Endpoint)
	}
	if opts.APIType != "anthropic-messages" {
		t.Errorf("APIType = %q", opts.APIType)
	}
	if opts.ThinkingLevel != "high" {
		t.Errorf("ThinkingLevel = %q, want high", opts.ThinkingLevel)
	}
	if got := opts.Capabilities; len(got) != 3 || got[0] != "tools" || got[1] != "images" || got[2] != "reasoning" {
		t.Errorf("Capabilities = %v", got)
	}
	// Defaults
	if opts.MaxTokens != defaultMaxTokens {
		t.Errorf("MaxTokens = %d, want default %d", opts.MaxTokens, defaultMaxTokens)
	}
	if opts.Verbosity != uctypes.VerbosityLevelMedium {
		t.Errorf("Verbosity = %q, want medium", opts.Verbosity)
	}
}

func TestBuildAIOptsFromConfig_HasCapabilityRoundtrip(t *testing.T) {
	withFakeSecretstore(t, func(name string) (string, bool, error) { return "tok", true, nil })
	cfg := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		Capabilities: []string{"tools", "images"},
		TokenSecretName: "OPENAI_API_KEY",
	}
	opts, _ := BuildAIOptsFromConfig(cfg)
	if !opts.HasCapability("tools") {
		t.Error("HasCapability(tools) should be true")
	}
	if opts.HasCapability("pdfs") {
		t.Error("HasCapability(pdfs) should be false")
	}
}

func TestBuildAIOptsFromConfig_RejectsEmptyRequiredFields(t *testing.T) {
	base := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		Token:    "tok",
	}
	cases := []struct {
		name string
		mut  func(c *AIConfigRequest)
	}{
		{"empty provider", func(c *AIConfigRequest) { c.Provider = "" }},
		{"empty model", func(c *AIConfigRequest) { c.Model = "" }},
		{"empty endpoint", func(c *AIConfigRequest) { c.Endpoint = "" }},
		{"empty apitype", func(c *AIConfigRequest) { c.APIType = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := base
			tc.mut(&cfg)
			_, err := BuildAIOptsFromConfig(cfg)
			if err == nil {
				t.Errorf("expected error for %s", tc.name)
			}
		})
	}
}

func TestBuildAIOptsFromConfig_NilCapabilitiesBecomeEmptySlice(t *testing.T) {
	withFakeSecretstore(t, func(name string) (string, bool, error) { return "tok", true, nil })
	cfg := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		// Capabilities deliberately nil.
		TokenSecretName: "OPENAI_API_KEY",
	}
	opts, err := BuildAIOptsFromConfig(cfg)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if opts.Capabilities == nil {
		t.Error("Capabilities should be non-nil (empty slice) when input nil")
	}
}

func TestBuildAIOptsFromConfig_NoReasoningWhenAbsent(t *testing.T) {
	withFakeSecretstore(t, func(name string) (string, bool, error) { return "tok", true, nil })
	cfg := AIConfigRequest{
		Provider: "openai", Model: "gpt-5",
		Endpoint: "https://api.openai.com/v1/responses",
		APIType:  "openai-responses",
		TokenSecretName: "OPENAI_API_KEY",
	}
	opts, _ := BuildAIOptsFromConfig(cfg)
	if opts.ThinkingLevel != "" {
		t.Errorf("ThinkingLevel = %q, want empty when Reasoning absent", opts.ThinkingLevel)
	}
}
