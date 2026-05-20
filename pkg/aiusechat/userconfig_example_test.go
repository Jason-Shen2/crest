// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"os"
	"path/filepath"
	"testing"
)

// TestExampleAIUserConfigParses guards against the shipped
// docs/examples/ai.json.example drifting from the real schema.  If we
// add or rename a field on AIUserConfig and forget to update the
// example, this test fails.
//
// The file path is resolved relative to the repo root (this test runs
// from pkg/aiusechat/, so we walk up two levels).
func TestExampleAIUserConfigParses(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// Walk up to the repo root so the relative path works regardless
	// of where `go test` was invoked from.
	repoRoot := filepath.Clean(filepath.Join(wd, "..", ".."))
	path := filepath.Join(repoRoot, "docs", "examples", "ai.json.example")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	cfg, err := parseAIUserConfig(data)
	if err != nil {
		t.Fatalf("parse + validate ai.json.example: %v", err)
	}
	// Sanity-check a few invariants — these doubles as documentation
	// for what the example demonstrates.
	if len(cfg.Providers) == 0 {
		t.Error("example should declare at least one provider")
	}
	if cfg.Default.Provider == "" || cfg.Default.Model == "" {
		t.Error("example should set a default selection")
	}
	if len(cfg.Profiles) == 0 {
		t.Error("example should demonstrate profiles")
	}
	if len(cfg.CustomModels) == 0 {
		t.Error("example should demonstrate custom_models")
	}
	if len(cfg.CustomEndpoints) == 0 {
		t.Error("example should demonstrate custom_endpoints")
	}
}
