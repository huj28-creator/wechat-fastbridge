# Token budget

## Normal limits

- Prefer FastBridge MCP tools; they return semantic JSON without screenshot tokens.
- Return 4–8 recent messages.
- Pass the previous signature as `after`; use `context: 2` for normal follow-ups.
- If the signature is unchanged, return zero messages. If it changed and the cached window overlaps, return only the new suffix plus bounded context.
- Return compact JSON only.
- Let `wechat_inbox_wait` poll locally at about 1.5 seconds; unchanged scans never reach model context.
- Fetch context only after an allowlisted event, then pass the per-chat signature with `context: 2`.
- Keep each normal state result below 2,000 characters.
- Require at least 80% character reduction versus the raw accessibility tree on representative fixtures.

## Debug fallback

If parsing fails, search the raw tree inside the Node runtime and return only matching lines for: `文本输入区`, `text <target>`, `row (selected)`, `说:`, and `我说:`. Print the full tree only as a last resort and only once.

## Why this saves tokens

FastBridge never sends the accessibility tree to Codex. Its fallback parser runs before `nodeRepl.write()`, preventing unrelated chats and controls from entering model context. Stable inbox/chat signatures suppress unchanged polls; native allowlist filtering hides every unrelated title.

The MCP fast path keeps up to four compact snapshots for each of eight recently used chats. This small in-memory bound lets it recover the new-message suffix even when a caller supplies a slightly older signature, without storing chat history on disk.
