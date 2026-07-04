// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package gitops

import (
	"context"
	"path/filepath"
	"strings"
)

func ResolveRepoRoot(dir string) (string, error) {
	out, err := runGitSimple(context.Background(), dir, "rev-parse", "--show-toplevel")
	if err != nil {
		if IsNotGitRepoErr(err) {
			return "", ErrNotGitRepo
		}
		return "", err
	}
	return strings.TrimSpace(out), nil
}

func ResolveRepoRootAndCurrentDir(workdir string) (repoRoot string, relativeDir string, err error) {
	root, err := ResolveRepoRoot(workdir)
	if err != nil {
		return "", "", err
	}
	absWorkdir, err := filepath.Abs(workdir)
	if err != nil {
		return root, ".", nil
	}
	rel, err := filepath.Rel(root, absWorkdir)
	if err != nil {
		return root, ".", nil
	}
	if rel == "." || strings.HasPrefix(rel, "..") {
		rel = "."
	}
	return root, filepath.ToSlash(rel), nil
}

func IsNotGitRepoErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "not a git repository") ||
		strings.Contains(msg, "fatal: not a git repository")
}

func SanitizePath(repoRoot string, unsafePath string) (string, error) {
	if unsafePath == "" || unsafePath == "." || unsafePath == "/" {
		return repoRoot, nil
	}
	cleaned := filepath.Clean(unsafePath)
	if filepath.IsAbs(cleaned) {
		rel, err := filepath.Rel(repoRoot, cleaned)
		if err != nil {
			return "", ErrPathOutsideRepo
		}
		if strings.HasPrefix(rel, "..") {
			return "", ErrPathOutsideRepo
		}
		return filepath.Join(repoRoot, rel), nil
	}
	full := filepath.Join(repoRoot, cleaned)
	full = filepath.Clean(full)
	rel, err := filepath.Rel(repoRoot, full)
	if err != nil {
		return "", ErrPathOutsideRepo
	}
	if strings.HasPrefix(rel, "..") {
		return "", ErrPathOutsideRepo
	}
	return full, nil
}

func ValidatePathspec(pathspec string) error {
	if pathspec == "" {
		return ErrInvalidPathspec
	}
	if strings.Contains(pathspec, "\x00") {
		return ErrInvalidPathspec
	}
	return nil
}

func StatusLabel(idx, wt string) string {
	switch {
	case idx == "?" && wt == "?":
		return "U"
	case idx == "A" && wt == "A":
		return "A"
	case idx == "D" || wt == "D":
		return "D"
	case idx == "M" || wt == "M":
		return "M"
	case idx == "R" || wt == "R":
		return "R"
	case idx == "C" || wt == "C":
		return "C"
	case idx == "U" || wt == "U" || idx == "A" && wt == "U" || idx == "U" && wt == "D":
		return "!"
	default:
		if idx != "." && idx != " " && idx != "" {
			return idx
		}
		if wt != "." && wt != " " && wt != "" {
			return wt
		}
		return "?"
	}
}
