/**
 * The exporters, all three of them, with no collector anywhere.
 *
 * `stdout` writes through an injected sink and `otlp-http` posts through an
 * injected `fetch`, so the whole export path — document included — is
 * exercised offline. Nothing in this file opens a socket.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { exportSessionLog } from '../src/export.js'
import {
  DEFAULT_ENDPOINT,
  EXPORTERS,
  OtelExportError,
  SCOPE_NAME,
  SCOPE_VERSION,
  createExporter,
  toOtlpDocument,
} from '../src/otlp.js'
import { parseSessionLog } from '../src/session.js'
import { buildSpans } from '../src/spans.js'

import { FIXTURE_SESSION_ID, SESSION_FIXTURE, fixtureText } from './helpers.js'

/** @returns The fixture's spans. */
function fixtureSpans() {
  return buildSpans(parseSessionLog(fixtureText()).events, { sessionId: FIXTURE_SESSION_ID }).spans
}

/**
 * A `fetch` that answers without a network and records what it was asked.
 * @param response - Fields to merge into the stub response.
 * @returns `{ fetch, calls }`.
 */
function stubFetch(response = {}) {
  const calls = []
  const fetch = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve({ ok: true, status: 200, ...response })
  }
  return { fetch, calls }
}

test('the document is one resource, one scope, and the spans', () => {
  const spans = fixtureSpans()

  const document = toOtlpDocument(spans)

  assert.equal(document.resourceSpans.length, 1)
  const [resourceSpans] = document.resourceSpans
  assert.deepEqual(resourceSpans.resource.attributes, [
    { key: 'service.name', value: { stringValue: 'dsh' } },
  ])
  assert.equal(resourceSpans.scopeSpans.length, 1)
  assert.deepEqual(resourceSpans.scopeSpans[0].scope, { name: SCOPE_NAME, version: SCOPE_VERSION })
  assert.equal(resourceSpans.scopeSpans[0].spans.length, spans.length)
})

test('the service name is configurable', () => {
  const document = toOtlpDocument([], { serviceName: 'my-agent' })

  assert.deepEqual(document.resourceSpans[0].resource.attributes, [
    { key: 'service.name', value: { stringValue: 'my-agent' } },
  ])
})

test('the document survives a round trip through JSON with string nanos intact', () => {
  const document = JSON.parse(JSON.stringify(toOtlpDocument(fixtureSpans())))

  for (const span of document.resourceSpans[0].scopeSpans[0].spans) {
    assert.equal(typeof span.startTimeUnixNano, 'string')
    assert.equal(typeof span.endTimeUnixNano, 'string')
    assert.equal(span.kind, 1)
    assert.ok(span.status.code === 1 || span.status.code === 2)
  }
})

test('the default exporter is off, and off sends nothing', async () => {
  const exporter = createExporter({})

  assert.equal(exporter.name, 'off')
  assert.equal(EXPORTERS[0], 'off')

  const result = await exporter.export(fixtureSpans())
  assert.equal(result.exported, 0)
  assert.equal(result.endpoint, null)
})

test('the stdout exporter writes the document as one JSON line to the sink', async () => {
  const lines = []
  const exporter = createExporter({ exporter: 'stdout' }, { sink: (line) => lines.push(line) })

  const result = await exporter.export(fixtureSpans())

  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('\n'), 'the document must stay on one line')
  const document = JSON.parse(lines[0])
  assert.equal(document.resourceSpans[0].scopeSpans[0].spans.length, 6)
  assert.equal(result.exported, 6)
  assert.equal(result.exporter, 'stdout')
})

test('the otlp-http exporter POSTs JSON to the endpoint, through the injected fetch', async () => {
  const { fetch, calls } = stubFetch()
  const endpoint = 'http://127.0.0.1:4318/v1/traces'
  const exporter = createExporter({ exporter: 'otlp-http', endpoint }, { fetch })

  const result = await exporter.export(fixtureSpans())

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, endpoint)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  const document = JSON.parse(calls[0].init.body)
  assert.equal(document.resourceSpans[0].scopeSpans[0].spans.length, 6)
  assert.equal(result.exported, 6)
  assert.equal(result.endpoint, endpoint)
  assert.equal(result.status, 200)
})

test('the default endpoint is the local collector', () => {
  assert.equal(createExporter({ exporter: 'otlp-http' }, { fetch: () => {} }).endpoint, DEFAULT_ENDPOINT)
})

test('a collector that refuses the spans fails loudly, with its status', async () => {
  const { fetch } = stubFetch({ ok: false, status: 503 })
  const exporter = createExporter({ exporter: 'otlp-http' }, { fetch })

  await assert.rejects(
    () => exporter.export(fixtureSpans()),
    (error) => {
      assert.ok(error instanceof OtelExportError)
      assert.equal(error.code, 'OTEL_ENDPOINT_REJECTED')
      assert.equal(error.status, 503)
      return true
    },
  )
})

test('a collector that is not there is reported as unreachable', async () => {
  const exporter = createExporter(
    { exporter: 'otlp-http' },
    {
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    },
  )

  await assert.rejects(
    () => exporter.export(fixtureSpans()),
    (error) => {
      assert.equal(error.code, 'OTEL_ENDPOINT_UNREACHABLE')
      return true
    },
  )
})

test('an exporter this package does not know is refused, not guessed at', () => {
  assert.throws(
    () => createExporter({ exporter: 'jaeger-thrift' }),
    (error) => {
      assert.ok(error instanceof OtelExportError)
      assert.equal(error.code, 'OTEL_UNKNOWN_EXPORTER')
      return true
    },
  )
})

test('exporting the fixture reports the shape of the run', async () => {
  const lines = []

  const report = await exportSessionLog({
    logPath: SESSION_FIXTURE,
    exporter: 'stdout',
    sink: (line) => lines.push(line),
  })

  assert.equal(report.log, SESSION_FIXTURE)
  assert.equal(report.session_id, FIXTURE_SESSION_ID)
  assert.equal(report.exporter, 'stdout')
  assert.equal(report.spans, 6)
  assert.equal(report.exported, 6)
  assert.equal(report.turns, 2)
  assert.equal(report.steps, 2)
  assert.equal(report.tools, 1)
  assert.deepEqual(report.malformed_lines, [5])
  assert.equal(lines.length, 1)
})

test('an explicit session id wins over the one the log names', async () => {
  const report = await exportSessionLog({
    logPath: SESSION_FIXTURE,
    sessionId: 'sess-override',
    exporter: 'off',
  })

  assert.equal(report.session_id, 'sess-override')
  assert.equal(report.exported, 0)
  assert.equal(report.spans, 6)
})

test('an export with no log path fails loudly rather than exporting nothing', async () => {
  await assert.rejects(
    () => exportSessionLog({ exporter: 'stdout' }),
    (error) => {
      assert.ok(error instanceof OtelExportError)
      assert.equal(error.code, 'OTEL_NO_LOG')
      return true
    },
  )
})

test('a log that is not there is named in the error', async () => {
  await assert.rejects(
    () => exportSessionLog({ logPath: `${SESSION_FIXTURE}.missing`, exporter: 'stdout' }),
    (error) => {
      assert.equal(error.code, 'OTEL_LOG_NOT_FOUND')
      assert.match(error.message, /session log not found/)
      return true
    },
  )
})

test('two exports of the same log produce byte-identical documents', async () => {
  const lines = []
  const sink = (line) => lines.push(line)

  await exportSessionLog({ logPath: SESSION_FIXTURE, exporter: 'stdout', sink })
  await exportSessionLog({ logPath: SESSION_FIXTURE, exporter: 'stdout', sink })

  assert.equal(lines[0], lines[1])
})
