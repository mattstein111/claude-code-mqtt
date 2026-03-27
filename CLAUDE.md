# claude-code-mqtt

MQTT channel plugin for Claude Code. This is a **public open-source repo** — all code, docs, and issues are visible to the world.

## What this is

An MCP server (TypeScript/Bun) that bridges MQTT messages into Claude Code sessions via the channel protocol. ~560 lines, single file (`server.ts`).

### Core design: three-tier gating

| Tier | Behavior |
|---|---|
| **Admitted** | Real-time into Claude's context |
| **Watched** | Buffered silently, agent pulls via `inbox` |
| **Muted** | Silently dropped |
| **Everything else** | Discarded |

This is the key differentiator. Without gating, MQTT would flood an agent's context window in seconds.

### Health monitoring

Agents publish a retained status message with a `lastSeen` timestamp updated every `HEARTBEAT_INTERVAL` seconds (default 60). MQTT's Last Will handles crash detection. Any coordinator reads retained messages to passively monitor health — no ping/response protocol.

## Architecture

- **Single file:** `server.ts` — MCP server + MQTT client + gating logic + tools
- **Runtime:** Bun (not Node)
- **Protocol:** MCP channel protocol (`notifications/claude/channel`)
- **State:** `~/.claude/channels/mqtt/sessions/<name>.json` per session
- **Dependencies:** `@modelcontextprotocol/sdk`, `mqtt`

## Development

```bash
bun install
bun run dev          # watch mode
bun run start        # production
```

Testing against a local broker:
```bash
# Publish a test message
mosquitto_pub -h localhost -t "claude/sessions/default/inbox" \
  -m '{"sender":"test","content":"hello"}'

# Watch all traffic
mosquitto_sub -h localhost -t "#" -v
```

## Standards

- **Public repo** — no secrets, no personal IPs, no internal references. Everything in `.env`, nothing hardcoded.
- **Commits** — one logical change per commit. Clear message explaining *why*, not just *what*.
- **Issues** — use GitHub Issues for all bugs and feature requests. Follow the lifecycle: open → investigate → fix → test → close.
- **Code style** — TypeScript, minimal dependencies, no unnecessary abstractions. The whole plugin should stay readable as a single file for as long as possible.
- **README** — keep it current. If you change behavior, update the README in the same commit.
- **Versioning** — semver in `package.json`. Bump on any user-facing change.

## Key design decisions

1. **Single file over modular** — the plugin is small enough that splitting it would add complexity without benefit. Revisit if it grows past ~1000 lines.
2. **Pull over push for buffered messages** — agents should be lean by default. The previous design pushed periodic buffer summaries into context; now agents explicitly pull via `inbox` when they want it.
3. **Retained messages for health** — simpler than request/response health checks. The coordinator just reads timestamps.
4. **Per-session config** — each session has its own admission/mute/watch lists. A global default can be set but sessions diverge based on their role.
5. **No auth layer** — MQTT broker handles auth. The plugin trusts whatever the broker allows.

## What NOT to do

- Don't add features that belong in the coordinator (health check logic, agent restart, etc.) — this plugin is the *bus*, not the *brain*.
- Don't hardcode topic prefixes — the prefix is configurable via `MQTT_TOPIC_PREFIX`.
- Don't add HTTP endpoints or REST APIs — MQTT is the interface.
- Don't bundle broker configuration — users bring their own broker.
