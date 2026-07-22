import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultBinary = new URL("./native/wechat-ax", import.meta.url).pathname;
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeChat = (value) => String(value || "")
  .replace(/\s*[（(]\s*\d+\s*[)）]\s*$/u, "")
  .normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const editDistance = (left, right) => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
};
const chatNamesClose = (left, right) => {
  const a = normalizeChat(left); const b = normalizeChat(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shortest = Math.min(a.length, b.length);
  if (shortest < 3) return false;
  const allowed = shortest <= 5 ? 1 : shortest <= 10 ? 2 : Math.min(3, Math.max(2, Math.floor(shortest / 5)));
  return editDistance(a, b) <= allowed;
};

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
    this.inboxSnapshots = new Map();
  }

  async available() {
    try { await access(this.binary); return true; } catch { return false; }
  }

  async run(command, args = [], timeoutMs = this.timeoutMs) {
    const started = performance.now();
    try {
      const { stdout } = await execFileAsync(this.binary, [command, ...args], {
        timeout: timeoutMs,
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
  #inboxRaw({ chats, limit = 12 }) {
    const args = ["--limit", String(limit)];
    for (const chat of chats) args.push("--allow", chat);
    return this.run("inbox", args);
  }
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

  #inboxKey(chats) { return [...new Set(chats.map((chat) => normalizeChat(chat)).filter(Boolean))].sort().join("\n"); }

  #rememberInbox(key, result) {
    if (!result?.signature || !Array.isArray(result.chats)) return;
    const history = (this.inboxSnapshots.get(key)?.history ?? []).filter((item) => item.signature !== result.signature);
    history.push({ signature: result.signature, chats: result.chats.map((entry) => ({ ...entry })) });
    this.inboxSnapshots.delete(key);
    this.inboxSnapshots.set(key, { history: history.slice(-4) });
    while (this.inboxSnapshots.size > 8) this.inboxSnapshots.delete(this.inboxSnapshots.keys().next().value);
  }

  #projectInbox(key, result, after) {
    const projected = { ok: true, signature: result.signature, changed: false, events: [] };
    if (!after) {
      projected.baseline = true;
    } else if (result.signature === after) {
      projected.delta = true;
    } else {
      const previous = this.inboxSnapshots.get(key)?.history.find((item) => item.signature === after);
      projected.changed = true;
      if (previous) {
        const old = new Map(previous.chats.map((entry) => [normalizeChat(entry.chat), entry.signature]));
        projected.events = result.chats.filter((entry) => old.get(normalizeChat(entry.chat)) !== entry.signature);
        projected.delta = true;
      } else {
        projected.resynced = true;
        projected.delta = false;
      }
    }
    projected.eventCount = projected.events.length;
    this.#rememberInbox(key, result);
    return projected;
  }

  #isOwnInboxEvent(event) {
    const now = Date.now();
    for (const [chat, pending] of this.pendingSends) {
      if (now - (pending.at || 0) > 120_000) continue;
      if (chatNamesClose(chat, event.chat) && event.preview?.includes(pending.text)) return true;
    }
    return false;
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

  async inboxWait({ chats, after, limit = 12, timeoutMs = 30_000, intervalMs = 1_500 }) {
    const allowlist = [...new Set((chats || []).map((chat) => String(chat).trim()).filter(Boolean))].slice(0, 8);
    if (!allowlist.length) throw Object.assign(new Error("ALLOWLIST_REQUIRED"), { error: "ALLOWLIST_REQUIRED", detail: "Pass at least one monitored chat" });
    const key = this.#inboxKey(allowlist);
    const deadline = performance.now() + Math.max(0, Math.min(55_000, timeoutMs));
    let state = await this.#inboxRaw({ chats: allowlist, limit: Math.max(1, Math.min(20, limit)) });
    let baseline = after || state.signature;
    if (!after) this.#rememberInbox(key, state);
    while (true) {
      const projected = this.#projectInbox(key, state, baseline);
      const externalEvents = projected.events.filter((event) => !this.#isOwnInboxEvent(event));
      if (externalEvents.length) return { ...projected, changed: true, events: externalEvents, eventCount: externalEvents.length };
      if (state.signature !== baseline) baseline = state.signature;
      if (performance.now() >= deadline) return { ok: true, changed: false, signature: baseline };
      await this.delay(Math.max(500, Math.min(5_000, intervalMs)));
      state = await this.#inboxRaw({ chats: allowlist, limit: Math.max(1, Math.min(20, limit)) });
    }
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
        this.pendingSends.set(chat, { signature: result.signature, text, at: Date.now() });
        while (this.pendingSends.size > 8) this.pendingSends.delete(this.pendingSends.keys().next().value);
      }
      return result;
    } finally {
      if (previousBundle) await this.#restorePrevious(previousBundle);
    }
  }

  async sendMedia({ chat, kind, path, collection = "favorites", query, index = 1, limit = 8, autoSelect = true, allowFocus = true }) {
    if (!allowFocus) throw Object.assign(new Error("WECHAT_FOCUS_REQUIRED"), { error: "WECHAT_FOCUS_REQUIRED", detail: "Media sending needs a brief foreground interaction" });
    const started = performance.now();
    const previousBundle = await this.#frontBundle();
    let focusUsed = false;
    const args = ["--chat", chat, "--limit", String(limit)];
    const command = kind === "file" ? "send-file" : "send-sticker";
    if (kind === "file") args.push("--path", path);
    else {
      args.push("--collection", collection, "--index", String(index));
      if (query) args.push("--query", query);
    }
    const runMedia = () => this.run(command, args, Math.max(this.timeoutMs, 8_000));
    try {
      await this.#focusWeChat();
      focusUsed = true;
      let result;
      try { result = await runMedia(); } catch (error) {
        if (!autoSelect || error?.error !== "WECHAT_TARGET_MISMATCH") throw error;
        await this.#autoSelect(chat, { allowFocus: true, knownMismatch: true });
        result = await runMedia();
      }
      let state;
      const waits = kind === "file" ? [500, 900, 1_400] : (result.panelDismissed ? [200] : [250, 550, 900]);
      for (const waitMs of waits) {
        await this.delay(waitMs);
        state = await this.#readRaw({ chat, limit });
        if (state.signature && state.signature !== result.signature) break;
      }
      const signatureChanged = state?.signature && state.signature !== result.signature;
      if (!signatureChanged && !(kind === "sticker" && result.panelDismissed)) {
        throw Object.assign(new Error("WECHAT_MEDIA_NOT_CONFIRMED"), { error: "WECHAT_MEDIA_NOT_CONFIRMED", detail: "The conversation did not change; check whether WeChat sent the media before retrying" });
      }
      if (state?.signature) result.signature = state.signature;
      result.deliveryConfirmed = true;
      result.autoSelected = autoSelect;
      result.focusUsed = focusUsed;
      result.totalMs = Math.round((performance.now() - started) * 10) / 10;
      const marker = kind === "file" ? result.fileName : "[动画表情]";
      this.pendingSends.delete(chat);
      this.pendingSends.set(chat, { signature: state.signature, text: marker, at: Date.now() });
      return result;
    } finally {
      await this.#restorePrevious(previousBundle);
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
