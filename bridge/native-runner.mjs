import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultBinary = new URL("./native/wechat-ax", import.meta.url).pathname;
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const semanticConcepts = [
  ["@money", /价格|价钱|费用|预算|报价|金额|付款|支付|退款|多少钱|贵|便宜|price|cost|budget|quote|pay|refund/iu],
  ["@time", /时间|日期|几号|几点|何时|什么时候|今天|明天|周[一二三四五六日天]|星期|截止|多久|time|date|when|today|tomorrow|deadline/iu],
  ["@delivery", /发货|到货|送达|快递|物流|配送|交付|shipping|ship|deliver|courier|tracking/iu],
  ["@place", /地址|地点|位置|哪里|哪儿|在哪|门店|address|location|where|store/iu],
  ["@quantity", /数量|几个|多少件|库存|有货|缺货|quantity|how many|stock|available/iu],
  ["@identity", /谁|哪位|联系人|负责人|姓名|名字|who|contact|owner|name/iu],
  ["@decision", /确认|决定|同意|拒绝|可以吗|行不行|是否|选择|confirm|decide|agree|reject|choose/iu],
  ["@preference", /喜欢|偏好|想要|颜色|尺寸|款式|prefer|like|want|color|size|style/iu],
  ["@problem", /问题|错误|失败|坏了|不能|无法|异常|投诉|problem|error|fail|broken|issue|complaint/iu],
];
const semanticTerms = (value) => {
  const text = String(value || "").normalize("NFKC").toLocaleLowerCase();
  const terms = new Set(text.match(/[a-z][a-z0-9._@/-]+|\d+(?:[.,]\d+)?/g) || []);
  for (const run of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
    if (run.length <= 6) terms.add(run);
    for (let index = 0; index + 1 < run.length; index += 1) terms.add(run.slice(index, index + 2));
  }
  for (const [concept, pattern] of semanticConcepts) if (pattern.test(text)) terms.add(concept);
  return terms;
};
const appendWindow = (history, window) => {
  let overlap = Math.min(history.length, window.length);
  while (overlap && history.slice(-overlap).join("\0") !== window.slice(0, overlap).join("\0")) overlap -= 1;
  return [...history, ...window.slice(overlap)];
};
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
    this.stickerGeometry = null;
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
    if (await this.#frontBundle() === "com.tencent.xinWeChat") return;
    try {
      await execFileAsync("/usr/bin/osascript", ["-e", 'tell application id "com.tencent.xinWeChat" to activate']);
      await this.delay(160);
      if (await this.#frontBundle() === "com.tencent.xinWeChat") return;
    } catch {}
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
    const cached = this.snapshots.get(result.chat) ?? {};
    const history = (cached.history ?? []).filter((item) => item.signature !== result.signature || item.limit !== limit);
    history.push({ signature: result.signature, limit, messages: [...result.messages] });
    const memory = appendWindow(cached.memory ?? [], result.messages);
    while (memory.length > 120 || memory.reduce((sum, message) => sum + message.length, 0) > 24_000) memory.shift();
    this.snapshots.delete(result.chat);
    this.snapshots.set(result.chat, { history: history.slice(-4), memory });
    while (this.snapshots.size > 8) this.snapshots.delete(this.snapshots.keys().next().value);
  }

  #smartContext(chat, query, count = 3, immediate = []) {
    const wanted = Math.max(0, Math.min(4, count));
    if (!wanted) return [];
    const memory = appendWindow(this.snapshots.get(chat)?.memory ?? [], immediate);
    const querySet = new Set(query.flatMap((message) => [...semanticTerms(message)]));
    const queryMessages = new Set(query);
    const candidates = memory.map((message, index) => ({ message, index })).filter(({ message }) => !queryMessages.has(message));
    if (!candidates.length) return [];
    const selected = new Set([candidates.at(-1).index]);
    const candidateTerms = candidates.map(({ message }) => semanticTerms(message));
    const frequency = new Map();
    for (const terms of candidateTerms) for (const term of terms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    const ranked = candidates.slice(0, -1).map((candidate, candidateIndex) => {
      let score = 0;
      for (const term of candidateTerms[candidateIndex]) {
        if (!querySet.has(term)) continue;
        const rarity = Math.log1p(candidates.length / (frequency.get(term) ?? 1));
        const weight = term.startsWith("@") || /^\d/.test(term) ? 4 : /^[a-z]/.test(term) ? 3 : 2;
        score += weight * rarity;
      }
      return { ...candidate, score: score + candidate.index / Math.max(1, memory.length) };
    }).sort((left, right) => right.score - left.score || right.index - left.index);
    for (const candidate of ranked) if (selected.size < wanted && candidate.score >= 1) selected.add(candidate.index);
    for (let index = candidates.length - 2; index >= 0 && selected.size < wanted; index -= 1) selected.add(candidates[index].index);
    const ordered = candidates.filter(({ index }) => selected.has(index)).map(({ message }) => message);
    const recent = candidates.at(-1).message;
    if (recent.length >= 1_600) return [recent];
    const bounded = [];
    let chars = 0;
    for (const message of ordered.slice(0, -1)) {
      if (chars + message.length > 1_600 - recent.length) continue;
      bounded.push(message); chars += message.length;
    }
    bounded.push(recent);
    return bounded;
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

  #projectDelta(result, { after, context = 3, limit } = {}) {
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
        projected.context = this.#smartContext(result.chat, projected.messages, context, previous.messages);
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

  async read({ chat, limit = 8, autoSelect = true, allowFocus = true, after, context = 3 }) {
    const started = performance.now();
    const result = await this.#readExact({ chat, limit, autoSelect, allowFocus });
    return { ...this.#projectDelta(result, { after, context, limit }), totalMs: Math.round((performance.now() - started) * 10) / 10 };
  }

  async inboxWait({ chats, after, limit = 12, timeoutMs = 30_000, intervalMs = 1_500 }) {
    const started = performance.now();
    const allowlist = [...new Set((chats || []).map((chat) => String(chat).trim()).filter(Boolean))].slice(0, 8);
    if (!allowlist.length) throw Object.assign(new Error("ALLOWLIST_REQUIRED"), { error: "ALLOWLIST_REQUIRED", detail: "Pass at least one monitored chat" });
    const key = this.#inboxKey(allowlist);
    const deadline = performance.now() + Math.max(0, Math.min(55_000, timeoutMs));
    let state = await this.#inboxRaw({ chats: allowlist, limit: Math.max(1, Math.min(20, limit)) });
    let baseline = after || state.signature;
    let pollMs = 500;
    if (!after) this.#rememberInbox(key, state);
    while (true) {
      const projected = this.#projectInbox(key, state, baseline);
      const externalEvents = projected.events.filter((event) => !this.#isOwnInboxEvent(event));
      if (externalEvents.length) return { ...projected, changed: true, events: externalEvents, eventCount: externalEvents.length, totalMs: Math.round((performance.now() - started) * 10) / 10 };
      if (state.signature !== baseline) baseline = state.signature;
      if (performance.now() >= deadline) return { ok: true, changed: false, signature: baseline, totalMs: Math.round((performance.now() - started) * 10) / 10 };
      await this.delay(pollMs);
      pollMs = Math.min(Math.max(500, Math.min(5_000, intervalMs)), Math.round(pollMs * 1.6));
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
    const command = kind === "file" ? "send-file" : "send-sticker";
    const runMedia = () => {
      const args = ["--chat", chat, "--limit", String(limit)];
      if (kind === "file") args.push("--path", path);
      else {
        args.push("--collection", collection, "--index", String(index));
        if (query) args.push("--query", query);
        if (this.stickerGeometry) for (const [flag, key] of [["--panel-dx", "panelDX"], ["--tab-dy", "tabDY"], ["--tab-step", "tabStep"], ["--panel-width", "panelWidth"]]) {
          args.push(flag, String(this.stickerGeometry[key]));
        }
      }
      return this.run(command, args, Math.max(this.timeoutMs, 8_000));
    };
    try {
      await this.#focusWeChat();
      focusUsed = true;
      let result;
      try { result = await runMedia(); } catch (error) {
        const safeGeometryRetry = kind === "sticker" && this.stickerGeometry &&
          ["WECHAT_STICKER_SEARCH_NOT_FOUND", "WECHAT_STICKER_QUERY_FAILED", "STICKER_SLOT_NOT_VISIBLE"].includes(error?.error);
        if (safeGeometryRetry) {
          this.stickerGeometry = null;
          result = await runMedia();
        } else {
          if (!autoSelect || error?.error !== "WECHAT_TARGET_MISMATCH") throw error;
          await this.#autoSelect(chat, { allowFocus: true, knownMismatch: true });
          result = await runMedia();
        }
      }
      if (kind === "sticker" && [result.panelDX, result.tabDY, result.tabStep, result.panelWidth].every(Number.isFinite)) {
        this.stickerGeometry = Object.fromEntries(["panelDX", "tabDY", "tabStep", "panelWidth"].map((key) => [key, result[key]]));
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
        if (kind === "sticker" && result.geometryCached) this.stickerGeometry = null;
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

  async wait({ chat, after, limit = 8, timeoutMs = 30_000, intervalMs = 1_000, context = 3 }) {
    const started = performance.now();
    const deadline = performance.now() + Math.max(0, Math.min(55_000, timeoutMs));
    let state = await this.#readExact({ chat, limit, autoSelect: true, allowFocus: true });
    let baseline = after || state.signature;
    const focusUsed = state.focusUsed ?? false;
    let pending = after && this.pendingSends.get(chat)?.signature === after ? this.pendingSends.get(chat) : null;
    let pollMs = 250;
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
          const ownContext = this.#smartContext(chat, repliesAfterOwn, context, state.messages.slice(0, ownIndex + 1));
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
            totalMs: Math.round((performance.now() - started) * 10) / 10,
          };
        }
        baseline = state.signature;
        this.#remember(state, limit);
      }
      if (performance.now() >= deadline) break;
      await this.delay(pollMs);
      pollMs = Math.min(Math.max(250, Math.min(5_000, intervalMs)), pollMs * 2);
      state = await this.#readRaw({ chat, limit });
    }
    const projected = this.#projectDelta(state, { after: baseline, context, limit });
    return { autoSelected: true, focusUsed, ...projected, totalMs: Math.round((performance.now() - started) * 10) / 10 };
  }
}
