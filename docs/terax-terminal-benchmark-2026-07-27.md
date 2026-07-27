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
| `yes \| head -c 104857600`                  | No; interrupted after timebox | 171,706.8 ms / 20,585 frames |    8.3 ms |    9.3 ms |  158.3 ms | **Fail**: renderer stayed responsive, but 100 MiB did not complete |
| `seq 1 100000` output                       |                           Yes |         516.7 ms / 61 frames |    8.3 ms |   10.4 ms |   10.4 ms | Frame budget pass                                                  |
| `seq 1 100000`, 120 top/bottom alternations |                           Yes |                   119 frames |    8.3 ms |    9.9 ms |   10.3 ms | Interaction pass; retention fail                                   |

The 100 MiB run ended with `usedJSHeapSize=61,385,594` bytes. Its output was
interrupted with ETX and the prompt recovered normally.

The `seq 1 100000` run grew the sampled JS heap by 5,357,742 bytes. After the
command, xterm reported `buffer.length=2041`, `baseY=2000`, and
`scrollback=2000`. This is expected for the current setting, but it disproves
the original “all 100,000 lines retained” acceptance criterion. Even the
product maximum is 50,000 lines, so that criterion is impossible without a
configuration/product change.

The original `head -c 100M` spelling is also invalid on macOS/BSD `head`;
`104857600` is the exact portable byte count used above.

## Functional Electron smoke completed alongside the benchmark

- Prompt startup and controller resync
- Command input/output, Up history, and direct PTY ETX interruption
- `less` alt-screen enter/exit
- Cmd+F search with match count
- exit-code overlay after `false`
- multiline terminal submission preserving line breaks
- WebGL rendering and scroll-to-top/bottom after heavy output

Direct PTY ETX was exercised through the public controller RPC. The UI key
gesture itself still needs a dedicated automation assertion.

## Remaining P4.1 work

- Scenario 2: `cat` a 50 MB text log
- Scenario 4: 30-second `vim` navigation latency
- Scenario 5: eight concurrent `tail -f` panes
- Scenario 6: background-tab CPU comparison against the deleted legacy engine

P4.1 remains partial until these scenarios are measured and the two failed
acceptance assumptions above are either revised or implemented.
