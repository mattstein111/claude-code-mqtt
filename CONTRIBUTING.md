# Contributing

Thanks for your interest in contributing to claude-code-mqtt!

## Development

```bash
git clone https://github.com/mattstein111/claude-code-mqtt.git
cd claude-code-mqtt
bun install
bun run dev  # watch mode
```

## Testing against a local broker

```bash
# Start Mosquitto (or any MQTT broker)
mosquitto -c /path/to/mosquitto.conf

# In another terminal, watch all traffic
mosquitto_sub -h localhost -t "#" -v

# Publish a test message
mosquitto_pub -h localhost -t "claude/sessions/default/inbox" \
  -m '{"sender":"test","content":"hello"}'
```

## Code style

- TypeScript, single file (`server.ts`) — keep it that way unless complexity demands otherwise
- Minimal dependencies
- Run `bun run lint` and `bun run typecheck` before submitting

## Pull requests

1. Fork the repo and create a branch from `main`
2. Make your changes — one logical change per commit
3. Run lint and typecheck
4. Open a PR with a clear description of what and why

## Issues

Use [GitHub Issues](https://github.com/mattstein111/claude-code-mqtt/issues) for bugs and feature requests. Include reproduction steps for bugs.
