// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package contextchip

import (
	"context"
	"os/exec"
	"strings"
)

// Generator is the warp `PromptGenerator` interface (ShellCommand | Contextual).
// crest currently only implements the shell-command variant; Contextual
// data — cwd, git_branch, virtual_env from precmd — comes through OSC 133;P
// and is handled directly on the Block (see frontend/app/term/engine/block-handler.ts).
type Generator interface {
	Fetch(ctx context.Context, cwd string) (string, error)
	Dependencies() []string
}

// ShellCommandGenerator = warp ShellCommandGenerator.  Runs a single
// `sh -c <cmd>` in the given cwd, returns trimmed stdout.  A non-zero
// exit (e.g. `git symbolic-ref` outside a git repo) is treated as
// "no value" — empty string, no error — to match warp semantics where
// chips silently disappear when their data source isn't applicable.
type ShellCommandGenerator struct {
	// Cmd is the shell command string passed to `sh -c`.  Each entry in
	// the warp source uses a shell-agnostic command via `ShellCommand`
	// helpers; crest defaults to POSIX sh, which covers bash/zsh/fish/dash.
	Cmd string
	// Deps lists the executables that must be on PATH for the chip to
	// have any chance of producing a value.  Used by the fetcher to
	// short-circuit before spawning the subprocess.
	Deps []string
}

func (g *ShellCommandGenerator) Fetch(ctx context.Context, cwd string) (string, error) {
	cmd := exec.CommandContext(ctx, "sh", "-c", g.Cmd)
	if cwd != "" {
		cmd.Dir = cwd
	}
	// Pass through the user's environment so generators can see things
	// like GIT_OPTIONAL_LOCKS, PATH additions from .zshrc subshells, etc.
	out, err := cmd.Output()
	if err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			// Non-zero exit → treat as "no value", consistent with warp's
			// behaviour for shell_git_branch outside a repo.
			return "", nil
		}
		return "", err
	}
	return strings.TrimRight(string(out), "\r\n"), nil
}

func (g *ShellCommandGenerator) Dependencies() []string {
	return g.Deps
}
