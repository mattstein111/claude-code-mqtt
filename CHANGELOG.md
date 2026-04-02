# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-04-02

### Added
- `+` single-level wildcard support in gating patterns (MQTT standard)
- `status` tool for session introspection (admitted/watched/muted lists, subscriptions, buffer stats)
- Periodic buffer sweep to evict expired messages
- Unit tests for `matchesPattern` and `.env` parser
- `unwatch` now cleans up buffered messages by sender+topic

### Changed
- Robust `.env` parser: handles quotes, comments, and `=` in values
- `reply` and `publish` tools now have feature parity
- Version reported from `package.json` instead of hardcoded
- Cleaner shutdown sequence

### Fixed
- Plugin manifest version synced with package.json

## [0.3.0] - 2026-03-27

### Added
- Raw publish mode (`raw: true`) to send messages without JSON envelope
- Auto-subscribe: `admit` and `watch` now automatically subscribe on the broker
- Input validation on all tool parameters
- Shutdown timeout (5s) to prevent hanging on broker disconnect
- Security documentation with threat model
- CONTRIBUTING.md, LICENSE, CHANGELOG.md
- Plugin packaging (.claude-plugin manifest)

### Changed
- Default max payload size reduced from 20MB to 256KB
- Correlation IDs now use full UUID instead of truncated 8-char
- `uncaughtException` handler now exits instead of continuing
- Wildcard matching tightened: `#` requires preceding `/`
- Config values validated (positive integers with upper bounds)
- `unadmit` response correctly indicates whether messages will be buffered or discarded

### Fixed
- Non-JSON inbound messages were silently dropped (#10)
- Admitted/watched topics were not subscribed on the broker (#12)

## [0.2.0] - 2026-03-26

### Added
- Request/reply tool with correlation ID tracking
- Health monitoring via retained status messages
- Last Will and Testament for crash detection
- Configurable buffer limits (max age, max per topic)
- Session name sanitization (path traversal prevention)

### Changed
- Switched from push to pull model for buffered messages

## [0.1.0] - 2026-03-25

### Added
- Initial release
- Three-tier gating model (admit/watch/mute)
- MQTT bridge with MCP channel protocol
- Per-session persistent configuration
- Cross-session messaging
