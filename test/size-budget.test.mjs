import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

async function directoryBytes(root) {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return bytes;
}

test("runtime source and universal native bridge stay below 256 KiB", async () => {
  const bytes = await Promise.all(["bridge", "skill", "scripts"].map(directoryBytes));
  const total = bytes.reduce((sum, value) => sum + value, 0);
  assert.ok(total < 256 * 1024, `runtime footprint grew to ${(total / 1024).toFixed(1)} KiB`);
});

test("runtime keeps its two-dependency ceiling", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(Object.keys(manifest.dependencies ?? {}).length <= 2, JSON.stringify(manifest.dependencies));
});
