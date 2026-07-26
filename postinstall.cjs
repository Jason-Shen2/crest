const skip =
    process.env.WAVETERM_SKIP_APP_DEPS === "1" || process.env.CF_PAGES === "1" || process.env.CF_PAGES === "true";

if (skip) {
    console.log("postinstall: skipping electron-builder install-app-deps");
    process.exit(0);
}

function restoreNodePtyHelperPermissions() {
    const fs = require("fs");
    const path = require("path");
    const prebuildsDir = path.join(__dirname, "node_modules", "node-pty", "prebuilds");
    if (!fs.existsSync(prebuildsDir)) {
        return;
    }
    for (const platformDir of fs.readdirSync(prebuildsDir)) {
        const helperPath = path.join(prebuildsDir, platformDir, "spawn-helper");
        if (fs.existsSync(helperPath)) {
            fs.chmodSync(helperPath, 0o755);
        }
    }
}

import("child_process").then(({ execSync }) => {
    execSync("electron-builder install-app-deps", { stdio: "inherit" });
    execSync("electron-rebuild -f -w node-pty", { stdio: "inherit" });
    execSync("node scripts/patch-node-pty-macos-helper.cjs", { stdio: "inherit" });
    restoreNodePtyHelperPermissions();
});
