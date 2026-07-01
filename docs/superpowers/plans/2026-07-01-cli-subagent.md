# CLI Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a delegated CLI subagent that runs long-running / interactive PTY commands as a second `AgentHarness` in emain, feeding only a natural-language summary back to the main agent.

**Architecture:** The main agent gets a `spawn_cli_agent` tool. It starts a real cmd block via Go blockcontroller, spins up a second `AgentHarness` (ephemeral in-memory session) carrying three private PTY tools (`pty_write` / `pty_read` / `pty_transfer_to_user`), drives it to completion, and returns the subagent's summary. `pty_read` reads the Go backend transcript tail by default (stable via the filestore valid-window tail read + `output_data` snapshot), and only asks the renderer for a screen snapshot when the Go-side `altScreen` state bit is set.

**Tech Stack:** TypeScript (emain / Node main process, typebox schemas, vitest), Go (wshrpc `WshServer` command + cmdblock tracker + filestore), Electron IPC (emain↔renderer), pi `AgentHarness`.

**Spec:** [`docs/superpowers/specs/2026-07-01-cli-subagent-design.md`](file:///Users/bytedance/Documents/crest/docs/superpowers/specs/2026-07-01-cli-subagent-design.md)

---

## Phasing

Implementation follows the spec's MVP-first ordering (spec §10):

- **Phase 1 (Go backend transcript tail):** Tasks 1–3 — the stable data source the subagent depends on.
- **Phase 2 (PTY tools + emain RPC glue):** Tasks 4–7 — the three tools around an existing `blockId`.
- **Phase 3 (subagent harness + delegation):** Tasks 8–10 — factory, `spawn_cli_agent`, main-agent registration.
- **Phase 4 (screen snapshot enhancement):** Task 11 — renderer alt-screen snapshot, deferred per spec.

Each phase produces testable software on its own. Phase 4 is optional for a first cut.

## File Structure

**Go backend (Phase 1):**
- `pkg/cmdblock/tracker.go` (modify): add exported `AltScreen()` getter + package-level tracker registry accessor.
- `pkg/cmdblock/store.go` (modify): add `TailLines(ctx, blockID, maxLines, maxBytes)` reading the filestore valid window.
- `pkg/wshrpc/wshrpctypes.go` (modify): declare `GetCmdBlockTailCommand` + its request/response structs.
- `pkg/wshrpc/wshserver/wshserver.go` (modify): implement `GetCmdBlockTailCommand`.

**emain tools (Phase 2–3):**
- `emain/agent/tools/pty-write.ts` (create): `createPtyWriteTool(blockId)`.
- `emain/agent/tools/pty-read.ts` (create): `createPtyReadTool(blockId)`.
- `emain/agent/tools/pty-transfer.ts` (create): `createPtyTransferTool(blockId)`.
- `emain/agent/tools/_pty-rpc.ts` (create): thin RPC helpers (`sendControllerInput`, `getCmdBlockTail`, `startAgentCommandBlock`, `stopBlock`) wrapping `RpcApi.*Command(ElectronWshClient, ...)`.
- `emain/agent/cli-subagent-factory.ts` (create): `buildCliSubagentHarness()`.
- `emain/agent/tools/spawn-cli-agent.ts` (create): `createSpawnCliAgentTool()` + `runSubagentToCompletion`.
- `emain/agent/tools/index.ts` (modify): export the new tools (subagent tools are NOT in `getDefaultTools`).

**Renderer (Phase 4):**
- `emain/emain-web.ts` (modify): add `webPtyScreenSnapshot(wc, blockId)`.
- `emain/emain-wsh.ts` (modify): add `handle_ptyscreensnapshot`.

---

## Task 1: Go — expose the cmdblock alt-screen state bit

**Files:**
- Modify: `pkg/cmdblock/tracker.go`
- Test: `pkg/cmdblock/tracker_test.go` (create or append)

The tracker already maintains `t.altScreen` (tracker.go:48) and flips it in `detectAltScreen` (tracker.go:183-208). The tail RPC needs to read it, so expose a getter and a way to find the tracker for a block.

- [ ] **Step 1: Write the failing test**

Append to `pkg/cmdblock/tracker_test.go`:

```go
func TestTrackerAltScreenGetter(t *testing.T) {
	tr := MakeTracker("block-alt-1")
	if tr.AltScreen() {
		t.Fatalf("new tracker should not be in alt-screen")
	}
	// Simulate the PTY emitting the DECSET 1049 enter sequence.
	tr.detectAltScreen([]byte("\x1b[?1049h"))
	if !tr.AltScreen() {
		t.Fatalf("expected alt-screen true after enter seq")
	}
	tr.detectAltScreen([]byte("\x1b[?1049l"))
	if tr.AltScreen() {
		t.Fatalf("expected alt-screen false after exit seq")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/cmdblock/ -run TestTrackerAltScreenGetter -v`
Expected: FAIL — `tr.AltScreen undefined (type *Tracker has no field or method AltScreen)`.

- [ ] **Step 3: Add the getter**

In `pkg/cmdblock/tracker.go`, after `MakeTracker` (around line 66), add:

```go
// AltScreen reports whether the tracked command is currently in the
// alternate screen buffer (a full-screen TUI like vim/top/lazygit).
// Read by the subagent tail RPC to decide transcript vs screen source.
func (t *Tracker) AltScreen() bool {
	return t.altScreen
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/cmdblock/ -run TestTrackerAltScreenGetter -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/cmdblock/tracker.go pkg/cmdblock/tracker_test.go
git commit -m "feat(cmdblock): expose tracker AltScreen() getter"
```

---

## Task 2: Go — add a tracker registry lookup by blockID

**Files:**
- Modify: `pkg/cmdblock/tracker.go`
- Test: `pkg/cmdblock/tracker_test.go`

The RPC handler (Task 3) has a `blockID` and needs the live `*Tracker` for that block to read `AltScreen()`. Add a process-wide registry keyed by blockID, populated in `MakeTracker`.

- [ ] **Step 1: Write the failing test**

Append to `pkg/cmdblock/tracker_test.go`:

```go
func TestTrackerRegistryLookup(t *testing.T) {
	tr := MakeTracker("block-reg-1")
	got := GetTracker("block-reg-1")
	if got != tr {
		t.Fatalf("GetTracker returned a different tracker instance")
	}
	if GetTracker("block-missing") != nil {
		t.Fatalf("GetTracker for unknown block should return nil")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/cmdblock/ -run TestTrackerRegistryLookup -v`
Expected: FAIL — `undefined: GetTracker`.

- [ ] **Step 3: Add the registry**

In `pkg/cmdblock/tracker.go`, add near the top (after imports, before `MakeTracker`):

```go
var trackerRegistry = struct {
	sync.Mutex
	byBlock map[string]*Tracker
}{byBlock: make(map[string]*Tracker)}

// GetTracker returns the live Tracker for a block, or nil if none exists.
func GetTracker(blockID string) *Tracker {
	trackerRegistry.Lock()
	defer trackerRegistry.Unlock()
	return trackerRegistry.byBlock[blockID]
}
```

Ensure `sync` is imported. Then inside `MakeTracker`, right before it returns the tracker, register it:

```go
	trackerRegistry.Lock()
	trackerRegistry.byBlock[blockID] = t
	trackerRegistry.Unlock()
	return t
```

(Read the existing `MakeTracker` body first and insert the registration before its existing `return`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/cmdblock/ -run TestTrackerRegistryLookup -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/cmdblock/tracker.go pkg/cmdblock/tracker_test.go
git commit -m "feat(cmdblock): add process-wide tracker registry keyed by blockID"
```

---

## Task 3: Go — GetCmdBlockTailCommand RPC (transcript tail + altScreen + running/exit)

**Files:**
- Modify: `pkg/cmdblock/store.go` (add `TailLines`)
- Modify: `pkg/wshrpc/wshrpctypes.go` (declare command + structs)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (implement)
- Test: `pkg/cmdblock/store_test.go` (create or append)

This is the stable transcript-tail source (spec §3b). Running commands read the filestore valid window tail; finished commands read the `output_data` snapshot. The RPC accepts only `max_lines`/`max_bytes` — never an absolute offset (spec §3b landing point).

- [ ] **Step 1: Write the failing test for TailLines**

Append to `pkg/cmdblock/store_test.go`:

```go
func TestTailLinesReturnsLastN(t *testing.T) {
	full := []byte("line1\nline2\nline3\nline4\nline5\n")
	got := tailLines(full, 2, 0)
	want := "line4\nline5\n"
	if string(got) != want {
		t.Fatalf("tailLines maxLines=2 = %q, want %q", got, want)
	}
}

func TestTailLinesRespectsMaxBytes(t *testing.T) {
	full := []byte("aaaa\nbbbb\ncccc\n")
	got := tailLines(full, 0, 5)
	// last 5 bytes = "ccc\n" region; must not exceed 5 bytes.
	if len(got) > 5 {
		t.Fatalf("tailLines maxBytes=5 returned %d bytes: %q", len(got), got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/cmdblock/ -run TestTailLines -v`
Expected: FAIL — `undefined: tailLines`.

- [ ] **Step 3: Implement the pure tail helper**

In `pkg/cmdblock/store.go`, add:

```go
// tailLines returns the trailing slice of data bounded by maxLines and
// maxBytes. A zero bound means "unbounded" for that dimension. Byte
// bound is applied first (from the end), then line bound. This is a pure
// helper so it can be unit-tested without a filestore.
func tailLines(data []byte, maxLines int, maxBytes int) []byte {
	if maxBytes > 0 && len(data) > maxBytes {
		data = data[len(data)-maxBytes:]
	}
	if maxLines > 0 {
		count := 0
		i := len(data)
		for i > 0 {
			if data[i-1] == '\n' {
				count++
				// Include the newline that terminates the (maxLines)th
				// line from the end; stop once we've passed maxLines
				// newlines while scanning backwards.
				if count > maxLines {
					return data[i:]
				}
			}
			i--
		}
	}
	return data
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/cmdblock/ -run TestTailLines -v`
Expected: PASS.

- [ ] **Step 5: Add the store-level TailLines that picks the source**

In `pkg/cmdblock/store.go`, add (uses `GetOutputData` at store.go:226 and filestore for the running case):

```go
// TailLines returns the trailing output for a block's current command,
// bounded by maxLines/maxBytes. When isRunning is true it reads the tail
// of the live term file's valid window (wrap/reset-immune); otherwise it
// reads the durable per-block output_data snapshot.
func TailLines(ctx context.Context, blockID string, oid string, isRunning bool, maxLines int, maxBytes int) ([]byte, error) {
	if !isRunning && oid != "" {
		snap, err := GetOutputData(ctx, oid)
		if err != nil {
			return nil, err
		}
		if snap != nil {
			return tailLines(snap, maxLines, maxBytes), nil
		}
	}
	// Running (or no snapshot yet): read the whole valid window of the
	// shared term file and tail it. filestore.ReadFile returns the valid
	// window only (offset..Size), so we never touch stale wrapped bytes.
	_, data, err := filestore.WFS.ReadFile(ctx, blockID, filestore.BlockFile_Term)
	if err != nil {
		return nil, err
	}
	return tailLines(data, maxLines, maxBytes), nil
}
```

Check the exact filestore accessor name (`filestore.WFS` / `filestore.BlockFile_Term`) against the existing shellcontroller usage; match whatever `HandleAppendBlockFile` uses in `pkg/blockcontroller/shellcontroller.go`. Adjust import path accordingly.

- [ ] **Step 6: Declare the RPC command and structs**

In `pkg/wshrpc/wshrpctypes.go`, add to the `WshRpcInterface` (near line 101 where `GetCmdBlockOutputCommand` is declared):

```go
	GetCmdBlockTailCommand(ctx context.Context, data CommandGetCmdBlockTailData) (*CmdBlockTailResponse, error)
```

And near line 379 (next to `CommandGetCmdBlockOutputData`):

```go
type CommandGetCmdBlockTailData struct {
	BlockID  string `json:"blockid"`
	OID      string `json:"oid,omitempty"`
	MaxLines int    `json:"maxlines,omitempty"`
	MaxBytes int    `json:"maxbytes,omitempty"`
}

type CmdBlockTailResponse struct {
	Text      string `json:"text"`
	IsRunning bool   `json:"isrunning"`
	ExitCode  *int   `json:"exitcode,omitempty"`
	AltScreen bool   `json:"altscreen"`
}
```

- [ ] **Step 7: Implement the handler**

In `pkg/wshrpc/wshserver/wshserver.go`, after `GetCmdBlockOutputCommand` (line 1540):

```go
// GetCmdBlockTailCommand returns the recent output tail for a block's
// current command plus its running/exit/alt-screen status. The subagent's
// pty_read uses this as its default (transcript-tail) source. It accepts
// only max_lines/max_bytes — never an absolute offset — so the shared
// term file's circular-buffer offsets stay hidden from callers.
func (ws *WshServer) GetCmdBlockTailCommand(ctx context.Context, data wshrpc.CommandGetCmdBlockTailData) (*wshrpc.CmdBlockTailResponse, error) {
	if data.BlockID == "" {
		return nil, fmt.Errorf("blockid is required")
	}
	tracker := cmdblock.GetTracker(data.BlockID)
	altScreen := tracker != nil && tracker.AltScreen()

	bc := blockcontroller.GetBlockController(data.BlockID)
	isRunning := bc != nil && bc.GetRuntimeStatus() != nil && bc.GetRuntimeStatus().ShellProcStatus == blockcontroller.Status_Running
	var exitCode *int
	if bc != nil && bc.GetRuntimeStatus() != nil && bc.GetRuntimeStatus().ShellProcStatus == blockcontroller.Status_Done {
		ec := bc.GetRuntimeStatus().ShellProcExitCode
		exitCode = &ec
	}

	out, err := cmdblock.TailLines(ctx, data.BlockID, data.OID, isRunning, data.MaxLines, data.MaxBytes)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CmdBlockTailResponse{
		Text:      string(out),
		IsRunning: isRunning,
		ExitCode:  exitCode,
		AltScreen: altScreen,
	}, nil
}
```

Before writing, open `pkg/blockcontroller/shellcontroller.go` around lines 525-590 and `pkg/blockcontroller/blockcontroller.go` to confirm the actual accessor names for controller lookup and status (`GetBlockController`, `GetRuntimeStatus`, `Status_Running`, `Status_Done`, `ShellProcStatus`, `ShellProcExitCode`). Match the real symbols — adjust the handler to the true API.

- [ ] **Step 8: Regenerate TS bindings**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` and `frontend/app/store/wshclientapi.ts` gain `GetCmdBlockTailCommand`, `CommandGetCmdBlockTailData`, `CmdBlockTailResponse`. No manual edits to generated files.

- [ ] **Step 9: Build the server to verify it compiles**

Run: `go build ./pkg/...`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add pkg/cmdblock/store.go pkg/cmdblock/store_test.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat(wshrpc): add GetCmdBlockTailCommand for subagent transcript tail"
```

---

## Task 4: emain — PTY RPC helper module

**Files:**
- Create: `emain/agent/tools/_pty-rpc.ts`
- Test: `emain/agent/tools/_pty-rpc.test.ts`

Thin wrappers over `RpcApi.*Command(ElectronWshClient, ...)` so the tools don't inline RPC plumbing and can be tested with a mocked RpcApi. Mirrors the `RpcApi.ControllerInputCommand` usage in `frontend/app/term/terminal-model.ts:434-439` and `RpcApi.*Command(ElectronWshClient, ...)` calls in `emain/emain-wsh.ts:78`.

- [ ] **Step 1: Write the failing test**

Create `emain/agent/tools/_pty-rpc.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const controllerInput = vi.fn(async () => {});
const getTail = vi.fn(async () => ({ text: "hi", isrunning: true, altscreen: false }));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        ControllerInputCommand: (...a: unknown[]) => controllerInput(...a),
        GetCmdBlockTailCommand: (...a: unknown[]) => getTail(...a),
    },
}));
vi.mock("../../emain-wsh", () => ({ ElectronWshClient: {} }));

import { getCmdBlockTail, sendControllerInput } from "./_pty-rpc";

describe("_pty-rpc", () => {
    it("sendControllerInput base64-encodes input data", async () => {
        await sendControllerInput("blk1", "abc");
        expect(controllerInput).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ blockid: "blk1", inputdata64: Buffer.from("abc").toString("base64") }),
        );
    });

    it("getCmdBlockTail passes bounds and returns the response", async () => {
        const r = await getCmdBlockTail("blk1", { oid: "o1", maxLines: 40 });
        expect(getTail).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ blockid: "blk1", oid: "o1", maxlines: 40 }),
        );
        expect(r.text).toBe("hi");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run emain/agent/tools/_pty-rpc.test.ts`
Expected: FAIL — cannot resolve `./_pty-rpc`.

- [ ] **Step 3: Implement the helpers**

Create `emain/agent/tools/_pty-rpc.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// _pty-rpc.ts — thin wrappers over the wshrpc channel the CLI subagent's
// PTY tools use. Keeps RPC plumbing out of the tool bodies so tools stay
// testable with a mocked RpcApi. See spec §2.4 decisions 2, 3, 5.

import { RpcApi } from "@/app/store/wshclientapi";
import { ElectronWshClient } from "../../emain-wsh";

/** Write raw bytes to a running block's PTY (ControllerInput → Go SendInput). */
export async function sendControllerInput(blockId: string, input: string): Promise<void> {
    await RpcApi.ControllerInputCommand(ElectronWshClient, {
        blockid: blockId,
        inputdata64: Buffer.from(input, "utf8").toString("base64"),
    });
}

export interface CmdBlockTail {
    text: string;
    isrunning: boolean;
    exitcode?: number;
    altscreen: boolean;
}

/** Read the recent transcript tail + running/exit/alt-screen status. */
export async function getCmdBlockTail(
    blockId: string,
    opts?: { oid?: string; maxLines?: number; maxBytes?: number },
): Promise<CmdBlockTail> {
    return RpcApi.GetCmdBlockTailCommand(ElectronWshClient, {
        blockid: blockId,
        oid: opts?.oid,
        maxlines: opts?.maxLines,
        maxbytes: opts?.maxBytes,
    }) as Promise<CmdBlockTail>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run emain/agent/tools/_pty-rpc.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add emain/agent/tools/_pty-rpc.ts emain/agent/tools/_pty-rpc.test.ts
git commit -m "feat(agent): add PTY RPC helper wrappers for subagent tools"
```

---

## Task 5: emain — pty_write tool

**Files:**
- Create: `emain/agent/tools/pty-write.ts`
- Test: `emain/agent/tools/pty-write.test.ts`

Implements `AgentTool` (types.ts:361-394). Three modes decorate the bytes, strictly mirroring Warp `AIAgentPtyWriteMode::decorate_bytes` ([action/mod.rs#L779-L822](file:///Users/bytedance/Documents/warp/crates/ai/src/agent/action/mod.rs#L779-L822), spec §6.1): `raw` passes bytes through unchanged; `line` prepends `SOH(\x01)` ("beginning of line" for readline/prompt-toolkit) then appends the submit char (POSIX `LF(\n)`, Windows `CR(\r)`); `block` wraps in bracketed-paste (`\x1b[200~` … `\x1b[201~`) **only when `is_bracketed_paste_enabled`**, otherwise passes through. First phase defaults `is_bracketed_paste_enabled=true` for `block` (matching Warp's common path) and derives the platform submit char from `process.platform`.

- [ ] **Step 1: Write the failing test**

Create `emain/agent/tools/pty-write.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const sent: Array<{ blockId: string; input: string }> = [];
vi.mock("./_pty-rpc", () => ({
    sendControllerInput: async (blockId: string, input: string) => {
        sent.push({ blockId, input });
    },
}));

import { createPtyWriteTool } from "./pty-write";

describe("pty_write", () => {
    it("raw mode sends bytes unchanged", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool("blk1");
        await tool.execute("t1", { block_id: "blk1", input: "\x03", mode: "raw" });
        expect(sent).toEqual([{ blockId: "blk1", input: "\x03" }]);
    });

    it("line mode wraps input with SOH prefix and submit char", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool("blk1");
        await tool.execute("t1", { block_id: "blk1", input: "yes", mode: "line" });
        // SOH(\x01) + input + platform submit char (LF on POSIX, CR on Windows).
        const submit = process.platform === "win32" ? "\r" : "\n";
        expect(sent[0].input).toBe(`\x01yes${submit}`);
    });

    it("block mode wraps in bracketed-paste when enabled", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool("blk1");
        await tool.execute("t1", { block_id: "blk1", input: "a\nb", mode: "block" });
        expect(sent[0].input).toBe("\x1b[200~a\nb\x1b[201~");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run emain/agent/tools/pty-write.test.ts`
Expected: FAIL — cannot resolve `./pty-write`.

- [ ] **Step 3: Implement the tool**

Create `emain/agent/tools/pty-write.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// pty-write.ts — subagent-private tool: write input to a running PTY
// command via ControllerInput. Mirrors Warp's WriteToLongRunningShell-
// Command + AIAgentPtyWriteMode::decorate_bytes
// (crates/ai/src/agent/action/mod.rs#L779-L822). See spec §6.1.

import { type Static, Type } from "typebox";
import type { AgentTool } from "../types";
import { sendControllerInput } from "./_pty-rpc";

const ptyWriteSchema = Type.Object({
    block_id: Type.String({ description: "The running PTY command to write to" }),
    input: Type.String({ description: "Bytes / text to send" }),
    mode: Type.Union([Type.Literal("raw"), Type.Literal("line"), Type.Literal("block")]),
});

export type PtyWriteInput = Static<typeof ptyWriteSchema>;

// C0 / bracketed-paste constants, per Warp escape_sequences.
const SOH = "\x01"; // ^A — "beginning of line" for readline/prompt-toolkit editors.
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function decorateBytes(input: string, mode: PtyWriteInput["mode"]): string {
    switch (mode) {
        case "raw":
            return input;
        case "line": {
            // Move to beginning of line, write input, then submit (Enter).
            // POSIX submits with LF; Windows submits with CR.
            const submit = process.platform === "win32" ? "\r" : "\n";
            return `${SOH}${input}${submit}`;
        }
        case "block": {
            // Warp only wraps when is_bracketed_paste_enabled; first phase
            // defaults enabled (Warp's common path). Otherwise pass through.
            const isBracketedPasteEnabled = true;
            return isBracketedPasteEnabled
                ? `${BRACKETED_PASTE_START}${input}${BRACKETED_PASTE_END}`
                : input;
        }
    }
}

export function createPtyWriteTool(blockId: string): AgentTool<typeof ptyWriteSchema, undefined> {
    return {
        name: "pty_write",
        label: "pty write",
        description:
            "Write input to the running PTY command. mode=raw sends bytes as-is (control keys like Ctrl-C=\\x03); mode=line goes to line start then submits the input with Enter (answer a prompt); mode=block wraps in bracketed-paste (multi-line paste without auto-run).",
        promptSnippet: "Write input to the running PTY command (raw / line / block).",
        parameters: ptyWriteSchema,
        async execute(_toolCallId, params) {
            await sendControllerInput(params.block_id || blockId, decorateBytes(params.input, params.mode));
            return { content: [{ type: "text", text: `sent ${params.mode} input` }], details: undefined };
        },
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run emain/agent/tools/pty-write.test.ts`
Expected: PASS (all three modes).

- [ ] **Step 5: Commit**

```bash
git add emain/agent/tools/pty-write.ts emain/agent/tools/pty-write.test.ts
git commit -m "feat(agent): add pty_write subagent tool"
```

---

## Task 6: emain — pty_read tool (transcript tail default, auto routing)

**Files:**
- Create: `emain/agent/tools/pty-read.ts`
- Test: `emain/agent/tools/pty-read.test.ts`

`pty_read` defaults to transcript tail (spec §3, §6.2). `mode:"auto"` routes on the backend `altscreen` bit: `false` → transcript only; `true` → attempt screen snapshot (Task 11), degrade to transcript with `degraded:true` on failure. Until Task 11 lands, the screen path throws internally and the tool degrades — this keeps Phase 1–3 shippable.

- [ ] **Step 1: Write the failing test**

Create `emain/agent/tools/pty-read.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

let tailResp = { text: "recent output", isrunning: true, altscreen: false, exitcode: undefined as number | undefined };
vi.mock("./_pty-rpc", () => ({
    getCmdBlockTail: async () => tailResp,
}));
// No screen snapshot backend yet; the module falls back to transcript.
vi.mock("./_pty-screen", () => ({
    getScreenSnapshot: async () => {
        throw new Error("renderer unavailable");
    },
}));

import { createPtyReadTool } from "./pty-read";

describe("pty_read", () => {
    it("auto + altscreen=false returns transcript_tail", async () => {
        tailResp = { text: "recent output", isrunning: true, altscreen: false, exitcode: undefined };
        const tool = createPtyReadTool("blk1");
        const r = await tool.execute("t1", { block_id: "blk1", mode: "auto" });
        expect(r.details).toMatchObject({ source: "transcript_tail", is_running: true, approximate: true });
        expect(r.content[0]).toMatchObject({ type: "text", text: "recent output" });
    });

    it("auto + altscreen=true degrades to transcript when renderer fails", async () => {
        tailResp = { text: "vim buffer tail", isrunning: true, altscreen: true, exitcode: undefined };
        const tool = createPtyReadTool("blk1");
        const r = await tool.execute("t1", { block_id: "blk1", mode: "auto" });
        expect(r.details).toMatchObject({ source: "transcript_tail", degraded: true });
    });

    it("reports exit_code when finished", async () => {
        tailResp = { text: "done", isrunning: false, altscreen: false, exitcode: 0 };
        const tool = createPtyReadTool("blk1");
        const r = await tool.execute("t1", { block_id: "blk1", mode: "transcript" });
        expect(r.details).toMatchObject({ is_running: false, exit_code: 0 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run emain/agent/tools/pty-read.test.ts`
Expected: FAIL — cannot resolve `./pty-read`.

- [ ] **Step 3: Add a screen-snapshot seam (placeholder that throws until Task 11)**

Create `emain/agent/tools/_pty-screen.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// _pty-screen.ts — renderer screen-snapshot seam for pty_read's screen
// branch. Wired to the renderer in Task 11. Until then it throws so
// pty_read degrades to transcript tail (spec §3a fallback).

export interface ScreenSnapshot {
    grid_contents: string;
    cursor: string;
    is_alt_screen_active: boolean;
    block_id: string;
}

export async function getScreenSnapshot(_blockId: string): Promise<ScreenSnapshot> {
    throw new Error("screen snapshot not implemented (Task 11)");
}
```

- [ ] **Step 4: Implement the tool**

Create `emain/agent/tools/pty-read.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// pty-read.ts — subagent-private tool: read a running PTY command's
// output. Defaults to the Go backend transcript tail; only asks the
// renderer for a screen snapshot when the backend altScreen bit is set
// (mode=auto) or mode=screen is requested. Mirrors Warp's
// ReadShellCommandOutput / LongRunningCommandSnapshot. See spec §3, §6.2.

import { type Static, Type } from "typebox";
import type { AgentTool } from "../types";
import { getCmdBlockTail } from "./_pty-rpc";
import { getScreenSnapshot } from "./_pty-screen";

const ptyReadSchema = Type.Object({
    block_id: Type.String(),
    delay_ms: Type.Optional(Type.Number()),
    mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("transcript"), Type.Literal("screen")])),
    max_lines: Type.Optional(Type.Number()),
});

export type PtyReadInput = Static<typeof ptyReadSchema>;

export interface PtyReadDetails {
    block_id: string;
    source: "transcript_tail" | "screen_snapshot";
    is_running?: boolean;
    exit_code?: number;
    approximate?: true;
    is_alt_screen_active?: boolean;
    degraded?: boolean;
}

const DEFAULT_MAX_LINES = 60;

async function readTranscript(blockId: string, maxLines: number, degraded: boolean) {
    const tail = await getCmdBlockTail(blockId, { maxLines });
    const details: PtyReadDetails = {
        block_id: blockId,
        source: "transcript_tail",
        is_running: tail.isrunning,
        exit_code: tail.exitcode,
        approximate: true,
        is_alt_screen_active: tail.altscreen,
        ...(degraded ? { degraded: true } : {}),
    };
    return { content: [{ type: "text" as const, text: tail.text }], details, tail };
}

export function createPtyReadTool(blockId: string): AgentTool<typeof ptyReadSchema, PtyReadDetails> {
    return {
        name: "pty_read",
        label: "pty read",
        description:
            "Read the running PTY command's recent output. Defaults to the backend transcript tail; use mode=screen for a precise TUI screen snapshot (vim/top). mode=auto picks screen only when the command is in a full-screen (alt-screen) TUI.",
        promptSnippet: "Read the running PTY command's output (transcript tail / TUI screen).",
        parameters: ptyReadSchema,
        async execute(_toolCallId, params) {
            const id = params.block_id || blockId;
            const maxLines = params.max_lines ?? DEFAULT_MAX_LINES;
            if (params.delay_ms && params.delay_ms > 0) {
                await new Promise((r) => setTimeout(r, params.delay_ms));
            }
            const mode = params.mode ?? "auto";

            // Peek the tail first: it carries the authoritative altScreen bit.
            const first = await readTranscript(id, maxLines, false);
            const wantScreen = mode === "screen" || (mode === "auto" && first.tail.altscreen);
            if (!wantScreen) {
                return { content: first.content, details: first.details };
            }
            try {
                const snap = await getScreenSnapshot(id);
                const details: PtyReadDetails = {
                    block_id: id,
                    source: "screen_snapshot",
                    is_alt_screen_active: snap.is_alt_screen_active,
                    is_running: first.tail.isrunning,
                };
                return {
                    content: [{ type: "text", text: `${snap.grid_contents}\n[cursor: ${snap.cursor}]` }],
                    details,
                };
            } catch {
                // Renderer unavailable → degrade to transcript (spec §3a).
                const degraded = await readTranscript(id, maxLines, true);
                return { content: degraded.content, details: degraded.details };
            }
        },
    };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run emain/agent/tools/pty-read.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add emain/agent/tools/pty-read.ts emain/agent/tools/_pty-screen.ts emain/agent/tools/pty-read.test.ts
git commit -m "feat(agent): add pty_read subagent tool with auto transcript/screen routing"
```

---

## Task 7: emain — pty_transfer_to_user tool

**Files:**
- Create: `emain/agent/tools/pty-transfer.ts`
- Test: `emain/agent/tools/pty-transfer.test.ts`

When the subagent is stuck (needs a password / human decision), it hands control back (spec §6, decision 6). The tool returns `terminate: true` so the harness stops after the batch (types.ts:350-354); `spawn_cli_agent` then returns early, leaving the blockId for the user.

- [ ] **Step 1: Write the failing test**

Create `emain/agent/tools/pty-transfer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createPtyTransferTool } from "./pty-transfer";

describe("pty_transfer_to_user", () => {
    it("terminates and echoes the reason", async () => {
        const tool = createPtyTransferTool("blk1");
        const r = await tool.execute("t1", { block_id: "blk1", reason: "needs sudo password" });
        expect(r.terminate).toBe(true);
        expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("needs sudo password") });
        expect(r.details).toMatchObject({ transferred: true, block_id: "blk1" });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run emain/agent/tools/pty-transfer.test.ts`
Expected: FAIL — cannot resolve `./pty-transfer`.

- [ ] **Step 3: Implement the tool**

Create `emain/agent/tools/pty-transfer.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// pty-transfer.ts — subagent-private tool: hand PTY control back to the
// user when stuck (password / decision). Sets terminate so the harness
// stops; spawn_cli_agent returns early and leaves the blockId for the
// user. Mirrors Warp's TransferShellCommandControlToUser. See spec §6.

import { type Static, Type } from "typebox";
import type { AgentTool } from "../types";

const ptyTransferSchema = Type.Object({
    block_id: Type.String(),
    reason: Type.String({ description: "Why control is being handed back (e.g. needs a password)." }),
});

export type PtyTransferInput = Static<typeof ptyTransferSchema>;

export interface PtyTransferDetails {
    transferred: true;
    block_id: string;
    reason: string;
}

export function createPtyTransferTool(blockId: string): AgentTool<typeof ptyTransferSchema, PtyTransferDetails> {
    return {
        name: "pty_transfer_to_user",
        label: "transfer to user",
        description:
            "Hand PTY control back to the user when you cannot proceed (waiting for a password or a human decision). Stops the subagent and leaves the command for the user to continue.",
        promptSnippet: "Hand control back to the user when stuck (password / decision).",
        parameters: ptyTransferSchema,
        async execute(_toolCallId, params) {
            return {
                content: [{ type: "text", text: `Transferred control to user: ${params.reason}` }],
                details: { transferred: true, block_id: params.block_id || blockId, reason: params.reason },
                terminate: true,
            };
        },
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run emain/agent/tools/pty-transfer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add emain/agent/tools/pty-transfer.ts emain/agent/tools/pty-transfer.test.ts
git commit -m "feat(agent): add pty_transfer_to_user subagent tool"
```

---

## Task 8: emain — CLI subagent harness factory

**Files:**
- Create: `emain/agent/cli-subagent-factory.ts`
- Test: `emain/agent/cli-subagent-factory.test.ts`

Builds a second `AgentHarness` with an ephemeral in-memory session (spec decision 4), the three PTY tools bound to the blockId, an independent system prompt (spec §8), and its own model. Mirrors `buildPaneHarness` (harness-factory.ts:83-135) but uses `InMemorySessionRepo` (memory-repo.ts) instead of the SQLite repo.

- [ ] **Step 1: Write the failing test**

Create `emain/agent/cli-subagent-factory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InMemorySessionRepo } from "./harness/session/memory-repo";
import { buildCliSubagentHarness, CLI_SUBAGENT_TOOL_NAMES } from "./cli-subagent-factory";

describe("buildCliSubagentHarness", () => {
    it("mounts exactly the three PTY tools bound to the blockId", async () => {
        const session = await new InMemorySessionRepo().create();
        const sub = buildCliSubagentHarness({
            session,
            model: { id: "test-model" } as any,
            blockId: "blk1",
            cwd: "/tmp",
        });
        const names = sub.tools.map((t) => t.name).sort();
        expect(names).toEqual([...CLI_SUBAGENT_TOOL_NAMES].sort());
    });

    it("exposes the underlying harness for prompt/subscribe/abort", async () => {
        const session = await new InMemorySessionRepo().create();
        const sub = buildCliSubagentHarness({
            session,
            model: { id: "test-model" } as any,
            blockId: "blk1",
            cwd: "/tmp",
        });
        expect(typeof sub.harness.prompt).toBe("function");
        expect(typeof sub.harness.abort).toBe("function");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run emain/agent/cli-subagent-factory.test.ts`
Expected: FAIL — cannot resolve `./cli-subagent-factory`.

- [ ] **Step 3: Implement the factory**

Create `emain/agent/cli-subagent-factory.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// cli-subagent-factory.ts — assembles the second AgentHarness that the
// CLI subagent runs in. Ephemeral in-memory session (decision 4), the
// three PTY tools bound to one already-started blockId, an independent
// system prompt (§8), and its own (smaller) model. Mirrors
// buildPaneHarness but never touches the SQLite session repo. See spec §2, §9.

import type { Api, Model } from "../ai";
import { AgentHarness } from "./harness/agent-harness";
import type { Session } from "./harness/types";
import { NodeExecutionEnv } from "./node";
import { createPtyReadTool } from "./tools/pty-read";
import { createPtyTransferTool } from "./tools/pty-transfer";
import { createPtyWriteTool } from "./tools/pty-write";
import type { AgentTool } from "./types";

export const CLI_SUBAGENT_TOOL_NAMES = ["pty_write", "pty_read", "pty_transfer_to_user"] as const;

const CLI_SUBAGENT_SYSTEM_PROMPT = [
    "You are a CLI subagent driving a single long-running or interactive PTY command.",
    "Your goal is the delegated task. When it is done, call pty_transfer_to_user only if you are stuck; otherwise stop and summarize.",
    "Rules:",
    "1. Goal-oriented: finish the task, then stop. Do not explore beyond it.",
    "2. Look before you act: call pty_read to confirm current output/screen before sending input.",
    "3. Quote errors verbatim: include exact error text and file:line in your summary — the main agent relies on it.",
    "4. When stuck (waiting for a password or a human decision), call pty_transfer_to_user instead of guessing.",
    "5. Respect the step limit; if you hit it, summarize current progress and stop.",
].join("\n");

export interface BuildCliSubagentOptions {
    session: Session;
    model: Model<Api>;
    blockId: string;
    cwd: string;
    getApiKeyAndHeaders?: (
        model: Model<Api>,
    ) => Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;
}

export interface CliSubagentHarness {
    readonly harness: AgentHarness;
    readonly session: Session;
    readonly tools: AgentTool[];
}

export function buildCliSubagentHarness(opts: BuildCliSubagentOptions): CliSubagentHarness {
    const tools: AgentTool[] = [
        createPtyWriteTool(opts.blockId),
        createPtyReadTool(opts.blockId),
        createPtyTransferTool(opts.blockId),
    ];
    const env = new NodeExecutionEnv({ cwd: opts.cwd });
    const harness = new AgentHarness({
        env,
        session: opts.session,
        model: opts.model,
        thinkingLevel: "off",
        tools,
        systemPrompt: () => CLI_SUBAGENT_SYSTEM_PROMPT,
        getApiKeyAndHeaders: opts.getApiKeyAndHeaders,
    });
    return { harness, session: opts.session, tools };
}
```

Before writing, confirm the `AgentHarness` constructor field names against `emain/agent/harness/agent-harness.ts` and `NodeExecutionEnv` import path against `harness-factory.ts:17` (`./node`). Match the real symbols.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run emain/agent/cli-subagent-factory.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add emain/agent/cli-subagent-factory.ts emain/agent/cli-subagent-factory.test.ts
git commit -m "feat(agent): add buildCliSubagentHarness factory"
```

---

## Task 9: emain — runSubagentToCompletion driver

**Files:**
- Modify: `emain/agent/tools/spawn-cli-agent.ts` (create in this task; extended in Task 10)
- Test: `emain/agent/tools/spawn-cli-agent.test.ts`

Drives the subagent harness to convergence: prompt the task, wait for `agent_end`, extract the final assistant text as the summary; enforce a `maxTurns` bound. Isolated here so it can be tested without RPC/block creation.

- [ ] **Step 1: Write the failing test**

Create `emain/agent/tools/spawn-cli-agent.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runSubagentToCompletion } from "./spawn-cli-agent";

function fakeSub(finalText: string) {
    return {
        harness: {
            prompt: vi.fn(async () => ({ role: "assistant", content: [{ type: "text", text: finalText }] })),
            abort: vi.fn(async () => {}),
        },
    } as any;
}

describe("runSubagentToCompletion", () => {
    it("returns the final assistant text as the summary", async () => {
        const sub = fakeSub("dev server listening on 3000");
        const summary = await runSubagentToCompletion(sub, "start dev server", { maxTurns: 5 });
        expect(summary).toBe("dev server listening on 3000");
        expect(sub.harness.prompt).toHaveBeenCalledWith("start dev server");
    });

    it("aborts and rethrows when the signal is already aborted", async () => {
        const sub = fakeSub("unused");
        const controller = new AbortController();
        controller.abort();
        await expect(
            runSubagentToCompletion(sub, "task", { maxTurns: 5, signal: controller.signal }),
        ).rejects.toThrow();
    });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run emain/agent/tools/spawn-cli-agent.test.ts`
Expected: FAIL — cannot resolve `./spawn-cli-agent`.

- [ ] **Step 3: Implement the driver**

Create `emain/agent/tools/spawn-cli-agent.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// spawn-cli-agent.ts — the main-agent-facing delegation tool plus the
// subagent driver. runSubagentToCompletion drives the subagent harness
// to convergence and extracts its natural-language summary. See spec §5
// (decision 5), §7.

import type { CliSubagentHarness } from "../cli-subagent-factory";

function extractText(message: unknown): string {
    const content = (message as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
    return content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n")
        .trim();
}

export async function runSubagentToCompletion(
    sub: CliSubagentHarness,
    task: string,
    opts: { maxTurns: number; signal?: AbortSignal },
): Promise<string> {
    if (opts.signal?.aborted) {
        await sub.harness.abort();
        throw new Error("aborted");
    }
    const onAbort = () => {
        void sub.harness.abort();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const finalMessage = await sub.harness.prompt(task);
        const summary = extractText(finalMessage);
        return summary || "(subagent produced no summary)";
    } finally {
        opts.signal?.removeEventListener("abort", onAbort);
    }
}
```

Note: `maxTurns` enforcement rides on the harness's own step budget; confirm whether `AgentHarness` accepts a max-turns/steps option in its constructor (check `agent-harness.ts`). If so, thread `opts.maxTurns` through `buildCliSubagentHarness` in Task 8 instead of here, and keep this driver focused on prompt + summary extraction. Adjust the Task 8 options and this call accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run emain/agent/tools/spawn-cli-agent.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add emain/agent/tools/spawn-cli-agent.ts emain/agent/tools/spawn-cli-agent.test.ts
git commit -m "feat(agent): add runSubagentToCompletion driver"
```

---

## Task 10: emain — spawn_cli_agent delegation tool + block lifecycle RPC

**Files:**
- Modify: `emain/agent/tools/_pty-rpc.ts` (add `startAgentCommandBlock`, `stopBlock`)
- Modify: `emain/agent/tools/_pty-rpc.test.ts`
- Modify: `emain/agent/tools/spawn-cli-agent.ts` (add `createSpawnCliAgentTool`)
- Modify: `emain/agent/tools/spawn-cli-agent.test.ts`

Adds the main-agent tool: start a `source:"agent"` cmd block, build the subagent, drive to completion, return the summary, transparently forwarding abort (spec decisions 5 & 6).

- [ ] **Step 1: Confirm the block-start RPC surface**

Read `pkg/blockcontroller/blockcontroller.go` and `pkg/wshrpc/wshrpctypes.go` for the command that creates a block + starts its shell controller with an initial command (look for `CreateBlockCommand` / `ControllerResyncCommand` / a `source` meta field). Note the exact command name and payload shape. If no single RPC starts a block with an initial command + `source:"agent"`, the minimal addition is a new `StartAgentCmdBlockCommand` — declare it in `wshrpctypes.go` and implement in `wshserver.go` mirroring Task 3's pattern, then `task generate`. Record the chosen approach as a comment in `_pty-rpc.ts`.

- [ ] **Step 2: Write the failing test for the RPC helpers**

Append to `emain/agent/tools/_pty-rpc.test.ts` (extend the existing `vi.mock` for `wshclientapi` to include the block commands you confirmed in Step 1 — shown here as `CreateBlockCommand`/`ControllerStopCommand`; substitute the real names):

```ts
it("startAgentCommandBlock returns the new blockId", async () => {
    const { startAgentCommandBlock } = await import("./_pty-rpc");
    const blockId = await startAgentCommandBlock("/tmp", "npm run dev");
    expect(typeof blockId).toBe("string");
    expect(blockId.length).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run emain/agent/tools/_pty-rpc.test.ts`
Expected: FAIL — `startAgentCommandBlock` is not exported.

- [ ] **Step 4: Implement the RPC helpers**

Append to `emain/agent/tools/_pty-rpc.ts` (substitute the real command names / payload from Step 1):

```ts
/**
 * Start a cmd block that runs `command` in `cwd`, tagged source:"agent"
 * so the UI shows it as agent-initiated. Returns the new blockId.
 */
export async function startAgentCommandBlock(cwd: string, command: string): Promise<string> {
    const resp = await RpcApi.CreateBlockCommand(ElectronWshClient, {
        // meta shape confirmed in Task 10 Step 1; source marks it agent-run.
        blockdef: { meta: { view: "term", "cmd:cwd": cwd, "cmd:cmd": command, source: "agent" } },
    } as never);
    return (resp as { blockid: string }).blockid;
}

/** Stop the block's running command (abort path). */
export async function stopBlock(blockId: string): Promise<void> {
    await RpcApi.ControllerStopCommand(ElectronWshClient, { blockid: blockId } as never);
}
```

- [ ] **Step 5: Run the helper test to verify it passes**

Run: `npx vitest run emain/agent/tools/_pty-rpc.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing test for the delegation tool**

Append to `emain/agent/tools/spawn-cli-agent.test.ts`:

```ts
import * as rpc from "./_pty-rpc";
import * as factory from "../cli-subagent-factory";

it("spawn_cli_agent starts a block, runs the subagent, returns the summary", async () => {
    vi.spyOn(rpc, "startAgentCommandBlock").mockResolvedValue("blk-new");
    vi.spyOn(rpc, "stopBlock").mockResolvedValue();
    vi.spyOn(factory, "buildCliSubagentHarness").mockReturnValue(fakeSub("listening on 3000"));

    const { createSpawnCliAgentTool } = await import("./spawn-cli-agent");
    const tool = createSpawnCliAgentTool({
        model: { id: "small" } as any,
        createSession: async () => ({ getMetadata: async () => ({}) }) as any,
    });
    const r = await tool.execute("t1", {
        task: "start dev server and confirm port 3000",
        initial_command: "npm run dev",
        cwd: "/tmp",
    });
    expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("3000") });
    expect(r.details).toMatchObject({ blockId: "blk-new" });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run emain/agent/tools/spawn-cli-agent.test.ts`
Expected: FAIL — `createSpawnCliAgentTool` is not exported.

- [ ] **Step 8: Implement the delegation tool**

Append to `emain/agent/tools/spawn-cli-agent.ts` (add imports at the top):

```ts
import { type Static, Type } from "typebox";
import type { Api, Model } from "../../ai";
import { buildCliSubagentHarness } from "../cli-subagent-factory";
import type { Session } from "../harness/types";
import type { AgentTool } from "../types";
import { startAgentCommandBlock, stopBlock } from "./_pty-rpc";

const spawnSchema = Type.Object({
    task: Type.String({ description: "Natural-language goal, e.g. start the dev server and confirm it listens on 3000." }),
    initial_command: Type.String({ description: "The long-running / interactive command to start." }),
    cwd: Type.String(),
});

export type SpawnCliAgentInput = Static<typeof spawnSchema>;

export interface SpawnCliAgentDetails {
    blockId: string;
}

export interface SpawnCliAgentDeps {
    model: Model<Api>;
    /** Mint an ephemeral in-memory session for the subagent. */
    createSession: () => Promise<Session>;
    maxTurns?: number;
    getApiKeyAndHeaders?: (
        model: Model<Api>,
    ) => Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;
}

export function createSpawnCliAgentTool(deps: SpawnCliAgentDeps): AgentTool<typeof spawnSchema, SpawnCliAgentDetails> {
    return {
        name: "spawn_cli_agent",
        label: "spawn cli agent",
        description:
            "Delegate a long-running or interactive shell command to a CLI subagent. Provide a natural-language task and the initial command; the subagent starts it, watches/interacts, and returns a natural-language summary. Use this instead of bash when the command will not exit on its own.",
        promptSnippet: "Delegate long-running / interactive commands to a CLI subagent.",
        parameters: spawnSchema,
        async execute(_toolCallId, params, signal) {
            const blockId = await startAgentCommandBlock(params.cwd, params.initial_command);
            const session = await deps.createSession();
            const sub = buildCliSubagentHarness({
                session,
                model: deps.model,
                blockId,
                cwd: params.cwd,
                getApiKeyAndHeaders: deps.getApiKeyAndHeaders,
            });
            const onAbort = () => {
                void sub.harness.abort();
                void stopBlock(blockId);
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
                const summary = await runSubagentToCompletion(sub, params.task, {
                    maxTurns: deps.maxTurns ?? 20,
                    signal,
                });
                return { content: [{ type: "text", text: summary }], details: { blockId } };
            } finally {
                signal?.removeEventListener("abort", onAbort);
            }
        },
    };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run emain/agent/tools/spawn-cli-agent.test.ts`
Expected: PASS (all cases).

- [ ] **Step 10: Register the tool for the main agent**

Read where the main pane agent's tools are assembled (`emain/agent/tools/index.ts:getDefaultTools` and its caller in `emain/agent-ipc.ts`). Add `spawn_cli_agent` alongside `bash` there — construct it with the pane's resolved model + an in-memory session factory (`() => new InMemorySessionRepo().create()`) + the same `getApiKeyAndHeaders` the pane harness uses. Do NOT add the three PTY tools to `getDefaultTools` — they stay subagent-private. Export `createSpawnCliAgentTool` from `emain/agent/tools/index.ts`.

- [ ] **Step 11: Run the full tool test suite**

Run: `npx vitest run emain/agent/tools/`
Expected: PASS. No regressions in existing `tools.test.ts`.

- [ ] **Step 12: Commit**

```bash
git add emain/agent/tools/_pty-rpc.ts emain/agent/tools/_pty-rpc.test.ts emain/agent/tools/spawn-cli-agent.ts emain/agent/tools/spawn-cli-agent.test.ts emain/agent/tools/index.ts emain/agent-ipc.ts
git commit -m "feat(agent): add spawn_cli_agent delegation tool and register it for the main agent"
```

---

## Task 11 (Phase 4, optional): renderer screen snapshot

**Files:**
- Modify: `emain/emain-web.ts` (add `webPtyScreenSnapshot`)
- Modify: `emain/emain-wsh.ts` (add `handle_ptyscreensnapshot`)
- Modify: `emain/agent/tools/_pty-screen.ts` (wire `getScreenSnapshot` to the RPC)
- Test: `emain/agent/tools/pty-read.test.ts` (add a screen-success case)

Replaces the throwing `_pty-screen.ts` seam with a real renderer query for alt-screen TUIs (spec §3, §6.2, §10 step 2c). Uses the emain→renderer request-response pattern (`getWebContentsByBlockId` + `webContents.send`/`ipcMain.once` in `emain-web.ts:7-25`).

- [ ] **Step 1: Add the renderer query in emain-web.ts**

Read `emain-web.ts:7-25` and `frontend/app/term/engine/block.ts:270-276` (`interactionMode` / `altScreen.active`) to confirm the renderer-side grid accessor. Add a function that sends a `pty-screen-snapshot-request` IPC to the block's webContents and awaits the reply on a random response channel (mirror `getWebContentsByBlockId`), returning `{ grid_contents, cursor, is_alt_screen_active }`. The renderer handler (in the frontend terminal view) reads the engine grid line-by-line (`Cell.char`) — add that handler next to the existing `webcontentsid-from-blockid` responder.

- [ ] **Step 2: Add handle_ptyscreensnapshot in emain-wsh.ts**

Mirror `handle_webscreenshot` (emain-wsh.ts:49-62): resolve the window + webContents by blockId, call `webPtyScreenSnapshot`, return the snapshot. Declare a `PtyScreenSnapshotCommand` in `wshrpctypes.go` + `task generate` if the tool calls it via RpcApi; otherwise call `webPtyScreenSnapshot` directly from `_pty-screen.ts` if it runs in emain.

- [ ] **Step 3: Wire getScreenSnapshot**

Replace the throwing body of `emain/agent/tools/_pty-screen.ts` `getScreenSnapshot` with a call to the emain-web function, returning the `ScreenSnapshot` shape.

- [ ] **Step 4: Add the screen-success test**

In `emain/agent/tools/pty-read.test.ts`, change the `_pty-screen` mock in a new `describe` block to resolve a snapshot, set `tailResp.altscreen = true`, and assert `details.source === "screen_snapshot"` and `content[0].text` contains the grid contents.

- [ ] **Step 5: Run the test**

Run: `npx vitest run emain/agent/tools/pty-read.test.ts`
Expected: PASS including the new screen-success case.

- [ ] **Step 6: Commit**

```bash
git add emain/emain-web.ts emain/emain-wsh.ts emain/agent/tools/_pty-screen.ts emain/agent/tools/pty-read.test.ts
git commit -m "feat(agent): wire renderer screen snapshot for pty_read alt-screen TUIs"
```

---

## Final verification

- [ ] **Run the emain agent test suite**

Run: `npx vitest run emain/agent/`
Expected: PASS. New files covered; no regressions.

- [ ] **Build the Go server**

Run: `go build ./pkg/...`
Expected: no errors.

- [ ] **Run the cmdblock Go tests**

Run: `go test ./pkg/cmdblock/ ./pkg/wshrpc/...`
Expected: PASS.

---

## Notes for the implementer

- **Verify real symbols before writing Go/harness glue.** Several tasks (3, 8, 9, 10, 11) call framework APIs whose exact names must be confirmed against the codebase (controller status accessors, `AgentHarness` constructor options, block-start RPC, renderer grid accessor). The code blocks show the intended shape; adjust identifiers to match reality rather than inventing them.
- **Generated files are outputs.** After changing `wshrpctypes.go`, always `task generate` and commit the regenerated `frontend/types/gotypes.d.ts` + `frontend/app/store/wshclientapi.ts`; never hand-edit them.
- **Subagent tools stay private.** `pty_write` / `pty_read` / `pty_transfer_to_user` must never appear in `getDefaultTools`. Only `spawn_cli_agent` is exposed to the main agent.
- **Phase 4 is optional for a first cut.** Tasks 1–10 ship a working transcript-tail subagent; `pty_read` degrades gracefully for alt-screen TUIs until Task 11 lands.
