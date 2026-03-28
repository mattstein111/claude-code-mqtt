/**
 * Unit tests for server.ts logic.
 * Run: bun test
 */

import { describe, expect, test } from 'bun:test'

// ── Extract matchesPattern for testing ──────────────────────────────────────

function matchesPattern(sender: string, topic: string, pattern: string): boolean {
  if (sender === pattern) return true
  if (topic === pattern) return true
  if (pattern === '#') return true

  const patternParts = pattern.split('/')
  const topicParts = topic.split('/')

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === '#') return true
    if (i >= topicParts.length) return false
    if (patternParts[i] === '+') continue
    if (patternParts[i] !== topicParts[i]) return false
  }

  return patternParts.length === topicParts.length
}

// ── .env parser logic for testing ───────────────────────────────────────────

function parseEnvLine(line: string): { key: string; val: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx < 1) return null
  const key = trimmed.slice(0, eqIdx).trim()
  if (!/^\w+$/.test(key)) return null
  let val = trimmed.slice(eqIdx + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1)
  }
  return { key, val }
}

// ── matchesPattern tests ────────────────────────────────────────────────────

describe('matchesPattern', () => {
  describe('exact matches', () => {
    test('matches by sender name', () => {
      expect(matchesPattern('alice', 'some/topic', 'alice')).toBe(true)
    })

    test('matches by topic', () => {
      expect(matchesPattern('bob', 'claude/sessions/a/inbox', 'claude/sessions/a/inbox')).toBe(true)
    })

    test('no match when neither sender nor topic match', () => {
      expect(matchesPattern('alice', 'some/topic', 'bob')).toBe(false)
    })
  })

  describe('# multi-level wildcard', () => {
    test('bare # matches everything', () => {
      expect(matchesPattern('x', 'any/topic/here', '#')).toBe(true)
    })

    test('prefix/# matches subtopics', () => {
      expect(matchesPattern('x', 'home/sensor/temp', 'home/#')).toBe(true)
    })

    test('prefix/# matches deep subtopics', () => {
      expect(matchesPattern('x', 'home/sensor/temp/celsius', 'home/#')).toBe(true)
    })

    test('prefix/# matches immediate child', () => {
      expect(matchesPattern('x', 'home/sensor', 'home/#')).toBe(true)
    })

    test('prefix/# does not match unrelated prefix', () => {
      expect(matchesPattern('x', 'other/sensor/temp', 'home/#')).toBe(false)
    })

    test('a/b/# matches a/b/c/d', () => {
      expect(matchesPattern('x', 'a/b/c/d', 'a/b/#')).toBe(true)
    })
  })

  describe('+ single-level wildcard', () => {
    test('a/+/c matches a/b/c', () => {
      expect(matchesPattern('x', 'a/b/c', 'a/+/c')).toBe(true)
    })

    test('a/+/c matches a/xyz/c', () => {
      expect(matchesPattern('x', 'a/xyz/c', 'a/+/c')).toBe(true)
    })

    test('a/+/c does not match a/b/d', () => {
      expect(matchesPattern('x', 'a/b/d', 'a/+/c')).toBe(false)
    })

    test('a/+/c does not match a/b/c/d (too many levels)', () => {
      expect(matchesPattern('x', 'a/b/c/d', 'a/+/c')).toBe(false)
    })

    test('+/b/c matches x/b/c', () => {
      expect(matchesPattern('x', 'x/b/c', '+/b/c')).toBe(true)
    })

    test('a/+ matches a/b', () => {
      expect(matchesPattern('x', 'a/b', 'a/+')).toBe(true)
    })

    test('a/+ does not match a/b/c', () => {
      expect(matchesPattern('x', 'a/b/c', 'a/+')).toBe(false)
    })

    test('multiple + wildcards: +/+/c matches x/y/c', () => {
      expect(matchesPattern('x', 'x/y/c', '+/+/c')).toBe(true)
    })
  })

  describe('mixed + and # wildcards', () => {
    test('a/+/# matches a/b/c/d', () => {
      expect(matchesPattern('x', 'a/b/c/d', 'a/+/#')).toBe(true)
    })

    test('a/+/# matches a/b/c', () => {
      expect(matchesPattern('x', 'a/b/c', 'a/+/#')).toBe(true)
    })

    test('+/sensor/# matches home/sensor/temp/celsius', () => {
      expect(matchesPattern('x', 'home/sensor/temp/celsius', '+/sensor/#')).toBe(true)
    })
  })

  describe('edge cases', () => {
    test('pattern longer than topic does not match', () => {
      expect(matchesPattern('x', 'a/b', 'a/b/c')).toBe(false)
    })

    test('topic longer than pattern does not match (no wildcards)', () => {
      expect(matchesPattern('x', 'a/b/c', 'a/b')).toBe(false)
    })

    test('empty sender does not match non-empty pattern by sender', () => {
      expect(matchesPattern('', 'a/b', 'alice')).toBe(false)
    })

    test('single segment topic matches single segment pattern', () => {
      expect(matchesPattern('x', 'hello', 'hello')).toBe(true)
    })

    test('+ alone matches single segment topic', () => {
      expect(matchesPattern('x', 'hello', '+')).toBe(true)
    })

    test('+ alone does not match multi-segment topic', () => {
      expect(matchesPattern('x', 'a/b', '+')).toBe(false)
    })
  })
})

// ── .env parser tests ───────────────────────────────────────────────────────

describe('parseEnvLine', () => {
  test('simple key=value', () => {
    expect(parseEnvLine('FOO=bar')).toEqual({ key: 'FOO', val: 'bar' })
  })

  test('double-quoted value', () => {
    expect(parseEnvLine('FOO="bar baz"')).toEqual({ key: 'FOO', val: 'bar baz' })
  })

  test('single-quoted value', () => {
    expect(parseEnvLine("FOO='bar baz'")).toEqual({ key: 'FOO', val: 'bar baz' })
  })

  test('value with = sign', () => {
    expect(parseEnvLine('PASSWORD=abc=def=ghi')).toEqual({ key: 'PASSWORD', val: 'abc=def=ghi' })
  })

  test('skips comments', () => {
    expect(parseEnvLine('# this is a comment')).toBeNull()
  })

  test('skips empty lines', () => {
    expect(parseEnvLine('')).toBeNull()
    expect(parseEnvLine('   ')).toBeNull()
  })

  test('trims whitespace around key and value', () => {
    expect(parseEnvLine('  FOO = bar  ')).toEqual({ key: 'FOO', val: 'bar' })
  })

  test('rejects lines without =', () => {
    expect(parseEnvLine('JUSTAKEYNOVALUE')).toBeNull()
  })

  test('rejects keys with invalid chars', () => {
    expect(parseEnvLine('FOO-BAR=baz')).toBeNull()
  })

  test('quoted value with = inside', () => {
    expect(parseEnvLine('PASS="a=b=c"')).toEqual({ key: 'PASS', val: 'a=b=c' })
  })
})
