# Super-simple setup

This guide is written so a student can follow it. Nothing here costs money.

## What you need

- A Mac with WeChat installed
- Codex installed
- Node.js 20 or newer
- About five minutes

## 1. Download and install

Open Terminal. Paste these commands one line at a time:

```bash
git clone https://github.com/YOUR_GITHUB/wechat-fastbridge.git
cd wechat-fastbridge
npm install
npm run setup
```

If you downloaded the ZIP instead, double-click `install.command` and wait for “Finished.”

If a command shows an error, stop there and copy the error into a GitHub issue. Do not keep guessing.

## 2. Turn on one Mac permission

1. Click the Apple menu ``.
2. Click **System Settings**.
3. Click **Privacy & Security**.
4. Scroll down and click **Accessibility**. In Chinese macOS this is **隐私与安全性 → 辅助功能**.
5. Turn on the switch for the app that starts Codex:
   - **ChatGPT** or **Codex**, when using the desktop app;
   - **Terminal**, when using Codex from Terminal;
   - **node**, if macOS adds it to the list after the first test.
6. If the app is missing, click `+`, choose the app, and turn its switch on.
7. Quit and reopen Codex. This restart matters.

FastBridge does not need Screen Recording in normal mode. The optional Computer Use fallback may ask for it.

## 3. Check that it works

Open WeChat and select the exact chat you want. Keep it selected; WeChat may stay behind another app.

In Codex, ask:

```text
Use $wechat-computer-use to check WeChat FastBridge.
```

Then send a harmless test to yourself:

```text
Use $wechat-computer-use to send “hello from Codex” to “File Transfer”.
```

FastBridge refuses to send if the selected chat name is different.

## 4. Use Quiet Mode

Quiet Mode means WeChat does not jump in front of your work.

1. Select one chat in WeChat once.
2. Switch back to your work.
3. Ask Codex to read, wait, or send in that exact chat.

Automatic background switching between chats is disabled because WeChat does not expose a safe background selection action. This is intentional: no screen stealing and fewer wrong-chat mistakes.

## 5. Permission and approval settings

Recommended Codex MCP approval mode: **Ask before writes**. Reading can happen automatically; sending a message remains a write action. Advanced users can change this, but beginners should keep the safer default.

FastBridge only needs:

| Permission | Why | Required? |
| --- | --- | --- |
| Accessibility | Read the selected chat title and control its input box | Yes |
| Screen Recording | Computer Use fallback screenshots | No for FastBridge |
| Files and Folders | Install the local skill and MCP files | During setup only |
| Network | None for WeChat control | No |

It does not need your WeChat password, Apple ID password, contacts export, microphone, camera, or payment information.

## Fix common problems

- **ACCESSIBILITY_PERMISSION_REQUIRED**: repeat step 2, then restart Codex.
- **WECHAT_NOT_RUNNING**: open WeChat.
- **WECHAT_TARGET_MISMATCH**: click the exact requested chat once.
- **WECHAT_INPUT_NOT_FOUND**: close photo/video viewers and return to the chat window.
- **WECHAT_SEND_SHORTCUT_UNKNOWN**: check the draft; FastBridge did not claim success.
- **Message stays in the input box**: update FastBridge and report your WeChat version in an issue.

Never pay anyone for an “activation code.” This project is free and MIT licensed.
