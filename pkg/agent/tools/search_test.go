// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package tools

import "testing"

func TestParseGrepLine(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		path    string
		lineNum int
		ok      bool
	}{
		{
			name:    "simple unix path",
			in:      "pkg/foo.go:42:    return nil",
			path:    "pkg/foo.go",
			lineNum: 42,
			ok:      true,
		},
		{
			name:    "absolute path",
			in:      "/home/user/proj/main.go:1:package main",
			path:    "/home/user/proj/main.go",
			lineNum: 1,
			ok:      true,
		},
		{
			name:    "content with colons survives",
			in:      "config.yaml:7:  host: localhost:8080",
			path:    "config.yaml",
			lineNum: 7,
			ok:      true,
		},
		{
			name: "no colon",
			in:   "binary file matches",
			ok:   false,
		},
		{
			name: "missing line number",
			in:   "file.go::content",
			ok:   false,
		},
		{
			name: "non-numeric line",
			in:   "file.go:abc:content",
			ok:   false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path, lineNum, ok := parseGrepLine(tc.in)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if !tc.ok {
				return
			}
			if path != tc.path {
				t.Errorf("path = %q, want %q", path, tc.path)
			}
			if lineNum != tc.lineNum {
				t.Errorf("lineNum = %d, want %d", lineNum, tc.lineNum)
			}
		})
	}
}

func TestParseRipgrepJSONReturnsHits(t *testing.T) {
	// One match row, one non-match row that should be ignored.
	rgOut := `{"type":"match","data":{"path":{"text":"a.go"},"line_number":10,"lines":{"text":"foo bar\n"}}}
{"type":"summary","data":{}}
{"type":"match","data":{"path":{"text":"b.go"},"line_number":3,"lines":{"text":"baz\n"}}}
`
	text, hits := parseRipgrepJSON(rgOut, 10)
	if text == "" {
		t.Fatal("expected non-empty text")
	}
	if len(hits) != 2 {
		t.Fatalf("hits len = %d, want 2", len(hits))
	}
	if hits[0].Path != "a.go" || hits[0].Line != 10 {
		t.Errorf("hit[0] = %+v, want {a.go, 10}", hits[0])
	}
	if hits[1].Path != "b.go" || hits[1].Line != 3 {
		t.Errorf("hit[1] = %+v, want {b.go, 3}", hits[1])
	}
}

func TestParseRipgrepJSONRespectsMaxResults(t *testing.T) {
	rgOut := `{"type":"match","data":{"path":{"text":"a.go"},"line_number":1,"lines":{"text":"a\n"}}}
{"type":"match","data":{"path":{"text":"a.go"},"line_number":2,"lines":{"text":"b\n"}}}
{"type":"match","data":{"path":{"text":"a.go"},"line_number":3,"lines":{"text":"c\n"}}}
`
	_, hits := parseRipgrepJSON(rgOut, 2)
	if len(hits) != 2 {
		t.Errorf("hits len = %d, want 2 (capped by maxResults)", len(hits))
	}
}
