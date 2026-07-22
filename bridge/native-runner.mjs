import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultBinary = new URL("./native/wechat-ax", import.meta.url).pathname;
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    this.snapshots = new Map();
    this.pendingSends = new Map();
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
    try {
      await this.run("activate");
      return;
    } catch {}
    await execFileAsync("/usr/bin/open", ["-b", "com.tencent.xinWeChat"]);
    await this.delay(320);
    if (await this.#frontBundle() !== "com.tencent.xinWeChat") {
      throw Object.assign(new Error("WECHAT_FOCUS_FAILED"), { error: "WECHAT_FOCUS_FAILED", detail: "macOS did not bring WeChat to the foreground" });
    }
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

  async #autoSelect(chat, { allowFocus, knownMismatch = false }) {
    if (!knownMismatch && await this.#verifyFast(chat)) return { selected: true, focusUsed: false };
    // Prefer a visible normalized/fuzzy sidebar match. This handles a small typo
    // without asking WeChat's literal search box to understand the typo, and it
    // avoids foreground focus when Accessibility can press the row directly.
    try {
      await this.run("select", ["--chat", chat]);
      await this.delay(120);
      if (await this.#verifyFast(chat)) return { selected: true, focusUsed: false };
    } catch (error) {
      if (error?.error !== "WECHAT_CHAT_NOT_VISIBLE" && error?.error !== "WECHAT_SEARCH_RESULT_NOT_VISIBLE") throw error;
    }
    if (!allowFocus) throw Object.assign(new Error("WECHAT_FOCUS_REQUIRED"), { error: "WECHAT_FOCUS_REQUIRED", detail: `Cannot open ${chat} fully in the background` });
    const searchArgs = ["--chat", chat, "--global-keys", "--no-confirm"];
    if (this.system.focusWeChat) await this.#focusWeChat();
    else searchArgs.push("--activate");
    await this.run("search", searchArgs);
    let selected = false;
    let rowUnavailable = false;
    for (const waitMs of [160, 240, 360, 800]) {
      await this.delay(waitMs);
      try {
        await this.run("select", ["--chat", chat, "--global-click"]);
        selected = true;
        break;
      } catch (error) {
        if (error?.error === "WECHAT_CHAT_NOT_VISIBLE") {
          rowUnavailable = true;
          break;
        }
        if (error?.error !== "WECHAT_SEARCH_RESULT_NOT_VISIBLE") throw error;
      }
    }
    // WeChat 4.x sometimes renders search results outside the accessibility row
    // tree. Confirm the top result, then accept it only if the current-chat header
    // passes the native normalized/fuzzy verifier. No message is written here.
    if (!selected && rowUnavailable) {
      const confirmArgs = ["--chat", chat, "--global-keys"];
      if (!this.system.focusWeChat) confirmArgs.push("--activate");
      await this.run("search", confirmArgs);
      await this.delay(300);
      selected = await this.#verifyFast(chat);
    }
    if (!selected) throw Object.assign(new Error("WECHAT_AUTO_SELECT_FAILED"), { error: "WECHAT_AUTO_SELECT_FAILED", detail: chat });
    await this.delay(240);
    if (!(await this.#verifyFast(chat))) throw Object.assign(new Error("WECHAT_AUTO_SELECT_FAILED"), { error: "WECHAT_AUTO_SELECT_FAILED", detail: chat });
    return { selected: true, focusUsed: true };
  }

  async selectChat({ chat, allowFocus = true, knownMismatch = false }) {
    const started = performance.now();
    const previousBundle = await this.#frontBundle();
    let selection = { selected: false, focusUsed: false };
    try {
      selection = await this.#autoSelect(chat, { allowFocus, knownMismatch });
      return { ...selection, chat, totalMs: Math.round((performance.now() - started) * 10) / 10 };
    } finally {
      await this.#restorePrevious(previousBundle);
    }
  }

  #remember(result, limit) {
    if (!result?.chat || !result?.signature || !Array.isArray(result.messages)) return;
    const existing = this.snapshots.get(result.chat)?.history ?? [];
    const history = existing.filter((item) => item.signature !== result.signature || item.limit !== limit);
    history.push({ signature: result.signature, limit, messages: [...result.messages] });
    this.snapshots.delete(result.chat);
    this.snapshots.set(result.chat, { history: history.slice(-4) });
    while (this.snapshots.size > 8) this.snapshots.delete(this.snapshots.keys().next().value);
  }

  #projectDelta(result, { after, context = 2, limit } = {}) {
    const fullMessages = Array.isArray(result.messages) ? result.messages : [];
    const previous = this.snapshots.get(result.chat)?.history.find((item) => item.signature === after && item.limit === limit);
    const projected = { ...result };
    if (after) {
      projected.changed = result.signature !== after;
      projected.fullCount = fullMessages.length;
      if (!projected.changed) {
        projected.messages = [];
        projected.context = [];
        projected.delta = true;
      } else if (previous?.signature === after) {
        let overlap = Math.min(previous.messages.length, fullMessages.length);
        while (overlap > 0 && previous.messages.slice(-overlap).join("\n") !== fullMessages.slice(0, overlap).join("\n")) overlap -= 1;
        projected.messages = fullMessages.slice(overlap);
        projected.context = previous.messages.slice(-Math.max(0, Math.min(4, context)));
        projected.delta = true;
      } else {
        projected.delta = false;
      }
      projected.returnedCount = projected.messages.length;
    }
    this.#remember(result, limit);
    return projected;
  }

  async #readExact({ chat, limit, autoSelect, allowFocus }) {
    let selection = null;
    let result;
    try {
      result = await this.#readRaw({ chat, limit });
    } catch (error) {
      if (!autoSelect || error?.error !== "WECHAT_TARGET_MISMATCH") throw error;
      selection = await this.selectChat({ chat, allowFocus, knownMismatch: true });
      try {
        result = await this.#readRaw({ chat, limit });
      } catch (retryError) {
        if (retryError?.error !== "WECHAT_TARGET_MISMATCH") throw retryError;
        await this.delay(300);
        result = await this.#readRaw({ chat, limit });
      }
    }
    if (autoSelect) {
      result.autoSelected = true;
      result.focusUsed = selection?.focusUsed ?? false;
      if (selection) result.selectionMs = selection.totalMs;
    }
    return result;
  }

  async read({ chat, limit = 8, autoSelect = true, allowFocus = true, after, context = 2 }) {
    const result = await this.#readExact({ chat, limit, autoSelect, allowFocus });
    return this.#projectDelta(result, { after, context, limit });
  }

  async send({ chat, text, limit = 8, autoSelect = true, allowFocus = true }) {
    const totalStarted = performance.now();
    let previousBundle = "";
    let focusUsed = false;
    const ensureFocus = async () => {
      if (!previousBundle) previousBundle = await this.#frontBundle();
      if (!focusUsed) await this.#focusWeChat();
      focusUsed = true;
    };
    const runSend = () => this.run("send", ["--chat", chat, "--text", text, "--limit", String(limit)]);
    try {
      let result;
      try {
        result = await runSend();
      } catch (error) {
        if (autoSelect && error?.error === "WECHAT_TARGET_MISMATCH") {
          if (!previousBundle) previousBundle = await this.#frontBundle();
          const selection = await this.#autoSelect(chat, { allowFocus, knownMismatch: true });
          focusUsed = selection.focusUsed;
          try { result = await runSend(); } catch (retryError) {
            if (retryError?.error === "WECHAT_TARGET_MISMATCH") {
              await this.delay(300);
              try { result = await runSend(); } catch (settledError) { error = settledError; }
            } else error = retryError;
          }
        }
        if (!result) {
          if (!allowFocus || error?.error !== "WECHAT_SEND_SHORTCUT_UNKNOWN") throw error;
          await ensureFocus();
          result = await runSend();
        }
      }
      result.autoSelected = autoSelect;
      result.focusUsed = focusUsed;
      result.totalMs = Math.round((performance.now() - totalStarted) * 10) / 10;
      if (result.signature) {
        this.pendingSends.delete(chat);
        this.pendingSends.set(chat, { signature: result.signature, text });
        while (this.pendingSends.size > 8) this.pendingSends.delete(this.pendingSends.keys().next().value);
      }
      return result;
    } finally {
      if (previousBundle) await this.#restorePrevious(previousBundle);
    }
  }

  async wait({ chat, after, limit = 8, timeoutMs = 30_000, intervalMs = 1_000, context = 2 }) {
    const deadline = performance.now() + Math.max(0, Math.min(55_000, timeoutMs));
    let state = await this.#readExact({ chat, limit, autoSelect: true, allowFocus: true });
    let baseline = after || state.signature;
    const focusUsed = state.focusUsed ?? false;
    let pending = after && this.pendingSends.get(chat)?.signature === after ? this.pendingSends.get(chat) : null;
    this.#remember(state, limit);
    while (true) {
      if (state.signature !== baseline) {
        if (!pending) break;
        const ownIndex = state.messages.findLastIndex((message) =>
          message.includes(`我说:${pending.text}`) || message.includes(`我说：${pending.text}`) ||
          new RegExp(`^(?:Me|You)\\s*:\\s*${escapeRegex(pending.text)}$`, "i").test(message),
        );
        if (ownIndex < 0) {
          this.pendingSends.delete(chat);
          pending = null;
          break;
        }
        this.pendingSends.delete(chat);
        pending = null;
        const repliesAfterOwn = state.messages.slice(ownIndex + 1);
        if (repliesAfterOwn.length) {
          const boundedContext = Math.max(0, Math.min(4, context));
          const ownContext = state.messages.slice(Math.max(0, ownIndex - boundedContext + 1), ownIndex + 1);
          this.#remember(state, limit);
          return {
            ...state,
            autoSelected: true,
            focusUsed,
            changed: true,
            delta: true,
            context: ownContext,
            messages: repliesAfterOwn,
            fullCount: state.messages.length,
            returnedCount: repliesAfterOwn.length,
          };
        }
        baseline = state.signature;
        this.#remember(state, limit);
      }
      if (performance.now() >= deadline) break;
      await this.delay(Math.max(250, Math.min(5_000, intervalMs)));
      state = await this.#readRaw({ chat, limit });
    }
    const projected = this.#projectDelta(state, { after: baseline, context, limit });
    return { autoSelected: true, focusUsed, ...projected };
  }
}
