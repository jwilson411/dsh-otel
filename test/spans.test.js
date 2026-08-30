/**
 * The span tree: names, hierarchy, derived ids, timings, and attributes.
 *
 * Everything here is computed from the checked-in fixture, so the assertions
 * are also the documentation of what a given log turns into.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { parseSessionLog } from '../src/session.js'
import {
  SESSION_SPAN_NAME,
  STATUS_ERROR,
  STATUS_OK,
  STEP_SPAN_NAME,
  TOOL_SPAN_NAME,
  TURN_SPAN_NAME,
  UNKNOWN_SESSION_ID,
  attributesToObject,
  buildSpans,
  msToNano,
  spanIdFor,
  traceIdFor,
} from '../src/spans.js'

import { FIXTURE_SESSION_ID, findSpan, fixtureText } from './helpers.js'

/**
 * Build the fixture's spans.
 * @param options - Overrides for `buildSpans`.
 * @returns What `buildSpans` returned.
 */
function build(options = {}) {
  const { events } = parseSessionLog(fixtureText())
  return buildSpans(events, { sessionId: FIXTURE_SESSION_ID, ...options })
}

/**
 * @param spans - Spans to search.
 * @param name - A span name.
 * @param match - Attribute values that must all match.
 * @returns The one matching span.
 */
function one(spans, name, match = {}) {
  const span = findSpan(spans, name, match, attributesToObject)
  assert.ok(span !== undefined, `no ${name} span matching ${JSON.stringify(match)}`)
  return span
}

test('the fixture yields one session, two turns, two steps, and one tool span', () => {
  const { spans, counts } = build()

  assert.deepEqual(counts, { spans: 6, turns: 2, steps: 2, tools: 1 })
  assert.deepEqual(
    [...new Set(spans.map((span) => span.name))].sort(),
    [SESSION_SPAN_NAME, STEP_SPAN_NAME, TOOL_SPAN_NAME, TURN_SPAN_NAME].sort(),
  )
})

test('the span names are exactly the four this package documents', () => {
  const { spans } = build()

  for (const span of spans) {
    assert.ok(
      [SESSION_SPAN_NAME, TURN_SPAN_NAME, STEP_SPAN_NAME, TOOL_SPAN_NAME].includes(span.name),
      `unexpected span name ${span.name}`,
    )
  }
  assert.equal(spans.filter((span) => span.name === TURN_SPAN_NAME).length, 2)
  assert.equal(spans.filter((span) => span.name === STEP_SPAN_NAME).length, 2)
  assert.equal(spans.filter((span) => span.name === TOOL_SPAN_NAME).length, 1)
})

test('every step parents to its turn, and the tool to its step', () => {
  const { spans } = build()

  const session = one(spans, SESSION_SPAN_NAME)
  assert.equal(session.parentSpanId, undefined)

  for (const turn of [1, 2]) {
    const turnSpan = one(spans, TURN_SPAN_NAME, { 'dsh.turn': turn })
    const stepSpan = one(spans, STEP_SPAN_NAME, { 'dsh.turn': turn, 'dsh.step': 1 })

    assert.equal(turnSpan.parentSpanId, session.spanId)
    assert.equal(stepSpan.parentSpanId, turnSpan.spanId)
  }

  const step = one(spans, STEP_SPAN_NAME, { 'dsh.turn': 1 })
  const tool = one(spans, TOOL_SPAN_NAME, { 'tool.call_id': 'call_1' })
  assert.equal(tool.parentSpanId, step.spanId)
})

test('all spans share one trace id, and every span id is distinct', () => {
  const { spans, traceId } = build()

  assert.equal(traceId.length, 32)
  assert.match(traceId, /^[0-9a-f]{32}$/)
  for (const span of spans) {
    assert.equal(span.traceId, traceId)
    assert.match(span.spanId, /^[0-9a-f]{16}$/)
  }
  assert.equal(new Set(spans.map((span) => span.spanId)).size, spans.length)
})

test('the same log and session id rebuild the identical tree', () => {
  assert.deepEqual(build().spans, build().spans)
})

test('a different session id moves the whole tree to a different trace', () => {
  const mine = build()
  const other = build({ sessionId: 'sess-2' })

  assert.notEqual(mine.traceId, other.traceId)
  assert.notEqual(mine.spans[0].spanId, other.spans[0].spanId)
  assert.deepEqual(
    mine.spans.map((span) => span.name),
    other.spans.map((span) => span.name),
  )
})

test('ids are derived from the session id and the bracket key, not generated', () => {
  const { spans, traceId } = build()

  const expectedTrace = createHash('sha256')
    .update(FIXTURE_SESSION_ID, 'utf8')
    .digest('hex')
    .slice(0, 32)
  assert.equal(traceId, expectedTrace)
  assert.equal(traceIdFor(FIXTURE_SESSION_ID), expectedTrace)

  assert.equal(
    one(spans, TURN_SPAN_NAME, { 'dsh.turn': 1 }).spanId,
    spanIdFor(FIXTURE_SESSION_ID, 'turn:1'),
  )
  assert.equal(
    one(spans, STEP_SPAN_NAME, { 'dsh.turn': 1 }).spanId,
    spanIdFor(FIXTURE_SESSION_ID, 'turn:1:step:1'),
  )
  assert.equal(
    one(spans, TOOL_SPAN_NAME, {}).spanId,
    spanIdFor(FIXTURE_SESSION_ID, 'turn:1:step:1:tool:call_1'),
  )
})

test('a session with no id falls back to a documented constant', () => {
  const { traceId, spans } = build({ sessionId: null })

  assert.equal(traceId, traceIdFor(UNKNOWN_SESSION_ID))
  assert.equal(attributesToObject(spans[0].attributes)['session.id'], UNKNOWN_SESSION_ID)
})

test('spans carry the session id, the turn, the step, and the tool name', () => {
  const { spans } = build()

  const turn = attributesToObject(one(spans, TURN_SPAN_NAME, { 'dsh.turn': 1 }).attributes)
  assert.equal(turn['session.id'], FIXTURE_SESSION_ID)
  assert.equal(turn['dsh.turn'], 1)
  assert.equal(turn['dsh.turn.reason'], 'completed')
  assert.equal(turn['dsh.event.seq.start'], 1)
  assert.equal(turn['dsh.event.seq.end'], 9)

  const step = attributesToObject(one(spans, STEP_SPAN_NAME, { 'dsh.turn': 1 }).attributes)
  assert.equal(step['dsh.turn'], 1)
  assert.equal(step['dsh.step'], 1)

  const tool = attributesToObject(one(spans, TOOL_SPAN_NAME, {}).attributes)
  assert.equal(tool['session.id'], FIXTURE_SESSION_ID)
  assert.equal(tool['tool.name'], 'read_file')
  assert.equal(tool['tool.call_id'], 'call_1')
  assert.equal(tool['dsh.turn'], 1)
  assert.equal(tool['dsh.step'], 1)
})

test('reported token counts are copied onto the step, and nothing is estimated', () => {
  const { spans } = build()

  const first = attributesToObject(one(spans, STEP_SPAN_NAME, { 'dsh.turn': 1 }).attributes)
  assert.equal(first['dsh.usage.input_tokens'], 12)
  assert.equal(first['dsh.usage.output_tokens'], 4)

  const second = attributesToObject(one(spans, STEP_SPAN_NAME, { 'dsh.turn': 2 }).attributes)
  assert.equal(second['dsh.usage.input_tokens'], 40)
  assert.equal(second['dsh.usage.total_tokens'], undefined)
})

test('no span carries a prompt, a tool argument, or a tool result', () => {
  const { spans } = build()

  const rendered = JSON.stringify(spans)
  assert.ok(!rendered.includes('README.md'), 'tool arguments leaked onto a span')
  assert.ok(!rendered.includes('no such file'), 'a tool result leaked onto a span')
  assert.ok(!rendered.includes('hello'), 'a user message leaked onto a span')
})

test('a tool result reporting an error marks the span ERROR', () => {
  const { spans } = build()

  const tool = one(spans, TOOL_SPAN_NAME, {})
  assert.equal(attributesToObject(tool.attributes)['tool.error'], true)
  assert.deepEqual(tool.status, { code: STATUS_ERROR })

  assert.deepEqual(one(spans, TURN_SPAN_NAME, { 'dsh.turn': 1 }).status, { code: STATUS_OK })
})

test('a turn that ended in failure is reported ERROR, and an unknown reason is not', () => {
  const log = (reason) =>
    buildSpans(
      parseSessionLog(
        `{"type":"turn/start","seq":1,"time":10,"data":{"turn":1}}\n` +
          `{"type":"turn/end","seq":2,"time":20,"data":{"turn":1,"reason":"${reason}"}}\n`,
      ).events,
      { sessionId: 'sess-x', session: false },
    ).spans[0]

  assert.equal(log('failed').status.code, STATUS_ERROR)
  assert.equal(log('cancelled').status.code, STATUS_ERROR)
  assert.equal(log('error').status.code, STATUS_ERROR)
  assert.equal(log('completed').status.code, STATUS_OK)
  assert.equal(log('handed-off').status.code, STATUS_OK)
})

test('timestamps come from event time, in nanoseconds', () => {
  const { spans } = build()

  const turn = one(spans, TURN_SPAN_NAME, { 'dsh.turn': 1 })
  assert.equal(turn.startTimeUnixNano, '1710000000000000000')
  assert.equal(turn.endTimeUnixNano, '1710000001000000000')
  assert.equal(msToNano(1710000000000), '1710000000000000000')

  const tool = one(spans, TOOL_SPAN_NAME, {})
  assert.equal(tool.startTimeUnixNano, msToNano(1710000000600))
  assert.equal(tool.endTimeUnixNano, msToNano(1710000000800))
})

test('a bracket the log never closed ends at the last event, and says so', () => {
  const { spans } = build()

  const unclosed = one(spans, STEP_SPAN_NAME, { 'dsh.turn': 2 })
  const attributes = attributesToObject(unclosed.attributes)
  assert.equal(attributes['dsh.span.unclosed'], true)
  assert.equal(unclosed.endTimeUnixNano, msToNano(1710000002300))
  assert.equal(attributes['dsh.event.seq.end'], 13)

  const closed = one(spans, STEP_SPAN_NAME, { 'dsh.turn': 1 })
  assert.equal(attributesToObject(closed.attributes)['dsh.span.unclosed'], undefined)
})

test('the session span spans the whole log', () => {
  const { spans } = build()

  const session = one(spans, SESSION_SPAN_NAME)
  assert.equal(session.startTimeUnixNano, msToNano(1710000000000))
  assert.equal(session.endTimeUnixNano, msToNano(1710000002300))
  assert.equal(attributesToObject(session.attributes)['dsh.span.unclosed'], undefined)
})

test('the root span can be left out, and then turns are roots', () => {
  const { spans, counts } = build({ session: false })

  assert.equal(counts.spans, 5)
  assert.ok(!spans.some((span) => span.name === SESSION_SPAN_NAME))
  for (const turn of spans.filter((span) => span.name === TURN_SPAN_NAME)) {
    assert.equal(turn.parentSpanId, undefined)
  }
})

test('a step with no turn above it synthesizes the turn rather than dangling', () => {
  const { spans, counts } = buildSpans(
    parseSessionLog(
      '{"type":"step/start","seq":1,"time":10,"data":{"turn":4,"step":1}}\n' +
        '{"type":"tool/call","seq":2,"time":20,"data":{"turn":4,"step":1,"callId":"c","name":"grep"}}\n',
    ).events,
    { sessionId: 'sess-y' },
  )

  assert.equal(counts.turns, 1)
  const turn = one(spans, TURN_SPAN_NAME, { 'dsh.turn': 4 })
  const step = one(spans, STEP_SPAN_NAME, { 'dsh.turn': 4 })
  const tool = one(spans, TOOL_SPAN_NAME, { 'tool.call_id': 'c' })
  assert.equal(step.parentSpanId, turn.spanId)
  assert.equal(tool.parentSpanId, step.spanId)
  assert.equal(turn.startTimeUnixNano, msToNano(10))
})

test('a tool result is paired by callId wherever the log spells it', () => {
  const { spans } = buildSpans(
    parseSessionLog(
      '{"type":"turn/start","seq":1,"time":10,"data":{"turn":1}}\n' +
        '{"type":"step/start","seq":2,"time":11,"data":{"turn":1,"step":1}}\n' +
        '{"type":"tool/call","seq":3,"time":12,"data":{"callId":"c1","name":"a"}}\n' +
        '{"type":"tool/result","seq":4,"time":13,"data":{"message":{"callId":"c1"}}}\n',
    ).events,
    { sessionId: 'sess-z' },
  )

  const tool = one(spans, TOOL_SPAN_NAME, { 'tool.call_id': 'c1' })
  assert.equal(tool.endTimeUnixNano, msToNano(13))
  assert.equal(attributesToObject(tool.attributes)['tool.error'], false)
})

test('an unknown event type changes nothing', () => {
  const withUnknown = buildSpans(
    parseSessionLog(
      '{"type":"turn/start","seq":1,"time":10,"data":{"turn":1}}\n' +
        '{"type":"some/future-event","seq":2,"time":10,"data":{"turn":1}}\n' +
        '{"type":"turn/end","seq":3,"time":20,"data":{"turn":1}}\n',
    ).events,
    { sessionId: 'sess-u' },
  )
  const without = buildSpans(
    parseSessionLog(
      '{"type":"turn/start","seq":1,"time":10,"data":{"turn":1}}\n' +
        '{"type":"turn/end","seq":3,"time":20,"data":{"turn":1}}\n',
    ).events,
    { sessionId: 'sess-u' },
  )

  assert.deepEqual(withUnknown.spans, without.spans)
})

test('an empty log yields only the root span', () => {
  const { spans, counts } = buildSpans([], { sessionId: 'sess-empty' })

  assert.equal(counts.spans, 1)
  assert.equal(spans[0].name, SESSION_SPAN_NAME)
})
