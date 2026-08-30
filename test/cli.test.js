/**
 * The CLI, driven in-process with both streams captured.
 *
 * stdout must carry the OTLP document and nothing else, so a redirect is
 * always a valid file; the report goes to stderr. Nothing here shells out and
 * nothing reaches a network.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { main } from '../bin/dsh-otel.js'

import { FIXTURE_SESSION_ID, SESSION_FIXTURE } from './helpers.js'

/** @returns A stream stub with a `write` method and the text it collected. */
function stream() {
  const chunks = []
  return { write: (text) => chunks.push(text), get text() { return chunks.join('') } }
}

/**
 * Run the CLI.
 * @param argv - Arguments after the script path.
 * @param env - Environment to read.
 * @returns `{ code, out, err }`.
 */
async function run(argv, env = {}) {
  const stdout = stream()
  const stderr = stream()
  const code = await main(argv, env, stdout, stderr)
  return { code, out: stdout.text, err: stderr.text }
}

test('export writes the OTLP document to stdout and the report to stderr', async () => {
  const { code, out, err } = await run(['export', '--log', SESSION_FIXTURE])

  assert.equal(code, 0)
  const document = JSON.parse(out)
  assert.equal(document.resourceSpans[0].scopeSpans[0].spans.length, 6)
  assert.match(err, new RegExp(`session ${FIXTURE_SESSION_ID} → trace [0-9a-f]{32}`))
  assert.match(err, /6 span\(s\): 2 turn\(s\), 2 step\(s\), 1 tool call\(s\)/)
  assert.match(err, /skipped unparseable log line\(s\): 5/)
})

test('--json reports the summary as JSON, still leaving stdout to the document', async () => {
  const { code, out, err } = await run(['export', '--log', SESSION_FIXTURE, '--json'])

  assert.equal(code, 0)
  assert.ok(JSON.parse(out).resourceSpans)
  const summary = JSON.parse(err)
  assert.equal(summary.session_id, FIXTURE_SESSION_ID)
  assert.equal(summary.exporter, 'stdout')
  assert.equal(summary.exported, 6)
  assert.deepEqual(summary.malformed_lines, [5])
})

test('--session sets the id the trace is derived from', async () => {
  const first = await run(['export', '--log', SESSION_FIXTURE, '--session', 'sess-a', '--json'])
  const again = await run(['export', '--log', SESSION_FIXTURE, '--session', 'sess-a', '--json'])
  const other = await run(['export', '--log', SESSION_FIXTURE, '--session', 'sess-b', '--json'])

  assert.equal(JSON.parse(first.err).trace_id, JSON.parse(again.err).trace_id)
  assert.equal(first.out, again.out)
  assert.notEqual(JSON.parse(first.err).trace_id, JSON.parse(other.err).trace_id)
})

test('--exporter off builds the spans and sends nothing', async () => {
  const { code, out, err } = await run(['export', '--log', SESSION_FIXTURE, '--exporter', 'off'])

  assert.equal(code, 0)
  assert.equal(out, '')
  assert.match(err, /exporter off — nothing sent/)
})

test('the log and the session id can come from the environment', async () => {
  const { code, err } = await run(['export', '--exporter', 'off'], {
    DSH_OTEL_SESSION_LOG: SESSION_FIXTURE,
    DSH_OTEL_SESSION_ID: 'sess-env',
  })

  assert.equal(code, 0)
  assert.match(err, /session sess-env/)
})

test('an export with no log at all is refused, with the flag named', async () => {
  const { code, out, err } = await run(['export'])

  assert.equal(code, 2)
  assert.equal(out, '')
  assert.match(err, /export needs --log <path>/)
})

test('a log that is not there exits 1 and says which one', async () => {
  const { code, err } = await run(['export', '--log', `${SESSION_FIXTURE}.missing`])

  assert.equal(code, 1)
  assert.match(err, /session log not found/)
})

test('an unknown exporter, command, or flag is refused before anything runs', async () => {
  assert.equal((await run(['export', '--log', SESSION_FIXTURE, '--exporter', 'zipkin'])).code, 2)
  assert.equal((await run(['import', '--log', SESSION_FIXTURE])).code, 2)
  assert.equal((await run(['export', '--verbose'])).code, 2)
  assert.match((await run(['export', '--log'])).err, /--log needs a value/)
})

test('help is available and goes to stderr', async () => {
  for (const argv of [[], ['-h'], ['--help']]) {
    const { code, out, err } = await run(argv)
    assert.equal(code, 0)
    assert.equal(out, '')
    assert.match(err, /dsh-otel export --log <path>/)
  }
})
