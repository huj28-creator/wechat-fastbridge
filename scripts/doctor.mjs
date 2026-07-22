#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeBridge } from "../bridge/native-runner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const pass = (message) => console.log(`✓ ${message}`);
const fail = (message, fix) => {
  failures += 1;
  console.log(`✗ ${message}`);
  if (fix) console.log(`  Fix: ${fix}`);
};

if (process.platform === "darwin") pass("macOS detected");
else fail("This computer is not running macOS", "Use FastBridge on a Mac.");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) pass(`Node.js ${process.version}`);
else fail(`Node.js ${process.version} is too old`, "Install Node.js 20 or newer.");

const binary = resolve(root, "bridge/native/wechat-ax");
try {
  accessSync(binary, constants.X_OK);
  pass("native bridge is installed and executable");
} catch {
  fail("native bridge is missing or not executable", "Run `npm run setup`.");
}

try {
  const mcp = execFileSync("codex", ["mcp", "get", "wechat-fastbridge"], { encoding: "utf8" });
  if (mcp.includes(resolve(root, "bridge/server.mjs"))) pass("Codex MCP entry points to this folder");
  else fail("Codex MCP entry points to a different folder", "Run `npm run setup` from this folder.");
} catch {
  fail("Codex MCP entry is missing", "Run `npm run setup`.");
}

const installedSkill = resolve(homedir(), ".codex/skills/wechat-computer-use/SKILL.md");
const sourceSkill = resolve(root, "skill/wechat-computer-use/SKILL.md");
if (!existsSync(installedSkill)) fail("Codex skill is missing", "Run `npm run setup`.");
else if (readFileSync(installedSkill, "utf8") === readFileSync(sourceSkill, "utf8")) pass("Codex skill is installed and current");
else fail("Codex skill is stale", "Run `npm run setup`, then restart Codex.");

if (process.platform === "darwin" && existsSync(binary)) {
  const wechatRunning = () => {
    try {
      return execFileSync("/usr/bin/osascript", ["-e", 'application id "com.tencent.xinWeChat" is running'], { encoding: "utf8" }).trim() === "true";
    } catch { return false; }
  };
  try {
    await new NativeBridge({ binary }).status();
    pass("Accessibility permission is enabled");
    pass("WeChat is running");
  } catch (error) {
    if (error?.error === "ACCESSIBILITY_PERMISSION_REQUIRED") {
      fail("Accessibility permission is off", "System Settings → Privacy & Security → Accessibility → enable Codex/ChatGPT/Terminal, then restart it.");
      if (wechatRunning()) pass("WeChat is running");
      else fail("WeChat is not running", "Open WeChat and sign in.");
    } else if (error?.error === "WECHAT_NOT_RUNNING") {
      pass("Accessibility permission is enabled");
      fail("WeChat is not running", "Open WeChat and sign in.");
    } else {
      fail("native status check failed", String(error.message || error));
      if (wechatRunning()) pass("WeChat is running");
    }
  }
}

if (failures) {
  console.log(`\n${failures} check(s) need attention. Nothing was sent.`);
  process.exitCode = 1;
} else {
  console.log("\nEverything is ready. Nothing was sent.");
}
