/**
 * One export: read a session log, build its spans, hand them to an exporter,
 * and report what happened.
 *
 * This is the only module that touches the filesystem, and it reads. The
 * session log is the source of truth and stays exactly as the harness wrote
 * it — this package adds no sidecar, no cursor file, and no state of its own,
 * so an export is repeatable and, because the ids are derived, idempotent at
 * the collector.
 *
 * @module dsh-otel/export
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { OtelExportError, createExporter } from './otlp.js'
import { parseSessionLog } from './session.js'
import { UNKNOWN_SESSION_ID, buildSpans } from './spans.js'

/**
 * Export one session log.
 *
 * The session id is taken from the caller, else from a header-like first line
 * in the log, else {@link UNKNOWN_SESSION_ID} — an explicit id always wins over
 * one the log guessed at, because the id is what the trace id is derived from.
 *
 * @param options - `logPath` (required), `sessionId`, `exporter`, `endpoint`,
 *   `serviceName`, `signal`, and the `sink` / `fetch` seams passed through to
 *   {@link createExporter}.
 * @returns `{ log, session_id, exporter, endpoint, spans, exported, turns,
 *   steps, tools, malformed_lines, status }`.
 * @throws {OtelExportError} If no log path was given, or the file cannot be read.
 */
export async function exportSessionLog(options = {}) {
  const { logPath, sessionId = null, signal } = options

  if (logPath === null || logPath === undefined || String(logPath).trim() === '') {
    throw new OtelExportError(
      'OTEL_NO_LOG',
      'no session log to export: pass a log path, or set `sessionLog` in the plugin config',
    )
  }

  const path = resolve(String(logPath))
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new OtelExportError(
      error.code === 'ENOENT' ? 'OTEL_LOG_NOT_FOUND' : 'OTEL_LOG_UNREADABLE',
      error.code === 'ENOENT'
        ? `session log not found: ${path}`
        : `session log could not be read: ${path} (${error.message})`,
      { path },
    )
  }

  const parsed = parseSessionLog(text)
  const effectiveSessionId = sessionId ?? parsed.sessionId ?? UNKNOWN_SESSION_ID
  const built = buildSpans(parsed.events, { sessionId: effectiveSessionId })

  const exporter = createExporter(
    { exporter: options.exporter, endpoint: options.endpoint, serviceName: options.serviceName },
    { sink: options.sink, fetch: options.fetch },
  )
  const result = await exporter.export(built.spans, { signal })

  return {
    log: path,
    session_id: effectiveSessionId,
    trace_id: built.traceId,
    exporter: result.exporter,
    endpoint: result.endpoint,
    spans: built.counts.spans,
    exported: result.exported,
    turns: built.counts.turns,
    steps: built.counts.steps,
    tools: built.counts.tools,
    malformed_lines: parsed.malformed,
    status: result.status ?? null,
  }
}
