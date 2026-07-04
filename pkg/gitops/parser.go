// Copyright 2026, s-zx
// SPDX-License-Identifier: Apache-2.0

package gitops

import (
	"strconv"
	"strings"
)

type porcelainV2Result struct {
	Branch     string
	Upstream   string
	Ahead      int
	Behind     int
	IsDetached bool
	Files      []GitChangedFile
}

func parsePorcelainV2(stdout []byte) porcelainV2Result {
	out := porcelainV2Result{
		Branch: "HEAD",
	}
	s := string(stdout)
	tokens := strings.Split(s, "\x00")
	i := 0
	for i < len(tokens) {
		tok := tokens[i]
		i++
		if tok == "" {
			continue
		}
		if rest, ok := strings.CutPrefix(tok, "# branch.head "); ok {
			out.Branch = rest
			out.IsDetached = rest == "(detached)"
			continue
		}
		if rest, ok := strings.CutPrefix(tok, "# branch.upstream "); ok {
			out.Upstream = rest
			continue
		}
		if rest, ok := strings.CutPrefix(tok, "# branch.ab "); ok {
			parts := strings.Fields(rest)
			if len(parts) >= 1 {
				a := strings.TrimPrefix(parts[0], "+")
				out.Ahead, _ = strconv.Atoi(a)
			}
			if len(parts) >= 2 {
				b := strings.TrimPrefix(parts[1], "-")
				out.Behind, _ = strconv.Atoi(b)
			}
			continue
		}
		if strings.HasPrefix(tok, "# ") {
			continue
		}
		if rest, ok := strings.CutPrefix(tok, "1 "); ok {
			if f := parseOrdinary(rest); f != nil {
				out.Files = append(out.Files, *f)
			}
			continue
		}
		if rest, ok := strings.CutPrefix(tok, "2 "); ok {
			orig := ""
			if i < len(tokens) {
				orig = tokens[i]
				i++
			}
			if f := parseRenamed(rest, orig); f != nil {
				out.Files = append(out.Files, *f)
			}
			continue
		}
		if rest, ok := strings.CutPrefix(tok, "u "); ok {
			if f := parseUnmerged(rest); f != nil {
				out.Files = append(out.Files, *f)
			}
			continue
		}
		if rest, ok := strings.CutPrefix(tok, "? "); ok {
			out.Files = append(out.Files, makeChangedFile("?", "?", rest, ""))
			continue
		}
	}
	return out
}

func skipFields(s string, n int) (string, bool) {
	rest := s
	for j := 0; j < n; j++ {
		idx := strings.IndexByte(rest, ' ')
		if idx < 0 {
			return "", false
		}
		rest = rest[idx+1:]
	}
	return rest, true
}

func xyChars(xy string) (string, string) {
	if len(xy) < 2 {
		return " ", " "
	}
	ci := string(xy[0])
	cw := string(xy[1])
	if ci == "." {
		ci = " "
	}
	if cw == "." {
		cw = " "
	}
	return ci, cw
}

func parseOrdinary(rest string) *GitChangedFile {
	if len(rest) < 2 {
		return nil
	}
	xy := rest[:2]
	path, ok := skipFields(rest, 7)
	if !ok {
		return nil
	}
	i, w := xyChars(xy)
	f := makeChangedFile(i, w, path, "")
	return &f
}

func parseRenamed(rest string, origPath string) *GitChangedFile {
	if len(rest) < 2 {
		return nil
	}
	xy := rest[:2]
	path, ok := skipFields(rest, 8)
	if !ok {
		return nil
	}
	i, w := xyChars(xy)
	f := makeChangedFile(i, w, path, origPath)
	return &f
}

func parseUnmerged(rest string) *GitChangedFile {
	if len(rest) < 2 {
		return nil
	}
	xy := rest[:2]
	path, ok := skipFields(rest, 9)
	if !ok {
		return nil
	}
	i, w := xyChars(xy)
	f := makeChangedFile(i, w, path, "")
	return &f
}

func makeChangedFile(idx, wt, path, origPath string) GitChangedFile {
	lab := statusLabelFull(idx, wt)
	staged := isStaged(idx, wt)
	unstaged := isUnstaged(idx, wt)
	untracked := idx == "?" && wt == "?"
	return GitChangedFile{
		Path:           path,
		OriginalPath:   origPath,
		IndexStatus:    idx,
		WorktreeStatus: wt,
		Staged:         staged,
		Unstaged:       unstaged,
		Untracked:      untracked,
		StatusLabel:    lab,
	}
}

func isStaged(idx, wt string) bool {
	_ = wt
	return idx != " " && !(idx == "?" && wt == "?")
}

func isUnstaged(idx, wt string) bool {
	return wt != " " || (idx == "?" && wt == "?")
}

func statusLabelFull(idx, wt string) string {
	switch {
	case idx == "?" && wt == "?":
		return "Untracked"
	case idx == "A":
		return "Added"
	case idx == "M" || wt == "M":
		return "Modified"
	case idx == "D" || wt == "D":
		return "Deleted"
	case idx == "R" || wt == "R":
		return "Renamed"
	case idx == "C" || wt == "C":
		return "Copied"
	case idx == "U" || wt == "U":
		return "Unmerged"
	default:
		return "Changed"
	}
}

const logFieldSep = "\x1f"

func parseGitLog(stdout []byte) []GitLogEntry {
	s := string(stdout)
	entries := make([]GitLogEntry, 0, 32)
	for _, rawLine := range strings.Split(s, "\n") {
		line := strings.TrimRight(rawLine, "\r")
		if line == "" {
			continue
		}
		if strings.Contains(line, logFieldSep) {
			fields := strings.SplitN(line, logFieldSep, 6)
			for len(fields) < 6 {
				fields = append(fields, "")
			}
			sha := fields[0]
			if !shaIsSafe(sha) {
				continue
			}
			author := fields[1]
			email := fields[2]
			ts, _ := strconv.ParseInt(fields[3], 10, 64)
			parents := strings.Fields(fields[4])
			subject := fields[5]
			shortSha := sha
			if len(shortSha) > 7 {
				shortSha = shortSha[:7]
			}
			entries = append(entries, GitLogEntry{
				Sha:           sha,
				ShortSha:      shortSha,
				Author:        author,
				AuthorEmail:   email,
				TimestampSecs: ts,
				Parents:       parents,
				Subject:       subject,
			})
			continue
		}
		if len(entries) > 0 {
			cur := &entries[len(entries)-1]
			trimmed := strings.TrimSpace(line)
			if strings.Contains(trimmed, "file changed") || strings.Contains(trimmed, "files changed") {
				files, ins, del := parseShortstat(trimmed)
				cur.FilesChanged = files
				cur.Insertions = ins
				cur.Deletions = del
			}
		}
	}
	return entries
}

func parseShortstat(line string) (int, int, int) {
	files := 0
	ins := 0
	del := 0
	for _, part := range strings.Split(line, ",") {
		part = strings.TrimSpace(part)
		fields := strings.Fields(part)
		if len(fields) == 0 {
			continue
		}
		n, _ := strconv.Atoi(fields[0])
		if strings.Contains(part, "file") {
			files = n
		} else if strings.Contains(part, "insertion") {
			ins = n
		} else if strings.Contains(part, "deletion") {
			del = n
		}
	}
	return files, ins, del
}

func shaIsSafe(sha string) bool {
	if sha == "" || len(sha) > 64 {
		return false
	}
	for _, c := range sha {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func parseDiffTreeNameStatus(stdout []byte) []GitCommitFileChange {
	s := string(stdout)
	tokens := strings.Split(s, "\x00")
	files := make([]GitCommitFileChange, 0)
	i := 0
	for i < len(tokens) {
		tok := tokens[i]
		i++
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		parts := strings.Fields(tok)
		status := parts[0]
		path := ""
		origPath := ""
		if len(parts) >= 2 {
			path = strings.Join(parts[1:], " ")
			if (strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C")) && i < len(tokens) {
				origPath = path
				path = tokens[i]
				i++
			}
		} else {
			if i >= len(tokens) {
				continue
			}
			path = tokens[i]
			i++
			if (strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C")) && i < len(tokens) {
				origPath = path
				path = tokens[i]
				i++
			}
		}
		path = strings.TrimSpace(path)
		origPath = strings.TrimSpace(origPath)
		if path == "" {
			continue
		}
		files = append(files, GitCommitFileChange{
			Path:         path,
			OriginalPath: origPath,
			Status:       status,
			StatusLabel:  fileStatusLabel(status),
		})
	}
	return files
}

func parseDiffTreeCombined(stdout []byte) []GitCommitFileChange {
	nameStatus, numstat := splitNameStatusNumstat(stdout)
	files := parseDiffTreeNameStatus(nameStatus)
	applyNumstat(&files, numstat)
	return files
}

func parseDiffTreeRawCombined(stdout []byte) []GitCommitFileChange {
	rawStatus, numstat := splitNameStatusNumstat(stdout)
	files := parseDiffTreeRawStatus(rawStatus)
	applyNumstat(&files, numstat)
	return files
}

func parseDiffTreeRawStatus(stdout []byte) []GitCommitFileChange {
	s := string(stdout)
	tokens := strings.Split(s, "\x00")
	files := make([]GitCommitFileChange, 0)
	i := 0
	for i < len(tokens) {
		header := strings.TrimSpace(tokens[i])
		i++
		if header == "" {
			continue
		}
		parts := strings.Fields(header)
		if len(parts) == 0 {
			continue
		}
		status := parts[len(parts)-1]
		if i >= len(tokens) {
			continue
		}
		path := strings.TrimSpace(tokens[i])
		i++
		origPath := ""
		if (strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C")) && i < len(tokens) {
			origPath = path
			path = strings.TrimSpace(tokens[i])
			i++
		}
		if path == "" {
			continue
		}
		files = append(files, GitCommitFileChange{
			Path:         path,
			OriginalPath: origPath,
			Status:       status,
			StatusLabel:  fileStatusLabel(status),
		})
	}
	return files
}

func splitNameStatusNumstat(stdout []byte) (nameStatus []byte, numstat []byte) {
	s := string(stdout)
	offset := 0
	for _, tok := range strings.Split(s, "\x00") {
		start := offset
		offset += len(tok) + 1
		if strings.Contains(tok, "\t") {
			return stdout[:start], stdout[start:]
		}
	}
	return stdout, nil
}

func applyNumstat(files *[]GitCommitFileChange, numstat []byte) {
	s := string(numstat)
	if strings.Contains(s, "\x00") {
		tokens := strings.Split(s, "\x00")
		idx := 0
		for idx < len(tokens) {
			header := strings.TrimSpace(tokens[idx])
			idx++
			if header == "" {
				continue
			}
			parts := strings.SplitN(header, "\t", 3)
			if len(parts) < 2 {
				continue
			}
			path := ""
			if len(parts) >= 3 {
				path = strings.TrimSpace(parts[2])
			} else if idx+1 < len(tokens) {
				idx++
				path = strings.TrimSpace(tokens[idx])
				idx++
			}
			applyNumstatEntry(files, path, parts[0], parts[1])
		}
		return
	}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		applyNumstatEntry(files, parts[2], parts[0], parts[1])
	}
}

func applyNumstatEntry(files *[]GitCommitFileChange, path string, addedRaw string, removedRaw string) {
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	added, _ := strconv.Atoi(addedRaw)
	removed, _ := strconv.Atoi(removedRaw)
	for i := range *files {
		f := &(*files)[i]
		if f.Path != path {
			continue
		}
		f.Added = added
		f.Removed = removed
		if addedRaw == "-" || removedRaw == "-" {
			f.IsBinary = true
		}
		return
	}
}

func fileStatusLabel(status string) string {
	switch {
	case strings.HasPrefix(status, "A"):
		return "Added"
	case strings.HasPrefix(status, "M"):
		return "Modified"
	case strings.HasPrefix(status, "D"):
		return "Deleted"
	case strings.HasPrefix(status, "R"):
		return "Renamed"
	case strings.HasPrefix(status, "C"):
		return "Copied"
	case strings.HasPrefix(status, "U"):
		return "Unmerged"
	default:
		return status
	}
}
