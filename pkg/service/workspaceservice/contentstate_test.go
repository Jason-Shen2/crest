// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"bytes"
	"encoding/json"
	"log"
	"reflect"
	"strings"
	"testing"

	"github.com/s-zx/crest/pkg/waveobj"
)

func TestNormalizeWorkspaceContentStateLogsDuplicateDescriptorsWithoutSecrets(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previous) })

	NormalizeWorkspaceContentState(waveobj.WorkspaceContentState{
		ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
		TopTabs: []waveobj.TopTabDescriptor{
			{Id: "secret-first", Kind: waveobj.TopTabKindFile, Path: "/secret/first.ts", Title: "secret-title"},
			{Id: "secret-first", Kind: waveobj.TopTabKindPreview, Path: "/secret/preview.md", Title: "secret-preview"},
			{Id: "secret-alias", Kind: waveobj.TopTabKindFile, Path: "/secret/first.ts", Title: "secret-alias-title"},
		},
	}, "")

	logged := output.String()
	for _, expected := range []string{
		"index=1 kind=preview reason=duplicate-id",
		"index=2 kind=file reason=duplicate-identity",
	} {
		if !strings.Contains(logged, expected) {
			t.Fatalf("missing structured log %q in %q", expected, logged)
		}
	}
	if strings.Contains(logged, "secret") {
		t.Fatalf("descriptor secrets leaked in log: %q", logged)
	}
}

func TestTopTabDescriptorContract(t *testing.T) {
	descriptor := waveobj.TopTabDescriptor{
		Id:           "diff-1",
		Kind:         waveobj.TopTabKindGitDiff,
		RepoRoot:     "/repo",
		Path:         "src/app.ts",
		Mode:         "+",
		OriginalPath: "src/old-app.ts",
		Title:        "app.ts",
	}
	encoded, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	expected := `{"id":"diff-1","kind":"git-diff","path":"src/app.ts","title":"app.ts","reporoot":"/repo","mode":"+","originalpath":"src/old-app.ts"}`
	if string(encoded) != expected {
		t.Fatalf("expected %s, got %s", expected, encoded)
	}
}

func TestNormalizeWorkspaceContentStateFinalTopTabContract(t *testing.T) {
	validFile := waveobj.TopTabDescriptor{Id: "file", Kind: waveobj.TopTabKindFile, Path: "/tmp/file.ts", Title: "File"}
	validPreview := waveobj.TopTabDescriptor{Id: "preview", Kind: waveobj.TopTabKindPreview, Path: "/tmp/preview.md", Title: "Preview"}
	validDiff := waveobj.TopTabDescriptor{
		Id:           "diff",
		Kind:         waveobj.TopTabKindGitDiff,
		RepoRoot:     "/repo",
		Path:         "src/app.ts",
		Mode:         "-",
		OriginalPath: "src/old-app.ts",
		Title:        "Diff",
	}
	state := waveobj.WorkspaceContentState{
		ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
		TopTabs: []waveobj.TopTabDescriptor{
			{Id: "browser", Kind: waveobj.TopTabKindBrowser, Title: "Browser"},
			{Id: "bad-mode", Kind: waveobj.TopTabKindGitDiff, RepoRoot: "/repo", Path: "src/app.ts", Mode: "x", Title: "Bad Mode"},
			validFile,
			{Id: "bad-path", Kind: waveobj.TopTabKindGitDiff, RepoRoot: "/repo", Mode: "+", Title: "Bad Path"},
			validPreview,
			validDiff,
		},
	}

	actual := NormalizeWorkspaceContentState(state, "")
	expected := waveobj.WorkspaceContentState{
		ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
		TopTabs:       []waveobj.TopTabDescriptor{validFile, validPreview, validDiff},
	}
	if !reflect.DeepEqual(expected, actual) {
		t.Fatalf("expected %#v, got %#v", expected, actual)
	}
}

func TestNormalizeWorkspaceContentStateGitDiffIdentity(t *testing.T) {
	makeDiff := func(id string, repoRoot string, path string, mode string, originalPath string) waveobj.TopTabDescriptor {
		return waveobj.TopTabDescriptor{
			Id: id, Kind: waveobj.TopTabKindGitDiff, RepoRoot: repoRoot,
			Path: path, Mode: mode, OriginalPath: originalPath, Title: id,
		}
	}
	descriptors := []waveobj.TopTabDescriptor{
		makeDiff("base", `C:\Repo\.\`, "src/../app.ts", "+", "src/old.ts"),
		makeDiff("normalized-equivalent", "c:/repo", "app.ts", "+", "src/old.ts"),
		makeDiff("repo-change", "C:/other", "app.ts", "+", "src/old.ts"),
		makeDiff("path-change", "C:/repo", "other.ts", "+", "src/old.ts"),
		makeDiff("mode-change", "C:/repo", "app.ts", "-", "src/old.ts"),
		makeDiff("original-change", "C:/repo", "app.ts", "+", "src/older.ts"),
		makeDiff("delimiter-a", "C:/repo", "a\x00b", "+", "c"),
		makeDiff("delimiter-b", "C:/repo\x00a", "b", "+", "c"),
		makeDiff("unicode-drive-a", "C:/İ", "file.ts", "+", ""),
		makeDiff("unicode-drive-b", "c:/i\u0307", "file.ts", "+", ""),
		makeDiff("unicode-unc-a", "//Server/İ", "file.ts", "+", ""),
		makeDiff("unicode-unc-b", "//server/i\u0307", "file.ts", "+", ""),
	}

	actual := NormalizeWorkspaceContentState(waveobj.WorkspaceContentState{
		ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
		TopTabs:       descriptors,
	}, "")
	actualIds := make([]string, 0, len(actual.TopTabs))
	for _, descriptor := range actual.TopTabs {
		actualIds = append(actualIds, descriptor.Id)
	}
	expectedIds := []string{
		"base",
		"repo-change",
		"path-change",
		"mode-change",
		"original-change",
		"delimiter-a",
		"delimiter-b",
		"unicode-drive-a",
		"unicode-drive-b",
		"unicode-unc-a",
		"unicode-unc-b",
	}
	if !reflect.DeepEqual(expectedIds, actualIds) {
		t.Fatalf("expected ids %#v, got %#v", expectedIds, actualIds)
	}
}

func TestNormalizeWorkspaceContentState(t *testing.T) {
	fileTab := waveobj.TopTabDescriptor{Id: "file-1", Kind: waveobj.TopTabKindFile, Path: "/tmp/file", Title: "File"}
	browserTab := waveobj.TopTabDescriptor{Id: "browser-1", Kind: waveobj.TopTabKindBrowser, Title: "Browser"}

	tests := []struct {
		name       string
		state      waveobj.WorkspaceContentState
		terminalId string
		expected   waveobj.WorkspaceContentState
	}{
		{
			name: "valid active file",
			state: waveobj.WorkspaceContentState{
				ActiveContent:      waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: fileTab.Id},
				TopTabs:            []waveobj.TopTabDescriptor{fileTab},
				LastActiveTopTabId: fileTab.Id,
			},
			terminalId: "terminal-1",
			expected: waveobj.WorkspaceContentState{
				ActiveContent:      waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: fileTab.Id},
				TopTabs:            []waveobj.TopTabDescriptor{fileTab},
				LastActiveTopTabId: fileTab.Id,
			},
		},
		{
			name: "invalid descriptor falls back to terminal",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "missing-path"},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "missing-path", Kind: waveobj.TopTabKindFile, Title: "Invalid"},
				},
				LastActiveTopTabId: "missing-path",
			},
			terminalId: "terminal-1",
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: "terminal-1"},
				TopTabs:       []waveobj.TopTabDescriptor{},
			},
		},
		{
			name: "falls back to agent without terminal",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "missing"},
			},
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs:       []waveobj.TopTabDescriptor{},
			},
		},
		{
			name: "last active top tab precedes terminal",
			state: waveobj.WorkspaceContentState{
				ActiveContent:      waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "missing"},
				TopTabs:            []waveobj.TopTabDescriptor{fileTab},
				LastActiveTopTabId: fileTab.Id,
			},
			terminalId: "terminal-1",
			expected: waveobj.WorkspaceContentState{
				ActiveContent:      waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: fileTab.Id},
				TopTabs:            []waveobj.TopTabDescriptor{fileTab},
				LastActiveTopTabId: fileTab.Id,
			},
		},
		{
			name: "duplicate ids are dropped independently",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					fileTab,
					{Id: fileTab.Id, Kind: waveobj.TopTabKindPreview, Path: "/tmp/preview", Title: "Duplicate"},
					browserTab,
				},
				LastActiveTopTabId: fileTab.Id,
			},
			terminalId: "terminal-1",
			expected: waveobj.WorkspaceContentState{
				ActiveContent:      waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs:            []waveobj.TopTabDescriptor{fileTab},
				LastActiveTopTabId: fileTab.Id,
			},
		},
		{
			name: "wrong terminal id uses last active top tab",
			state: waveobj.WorkspaceContentState{
				ActiveContent:      waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: "old-terminal"},
				TopTabs:            []waveobj.TopTabDescriptor{fileTab},
				LastActiveTopTabId: fileTab.Id,
			},
			terminalId: "terminal-1",
			expected: waveobj.WorkspaceContentState{
				ActiveContent:      waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: fileTab.Id},
				TopTabs:            []waveobj.TopTabDescriptor{fileTab},
				LastActiveTopTabId: fileTab.Id,
			},
		},
		{
			name: "invalid browser scheme is dropped",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "browser-1", Kind: waveobj.TopTabKindBrowser, Title: "Invalid"},
				},
			},
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs:       []waveobj.TopTabDescriptor{},
			},
		},
		{
			name: "browser urls without hostnames are dropped",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "http-port-only", Kind: waveobj.TopTabKindBrowser, Title: "Invalid HTTP"},
					{Id: "https-port-only", Kind: waveobj.TopTabKindBrowser, Title: "Invalid HTTPS"},
				},
			},
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs:       []waveobj.TopTabDescriptor{},
			},
		},
		{
			name: "browser urls with invalid ports are dropped",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "bad-port", Kind: waveobj.TopTabKindBrowser, Title: "Bad Port"},
					{Id: "large-port", Kind: waveobj.TopTabKindBrowser, Title: "Large Port"},
				},
			},
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs:       []waveobj.TopTabDescriptor{},
			},
		},
		{
			name: "valid browser urls are dropped",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "ipv6", Kind: waveobj.TopTabKindBrowser, Title: "IPv6"},
					{Id: "port", Kind: waveobj.TopTabKindBrowser, Title: "Port"},
				},
			},
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs:       []waveobj.TopTabDescriptor{},
			},
		},
		{
			name: "browser urls with ipv6 zones are dropped",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "ipv6-zone", Kind: waveobj.TopTabKindBrowser, Title: "IPv6 Zone"},
					{Id: "ipv6", Kind: waveobj.TopTabKindBrowser, Title: "IPv6"},
				},
			},
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs:       []waveobj.TopTabDescriptor{},
			},
		},
		{
			name: "relative file and preview paths are dropped",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "relative-file", Kind: waveobj.TopTabKindFile, Path: "src/file.ts", Title: "Relative"},
					{Id: "drive-relative", Kind: waveobj.TopTabKindFile, Path: "C:src/file.ts", Title: "Drive Relative"},
					{Id: "relative-preview", Kind: waveobj.TopTabKindPreview, Path: "preview.md", Title: "Preview"},
					{Id: "incomplete-unc", Kind: waveobj.TopTabKindFile, Path: "\\\\server", Title: "Incomplete UNC"},
					{Id: "posix", Kind: waveobj.TopTabKindFile, Path: "/tmp/file.ts", Title: "POSIX"},
					{Id: "drive", Kind: waveobj.TopTabKindFile, Path: "C:\\repo\\file.ts", Title: "Drive"},
					{Id: "unc", Kind: waveobj.TopTabKindPreview, Path: "\\\\server\\share\\preview.md", Title: "UNC"},
				},
			},
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "posix", Kind: waveobj.TopTabKindFile, Path: "/tmp/file.ts", Title: "POSIX"},
					{Id: "drive", Kind: waveobj.TopTabKindFile, Path: "C:\\repo\\file.ts", Title: "Drive"},
					{Id: "unc", Kind: waveobj.TopTabKindPreview, Path: "\\\\server\\share\\preview.md", Title: "UNC"},
				},
			},
		},
		{
			name: "invalid preview and git diff descriptors are dropped",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "preview-1", Kind: waveobj.TopTabKindPreview, Title: "Invalid Preview"},
					{Id: "diff-1", Kind: waveobj.TopTabKindGitDiff, RepoRoot: "/repo", Path: "src/app.ts", Mode: "x", Title: "Invalid Diff"},
					fileTab,
				},
			},
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs:       []waveobj.TopTabDescriptor{fileTab},
			},
		},
		{
			name: "valid preview and git diff descriptors survive",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "preview-1", Kind: waveobj.TopTabKindPreview, Path: "/tmp/preview", Title: "Preview"},
					{Id: "diff-1", Kind: waveobj.TopTabKindGitDiff, RepoRoot: "/repo", Path: "src/app.ts", Mode: "+", OriginalPath: "", Title: "Diff"},
				},
			},
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: "preview-1", Kind: waveobj.TopTabKindPreview, Path: "/tmp/preview", Title: "Preview"},
					{Id: "diff-1", Kind: waveobj.TopTabKindGitDiff, RepoRoot: "/repo", Path: "src/app.ts", Mode: "+", OriginalPath: "", Title: "Diff"},
				},
			},
		},
		{
			name: "valid active terminal survives",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: "terminal-1"},
			},
			terminalId: "terminal-1",
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: "terminal-1"},
				TopTabs:       []waveobj.TopTabDescriptor{},
			},
		},
		{
			name: "unknown active kind falls back to terminal",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: "unknown"},
			},
			terminalId: "terminal-1",
			expected: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: "terminal-1"},
				TopTabs:       []waveobj.TopTabDescriptor{},
			},
		},
		{
			name: "invalid descriptor does not reserve duplicate id",
			state: waveobj.WorkspaceContentState{
				ActiveContent: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: fileTab.Id},
				TopTabs: []waveobj.TopTabDescriptor{
					{Id: fileTab.Id, Kind: waveobj.TopTabKindFile, Title: "Invalid"},
					fileTab,
				},
			},
			expected: waveobj.WorkspaceContentState{
				ActiveContent:      waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: fileTab.Id},
				TopTabs:            []waveobj.TopTabDescriptor{fileTab},
				LastActiveTopTabId: fileTab.Id,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actual := NormalizeWorkspaceContentState(tt.state, tt.terminalId)
			if !reflect.DeepEqual(tt.expected, actual) {
				t.Fatalf("expected %#v, got %#v", tt.expected, actual)
			}
		})
	}
}

func TestActiveContentContentId(t *testing.T) {
	tests := []struct {
		name     string
		active   waveobj.ActiveContent
		expected string
	}{
		{name: "terminal", active: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTerminal, TerminalTabId: "terminal-1"}, expected: "terminal-1"},
		{name: "top tab", active: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindTopTab, TopTabId: "top-1"}, expected: "top-1"},
		{name: "agent", active: waveobj.ActiveContent{Kind: waveobj.ActiveContentKindAgent}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if actual := tt.active.ContentId(); actual != tt.expected {
				t.Fatalf("expected %q, got %q", tt.expected, actual)
			}
		})
	}
}
