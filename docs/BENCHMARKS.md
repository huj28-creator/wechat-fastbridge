# Benchmarks

## Real WeChat test

Date: 2026-07-22

Platform: macOS, WeChat 4.x, Apple Silicon. The bridge binary was the universal Intel + Apple Silicon build.

| Check | Result |
| --- | ---: |
| Bridge status | 35 ms |
| Native send path | 3,060 ms |
| Full Node round trip | 3,950 ms |
| Input cleared after send | Yes |
| Conversation preview updated | Yes |
| Duplicate test messages | 0 |

Only one authorized message was delivered. Earlier attempts that left text in the input field or failed exact-chat verification were not counted as successful.

## Automated gates

- MCP server exposes only compact semantic tools.
- Mock native round trip stays below 2,000 ms.
- Compact Computer Use fallback removes at least 80% of representative UI-tree characters.
- Exact-chat mismatch prevents writes.
- Skill passes the standard Codex skill validator.

Real latency varies with WeChat UI size and Mac load. The product goal is a complete send within a few seconds, with correctness taking priority over shaving off a misleading fraction of a second.
