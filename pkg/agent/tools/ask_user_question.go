// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ask_user_question — agent-driven multi-choice card.  Structure
// derived from warp:
//   crates/ai/src/agent/action/mod.rs:610-657 (AskUserQuestion shape)
//   app/src/ai/blocklist/inline_action/ask_user_question_view.rs (UX)
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// Flow:
//   1. Agent invokes the tool with a `questions` array.
//   2. ToolVerifyInput parses + writes the payload onto toolusedata.
//      AskQuestion so the FE can render the card.
//   3. ToolApproval returns "needs-approval" unconditionally — the
//      user's answer IS the approval.
//   4. FE collects answers, posts them via WaveAIToolApproveCommand.
//      The usechat dispatcher copies AskAnswers onto toolusedata.
//   5. ToolAnyCallback reads toolusedata.AskAnswers and returns a JSON
//      blob the agent can read on its next turn.

package tools

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/s-zx/crest/pkg/aiusechat/uctypes"
	"github.com/s-zx/crest/pkg/util/utilfn"
)

const (
	askMaxQuestions      = 4
	askMaxOptions        = 4
	askMinOptions        = 2
	askMaxLabelChars     = 80
	askMaxQuestionChars  = 500
	askMaxOtherTextChars = 2000
)

type askUserQuestionInput struct {
	Questions []askInputQuestion `json:"questions"`
}

// askInputQuestion mirrors warp's `AskUserQuestionItem`
// (`action/mod.rs:626-631`).  Answer-shape data (options /
// multiselect / supportsother) lives in the nested `QuestionType`
// variant so future question kinds can be added without breaking
// the item-level wire format.
type askInputQuestion struct {
	QuestionID   string       `json:"questionid,omitempty"`
	Question     string       `json:"question"`
	QuestionType askInputType `json:"questiontype"`
}

// askInputType mirrors warp's `AskUserQuestionType::MultipleChoice`
// variant (`action/mod.rs:611-618`).  `Kind` is the discriminator;
// today only "multiplechoice" is defined.
type askInputType struct {
	Kind          string           `json:"kind"`
	Options       []askInputOption `json:"options"`
	MultiSelect   bool             `json:"multiselect,omitempty"`
	SupportsOther bool             `json:"supportsother,omitempty"`
}

// askInputOption mirrors warp's `AskUserQuestionOption`
// (`action/mod.rs:620-624`): `{ label, recommended }`.  No
// description field — warp doesn't carry one.
type askInputOption struct {
	Label       string `json:"label"`
	Recommended bool   `json:"recommended,omitempty"`
}

// AskUserQuestion builds the tool definition.  The single dependency
// is an `approval` callback for non-question paths — in practice the
// engine never reaches it because verifyAsk returns NeedsApproval
// itself, but the field is required by the ToolDefinition contract.
func AskUserQuestion(approval func(any) string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:        "ask_user_question",
		DisplayName: "Ask the user",
		Description: "Ask the user a multiple-choice question when a step has genuinely ambiguous paths forward. Returns the user's chosen option(s). Do NOT use for trivial confirmations — only when proceeding without an answer would likely require backtracking.",
		ToolLogName: "agent:ask_user_question",
		Prompt: `ask_user_question: Pause the turn and present a multiple-choice card.
- Use when the next step has 2-4 plausible directions and guessing wrong is expensive (file/route renames, framework picks, breaking-change scoping).
- Do NOT use for "should I proceed?" — that's just noise. Make the call and act.
- Each question carries a "questiontype" object — today only kind="multiplechoice" is supported. Put options/multiselect/supportsother on the questiontype, not on the question itself.
- 2-4 options per question. Concise labels, 1-5 words.
- Set "recommended": true on the option you'd take if forced to guess; the FE highlights it.
- Set "supportsother": true when the user might want a free-form answer outside your options (e.g. "name this thing").
- Cap: 4 questions per call. Group them in one call rather than calling repeatedly.
- The result is JSON-encoded: { "answers": [{ "questionid", "choices": ["..."], "othertext": "..." }] }.`,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"questions": map[string]any{
					"type":        "array",
					"minItems":    1,
					"maxItems":    askMaxQuestions,
					"description": "Up to 4 questions to present at once.",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"questionid": map[string]any{
								"type":        "string",
								"description": "Stable id echoed back in the answer; pick something short and human-readable like \"framework\" or \"rename-route\".",
							},
							"question": map[string]any{
								"type":        "string",
								"description": "The question text shown above the options.",
							},
							"questiontype": map[string]any{
								"type":        "object",
								"description": "Answer-shape descriptor.  Today the only supported kind is \"multiplechoice\".",
								"properties": map[string]any{
									"kind": map[string]any{
										"type":        "string",
										"enum":        []string{uctypes.AskUserQuestionTypeMultipleChoice},
										"description": "Discriminator. Must be \"multiplechoice\".",
									},
									"options": map[string]any{
										"type":     "array",
										"minItems": askMinOptions,
										"maxItems": askMaxOptions,
										"items": map[string]any{
											"type": "object",
											"properties": map[string]any{
												"label": map[string]any{
													"type":        "string",
													"description": "Concise option title (1-5 words).",
												},
												"recommended": map[string]any{
													"type":        "boolean",
													"description": "Set on the option you'd take by default; the FE highlights it.",
												},
											},
											"required":             []string{"label"},
											"additionalProperties": false,
										},
									},
									"multiselect": map[string]any{
										"type":        "boolean",
										"description": "When true, the user can pick more than one option.",
									},
									"supportsother": map[string]any{
										"type":        "boolean",
										"description": "When true, the FE shows an \"Other\" fallback that lets the user type a free-form answer.",
									},
								},
								"required":             []string{"kind", "options"},
								"additionalProperties": false,
							},
						},
						"required":             []string{"question", "questiontype"},
						"additionalProperties": false,
					},
				},
			},
			"required":             []string{"questions"},
			"additionalProperties": false,
		},
		// Always gate on user response; the answer IS the approval.
		ToolApproval: func(_ any) string {
			return uctypes.ApprovalNeedsApproval
		},
		// ToolVerifyInput shapes + persists the payload onto toolusedata.
		// Returning a non-nil error here surfaces as a tool-call error
		// without ever reaching the FE (the existing dispatcher flow).
		ToolVerifyInput: func(input any, data *uctypes.UIMessageDataToolUse) error {
			payload, err := parseAskUserQuestionInput(input)
			if err != nil {
				return err
			}
			data.AskQuestion = payload
			return nil
		},
		ToolAnyCallback: func(input any, data *uctypes.UIMessageDataToolUse) (any, error) {
			// We only reach here after the user has answered. Format
			// the answers as a JSON object the agent can parse on its
			// next turn. Empty answers are still valid (user denied
			// with no selections) — the agent should treat that as
			// "no answer, proceed without confirmation".
			if data == nil {
				return "", fmt.Errorf("ask_user_question: tool-use data missing")
			}
			out := struct {
				Answers []uctypes.AskUserQuestionAnswer `json:"answers"`
			}{
				Answers: data.AskAnswers,
			}
			b, err := json.Marshal(out)
			if err != nil {
				return "", fmt.Errorf("serialize answers: %w", err)
			}
			return string(b), nil
		},
		ToolCallDesc: func(input any, _ any, _ *uctypes.UIMessageDataToolUse) string {
			payload, err := parseAskUserQuestionInput(input)
			if err != nil {
				return fmt.Sprintf("ask_user_question (invalid: %v)", err)
			}
			if len(payload.Questions) == 1 {
				return fmt.Sprintf("ask: %s", utilfn.TruncateString(payload.Questions[0].Question, 60))
			}
			return fmt.Sprintf("ask %d questions", len(payload.Questions))
		},
		// Approval callback (above) handles dispatch; this field is the
		// fallback used by paths that bypass ToolApproval.
	}
}

func parseAskUserQuestionInput(input any) (*uctypes.AskUserQuestionPayload, error) {
	parsed := &askUserQuestionInput{}
	if input == nil {
		return nil, fmt.Errorf("input is required")
	}
	if err := utilfn.ReUnmarshal(parsed, input); err != nil {
		return nil, fmt.Errorf("invalid input: %w", err)
	}
	if len(parsed.Questions) == 0 {
		return nil, fmt.Errorf("at least one question is required")
	}
	if len(parsed.Questions) > askMaxQuestions {
		return nil, fmt.Errorf("at most %d questions allowed; got %d", askMaxQuestions, len(parsed.Questions))
	}
	out := &uctypes.AskUserQuestionPayload{
		Questions: make([]uctypes.AskUserQuestionItem, 0, len(parsed.Questions)),
	}
	seenIds := make(map[string]bool, len(parsed.Questions))
	for i, q := range parsed.Questions {
		q.Question = strings.TrimSpace(q.Question)
		if q.Question == "" {
			return nil, fmt.Errorf("question %d: question text is required", i+1)
		}
		if len(q.Question) > askMaxQuestionChars {
			return nil, fmt.Errorf("question %d: text exceeds %d chars", i+1, askMaxQuestionChars)
		}
		// Validate the nested questiontype variant.  Only the
		// "multiplechoice" kind is implemented; future kinds will
		// add additional branches here.
		kind := strings.TrimSpace(q.QuestionType.Kind)
		if kind == "" {
			return nil, fmt.Errorf("question %d: questiontype.kind is required", i+1)
		}
		if kind != uctypes.AskUserQuestionTypeMultipleChoice {
			return nil, fmt.Errorf("question %d: questiontype.kind %q is not supported (only %q)",
				i+1, q.QuestionType.Kind, uctypes.AskUserQuestionTypeMultipleChoice)
		}
		if len(q.QuestionType.Options) < askMinOptions || len(q.QuestionType.Options) > askMaxOptions {
			return nil, fmt.Errorf("question %d: must have %d-%d options; got %d",
				i+1, askMinOptions, askMaxOptions, len(q.QuestionType.Options))
		}
		id := strings.TrimSpace(q.QuestionID)
		if id == "" {
			id = fmt.Sprintf("q%d", i+1)
		}
		if seenIds[id] {
			return nil, fmt.Errorf("question %d: duplicate questionid %q", i+1, id)
		}
		seenIds[id] = true
		options := make([]uctypes.AskUserQuestionOption, 0, len(q.QuestionType.Options))
		seenLabels := make(map[string]bool, len(q.QuestionType.Options))
		for j, opt := range q.QuestionType.Options {
			label := strings.TrimSpace(opt.Label)
			if label == "" {
				return nil, fmt.Errorf("question %d option %d: label is required", i+1, j+1)
			}
			if len(label) > askMaxLabelChars {
				return nil, fmt.Errorf("question %d option %d: label exceeds %d chars", i+1, j+1, askMaxLabelChars)
			}
			if seenLabels[label] {
				return nil, fmt.Errorf("question %d option %d: duplicate label %q", i+1, j+1, label)
			}
			seenLabels[label] = true
			options = append(options, uctypes.AskUserQuestionOption{
				Label:       label,
				Recommended: opt.Recommended,
			})
		}
		out.Questions = append(out.Questions, uctypes.AskUserQuestionItem{
			QuestionId: id,
			Question:   q.Question,
			QuestionType: uctypes.AskUserQuestionType{
				Kind:          uctypes.AskUserQuestionTypeMultipleChoice,
				Options:       options,
				MultiSelect:   q.QuestionType.MultiSelect,
				SupportsOther: q.QuestionType.SupportsOther,
			},
		})
	}
	return out, nil
}
