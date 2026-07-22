# Setup and recovery

## Install FastBridge

1. Clone the public repository and run `npm install` followed by `npm run setup`. Re-running setup replaces the installed skill folder cleanly, so removed or renamed files cannot remain stale.
2. Copy `skill/wechat-computer-use` into `~/.codex/skills/`.
3. Restart Codex so it discovers the STDIO MCP server.
4. Open WeChat and grant Accessibility permission to Codex or the terminal host in System Settings → Privacy & Security → Accessibility.
5. Open WeChat. FastBridge selects the exact requested chat automatically.

This path is free. It needs no App Store membership, cloud server, API key, Xcode build, or code-signing purchase.

## Recover FastBridge

- `ACCESSIBILITY_PERMISSION_REQUIRED` or `-25211`: enable Accessibility, quit and reopen the host app, then retry status.
- `WECHAT_NOT_RUNNING`: open WeChat.
- `WECHAT_WINDOW_NOT_FOUND`: return to the main WeChat chat window.
- `WECHAT_TARGET_MISMATCH`: the chat changed during verification; stop rather than guessing or fighting the user's interaction.
- `WECHAT_AUTO_SELECT_FAILED`: confirm a close, unambiguous title exists and WeChat's main window is open.
- `WECHAT_AMBIGUOUS_CHAT`: more than one result has the exact same title; rename or disambiguate the chat before sending.
- `WECHAT_INPUT_NOT_FOUND`: close viewers/dialogs and return to the main chat.
- timeout: call status once; do not retry a send until delivery is known.

## Initialize Computer Use fallback

1. Install and enable the Computer Use plugin that exposes the persistent Node REPL and `sky` runtime.
2. Follow that plugin's current `SKILL.md` to initialize `sky`; its cache path and version can change.
3. Import `scripts/wechat_compact.mjs` by absolute path and create one controller for the session.

## Recover Computer Use

- `WECHAT_CHAT_WINDOW_NOT_ACTIVE`: close the image/video viewer or wait for the user to return.
- `WECHAT_MAC_LOCKED`: ask the user to unlock the Mac manually.
- `USER_CHANGED_APP` or stale element: discard the input index and re-query full state.
- ScreenCaptureKit errors: wait briefly and retry state; do not resend until delivery is known.
- Send failure icon: retry only when failure is visible and no delivered duplicate exists.

Keep one persistent controller binding. Never print the full UI tree on every turn.
