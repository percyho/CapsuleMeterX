import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostTarget = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || hostTarget;

if (!target.endsWith("-pc-windows-msvc")) {
  console.log(`Codex sidecar packaging is Windows-only; skipping target ${target}.`);
  process.exit(0);
}

if (process.platform !== "win32") {
  throw new Error(`Cross-compiling the Codex sidecar for ${target} is not supported on ${process.platform}.`);
}

const targetPackages = {
  "x86_64-pc-windows-msvc": "codex-win32-x64",
  "aarch64-pc-windows-msvc": "codex-win32-arm64",
};
const nativePackageName = targetPackages[target];
if (!nativePackageName) {
  throw new Error(`No pinned Codex CLI package is configured for ${target}.`);
}

const wrapperLink = path.join(projectRoot, "node_modules", "@openai", "codex");
if (!existsSync(wrapperLink)) {
  throw new Error("Codex CLI build dependency is missing. Run pnpm install first.");
}

const wrapperRoot = realpathSync(wrapperLink);
const wrapperManifest = JSON.parse(readFileSync(path.join(wrapperRoot, "package.json"), "utf8"));
const nativeLink = path.join(path.dirname(wrapperRoot), nativePackageName);
if (!existsSync(nativeLink)) {
  throw new Error(`The pinned ${nativePackageName} package is missing. Run pnpm install on a matching Windows architecture.`);
}

const vendorRoot = path.join(realpathSync(nativeLink), "vendor", target);
const vendorManifest = JSON.parse(readFileSync(path.join(vendorRoot, "codex-package.json"), "utf8"));
if (vendorManifest.version !== wrapperManifest.version || vendorManifest.target !== target) {
  throw new Error(`Codex sidecar package mismatch: expected ${wrapperManifest.version} for ${target}.`);
}

const binariesRoot = path.resolve(projectRoot, "src-tauri", "binaries");
const destination = path.resolve(binariesRoot, "codex");
const relativeDestination = path.relative(binariesRoot, destination);
if (!relativeDestination || relativeDestination.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDestination)) {
  throw new Error("Refusing to write the Codex sidecar outside src-tauri/binaries.");
}

mkdirSync(binariesRoot, { recursive: true });
rmSync(destination, { recursive: true, force: true });
cpSync(vendorRoot, destination, { recursive: true });

console.log(`Prepared Codex CLI ${vendorManifest.version} for ${target} in src-tauri/binaries/codex.`);
