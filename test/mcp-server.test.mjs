import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server exposes the fast semantic WeChat tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wechat-mcp-"));
  const fake = join(dir, "wechat-ax");
  await writeFile(fake, `#!/bin/sh\nprintf '{"ok":true,"chat":"lab","messages":["Alice说:hi"],"signature":"abc123","latencyMs":35}\\n'\n`);
  await chmod(fake, 0o755);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("bridge/server.mjs")],
    env: { ...process.env, WECHAT_AX_BINARY: fake },
  });
  const client = new Client({ name: "wechat-fastbridge-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["wechat_inbox_wait", "wechat_read", "wechat_send", "wechat_send_media", "wechat_status", "wechat_wait"],
    );
    const schemaBytes = JSON.stringify(listed.tools).length;
    assert.ok(schemaBytes < 3_100, `tool schemas grew to ${schemaBytes} characters`);
    const result = await client.callTool({ name: "wechat_send", arguments: { chat: "lab", text: "hello" } });
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.roundTripMs, undefined);
    assert.equal(result.structuredContent.scanMs, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, chat: "lab", messageCount: 1, signature: "abc123" });
    assert.ok(JSON.stringify(result).length < 500);
    const inbox = await client.callTool({ name: "wechat_inbox_wait", arguments: { chats: ["lab"], timeoutMs: 0 } });
    assert.equal(inbox.structuredContent.ok, true);
    assert.equal(inbox.structuredContent.changed, false);
    assert.equal(inbox.structuredContent.signature, "abc123");
    assert.ok(Number.isFinite(inbox.structuredContent.ms));
  } finally {
    await transport.close();
  }
});
