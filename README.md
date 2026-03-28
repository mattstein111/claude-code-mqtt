# claude-code-mqtt

MQTT channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Bridges MQTT messages directly into Claude Code sessions — enabling cross-session communication, Home Assistant integration, and IoT-triggered workflows.

## Why

If you're running multiple Claude Code sessions, they can't talk to each other. If you have Home Assistant, Frigate, or other IoT systems, they can't trigger Claude directly. MQTT solves both — it's the universal pub/sub protocol that every smart home device and automation tool already speaks.

This plugin connects a Claude Code session to any standard MQTT broker. Messages arrive as tagged events in Claude's context. Claude can read them, act on them, and publish back.

## The gating model

An MQTT broker on a busy network can have hundreds of messages per second. If all of that landed in Claude's context, the session would be overwhelmed. So messages are filtered through a gating model:

| Tier | Behavior |
|---|---|
| **Admitted** | Flows into Claude's context in real time |
| **Watched** | Buffered silently — Claude pulls via `inbox` when it wants |
| **Muted** | Silently dropped, never buffered |
| **Everything else** | Discarded |

Agents stay lean by default. They only see what they've explicitly opted into.

Admission, watch, and mute lists persist across session restarts in a JSON config file. Each session gets its own config — the email session admits different things than the coding session.

**Topic matching:** Patterns support the MQTT `#` multi-level wildcard as a suffix (e.g., `homeassistant/sensor/#` matches all subtopics). The `+` single-level wildcard is not currently supported in gating patterns — use specific topic paths or `#` suffixes instead.

## Message format

### Outbound (publish)

By default, `publish` wraps messages in a JSON envelope:

```json
{"sender": "session-name", "ts": "2026-03-27T...", "content": "your message"}
```

Set `raw: true` to send the text as-is — useful for publishing to systems that expect plain strings (e.g., Home Assistant command topics):

```
publish topic="homeassistant/switch/office/set" text="ON" raw=true
```

### Inbound (receive)

The plugin accepts both formats:

- **JSON envelope** — `{"sender": "name", "content": "..."}` — sender and content are extracted
- **Plain string** — any non-JSON payload is used as content directly, with sender set to `unknown`

This means you can receive messages from systems that don't know about the envelope format (IoT devices, Home Assistant, other MQTT clients).

### Broker subscriptions

When you `admit` or `watch` a topic, the plugin automatically subscribes to it on the broker. When you `unadmit` or `unwatch`, it unsubscribes (unless the other list still needs it). Persisted topics are re-subscribed on reconnect.

## Health monitoring

Each session publishes a retained status message to `claude/sessions/<name>/status` with a `lastSeen` timestamp updated every 60 seconds (configurable). On clean shutdown, status flips to `offline`. On crash, MQTT's Last Will & Testament does it automatically.

Any coordinator can passively monitor agent health by reading retained status messages — no ping/response protocol needed:

- `status: online` + recent `lastSeen` → healthy
- `status: offline` → graceful shutdown or LWT fired
- `status: online` + stale `lastSeen` → frozen/hung, needs attention

**Note:** The Last Will timestamp is set when the client connects (an MQTT protocol limitation). If the broker delivers the LWT hours later after a crash, the `ts` field will reflect connection time, not actual disconnect time. Use `lastSeen` from the most recent heartbeat for accurate timing.

## Setup

### Quickstart

```bash
# 1. Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# 2. Install the plugin
claude plugin install mqtt@mattstein111/claude-code-mqtt

# 3. Create the config directory and .env file
mkdir -p ~/.claude/channels/mqtt
cat > ~/.claude/channels/mqtt/.env << 'EOF'
MQTT_BROKER_URL=mqtt://localhost:1883
# MQTT_USERNAME=your_user
# MQTT_PASSWORD=your_pass
EOF

# 4. Launch Claude Code with the MQTT channel
SESSION_NAME=primary claude --channels plugin:mqtt@mattstein111/claude-code-mqtt
```

### Prerequisites

- [Bun](https://bun.sh) runtime
- An MQTT broker (e.g., [Mosquitto](https://mosquitto.org/)) — if you run Home Assistant, you probably already have one
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

### Install as Claude Code plugin

```bash
claude plugin install mqtt@mattstein111/claude-code-mqtt
```

To install for a specific project only (keeps it out of your other sessions):

```bash
claude plugin install mqtt@mattstein111/claude-code-mqtt --scope local
```

Use `--scope local` when you only need MQTT in certain projects — for example, a home automation repo that talks to your broker but not your other coding sessions.

### Run

```bash
SESSION_NAME=primary claude --channels plugin:mqtt@mattstein111/claude-code-mqtt
```

The session name identifies this agent on the network. Other sessions (or anything that can publish to MQTT) can send messages to `claude/sessions/primary/inbox`.

### Configure

The plugin reads broker settings from `~/.claude/channels/mqtt/.env`:

```bash
MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_USERNAME=your_user
MQTT_PASSWORD=your_pass
```

### Install from source (development)

```bash
git clone https://github.com/mattstein111/claude-code-mqtt.git
cd claude-code-mqtt
bun install
```

Run from source using the dev channels flag:

```bash
SESSION_NAME=primary claude --dangerously-load-development-channels server:mqtt
```

## Tools

| Tool | Description |
|---|---|
| `publish` | Send a message to any MQTT topic (supports `raw` flag to skip JSON envelope) |
| `reply` | Reply to a message on an MQTT topic (same as publish, with optional correlation_id for request/reply flows) |
| `request` | Send a message and wait for a correlated response |
| `admit` | Allow a sender/topic to flow directly into context (persists) |
| `mute` | Silently drop messages from a sender/topic (persists) |
| `watch` | Buffer messages from a topic for on-demand reading |
| `inbox` | Read buffered messages from watched topics |
| `unadmit` | Remove from admitted list |
| `unmute` | Remove from muted list |
| `unwatch` | Stop watching, clear buffer |
| `config` | View or update session settings |
| `subscribe` | Subscribe to a new MQTT topic at runtime (admit/watch auto-subscribe, so this is rarely needed) |
| `unsubscribe` | Unsubscribe from a topic |

## Cross-session messaging

Session A can message session B by publishing to `claude/sessions/B/inbox`. Session B admits session A, and messages flow in real time. They coordinate without human involvement.

```
Session A (email)  →  publish to claude/sessions/coding/inbox
                          ↓
Session B (coding) ←  receives message, acts on it, replies back
```

## Home Assistant integration

Subscribe to HA topics and admit/watch what's relevant:

```
# In Claude's session:
subscribe homeassistant/sensor/#
watch homeassistant/sensor/temperature
admit homeassistant/binary_sensor/front_door
```

Temperature readings buffer silently for periodic review. Front door events flow in real time.

## Configuration

All configuration lives in `~/.claude/channels/mqtt/`:

```
.env                        # Broker connection
sessions/<name>.json        # Per-session config (auto-created)
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `MQTT_BROKER_URL` | `mqtt://localhost:1883` | Broker connection URL |
| `MQTT_USERNAME` | — | Broker auth username |
| `MQTT_PASSWORD` | — | Broker auth password |
| `SESSION_NAME` | `default` | This session's identity |
| `MQTT_TOPIC_PREFIX` | `claude` | Prefix for all session topics (inbox, status) |
| `QOS` | `1` | MQTT QoS level (0, 1, or 2) |
| `HEARTBEAT_INTERVAL` | `60` | Seconds between status heartbeats |
| `MQTT_REQUEST_TIMEOUT` | `120` | Seconds to wait for a correlated response |
| `MQTT_MAX_PAYLOAD_BYTES` | `262144` | Max inbound payload size (256KB) |
| `MQTT_MAX_PENDING_REQUESTS` | `50` | Max concurrent pending request/reply operations |
| `MQTT_STATE_DIR` | `~/.claude/channels/mqtt` | Directory for .env and session config files |

### Session config (JSON)

```json
{
  "admitted": ["claude/sessions/primary/inbox"],
  "muted": [],
  "watched": [],
  "bufferMaxAge": 3600,
  "bufferMaxPerTopic": 50
}
```

## Troubleshooting

**Messages not appearing?**
- Check that the topic is admitted (`admit`) or watched (`watch`). Messages to unmatched topics are silently discarded.
- Verify the broker is reachable: `mosquitto_pub -h <broker-host> -t test -m hello`
- Check Claude Code's stderr output for connection errors (run with `--verbose` to see MCP logs).

**Broker connection fails silently?**
- The plugin logs to stderr, not to Claude's context. If the broker is unreachable, tools will appear to work but messages won't be delivered.
- Verify your `.env` file is at `~/.claude/channels/mqtt/.env` (or the path set by `MQTT_STATE_DIR`).

**Session name was changed?**
- `SESSION_NAME` is sanitized to `[a-zA-Z0-9_-]` only. Characters like `.` or `/` are silently stripped. Set `SESSION_NAME=my-session` (hyphens and underscores are fine).

**Using a TLS broker?**
- Set `MQTT_BROKER_URL=mqtts://broker.example.com:8883` for TLS connections. The plugin uses the mqtt.js library which supports `mqtts://` URLs. For custom CA certificates or client certificates, you'll need to modify the `mqtt.connect()` options in `server.ts`.

## Security considerations

### Threat model

This plugin bridges an MQTT broker into an LLM's context window. **Any message that passes the gating filters (admitted or watched) reaches the agent.** This means:

- **Broker authentication is your perimeter.** The plugin does not add its own auth layer — it trusts whatever the broker allows. Use broker-level ACLs, username/password, or TLS client certificates to control who can publish.
- **Admitted messages flow verbatim into the agent's context.** A malicious publisher on an admitted topic could attempt prompt injection. Mitigations:
  - Only admit topics you fully control or trust
  - Use the `watch` + `inbox` pull model for untrusted sources — the agent explicitly requests these messages and can inspect them with more scrutiny
  - Keep admission lists narrow (specific topics, not broad wildcards)
- **Content size** — inbound payloads are capped at 256KB by default (`MQTT_MAX_PAYLOAD_BYTES`). Adjust this if your use case requires larger messages, but be aware that large payloads consume context window space.

### Reporting vulnerabilities

For security issues, please use [GitHub's private vulnerability reporting](https://github.com/mattstein111/claude-code-mqtt/security/advisories/new) rather than opening a public issue.

## License

MIT
