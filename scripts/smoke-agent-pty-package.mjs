// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const makeDir = path.join(root, "make");

function newestOutputDir() {
  if (!existsSync(makeDir)) {
    throw new Error(`missing package output directory: ${makeDir}`);
  }
  const entries = readdirSync(makeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(makeDir, entry.name));
  if (entries.length === 0) {
    throw new Error(`no packaged app directory found under ${makeDir}`);
  }
  return entries.sort().at(-1);
}

function packagedAppBundle(outputDir) {
  if (process.platform === "darwin") {
    const app = readdirSync(outputDir).find((name) => name.endsWith(".app"));
    if (!app) {
      throw new Error(`no .app bundle found in ${outputDir}`);
    }
    return path.join(outputDir, app);
  }
  return outputDir;
}

function packagedExecutable(appBundle) {
  if (process.platform === "darwin") {
    return path.join(appBundle, "Contents", "MacOS", "Crest");
  }
  if (process.platform === "win32") {
    return path.join(appBundle, "Crest.exe");
  }
  return path.join(appBundle, "crest");
}

function packagedResourcesDir(appBundle) {
  if (process.platform === "darwin") {
    return path.join(appBundle, "Contents", "Resources");
  }
  return path.join(appBundle, "resources");
}

function packagedNodePtyDir(resourcesDir) {
  const candidates = [
    path.join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty"),
    path.join(resourcesDir, "node_modules", "node-pty"),
  ];
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "package.json")));
  if (!found) {
    throw new Error(`packaged node-pty not found; checked ${candidates.join(", ")}`);
  }
  const nativeFile = path.join(found, "prebuilds", `${process.platform}-${process.arch}`, "pty.node");
  if (!existsSync(nativeFile)) {
    throw new Error(`packaged node-pty native module not found: ${nativeFile}`);
  }
  return found;
}

const appBundle = packagedAppBundle(newestOutputDir());
const executable = packagedExecutable(appBundle);
if (!existsSync(executable)) {
  throw new Error(`packaged executable not found: ${executable}`);
}

const nodePtyDir = packagedNodePtyDir(packagedResourcesDir(appBundle));
const smokeDir = mkdtempSync(path.join(os.tmpdir(), "crest-agent-pty-smoke-"));
const smokeFile = path.join(smokeDir, "smoke.cjs");
writeFileSync(
  smokeFile,
  `
const nodePty = require(process.env.CREST_PACKAGED_NODE_PTY);
const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", "echo CREST_AGENT_PTY_SMOKE_OK"]
  : ["-c", "printf CREST_AGENT_PTY_SMOKE_OK"];
let output = "";
const pty = nodePty.spawn(shell, args, {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
});
const timeout = setTimeout(() => {
  try {
    pty.kill();
  } catch {}
  console.error("agent PTY smoke timed out");
  process.exit(1);
}, 10000);
pty.onData((data) => {
  output += data;
  process.stdout.write(data);
});
pty.onExit((event) => {
  clearTimeout(timeout);
  if (event.exitCode !== 0) {
    console.error(\`agent PTY smoke exited \${event.exitCode}\`);
    process.exit(event.exitCode || 1);
  }
  if (!output.includes("CREST_AGENT_PTY_SMOKE_OK")) {
    console.error("agent PTY smoke sentinel missing");
    process.exit(1);
  }
  process.exit(0);
});
`,
  "utf8"
);

const child = spawn(executable, [smokeFile], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    CREST_PACKAGED_NODE_PTY: nodePtyDir,
  },
  stdio: "inherit",
});

const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  console.error("packaged agent PTY smoke process timed out");
  process.exitCode = 1;
}, 20000);

child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  rmSync(smokeDir, { recursive: true, force: true });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
