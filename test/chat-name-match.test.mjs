import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const binary = new URL("../bridge/native/wechat-ax", import.meta.url).pathname;

async function matches(chat, candidate) {
  const { stdout } = await execFileAsync(binary, ["match-name", "--chat", chat, "--candidate", candidate]);
  return JSON.parse(stdout);
}

async function parseInbox(...values) {
  const args = values.flatMap((value) => ["--value", value]);
  const { stdout } = await execFileAsync(binary, ["parse-inbox", ...args]);
  return JSON.parse(stdout);
}

test("chat matcher ignores group member counts and formatting", { skip: process.platform !== "darwin" }, async () => {
  assert.equal((await matches("傻逼裙", "傻逼裙(3)")).matched, true);
  assert.equal((await matches("Project Lab", "project-lab（12）")).matched, true);
});

test("chat matcher tolerates small typos but rejects unsafe short or distant names", { skip: process.platform !== "darwin" }, async () => {
  assert.equal((await matches("傻比裙", "傻逼裙(3)")).matched, true);
  assert.equal((await matches("Jery", "Jerry")).matched, true);
  assert.equal((await matches("AB", "AC")).matched, false);
  assert.equal((await matches("Project Alpha", "Project Omega")).matched, false);
});

test("inbox parser preserves commas inside an English message preview", { skip: process.platform !== "darwin" }, async () => {
  const entry = await parseInbox("Customer, hello, world");
  assert.equal(entry.chat, "Customer");
  assert.equal(entry.preview, "hello, world");
});
