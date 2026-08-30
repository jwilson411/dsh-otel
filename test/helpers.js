/**
 * Shared fixtures for the suite.
 *
 * Every test in this package reads the same checked-in session log: no profile
 * boots, no socket opens, no key is read, and nothing is written outside a
 * test's own sink.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The session log every test reads. */
export const SESSION_FIXTURE = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url))

/** The session id the fixture's header names. */
export const FIXTURE_SESSION_ID = 'sess-1'

/** @returns The fixture's text. */
export function fixtureText() {
  return readFileSync(SESSION_FIXTURE, 'utf8')
}

/**
 * Find the one span with a name and attribute values.
 * @param spans - Spans from `buildSpans`.
 * @param name - The span name to match.
 * @param match - Attribute values that must all match, as a plain object.
 * @param attributesToObject - The decoder, passed in to keep this file dependency-free.
 * @returns The matching span, or undefined.
 */
export function findSpan(spans, name, match, attributesToObject) {
  return spans.find((span) => {
    if (span.name !== name) return false
    const attributes = attributesToObject(span.attributes)
    return Object.entries(match).every(([key, value]) => attributes[key] === value)
  })
}
