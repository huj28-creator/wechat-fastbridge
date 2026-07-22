import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const skillDir = new URL("../skill/wechat-computer-use/", import.meta.url);

test("skill package has concise valid discovery metadata", async () => {
  const markdown = await readFile(new URL("SKILL.md", skillDir), "utf8");
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");
  const keys = match[1].split("\n").filter(Boolean).map((line) => line.split(":", 1)[0]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(match[1], /^name: wechat-computer-use$/m);
  assert.ok(markdown.split("\n").length < 150, "keep the triggered skill compact");
  assert.ok(Buffer.byteLength(markdown) < 5_000, "keep skill instructions token-light");

  const interfaceYaml = await readFile(new URL("agents/openai.yaml", skillDir), "utf8");
  assert.match(interfaceYaml, /display_name: "WeChat FastBridge"/);
  assert.match(interfaceYaml, /default_prompt: "Use \$wechat-computer-use /);

  const files = await readdir(skillDir);
  assert.ok(!files.includes("README.md"), "user documentation belongs at repository level");
});
