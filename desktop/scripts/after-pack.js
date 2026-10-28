// electron-builder afterPack: flip the Electron fuses, then (macOS) ad-hoc sign the bundle
// inside-out - fuses and our resources change the binaries, and arm64 refuses unsigned code.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

const FUSES = {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: false, // re-signed below, once, after everything changed
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false, // the app never loads file:
};

const isMachO = (f) => {
  const fd = fs.openSync(f, "r");
  try {
    const b = Buffer.alloc(4);
    if (fs.readSync(fd, b, 0, 4, 0) < 4) return false;
    const m = b.readUInt32BE(0);
    return [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xfeedface, 0xcefaedfe].includes(m);
  } finally {
    fs.closeSync(fd);
  }
};

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

const sign = (args) => execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", ...args], { stdio: "inherit" });

exports.default = async function afterPack(ctx) {
  const mac = ctx.electronPlatformName === "darwin";
  const name = ctx.packager.appInfo.productFilename;
  const app = mac ? path.join(ctx.appOutDir, `${name}.app`) : path.join(ctx.appOutDir, ctx.packager.executableName);
  await flipFuses(app, FUSES);
  if (!mac) return;
  // 1. the frozen server (Resources is not covered by --deep): dylibs/.so first, executable last
  const server = path.join(app, "Contents", "Resources", "server", "viewer-server");
  const exe = path.join(server, "viewer-server");
  const libs = [...walk(server)].filter((f) => f !== exe && isMachO(f));
  for (let i = 0; i < libs.length; i += 200) sign(libs.slice(i, i + 200));
  sign([exe]);
  // 2. Electron's frameworks, helpers and the main executable
  sign(["--deep", app]);
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
