# Benchmarks

## Version 1.7 algorithm gates

The v1.7 hot path combines verified routing, allowlisted semantic inbox events, compact structured errors, compact media, adaptive polling, cached sticker geometry, bounded rolling memory, and an extractive high-signal fact capsule. Unchanged scans, unread decreases, stale conflicting facts, and unrelated titles are discarded before returning to Codex.

| Gate | v1.0 path | v1.6 path |
| --- | ---: | ---: |
| Already-selected send native calls | inspect + send | send |
| Already-selected read native calls | inspect + snapshot | snapshot |
| Wait baseline reads before polling | 2 | 1 |
| Unchanged repeated-read messages returned | up to limit | 0 |
| Changed repeated-read payload | full window | new delta + 0–4 context lines |
| Representative 1-new-message compact payload | full 8-message result | 43.8% fewer JSON characters with 2 context lines |
| Wait immediately after send | may return own send | re-baselines on own send, returns reply |
| Cached context bound | none | 120 messages/24 KB + 40 facts/8 KB × 8 chats, RAM-only |
| Runtime footprint gate | none | <288 KiB |
| Production dependency ceiling | none | 2 |
| Chat-name resolver | exact text | ignores member counts/formatting; bounded typo distance |
| Live reply context | repeated full reads | signature wait + new delta + bounded context |
| Multi-chat sensing | switch and read every chat | local allowlisted preview events |
| Unchanged inbox payload | n/a | zero events |
| File/sticker context input | screenshots / accessibility dump | explicit path or query/slot only |
| MCP tool-definition characters | n/a | 2,849 (49% below 5,624; 21% below v1.5) |
| Triggered skill instructions | n/a | 3,924 bytes |
| Rolling conversation memory | none | 120 messages/24 KB × 8 chats, RAM-only |
| Durable fact capsule | none | 40 high-signal source messages/8 KB × 8 chats, RAM-only |
| Delta context | last lines only | recent continuity + concept/rarity-ranked facts + stale-number suppression |
| Unread decrease after opening chat | false event | ignored locally |
| Repeated preview with unread increase | may be missed | emitted as an event |
| English preview containing commas | truncated | preserved |
| Runtime tool failures | protocol exception | compact structured error |
| UI controls / duplicate bubbles | mixed / collapsed | controls excluded / duplicates preserved |

The one-call behavior, target-mismatch fallback, transient search-result retry, unchanged suppression, delta overlap, limit-change fallback, self-send suppression, durable fact retrieval after more than 120 observed messages, stale-number suppression, unread-change handling, comma-safe previews, and all memory bounds are automated tests. Based on the separately measured 499 ms native send and 465 ms native snapshot below, removing the preceding scan should save roughly one native-process round trip on an already-selected chat. That is a component estimate, not a new end-to-end claim; real UI timings still vary with WeChat state and user activity.

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
| v1.5 cold favorite sticker | 4,315 ms native; 6,784 ms total |
| v1.5 cached favorite sticker | 1,823 ms native; 3,784 ms total |
| Full diagnostic result | 13,852 characters (~3,463 tokens) |
| Compact 8-message result | 296 characters (~74 tokens) |
| Real-result reduction | 97.9% |
| Input cleared after send | Yes |
| Conversation preview updated | Yes |
| Duplicate test messages | 0 |

The original text-send benchmark used `autoSelect: true`, verified the already-selected exact `Jerry` chat without foreground focus, cleared the input, and returned to the command in 1.253 seconds. The v1.4 media checks were also explicitly authorized for Jerry: a uniquely named text fixture, a favorite slot, and the first `早上好` search result all produced a changed conversation signature. Attempts without a changed signature or a dismissed favorite panel were not reported as successful. The 10.898-second automatic-search prototype predates row-subtree pruning and remains listed separately.

## Automated gates

- MCP server exposes only compact semantic tools.
- Thirty-six tests cover MCP discovery/schema budgets, structured errors, version sync, synonym-aware and durable smart context, stale-number suppression, normalized/fuzzy names, comma-safe previews, confirmed media and geometry reuse, compact native round trips, meaningful allowlisted inbox deltas, false/own-event suppression, recovery, runtime size, dependencies, token reduction, and wrong-chat rejection.
- Compact Computer Use fallback removes at least 80% of representative UI-tree characters.
- Exact-chat mismatch prevents writes.
- Skill passes the standard Codex skill validator.

Real latency varies with WeChat UI size and Mac load. The product goal is a complete send within a few seconds, with correctness taking priority over shaving off a misleading fraction of a second.
