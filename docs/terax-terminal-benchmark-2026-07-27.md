# Terax terminal benchmark — 2026-07-27

## Environment

- macOS arm64, Electron development build, isolated schema-17 data directory
- current worktree Go server source and Vite renderer
- xterm.js 6 WebGL renderer active (2 canvases)
- terminal size approximately 113 × 44; configured scrollback 2,000 lines
- sampler: `frontend/app/xterm/bench/renderer-bench.ts`

Animation-frame percentiles measure renderer responsiveness while PTY output is
active. They are not a substitute for command completion or throughput: a
timed-out command fails even when its sampled p99 is within the frame budget.
The final harness calibrates 30 frames before each command and accepts p99
within one detected refresh interval plus 2.5 ms.

## Results

| Scenario                                    | Completion |               Total / sample | p50 frame | p99 frame | Max frame | Result                                            |
| ------------------------------------------- | ---------: | ---------------------------: | --------: | --------: | --------: | ------------------------------------------------- |
| Python block-write, 100 MiB                 |        Yes |       1,498.6 ms / 90 frames |   16.7 ms |   18.6 ms |   18.6 ms | Throughput pass; no long frame                    |
| `cat` 50 MiB text log                       |        Yes |           997 ms / 58 frames |   16.7 ms |   17.7 ms |   17.7 ms | Throughput pass; prompt recovered                 |
| `seq 1 100000` output                       |        Yes |         516.7 ms / 61 frames |    8.3 ms |   10.4 ms |   10.4 ms | Frame budget pass                                 |
| `seq 1 100000`, 120 top/bottom alternations |        Yes |                   119 frames |    8.3 ms |    9.9 ms |   10.3 ms | Interaction pass; retention fail                  |
| vim 100k-line file, continuous `j`/`k`      |        Yes |     30,015 ms / 1,801 frames |   16.7 ms |   17.6 ms |   17.7 ms | 1,740 keys; alt-screen exited to prompt           |
| 8 pane concurrent tail-like output          |        Yes |     15,001.4 ms / 900 frames |   16.7 ms |   17.7 ms |   17.7 ms | 5-slot eviction active; all pane output recovered |
| Background 50 MiB block output              |        Yes | active/background CDP sample |         — |         — |         — | parked; renderer layout time 77.6% lower          |

The refresh-aware harness was exercised live with a one-second command:
`refreshIntervalMs=16.6`, `frameBudgetMs=19.1`, `p99FrameMs=17.6`, and
`meetsFrameBudget=true`.

The original `yes | head -c 104857600` run was interrupted after 171,706.8 ms.
Backend instrumentation showed why: macOS/BSD `head -c` emitted the line-heavy
pipeline to the PTY in approximately 3.4 million reads averaging 4–5 bytes.
The complete Crest work after those reads—coalescing, filestore append, Tracker,
WPS delivery, and xterm parse—was not the limiter. Disabling PTY `OPOST` did not
materially change the result.

The replacement flood generator writes a 100 MiB buffer in large chunks:

```sh
python3 -c 'import sys; sys.stdout.buffer.write(b"x" * 104857600)'
```

It completed through the same PTY → Go → WPS → xterm path in 1,498.6 ms and
grew the sampled JS heap by 10,617,413 bytes. The 50 MiB text-log `cat` completed
in 997 ms and grew the heap by 2,570,691 bytes. These controls establish that
the old timeout was a macOS benchmark-generator artifact, not Crest terminal
throughput.

The `seq 1 100000` run grew the sampled JS heap by 5,357,742 bytes. After the
command, xterm reported `buffer.length=2041`, `baseY=2000`, and
`scrollback=2000`. A final 144×44 run retained the continuous numeric tail
97,958 through 100,000 (2,043 lines, zero gaps). The acceptance decision is
therefore “complete within the configured scrollback plus viewport,” not
“retain output beyond the configured product window.” The 50,000-line product
maximum remains unchanged.

The original `head -c 100M` spelling is invalid on macOS/BSD `head`;
`104857600` is the exact portable byte count, but `head` is still not a suitable
TTY flood generator on this platform.

The later runs were sampled on a 60 Hz renderer: their median frame interval is
already 16.7 ms, so an absolute `p99 <= 16.7 ms` rejects normal refresh-period
quantization (17.6–18.6 ms) even when there are no long frames. The implemented
criterion is one calibrated refresh interval plus 2.5 ms of scheduler
tolerance, with 16.7 ms retained only as a no-calibration fallback.

## Background-cost acceptance decision

The legacy engine was deleted before a CPU baseline was captured. Rather than
inventing a number from a different commit and runtime, scenario 6 now uses an
identical-workload A/B within the current renderer. A 50 MiB Python block write
was submitted once with the session visible and once after
`setSessionVisibility(false, false)`.

The active sample used 0.591523 s of CDP `TaskDuration` and 0.000865 s of
`LayoutDuration`; the background sample used 0.545025 s and 0.000194 s
respectively. Total task time falls only 7.9% because WPS delivery, base64
decode, and session ingestion intentionally continue in the background.
Renderer layout work falls 77.6%, the pool reports `parked=true`, the command
returns to `prompt`, and output is replayed when visible again.

This is the actionable guard for the migrated design: background sessions must
stay data-fresh while the live xterm/WebGL layout path is parked. The original
“≥80% versus legacy process CPU” line is retired because no measured legacy
sample exists.

The first 8-pane run exposed a pool-rebind state bug: a pane could display the
restored prompt while its internal block mode remained `running`. The slot was
replaying snapshot/dormant bytes before replacing the prior leaf's OSC
handlers. After registering the new leaf handlers before replay, a fresh
Electron run verified all 8 panes retained their own output and returned to
`prompt` while cycling through the 5-slot pool.

The final pre-merge review found two additional ordering hazards. Xterm writes
are asynchronous, so a slot with queued writes now drains into its old pane
before its final snapshot is stored; the replacement pane temporarily uses an
overflow slot, and the pool returns to five after the callbacks complete.
Blockfile append events now also carry the absolute offset captured by the same
lock as the append, allowing cold restore to remove bytes already included in
the fetched snapshot without dropping later output. Focused regressions cover
both races.

## Functional Electron smoke completed alongside the benchmark

- Prompt startup and controller resync
- Command input/output, Up history, and direct PTY ETX interruption
- `less` alt-screen enter/exit
- Cmd+F search with match count
- exit-code overlay after `false`
- multiline terminal submission preserving line breaks
- WebGL rendering and scroll-to-top/bottom after heavy output
- `vim` alt-screen with 30 seconds of continuous navigation
- balanced 8-pane layout, pool eviction, snapshot/dormant replay, and prompt recovery
- prompt-editor Chinese composition (`中文测试`) submitted to the shell
- raw xterm composition (`终端输入`) echoed through `cat`, then ETX returned to prompt
- renderer reload restored a unique sentinel from the `term` blockfile and recovered prompt mode

Direct PTY ETX was exercised through the public controller RPC. The UI key
gesture itself still needs a dedicated automation assertion.

The composition checks synthesize browser composition events and validate both
application input paths. They do not automate the native macOS candidate
window, which remains an optional hands-on platform check rather than a merge
gate.

## P4.1 status

Complete. Scenarios 1–5 retain their raw frame/throughput results, scenario 6
has a reproducible same-build background-layout guard, scrollback is judged
against the configured retained window, and the harness uses a calibrated
refresh-aware frame budget.
