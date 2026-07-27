# Terax renderer benchmark

This directory contains a renderer-side frame sampler for P4.1. Run it in a
development Electron renderer after opening a terminal block:

```js
const bench = await import("/frontend/app/xterm/bench/renderer-bench.ts");
await bench.runCommandBenchmark({
  blockId: "<terminal block id>",
  command: "yes | head -c 104857600",
  timeoutMs: 180000,
});
```

`head -c 104857600` is the portable numeric equivalent of 100 MiB. macOS/BSD
`head` rejects the original `100M` operand.

Before submitting the command, the harness samples 30 animation-frame
intervals. The median becomes `refreshIntervalMs`; the pass budget is one
detected refresh interval plus 2.5 ms of scheduler tolerance. When calibration
cannot produce a sample, the legacy 16.7 ms budget remains the fallback.

The result records the detected refresh interval, effective frame budget,
total time, p50/p99/max animation-frame intervals, Chromium JS heap
before/after, renderer-pool state, completion, and timeout. A timeout is always
a failed scenario even if its sampled p99 remains within the frame budget.

Run the remaining scenarios by changing `command`; alt-screen interaction,
multi-pane load, background-tab CPU, and scroll-to-top/bottom require a
CDP/manual driver around this sampler. Preserve raw results in `docs/`.

The product clamps `term:scrollback` to 50,000 lines. Scrollback acceptance
therefore means that the configured scrollback plus the visible viewport form
a continuous retained tail. It does not require retaining output beyond the
configured product window.
