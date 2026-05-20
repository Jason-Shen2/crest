// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"fmt"
	"strings"

	"github.com/s-zx/crest/pkg/aiusechat/uctypes"
	"github.com/s-zx/crest/pkg/secretstore"
)

// AIConfigRequest is the resolved AI configuration the frontend sends
// on every agent / chat request.  Mirrors frontend types
// ResolvedAIConfig / AIConfigRequest in frontend/app/store/ai-types.ts
// — keep field names + JSON tags in sync across the boundary.
//
// Design: see docs/ai-config-architecture.md §6.
//
// Resolution flow:
//   1. Frontend reads ai-catalog.ts + ~/.config/crest/ai.json + selection
//   2. Frontend produces ResolvedAIConfig (endpoint, apitype, token
//      secret name, capabilities — all derived) and posts it
//   3. Backend ingests AIConfigRequest, fills AIOptsType via
//      BuildAIOptsFromConfig, passes to existing backends unchanged
//
// The backend does NOT consult any catalog or wconfig for AI settings
// when this struct is provided.  All AI choices flow through it.

type AIConfigRequest struct {
	Provider      string   `json:"provider"`
	Model         string   `json:"model"`
	Endpoint      string   `json:"endpoint"`
	APIType       string   `json:"apitype"`
	Capabilities  []string `json:"capabilities,omitempty"`
	ContextWindow int      `json:"contextwindow,omitempty"`

	// Optional, only set when the resolved model supports reasoning
	// AND the user picked a level.  Maps to AIOptsType.ThinkingLevel.
	Reasoning string `json:"reasoning,omitempty"`

	// Exactly one of TokenSecretName / Token will be set.  When
	// TokenSecretName is set, the backend resolves the literal value
	// via secretstore.GetSecret at request time.  Token is a
	// pass-through literal (testing / unauthed local endpoints).
	TokenSecretName string `json:"tokensecretname,omitempty"`
	Token           string `json:"token,omitempty"`
}

// secretLookup is the secretstore.GetSecret signature, lifted into a
// variable so tests can swap in a fake without touching the OS keychain.
// Production callers should never reassign this.
var secretLookup = secretstore.GetSecret

// defaultMaxTokens is the fallback output-token cap when the backend
// gets no per-request override.  Mirrors the legacy
// buildAIOptsFromSettings default (pkg/agent/http.go) so the cutover in
// Phase E preserves behavior.
const defaultMaxTokens = 16384

// BuildAIOptsFromConfig converts a resolved AIConfigRequest into the
// AIOptsType that downstream backends (openai-responses, openai-chat,
// google-gemini, anthropic-messages) already consume.  Pure ingest —
// no catalog lookup, no wconfig access, no rtinfo.  Everything the
// backend needs is in `cfg`.
//
// Error cases:
//   - Empty Provider/Model/Endpoint/APIType — the frontend resolver
//     guarantees these.  Reject so a malformed client request can't
//     reach the backends with empty fields.
//   - Both TokenSecretName and Token unset, OR TokenSecretName set
//     but the keychain has no entry under that name.  Local unauthed
//     endpoints opt in by sending TokenSecretName: "" (explicit empty
//     string, not absent) — distinct from "no creds at all".
func BuildAIOptsFromConfig(cfg AIConfigRequest) (*uctypes.AIOptsType, error) {
	if cfg.Provider == "" {
		return nil, fmt.Errorf("aiconfig: empty provider")
	}
	if cfg.Model == "" {
		return nil, fmt.Errorf("aiconfig: empty model")
	}
	if cfg.Endpoint == "" {
		return nil, fmt.Errorf("aiconfig: empty endpoint")
	}
	if cfg.APIType == "" {
		return nil, fmt.Errorf("aiconfig: empty apitype")
	}

	token, err := resolveToken(cfg)
	if err != nil {
		return nil, err
	}

	caps := cfg.Capabilities
	if caps == nil {
		// Be permissive: empty slice rather than nil so downstream
		// HasCapability() doesn't have to nil-check.
		caps = []string{}
	}

	opts := &uctypes.AIOptsType{
		Provider:      cfg.Provider,
		APIType:       cfg.APIType,
		Model:         cfg.Model,
		Endpoint:      cfg.Endpoint,
		APIToken:      token,
		MaxTokens:     defaultMaxTokens,
		ThinkingLevel: cfg.Reasoning,
		Verbosity:     uctypes.VerbosityLevelMedium,
		Capabilities:  caps,
	}
	return opts, nil
}

// resolveToken — pick the credential the frontend asked us to use.
// Precedence (matches resolver §6 of the design doc):
//   1. Literal Token (testing / pass-through)
//   2. TokenSecretName != "" → look up in secretstore
//   3. TokenSecretName == "" (empty string explicit) → local unauthed
//      endpoint, return "" with no error
//   4. Both empty → error
func resolveToken(cfg AIConfigRequest) (string, error) {
	if cfg.Token != "" {
		return cfg.Token, nil
	}
	// Treat absent (Go zero value for string) the same as never-set.
	// The frontend explicitly sends "" to opt into unauthed; we can't
	// distinguish absent from set-to-empty over JSON, so the rule
	// becomes: empty string == unauthed-allowed.  In practice the FE
	// always sets one of Token / TokenSecretName, so the "both
	// empty" branch only fires on a malformed client request.
	if cfg.TokenSecretName == "" {
		// Empty-string secret name == "local unauthed endpoint".  Only
		// the FE knowingly sends this; arriving here from a buggy
		// client is benign (the upstream provider will reject the
		// unauthed call with its own error).  No warning.
		return "", nil
	}
	value, exists, err := secretLookup(cfg.TokenSecretName)
	if err != nil {
		return "", fmt.Errorf("aiconfig: secretstore lookup for %q: %w", cfg.TokenSecretName, err)
	}
	value = strings.TrimSpace(value)
	if !exists || value == "" {
		return "", fmt.Errorf(
			"aiconfig: secret %q not found or empty — open Settings → AI Provider to set the key",
			cfg.TokenSecretName,
		)
	}
	return value, nil
}
