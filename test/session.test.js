/**
 * Reading the log: what survives a bad line, and where a session id comes from.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseSessionLog } from '../src/session.js'

import { FIXTURE_SESSION_ID, fixtureText } from './helpers.js'

test('a line that is not JSON is counted and skipped, not thrown', () => {
  const { events, malformed } = parseSessionLog(fixtureText())

  assert.deepEqual(malformed, [5])
  // Every line but the unparseable one is kept, header included.
  assert.equal(events.length, 14)
  assert.equal(events.at(-1).type, 'turn/end')
})

test('the header line names the session', () => {
  const { sessionId } = parseSessionLog(fixtureText())

  assert.equal(sessionId, FIXTURE_SESSION_ID)
})

test('a log with no header reports no session id', () => {
  const { sessionId, events } = parseSessionLog(
    '{"type":"turn/start","seq":1,"time":10,"data":{"turn":1}}\n',
  )

  assert.equal(sessionId, null)
  assert.equal(events.length, 1)
})

test("an event's own id is not mistaken for the session's", () => {
  const { sessionId } = parseSessionLog('{"type":"turn/start","id":"evt-1","seq":1,"data":{}}\n')

  assert.equal(sessionId, null)
})

test('a header spelling the id `id` or `sessionId` is read', () => {
  assert.equal(parseSessionLog('{"id":"sess-a"}\n').sessionId, 'sess-a')
  assert.equal(parseSessionLog('{"sessionId":"sess-b"}\n').sessionId, 'sess-b')
  assert.equal(parseSessionLog('{"data":{"session_id":"sess-c"}}\n').sessionId, 'sess-c')
})

test('blank lines are neither events nor malformed', () => {
  const { events, malformed } = parseSessionLog('\n\n  \n{"type":"turn/start","seq":1}\n')

  assert.equal(events.length, 1)
  assert.deepEqual(malformed, [])
})

test('a JSON line that is not an object is malformed', () => {
  const { events, malformed } = parseSessionLog('[1,2]\n"text"\n{"type":"turn/start"}\n')

  assert.deepEqual(malformed, [1, 2])
  assert.equal(events.length, 1)
})
