// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package uctypes

import (
	"encoding/json"
	"testing"
)

func TestCitationJSONRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		in   Citation
		want string
	}{
		{
			name: "web",
			in:   Citation{Kind: CitationKindWeb, URL: "https://example.com", Title: "example"},
			want: `{"kind":"web","url":"https://example.com","title":"example"}`,
		},
		{
			name: "file with line range",
			in:   Citation{Kind: CitationKindFile, Title: "pkg/foo.go", LineStart: 12, LineEnd: 18},
			want: `{"kind":"file","title":"pkg/foo.go","linestart":12,"lineend":18}`,
		},
		{
			name: "file with only start line",
			in:   Citation{Kind: CitationKindFile, Title: "pkg/foo.go", LineStart: 42},
			want: `{"kind":"file","title":"pkg/foo.go","linestart":42}`,
		},
		{
			name: "history",
			in:   Citation{Kind: CitationKindHistory, Title: "ls -la"},
			want: `{"kind":"history","title":"ls -la"}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.in)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(b) != tc.want {
				t.Errorf("marshal mismatch\n got: %s\nwant: %s", b, tc.want)
			}
			var got Citation
			if err := json.Unmarshal(b, &got); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if got != tc.in {
				t.Errorf("round-trip mismatch\n got: %+v\nwant: %+v", got, tc.in)
			}
		})
	}
}

func TestAddCitationDedup(t *testing.T) {
	d := &UIMessageDataToolUse{}

	c1 := Citation{Kind: CitationKindFile, Title: "a.go", LineStart: 10}
	c2 := Citation{Kind: CitationKindFile, Title: "a.go", LineStart: 10} // exact dup
	c3 := Citation{Kind: CitationKindFile, Title: "a.go", LineStart: 20} // different line → not a dup
	c4 := Citation{Kind: CitationKindFile, Title: "b.go", LineStart: 10} // different path → not a dup

	d.AddCitation(c1)
	d.AddCitation(c2)
	d.AddCitation(c3)
	d.AddCitation(c4)

	if got := len(d.Citations); got != 3 {
		t.Fatalf("citations len = %d, want 3 (c2 should dedup against c1)", got)
	}
	if d.Citations[0] != c1 || d.Citations[1] != c3 || d.Citations[2] != c4 {
		t.Errorf("unexpected order/contents: %+v", d.Citations)
	}
}

func TestAddCitationIgnoresEmptyKind(t *testing.T) {
	d := &UIMessageDataToolUse{}
	d.AddCitation(Citation{Title: "no kind"})
	if len(d.Citations) != 0 {
		t.Errorf("empty-kind citation should be ignored, got %+v", d.Citations)
	}
}

func TestAddCitationNilReceiverIsNoOp(t *testing.T) {
	var d *UIMessageDataToolUse
	// Should not panic. Method-on-nil-pointer is valid because AddCitation
	// guards against nil before any field deref.
	d.AddCitation(Citation{Kind: CitationKindWeb, Title: "x"})
}
