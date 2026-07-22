# Benchmarks

## Version 1.4 algorithm gates

The v1.4 hot path retains verified routing and the native allowlisted inbox, then adds one compact media tool for verified files and custom stickers. Unchanged preview scans and unrelated titles are discarded before returning to Codex; message context is fetched only after an allowed event.

| Gate | v1.0 path | v1.4 path |
| --- | ---: | ---: |
| Already-selected send native calls | inspect + send | send |
| Already-selected read native calls | inspect + snapshot | snapshot |
| Wait baseline reads before polling | 2 | 1 |
| Unchanged repeated-read messages returned | up to limit | 0 |
| Changed repeated-read payload | full window | new delta + 0–4 context lines |
| Representative 1-new-message compact payload | full 8-message result | 43.8% fewer JSON characters with 2 context lines |
| Wait immediately after send | may return own send | re-baselines on own send, returns reply |
| Cached context bound | none | 8 chats × 4 snapshots × 20 messages |
| Runtime footprint gate | none | <288 KiB |
| Production dependency ceiling | none | 2 |
| Chat-name resolver | exact text | ignores member counts/formatting; bounded typo distance |
| Live reply context | repeated full reads | signature wait + new delta + bounded context |
| Multi-chat sensing | switch and read every chat | local allowlisted preview events |
| Unchanged inbox payload | n/a | zero events |
| File/sticker context input | screenshots / accessibility dump | explicit path or query/slot only |

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
| v1.3 two-chat inbox baseline | 186 ms |
| v1.3 unchanged 3-second inbox wait | 3,636 ms wall; 50-character result (~13 tokens) |
| Estimated unchanged result payload over one hour | ~850 tokens at one 55-second timeout per call, excluding protocol/tool-call framing |
| v1.3 non-allowlisted titles returned | 0 |
| v1.4 verified 54-byte file send | 1,518 ms native; 2,971 ms total |
| v1.4 favorite sticker slot send | 4,132 ms native; 6,017 ms total |
| v1.4 searched sticker (`早上好`, first result) | 7,169 ms native; 8,566 ms total |
| v1.4 media destinations used | Jerry only |
| Full diagnostic result | 13,852 characters (~3,463 tokens) |
| Compact 8-message result | 296 characters (~74 tokens) |
| Real-result reduction | 97.9% |
| Input cleared after send | Yes |
| Conversation preview updated | Yes |
| Duplicate test messages | 0 |

The original text-send benchmark used `autoSelect: true`, verified the already-selected exact `Jerry` chat without foreground focus, cleared the input, and returned to the command in 1.253 seconds. The v1.4 media checks were also explicitly authorized for Jerry: a uniquely named text fixture, a favorite slot, and the first `早上好` search result all produced a changed conversation signature. Attempts without a changed signature or a dismissed favorite panel were not reported as successful. The 10.898-second automatic-search prototype predates row-subtree pruning and remains listed separately.

## Automated gates

- MCP server exposes only compact semantic tools.
- Twenty-six tests cover MCP discovery, normalized/fuzzy names, confirmed media, compact native round trips, allowlisted inbox baselines/deltas, own-event suppression, automatic-selection recovery, incremental context, skill packaging, runtime size, dependency count, token reduction, and wrong-chat rejection.
- Compact Computer Use fallback removes at least 80% of representative UI-tree characters.
- Exact-chat mismatch prevents writes.
- Skill passes the standard Codex skill validator.

Real latency varies with WeChat UI size and Mac load. The product goal is a complete send within a few seconds, with correctness taking priority over shaving off a misleading fraction of a second.
