# claude-code-mqtt

MQTT channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Bridges MQTT messages directly into Claude Code sessions — enabling cross-session communication, Home Assistant integration, and IoT-triggered workflows.

## Why

If you're running multiple Claude Code sessions, they can't talk to each other. If you have Home Assistant, Frigate, or other IoT systems, they can't trigger Claude directly. MQTT solves both — it's the universal pub/sub protocol that every smart home device and automation tool already speaks.

This plugin connects a Claude Code session to any standard MQTT broker. Messages arrive as tagged events in Claude's context. Claude can read them, act on them, and publish back.

## The gating model

An MQTT broker on a busy network can have hundreds of messages per second. If all of that landed in Claude's context, the session would be overwhelmed. So messages are filtered into three tiers:

| Tier | Behavior |
|---|---|
| **Admitted** | Flows into Claude's context in real time |
| **Watched** | Buffered silently — Claude pulls via `inbox` when it wants |
| **Muted** | Silently dropped, never buffered |
| **Everything else** | Discarded |

Agents stay lean by default. They only see what they've explicitly opted into.

Admission, watch, and mute lists persist across session restarts in a JSON config file. Each session gets its own config — the email session admits different things than the coding session.

## Health monitoring

Each session publishes a retained status message to `chachi/sessions/<name>/status` with a `lastSeen` timestamp updated every 60 seconds (configurable). On clean shutdown, status flips to `offline`. On crash, MQTT's Last Will & Testament does it automatically.

Any coordinator can passively monitor agent health by reading retained status messages — no ping/response protocol needed:

- `status: online` + recent `lastSeen` → healthy
- `status: offline` → graceful shutdown or LWT fired
- `status: online` + stale `lastSeen` → frozen/hung, needs attention

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- An MQTT broker (e.g., [Mosquitto](https://mosquitto.org/)) — if you run Home Assistant, you probably already have one
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

### Install

```bash
git clone https://github.com/mattstein111/claude-code-mqtt.git
cd claude-code-mqtt
bun install
```

### Configure

```bash
cp .env.example .env
# Edit .env with your broker URL and credentials
```

### Run

```bash
SESSION_NAME=primary claude --dangerously-load-development-channels server:mqtt
```

The session name identifies this agent on the network. Other sessions (or anything that can publish to MQTT) can send messages to `chachi/sessions/primary/inbox`.

## Tools

| Tool | Description |
|---|---|
| `publish` | Send a message to any MQTT topic |
| `reply` | Publish a response to a topic |
| `admit` | Allow a sender/topic to flow directly into context (persists) |
| `mute` | Silently drop messages from a sender/topic (persists) |
| `watch` | Buffer messages from a topic for on-demand reading |
| `inbox` | Read buffered messages from watched topics |
| `unadmit` | Remove from admitted list |
| `unmute` | Remove from muted list |
| `unwatch` | Stop watching, clear buffer |
| `config` | View or update session settings |
| `subscribe` | Subscribe to a new MQTT topic at runtime |
| `unsubscribe` | Unsubscribe from a topic |

## Cross-session messaging

Session A can message session B by publishing to `chachi/sessions/B/inbox`. Session B admits session A, and messages flow in real time. They coordinate without human involvement.

```
Session A (email)  →  publish to chachi/sessions/coding/inbox
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
| `QOS` | `1` | MQTT QoS level (0, 1, or 2) |
| `HEARTBEAT_INTERVAL` | `60` | Seconds between status heartbeats |

### Session config (JSON)

```json
{
  "admitted": ["chachi/sessions/primary/inbox"],
  "muted": [],
  "watched": [],
  "bufferMaxAge": 3600,
  "bufferMaxPerTopic": 50
}
```

## License

MIT
