import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compactWechatTree, createWechatController } from "../skill/wechat-computer-use/scripts/wechat_compact.mjs";

const fixtureUrl = new URL("./fixtures/wechat-tree.txt", import.meta.url);

test("compacts a WeChat tree and saves at least 80%", async () => {
  const raw = await readFile(fixtureUrl, "utf8");
  const state = compactWechatTree(raw, { targetChat: "lab之最抽象组合", limit: 2 });
  assert.equal(state.ok, true);
  assert.equal(state.inputIndex, 170);
  assert.deepEqual(state.messages, ["我说:对啊", "Blue:发送了一个表情"]);
  assert.ok(state.stats.savingsPercent >= 80, JSON.stringify(state.stats));
  assert.ok(state.stats.compactChars < 2_000);
});

test("rejects the wrong chat", async () => {
  const raw = await readFile(fixtureUrl, "utf8");
  const calls = [];
  const sky = {
    async get_app_state() { return { text: raw }; },
    async set_value(args) { calls.push(["set", args]); },
    async press_key(args) { calls.push(["key", args]); },
  };
  const wx = createWechatController({ sky });
  await assert.rejects(() => wx.send({ targetChat: "wrong-chat", text: "hello" }), /WECHAT_TARGET_MISMATCH/);
  assert.deepEqual(calls, []);
});

test("sends only after exact target verification", async () => {
  const raw = await readFile(fixtureUrl, "utf8");
  const delivered = `${raw}\n  172 row (selectable)\n    173 单元格\n      174 单元格 我说:hello, ID: MMTextMessageCellView`;
  const calls = [];
  let reads = 0;
  const sky = {
    async get_app_state() { reads += 1; return { text: reads === 1 ? raw : delivered }; },
    async set_value(args) { calls.push(["set", args]); },
    async press_key(args) { calls.push(["key", args]); },
  };
  const wx = createWechatController({ sky });
  const result = await wx.send({ targetChat: "lab之最抽象组合", text: "hello" });
  assert.equal(result.ok, true);
  assert.equal(calls[0][1].element_index, 170);
  assert.equal(calls[0][1].value, "hello");
  assert.equal(calls[1][1].key, "Return");
});
