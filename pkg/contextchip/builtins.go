// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package contextchip

import "time"

// BuiltinChips returns crest's default chip registry — every entry maps
// 1:1 with a warp `builtins.rs` generator.  Shell commands are copied
// verbatim from warp source (cited in comments) so behaviour matches.
//
// Reference: warp/app/src/context_chips/builtins.rs:127-244.
func BuiltinChips() []*ContextChip {
	return []*ContextChip{
		// shell_git_branch — warp builtins.rs:127-147.
		{
			Kind:  ChipKindShellGitBranch,
			Title: "Git Branch",
			Generator: &ShellCommandGenerator{
				Cmd:  `GIT_OPTIONAL_LOCKS=0 git symbolic-ref --short HEAD 2>/dev/null || GIT_OPTIONAL_LOCKS=0 git rev-parse --short HEAD 2>/dev/null`,
				Deps: []string{"git"},
			},
			RuntimePolicy: RuntimePolicy{
				RequiredExecutables:  []string{"git"},
				FingerprintInputs:    []FingerprintInput{FpWorkingDirectory, FpInvalidatingCommandCount},
				InvalidateOnCommands: []string{"git", "gh", "gt"},
				ShellCommandTimeout:  500 * time.Millisecond,
			},
		},

		// shell_git_line_changes — warp builtins.rs:172-187.  Empty
		// output = clean tree, still meaningful (AllowEmpty=true).
		{
			Kind:  ChipKindGitDiffStats,
			Title: "Git Diff Stats",
			Generator: &ShellCommandGenerator{
				Cmd:  `GIT_OPTIONAL_LOCKS=0 git -c diff.autoRefreshIndex=false diff --shortstat HEAD 2>/dev/null`,
				Deps: []string{"git"},
			},
			RuntimePolicy: RuntimePolicy{
				RequiredExecutables:  []string{"git"},
				FingerprintInputs:    []FingerprintInput{FpWorkingDirectory, FpGitBranch, FpInvalidatingCommandCount},
				InvalidateOnCommands: []string{"git"},
				ShellCommandTimeout:  1 * time.Second,
			},
			AllowEmpty: true,
		},

		// github_pull_request_url — warp context_chips/mod.rs:305-328 +
		// builtins.rs:189-205.  We invoke `gh pr view` directly; the warp
		// source embeds a full shell script that distinguishes "no PR
		// found" from auth/network failure.  Same intent; crest treats
		// any non-zero exit as "no value" (see ShellCommandGenerator).
		// Timeout 5s + InvalidateOnCommands "git/gh/gt" + Fingerprint
		// inputs match warp explicitly.
		{
			Kind:  ChipKindGithubPullRequest,
			Title: "GitHub Pull Request",
			Generator: &ShellCommandGenerator{
				Cmd:  `gh pr view --json number,title 2>/dev/null`,
				Deps: []string{"gh", "git"},
			},
			RuntimePolicy: RuntimePolicy{
				RequiredExecutables:  []string{"gh", "git"},
				FingerprintInputs:    []FingerprintInput{FpWorkingDirectory, FpGitBranch, FpInvalidatingCommandCount},
				InvalidateOnCommands: []string{"git", "gh", "gt"},
				ShellCommandTimeout:  5 * time.Second,
				SuppressOnFailure:    true,
			},
		},

		// kubernetes_current_context — warp builtins.rs:207-212.
		{
			Kind:  ChipKindKubernetesContext,
			Title: "Kubernetes Context",
			Generator: &ShellCommandGenerator{
				Cmd:  `kubectl config current-context 2>/dev/null`,
				Deps: []string{"kubectl"},
			},
			RuntimePolicy: RuntimePolicy{
				RequiredExecutables:  []string{"kubectl"},
				InvalidateOnCommands: []string{"kubectl", "kubectx"},
				ShellCommandTimeout:  1 * time.Second,
			},
		},
	}
}

// LookupChip returns the chip definition for a kind, or nil if unknown.
// Called by the RPC handler before spawning a generator.
func LookupChip(kind ChipKind) *ContextChip {
	for _, chip := range BuiltinChips() {
		if chip.Kind == kind {
			return chip
		}
	}
	return nil
}
