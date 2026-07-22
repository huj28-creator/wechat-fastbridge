const DEFAULT_APP = "com.tencent.xinWeChat";

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n");
}

function percentSaved(rawChars, compactChars) {
  if (!rawChars) return 0;
  return Math.max(0, Math.round((1 - compactChars / rawChars) * 1000) / 10);
}

function extractElementIndex(line) {
  const match = line.match(/(?:^|\s)(\d+)\s+(?=\S)/);
  return match ? Number(match[1]) : null;
}

function extractMessage(line) {
  const marker = "单元格 ";
  const index = line.indexOf(marker);
  if (index < 0) return null;
  const value = line.slice(index + marker.length).replace(/, ID: MM\w+CellView.*$/, "").trim();
  if (!value) return null;
  if (/^(昨天 )?\d{1,2}:\d{2}$/.test(value)) return null;
  if (!/(说:|我说:|发送了一个|撤回了一条|拍了拍|引用了|视频|文件|表情)/.test(value)) return null;
  return value;
}

function chatHeaderMatches(raw, targetChat) {
  if (!targetChat) return false;
  const escaped = targetChat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\btext ${escaped}(?: \\(\\d+\\))?\\s*$`, "m").test(raw);
}

export function compactWechatTree(treeText, { targetChat, limit = 8 } = {}) {
  const raw = normalizeText(treeText);
  const lines = raw.split("\n");
  const boundedLimit = Math.max(1, Math.min(20, Number(limit) || 8));

  const windowLine = lines.find((line) => line.startsWith("Window:")) ?? "";
  const selectedLine = lines.find((line) => /row \(selected\)/.test(line)) ?? "";
  const inputLine = [...lines].reverse().find((line) =>
    line.includes("文本输入区") && line.includes("settable"),
  ) ?? "";
  const messages = lines.map(extractMessage).filter(Boolean).slice(-boundedLimit);
  const inputIndex = extractElementIndex(inputLine);
  const targetMatched = chatHeaderMatches(raw, targetChat) && inputLine.includes(targetChat ?? "");
  const locked = /Mac is locked|automatic unlock could not unlock/i.test(raw);
  const viewer = /Window: "", App: 微信/.test(raw) || !/微信 \(聊天\)/.test(windowLine);

  const signatureSeed = `${selectedLine}\n${messages.join("\n")}\n${inputIndex ?? ""}`;
  let hash = 2166136261;
  for (let i = 0; i < signatureSeed.length; i += 1) {
    hash ^= signatureSeed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const compact = {
    ok: Boolean(targetMatched && inputIndex !== null && !locked && !viewer),
    targetChat: targetChat ?? null,
    targetMatched,
    inputIndex,
    window: windowLine.replace(/^Window:\s*/, ""),
    messages,
    locked,
    viewer,
    signature: (hash >>> 0).toString(16).padStart(8, "0"),
  };

  const compactChars = JSON.stringify(compact).length;
  compact.stats = {
    rawChars: raw.length,
    compactChars,
    savingsPercent: percentSaved(raw.length, compactChars),
  };
  return compact;
}

function stateText(result) {
  if (typeof result === "string") return result;
  if (typeof result?.text === "string") return result.text;
  throw new Error("WECHAT_STATE_TEXT_MISSING");
}

function assertTarget(state, targetChat) {
  if (state.locked) throw new Error("WECHAT_MAC_LOCKED");
  if (state.viewer) throw new Error("WECHAT_CHAT_WINDOW_NOT_ACTIVE");
  if (!state.targetMatched) throw new Error(`WECHAT_TARGET_MISMATCH:${targetChat}`);
  if (!Number.isInteger(state.inputIndex)) throw new Error("WECHAT_INPUT_NOT_FOUND");
}

export function createWechatController({ sky, app = DEFAULT_APP } = {}) {
  if (!sky?.get_app_state || !sky?.set_value || !sky?.press_key) {
    throw new TypeError("A Computer Use sky runtime is required");
  }

  async function state({ targetChat, limit = 8, disableDiff = true } = {}) {
    if (!targetChat) throw new TypeError("targetChat is required");
    const result = await sky.get_app_state({ app, disableDiff });
    return compactWechatTree(stateText(result), { targetChat, limit });
  }

  async function send({ targetChat, text, verify = true, limit = 8 } = {}) {
    if (!targetChat) throw new TypeError("targetChat is required");
    if (typeof text !== "string" || !text.trim()) throw new TypeError("text must be non-empty");

    const before = await state({ targetChat, limit, disableDiff: true });
    assertTarget(before, targetChat);
    await sky.set_value({ app, element_index: before.inputIndex, value: text });
    await sky.press_key({ app, key: "Return" });

    if (!verify) {
      return { ok: true, targetChat, sentChars: text.length, before: before.signature };
    }

    const after = await state({ targetChat, limit, disableDiff: false });
    return {
      ok: after.messages.some((message) => message.includes(`我说:${text}`)),
      targetChat,
      sentChars: text.length,
      signature: after.signature,
      messages: after.messages,
      stats: after.stats,
    };
  }

  return Object.freeze({ state, send });
}
