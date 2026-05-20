// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ChatRequestOptions, FileUIPart, UIMessage, UIMessagePart } from "ai";

export type SuggestedRule = {
    toolname: string;
    content?: string;
    display: string;
};

// Mirror of pkg/aiusechat/uctypes/uctypes.go Citation. Tools attach these
// to UIMessageDataToolUse to point at the source their output references
// (a web page, a file:line, a prior shell command). Rendered as chips.
export type CitationKind = "web" | "file" | "history" | "doc";

export type Citation = {
    kind: CitationKind;
    url?: string;
    title: string;
    linestart?: number;
    lineend?: number;
};

// Mirror of pkg/aiusechat/uctypes/uctypes.go AskUserQuestion* types.
// Strict port of warp's data shape
// (crates/ai/src/agent/action/mod.rs:611-631) — questiontype carries
// the answer-shape variant so future kinds (freeform, range, …) can
// be added without breaking the item-level wire format.
export type AskUserQuestionOption = {
    label: string;
    recommended?: boolean;
};

export type AskUserQuestionType = {
    kind: "multiplechoice";
    options: AskUserQuestionOption[];
    multiselect?: boolean;
    supportsother?: boolean;
};

export type AskUserQuestionItem = {
    questionid: string;
    question: string;
    questiontype: AskUserQuestionType;
};

export type AskUserQuestionPayload = {
    questions: AskUserQuestionItem[];
};

export type AskUserQuestionAnswer = {
    questionid: string;
    choices?: string[];
    othertext?: string;
};

export type ApprovalDestination = "session" | "localProject" | "sharedProject" | "user";

type WaveUIDataTypes = {
    userfile: {
        filename: string;
        size: number;
        mimetype: string;
        previewurl?: string;
    };
    tooluse: {
        toolcallid: string;
        toolname: string;
        tooldesc: string;
        status: "pending" | "error" | "completed";
        runts?: number;
        errormessage?: string;
        approval?: "needs-approval" | "user-approved" | "user-denied" | "auto-approved" | "timeout";
        blockid?: string;
        // True when the block exists but isn't laid out in the user's
        // tab — the FE shows an "Open block" button to attach it.
        // Currently only set by background shell_exec runs.
        blockhidden?: boolean;
        writebackupfilename?: string;
        inputfilename?: string;
        originalcontent?: string;
        modifiedcontent?: string;
        // Populated when approval == "needs-approval" and the permissions
        // engine emitted "remember this" suggestions. Empty/missing on
        // auto-approved or already-decided calls.
        suggestions?: SuggestedRule[];
        // Source pointers attached by the tool (web URL, file:line,
        // prior command). Rendered as chips beneath the tool-use card.
        citations?: Citation[];
        // ask_user_question payload (multi-choice card). Present iff
        // the tool is ask_user_question and approval == needs-approval.
        askquestion?: AskUserQuestionPayload;
        // User's answers, populated by the FE after submission (echoed
        // back into the SSE stream when the dispatcher copies them
        // onto toolusedata for trajectory replay).
        askanswers?: AskUserQuestionAnswer[];
    };
    toolprogress: {
        toolcallid: string;
        toolname: string;
        statuslines: string[];
    };
};

export type WaveUIMessage = UIMessage<unknown, WaveUIDataTypes, any>;
export type WaveUIMessagePart = UIMessagePart<WaveUIDataTypes, any>;

export type UseChatSetMessagesType = (
    messages: WaveUIMessage[] | ((messages: WaveUIMessage[]) => WaveUIMessage[])
) => void;

export type UseChatSendMessageType = (
    message?:
        | (Omit<WaveUIMessage, "id" | "role"> & {
              id?: string;
              role?: "system" | "user" | "assistant";
          } & {
              text?: never;
              files?: never;
              messageId?: string;
          })
        | {
              text: string;
              files?: FileList | FileUIPart[];
              metadata?: unknown;
              parts?: never;
              messageId?: string;
          }
        | {
              files: FileList | FileUIPart[];
              metadata?: unknown;
              parts?: never;
              messageId?: string;
          },
    options?: ChatRequestOptions
) => Promise<void>;
