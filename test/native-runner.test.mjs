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
    if [ -f "${state}" ]; then
      printf '{"ok":true,"chat":"Jerry","inputCleared":true,"sentChars":5}\\n'
    else
      printf '{"ok":false,"error":"WECHAT_TARGET_MISMATCH","detail":"Jerry"}\\n' >&2
      exit 2
    fi ;;
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

test("selected-chat send uses one optimistic native call", async () => {
  const calls = [];
  const bridge = new NativeBridge();
  bridge.run = async (command) => {
    calls.push(command);
    return { ok: true, chat: "lab", inputCleared: true, signature: "s1" };
  };
  const result = await bridge.send({ chat: "lab", text: "hello" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["send"]);
});

test("selected-chat read uses one native call and returns cached deltas with context", async () => {
  const calls = [];
  const states = [
    { ok: true, chat: "lab", messages: ["A:one", "B:two", "A:three"], signature: "s1" },
    { ok: true, chat: "lab", messages: ["B:two", "A:three", "B:four"], signature: "s2" },
    { ok: true, chat: "lab", messages: ["B:two", "A:three", "B:four"], signature: "s2" },
    { ok: true, chat: "lab", messages: ["A:three", "B:four"], signature: "s3" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async (command) => {
    calls.push(command);
    return states.shift();
  };

  const first = await bridge.read({ chat: "lab", limit: 3 });
  const changed = await bridge.read({ chat: "lab", limit: 3, after: first.signature, context: 2 });
  const unchanged = await bridge.read({ chat: "lab", limit: 3, after: changed.signature, context: 2 });
  const differentLimit = await bridge.read({ chat: "lab", limit: 2, after: changed.signature, context: 2 });

  assert.deepEqual(calls, ["snapshot", "snapshot", "snapshot", "snapshot"]);
  assert.deepEqual(changed.context, ["B:two", "A:three"]);
  assert.deepEqual(changed.messages, ["B:four"]);
  assert.equal(changed.delta, true);
  assert.deepEqual(unchanged.messages, []);
  assert.equal(unchanged.changed, false);
  assert.deepEqual(differentLimit.messages, ["A:three", "B:four"]);
  assert.equal(differentLimit.delta, false);
});

test("wait reads its baseline once and returns only the reply delta", async () => {
  const calls = [];
  const states = [
    { ok: true, chat: "lab", messages: ["A:one", "B:two"], signature: "s1" },
    { ok: true, chat: "lab", messages: ["A:one", "B:two", "A:reply"], signature: "s2" },
  ];
  const bridge = new NativeBridge({ delay: async () => {} });
  bridge.run = async (command) => {
    calls.push(command);
    return states.shift();
  };

  const result = await bridge.wait({ chat: "lab", limit: 4, timeoutMs: 1_000, context: 1 });
  assert.deepEqual(calls, ["snapshot", "snapshot"]);
  assert.deepEqual(result.context, ["B:two"]);
  assert.deepEqual(result.messages, ["A:reply"]);
  assert.equal(result.changed, true);
});

test("automatic selection tolerates a briefly missing search result", async () => {
  const calls = [];
  const events = [];
  let selectAttempts = 0;
  let snapshotAttempts = 0;
  const bridge = new NativeBridge({
    delay: async () => {},
    system: {
      frontBundle: async () => "com.example.previous",
      focusWeChat: async () => events.push("focus"),
      restorePrevious: async (bundle) => events.push(`restore:${bundle}`),
    },
  });
  bridge.run = async (command) => {
    calls.push(command);
    if (command === "snapshot" && snapshotAttempts++ === 0) {
      throw Object.assign(new Error("WECHAT_TARGET_MISMATCH"), { error: "WECHAT_TARGET_MISMATCH" });
    }
    if (command === "select" && selectAttempts++ === 0) {
      throw Object.assign(new Error("WECHAT_CHAT_NOT_VISIBLE"), { error: "WECHAT_CHAT_NOT_VISIBLE" });
    }
    if (command === "inspect-fast") return { ok: true, selectedMatched: true, headerMatched: true, inputs: [{}] };
    if (command === "snapshot") return { ok: true, chat: "lab", messages: ["A:ready"], signature: "s1" };
    return { ok: true };
  };

  const result = await bridge.read({ chat: "lab" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["snapshot", "search", "select", "select", "inspect-fast", "snapshot"]);
  assert.deepEqual(events, ["focus", "restore:com.example.previous"]);
});

test("wait suppresses the just-sent message and returns the actual reply", async () => {
  const calls = [];
  const snapshots = [
    { ok: true, chat: "lab", messages: ["A:before", "我说:hello"], signature: "s2" },
    { ok: true, chat: "lab", messages: ["A:before", "我说:hello", "A:reply"], signature: "s3" },
  ];
  const bridge = new NativeBridge({ delay: async () => {} });
  bridge.run = async (command) => {
    calls.push(command);
    if (command === "send") return { ok: true, chat: "lab", inputCleared: true, signature: "s1" };
    return snapshots.shift();
  };

  const sent = await bridge.send({ chat: "lab", text: "hello" });
  const result = await bridge.wait({ chat: "lab", after: sent.signature, limit: 4, timeoutMs: 1_000, context: 1 });
  assert.deepEqual(calls, ["send", "snapshot", "snapshot"]);
  assert.deepEqual(result.context, ["我说:hello"]);
  assert.deepEqual(result.messages, ["A:reply"]);
  assert.equal(result.changed, true);
});

test("one-message delta is materially smaller than an eight-message read", async () => {
  const messages = Array.from({ length: 9 }, (_, index) => `${index}:${"context".repeat(10)}`);
  const states = [
    { ok: true, chat: "lab", messages: messages.slice(0, 8), signature: "s1" },
    { ok: true, chat: "lab", messages: messages.slice(1, 9), signature: "s2" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  const full = await bridge.read({ chat: "lab", limit: 8 });
  const delta = await bridge.read({ chat: "lab", limit: 8, after: full.signature, context: 2 });
  assert.ok(JSON.stringify(delta).length < JSON.stringify(full).length * 0.65);
});
