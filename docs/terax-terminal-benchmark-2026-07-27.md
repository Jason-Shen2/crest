# Terax terminal benchmark — 2026-07-27

## Environment

- macOS arm64, Electron development build, isolated schema-17 data directory
- current worktree Go server source and Vite renderer
- xterm.js 6 WebGL renderer active (2 canvases)
- terminal size approximately 113 × 44; configured scrollback 2,000 lines
- sampler: `frontend/app/xterm/bench/renderer-bench.ts`

Animation-frame percentiles measure renderer responsiveness while PTY output is
active. They are not a substitute for command completion or throughput: a
timed-out command fails even when its sampled p99 is below 16.7 ms.

## Results

| Scenario                                    |                    Completion |               Total / sample | p50 frame | p99 frame | Max frame | Result                                                             |
| ------------------------------------------- | ----------------------------: | ---------------------------: | --------: | --------: | --------: | ------------------------------------------------------------------ |
| Python block-write, 100 MiB                  |                           Yes |       1,498.6 ms / 90 frames |   16.7 ms |   18.6 ms |   18.6 ms | Throughput pass; no long frame                                     |
| `cat` 50 MiB text log                       |                           Yes |           997 ms / 58 frames |   16.7 ms |   17.7 ms |   17.7 ms | Throughput pass; prompt recovered                                  |
| `seq 1 100000` output                       |                           Yes |         516.7 ms / 61 frames |    8.3 ms |   10.4 ms |   10.4 ms | Frame budget pass                                                  |
| `seq 1 100000`, 120 top/bottom alternations |                           Yes |                   119 frames |    8.3 ms |    9.9 ms |   10.3 ms | Interaction pass; retention fail                                   |
| vim 100k-line file, continuous `j`/`k`      |                           Yes |     30,015 ms / 1,801 frames |   16.7 ms |   17.6 ms |   17.7 ms | 1,740 keys; alt-screen exited to prompt                            |
| 8 pane concurrent tail-like output          |                           Yes |      15,001.4 ms / 900 frames |   16.7 ms |   17.7 ms |   17.7 ms | 5-slot eviction active; all pane output recovered                  |

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
`scrollback=2000`. This is expected for the current setting, but it disproves
the original “all 100,000 lines retained” acceptance criterion. Even the
product maximum is 50,000 lines, so that criterion is impossible without a
configuration/product change.

The original `head -c 100M` spelling is invalid on macOS/BSD `head`;
`104857600` is the exact portable byte count, but `head` is still not a suitable
TTY flood generator on this platform.

The later runs were sampled on a 60 Hz renderer: their median frame interval is
already 16.7 ms, so an absolute `p99 <= 16.7 ms` rejects normal refresh-period
quantization (17.6–18.6 ms) even when there are no long frames. The raw values
are retained above; the acceptance line should be normalized to the detected
refresh interval or expressed as a long-frame threshold.

The first 8-pane run exposed a pool-rebind state bug: a pane could display the
restored prompt while its internal block mode remained `running`. The slot was
replaying snapshot/dormant bytes before replacing the prior leaf's OSC
handlers. After registering the new leaf handlers before replay, a fresh
Electron run verified all 8 panes retained their own output and returned to
`prompt` while cycling through the 5-slot pool.

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

Direct PTY ETX was exercised through the public controller RPC. The UI key
gesture itself still needs a dedicated automation assertion.

## Remaining P4.1 work

- Scenario 6: background-tab CPU comparison against the deleted legacy engine
- Decide whether scrollback acceptance means “complete up to the configured
  limit” or raising the product maximum above 100,000 lines
- Replace the fixed 16.7 ms frame threshold with a refresh-rate-aware criterion

Scenarios 1–5 are now measured. P4.1 remains partial only because scenario 6
has no retained legacy-engine baseline and the two acceptance assumptions above
require a product/benchmark decision.
