/**
 * Reading the harness session log.
 *
 * The log is JSONL: one `SessionEvent` per line, `seq` monotonic, `time` in
 * Unix epoch milliseconds, and the payload under `data`. This module only
 * reads it — it decides nothing about spans, and it never rewrites the log.
 *
 * Two rules matter more than the rest:
 *
 * - A line that is not JSON is counted and skipped, never thrown. A tail that
 *   caught a partial write must not cost you the whole trace.
 * - An event type this module does not know is kept in `events` and left for
 *   the span builder to ignore. The vocabulary lives in one place
 *   ({@link ./spans.js}), so a new event type is one edit away from meaning
 *   something.
 *
 * @module dsh-otel/session
 */

/** Keys a header-like first line may carry the session id under. */
const SESSION_ID_KEYS = ['session_id', 'sessionId']

/**
 * Read a session log's text as events.
 *
 * @param text - The whole log, JSONL.
 * @returns `{ events, malformed, sessionId }`, where `events` are the parsed
 *   objects in file order, `malformed` are the 1-based numbers of lines that
 *   did not parse or did not hold an object, and `sessionId` is the id a
 *   header-like first line named, or null.
 */
export function parseSessionLog(text) {
  const events = []
  const malformed = []
  let sessionId = null
  let first = true

  const rows = String(text).split('\n')
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index].trim()
    if (row === '') continue

    let value
    try {
      value = JSON.parse(row)
    } catch {
      malformed.push(index + 1)
      continue
    }

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      malformed.push(index + 1)
      continue
    }

    if (first) {
      first = false
      sessionId = headerSessionId(value)
    }
    events.push(value)
  }

  return { events, malformed, sessionId }
}

/**
 * Read a session id off the log's first object, if it names one.
 *
 * A `SessionHeader` line is a plain object naming the session. A bare `id` is
 * only read from a line that is *not* an event, because an event's `id` is the
 * event's own, not the session's — `session_id` and `sessionId` are
 * unambiguous and are read either way.
 * @param value - The first parsed object in the log.
 * @returns The session id, or null.
 */
function headerSessionId(value) {
  const sources = [value, value.data]
  for (const source of sources) {
    if (source === null || typeof source !== 'object') continue
    for (const key of SESSION_ID_KEYS) {
      if (typeof source[key] === 'string' && source[key] !== '') return source[key]
    }
  }
  if (value.type === undefined) {
    for (const source of sources) {
      if (source === null || typeof source !== 'object') continue
      if (typeof source.id === 'string' && source.id !== '') return source.id
    }
  }
  return null
}

/**
 * The event's instant, in epoch milliseconds.
 *
 * An event that reports no usable `time` inherits the last one seen rather
 * than landing at the epoch, which would stretch every enclosing span across
 * fifty-six years of empty trace.
 * @param event - A parsed event.
 * @param fallbackMs - The instant to use when the event names none.
 * @returns The instant in milliseconds.
 */
export function eventTime(event, fallbackMs) {
  const time = event?.time
  return Number.isFinite(time) ? Math.trunc(time) : fallbackMs
}

/**
 * The event's sequence number, if it reports one.
 * @param event - A parsed event.
 * @returns The `seq` as an integer, or null.
 */
export function eventSeq(event) {
  const seq = event?.seq
  return Number.isFinite(seq) ? Math.trunc(seq) : null
}
