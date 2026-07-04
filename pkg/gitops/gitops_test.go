package gitops

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func runTestGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}

func makeTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runTestGit(t, dir, "init")
	runTestGit(t, dir, "config", "user.email", "test@example.com")
	runTestGit(t, dir, "config", "user.name", "Test User")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runTestGit(t, dir, "add", "README.md")
	runTestGit(t, dir, "commit", "-m", "initial")
	return dir
}

func TestGetRepoInfoIncludesRemoteURL(t *testing.T) {
	repo := makeTestRepo(t)
	runTestGit(t, repo, "remote", "add", "origin", "git@github.com:owner/repo.git")

	info, err := GetRepoInfo(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	if info.RemoteURL != "git@github.com:owner/repo.git" {
		t.Fatalf("RemoteURL = %q, want origin URL", info.RemoteURL)
	}
}

func TestGetCommitFilesIncludesFilesAndNumstat(t *testing.T) {
	repo := makeTestRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runTestGit(t, repo, "add", "README.md")
	runTestGit(t, repo, "commit", "-m", "update readme")
	shaOut, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}

	files, err := GetCommitFiles(context.Background(), repo, string(shaOut[:40]))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("len(files) = %d, want 1: %#v", len(files), files)
	}
	got := files[0]
	if got.Path != "README.md" || got.Status != "M" || got.Added != 1 || got.Removed != 0 || got.IsBinary {
		t.Fatalf("file = %#v, want modified README with +1/-0", got)
	}
}

func TestParseDiffTreeCombinedNameStatusAndNumstat(t *testing.T) {
	stdout := []byte("M\x00README.md\x001\t0\tREADME.md\x00")

	files := parseDiffTreeCombined(stdout)
	if len(files) != 1 {
		t.Fatalf("len(files) = %d, want 1: %#v", len(files), files)
	}
	got := files[0]
	if got.Path != "README.md" || got.Status != "M" || got.StatusLabel != "Modified" || got.Added != 1 || got.Removed != 0 || got.IsBinary {
		t.Fatalf("file = %#v, want modified README with +1/-0", got)
	}
}

func TestParseDiffTreeCombinedRenameNumstat(t *testing.T) {
	stdout := []byte("R100\x00old.txt\x00new.txt\x002\t1\x00old.txt\x00new.txt\x00")

	files := parseDiffTreeCombined(stdout)
	if len(files) != 1 {
		t.Fatalf("len(files) = %d, want 1: %#v", len(files), files)
	}
	got := files[0]
	if got.Path != "new.txt" || got.OriginalPath != "old.txt" || got.Status != "R100" || got.StatusLabel != "Renamed" || got.Added != 2 || got.Removed != 1 || got.IsBinary {
		t.Fatalf("file = %#v, want renamed old.txt -> new.txt with +2/-1", got)
	}
}

func TestParseDiffTreeRawCombinedNameStatusAndNumstat(t *testing.T) {
	stdout := []byte(":100644 100644 5626abf 814f4a4 M\x00README.md\x001\t0\tREADME.md\x00")

	files := parseDiffTreeRawCombined(stdout)
	if len(files) != 1 {
		t.Fatalf("len(files) = %d, want 1: %#v", len(files), files)
	}
	got := files[0]
	if got.Path != "README.md" || got.Status != "M" || got.StatusLabel != "Modified" || got.Added != 1 || got.Removed != 0 || got.IsBinary {
		t.Fatalf("file = %#v, want modified README with +1/-0", got)
	}
}
