#!/usr/bin/env bun
/**
 * MQTT channel plugin for Claude Code.
 *
 * Bridges MQTT messages into Claude Code sessions via the MCP channel protocol.
 * Three tiers: admitted = real-time into context, watched = buffered for pull,
 * muted = silently dropped. Everything else is discarded. Agents stay lean by
 * default and only pull context when they need it.
 *
 * Launch: SESSION_NAME=my-session claude --dangerously-load-development-channels server:mqtt
 *
 * State lives in ~/.claude/channels/mqtt/:
 *   .env            — broker connection
 *   sessions/<name>.json — per-session admissions, mutes, and buffer config
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import mqtt from 'mqtt'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ── Configuration ────────────────────────────────────────────────────────────

const STATE_DIR = process.env.MQTT_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'mqtt')
const ENV_FILE = join(STATE_DIR, '.env')

// Load .env into process.env (real env wins)
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const BROKER_URL = process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883'
const MQTT_USERNAME = process.env.MQTT_USERNAME
const MQTT_PASSWORD = process.env.MQTT_PASSWORD
const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX ?? 'claude'
const QOS = parseInt(process.env.QOS ?? '1', 10) as 0 | 1 | 2
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL ?? '60', 10) * 1000  // default: 60s
const REQUEST_TIMEOUT = parseInt(process.env.MQTT_REQUEST_TIMEOUT ?? '120', 10) * 1000  // default: 120s
const MAX_PAYLOAD_BYTES = parseInt(process.env.MQTT_MAX_PAYLOAD_BYTES ?? String(20 * 1024 * 1024), 10) // default: 20MB
const MAX_PENDING_REQUESTS = parseInt(process.env.MQTT_MAX_PENDING_REQUESTS ?? '50', 10) // default: 50

// Sanitize session name to prevent path traversal
const RAW_SESSION_NAME = process.env.SESSION_NAME ?? 'default'
const SESSION_NAME = RAW_SESSION_NAME.replace(/[^a-zA-Z0-9_-]/g, '')
if (SESSION_NAME !== RAW_SESSION_NAME) {
  process.stderr.write(`[mqtt-channel] WARNING: SESSION_NAME sanitized from "${RAW_SESSION_NAME}" to "${SESSION_NAME}"\n`)
}
if (SESSION_NAME.length === 0) {
  process.stderr.write(`[mqtt-channel] ERROR: SESSION_NAME is empty after sanitization\n`)
  process.exit(1)
}

const log = (msg: string) => process.stderr.write(`[mqtt-channel:${SESSION_NAME}] ${msg}\n`)

// ── Topic helpers ────────────────────────────────────────────────────────────

const topics = {
  inbox: () => `${TOPIC_PREFIX}/sessions/${SESSION_NAME}/inbox`,
  status: () => `${TOPIC_PREFIX}/sessions/${SESSION_NAME}/status`,
  sessionInbox: (name: string) => `${TOPIC_PREFIX}/sessions/${name}/inbox`,
}

// ── Per-session config (persists across restarts) ────────────────────────────

const SESSIONS_DIR = join(STATE_DIR, 'sessions')
mkdirSync(SESSIONS_DIR, { recursive: true })
const SESSION_CONFIG_FILE = join(SESSIONS_DIR, `${SESSION_NAME}.json`)

interface SessionConfig {
  admitted: string[]       // sender names or topic patterns that flow directly into context
  muted: string[]          // sender names or topic patterns to silently drop
  watched: string[]        // topic patterns to buffer on-demand (pull model — agent must explicitly watch)
  bufferMaxAge: number     // max age in seconds before buffer entries are dropped (default: 3600)
  bufferMaxPerTopic: number // max buffered messages per topic (default: 50)
}

function loadSessionConfig(): SessionConfig {
  try {
    return { ...defaultConfig(), ...JSON.parse(readFileSync(SESSION_CONFIG_FILE, 'utf8')) }
  } catch {
    return defaultConfig()
  }
}

function defaultConfig(): SessionConfig {
  return {
    admitted: [topics.inbox()],  // always admit our own inbox
    muted: [],
    watched: [],
    bufferMaxAge: 3600,
    bufferMaxPerTopic: 50,
  }
}

function saveSessionConfig(config: SessionConfig) {
  writeFileSync(SESSION_CONFIG_FILE, JSON.stringify(config, null, 2))
}

const sessionConfig = loadSessionConfig()

// ── Message buffer ───────────────────────────────────────────────────────────

interface BufferedMessage {
  topic: string
  sender: string
  content: string
  timestamp: string
}

const buffer = new Map<string, BufferedMessage[]>()  // topic → messages

function bufferMessage(msg: BufferedMessage) {
  const topic = msg.topic
  if (!buffer.has(topic)) buffer.set(topic, [])
  const topicBuf = buffer.get(topic)!
  topicBuf.push(msg)

  // Enforce max per topic
  while (topicBuf.length > sessionConfig.bufferMaxPerTopic) {
    topicBuf.shift()
  }

  // Enforce max age
  const cutoff = Date.now() - sessionConfig.bufferMaxAge * 1000
  while (topicBuf.length > 0 && new Date(topicBuf[0].timestamp).getTime() < cutoff) {
    topicBuf.shift()
  }

  if (topicBuf.length === 0) buffer.delete(topic)
}

function isAdmitted(sender: string, topic: string): boolean {
  return sessionConfig.admitted.some(pattern => {
    // Match by sender name
    if (sender === pattern) return true
    // Match by topic pattern (simple prefix with # wildcard)
    const prefix = pattern.replace(/#$/, '')
    if (topic === pattern || topic.startsWith(prefix)) return true
    return false
  })
}

function isMuted(sender: string, topic: string): boolean {
  return sessionConfig.muted.some(pattern => {
    if (sender === pattern) return true
    const prefix = pattern.replace(/#$/, '')
    if (topic === pattern || topic.startsWith(prefix)) return true
    return false
  })
}

function isWatched(sender: string, topic: string): boolean {
  return sessionConfig.watched.some(pattern => {
    if (sender === pattern) return true
    const prefix = pattern.replace(/#$/, '')
    if (topic === pattern || topic.startsWith(prefix)) return true
    return false
  })
}

// ── Pending requests (correlation ID tracking) ───────────────────────────────

interface PendingRequest {
  correlationId: string
  replyTopic: string
  resolve: (response: string) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingRequests = new Map<string, PendingRequest>()

// ── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'mqtt', version: '0.2.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      `You are session "${SESSION_NAME}". Messages from MQTT arrive as <channel source="mqtt" topic="..." sender="..." ts="...">. Only admitted senders/topics reach you directly — everything else is silently discarded.`,
      '',
      'Message flow: admitted = real-time into context, muted = silently dropped, watched = buffered for on-demand reading, everything else = discarded.',
      '',
      'Tools:',
      '  reply/publish — send messages to MQTT topics',
      '  request — send a message and wait for a correlated response (synchronous request/reply pattern)',
      '  admit — allow a sender or topic to flow directly into context (persists)',
      '  mute — silently drop messages from a sender or topic (persists)',
      '  watch — buffer messages from a topic for on-demand reading (pull model)',
      '  inbox — read buffered messages from watched topics',
      '  config — view or update session settings',
      '',
      `To message another session: publish to ${TOPIC_PREFIX}/sessions/<name>/inbox`,
      `Your inbox: ${topics.inbox()}`,
      '',
      'For request/reply: use the request tool which sends a message with a correlation_id',
      'and waits for a response on your inbox with the same correlation_id.',
    ].join('\n'),
  },
)

// ── Tools ────────────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Publish a response to an MQTT topic.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'MQTT topic to publish to' },
          text: { type: 'string', description: 'Message content' },
          correlation_id: { type: 'string', description: 'Optional correlation ID if replying to a request' },
        },
        required: ['topic', 'text'],
      },
    },
    {
      name: 'publish',
      description: 'Publish a message to any MQTT topic. Use raw=true to send the text as-is without the JSON envelope.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'MQTT topic' },
          text: { type: 'string', description: 'Message content' },
          retain: { type: 'boolean', description: 'Retain the message on the broker (default: false)' },
          raw: { type: 'boolean', description: 'Send text as-is without JSON envelope (default: false)' },
        },
        required: ['topic', 'text'],
      },
    },
    {
      name: 'request',
      description: 'Send a message to another session and wait for a correlated response. Use this for task delegation where you need a result back.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Target session name (publishes to their inbox)' },
          text: { type: 'string', description: 'The request message' },
          timeout: { type: 'number', description: `Timeout in seconds (default: ${REQUEST_TIMEOUT / 1000})` },
        },
        required: ['target', 'text'],
      },
    },
    {
      name: 'inbox',
      description: 'Read buffered messages from watched topics. Only topics added via "watch" will have messages here.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Read messages from this specific topic (omit for summary of all watched topics)' },
          clear: { type: 'boolean', description: 'Clear the buffer for this topic after reading' },
        },
      },
    },
    {
      name: 'watch',
      description: 'Start buffering messages from a topic for on-demand reading via inbox. Pull model — messages accumulate silently until you read them. Persists across restarts.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Sender name or topic pattern to watch (e.g., "homeassistant/sensor/temperature")' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'unwatch',
      description: 'Stop buffering messages from a topic. Clears any buffered messages for this pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern to stop watching' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'admit',
      description: 'Allow a sender or topic pattern to flow directly into context. Persists across session restarts.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: `Sender name or topic pattern (e.g., "session-b" or "${TOPIC_PREFIX}/sessions/session-b/#")` },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'mute',
      description: 'Silently drop messages from a sender or topic. Not even buffered. Persists across restarts.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Sender name or topic pattern to mute' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'unadmit',
      description: 'Remove a sender or topic from the admitted list. Messages will be discarded unless also watched.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern to remove from admitted list' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'unmute',
      description: 'Remove a sender or topic from the muted list.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern to remove from muted list' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'config',
      description: 'View or update session configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          bufferMaxAge: { type: 'number', description: 'Max age in seconds for buffered messages' },
          bufferMaxPerTopic: { type: 'number', description: 'Max messages per topic in buffer' },
        },
      },
    },
    {
      name: 'subscribe',
      description: 'Subscribe to a new MQTT topic at runtime.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'MQTT topic or pattern (supports + and # wildcards)' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'unsubscribe',
      description: 'Unsubscribe from an MQTT topic.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'MQTT topic to unsubscribe from' },
        },
        required: ['topic'],
      },
    },
  ],
}))

const activeSubscriptions = new Set<string>([
  topics.inbox(),
])

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
  const err = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true })

  try {
    switch (req.params.name) {
      case 'reply':
      case 'publish': {
        const topic = args.topic as string
        const msg = args.text as string
        const retain = (args.retain as boolean) ?? false
        const correlationId = args.correlation_id as string | undefined
        const raw = (args.raw as boolean) ?? false
        const payload = raw ? msg : JSON.stringify({
          sender: SESSION_NAME,
          ts: new Date().toISOString(),
          content: msg,
          ...(correlationId && { correlation_id: correlationId }),
        })
        mqttClient.publish(topic, payload, { qos: QOS, retain })
        return text(`Published to ${topic}${raw ? ' (raw)' : ''}`)
      }

      case 'request': {
        if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
          return err(`Too many pending requests (${MAX_PENDING_REQUESTS}). Wait for existing requests to complete.`)
        }
        const target = args.target as string
        const msg = args.text as string
        const timeoutSecs = (args.timeout as number) ?? (REQUEST_TIMEOUT / 1000)
        const correlationId = randomUUID().slice(0, 8)
        const targetTopic = topics.sessionInbox(target)

        // Publish the request with correlation_id and reply_to
        mqttClient.publish(targetTopic, JSON.stringify({
          sender: SESSION_NAME,
          ts: new Date().toISOString(),
          content: msg,
          correlation_id: correlationId,
          reply_to: topics.inbox(),
        }), { qos: QOS })

        log(`[request] Sent to ${target} (correlation: ${correlationId}): ${msg.substring(0, 80)}`)

        // Wait for correlated response
        try {
          const response = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingRequests.delete(correlationId)
              reject(new Error(`Request to ${target} timed out after ${timeoutSecs}s`))
            }, timeoutSecs * 1000)

            pendingRequests.set(correlationId, {
              correlationId,
              replyTopic: topics.inbox(),
              resolve,
              timer,
            })
          })

          return text(`Response from ${target}: ${response}`)
        } catch (e) {
          return err(`${e}`)
        }
      }

      case 'inbox': {
        const topic = args.topic as string | undefined
        const clear = (args.clear as boolean) ?? false

        if (topic) {
          const msgs = buffer.get(topic) ?? []
          if (clear) buffer.delete(topic)
          if (msgs.length === 0) return text(`No buffered messages on ${topic}`)
          const formatted = msgs.map(m => `[${m.timestamp}] ${m.sender}: ${m.content}`).join('\n')
          return text(`${msgs.length} message(s) on ${topic}:\n${formatted}`)
        }

        // Summary view
        if (buffer.size === 0) return text('Buffer is empty — no pending messages.')
        const lines: string[] = []
        for (const [t, msgs] of buffer.entries()) {
          const senders = [...new Set(msgs.map(m => m.sender))].join(', ')
          lines.push(`${t}: ${msgs.length} message(s) from ${senders}`)
        }
        return text(`Buffered messages:\n${lines.join('\n')}`)
      }

      case 'admit': {
        const pattern = args.pattern as string
        if (!sessionConfig.admitted.includes(pattern)) {
          sessionConfig.admitted.push(pattern)
          saveSessionConfig(sessionConfig)
        }
        if (!activeSubscriptions.has(pattern)) {
          mqttClient.subscribe(pattern, { qos: QOS })
          activeSubscriptions.add(pattern)
        }
        return text(`Admitted "${pattern}" — messages will flow directly into context. Persisted.`)
      }

      case 'unadmit': {
        const pattern = args.pattern as string
        sessionConfig.admitted = sessionConfig.admitted.filter(p => p !== pattern)
        saveSessionConfig(sessionConfig)
        if (!sessionConfig.watched.includes(pattern)) {
          mqttClient.unsubscribe(pattern)
          activeSubscriptions.delete(pattern)
        }
        return text(`Removed "${pattern}" from admitted list. Messages will be buffered.`)
      }

      case 'mute': {
        const pattern = args.pattern as string
        if (!sessionConfig.muted.includes(pattern)) {
          sessionConfig.muted.push(pattern)
          saveSessionConfig(sessionConfig)
        }
        return text(`Muted "${pattern}" — messages will be silently dropped. Persisted.`)
      }

      case 'unmute': {
        const pattern = args.pattern as string
        sessionConfig.muted = sessionConfig.muted.filter(p => p !== pattern)
        saveSessionConfig(sessionConfig)
        return text(`Unmuted "${pattern}".`)
      }

      case 'watch': {
        const pattern = args.pattern as string
        if (!sessionConfig.watched.includes(pattern)) {
          sessionConfig.watched.push(pattern)
          saveSessionConfig(sessionConfig)
        }
        if (!activeSubscriptions.has(pattern)) {
          mqttClient.subscribe(pattern, { qos: QOS })
          activeSubscriptions.add(pattern)
        }
        return text(`Watching "${pattern}" — messages will buffer silently. Use inbox to read them.`)
      }

      case 'unwatch': {
        const pattern = args.pattern as string
        sessionConfig.watched = sessionConfig.watched.filter(p => p !== pattern)
        saveSessionConfig(sessionConfig)
        if (!sessionConfig.admitted.includes(pattern)) {
          mqttClient.unsubscribe(pattern)
          activeSubscriptions.delete(pattern)
        }
        // Clear any buffered messages for this pattern
        for (const topic of buffer.keys()) {
          const prefix = pattern.replace(/#$/, '')
          if (topic === pattern || topic.startsWith(prefix)) {
            buffer.delete(topic)
          }
        }
        return text(`Stopped watching "${pattern}". Buffer cleared.`)
      }

      case 'config': {
        if (args.bufferMaxAge !== undefined) {
          sessionConfig.bufferMaxAge = args.bufferMaxAge as number
          saveSessionConfig(sessionConfig)
        }
        if (args.bufferMaxPerTopic !== undefined) {
          sessionConfig.bufferMaxPerTopic = args.bufferMaxPerTopic as number
          saveSessionConfig(sessionConfig)
        }
        return text(JSON.stringify(sessionConfig, null, 2))
      }

      case 'subscribe': {
        const topic = args.topic as string
        mqttClient.subscribe(topic, { qos: QOS })
        activeSubscriptions.add(topic)
        return text(`Subscribed to ${topic}`)
      }

      case 'unsubscribe': {
        const topic = args.topic as string
        mqttClient.unsubscribe(topic)
        activeSubscriptions.delete(topic)
        return text(`Unsubscribed from ${topic}`)
      }

      default:
        return err(`Unknown tool: ${req.params.name}`)
    }
  } catch (e) {
    return err(`Error: ${e}`)
  }
})

// ── MQTT Client ──────────────────────────────────────────────────────────────

const mqttClient = mqtt.connect(BROKER_URL, {
  clientId: `claude-${SESSION_NAME}-${Date.now()}`,
  clean: true,
  ...(MQTT_USERNAME && { username: MQTT_USERNAME }),
  ...(MQTT_PASSWORD && { password: MQTT_PASSWORD }),
  will: {
    topic: topics.status(),
    payload: Buffer.from(JSON.stringify({ status: 'offline', ts: new Date().toISOString() })),
    qos: 1,
    retain: true,
  },
})

log(`Connecting to ${BROKER_URL}...`)

const startedAt = new Date().toISOString()

function publishStatus() {
  mqttClient.publish(
    topics.status(),
    JSON.stringify({ status: 'online', lastSeen: new Date().toISOString(), startedAt, session: SESSION_NAME }),
    { qos: 1, retain: true },
  )
}

mqttClient.on('connect', () => {
  log('Connected to broker')
  // Subscribe to persisted admitted/watched topics
  for (const pattern of [...sessionConfig.admitted, ...sessionConfig.watched]) {
    if (!activeSubscriptions.has(pattern)) activeSubscriptions.add(pattern)
  }
  for (const topic of activeSubscriptions) {
    mqttClient.subscribe(topic, { qos: QOS }, (e) => {
      if (e) log(`Subscribe error for ${topic}: ${e}`)
      else log(`Subscribed to ${topic}`)
    })
  }
  publishStatus()
})

// Heartbeat — update lastSeen on retained status message every HEARTBEAT_INTERVAL
const heartbeat = setInterval(publishStatus, HEARTBEAT_INTERVAL)

mqttClient.on('error', (e) => log(`MQTT error: ${e.message}`))
mqttClient.on('reconnect', () => log('Reconnecting...'))

// ── Inbound message handler ─────────────────────────────────────────────────

mqttClient.on('message', async (topic: string, payload: Buffer) => {
  // Reject oversized payloads
  if (payload.length > MAX_PAYLOAD_BYTES) {
    log(`[dropped] Payload too large (${(payload.length / 1024 / 1024).toFixed(1)}MB) on ${topic}`)
    return
  }

  let sender = 'unknown'
  let content = ''
  let correlationId: string | undefined
  let replyTo: string | undefined

  try {
    const msg = JSON.parse(payload.toString())
    sender = msg.sender ?? 'unknown'
    content = msg.content ?? payload.toString()
    correlationId = msg.correlation_id
    replyTo = msg.reply_to
  } catch {
    content = payload.toString()
  }

  // Don't echo our own messages
  if (sender === SESSION_NAME) return

  // Check if this is a response to a pending request
  if (correlationId && pendingRequests.has(correlationId)) {
    const pending = pendingRequests.get(correlationId)!
    clearTimeout(pending.timer)
    pendingRequests.delete(correlationId)
    log(`[response] Received correlated response (${correlationId}) from ${sender}`)
    pending.resolve(content)
    return
  }

  // Muted → silently drop
  if (isMuted(sender, topic)) return

  const timestamp = new Date().toISOString()

  // Build meta with standard fields + request context if present
  const meta: Record<string, string> = { source: 'mqtt', topic, sender, ts: timestamp }
  if (correlationId) meta.correlation_id = correlationId
  if (replyTo) meta.reply_to = replyTo

  // Admitted → push directly into Claude's context
  if (isAdmitted(sender, topic)) {
    log(`[admitted] ${sender} on ${topic}: ${content.substring(0, 80)}`)
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content, meta },
      })
      return
    } catch (e) {
      log(`Failed to push notification, buffering instead: ${e}`)
      bufferMessage({ topic, sender, content, timestamp })
      return
    }
  }

  // Watched → buffer silently for on-demand reading
  if (isWatched(sender, topic)) {
    log(`[watched] ${sender} on ${topic}: ${content.substring(0, 80)}`)
    bufferMessage({ topic, sender, content, timestamp })
    return
  }

  // Not admitted, not watched → discard
  log(`[discarded] ${sender} on ${topic}`)
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

function shutdown() {
  log('Shutting down...')
  clearInterval(heartbeat)

  // Clean up pending requests
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer)
    pending.resolve('Session shutting down')
    pendingRequests.delete(id)
  }

  mqttClient.publish(
    topics.status(),
    JSON.stringify({ status: 'offline', lastSeen: new Date().toISOString(), startedAt, session: SESSION_NAME }),
    { qos: 1, retain: true },
    () => { mqttClient.end(); process.exit(0) },
  )
}

process.on('unhandledRejection', (e) => log(`Unhandled rejection: ${e}`))
process.on('uncaughtException', (e) => log(`Uncaught exception: ${e}`))
process.stdin.on('end', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Start ────────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
log(`MCP ready — session "${SESSION_NAME}" (prefix: ${TOPIC_PREFIX})`)
