import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeBridge } from "../bridge/native-runner.mjs";

async function fakeBridge() {
  const dir = await mkdtemp(join(tmpdir(), "wechat-fastbridge-"));
  const binary = join(dir, "wechat-ax");
  await writeFile(binary, `#!/bin/sh\nprintf '{"ok":true,"chat":"lab","messages":["Alice说:hi"],"latencyMs":41.2}\\n'\n`);
  await chmod(binary, 0o755);
  return new NativeBridge({ binary, timeoutMs: 2_000 });
}

test("native bridge round trip remains below the 2 second hot-path budget", async () => {
  const bridge = await fakeBridge();
  const result = await bridge.send({ chat: "lab", text: "hello" });
  assert.equal(result.ok, true);
  assert.ok(result.roundTripMs < 2_000, JSON.stringify(result));
});

test("native bridge returns compact semantic messages", async () => {
  const bridge = await fakeBridge();
  const result = await bridge.read({ chat: "lab", limit: 4 });
  assert.deepEqual(result.messages, ["Alice说:hi"]);
  assert.ok(JSON.stringify(result).length < 500);
});
