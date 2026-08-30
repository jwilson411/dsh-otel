/**
 * Turning session events into spans.
 *
 * Three span kinds come out of the log, and nothing else:
 *
 * | span | opened by | closed by | parent |
 * |---|---|---|---|
 * | `dsh.turn` | `turn/start` | `turn/end` | the session span |
 * | `dsh.step` | `step/start` | `step/end` | its turn |
 * | `dsh.tool.execute` | `tool/call` | the `tool/result` with the same `callId` | its step |
 *
 * A root `dsh.session` span wraps them so a trace opens as one tree.
 *
 * **Ids are derived, not generated.** The trace id is SHA-256 of the session
 * id; a span id is SHA-256 of `<sessionId>/<key>`, where the key is the
 * bracket's own coordinates in the log (`turn:1:step:2:tool:call_7`). Two
 * exports of the same log therefore produce the same tree, so re-running an
 * export after a collector was actually up repairs the gap instead of
 * duplicating it under fresh ids.
 *
 * **Nothing is measured here.** Timestamps come from event `time`, counts from
 * `data.usage` if the log reported them, and a bracket left open at EOF is
 * closed at the last event's instant rather than dropped — an in-flight tool
 * call is the interesting one.
 *
 * Prompts, tool arguments, and tool results are deliberately not attached. A
 * span carries the shape of the run, not its contents.
 *
 * @module dsh-otel/spans
 */
import { createHash } from 'node:crypto'

import { eventSeq, eventTime } from './session.js'

/** The turn span's name. */
export const TURN_SPAN_NAME = 'dsh.turn'

/** The step span's name. */
export const STEP_SPAN_NAME = 'dsh.step'

/** The tool-execution span's name. */
export const TOOL_SPAN_NAME = 'dsh.tool.execute'

/** The optional root span's name. */
export const SESSION_SPAN_NAME = 'dsh.session'

/** Every span name this module can emit. */
export const SPAN_NAMES = [SESSION_SPAN_NAME, TURN_SPAN_NAME, STEP_SPAN_NAME, TOOL_SPAN_NAME]

/** Session id used for id derivation when neither config, CLI, nor log names one. */
export const UNKNOWN_SESSION_ID = 'unknown'

/** OTLP `SpanKind.INTERNAL`; these spans describe work inside one process. */
export const SPAN_KIND_INTERNAL = 1

/** OTLP `StatusCode.OK`. */
export const STATUS_OK = 1

/** OTLP `StatusCode.ERROR`. */
export const STATUS_ERROR = 2

/**
 * Turn-end reasons read as failure.
 *
 * Conservative on purpose: a reason not on this list is reported OK rather
 * than guessed at, so a new vocabulary word does not silently redden a trace.
 */
export const ERROR_TURN_REASONS = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled'])

/**
 * Derive the 32-hex trace id for a session.
 * @param sessionId - The session id, or null for {@link UNKNOWN_SESSION_ID}.
 * @returns 32 lowercase hex characters.
 */
export function traceIdFor(sessionId) {
  return sha256Hex(sessionId ?? UNKNOWN_SESSION_ID).slice(0, 32)
}

/**
 * Derive the 16-hex span id for one bracket in one session.
 * @param sessionId - The session id, or null for {@link UNKNOWN_SESSION_ID}.
 * @param key - The bracket's stable key, e.g. `turn:1:step:2:tool:call_7`.
 * @returns 16 lowercase hex characters.
 */
export function spanIdFor(sessionId, key) {
  return sha256Hex(`${sessionId ?? UNKNOWN_SESSION_ID}/${key}`).slice(0, 16)
}

/**
 * @param text - The value to digest.
 * @returns Its SHA-256, lowercase hex.
 */
function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Epoch milliseconds as the string of nanoseconds OTLP/JSON wants.
 *
 * OTLP declares these as `fixed64`, which JSON carries as a string; building
 * it by concatenation rather than multiplication keeps it exact past 2^53.
 * @param ms - Epoch milliseconds.
 * @returns The same instant in nanoseconds, as a decimal string.
 */
export function msToNano(ms) {
  const whole = Math.trunc(Number.isFinite(ms) ? ms : 0)
  return whole < 0 ? `-${String(-whole)}000000` : `${String(whole)}000000`
}

/**
 * Project an OTLP attribute list back into a plain object.
 *
 * The inverse of what {@link buildSpans} writes, for readers — tests, the
 * CLI's text output — that want the values rather than the encoding.
 * @param attributes - An OTLP `KeyValue[]`.
 * @returns The attributes as `{ key: value }`, integers as numbers.
 */
export function attributesToObject(attributes = []) {
  const out = {}
  for (const { key, value } of attributes) {
    if (value === null || typeof value !== 'object') continue
    if ('stringValue' in value) out[key] = value.stringValue
    else if ('intValue' in value) out[key] = Number(value.intValue)
    else if ('boolValue' in value) out[key] = value.boolValue
    else if ('doubleValue' in value) out[key] = value.doubleValue
  }
  return out
}

/**
 * Encode a plain object as an OTLP attribute list, in insertion order.
 * @param object - Attribute values; `undefined` and `null` entries are dropped.
 * @returns An OTLP `KeyValue[]`.
 */
function toAttributes(object) {
  const attributes = []
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'boolean') attributes.push({ key, value: { boolValue: value } })
    else if (typeof value === 'number') {
      attributes.push(
        Number.isInteger(value)
          ? { key, value: { intValue: String(value) } }
          : { key, value: { doubleValue: value } },
      )
    } else attributes.push({ key, value: { stringValue: String(value) } })
  }
  return attributes
}

/**
 * Build the span tree for one session log.
 *
 * Events are read in file order; `seq` is recorded on each span
 * (`dsh.event.seq.start` / `dsh.event.seq.end`) so a span can be traced back
 * to the exact log lines that produced it. An event that opens a child whose
 * parent was never opened — a `step/start` with no `turn/start` above it —
 * synthesizes that parent at the child's own instant, because a dangling
 * `parentSpanId` would break the tree at the collector rather than here.
 *
 * @param events - Parsed events, as {@link ./session.js} returns them.
 * @param options - `sessionId`, and `session: false` to omit the root span.
 * @returns `{ spans, sessionId, traceId, counts }` — `spans` is OTLP-ready and
 *   in the order the brackets opened; `counts` is `{ spans, turns, steps, tools }`.
 */
export function buildSpans(events, options = {}) {
  const sessionId = options.sessionId ?? null
  const withSession = options.session !== false
  const traceId = traceIdFor(sessionId)
  const idOf = (key) => spanIdFor(sessionId, key)

  /** Every record built, in the order it was opened. */
  const records = []
  /** Records still waiting for their closing event, by key. */
  const open = new Map()
  /** Open turn number → its record; the last entry is the innermost turn. */
  const openTurns = new Map()
  /** Open `<turn>:<step>` → its record. */
  const openSteps = new Map()
  /** Open `callId` → its record. */
  const openTools = new Map()

  const counts = { turns: 0, steps: 0, tools: 0 }
  let lastTime = 0
  let lastSeq = null
  let firstTime = null
  let impliedTurn = 0
  const impliedStep = new Map()

  const sessionRecord = withSession
    ? openRecord({
        key: 'session',
        name: SESSION_SPAN_NAME,
        parentSpanId: null,
        startTimeMs: 0,
        startSeq: null,
        attributes: { 'session.id': sessionId ?? UNKNOWN_SESSION_ID },
      })
    : null

  /**
   * Start a record and remember it as open.
   * @param spec - The record's fixed fields.
   * @returns The record.
   */
  function openRecord(spec) {
    const record = {
      key: spec.key,
      name: spec.name,
      parentSpanId: spec.parentSpanId,
      spanId: idOf(spec.key),
      startTimeMs: spec.startTimeMs,
      endTimeMs: null,
      startSeq: spec.startSeq,
      endSeq: null,
      attributes: { ...spec.attributes },
      status: STATUS_OK,
    }
    records.push(record)
    open.set(record.key, record)
    return record
  }

  /**
   * Find, or synthesize, the record for a turn.
   * @param turn - The turn number.
   * @param timeMs - The instant to open a synthesized turn at.
   * @param seq - The seq to credit a synthesized turn to.
   * @returns The turn's record.
   */
  function ensureTurn(turn, timeMs, seq) {
    const existing = openTurns.get(turn)
    if (existing !== undefined) return existing
    counts.turns += 1
    const record = openRecord({
      key: `turn:${turn}`,
      name: TURN_SPAN_NAME,
      parentSpanId: sessionRecord === null ? null : sessionRecord.spanId,
      startTimeMs: timeMs,
      startSeq: seq,
      attributes: { 'session.id': sessionId ?? UNKNOWN_SESSION_ID, 'dsh.turn': turn },
    })
    openTurns.set(turn, record)
    return record
  }

  /**
   * Find, or synthesize, the record for a step.
   * @param turn - The turn number.
   * @param step - The step number within that turn.
   * @param timeMs - The instant to open a synthesized step at.
   * @param seq - The seq to credit a synthesized step to.
   * @returns The step's record.
   */
  function ensureStep(turn, step, timeMs, seq) {
    const stepKey = `${turn}:${step}`
    const existing = openSteps.get(stepKey)
    if (existing !== undefined) return existing
    const parent = ensureTurn(turn, timeMs, seq)
    counts.steps += 1
    const record = openRecord({
      key: `turn:${turn}:step:${step}`,
      name: STEP_SPAN_NAME,
      parentSpanId: parent.spanId,
      startTimeMs: timeMs,
      startSeq: seq,
      attributes: {
        'session.id': sessionId ?? UNKNOWN_SESSION_ID,
        'dsh.turn': turn,
        'dsh.step': step,
      },
    })
    openSteps.set(stepKey, record)
    return record
  }

  /**
   * Close a record at an instant.
   * @param record - The record to close.
   * @param timeMs - The instant.
   * @param seq - The closing event's seq, if it reported one.
   */
  function closeRecord(record, timeMs, seq) {
    record.endTimeMs = Math.max(timeMs, record.startTimeMs)
    record.endSeq = seq
    open.delete(record.key)
  }

  /**
   * The turn an event belongs to: the one it names, else the innermost open one.
   * @param data - The event payload.
   * @returns A turn number.
   */
  function turnOf(data) {
    if (Number.isFinite(data?.turn)) return Math.trunc(data.turn)
    const keys = [...openTurns.keys()]
    return keys.length > 0 ? keys[keys.length - 1] : impliedTurn
  }

  /**
   * The step an event belongs to: the one it names, else the innermost open one
   * in that turn.
   * @param data - The event payload.
   * @param turn - The event's turn.
   * @returns A step number.
   */
  function stepOf(data, turn) {
    if (Number.isFinite(data?.step)) return Math.trunc(data.step)
    for (const [key, record] of [...openSteps].reverse()) {
      if (key.startsWith(`${turn}:`)) return record.attributes['dsh.step']
    }
    return impliedStep.get(turn) ?? 1
  }

  for (const event of events) {
    const timeMs = eventTime(event, lastTime)
    const seq = eventSeq(event)
    lastTime = timeMs
    if (seq !== null) lastSeq = seq
    // Only an event that reported its own instant can open the session span: a
    // header line carries no `time`, and starting the trace at the epoch
    // because of it would stretch it across fifty-six years of nothing.
    if (firstTime === null && Number.isFinite(event?.time)) firstTime = timeMs
    const data = event?.data ?? {}

    switch (event?.type) {
      case 'turn/start': {
        const turn = Number.isFinite(data.turn) ? Math.trunc(data.turn) : impliedTurn + 1
        impliedTurn = turn
        ensureTurn(turn, timeMs, seq)
        break
      }

      case 'turn/end': {
        const turn = turnOf(data)
        const record = openTurns.get(turn)
        if (record === undefined) break
        if (typeof data.reason === 'string' && data.reason !== '') {
          record.attributes['dsh.turn.reason'] = data.reason
          if (ERROR_TURN_REASONS.has(data.reason.toLowerCase())) record.status = STATUS_ERROR
        }
        openTurns.delete(turn)
        closeRecord(record, timeMs, seq)
        break
      }

      case 'step/start': {
        const turn = turnOf(data)
        const step = Number.isFinite(data.step)
          ? Math.trunc(data.step)
          : (impliedStep.get(turn) ?? 0) + 1
        impliedStep.set(turn, step)
        ensureStep(turn, step, timeMs, seq)
        break
      }

      case 'step/end': {
        const turn = turnOf(data)
        const step = stepOf(data, turn)
        const record = openSteps.get(`${turn}:${step}`)
        if (record === undefined) break
        openSteps.delete(`${turn}:${step}`)
        closeRecord(record, timeMs, seq)
        break
      }

      case 'assistant/message': {
        const usage = data.usage
        if (usage === null || typeof usage !== 'object') break
        const turn = turnOf(data)
        const step = stepOf(data, turn)
        const record = openSteps.get(`${turn}:${step}`)
        if (record === undefined) break
        // Reported counts only, copied under their own names. Nothing is summed
        // and nothing is estimated: a count the log did not report is absent.
        for (const [key, value] of Object.entries(usage)) {
          if (Number.isFinite(value)) record.attributes[`dsh.usage.${key}`] = value
        }
        break
      }

      case 'tool/call': {
        const callId = callIdOf(data)
        if (callId === null || openTools.has(callId)) break
        const turn = turnOf(data)
        const step = stepOf(data, turn)
        const parent = ensureStep(turn, step, timeMs, seq)
        counts.tools += 1
        const record = openRecord({
          key: `turn:${turn}:step:${step}:tool:${callId}`,
          name: TOOL_SPAN_NAME,
          parentSpanId: parent.spanId,
          startTimeMs: timeMs,
          startSeq: seq,
          attributes: {
            'session.id': sessionId ?? UNKNOWN_SESSION_ID,
            'dsh.turn': turn,
            'dsh.step': step,
            // Name and call id only: arguments and results stay in the log.
            'tool.name': typeof data.name === 'string' ? data.name : 'unknown',
            'tool.call_id': callId,
          },
        })
        openTools.set(callId, record)
        break
      }

      case 'tool/result': {
        const callId = callIdOf(data)
        if (callId === null) break
        const record = openTools.get(callId)
        if (record === undefined) break
        const failed = hasError(data)
        record.attributes['tool.error'] = failed
        if (failed) record.status = STATUS_ERROR
        openTools.delete(callId)
        closeRecord(record, timeMs, seq)
        break
      }

      default:
        // Unknown or uninteresting event type: it advances the clock and
        // nothing else.
        break
    }
  }

  // A bracket the log never closed ends at the last event seen, rather than
  // being dropped — an in-flight tool call at EOF is the one you came for.
  for (const record of [...open.values()]) {
    closeRecord(record, lastTime, lastSeq)
    record.attributes['dsh.span.unclosed'] = true
  }
  if (sessionRecord !== null) {
    sessionRecord.startTimeMs = firstTime ?? 0
    sessionRecord.endTimeMs = Math.max(lastTime, sessionRecord.startTimeMs)
    delete sessionRecord.attributes['dsh.span.unclosed']
  }

  const spans = records.map((record) => toOtlpSpan(record, traceId))
  return { spans, sessionId, traceId, counts: { spans: spans.length, ...counts } }
}

/**
 * @param data - A `tool/call` or `tool/result` payload.
 * @returns The call id both halves pair on, or null.
 */
function callIdOf(data) {
  const candidates = [data?.callId, data?.call_id, data?.message?.callId, data?.message?.call_id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return null
}

/**
 * @param data - A `tool/result` payload.
 * @returns Whether the result reported a failure.
 */
function hasError(data) {
  if (data?.error !== undefined && data.error !== null && data.error !== false) return true
  const message = data?.message
  if (message?.error !== undefined && message.error !== null && message.error !== false) return true
  return message?.isError === true || data?.isError === true
}

/**
 * Project a record into the OTLP span a collector reads.
 * @param record - An internal span record.
 * @param traceId - The trace every span in this export belongs to.
 * @returns An OTLP span object.
 */
function toOtlpSpan(record, traceId) {
  const attributes = {
    ...record.attributes,
    'dsh.event.seq.start': record.startSeq,
    'dsh.event.seq.end': record.endSeq,
  }
  const span = {
    traceId,
    spanId: record.spanId,
    name: record.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: msToNano(record.startTimeMs),
    endTimeUnixNano: msToNano(record.endTimeMs ?? record.startTimeMs),
    attributes: toAttributes(attributes),
    status: { code: record.status },
  }
  if (record.parentSpanId !== null) span.parentSpanId = record.parentSpanId
  return span
}
