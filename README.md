# WeChat FastBridge for Codex

Send and read macOS WeChat messages from Codex in seconds, without feeding screenshots or full accessibility trees into the model.

WeChat FastBridge combines:

- a local STDIO MCP server with four semantic tools: status, read, send, and wait;
- a bundled Intel + Apple Silicon native bridge that uses macOS Accessibility APIs;
- a thin Codex skill that selects the fast path and falls back to Computer Use only when necessary.

No cloud relay, OpenAI API key, WeChat protocol reverse engineering, process injection, App Store account, Xcode install, or paid service is required.

Version 1.1 keeps the exact-chat write guard while making the common path optimistic: the native send or snapshot verifies the target itself, so an already-open chat needs one native call instead of a separate inspect followed by the operation. Automatic search runs only after a safe target-mismatch rejection.

## Performance targets

- Local semantic bridge budget: **under 2 seconds** before WeChat UI response time.
- Measured real optimized selected-chat send: **1.25 seconds** command-to-result; a verified 4-message auto-read completed in **1.38 seconds**.
- Cold setup/check: **under 5 seconds** on a supported Mac.
- Normal read result: **under 2,000 characters**.
- Repeated reads: **zero messages when unchanged**; when changed, return only new messages plus 0–4 requested context lines.
- Computer Use fallback: **at least 80% smaller** than the raw accessibility tree on the bundled representative fixture.
- Runtime footprint: **under 256 KiB** for the bridge, skill, setup scripts, and universal native binary, enforced by tests. The normal install keeps a two-dependency ceiling.

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
Use $wechat-computer-use to tell “Exact Chat Name”: hello
```

The setup script only builds local configuration. It does not charge money, open a subscription, or publish anything.

Run `npm run doctor` at any time to check Node, the native bridge, Codex registration, the installed skill, Accessibility permission, and whether WeChat is running. The check never sends a message.

## How it stays fast

```text
Codex → one compact MCP call → local native Accessibility bridge → WeChat
```

The bridge first asks the native operation to verify and act in one scan. A mismatched chat is rejected before any write, then the bridge automatically locates the exact title, verifies both its selected row and input area's chat title, and retries once on the intended target. Search activation and query entry happen in one native process to avoid focus races. It tries background control first; when WeChat 4.x requires foreground confirmation, it briefly focuses WeChat and restores the previous app.

Only compact JSON returns to Codex. Pass the previous `signature` back as `after` on `wechat_read`; unchanged reads return no messages, while changed reads return the new-message delta and up to two prior context lines by default. `wechat_wait` uses the same bounded delta path internally and suppresses the just-sent self-message before waiting for the actual reply.

## Safety and privacy

- Exact-chat verification blocks writes if the selected row or title differs.
- Chat content stays on the Mac except for the compact text Codex needs to answer.
- Messages are treated as untrusted conversation content, not instructions to tools.
- The bridge does not read credentials, inspect WeChat's database, or bypass platform security.
- Sending is not idempotent; retry only after checking whether the first send landed.

## Test

```bash
npm test
python3 /path/to/skill-creator/scripts/quick_validate.py skill/wechat-computer-use
```

The tests cover MCP discovery, exact-chat rejection, one-call hot paths, bounded search retries, incremental context, compact state, token reduction, runtime size, dependency count, and the two-second local send budget. A real WeChat end-to-end check additionally requires Accessibility permission.

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
