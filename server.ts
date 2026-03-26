#!/usr/bin/env bun
/**
 * MQTT channel plugin for Claude Code.
 *
 * Bridges MQTT messages into Claude Code sessions via the MCP channel protocol.
 * Enables cross-session messaging, Home Assistant integration, and IoT bridge.
 *
 * State lives in ~/.claude/channels/mqtt/ — access.json for allowlists,
 * .env for broker connection.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import mqtt from 'mqtt'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ── Configuration ────────────────────────────────────────────────────────────

const STATE_DIR = process.env.MQTT_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'mqtt')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')

// Load .env into process.env (real env wins)
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const BROKER_URL = process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883'
const MQTT_USERNAME = process.env.MQTT_USERNAME
const MQTT_PASSWORD = process.env.MQTT_PASSWORD
const SESSION_NAME = process.env.SESSION_NAME ?? 'default'
const QOS = parseInt(process.env.QOS ?? '1', 10) as 0 | 1 | 2
const SUBSCRIBE_TOPICS = (process.env.SUBSCRIBE_TOPICS ?? `chachi/sessions/${SESSION_NAME}/inbox,chachi/broadcast`)
  .split(',')
  .map(t => t.trim())
  .filter(Boolean)

const log = (msg: string) => process.stderr.write(`[mqtt-channel] ${msg}\n`)

// ── Access control ───────────────────────────────────────────────────────────

interface Access {
  allowFrom: string[]     // allowed MQTT client IDs or sender names
  allowTopics: string[]   // topic prefixes allowed to push events
}

function loadAccess(): Access {
  try {
    return JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
  } catch {
    return { allowFrom: ['*'], allowTopics: ['chachi/#'] }
  }
}

function isAllowed(sender: string, topic: string): boolean {
  const access = loadAccess()
  const senderOk = access.allowFrom.includes('*') || access.allowFrom.includes(sender)
  const topicOk = access.allowTopics.some(prefix => topic.startsWith(prefix.replace('#', '')))
  return senderOk && topicOk
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'mqtt', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'Messages from MQTT arrive as <channel source="mqtt" topic="..." sender="..." ts="...">.',
      'Use the reply tool to respond to a specific topic. Use publish to send to any topic.',
      '',
      'Topic conventions:',
      '  chachi/sessions/<name>/inbox — messages TO that session',
      '  chachi/sessions/<name>/outbox — messages FROM that session',
      '  chachi/broadcast — all sessions receive',
      '  homeassistant/# — Home Assistant events',
      '',
      'Messages are JSON with: { sender, timestamp, type, content, reply_topic? }',
      'If the message has a reply_topic, use that for responses.',
    ].join('\n'),
  },
)

// ── Tools ────────────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Publish a response to an MQTT topic. Use the reply_topic from the inbound message, or specify a topic directly.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'MQTT topic to publish to' },
          text: { type: 'string', description: 'Message content' },
        },
        required: ['topic', 'text'],
      },
    },
    {
      name: 'publish',
      description: 'Publish a message to any MQTT topic.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'MQTT topic' },
          text: { type: 'string', description: 'Message content' },
          retain: { type: 'boolean', description: 'Retain the message on the broker (default: false)' },
        },
        required: ['topic', 'text'],
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
    {
      name: 'list_subscriptions',
      description: 'List current MQTT topic subscriptions.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}))

// Track active subscriptions
const activeSubscriptions = new Set<string>(SUBSCRIBE_TOPICS)

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'reply':
      case 'publish': {
        const topic = args.topic as string
        const text = args.text as string
        const retain = (args.retain as boolean) ?? false

        const payload = JSON.stringify({
          sender: SESSION_NAME,
          timestamp: new Date().toISOString(),
          type: 'chat',
          content: text,
        })

        mqttClient.publish(topic, payload, { qos: QOS, retain })
        return { content: [{ type: 'text' as const, text: `Published to ${topic}` }] }
      }

      case 'subscribe': {
        const topic = args.topic as string
        mqttClient.subscribe(topic, { qos: QOS })
        activeSubscriptions.add(topic)
        return { content: [{ type: 'text' as const, text: `Subscribed to ${topic}` }] }
      }

      case 'unsubscribe': {
        const topic = args.topic as string
        mqttClient.unsubscribe(topic)
        activeSubscriptions.delete(topic)
        return { content: [{ type: 'text' as const, text: `Unsubscribed from ${topic}` }] }
      }

      case 'list_subscriptions': {
        const list = Array.from(activeSubscriptions).join('\n')
        return { content: [{ type: 'text' as const, text: list || '(none)' }] }
      }

      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true }
  }
})

// ── MQTT Client ──────────────────────────────────────────────────────────────

const mqttOptions: mqtt.IClientOptions = {
  clientId: `claude-code-${SESSION_NAME}-${Date.now()}`,
  clean: true,
  ...(MQTT_USERNAME && { username: MQTT_USERNAME }),
  ...(MQTT_PASSWORD && { password: MQTT_PASSWORD }),
  will: {
    topic: `chachi/sessions/${SESSION_NAME}/status`,
    payload: Buffer.from(JSON.stringify({ status: 'offline', timestamp: new Date().toISOString() })),
    qos: 1,
    retain: true,
  },
}

log(`Connecting to ${BROKER_URL} as session "${SESSION_NAME}"...`)
const mqttClient = mqtt.connect(BROKER_URL, mqttOptions)

mqttClient.on('connect', () => {
  log(`Connected to broker`)

  // Subscribe to configured topics
  for (const topic of SUBSCRIBE_TOPICS) {
    mqttClient.subscribe(topic, { qos: QOS }, (err) => {
      if (err) log(`Subscribe error for ${topic}: ${err}`)
      else log(`Subscribed to ${topic}`)
    })
  }

  // Announce presence
  mqttClient.publish(
    `chachi/sessions/${SESSION_NAME}/status`,
    JSON.stringify({ status: 'online', timestamp: new Date().toISOString(), session: SESSION_NAME }),
    { qos: 1, retain: true },
  )
})

mqttClient.on('error', (err) => {
  log(`MQTT error: ${err.message}`)
})

mqttClient.on('reconnect', () => {
  log('Reconnecting to broker...')
})

// ── Inbound message handler ─────────────────────────────────────────────────

mqttClient.on('message', async (topic: string, payload: Buffer) => {
  let sender = 'unknown'
  let content = ''
  let replyTopic = ''

  try {
    const msg = JSON.parse(payload.toString())
    sender = msg.sender ?? 'unknown'
    content = msg.content ?? payload.toString()
    replyTopic = msg.reply_topic ?? ''

    // Don't echo our own messages
    if (sender === SESSION_NAME) return
  } catch {
    // Not JSON — treat raw payload as content
    content = payload.toString()
  }

  // Access control
  if (!isAllowed(sender, topic)) {
    log(`Dropped message from "${sender}" on ${topic} (not allowed)`)
    return
  }

  log(`Message from "${sender}" on ${topic}: ${content.substring(0, 100)}`)

  // Push into Claude Code as a channel event
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          source: 'mqtt',
          topic,
          sender,
          ts: new Date().toISOString(),
          ...(replyTopic && { reply_topic: replyTopic }),
        },
      },
    })
  } catch (err) {
    log(`Failed to push notification: ${err}`)
  }
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

function shutdown() {
  log('Shutting down...')
  // Clear presence
  mqttClient.publish(
    `chachi/sessions/${SESSION_NAME}/status`,
    JSON.stringify({ status: 'offline', timestamp: new Date().toISOString() }),
    { qos: 1, retain: true },
    () => {
      mqttClient.end()
      process.exit(0)
    },
  )
}

process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err}`)
})
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err}`)
})
process.stdin.on('end', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Start MCP transport ──────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
log('MCP transport connected — MQTT channel ready')
