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

async function selectedFakeBridge() {
  const dir = await mkdtemp(join(tmpdir(), "wechat-fastbridge-selected-"));
  const binary = join(dir, "wechat-ax");
  await writeFile(binary, `#!/bin/sh
if [ "$1" = "inspect-fast" ]; then
  printf '{"ok":true,"selectedMatched":true,"headerMatched":true,"inputs":[{"role":"AXTextArea"}]}\\n'
else
  printf '{"ok":true,"chat":"lab","messages":["Alice说:hi"],"inputCleared":true,"latencyMs":41.2}\\n'
fi
`);
  await chmod(binary, 0o755);
  return new NativeBridge({ binary, timeoutMs: 2_000 });
}

async function searchableFakeBridge() {
  const dir = await mkdtemp(join(tmpdir(), "wechat-fastbridge-search-"));
  const binary = join(dir, "wechat-ax");
  const state = join(dir, "selected");
  await writeFile(binary, `#!/bin/sh
case "$1" in
  inspect-fast)
    if [ -f "${state}" ]; then
      printf '{"ok":true,"selectedMatched":true,"headerMatched":true,"inputs":[{"role":"AXTextArea"}]}\\n'
    else
      printf '{"ok":true,"selectedMatched":false,"headerMatched":false,"inputs":[]}\\n'
    fi ;;
  search)
    printf '{"ok":true,"searchAttempted":true}\\n' ;;
  select)
    touch "${state}"
    printf '{"ok":true,"selectionAttempted":true}\\n' ;;
  send)
    printf '{"ok":true,"chat":"Jerry","inputCleared":true,"sentChars":5}\\n' ;;
esac
`);
  await chmod(binary, 0o755);
  const events = [];
  return {
    events,
    bridge: new NativeBridge({
      binary,
      timeoutMs: 2_000,
      delay: async () => {},
      system: {
        frontBundle: async () => "com.example.previous",
        focusWeChat: async () => events.push("focus"),
        restorePrevious: async (bundle) => events.push(`restore:${bundle}`),
      },
    }),
  };
}

test("native bridge round trip remains below the 2 second hot-path budget", async () => {
  const bridge = await fakeBridge();
  const result = await bridge.send({ chat: "lab", text: "hello", autoSelect: false, allowFocus: false });
  assert.equal(result.ok, true);
  assert.ok(result.roundTripMs < 2_000, JSON.stringify(result));
});

test("native bridge returns compact semantic messages", async () => {
  const bridge = await fakeBridge();
  const result = await bridge.read({ chat: "lab", limit: 4, autoSelect: false, allowFocus: false });
  assert.deepEqual(result.messages, ["Alice说:hi"]);
  assert.ok(JSON.stringify(result).length < 500);
});

test("auto-select fast path verifies the exact chat without focusing another app", async () => {
  const bridge = await selectedFakeBridge();
  const result = await bridge.send({ chat: "lab", text: "hello", autoSelect: true, allowFocus: false });
  assert.equal(result.ok, true);
  assert.equal(result.autoSelected, true);
  assert.equal(result.focusUsed, false);
  assert.equal(result.inputCleared, true);
});

test("automatic search selects the exact chat and restores the previous app", async () => {
  const { bridge, events } = await searchableFakeBridge();
  const result = await bridge.send({ chat: "Jerry", text: "hello", autoSelect: true, allowFocus: true });
  assert.equal(result.ok, true);
  assert.equal(result.focusUsed, true);
  assert.deepEqual(events, ["focus", "restore:com.example.previous"]);
});
