// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package gitops

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

var (
	gitPath     string
	gitPathOnce sync.Once
	gitPathErr  error
	gitVersion  string
)

func findGit() (string, error) {
	gitPathOnce.Do(func() {
		path, err := exec.LookPath("git")
		if err != nil {
			gitPathErr = ErrGitNotFound
			return
		}
		gitPath = path
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, path, "--version")
		out, err := cmd.Output()
		if err != nil {
			gitPathErr = fmt.Errorf("git version check failed: %w", err)
			return
		}
		gitVersion = strings.TrimSpace(string(out))
	})
	return gitPath, gitPathErr
}

func runGit(ctx context.Context, repoRoot string, timeoutSecs int, args ...string) (*GitOutput, error) {
	gitExe, err := findGit()
	if err != nil {
		return nil, err
	}
	if timeoutSecs <= 0 {
		timeoutSecs = DefaultTimeoutSecs
	}
	timeout := time.Duration(timeoutSecs) * time.Second
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmdArgs := append([]string{"-c", "core.quotepath=false", "-c", "color.ui=false"}, args...)
	cmd := exec.CommandContext(ctx, gitExe, cmdArgs...)
	cmd.Dir = repoRoot
	cmd.Env = append(cmd.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"LC_ALL=C",
		"LANG=C",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	timedOut := ctx.Err() == context.DeadlineExceeded
	stdoutBytes := stdout.Bytes()
	truncated := false
	if len(stdoutBytes) > MaxOutputBytes {
		stdoutBytes = stdoutBytes[:MaxOutputBytes]
		truncated = true
	}
	out := &GitOutput{
		Stdout:    stdoutBytes,
		Stderr:    stderr.Bytes(),
		ExitCode:  exitCode,
		TimedOut:  timedOut,
		Truncated: truncated,
	}
	if timedOut {
		return out, &GitError{
			ExitCode: exitCode,
			Stderr:   string(out.Stderr),
			Command:  strings.Join(append([]string{"git"}, args...), " "),
			TimedOut: true,
			Original: ErrTimeout,
		}
	}
	if exitCode != 0 {
		ge := &GitError{
			ExitCode: exitCode,
			Stderr:   string(out.Stderr),
			Command:  strings.Join(append([]string{"git"}, args...), " "),
		}
		if IsAuthError(ge) {
			ge.Original = ErrAuth
		}
		return out, ge
	}
	return out, nil
}

func runGitSimple(ctx context.Context, repoRoot string, args ...string) (string, error) {
	out, err := runGit(ctx, repoRoot, DefaultTimeoutSecs, args...)
	if err != nil {
		return "", err
	}
	if out.Truncated {
		return string(out.Stdout), ErrOutputTruncated
	}
	return string(out.Stdout), nil
}

func GitAvailable() bool {
	_, err := findGit()
	return err == nil
}

func GitVersionStr() string {
	findGit()
	return gitVersion
}
