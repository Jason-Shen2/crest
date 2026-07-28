// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export interface ProcessOwnerIdentity {
    pid: number;
    processStartToken: string;
    nonce: string;
}

const execFileAsync = promisify(execFile);

export async function makeProcessOwnerIdentity(): Promise<ProcessOwnerIdentity> {
    return {
        pid: process.pid,
        processStartToken: await readProcessStartToken(process.pid),
        nonce: randomBytes(32).toString("hex"),
    };
}

export async function readProcessStartToken(pid: number): Promise<string> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("Invalid process id");
    }
    if (process.platform === "linux") {
        return readLinuxProcessStartToken(pid);
    }
    if (process.platform === "darwin" || process.platform === "freebsd") {
        return readPsProcessStartToken(pid);
    }
    if (process.platform === "win32") {
        return readWindowsProcessStartToken(pid);
    }
    return readPsProcessStartToken(pid);
}

async function readLinuxProcessStartToken(pid: number): Promise<string> {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = value.lastIndexOf(")");
    if (commandEnd < 0) {
        throw new Error(`Invalid process stat for pid ${pid}`);
    }
    const fields = value
        .slice(commandEnd + 2)
        .trimEnd()
        .split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks || !/^[0-9]+$/.test(startTicks)) {
        throw new Error(`Invalid process start token for pid ${pid}`);
    }
    return `linux:${startTicks}`;
}

async function readPsProcessStartToken(pid: number): Promise<string> {
    const executable = process.platform === "darwin" ? "/bin/ps" : "ps";
    const { stdout } = await execFileAsync(executable, ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        timeout: 5_000,
        windowsHide: true,
    });
    const token = stdout.trim();
    if (!token) {
        throw new Error(`Process ${pid} does not exist`);
    }
    return `${process.platform}:${token}`;
}

async function readWindowsProcessStartToken(pid: number): Promise<string> {
    try {
        const { stdout } = await execFileAsync(
            "wmic",
            ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"],
            {
                encoding: "utf8",
                timeout: 5_000,
                windowsHide: true,
            }
        );
        const match = /(?:^|\r?\n)CreationDate=([^\r\n]+)/.exec(stdout);
        if (match?.[1]) {
            return `win32:${match[1]}`;
        }
    } catch {
        return readWindowsProcessStartTokenWithPowerShell(pid);
    }
    throw new Error(`Process ${pid} does not exist`);
}

async function readWindowsProcessStartTokenWithPowerShell(pid: number): Promise<string> {
    const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().Ticks`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
    });
    const token = stdout.trim();
    if (!/^[0-9]+$/.test(token)) {
        throw new Error(`Process ${pid} does not exist`);
    }
    return `win32:${token}`;
}
