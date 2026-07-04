// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package gitops

const DefaultTimeoutSecs = 15
const NetworkTimeoutSecs = 60
const MaxOutputBytes = 10 * 1024 * 1024

type GitRepoInfo struct {
	RepoRoot   string `json:"reporoot"`
	Branch     string `json:"branch"`
	Upstream   string `json:"upstream"`
	RemoteURL  string `json:"remoteurl"`
	IsDetached bool   `json:"isdetached"`
}

type GitChangedFile struct {
	Path           string `json:"path"`
	OriginalPath   string `json:"originalpath"`
	IndexStatus    string `json:"indexstatus"`
	WorktreeStatus string `json:"worktreestatus"`
	Staged         bool   `json:"staged"`
	Unstaged       bool   `json:"unstaged"`
	Untracked      bool   `json:"untracked"`
	StatusLabel    string `json:"statuslabel"`
}

type GitStatusSnapshot struct {
	RepoRoot     string           `json:"reporoot"`
	Branch       string           `json:"branch"`
	Upstream     string           `json:"upstream"`
	RemoteURL    string           `json:"remoteurl"`
	Ahead        int              `json:"ahead"`
	Behind       int              `json:"behind"`
	IsDetached   bool             `json:"isdetached"`
	Truncated    bool             `json:"truncated"`
	ChangedFiles []GitChangedFile `json:"changedfiles"`
}

type GitPanelSnapshot struct {
	Repo   *GitRepoInfo       `json:"repo"`
	Status *GitStatusSnapshot `json:"status"`
}

type GitDiffResult struct {
	DiffText  string `json:"difftext"`
	Truncated bool   `json:"truncated"`
}

type GitDiffContentResult struct {
	OriginalContent string `json:"originalcontent"`
	ModifiedContent string `json:"modifiedcontent"`
	IsBinary        bool   `json:"isbinary"`
	FallbackPatch   string `json:"fallbackpatch"`
	Truncated       bool   `json:"truncated"`
}

type GitCommitResult struct {
	CommitSha string `json:"commitsha"`
	Summary   string `json:"summary"`
}

type GitCommitFileChange struct {
	Path         string `json:"path"`
	OriginalPath string `json:"originalpath"`
	Status       string `json:"status"`
	StatusLabel  string `json:"statuslabel"`
	Added        int    `json:"added"`
	Removed      int    `json:"removed"`
	IsBinary     bool   `json:"isbinary"`
}

type GitLogEntry struct {
	Sha           string   `json:"sha"`
	ShortSha      string   `json:"shortsha"`
	Author        string   `json:"author"`
	AuthorEmail   string   `json:"authoremail"`
	TimestampSecs int64    `json:"timestampsecs"`
	Parents       []string `json:"parents"`
	Subject       string   `json:"subject"`
	FilesChanged  int      `json:"fileschanged"`
	Insertions    int      `json:"insertions"`
	Deletions     int      `json:"deletions"`
}

type GitPushResult struct {
	Remote string `json:"remote"`
	Branch string `json:"branch"`
	Pushed bool   `json:"pushed"`
}

type GitBranchEntry struct {
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	WorktreePath string `json:"worktreepath"`
	IsHead       bool   `json:"ishead"`
	IsDetached   bool   `json:"isdetached"`
}

type GitBranchListResult struct {
	Branches []GitBranchEntry `json:"branches"`
}

type DiscardEntry struct {
	Path      string `json:"path"`
	Untracked bool   `json:"untracked"`
}

type GitOutput struct {
	Stdout    []byte
	Stderr    []byte
	ExitCode  int
	TimedOut  bool
	Truncated bool
}
