#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") {
  throw new Error("WeChat FastBridge currently supports macOS only.");
}

console.log("Using the bundled universal native bridge (free; no App Store account required)…");
const nativeBinary = resolve(root, "bridge/native/wechat-ax");
try {
  execFileSync("chmod", ["+x", nativeBinary]);
} catch {
  console.log("Bundled bridge missing; building from source with the free Xcode Command Line Tools…");
  execFileSync("npm", ["run", "build:native"], { cwd: root, stdio: "inherit" });
}

const server = resolve(root, "bridge/server.mjs");
try {
  execFileSync("codex", ["mcp", "get", "wechat-fastbridge"], { stdio: "ignore" });
  console.log("Codex already has an MCP server named wechat-fastbridge.");
  console.log("Remove it with `codex mcp remove wechat-fastbridge`, then run setup again if its path changed.");
} catch {
  execFileSync("codex", ["mcp", "add", "wechat-fastbridge", "--", process.execPath, server], { stdio: "inherit" });
}

const skillsDir = resolve(homedir(), ".codex/skills");
mkdirSync(skillsDir, { recursive: true });
cpSync(resolve(root, "skill/wechat-computer-use"), resolve(skillsDir, "wechat-computer-use"), {
  recursive: true,
  force: true,
});

console.log("Done. The MCP server and skill are installed. Restart Codex, open WeChat, and grant Accessibility permission.");
