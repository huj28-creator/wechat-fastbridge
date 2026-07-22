#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") {
  throw new Error("WeChat FastBridge currently supports macOS only.");
}
if (Number(process.versions.node.split(".")[0]) < 20) {
  throw new Error(`Node.js 20 or newer is required. You have ${process.version}.`);
}

try {
  execFileSync("codex", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("Codex CLI was not found. Install or update Codex, then run `npm run setup` again.");
}

console.log("Using the bundled universal native bridge (free; no App Store account required)…");
const nativeBinary = resolve(root, "bridge/native/wechat-ax");
try {
  if (!existsSync(nativeBinary)) throw new Error("missing");
  chmodSync(nativeBinary, 0o755);
} catch {
  console.log("Bundled bridge missing; building from source with the free Xcode Command Line Tools…");
  execFileSync("npm", ["run", "build:native"], { cwd: root, stdio: "inherit" });
}

const server = resolve(root, "bridge/server.mjs");
try {
  execFileSync("codex", ["mcp", "get", "wechat-fastbridge"], { stdio: "ignore" });
  execFileSync("codex", ["mcp", "remove", "wechat-fastbridge"], { stdio: "ignore" });
  console.log("Refreshed the existing Codex MCP entry.");
} catch {}
execFileSync("codex", ["mcp", "add", "wechat-fastbridge", "--", process.execPath, server], { stdio: "inherit" });

const skillsDir = resolve(homedir(), ".codex/skills");
mkdirSync(skillsDir, { recursive: true });
const installedSkill = resolve(skillsDir, "wechat-computer-use");
rmSync(installedSkill, { recursive: true, force: true });
cpSync(resolve(root, "skill/wechat-computer-use"), installedSkill, {
  recursive: true,
  force: true,
});

console.log("Done. The MCP server and a clean, current skill copy are installed.");
console.log("Next: grant Accessibility permission, restart Codex, open WeChat, then run `npm run doctor`.");
