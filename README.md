# dsh-clawd-pet

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)
[![DSH](https://img.shields.io/badge/DSH%20Desktop-2.x-blue)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](package.json)

Drive the Clawd on Desk desktop pet from DeepSeek Harness (DSH): when the DSH agent thinks, calls tools, waits for approval, errors, or completes a turn, the pet animates accordingly — in real time.

Runs as a Cordis plugin inside DSH. It listens to the DSH session firehose (`session/created` / `session/event` / `session/disposed` / `agent/error`), translates events into Clawd pet states, and POSTs them to Clawd's local server (`127.0.0.1:23333+/state`) as a registered Clawd "custom application".

## Features

- **Real-time pet telemetry** — thinking / working / juggling / notification / attention / error / sweeping / sleeping, mapped from live DSH session events (see table below).
- **Subagent & workflow aware** — subagent sessions and `tool-workflow` runs fold into their parent session as *juggling*, so the HUD stays clean instead of spawning pet cards per child agent.
- **Approval alerts** — when DSH waits on you (`approval/asked`), the pet switches to *notification* so you notice the pending approval.
- **Context-usage ring** — turn completions carry a `context_usage` estimate (used/limit/percent) for the session HUD.
- **Completion text** — the final assistant message is attached to completion events (clamped to Clawd's 2400-char cap).
- **Zero footprint** — modifies no existing DSH/Clawd files; all reporting is fire-and-forget on a serial queue, failures only log, the agent loop is never blocked.
- **Auto-discovery** — Clawd's port is discovered from `~/.clawd/runtime.json` + the 23333–23337 range; the agent id is auto-resolved from Clawd's registered custom applications, falling back to the deterministic hash of the host executable.
- **No extra runtime deps** — only Node built-ins (`node:http`, `node:crypto`, …) plus the tiny `@deepseek-ai/schemastery` schema package; loads inside every DSH host (DSH Desktop Electron main, `dsh web` node server).

## State mapping

| DSH event | Clawd state | Pet animation |
|---|---|---|
| prompt submit / `turn/start` / model streaming | `thinking` | thinking |
| `tool/call`, `tool/result` | `working` | typing |
| subagent session active / workflow run | `juggling` | juggling |
| `approval/asked` (waiting on you) | `notification` | alerts you |
| `turn/end` (reason=completed/max-tokens) | `attention` | celebrates |
| `turn/end` (reason=error), `agent/error`, tool failure | `error` | error |
| `compaction/start` (context compaction) | `sweeping` | sweeping |
| session disposed / DSH shutdown | `sleeping` | card removed |

Subagent sessions fold into their parent session (`SubagentStart`/`SubagentStop`) so the HUD stays clean. Turn completions carry the last assistant message text (`assistant_last_output`), the model name, and a context-usage estimate (`context_usage`).

## How it works

```
DSH session firehose                    dsh-clawd-pet (Cordis plugin)              Clawd on Desk
─────────────────────────              ──────────────────────────────             ──────────────
session/created ──────────┐            ┌──────────────────────────┐   POST /state   ┌─────────────┐
session/event   ──────────┼──────────▶ │ event → Clawd state map   │ ─────────────▶ │ local HTTP  │
agent/error     ──────────┘            │ agent id resolve          │  x-clawd-server │ server      │
session/disposed                       │ port autodiscovery        │  200/204/400   │ 127.0.0.1   │
                                       │ throttle + serial queue   │                │ :23333-23337│
                                       │ fire-and-forget POSTs     │                └─────────────┘
                                       └──────────────────────────┘
```

- **Wire protocol** was reverse-engineered from Clawd on Desk's `hooks/server-config.js`, `src/server-route-state.js`, `src/custom-applications.js`: `/state` POST with the `x-clawd-server: clawd-on-desk` header check; 200 = accepted, 204 = dropped (agent id unknown/disabled), 400 = unknown state.
- **Agent id** is deterministic: `custom-<slug>-<sha256(lower(exePath))[:12]>` on Windows, mirroring Clawd's `custom-applications.js` hashing — so the id the plugin computes always matches what Clawd registers for the same executable.
- **Session adoption** — on plugin load, already-open sessions are adopted (`sessions.list()`), so the pet recovers after host restarts.
- **Teardown** — on dispose the plugin best-effort posts `sleeping`; even if that is lost, Clawd's `agent_pid` liveness check reaps cards when the DSH process exits.

## Prerequisites

> **Availability note — read this first.** This repository only contains the DSH-side plugin. It does **not** bundle the Clawd on Desk app itself, and at the time of writing Clawd on Desk is distributed through a closed channel (private GitHub Releases / its own updater, v0.15.0 observed), *not* a public download — the `anthropics/clawd-on-desk` GitHub link that is sometimes cited does not resolve publicly. DSH Desktop itself is likewise not a public open-source download. If you cannot obtain the Clawd on Desk app, the pet will not appear no matter how this plugin is installed; treat this plugin as a remote control for an app you already have.

1. Clawd on Desk installed and running (local server on port 23333–23337, recorded in `~/.clawd/runtime.json`).
2. DSH registered in Clawd as a **custom application** (Settings → Agents → add custom application; pick `DSH Desktop.exe` or its folder — both resolve identically). The id is deterministic: `custom-dsh-desktop-<sha256(lowercased exe path)[:12]>`.
3. DSH Desktop 2.x (desktop profile at `~/.dsh/profiles/desktop`).

## Install

```bash
cd dsh-clawd-pet && pnpm install
dsh plugin --profile desktop add /abs/path/to/dsh-clawd-pet
# then restart DSH Desktop
```

> Note: `dsh plugin add`'s pnpm argument forwarding breaks on paths with spaces/full-width characters. If your checkout lives under such a path (as on this machine), install manually: add `"dsh-clawd-pet": "link:<abs path>"` to `~/.dsh/profiles/desktop/package.json` dependencies, append `"dsh-clawd-pet"` to `dsh.profile.bundles`, then run `pnpm install` inside the profile directory.

## Verify

```bash
dsh --profile desktop --dump-config | grep clawd        # composition includes the plugin row
node test/e2e.mjs                                        # live protocol + animation test against Clawd
```

## Configuration (Web settings → plugins → clawd-pet)

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `agentId` | `""` | force a Clawd agent id (empty = auto: match Clawd's registered custom app, else compute from this host exe) |
| `port` | `0` | force Clawd port (0 = autodiscover) |
| `subagents` | `true` | map subagents to juggling |
| `contextUsage` | `true` | report context-usage estimate (HUD ring) |
| `toolFailures` | `true` | play a one-shot error animation on single tool failures |
| `completionText` | `true` | attach the final assistant message on completion |
| `minIntervalMs` | `200` | per-session throttle window (state transitions bypass it) |
| `timeoutMs` | `1200` | POST timeout |

## Project structure

```
dsh-clawd-pet/
├── index.js               # Cordis plugin: config schema, event handling, state machine
├── lib/
│   └── clawd-client.js    # Clawd local-server client: id hashing, port discovery, POST/probe
├── test/
│   ├── smoke.mjs          # plugin loads with a mocked session store
│   ├── mapping.mjs        # DSH event → Clawd state mapping unit tests
│   ├── clawd-id-roundtrip.mjs  # custom-application id hash roundtrip
│   ├── live-protocol.mjs  # protocol against a running Clawd (if any)
│   ├── e2e.mjs            # live protocol + animation test against Clawd
│   └── ...
├── cordis.patch.yml       # DSH bundle patch metadata
├── package.json
└── README.md / README.zh.md
```

## Development

```bash
pnpm install
node test/smoke.mjs          # offline smoke test, no Clawd needed
node test/mapping.mjs        # state-mapping unit tests
node test/e2e.mjs            # requires Clawd on Desk running
```

Contributions welcome: keep the plugin dependency-free (Node built-ins only), keep reporting non-blocking, and add a test for every new event mapping.

## Troubleshooting

- **Pet never reacts**: Clawd running? (`~/.clawd/runtime.json`, probe `/state`.) DSH Desktop restarted after install? (log line `clawd-pet: loaded`.)
- **Log says "dropping our events"**: agent id not registered/disabled in Clawd → register DSH Desktop in Clawd settings and restart Clawd.
- **Uninstall**: `dsh plugin --profile desktop remove dsh-clawd-pet`, restart DSH Desktop; remove the custom application in Clawd.

## Implementation notes

- Protocol reverse-engineered from Clawd on Desk's `hooks/server-config.js`, `src/server-route-state.js`, `src/custom-applications.js`: local HTTP wire format (`/state` POST, `x-clawd-server` header, 200/204/400 semantics) and the custom-application id hash (`custom-<slug>-sha256(lower(exePath))[:12]` on Windows).
- Zero-footprint: modifies no existing DSH/Clawd files. Reporting failures only log — the agent loop is never blocked (fire-and-forget POSTs on a serial queue).
- On dispose it best-effort posts `sleeping`; even if that is lost, Clawd's `agent_pid` liveness check reaps cards when the DSH process exits.

## Changelog

### 0.1.0 (2026-08-16)

- Initial release: full DSH → Clawd state mapping, subagent/workflow folding, approval notifications, context-usage ring, completion text, port/agent-id autodiscovery, session adoption, zero-footprint teardown.

## Related

- Clawd on Desk — the desktop pet this plugin drives (closed distribution; obtain it from its official updater channel)
- DeepSeek Harness (DSH) — the agent harness this plugin runs inside (DSH Desktop 2.x)

## License

MIT
