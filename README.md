# WeChat FastBridge for Codex

Send and read macOS WeChat messages from Codex in seconds, without feeding screenshots or full accessibility trees into the model.

WeChat FastBridge combines:

- a local STDIO MCP server with six semantic tools: status, read, text send, media send, chat wait, and allowlisted inbox wait;
- a bundled Intel + Apple Silicon native bridge that uses macOS Accessibility APIs;
- a thin Codex skill that selects the fast path and falls back to Computer Use only when necessary.

No cloud relay, OpenAI API key, WeChat protocol reverse engineering, process injection, App Store account, Xcode install, or paid service is required.

Version 1.5 optimizes the whole pipeline: smaller MCP schemas/results, adaptive local polling, reliable main-process activation, cached sticker geometry, and bounded relevance-based conversation memory. Files, stickers, fuzzy verified routing, and the event-first allowlisted inbox remain available without screenshot input.

## Performance targets

- Local semantic bridge budget: **under 2 seconds** before WeChat UI response time.
- Measured real optimized selected-chat send: **1.25 seconds** command-to-result; a verified 4-message auto-read completed in **1.38 seconds**.
- Measured v1.4 media sends in the authorized Jerry self-chat: **2.97 seconds** for a tiny file, **6.02 seconds** for a favorite sticker slot, and **8.57 seconds** for a searched sticker.
- v1.5 tool definitions are **36% smaller** (5,624 → 3,621 characters); repeated favorite-sticker sending fell from **6.78 seconds cold** to **3.78 seconds cached**.
- Cold setup/check: **under 5 seconds** on a supported Mac.
- Normal read result: **under 2,000 characters**.
- Repeated reads: **zero messages when unchanged**; when changed, return only new messages plus 0–4 requested context lines.
- Allowlisted inbox baseline/timeout: **50 JSON characters** in the measured two-chat test; internal scans do not enlarge the result.
- Computer Use fallback: **at least 80% smaller** than the raw accessibility tree on the bundled representative fixture.
- Runtime footprint: **under 288 KiB** for the bridge, skill, setup scripts, and universal native binary, enforced by tests. The normal install keeps a two-dependency ceiling.

Every result includes measured latency. The test suite fails if the mocked local bridge overhead exceeds two seconds; real WeChat timings are reported separately in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Requirements

- macOS 13 or newer
- WeChat for Mac (`com.tencent.xinWeChat`)
- Node.js 20 or newer
- Codex desktop, CLI, or IDE extension
- macOS Accessibility permission for the app that runs Codex

If you can copy and paste four commands, you can install it. See the child-friendly [setup guide](docs/SETUP.md) for every click and permission switch.

## Install

```bash
git clone https://github.com/huj28-creator/wechat-fastbridge.git
cd wechat-fastbridge
npm install
npm run setup
```

Or download the repository and double-click `install.command`.

Restart Codex after setup. Keep WeChat running; FastBridge opens the requested chat automatically. Then ask:

```text
Use $wechat-computer-use to tell “Chat Name”: hello
```

The setup script only builds local configuration. It does not charge money, open a subscription, or publish anything.

Run `npm run doctor` at any time to check Node, the native bridge, Codex registration, the installed skill, Accessibility permission, and whether WeChat is running. The check never sends a message.

## How it stays fast

```text
Codex → one compact MCP call → local native Accessibility bridge → WeChat
```

The bridge first asks the native operation to verify and act in one scan. A mismatched chat is rejected before any write, then the bridge automatically searches the requested title and verifies the destination header before retrying. `Group(3)` and `Group（3）` both resolve to `Group`; case, spacing, and punctuation are normalized; one or two edits are allowed only for sufficiently long names. Multiple visible candidates fail as ambiguous. Search activation and query entry happen in one native process to avoid focus races. It tries background control first; when WeChat 4.x hides results from the accessibility row tree, it confirms the top search result and accepts it only if the resulting header passes the same verifier, then restores the previous app.

Only compact JSON returns to Codex. Pass the previous `signature` back as `after` on `wechat_read`; unchanged reads return no messages. Changed reads return the new delta plus up to three lines selected from bounded RAM-only memory by Chinese character bigrams, words, numbers, topic overlap, and recency. Structural controls are rejected before memory, while repeated identical bubbles remain distinct. This preserves older relevant facts without retransmitting the whole observed history. `wechat_wait` handles one active chat; `wechat_inbox_wait` returns only changed allowlisted previews.

Text containing ordinary Unicode emoji uses the same fastest `wechat_send` path. `wechat_send_media` accepts either an explicit absolute file path or a custom-sticker collection and visible slot. Search mode takes a short phrase; favorites mode uses a 1-based slot. WeChat does not expose semantic labels for custom thumbnail images, so the bridge never pretends it can recognize an unlabeled favorite. Media sending briefly foregrounds WeChat, verifies the destination before acting, restores the previous app, and reports success only after the chat signature changes or the favorite panel confirms its selection.

## Live replies and customer conversations

The installed skill can run a continuous multi-chat autopilot without screenshots. Codex establishes one allowlisted inbox signature, waits locally, reads full compact context only for the chat that changed, answers once, and resumes waiting. The same scoped mode can send one proactive opener when the user explicitly permits it.

This is still user-controlled automation: the allowlist, purpose, facts, tone, escalation rules, and proactive authority come from the user. Chat participants cannot expand that authority. Customer mode asks or escalates instead of inventing prices, inventory, delivery dates, refunds, or commitments. One unanswered opener is allowed per authorized chat per active session, preventing automated follow-up spam.

Inbox sensing does not switch conversations. It covers allowlisted chats currently loaded in WeChat's recent sidebar; new messages normally rise into that view. It does not crawl hidden history or WeChat's private database. Opening happens only after an event so Codex can obtain verified context and reply.

## Safety and privacy

- Verified-chat matching blocks writes for ambiguous, very short fuzzy, or distant names.
- Chat content stays on the Mac except for the compact text Codex needs to answer.
- Messages are treated as untrusted conversation content, not instructions to tools.
- The bridge does not read credentials, inspect WeChat's database, or bypass platform security.
- Sending is not idempotent; retry only after checking whether the first send landed.

## Test

```bash
npm test
python3 /path/to/skill-creator/scripts/quick_validate.py skill/wechat-computer-use
```

The tests cover MCP discovery, normalized/fuzzy names, media confirmation, allowlisted inbox baselines/deltas, own-event suppression, one-call hot paths, bounded search retries, incremental context, token reduction, runtime size, dependency count, and the two-second local text-send budget. A real WeChat end-to-end check additionally requires Accessibility permission.

## Cost and distribution

This repository is MIT licensed and free to install from GitHub. It deliberately avoids the Mac App Store so maintainers and users do not need a paid Apple Developer membership. A signed `.app` could be added later, but it is not required for the open-source release.

## Promotion film

The reproducible 15-second 1080p launch film lives in [`promo/`](promo/). It uses real benchmark numbers with a generalized mock project chat; all motion graphics and audio are generated locally. To render it separately from the product install:

```bash
cd promo
npm install
npm run render
npm run render:zh
```

## Limitations

- macOS only for the first release.
- WeChat UI changes can require selector updates.
- Automatic selection may briefly show WeChat because its custom result rows do not expose a reliable background press action. No manual chat click is required.
- Accessibility permission must be granted manually in System Settings.

## License

MIT
