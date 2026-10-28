// npm run dist[:mac|:linux]: build web/out fresh, freeze the server, compile, package for this
// machine's arch (PyInstaller cannot cross-compile). Extra args go to electron-builder.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.resolve(desktop, "..", "web");
const [target = process.platform === "darwin" ? "mac" : "linux", ...rest] = process.argv.slice(2);
const host = process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : null;
if (target !== host) {
  console.error(`dist: building for ${target} needs a ${target} machine (this is ${process.platform})`);
  process.exit(1);
}
const arch = { arm64: "--arm64", x64: "--x64" }[process.arch];
if (!arch) throw new Error(`unsupported arch ${process.arch}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, args, cwd) => {
  console.log(`\n> (${path.relative(desktop, cwd) || "."}) ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
};

if (!process.env.LDV_SKIP_WEB) {
  run(npm, ["ci"], web);
  run(npm, ["run", "build"], web);
}
if (!process.env.LDV_SKIP_SERVER) run("bash", [path.join(desktop, "scripts", "build-server.sh")], desktop);
run(npm, ["run", "build"], desktop);
run(path.join(desktop, "node_modules", ".bin", "electron-builder"), [`--${target}`, arch, ...rest], desktop);
