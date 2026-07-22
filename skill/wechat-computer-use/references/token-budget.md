# Token budget

## Normal limits

- Prefer FastBridge MCP tools; they return semantic JSON without screenshot tokens.
- Return 4–8 recent messages.
- Return compact JSON only.
- Poll at 3–5 second intervals and return only after the signature changes or the bounded poll ends.
- Keep each normal state result below 2,000 characters.
- Require at least 80% character reduction versus the raw accessibility tree on representative fixtures.

## Debug fallback

If parsing fails, search the raw tree inside the Node runtime and return only matching lines for: `文本输入区`, `text <target>`, `row (selected)`, `说:`, and `我说:`. Print the full tree only as a last resort and only once.

## Why this saves tokens

FastBridge never sends the accessibility tree to Codex. Its fallback parser runs before `nodeRepl.write()`, preventing unrelated chats and controls from entering model context. Stable signatures also suppress unchanged polls.
