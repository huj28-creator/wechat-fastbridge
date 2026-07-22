import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultBinary = new URL("./native/wechat-ax", import.meta.url).pathname;

export class NativeBridge {
  constructor({
    binary = process.env.WECHAT_AX_BINARY || defaultBinary,
    timeoutMs = 5_000,
  } = {}) {
    this.binary = binary;
    this.timeoutMs = timeoutMs;
  }

  async available() {
    try { await access(this.binary); return true; } catch { return false; }
  }

  async run(command, args = []) {
    const started = performance.now();
    try {
      const { stdout } = await execFileAsync(this.binary, [command, ...args], {
        timeout: this.timeoutMs,
        maxBuffer: 256 * 1024,
      });
      const result = JSON.parse(stdout.trim());
      result.roundTripMs = Math.round((performance.now() - started) * 10) / 10;
      return result;
    } catch (error) {
      const raw = String(error.stderr || "").trim();
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        try {
          const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
          if (parsed && parsed.ok === false && parsed.error) {
            throw Object.assign(new Error(parsed.error), parsed);
          }
        } catch (parseError) {
          if (parseError?.error) throw parseError;
        }
      }
      throw new Error(raw || error.message);
    }
  }

  status() { return this.run("status"); }
  read({ chat, limit = 8 }) { return this.run("snapshot", ["--chat", chat, "--limit", String(limit)]); }
  send({ chat, text, limit = 8 }) { return this.run("send", ["--chat", chat, "--text", text, "--limit", String(limit)]); }

  async wait({ chat, after, limit = 8, timeoutMs = 30_000, intervalMs = 1_000 }) {
    const deadline = performance.now() + Math.max(0, Math.min(55_000, timeoutMs));
    const baseline = after || (await this.read({ chat, limit })).signature;
    let state = await this.read({ chat, limit });
    while (state.signature === baseline && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(250, Math.min(5_000, intervalMs))));
      state = await this.read({ chat, limit });
    }
    return { changed: state.signature !== baseline, ...state };
  }
}
