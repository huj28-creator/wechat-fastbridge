# Benchmarks

## Version 1.1 algorithm gates

The v1.1 hot path removes the separate `inspect-fast` process when the requested chat is already selected. The native `snapshot` and `send` commands still reject a mismatched selected row or header before returning or writing anything.

| Gate | v1.0 path | v1.1 path |
| --- | ---: | ---: |
| Already-selected send native calls | inspect + send | send |
| Already-selected read native calls | inspect + snapshot | snapshot |
| Wait baseline reads before polling | 2 | 1 |
| Unchanged repeated-read messages returned | up to limit | 0 |
| Changed repeated-read payload | full window | new delta + 0–4 context lines |
| Representative 1-new-message compact payload | full 8-message result | 43.8% fewer JSON characters with 2 context lines |
| Wait immediately after send | may return own send | re-baselines on own send, returns reply |
| Cached context bound | none | 8 chats × 4 snapshots × 20 messages |
| Runtime footprint gate | none | <256 KiB |
| Production dependency ceiling | none | 2 |

The one-call behavior, target-mismatch fallback, transient search-result retry, unchanged suppression, delta overlap, limit-change fallback, self-send suppression, and context bound are automated tests. Based on the separately measured 499 ms native send and 465 ms native snapshot below, removing the preceding scan should save roughly one native-process round trip on an already-selected chat. That is a component estimate, not a new end-to-end claim; real UI timings still vary with WeChat state and user activity.

## Real WeChat test

Date: 2026-07-22

Platform: macOS, WeChat 4.x, Apple Silicon. The bridge binary was the universal Intel + Apple Silicon build.

| Check | Result |
| --- | ---: |
| Bridge status | 35 ms |
| First selected-chat native send path | 3,060 ms |
| First selected-chat full Node round trip | 3,950 ms |
| Auto-select + verified send prototype | 10,898 ms |
| Native send portion of that prototype | 2,526 ms |
| Optimized exact-state scan | 129 ms |
| Optimized 8-message read | 465 ms |
| Post-hardening Jerry auto-read, full wall time | 1,385 ms |
| Final optimized selected-chat native send | 499 ms |
| Final optimized bridge send total | 944 ms |
| Final optimized command wall time | 1,253 ms |
| Post-send delivery confirmation read | 654 ms |
| Full diagnostic result | 13,852 characters (~3,463 tokens) |
| Compact 8-message result | 296 characters (~74 tokens) |
| Real-result reduction | 97.9% |
| Input cleared after send | Yes |
| Conversation preview updated | Yes |
| Duplicate test messages | 0 |

Three user-authorized messages were delivered across development: `testing sending message`, `FastBridge latency test`, and `FastBridge optimized final test`. The final test used `autoSelect: true`, verified the already-selected exact `Jerry` chat without foreground focus, cleared the input, appeared exactly once in the latest 20 messages, and returned to the command in 1.253 seconds. Attempts that left text in the input field or failed exact-chat verification were not counted as successful. The 10.898-second automatic-search prototype was measured before row-subtree pruning; it remains listed separately rather than being presented as the current selected-chat fast path.

## Automated gates

- MCP server exposes only compact semantic tools.
- Seventeen tests cover MCP discovery, compact native round trips, optimistic single-call paths, automatic-selection recovery, incremental context, self-send suppression, skill packaging, runtime size, dependency count, token reduction, and wrong-chat rejection.
- Compact Computer Use fallback removes at least 80% of representative UI-tree characters.
- Exact-chat mismatch prevents writes.
- Skill passes the standard Codex skill validator.

Real latency varies with WeChat UI size and Mac load. The product goal is a complete send within a few seconds, with correctness taking priority over shaving off a misleading fraction of a second.
