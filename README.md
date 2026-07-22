# WeChat FastBridge for Codex

Send and read macOS WeChat messages from Codex in seconds, without feeding screenshots or full accessibility trees into the model.

WeChat FastBridge combines:

- a local STDIO MCP server with four semantic tools: status, read, send, and wait;
- a bundled Intel + Apple Silicon native bridge that uses macOS Accessibility APIs;
- a thin Codex skill that selects the fast path and falls back to Computer Use only when necessary.

No cloud relay, OpenAI API key, WeChat protocol reverse engineering, process injection, App Store account, Xcode install, or paid service is required.

## Performance targets

- Local semantic bridge budget: **under 2 seconds** before WeChat UI response time.
- Measured real end-to-end send: **3.95 seconds** on the documented test Mac.
- Cold setup/check: **under 5 seconds** on a supported Mac.
- Normal read result: **under 2,000 characters**.
- Computer Use fallback: **at least 80% smaller** than the raw accessibility tree on the bundled representative fixture.

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

Restart Codex after setup. Open the exact WeChat chat you want to use, then ask:

```text
Use $wechat-computer-use to tell “Exact Chat Name”: hello
```

The setup script only builds local configuration. It does not charge money, open a subscription, or publish anything.

## How it stays fast

```text
Codex → one compact MCP call → local native Accessibility bridge → WeChat
```

The bridge walks the UI locally, verifies both the selected chat row and input area's chat title, writes the input value directly, and sends the key only to WeChat's process. It does not bring WeChat to the front in Quiet Mode. Only compact JSON returns to Codex. A stable message signature lets `wechat_wait` poll without adding unchanged UI state to the conversation.

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

The tests cover MCP discovery, exact-chat rejection, compact state, token reduction, and the two-second local send budget. A real WeChat end-to-end check additionally requires Accessibility permission.

## Cost and distribution

This repository is MIT licensed and free to install from GitHub. It deliberately avoids the Mac App Store so maintainers and users do not need a paid Apple Developer membership. A signed `.app` could be added later, but it is not required for the open-source release.

## Limitations

- macOS only for the first release.
- WeChat UI changes can require selector updates.
- Quiet Mode requires the requested chat to already be open and selected. This prevents screen stealing and wrong-chat sends.
- Accessibility permission must be granted manually in System Settings.

## License

MIT
