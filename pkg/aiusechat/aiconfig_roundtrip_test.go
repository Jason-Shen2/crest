// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"encoding/json"
	"testing"
)

// Phase B acceptance — round-trip test (docs/ai-config-architecture.md
// §11 Phase B).  The frontend resolver produces a JSON blob that the
// backend ingests via AIConfigRequest → BuildAIOptsFromConfig.  This
// test asserts the wire format stays compatible by feeding known-good
// frontend outputs (captured by hand from the resolver TS smoke runner)
// into BuildAIOptsFromConfig and checking the resulting AIOptsType.
//
// If this test ever fails after a TS-side change, the contract has
// drifted — fix either AIConfigRequest (here) or ResolvedAIConfig
// (frontend/app/store/ai-types.ts) to bring them back in line.

func TestRoundtrip_OpenAI_GPT5_Reasoning(t *testing.T) {
	// What the FE resolver emits for:
	//   selection = {provider:"openai", model:"gpt-5", reasoning:"high"}
	//   userConfig = {providers:{openai:{tokensecretname:"OPENAI_API_KEY"}}, ...}
	const fePayload = `{
		"provider": "openai",
		"model": "gpt-5",
		"endpoint": "https://api.openai.com/v1/responses",
		"apitype": "openai-responses",
		"capabilities": ["tools","images","pdfs","reasoning"],
		"contextwindow": 200000,
		"reasoning": "high",
		"tokensecretname": "OPENAI_API_KEY"
	}`
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		return "sk-roundtrip-test", true, nil
	})

	var req AIConfigRequest
	if err := json.Unmarshal([]byte(fePayload), &req); err != nil {
		t.Fatalf("decode FE payload: %v", err)
	}
	opts, err := BuildAIOptsFromConfig(req)
	if err != nil {
		t.Fatalf("BuildAIOptsFromConfig: %v", err)
	}
	if opts.Provider != "openai" || opts.Model != "gpt-5" ||
		opts.Endpoint != "https://api.openai.com/v1/responses" ||
		opts.APIType != "openai-responses" ||
		opts.ThinkingLevel != "high" ||
		opts.APIToken != "sk-roundtrip-test" {
		t.Errorf("opts roundtrip mismatch: %+v", opts)
	}
}

func TestRoundtrip_Google_Gemini_TemplateSubstituted(t *testing.T) {
	// FE resolver substituted {model} before sending.  Backend sees
	// the substituted URL only.
	const fePayload = `{
		"provider": "google",
		"model": "gemini-2.0-pro",
		"endpoint": "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-pro:streamGenerateContent",
		"apitype": "google-gemini",
		"capabilities": ["tools","images","pdfs"],
		"contextwindow": 2000000,
		"tokensecretname": "GOOGLE_AI_KEY"
	}`
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		return "AIza-test", true, nil
	})

	var req AIConfigRequest
	if err := json.Unmarshal([]byte(fePayload), &req); err != nil {
		t.Fatalf("decode: %v", err)
	}
	opts, err := BuildAIOptsFromConfig(req)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	want := "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-pro:streamGenerateContent"
	if opts.Endpoint != want {
		t.Errorf("Endpoint = %q, want %q", opts.Endpoint, want)
	}
	if opts.APIType != "google-gemini" {
		t.Errorf("APIType = %q", opts.APIType)
	}
}

func TestRoundtrip_OpenRouter_ChatAPI(t *testing.T) {
	const fePayload = `{
		"provider": "openrouter",
		"model": "anthropic/claude-opus-4-7",
		"endpoint": "https://openrouter.ai/api/v1/chat/completions",
		"apitype": "openai-chat",
		"capabilities": ["tools","images"],
		"contextwindow": 1000000,
		"tokensecretname": "OPENROUTER_API_KEY"
	}`
	withFakeSecretstore(t, func(name string) (string, bool, error) {
		return "or-test", true, nil
	})
	var req AIConfigRequest
	_ = json.Unmarshal([]byte(fePayload), &req)
	opts, err := BuildAIOptsFromConfig(req)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if opts.Model != "anthropic/claude-opus-4-7" {
		t.Errorf("Model = %q", opts.Model)
	}
	if opts.APIType != "openai-chat" {
		t.Errorf("APIType = %q", opts.APIType)
	}
}

func TestRoundtrip_LocalVllm_Unauthed(t *testing.T) {
	// Local endpoint, no token, no secret.
	const fePayload = `{
		"provider": "vllm-local",
		"model": "qwen-coder-32b",
		"endpoint": "http://localhost:8000/v1/chat/completions",
		"apitype": "openai-chat",
		"capabilities": ["tools"],
		"contextwindow": 128000,
		"tokensecretname": ""
	}`
	var req AIConfigRequest
	_ = json.Unmarshal([]byte(fePayload), &req)
	opts, err := BuildAIOptsFromConfig(req)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if opts.APIToken != "" {
		t.Errorf("APIToken = %q, want empty", opts.APIToken)
	}
}

func TestRoundtrip_LiteralToken_TestingPath(t *testing.T) {
	// FE config with `providers.openai.token = "sk-test"` (no secret).
	const fePayload = `{
		"provider": "openai",
		"model": "gpt-5-mini",
		"endpoint": "https://api.openai.com/v1/responses",
		"apitype": "openai-responses",
		"capabilities": ["tools"],
		"contextwindow": 200000,
		"token": "sk-test-literal"
	}`
	var req AIConfigRequest
	_ = json.Unmarshal([]byte(fePayload), &req)
	opts, err := BuildAIOptsFromConfig(req)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if opts.APIToken != "sk-test-literal" {
		t.Errorf("APIToken = %q", opts.APIToken)
	}
}
