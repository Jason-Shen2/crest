// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

// Package contextchip is crest's port of warp's `context_chips` framework
// (warp/app/src/context_chips/).  Each chip is a small dynamic data source
// — git branch, diff stats, GitHub PR, kubernetes context, ssh host, etc. —
// that the input-bar footer renders as a pill.
//
// Architecture maps onto warp's primitives:
//
//   - ChipKind            = warp ContextChipKind enum
//   - Generator           = warp PromptGenerator (ShellCommand / Contextual)
//   - RuntimePolicy       = warp ChipRuntimePolicy
//   - FingerprintInput    = warp ChipFingerprintInput
//   - ChipValue           = warp ChipValue (string + Failed flag)
//   - BuiltinChips()      = warp builtins.rs registry
//
// Stateless on this layer — the per-block ChipFetcher (frontend) owns
// fingerprint caching, invalidate-on-command counting, and command-debouncing.
// This package exposes `Fetch(kind, cwd)` as the leaf operation.
package contextchip

import "time"

// ChipKind enumerates every chip the backend knows how to fetch.  String
// constants follow Wave's convention (no custom enum types).
type ChipKind = string

const (
	ChipKindShellGitBranch    ChipKind = "shell_git_branch"
	ChipKindGitDiffStats      ChipKind = "git_diff_stats"
	ChipKindGithubPullRequest ChipKind = "github_pull_request"
	ChipKindKubernetesContext ChipKind = "kubernetes_context"
)

// FingerprintInput is the warp-equivalent ChipFingerprintInput — the set
// of session-environment dimensions that determine whether a cached value
// is still valid.  The fetcher recomputes the chip when any input changes.
type FingerprintInput = string

const (
	FpWorkingDirectory         FingerprintInput = "working_directory"
	FpGitBranch                FingerprintInput = "git_branch"
	FpSessionId                FingerprintInput = "session_id"
	FpInvalidatingCommandCount FingerprintInput = "invalidating_command_count"
)

// RefreshKind controls automatic re-fetching beyond fingerprint changes.
// On-demand-only chips only refresh when a fingerprint input changes.
type RefreshKind = string

const (
	RefreshOnDemandOnly RefreshKind = "on_demand_only"
	RefreshPeriodically RefreshKind = "periodically"
)

// RefreshConfig mirrors warp's RefreshConfig — currently OnDemandOnly is
// the only kind used by built-in chips; Periodically is reserved for
// chips like context-window-usage that need a clock-driven update.
type RefreshConfig struct {
	Kind     RefreshKind   `json:"kind"`
	Interval time.Duration `json:"interval,omitempty"`
}

// RuntimePolicy = warp ChipRuntimePolicy.  Governs how a chip interacts
// with the runtime environment: which executables it needs, whether it
// can run on remote sessions, its command timeout, and which inputs form
// its fingerprint.
type RuntimePolicy struct {
	RequiredExecutables  []string           `json:"requiredexecutables,omitempty"`
	LocalOnly            bool               `json:"localonly,omitempty"`
	ShellCommandTimeout  time.Duration      `json:"shellcommandtimeout,omitempty"`
	FingerprintInputs    []FingerprintInput `json:"fingerprintinputs,omitempty"`
	SuppressOnFailure    bool               `json:"suppressonfailure,omitempty"`
	InvalidateOnCommands []string           `json:"invalidateoncommands,omitempty"`
}

// ContextChip = warp ContextChip.  Bundles the kind + the generator that
// produces its value + the policy that gates / fingerprints it.
type ContextChip struct {
	Kind          ChipKind
	Title         string
	Generator     Generator
	RuntimePolicy RuntimePolicy
	RefreshConfig RefreshConfig
	// AllowEmpty mirrors warp's `allow_empty_value`: a successful command
	// with empty output produces ChipValue{Value:""} instead of dropping
	// the chip.  Used by GitDiffStats — empty stat = clean tree, still
	// meaningful (shows "0 changes").
	AllowEmpty bool
}
