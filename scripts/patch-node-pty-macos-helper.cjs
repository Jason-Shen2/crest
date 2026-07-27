// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const fs = require("node:fs");
const path = require("node:path");

const nodePtyLibDir = path.join(__dirname, "..", "node_modules", "node-pty", "lib");
const nodePtyUnixTerminalPath = path.join(nodePtyLibDir, "unixTerminal.js");
const nodePtyUtilsPath = path.join(nodePtyLibDir, "utils.js");

patchUnixTerminal();
patchUtils();

function patchUnixTerminal() {
    if (!fs.existsSync(nodePtyUnixTerminalPath)) {
        return;
    }

    const source = fs.readFileSync(nodePtyUnixTerminalPath, "utf8");
    if (source.includes("CREST_NODE_PTY_APP_BUNDLE_HELPER_PATCH")) {
        return;
    }

    const requireNeedle = 'var fs = require("fs");\nvar path = require("path");';
    const helperNeedle = [
        "var helperPath = native.dir + '/spawn-helper';",
        "helperPath = path.resolve(__dirname, helperPath);",
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
        "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
    ].join("\n");

    if (!source.includes(requireNeedle) || !source.includes(helperNeedle)) {
        throw new Error(`node-pty unixTerminal.js layout changed; update ${path.basename(__filename)}`);
    }

    const patched = source
        .replace(
            requireNeedle,
            [
                'var crypto = require("crypto");',
                'var fs = require("fs");',
                'var os = require("os");',
                'var path = require("path");',
            ].join("\n")
        )
        .replace(
            helperNeedle,
            [
                "// CREST_NODE_PTY_APP_BUNDLE_HELPER_PATCH",
                "function resolveHelperPath(helperRelativePath) {",
                "    var sourcePath = path.resolve(__dirname, helperRelativePath);",
                "    sourcePath = sourcePath.replace('app.asar', 'app.asar.unpacked');",
                "    sourcePath = sourcePath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
                "    if (process.platform !== 'darwin' || sourcePath.indexOf('.app/Contents/Resources/') === -1) {",
                "        return sourcePath;",
                "    }",
                "    try {",
                "        var stat = fs.statSync(sourcePath);",
                "        var cacheKey = crypto",
                "            .createHash('sha256')",
                "            .update(sourcePath + ':' + stat.size + ':' + stat.mtimeMs)",
                "            .digest('hex')",
                "            .slice(0, 16);",
                "        var helperDir = path.join(os.tmpdir(), 'crest-node-pty-spawn-helper', cacheKey);",
                "        var helperCopyPath = path.join(helperDir, 'spawn-helper');",
                "        fs.mkdirSync(helperDir, { recursive: true, mode: 0o700 });",
                "        if (!fs.existsSync(helperCopyPath) || fs.statSync(helperCopyPath).size !== stat.size) {",
                "            fs.copyFileSync(sourcePath, helperCopyPath);",
                "        }",
                "        fs.chmodSync(helperCopyPath, 0o755);",
                "        return helperCopyPath;",
                "    }",
                "    catch (_a) {",
                "        return sourcePath;",
                "    }",
                "}",
                "var helperPath = resolveHelperPath(native.dir + '/spawn-helper');",
            ].join("\n")
        );

    fs.writeFileSync(nodePtyUnixTerminalPath, patched);
}

function patchUtils() {
    if (!fs.existsSync(nodePtyUtilsPath)) {
        return;
    }

    const source = fs.readFileSync(nodePtyUtilsPath, "utf8");
    if (source.includes("CREST_NODE_PTY_APP_BUNDLE_NATIVE_PATCH")) {
        return;
    }

    const strictNeedle = '"use strict";\n';
    const returnNeedle = 'return { dir: dir, module: require(dir + "/" + name + ".node") };';

    if (!source.includes(strictNeedle) || !source.includes(returnNeedle)) {
        throw new Error(`node-pty utils.js layout changed; update ${path.basename(__filename)}`);
    }

    const helpers = [
        '"use strict";',
        "// CREST_NODE_PTY_APP_BUNDLE_NATIVE_PATCH",
        'var crypto = require("crypto");',
        'var fs = require("fs");',
        'var os = require("os");',
        'var path = require("path");',
        "function resolveNativeLoadTarget(modulePath, name) {",
        "    var resolvedModulePath = require.resolve(modulePath);",
        "    var nativeDir = path.dirname(resolvedModulePath);",
        "    if (process.platform !== 'darwin' || nativeDir.indexOf('.app/Contents/Resources/') === -1) {",
        "        return { dir: nativeDir, modulePath: resolvedModulePath };",
        "    }",
        "    var stat = fs.statSync(resolvedModulePath);",
        "    var cacheKey = crypto",
        "        .createHash('sha256')",
        "        .update(nativeDir + ':' + stat.size + ':' + stat.mtimeMs)",
        "        .digest('hex')",
        "        .slice(0, 16);",
        "    var cacheDir = path.join(os.tmpdir(), 'crest-node-pty-native', cacheKey);",
        "    var nativeCopyPath = path.join(cacheDir, name + '.node');",
        "    var helperSourcePath = path.join(nativeDir, 'spawn-helper');",
        "    var helperCopyPath = path.join(cacheDir, 'spawn-helper');",
        "    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });",
        "    if (!fs.existsSync(nativeCopyPath) || fs.statSync(nativeCopyPath).size !== stat.size) {",
        "        fs.copyFileSync(resolvedModulePath, nativeCopyPath);",
        "    }",
        "    if (fs.existsSync(helperSourcePath)) {",
        "        var helperStat = fs.statSync(helperSourcePath);",
        "        if (!fs.existsSync(helperCopyPath) || fs.statSync(helperCopyPath).size !== helperStat.size) {",
        "            fs.copyFileSync(helperSourcePath, helperCopyPath);",
        "        }",
        "        fs.chmodSync(helperCopyPath, 0o755);",
        "    }",
        "    return { dir: cacheDir, modulePath: nativeCopyPath };",
        "}",
    ].join("\n");

    const patched = source
        .replace(strictNeedle, `${helpers}\n`)
        .replace(
            returnNeedle,
            [
                'var target = resolveNativeLoadTarget(dir + "/" + name + ".node", name);',
                "return { dir: target.dir, module: require(target.modulePath) };",
            ].join("\n")
        );

    fs.writeFileSync(nodePtyUtilsPath, patched);
}
