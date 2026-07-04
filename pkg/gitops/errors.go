// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package gitops

import (
	"errors"
	"fmt"
	"strings"
)

var (
	ErrNotGitRepo         = errors.New("not a git repository")
	ErrGitNotFound        = errors.New("git executable not found")
	ErrTimeout            = errors.New("git command timed out")
	ErrOutputTruncated    = errors.New("git output truncated")
	ErrAuth               = errors.New("git authentication failed")
	ErrNoUpstream         = errors.New("no upstream branch configured")
	ErrNothingToCommit    = errors.New("nothing to commit")
	ErrConflicts          = errors.New("conflicts present")
	ErrEmptyCommitMessage = errors.New("empty commit message")
	ErrPathOutsideRepo    = errors.New("path outside repository")
	ErrBadGitVersion      = errors.New("git version too old, requires >= 2.31.0")
	ErrInvalidPathspec    = errors.New("invalid pathspec")
)

type GitError struct {
	ExitCode  int
	Stderr    string
	Command   string
	Original  error
	Truncated bool
	TimedOut  bool
}

func (e *GitError) Error() string {
	if e == nil {
		return ""
	}
	var parts []string
	if e.TimedOut {
		parts = append(parts, "command timed out")
	}
	if e.Truncated {
		parts = append(parts, "output truncated")
	}
	if e.Stderr != "" {
		stderr := strings.TrimSpace(e.Stderr)
		if len(stderr) > 500 {
			stderr = stderr[:500] + "..."
		}
		parts = append(parts, stderr)
	}
	if e.ExitCode != 0 {
		parts = append(parts, fmt.Sprintf("exit code %d", e.ExitCode))
	}
	if e.Original != nil {
		parts = append(parts, e.Original.Error())
	}
	if len(parts) == 0 {
		return "git error"
	}
	return strings.Join(parts, "; ")
}

func (e *GitError) Unwrap() error {
	return e.Original
}

func IsAuthError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	authMarkers := []string{
		"Authentication failed",
		"could not read Username",
		"Permission denied (publickey)",
		"fatal: could not read Password",
		"fatal: Authentication failed",
	}
	for _, m := range authMarkers {
		if strings.Contains(msg, m) {
			return true
		}
	}
	return false
}

func IsNothingToCommit(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "nothing to commit") ||
		strings.Contains(err.Error(), "nothing added to commit")
}

func IsNoUpstream(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "no upstream branch") ||
		strings.Contains(err.Error(), "has no upstream")
}

func IsConflicts(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "CONFLICT") ||
		strings.Contains(err.Error(), "would be overwritten by merge") ||
		strings.Contains(err.Error(), "you need to resolve your current index first")
}
