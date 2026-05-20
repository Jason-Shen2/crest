// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package tools

import (
	"strings"
	"testing"

	"github.com/s-zx/crest/pkg/aiusechat/uctypes"
)

func TestParseAskUserQuestionInput_HappyPath(t *testing.T) {
	in := map[string]any{
		"questions": []any{
			map[string]any{
				"questionid": "framework",
				"question":   "Which framework should we use?",
				"questiontype": map[string]any{
					"kind":          "multiplechoice",
					"multiselect":   false,
					"supportsother": true,
					"options": []any{
						map[string]any{"label": "React", "recommended": true},
						map[string]any{"label": "Vue"},
					},
				},
			},
		},
	}
	out, err := parseAskUserQuestionInput(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.Questions) != 1 {
		t.Fatalf("question count = %d, want 1", len(out.Questions))
	}
	q := out.Questions[0]
	if q.QuestionId != "framework" {
		t.Errorf("questionid = %q, want %q", q.QuestionId, "framework")
	}
	if q.QuestionType.Kind != uctypes.AskUserQuestionTypeMultipleChoice {
		t.Errorf("questiontype.kind = %q", q.QuestionType.Kind)
	}
	if !q.QuestionType.SupportsOther {
		t.Errorf("supportsother should be true")
	}
	if len(q.QuestionType.Options) != 2 {
		t.Fatalf("options len = %d, want 2", len(q.QuestionType.Options))
	}
	if !q.QuestionType.Options[0].Recommended {
		t.Errorf("option[0] should be recommended")
	}
}

func TestParseAskUserQuestionInput_AutoAssignsQuestionId(t *testing.T) {
	in := map[string]any{
		"questions": []any{
			map[string]any{
				"question": "Pick one",
				"questiontype": map[string]any{
					"kind": "multiplechoice",
					"options": []any{
						map[string]any{"label": "A"},
						map[string]any{"label": "B"},
					},
				},
			},
			map[string]any{
				"question": "Pick another",
				"questiontype": map[string]any{
					"kind": "multiplechoice",
					"options": []any{
						map[string]any{"label": "X"},
						map[string]any{"label": "Y"},
					},
				},
			},
		},
	}
	out, err := parseAskUserQuestionInput(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Questions[0].QuestionId != "q1" || out.Questions[1].QuestionId != "q2" {
		t.Errorf("auto-assigned ids = %q,%q want q1,q2",
			out.Questions[0].QuestionId, out.Questions[1].QuestionId)
	}
}

func TestParseAskUserQuestionInput_Rejections(t *testing.T) {
	cases := []struct {
		name string
		in   map[string]any
		// substr the error message should contain
		wantErrSubstr string
	}{
		{
			name:          "no questions",
			in:            map[string]any{"questions": []any{}},
			wantErrSubstr: "at least one question",
		},
		{
			name: "too many questions",
			in: map[string]any{"questions": []any{
				questionFixture("q1", []string{"a", "b"}),
				questionFixture("q2", []string{"a", "b"}),
				questionFixture("q3", []string{"a", "b"}),
				questionFixture("q4", []string{"a", "b"}),
				questionFixture("q5", []string{"a", "b"}),
			}},
			wantErrSubstr: "at most",
		},
		{
			name: "empty question text",
			in: map[string]any{"questions": []any{
				map[string]any{
					"question": "   ",
					"questiontype": map[string]any{
						"kind":    "multiplechoice",
						"options": []any{map[string]any{"label": "x"}, map[string]any{"label": "y"}},
					},
				},
			}},
			wantErrSubstr: "question text is required",
		},
		{
			name: "missing questiontype kind",
			in: map[string]any{"questions": []any{
				map[string]any{
					"question": "Pick",
					"questiontype": map[string]any{
						"options": []any{map[string]any{"label": "a"}, map[string]any{"label": "b"}},
					},
				},
			}},
			wantErrSubstr: "questiontype.kind is required",
		},
		{
			name: "unsupported questiontype kind",
			in: map[string]any{"questions": []any{
				map[string]any{
					"question": "Pick",
					"questiontype": map[string]any{
						"kind":    "freeform",
						"options": []any{map[string]any{"label": "a"}, map[string]any{"label": "b"}},
					},
				},
			}},
			wantErrSubstr: "is not supported",
		},
		{
			name: "too few options",
			in: map[string]any{"questions": []any{
				map[string]any{
					"question": "Pick",
					"questiontype": map[string]any{
						"kind":    "multiplechoice",
						"options": []any{map[string]any{"label": "only one"}},
					},
				},
			}},
			wantErrSubstr: "must have 2-4 options",
		},
		{
			name: "too many options",
			in: map[string]any{"questions": []any{
				map[string]any{
					"question": "Pick",
					"questiontype": map[string]any{
						"kind": "multiplechoice",
						"options": []any{
							map[string]any{"label": "a"},
							map[string]any{"label": "b"},
							map[string]any{"label": "c"},
							map[string]any{"label": "d"},
							map[string]any{"label": "e"},
						},
					},
				},
			}},
			wantErrSubstr: "must have 2-4 options",
		},
		{
			name: "duplicate option labels",
			in: map[string]any{"questions": []any{
				map[string]any{
					"question": "Pick",
					"questiontype": map[string]any{
						"kind": "multiplechoice",
						"options": []any{
							map[string]any{"label": "same"},
							map[string]any{"label": "same"},
						},
					},
				},
			}},
			wantErrSubstr: "duplicate label",
		},
		{
			name: "duplicate question ids",
			in: map[string]any{"questions": []any{
				map[string]any{
					"questionid": "dup",
					"question":   "first",
					"questiontype": map[string]any{
						"kind":    "multiplechoice",
						"options": []any{map[string]any{"label": "a"}, map[string]any{"label": "b"}},
					},
				},
				map[string]any{
					"questionid": "dup",
					"question":   "second",
					"questiontype": map[string]any{
						"kind":    "multiplechoice",
						"options": []any{map[string]any{"label": "x"}, map[string]any{"label": "y"}},
					},
				},
			}},
			wantErrSubstr: "duplicate questionid",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseAskUserQuestionInput(tc.in)
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantErrSubstr) {
				t.Errorf("error %q does not contain %q", err.Error(), tc.wantErrSubstr)
			}
		})
	}
}

// questionFixture builds a minimal valid question with the given id and
// option labels. Test-only helper; used to fill out N-question payloads
// for "too many" checks without bloating the case list.
func questionFixture(id string, optionLabels []string) map[string]any {
	options := make([]any, 0, len(optionLabels))
	for _, l := range optionLabels {
		options = append(options, map[string]any{"label": l})
	}
	return map[string]any{
		"questionid": id,
		"question":   "Pick",
		"questiontype": map[string]any{
			"kind":    "multiplechoice",
			"options": options,
		},
	}
}

func TestAskUserQuestion_ApprovalAlwaysNeedsUser(t *testing.T) {
	td := AskUserQuestion(func(_ any) string { return uctypes.ApprovalAutoApproved })
	if td.ToolApproval == nil {
		t.Fatal("ToolApproval should be set")
	}
	// The tool's own callback overrides whatever approval slot was passed;
	// confirm that intent regardless of the dummy outer approval.
	got := td.ToolApproval(map[string]any{"questions": []any{}})
	if got != uctypes.ApprovalNeedsApproval {
		t.Errorf("ToolApproval returned %q, want %q (always gate on user)",
			got, uctypes.ApprovalNeedsApproval)
	}
}

func TestAskUserQuestion_VerifyInputAttachesPayload(t *testing.T) {
	td := AskUserQuestion(func(_ any) string { return uctypes.ApprovalNeedsApproval })
	data := &uctypes.UIMessageDataToolUse{}
	err := td.ToolVerifyInput(map[string]any{
		"questions": []any{
			map[string]any{
				"questionid": "q",
				"question":   "Pick",
				"questiontype": map[string]any{
					"kind":    "multiplechoice",
					"options": []any{map[string]any{"label": "a"}, map[string]any{"label": "b"}},
				},
			},
		},
	}, data)
	if err != nil {
		t.Fatalf("verify input: %v", err)
	}
	if data.AskQuestion == nil {
		t.Fatal("expected AskQuestion to be populated on toolusedata")
	}
	if len(data.AskQuestion.Questions) != 1 {
		t.Errorf("question count = %d, want 1", len(data.AskQuestion.Questions))
	}
	q := data.AskQuestion.Questions[0]
	if q.QuestionType.Kind != uctypes.AskUserQuestionTypeMultipleChoice {
		t.Errorf("questiontype.kind = %q, want %q", q.QuestionType.Kind, uctypes.AskUserQuestionTypeMultipleChoice)
	}
	if len(q.QuestionType.Options) != 2 {
		t.Errorf("questiontype.options len = %d, want 2", len(q.QuestionType.Options))
	}
}

func TestAskUserQuestion_CallbackFormatsAnswersAsJSON(t *testing.T) {
	td := AskUserQuestion(func(_ any) string { return uctypes.ApprovalNeedsApproval })
	data := &uctypes.UIMessageDataToolUse{
		AskAnswers: []uctypes.AskUserQuestionAnswer{
			{QuestionId: "framework", Choices: []string{"React"}},
			{QuestionId: "router", OtherText: "custom-thing"},
		},
	}
	out, err := td.ToolAnyCallback(nil, data)
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	s, ok := out.(string)
	if !ok {
		t.Fatalf("output type = %T, want string", out)
	}
	if !strings.Contains(s, `"questionid":"framework"`) ||
		!strings.Contains(s, `"choices":["React"]`) ||
		!strings.Contains(s, `"othertext":"custom-thing"`) {
		t.Errorf("answer JSON missing expected fields: %s", s)
	}
}
