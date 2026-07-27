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

The result records total time, p50/p99/max animation-frame intervals, Chromium
JS heap before/after, renderer-pool state, completion, and timeout. A timeout is
always a failed scenario even if its sampled p99 remains below 16.7 ms.

Run the remaining scenarios by changing `command`; alt-screen interaction,
multi-pane load, background-tab CPU, and scroll-to-top/bottom still require a
Playwright/manual driver around this sampler. Preserve raw results in `docs/`.

The product clamps `term:scrollback` to 50,000 lines. Therefore the original
“`seq 100000` and retain all 100,000 lines” criterion cannot pass without a
product-setting change; record retained lines separately from scroll latency.
