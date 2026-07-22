import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultBinary = new URL("./native/wechat-ax", import.meta.url).pathname;

export class NativeBridge {
  constructor({
    binary = process.env.WECHAT_AX_BINARY || defaultBinary,
    timeoutMs = 5_000,
    system = {},
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.system = system;
    this.delay = delay;
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
  select({ chat }) { return this.run("select", ["--chat", chat]); }
  #readRaw({ chat, limit = 8 }) { return this.run("snapshot", ["--chat", chat, "--limit", String(limit)]); }
  async #frontBundle() {
    if (this.system.frontBundle) return this.system.frontBundle();
    try {
      const { stdout } = await execFileAsync("/usr/bin/osascript", [
        "-e",
        'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
      ]);
      return stdout.trim();
    } catch { return ""; }
  }

  async #focusWeChat() {
    if (this.system.focusWeChat) return this.system.focusWeChat();
    await execFileAsync("/usr/bin/open", ["-b", "com.tencent.xinWeChat"]);
    await this.delay(320);
  }

  async #restorePrevious(previousBundle) {
    if (this.system.restorePrevious) return this.system.restorePrevious(previousBundle);
    if (!previousBundle || previousBundle === "com.tencent.xinWeChat") return;
    if (await this.#frontBundle() !== "com.tencent.xinWeChat") return;
    try { await execFileAsync("/usr/bin/open", ["-b", previousBundle]); } catch {}
  }

  async #verifyFast(chat) {
    const state = await this.run("inspect-fast", ["--chat", chat]);
    return Boolean(state.selectedMatched && state.headerMatched && state.inputs?.length);
  }

  async #autoSelect(chat, { allowFocus }) {
    if (await this.#verifyFast(chat)) return { selected: true, focusUsed: false };
    if (!allowFocus) throw Object.assign(new Error("WECHAT_FOCUS_REQUIRED"), { error: "WECHAT_FOCUS_REQUIRED", detail: `Cannot open ${chat} fully in the background` });
    await this.#focusWeChat();
    await this.run("search", ["--chat", chat, "--global-keys", "--no-confirm"]);
    await this.delay(160);
    await this.run("select", ["--chat", chat, "--global-click"]);
    await this.delay(240);
    if (!(await this.#verifyFast(chat))) throw Object.assign(new Error("WECHAT_AUTO_SELECT_FAILED"), { error: "WECHAT_AUTO_SELECT_FAILED", detail: chat });
    return { selected: true, focusUsed: true };
  }

  async selectChat({ chat, allowFocus = true }) {
    const started = performance.now();
    const previousBundle = await this.#frontBundle();
    let selection = { selected: false, focusUsed: false };
    try {
      selection = await this.#autoSelect(chat, { allowFocus });
      return { ...selection, chat, totalMs: Math.round((performance.now() - started) * 10) / 10 };
    } finally {
      await this.#restorePrevious(previousBundle);
    }
  }

  async read({ chat, limit = 8, autoSelect = true, allowFocus = true }) {
    const selection = autoSelect ? await this.selectChat({ chat, allowFocus }) : null;
    const result = await this.#readRaw({ chat, limit });
    if (selection) {
      result.autoSelected = true;
      result.focusUsed = selection.focusUsed;
      result.selectionMs = selection.totalMs;
    }
    return result;
  }

  async send({ chat, text, limit = 8, autoSelect = true, allowFocus = true }) {
    const totalStarted = performance.now();
    const previousBundle = await this.#frontBundle();
    let focusUsed = false;
    try {
      if (autoSelect) {
        const selection = await this.#autoSelect(chat, { allowFocus });
        focusUsed = selection.focusUsed;
      }
      let result;
      try {
        result = await this.run("send", ["--chat", chat, "--text", text, "--limit", String(limit)]);
      } catch (error) {
        if (!allowFocus || error?.error !== "WECHAT_SEND_SHORTCUT_UNKNOWN") throw error;
        if (!focusUsed) await this.#focusWeChat();
        focusUsed = true;
        result = await this.run("send", ["--chat", chat, "--text", text, "--limit", String(limit)]);
      }
      result.autoSelected = autoSelect;
      result.focusUsed = focusUsed;
      result.totalMs = Math.round((performance.now() - totalStarted) * 10) / 10;
      return result;
    } finally {
      await this.#restorePrevious(previousBundle);
    }
  }

  async wait({ chat, after, limit = 8, timeoutMs = 30_000, intervalMs = 1_000 }) {
    const deadline = performance.now() + Math.max(0, Math.min(55_000, timeoutMs));
    const selection = await this.selectChat({ chat, allowFocus: true });
    const baseline = after || (await this.#readRaw({ chat, limit })).signature;
    let state = await this.#readRaw({ chat, limit });
    while (state.signature === baseline && performance.now() < deadline) {
      await this.delay(Math.max(250, Math.min(5_000, intervalMs)));
      state = await this.#readRaw({ chat, limit });
    }
    return { changed: state.signature !== baseline, autoSelected: true, focusUsed: selection.focusUsed, ...state };
  }
}
