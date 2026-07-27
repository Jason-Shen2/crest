const { Arch } = require("electron-builder");
const pkg = require("./package.json");
const fs = require("fs");
const path = require("path");

const windowsShouldSign = !!process.env.SM_CODE_SIGNING_CERT_SHA1_HASH;

function chmodMatchingFiles(rootDir, predicate, mode) {
    if (!fs.existsSync(rootDir)) {
        return;
    }
    fs.readdirSync(rootDir, {
        recursive: true,
        withFileTypes: true,
    })
        .filter((file) => file.isFile() && predicate(file.name))
        .forEach((file) => fs.chmodSync(path.resolve(file.parentPath ?? file.path, file.name), mode));
}

/**
 * @type {import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration/configuration
 */
const config = {
    appId: pkg.build.appId,
    productName: pkg.productName,
    executableName: pkg.productName,
    artifactName: "${productName}-${platform}-${arch}-${version}.${ext}",
    generateUpdatesFilesForAllChannels: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    electronCompile: false,
    files: [
        {
            from: "./dist",
            to: "./dist",
            filter: ["**/*", "!bin/*", "bin/wavesrv.${arch}*", "bin/wsh*", "!tsunamiscaffold/**/*"],
        },
        {
            from: ".",
            to: ".",
            filter: ["package.json"],
        },
        {
            from: ".",
            to: ".",
            filter: [
                "NOTICE",
                "NOTICES.md",
                "frontend/app/observability/trace-panel/LICENSE.langfuse",
                "third_party/licenses/elkjs-EPL-2.0.md",
            ],
        },
        {
            from: "node_modules/typescript-language-server",
            to: "node_modules/typescript-language-server",
            filter: ["lib/**/*", "package.json"],
        },
        {
            from: "node_modules/typescript",
            to: "node_modules/typescript",
            filter: ["lib/**/*", "package.json"],
        },
        {
            from: "node_modules/node-pty",
            to: "node_modules/node-pty",
            filter: ["package.json", "build/Release/**/*", "lib/**/*", "prebuilds/**/*"],
        },
        "!node_modules", // We don't need electron-builder to package in Node modules as Vite has already bundled any code that our program is using.
    ],
    extraResources: [
        {
            from: "dist/tsunamiscaffold",
            to: "tsunamiscaffold",
        },
    ],
    directories: {
        output: "make",
    },
    asarUnpack: [
        "dist/bin/**/*", // wavesrv and wsh binaries
        "dist/schema/**/*", // schema files for Monaco editor
        "node_modules/typescript-language-server/**",
        "node_modules/typescript/**",
        "node_modules/node-pty/**",
    ],
    mac: {
        target: [
            {
                target: "zip",
                arch: ["arm64", "x64"],
            },
            {
                target: "dmg",
                arch: ["arm64", "x64"],
            },
        ],
        category: "public.app-category.developer-tools",
        minimumSystemVersion: "10.15.0",
        mergeASARs: true,
        singleArchFiles: "**/dist/bin/wavesrv.*",
        entitlements: "build/entitlements.mac.plist",
        entitlementsInherit: "build/entitlements.mac.plist",
        extendInfo: {
            NSContactsUsageDescription: "A CLI application running in Crest wants to use your contacts.",
            NSRemindersUsageDescription: "A CLI application running in Crest wants to use your reminders.",
            NSLocationWhenInUseUsageDescription:
                "A CLI application running in Crest wants to use your location information while active.",
            NSLocationAlwaysUsageDescription:
                "A CLI application running in Crest wants to use your location information, even in the background.",
            NSCameraUsageDescription: "A CLI application running in Crest wants to use the camera.",
            NSMicrophoneUsageDescription: "A CLI application running in Crest wants to use your microphone.",
            NSCalendarsUsageDescription: "A CLI application running in Crest wants to use Calendar data.",
            NSLocationUsageDescription: "A CLI application running in Crest wants to use your location information.",
            NSAppleEventsUsageDescription: "A CLI application running in Crest wants to use AppleScript.",
        },
    },
    linux: {
        artifactName: "${name}-${platform}-${arch}-${version}.${ext}",
        category: "TerminalEmulator",
        executableName: pkg.name,
        target: ["zip", "deb", "rpm", "snap", "AppImage", "pacman"],
        synopsis: pkg.description,
        description: null,
        desktop: {
            entry: {
                Name: pkg.productName,
                Comment: pkg.description,
                Keywords: "developer;terminal;emulator;",
                Categories: "Development;Utility;",
            },
        },
        executableArgs: ["--enable-features", "UseOzonePlatform", "--ozone-platform-hint", "auto"], // Hint Electron to use Ozone abstraction layer for native Wayland support
    },
    deb: {
        afterInstall: "build/deb-postinstall.tpl",
    },
    win: {
        target: ["nsis", "msi", "zip"],
        signtoolOptions: windowsShouldSign && {
            signingHashAlgorithms: ["sha256"],
            publisherName: "s-zx",
            certificateSubjectName: "s-zx",
            certificateSha1: process.env.SM_CODE_SIGNING_CERT_SHA1_HASH,
        },
    },
    appImage: {
        license: "LICENSE",
    },
    snap: {
        base: "core22",
        confinement: "classic",
        allowNativeWayland: true,
        artifactName: "${name}_${version}_${arch}.${ext}",
    },
    rpm: {
        // this should remove /usr/lib/.build-id/ links which can conflict with other electron apps like slack
        fpm: ["--rpm-rpmbuild-define", "_build_id_links none"],
    },
    publish: null,
    afterPack: (context) => {
        const appResourcesDir = path.resolve(context.appOutDir, `${pkg.productName}.app/Contents/Resources`);
        chmodMatchingFiles(
            path.resolve(appResourcesDir, "app.asar.unpacked/node_modules/node-pty/prebuilds"),
            (name) => name === "spawn-helper",
            0o755
        );

        // This is a workaround to restore file permissions to the wavesrv binaries on macOS after packaging the universal binary.
        if (context.electronPlatformName === "darwin" && context.arch === Arch.universal) {
            chmodMatchingFiles(
                path.resolve(appResourcesDir, "app.asar.unpacked/dist/bin"),
                (name) => name.startsWith("wavesrv"),
                0o755
            );
        }
    },
};

module.exports = config;
