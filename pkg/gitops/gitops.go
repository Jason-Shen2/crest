// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package gitops

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func GetRepoInfo(ctx context.Context, repoRoot string) (*GitRepoInfo, error) {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return nil, err
	}
	out, err := runGit(ctx, root, DefaultTimeoutSecs, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return nil, err
	}
	branch := strings.TrimSpace(string(out.Stdout))
	isDetached := branch == "HEAD"
	if isDetached {
		shaOut, err := runGitSimple(ctx, root, "rev-parse", "--short", "HEAD")
		if err == nil {
			branch = fmt.Sprintf("(detached %s)", strings.TrimSpace(shaOut))
		} else {
			branch = "(detached)"
		}
	}
	upstream := ""
	upOut, err := runGitSimple(ctx, root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if err == nil {
		upstream = strings.TrimSpace(upOut)
	}
	remoteURL := getRemoteURL(ctx, root, upstream)
	return &GitRepoInfo{
		RepoRoot:   root,
		Branch:     branch,
		Upstream:   upstream,
		RemoteURL:  remoteURL,
		IsDetached: isDetached,
	}, nil
}

func getRemoteURL(ctx context.Context, repoRoot string, upstream string) string {
	remote := "origin"
	if upstream != "" {
		parts := strings.SplitN(upstream, "/", 2)
		if parts[0] != "" {
			remote = parts[0]
		}
	}
	out, err := runGitSimple(ctx, repoRoot, "config", "--get", "remote."+remote+".url")
	if err == nil {
		return strings.TrimSpace(out)
	}
	if remote != "origin" {
		out, err = runGitSimple(ctx, repoRoot, "config", "--get", "remote.origin.url")
		if err == nil {
			return strings.TrimSpace(out)
		}
	}
	return ""
}

func GetStatus(ctx context.Context, repoRoot string) (*GitStatusSnapshot, error) {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return nil, err
	}
	out, err := runGit(ctx, root, DefaultTimeoutSecs, "status", "--porcelain=v2", "--branch", "-z")
	if err != nil {
		return nil, err
	}
	parsed := parsePorcelainV2(out.Stdout)
	branch := parsed.Branch
	isDetached := parsed.IsDetached
	if isDetached {
		shaOut, err := runGitSimple(ctx, root, "rev-parse", "--short", "HEAD")
		if err == nil {
			branch = fmt.Sprintf("(detached %s)", strings.TrimSpace(shaOut))
		}
	}
	return &GitStatusSnapshot{
		RepoRoot:     root,
		Branch:       branch,
		Upstream:     parsed.Upstream,
		RemoteURL:    getRemoteURL(ctx, root, parsed.Upstream),
		Ahead:        parsed.Ahead,
		Behind:       parsed.Behind,
		IsDetached:   isDetached,
		Truncated:    out.Truncated,
		ChangedFiles: parsed.Files,
	}, nil
}

func GetPanelSnapshot(ctx context.Context, repoRoot string) (*GitPanelSnapshot, error) {
	repo, err := GetRepoInfo(ctx, repoRoot)
	if err != nil {
		return nil, err
	}
	status, err := GetStatus(ctx, repoRoot)
	if err != nil {
		return nil, err
	}
	return &GitPanelSnapshot{
		Repo:   repo,
		Status: status,
	}, nil
}

func StageFile(ctx context.Context, repoRoot string, path string) error {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return err
	}
	safePath, err := SanitizePath(root, path)
	if err != nil {
		return err
	}
	rel, err := relPath(root, safePath)
	if err != nil {
		return err
	}
	_, err = runGit(ctx, root, DefaultTimeoutSecs, "add", "--", rel)
	return err
}

func UnstageFile(ctx context.Context, repoRoot string, path string) error {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return err
	}
	safePath, err := SanitizePath(root, path)
	if err != nil {
		return err
	}
	rel, err := relPath(root, safePath)
	if err != nil {
		return err
	}
	_, err = runGit(ctx, root, DefaultTimeoutSecs, "reset", "HEAD", "--", rel)
	return err
}

func StageAll(ctx context.Context, repoRoot string) error {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return err
	}
	_, err = runGit(ctx, root, DefaultTimeoutSecs, "add", "-A")
	return err
}

func UnstageAll(ctx context.Context, repoRoot string) error {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return err
	}
	_, err = runGit(ctx, root, DefaultTimeoutSecs, "reset")
	return err
}

func DiscardChanges(ctx context.Context, repoRoot string, paths []DiscardEntry) error {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return err
	}
	var toRestore []string
	var toRemove []string
	for _, e := range paths {
		safe, err := SanitizePath(root, e.Path)
		if err != nil {
			return err
		}
		rel, err := relPath(root, safe)
		if err != nil {
			return err
		}
		if e.Untracked {
			toRemove = append(toRemove, rel)
		} else {
			toRestore = append(toRestore, rel)
		}
	}
	if len(toRestore) > 0 {
		args := append([]string{"restore", "--"}, toRestore...)
		_, err := runGit(ctx, root, DefaultTimeoutSecs, args...)
		if err != nil {
			_, _ = runGit(ctx, root, DefaultTimeoutSecs, append([]string{"checkout", "--"}, toRestore...)...)
		}
	}
	if len(toRemove) > 0 {
		args := append([]string{"clean", "-fd", "--"}, toRemove...)
		_, err := runGit(ctx, root, DefaultTimeoutSecs, args...)
		if err != nil {
			return err
		}
	}
	return nil
}

func DiscardAllChanges(ctx context.Context, repoRoot string) error {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return err
	}
	_, rerr := runGit(ctx, root, DefaultTimeoutSecs, "restore", "--worktree", "--", ".")
	if rerr != nil {
		_, _ = runGit(ctx, root, DefaultTimeoutSecs, "checkout", "--", ".")
	}
	_, cleanErr := runGit(ctx, root, DefaultTimeoutSecs, "clean", "-fd")
	if cleanErr != nil {
		return cleanErr
	}
	return nil
}

func Commit(ctx context.Context, repoRoot string, message string, allowEmpty bool) (*GitCommitResult, error) {
	if strings.TrimSpace(message) == "" {
		return nil, ErrEmptyCommitMessage
	}
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return nil, err
	}
	args := []string{"commit", "-m", message}
	if allowEmpty {
		args = append(args, "--allow-empty")
	}
	out, err := runGit(ctx, root, DefaultTimeoutSecs, args...)
	if err != nil {
		if IsNothingToCommit(err) {
			return nil, ErrNothingToCommit
		}
		if IsConflicts(err) {
			return nil, ErrConflicts
		}
		return nil, err
	}
	shaOut, err := runGitSimple(ctx, root, "rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	sha := strings.TrimSpace(shaOut)
	shortSha := sha
	if len(shortSha) > 7 {
		shortSha = shortSha[:7]
	}
	subjOut, err := runGitSimple(ctx, root, "log", "-1", "--format=%s", "HEAD")
	summary := strings.TrimSpace(subjOut)
	_ = out
	return &GitCommitResult{
		CommitSha: shortSha,
		Summary:   summary,
	}, nil
}

func GetDiffForFile(ctx context.Context, repoRoot string, path string, staged bool) (*GitDiffResult, error) {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return nil, err
	}
	safePath, err := SanitizePath(root, path)
	if err != nil {
		return nil, err
	}
	rel, err := relPath(root, safePath)
	if err != nil {
		return nil, err
	}
	args := []string{"diff", "--no-color", "--no-ext-diff"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", rel)
	out, err := runGit(ctx, root, DefaultTimeoutSecs, args...)
	if err != nil {
		return nil, err
	}
	return &GitDiffResult{
		DiffText:  string(out.Stdout),
		Truncated: out.Truncated,
	}, nil
}

func GetDiffContent(ctx context.Context, repoRoot string, path string, originalPath string, staged bool) (*GitDiffContentResult, error) {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return nil, err
	}
	safePath, err := SanitizePath(root, path)
	if err != nil {
		return nil, err
	}
	rel, err := relPath(root, safePath)
	if err != nil {
		return nil, err
	}
	originalRel := rel
	if strings.TrimSpace(originalPath) != "" {
		safeOriginalPath, err := SanitizePath(root, originalPath)
		if err != nil {
			return nil, err
		}
		originalRel, err = relPath(root, safeOriginalPath)
		if err != nil {
			return nil, err
		}
	}
	isBin, err := isBinaryFile(ctx, root, rel, staged)
	if err != nil {
		isBin = false
	}
	if isBin {
		patch, err := GetDiffForFile(ctx, root, rel, staged)
		if err != nil {
			return nil, err
		}
		return &GitDiffContentResult{
			IsBinary:      true,
			FallbackPatch: patch.DiffText,
			Truncated:     patch.Truncated,
		}, nil
	}
	original, err := getFileContent(ctx, root, originalRel, staged, true)
	if err != nil {
		original = ""
	}
	modified, err := getFileContent(ctx, root, rel, staged, false)
	if err != nil {
		modified = ""
	}
	return &GitDiffContentResult{
		OriginalContent: original,
		ModifiedContent: modified,
		IsBinary:        false,
	}, nil
}

func getFileContent(ctx context.Context, repoRoot, path string, staged, original bool) (string, error) {
	var spec string
	if original {
		if staged {
			spec = "HEAD:" + path
		} else {
			spec = ":" + path
		}
	} else {
		if staged {
			spec = ":" + path
		} else {
			abs, err := SanitizePath(repoRoot, path)
			if err != nil {
				return "", err
			}
			return readFileContent(abs)
		}
	}
	out, err := runGit(ctx, repoRoot, DefaultTimeoutSecs, "show", spec)
	if err != nil {
		return "", err
	}
	if out.Truncated {
		return string(out.Stdout), ErrOutputTruncated
	}
	return string(out.Stdout), nil
}

func isBinaryFile(ctx context.Context, repoRoot, path string, staged bool) (bool, error) {
	args := []string{"diff", "--no-color", "--numstat"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", path)
	out, err := runGit(ctx, repoRoot, DefaultTimeoutSecs, args...)
	if err != nil {
		return false, err
	}
	line := strings.TrimSpace(string(out.Stdout))
	if line == "" {
		return false, nil
	}
	parts := strings.SplitN(line, "\t", 3)
	if len(parts) >= 2 && (parts[0] == "-" || parts[1] == "-") {
		return true, nil
	}
	return false, nil
}

func GetLog(ctx context.Context, repoRoot string, limit int, cursorSha string) ([]GitLogEntry, error) {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	format := "%H" + logFieldSep + "%an" + logFieldSep + "%ae" + logFieldSep + "%ct" + logFieldSep + "%P" + logFieldSep + "%s"
	args := []string{"log", "--no-color", "--shortstat", "-n", strconv.Itoa(limit), "--format=" + format}
	if cursorSha != "" {
		if !shaIsSafe(cursorSha) {
			return nil, fmt.Errorf("invalid cursor sha")
		}
		args = append(args, cursorSha+"^")
	}
	out, err := runGit(ctx, root, DefaultTimeoutSecs, args...)
	if err != nil {
		errStr := err.Error()
		if strings.Contains(strings.ToLower(errStr), "does not have any commits yet") ||
			strings.Contains(strings.ToLower(errStr), "bad default revision") ||
			strings.Contains(strings.ToLower(errStr), "unknown revision") {
			return []GitLogEntry{}, nil
		}
		return nil, err
	}
	entries := parseGitLog(out.Stdout)
	return entries, nil
}

func GetCommitFiles(ctx context.Context, repoRoot string, sha string) ([]GitCommitFileChange, error) {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return nil, err
	}
	if !shaIsSafe(sha) {
		return nil, fmt.Errorf("invalid commit sha")
	}
	out, err := runGit(ctx, root, DefaultTimeoutSecs, "diff-tree", "--no-commit-id", "-r", "-z", "--raw", "--numstat", sha)
	if err != nil {
		return nil, err
	}
	return parseDiffTreeRawCombined(out.Stdout), nil
}

func GetCommitDiff(ctx context.Context, repoRoot string, sha string) (*GitDiffResult, error) {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return nil, err
	}
	if !shaIsSafe(sha) {
		return nil, fmt.Errorf("invalid commit sha")
	}
	out, err := runGit(ctx, root, DefaultTimeoutSecs, "show", "--no-color", "--no-ext-diff", "--patch-with-stat", sha, "--")
	if err != nil {
		return nil, err
	}
	return &GitDiffResult{
		DiffText:  string(out.Stdout),
		Truncated: out.Truncated,
	}, nil
}

func Push(ctx context.Context, repoRoot string) (*GitPushResult, error) {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return nil, err
	}
	branchOut, err := runGitSimple(ctx, root, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return nil, err
	}
	branch := strings.TrimSpace(branchOut)
	upstreamOut, err := runGitSimple(ctx, root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	remote := ""
	if err == nil {
		up := strings.TrimSpace(upstreamOut)
		parts := strings.SplitN(up, "/", 2)
		if len(parts) >= 1 {
			remote = parts[0]
		}
	}
	out, err := runGit(ctx, root, NetworkTimeoutSecs, "push")
	if err != nil {
		if IsNoUpstream(err) {
			_, err2 := runGit(ctx, root, NetworkTimeoutSecs, "push", "-u", "origin", branch)
			if err2 != nil {
				if IsAuthError(err2) {
					return nil, ErrAuth
				}
				return nil, err2
			}
			return &GitPushResult{Remote: "origin", Branch: branch, Pushed: true}, nil
		}
		if IsAuthError(err) {
			return nil, ErrAuth
		}
		return nil, err
	}
	_ = out
	if remote == "" {
		remote = "origin"
	}
	return &GitPushResult{Remote: remote, Branch: branch, Pushed: true}, nil
}

func Pull(ctx context.Context, repoRoot string) error {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return err
	}
	_, err = runGit(ctx, root, NetworkTimeoutSecs, "pull", "--no-rebase")
	if err != nil {
		if IsAuthError(err) {
			return ErrAuth
		}
		if IsConflicts(err) {
			return ErrConflicts
		}
	}
	return err
}

func Fetch(ctx context.Context, repoRoot string) error {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return err
	}
	_, err = runGit(ctx, root, NetworkTimeoutSecs, "fetch", "--all", "--prune")
	if err != nil {
		if IsAuthError(err) {
			return ErrAuth
		}
	}
	return err
}

func ListBranches(ctx context.Context, repoRoot string) (*GitBranchListResult, error) {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return nil, err
	}
	out, err := runGitSimple(ctx, root, "branch", "--list", "-a", "--format=%(refname:short)|%(objectname)|%(worktreepath)")
	if err != nil {
		return nil, err
	}
	headBranch := ""
	hb, err := runGitSimple(ctx, root, "rev-parse", "--abbrev-ref", "HEAD")
	if err == nil {
		headBranch = strings.TrimSpace(hb)
	}
	entries := make([]GitBranchEntry, 0)
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		name := parts[0]
		wt := ""
		if len(parts) >= 3 {
			wt = parts[2]
		}
		kind := "local"
		if strings.HasPrefix(name, "remotes/") {
			kind = "remote"
			name = strings.TrimPrefix(name, "remotes/")
		}
		if strings.HasPrefix(name, "origin/HEAD") {
			continue
		}
		isHead := name == headBranch
		isDetached := false
		entries = append(entries, GitBranchEntry{
			Name:         name,
			Kind:         kind,
			WorktreePath: wt,
			IsHead:       isHead,
			IsDetached:   isDetached,
		})
	}
	return &GitBranchListResult{Branches: entries}, nil
}

func CheckoutBranch(ctx context.Context, repoRoot string, branch string) error {
	root, err := ResolveRepoRoot(repoRoot)
	if err != nil {
		return err
	}
	_, err = runGit(ctx, root, DefaultTimeoutSecs, "checkout", branch)
	return err
}

func relPath(repoRoot, absPath string) (string, error) {
	rel, err := filepath.Rel(repoRoot, absPath)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(rel), nil
}

func readFileContent(absPath string) (string, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", err
	}
	if len(data) > MaxOutputBytes {
		return string(data[:MaxOutputBytes]), ErrOutputTruncated
	}
	return string(data), nil
}
