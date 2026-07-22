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
  const searched = join(dir, "searched");
  await writeFile(binary, `#!/bin/sh
case "$1" in
  inspect-fast)
    if [ -f "${state}" ]; then
      printf '{"ok":true,"selectedMatched":true,"headerMatched":true,"inputs":[{"role":"AXTextArea"}]}\\n'
    else
      printf '{"ok":true,"selectedMatched":false,"headerMatched":false,"inputs":[]}\\n'
    fi ;;
  search)
    touch "${searched}"
    printf '{"ok":true,"searchAttempted":true}\\n' ;;
  select)
    if [ -f "${searched}" ]; then
      touch "${state}"
      printf '{"ok":true,"selectionAttempted":true}\\n'
    else
      printf '{"ok":false,"error":"WECHAT_CHAT_NOT_VISIBLE"}\\n' >&2
      exit 2
    fi ;;
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

test("non-macOS registry checks get an honest platform status without spawning the native bridge", async () => {
  const bridge = new NativeBridge({ platform: "linux", binary: "/missing/wechat-ax" });
  const result = await bridge.status();
  assert.equal(result.ok, false);
  assert.equal(result.error, "MACOS_REQUIRED");
  assert.match(result.detail, /requires macOS/);
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

test("media send confirms a changed chat and restores the previous app", async () => {
  const calls = [];
  const events = [];
  const bridge = new NativeBridge({
    delay: async () => {},
    system: {
      frontBundle: async () => "com.example.previous",
      focusWeChat: async () => events.push("focus"),
      restorePrevious: async (bundle) => events.push(`restore:${bundle}`),
    },
  });
  bridge.run = async (command, args) => {
    calls.push([command, args]);
    if (command === "send-sticker") return { ok: true, chat: "Jerry", mediaKind: "sticker", signature: "before" };
    if (command === "snapshot") return { ok: true, chat: "Jerry", messages: ["我说:[动画表情]"], signature: "after" };
    throw new Error(command);
  };
  const result = await bridge.sendMedia({ chat: "Jerry", kind: "sticker", collection: "favorites", index: 2 });
  assert.equal(result.deliveryConfirmed, true);
  assert.equal(result.signature, "after");
  assert.deepEqual(calls.map(([command]) => command), ["send-sticker", "snapshot"]);
  assert.deepEqual(events, ["focus", "restore:com.example.previous"]);
});

test("sticker geometry is discovered once and reused by later sends", async () => {
  const mediaArgs = [];
  let sent = 0;
  const bridge = new NativeBridge({
    delay: async () => {},
    system: { frontBundle: async () => "com.example.previous", focusWeChat: async () => {}, restorePrevious: async () => {} },
  });
  bridge.run = async (command, args) => {
    if (command === "send-sticker") {
      mediaArgs.push(args);
      sent += 1;
      return { ok: true, chat: "Jerry", mediaKind: "sticker", signature: `before-${sent}`, panelDismissed: true,
        panelDX: -241.5, tabDY: -53, tabStep: 52, panelWidth: 478 };
    }
    return { ok: true, chat: "Jerry", messages: ["我说:[动画表情]"], signature: `after-${sent}` };
  };
  await bridge.sendMedia({ chat: "Jerry", kind: "sticker", index: 1 });
  await bridge.sendMedia({ chat: "Jerry", kind: "sticker", index: 2 });
  assert.equal(mediaArgs[0].includes("--panel-dx"), false);
  assert.equal(mediaArgs[1].includes("--panel-dx"), true);
  assert.equal(mediaArgs[1][mediaArgs[1].indexOf("--tab-step") + 1], "52");
});

test("media send never reports success when the chat signature stays unchanged", async () => {
  const bridge = new NativeBridge({
    delay: async () => {},
    system: { frontBundle: async () => "com.example.previous", focusWeChat: async () => {}, restorePrevious: async () => {} },
  });
  bridge.run = async (command) => command === "send-file"
    ? { ok: true, chat: "Jerry", mediaKind: "file", signature: "same" }
    : { ok: true, chat: "Jerry", messages: [], signature: "same" };
  await assert.rejects(
    bridge.sendMedia({ chat: "Jerry", kind: "file", path: "/tmp/test.txt" }),
    (error) => error.error === "WECHAT_MEDIA_NOT_CONFIRMED",
  );
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

test("delta alignment does not retransmit formatting-only message variants", async () => {
  const states = [
    { ok: true, chat: "shop", messages: ["客服说：价格是 500 元", "我说：收到"], signature: "s1" },
    { ok: true, chat: "shop", messages: ["客服说:价格是 500 元", "我说:收到", "客户说:还能优惠吗"], signature: "s2" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  const baseline = await bridge.read({ chat: "shop", limit: 3 });
  const delta = await bridge.read({ chat: "shop", limit: 3, after: baseline.signature, context: 2 });
  assert.deepEqual(delta.messages, ["客户说:还能优惠吗"]);
  assert.equal(delta.returnedCount, 1);
  assert.equal(delta.delta, true);
});

test("smart context retrieves an older relevant fact plus recent continuity", async () => {
  const firstWindow = ["A说:项目预算上限是5000元", "B说:周五交付", "A说:今天下雨", "B说:收到", "A说:午饭吃什么", "B说:我去开会", "A说:好的", "B说:我晚点回复"];
  const states = [
    { ok: true, chat: "lab", messages: firstWindow, signature: "s1" },
    { ok: true, chat: "lab", messages: [...firstWindow.slice(1), "C说:预算还能增加吗"], signature: "s2" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  const baseline = await bridge.read({ chat: "lab", limit: 8 });
  const delta = await bridge.read({ chat: "lab", limit: 8, after: baseline.signature });
  assert.deepEqual(delta.messages, ["C说:预算还能增加吗"]);
  assert.ok(delta.context.includes("A说:项目预算上限是5000元"), JSON.stringify(delta.context));
  assert.ok(delta.context.includes("B说:我晚点回复"), JSON.stringify(delta.context));
  assert.ok(delta.context.length <= 3);
});

test("smart context connects Chinese synonyms without retransmitting full history", async () => {
  const firstWindow = ["客服说:这款价格是500元", "客服说:周五发货", "我说:先考虑", "客服说:没问题", "我说:谢谢", "客服说:不客气"];
  const states = [
    { ok: true, chat: "shop", messages: firstWindow, signature: "s1" },
    { ok: true, chat: "shop", messages: [...firstWindow.slice(1), "我说:这个多少钱，什么时候能到"], signature: "s2" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  const baseline = await bridge.read({ chat: "shop", limit: 6 });
  const delta = await bridge.read({ chat: "shop", limit: 6, after: baseline.signature, context: 3 });
  assert.deepEqual(delta.messages, ["我说:这个多少钱，什么时候能到"]);
  assert.ok(delta.context.includes("客服说:这款价格是500元"), JSON.stringify(delta.context));
  assert.ok(delta.context.includes("客服说:周五发货"), JSON.stringify(delta.context));
  assert.ok(JSON.stringify(delta.context).length < JSON.stringify(firstWindow).length);
});

test("semantic retrieval returns relevant evidence without unrelated quota padding", async () => {
  const firstWindow = [
    "客服说:商品价格是500元",
    "客服说:周五发货",
    "客服说:今天天气不错",
    "我说:好的",
    "客服说:继续等通知",
    "我说:收到",
  ];
  const states = [
    { ok: true, chat: "shop", messages: firstWindow, signature: "s1" },
    { ok: true, chat: "shop", messages: [...firstWindow.slice(1), "我说:这件商品多少钱"], signature: "s2" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  const baseline = await bridge.read({ chat: "shop", limit: 6 });
  const delta = await bridge.read({ chat: "shop", limit: 6, after: baseline.signature, context: 4 });
  assert.deepEqual(delta.messages, ["我说:这件商品多少钱"]);
  assert.deepEqual(delta.context, ["客服说:商品价格是500元", "我说:收到"]);
  assert.equal(delta.context.includes("客服说:今天天气不错"), false);
  assert.ok(JSON.stringify(delta.context).length * 2 < JSON.stringify(firstWindow).length);
});

test("sender identity remains searchable without treating labels as body relevance", async () => {
  const firstWindow = ["Alice说:最终报价是500元", "Bob说:明天发货", "我说:收到", "Bob说:稍后联系"];
  const states = [
    { ok: true, chat: "sales", messages: firstWindow, signature: "s1" },
    { ok: true, chat: "sales", messages: [...firstWindow.slice(1), "我说:Alice之前确认了什么"], signature: "s2" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  const baseline = await bridge.read({ chat: "sales", limit: 4 });
  const delta = await bridge.read({ chat: "sales", limit: 4, after: baseline.signature, context: 3 });
  assert.ok(delta.context.includes("Alice说:最终报价是500元"), JSON.stringify(delta.context));
  assert.equal(delta.context.includes("Bob说:明天发货"), false, JSON.stringify(delta.context));
});

test("durable fact capsules retain important evidence after the rolling window is evicted", async () => {
  const initial = ["客服说:项目预算最终确认是5000元", ...Array.from({ length: 7 }, (_, index) => `闲聊:${index}`)];
  const batches = Array.from({ length: 16 }, (_, batch) => Array.from({ length: 8 }, (_, index) => `普通消息:${batch}-${index}`));
  const states = [{ ok: true, chat: "long", messages: initial, signature: "s0" }];
  for (let index = 0; index < batches.length; index += 1) states.push({ ok: true, chat: "long", messages: batches[index], signature: `s${index + 1}` });
  const last = batches.at(-1);
  states.push({ ok: true, chat: "long", messages: [...last.slice(1), "客户说:之前确认的预算是多少"], signature: "query" });
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  let result = await bridge.read({ chat: "long", limit: 8 });
  for (let index = 0; index < batches.length; index += 1) result = await bridge.read({ chat: "long", limit: 8, after: result.signature });
  const delta = await bridge.read({ chat: "long", limit: 8, after: result.signature, context: 3 });
  assert.deepEqual(delta.messages, ["客户说:之前确认的预算是多少"]);
  assert.ok(delta.context.includes("客服说:项目预算最终确认是5000元"), JSON.stringify(delta.context));
  assert.ok(JSON.stringify(delta.context).length < 1_600);
});

test("smart context suppresses an older conflicting numeric fact when a newer update exists", async () => {
  const first = ["客服说:价格是500元", "客服说:今天改为450元", "我说:收到", "客服说:以新价格为准"];
  const states = [
    { ok: true, chat: "shop", messages: first, signature: "s1" },
    { ok: true, chat: "shop", messages: [...first.slice(1), "我说:现在价格是多少"], signature: "s2" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  const baseline = await bridge.read({ chat: "shop", limit: 4 });
  const delta = await bridge.read({ chat: "shop", limit: 4, after: baseline.signature, context: 4 });
  assert.ok(delta.context.includes("客服说:今天改为450元"), JSON.stringify(delta.context));
  assert.equal(delta.context.includes("客服说:价格是500元"), false, JSON.stringify(delta.context));
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
      throw Object.assign(new Error("WECHAT_SEARCH_RESULT_NOT_VISIBLE"), { error: "WECHAT_SEARCH_RESULT_NOT_VISIBLE" });
    }
    if (command === "inspect-fast") return { ok: true, selectedMatched: true, headerMatched: true, inputs: [{}] };
    if (command === "snapshot") return { ok: true, chat: "lab", messages: ["A:ready"], signature: "s1" };
    return { ok: true };
  };

  const result = await bridge.read({ chat: "lab" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["snapshot", "select", "search", "select", "inspect-fast", "snapshot"]);
  assert.deepEqual(events, ["focus", "restore:com.example.previous"]);
});

test("automatic selection confirms an inaccessible WeChat 4 search result, then verifies it", async () => {
  const calls = [];
  let verified = false;
  const bridge = new NativeBridge({
    delay: async () => {},
    system: {
      frontBundle: async () => "com.example.previous",
      focusWeChat: async () => {},
      restorePrevious: async () => {},
    },
  });
  bridge.run = async (command, args) => {
    calls.push([command, args]);
    if (command === "send" && !verified) {
      throw Object.assign(new Error("WECHAT_TARGET_MISMATCH"), { error: "WECHAT_TARGET_MISMATCH" });
    }
    if (command === "select") {
      throw Object.assign(new Error("WECHAT_CHAT_NOT_VISIBLE"), { error: "WECHAT_CHAT_NOT_VISIBLE" });
    }
    if (command === "search" && !args.includes("--no-confirm")) verified = true;
    if (command === "inspect-fast") return { ok: true, selectedMatched: verified, headerMatched: verified, inputs: verified ? [{}] : [] };
    return { ok: true, chat: "lab", inputCleared: true };
  };

  const result = await bridge.send({ chat: "傻比裙", text: "hello" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([command]) => command), ["send", "select", "search", "select", "search", "inspect-fast", "inspect-fast", "send"]);
  assert.equal(calls[4][1].includes("--no-confirm"), false);
});

test("read retries once when WeChat is still settling after verified selection", async () => {
  const calls = [];
  let snapshots = 0;
  const bridge = new NativeBridge({
    delay: async () => {},
    system: {
      frontBundle: async () => "com.example.previous",
      restorePrevious: async () => {},
    },
  });
  bridge.run = async (command) => {
    calls.push(command);
    if (command === "snapshot" && snapshots++ < 2) {
      throw Object.assign(new Error("WECHAT_TARGET_MISMATCH"), { error: "WECHAT_TARGET_MISMATCH" });
    }
    if (command === "inspect-fast") return { ok: true, selectedMatched: true, headerMatched: true, inputs: [{}] };
    if (command === "snapshot") return { ok: true, chat: "lab", messages: ["A:ready"], signature: "s1" };
    return { ok: true };
  };

  const result = await bridge.read({ chat: "lab" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["snapshot", "select", "inspect-fast", "snapshot", "snapshot"]);
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

test("inbox wait establishes a compact zero-event baseline", async () => {
  const bridge = new NativeBridge();
  bridge.run = async (command) => {
    assert.equal(command, "inbox");
    return { ok: true, chats: [{ chat: "Customer", preview: "hello", unread: 1, signature: "c1" }], signature: "i1" };
  };
  const result = await bridge.inboxWait({ chats: ["Customer"], timeoutMs: 0 });
  assert.equal(result.changed, false);
  assert.equal(result.signature, "i1");
  assert.ok(JSON.stringify(result).length < 80, JSON.stringify(result));
});

test("inbox wait returns only changed allowlisted chat events", async () => {
  const states = [
    { ok: true, chats: [
      { chat: "Customer A", preview: "old", unread: 0, signature: "a1" },
      { chat: "Customer B", preview: "same", unread: 0, signature: "b1" },
    ], signature: "i1" },
    { ok: true, chats: [
      { chat: "Customer A", preview: "new question", unread: 1, signature: "a2" },
      { chat: "Customer B", preview: "same", unread: 0, signature: "b1" },
    ], signature: "i2" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  const baseline = await bridge.inboxWait({ chats: ["Customer A", "Customer B"], timeoutMs: 0 });
  const changed = await bridge.inboxWait({ chats: ["Customer A", "Customer B"], after: baseline.signature, timeoutMs: 0 });
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.events.map((event) => event.chat), ["Customer A"]);
  assert.equal(changed.events[0].preview, "new question");
});

test("inbox wait ignores unread decreases caused by opening a chat", async () => {
  const states = [
    { ok: true, chats: [{ chat: "Customer", preview: "same", unread: 2, signature: "c1" }], signature: "i1" },
    { ok: true, chats: [{ chat: "Customer", preview: "same", unread: 0, signature: "c2" }], signature: "i2" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  const baseline = await bridge.inboxWait({ chats: ["Customer"], timeoutMs: 0 });
  const unchanged = await bridge.inboxWait({ chats: ["Customer"], after: baseline.signature, timeoutMs: 0 });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.events, undefined);
  assert.equal(unchanged.signature, "i2");
});

test("inbox wait detects a repeated preview when unread count increases", async () => {
  const states = [
    { ok: true, chats: [{ chat: "Customer", preview: "ok", unread: 0, signature: "c1" }], signature: "i1" },
    { ok: true, chats: [{ chat: "Customer", preview: "ok", unread: 1, signature: "c2" }], signature: "i2" },
  ];
  const bridge = new NativeBridge();
  bridge.run = async () => states.shift();
  const baseline = await bridge.inboxWait({ chats: ["Customer"], timeoutMs: 0 });
  const changed = await bridge.inboxWait({ chats: ["Customer"], after: baseline.signature, timeoutMs: 0 });
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.events.map((event) => event.preview), ["ok"]);
});

test("inbox wait suppresses own-send previews before surfacing a reply", async () => {
  const inboxStates = [
    { ok: true, chats: [{ chat: "Customer", preview: "before", unread: 0, signature: "c1" }], signature: "i1" },
    { ok: true, chats: [{ chat: "Customer", preview: "hello", unread: 0, signature: "c2" }], signature: "i2" },
    { ok: true, chats: [{ chat: "Customer", preview: "thanks", unread: 1, signature: "c3" }], signature: "i3" },
  ];
  const bridge = new NativeBridge({ delay: async () => {} });
  bridge.run = async (command) => {
    if (command === "send") return { ok: true, chat: "Customer", inputCleared: true, signature: "s1" };
    return inboxStates.shift();
  };
  await bridge.send({ chat: "Customer", text: "hello" });
  const baseline = await bridge.inboxWait({ chats: ["Customer"], timeoutMs: 0 });
  const changed = await bridge.inboxWait({ chats: ["Customer"], after: baseline.signature, timeoutMs: 1_000, intervalMs: 500 });
  assert.deepEqual(changed.events.map((event) => event.preview), ["thanks"]);
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
