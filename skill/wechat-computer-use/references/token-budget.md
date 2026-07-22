# Token budget

## Normal limits

- Prefer FastBridge MCP tools; they return semantic JSON without screenshot tokens.
- Return 4–8 recent messages.
- Pass the previous signature as `after`; let smart context select up to three recent/relevant lines for normal follow-ups. This is a maximum: semantic retrieval keeps relevant evidence plus continuity without padding the quota with unrelated lines.
- If the signature is unchanged, return zero messages. If it changed and the cached window overlaps, return only the new suffix plus bounded context; formatting-only colon or whitespace changes do not retransmit old bubbles.
- Return compact JSON only.
- Let `wechat_inbox_wait` poll locally at about 1.5 seconds; unchanged scans never reach model context.
- Fetch context only after an allowlisted event, then pass the per-chat signature and reuse the RAM-only rolling memory plus its bounded high-signal fact capsule.
- Keep each normal state result below 2,000 characters.
- Require at least 80% character reduction versus the raw accessibility tree on representative fixtures.

## Debug fallback

If parsing fails, search the raw tree inside the Node runtime and return only matching lines for: `文本输入区`, `text <target>`, `row (selected)`, `说:`, and `我说:`. Print the full tree only as a last resort and only once.

## Why this saves tokens

FastBridge never sends the accessibility tree to Codex. Its fallback parser runs before `nodeRepl.write()`, preventing unrelated chats and controls from entering model context. Stable inbox/chat signatures suppress unchanged polls; native allowlist filtering hides every unrelated title.

The MCP fast path keeps four delta snapshots, up to 120 observed messages/24 KB, and up to 40 high-signal facts/8 KB for each of eight recent chats. Local Chinese bigrams, words, concepts, numbers, conflict suppression, and recency retrieve useful evidence without retransmitting the full history. Nothing is stored on disk.
