/**
 * The OTLP/JSON document, and the two ways it leaves this process.
 *
 * The payload is written by hand rather than through an OpenTelemetry SDK: the
 * spans are already built, the document is a hundred lines of JSON, and taking
 * `@opentelemetry/*` as a runtime dependency would put a tree of packages
 * inside a harness profile to serialize an object. Nothing here imports
 * anything outside `node:` and this package.
 *
 * Both exporters take their effect as an argument — `sink` for stdout,
 * `fetch` for OTLP/HTTP — so the whole path is exercised offline in tests. The
 * default `off` exporter builds the document and drops it, which is what makes
 * "on by explicit choice" the shape of the plugin rather than a warning in the
 * README.
 *
 * @module dsh-otel/otlp
 */

/** The instrumentation scope every span is reported under. */
export const SCOPE_NAME = 'dsh-otel'

/** The scope version, kept in step with this package's version. */
export const SCOPE_VERSION = '0.1.0'

/** `service.name` on the exported resource, unless configured otherwise. */
export const DEFAULT_SERVICE_NAME = 'dsh'

/** The OTLP/HTTP traces endpoint used when none is configured. */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:4318/v1/traces'

/** The exporters this plugin knows, `off` first because it is the default. */
export const EXPORTERS = ['off', 'stdout', 'otlp-http']

/** Raised when an export was attempted and the far end refused it. */
export class OtelExportError extends Error {
  /**
   * @param code - A stable, greppable code.
   * @param message - What went wrong, in one line.
   * @param details - Anything a caller might want to report, e.g. `status`.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'OtelExportError'
    this.code = code
    Object.assign(this, details)
  }
}

/**
 * Wrap spans in the OTLP/JSON trace document collectors accept.
 * @param spans - Spans from {@link ./spans.js}.
 * @param options - `serviceName` for the resource.
 * @returns A `{ resourceSpans: [...] }` document.
 */
export function toOtlpDocument(spans, options = {}) {
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans,
          },
        ],
      },
    ],
  }
}

/**
 * Build the exporter named by the resolved settings.
 *
 * @param settings - `{ exporter, endpoint, serviceName }`.
 * @param seams - `sink` (a `(line: string) => void` for `stdout`) and `fetch`
 *   (for `otlp-http`); both default to the real thing, both are replaced in
 *   tests so the suite reaches no network and writes to no terminal.
 * @returns `{ name, endpoint, export(spans, options) }`, where `export`
 *   resolves to `{ exported, exporter, endpoint, status }` — `exported` is how
 *   many spans actually left, so `off` reports 0.
 * @throws {OtelExportError} On an exporter name this package does not know.
 */
export function createExporter(settings = {}, seams = {}) {
  const name = settings.exporter ?? 'off'
  if (!EXPORTERS.includes(name)) {
    throw new OtelExportError(
      'OTEL_UNKNOWN_EXPORTER',
      `unknown exporter '${name}' (expected one of: ${EXPORTERS.join(', ')})`,
    )
  }

  const endpoint = settings.endpoint ?? DEFAULT_ENDPOINT
  const serviceName = settings.serviceName ?? DEFAULT_SERVICE_NAME

  if (name === 'off') {
    return {
      name,
      endpoint: null,
      export: () => Promise.resolve({ exported: 0, exporter: name, endpoint: null, status: null }),
    }
  }

  if (name === 'stdout') {
    const sink = seams.sink ?? ((line) => process.stdout.write(`${line}\n`))
    return {
      name,
      endpoint: null,
      export(spans) {
        // One document, one line — the file stays valid JSONL however many
        // exports are appended to it.
        sink(JSON.stringify(toOtlpDocument(spans, { serviceName })))
        return Promise.resolve({
          exported: spans.length,
          exporter: name,
          endpoint: null,
          status: null,
        })
      },
    }
  }

  const fetchImpl = seams.fetch ?? globalThis.fetch
  return {
    name,
    endpoint,
    async export(spans, options = {}) {
      if (typeof fetchImpl !== 'function') {
        throw new OtelExportError('OTEL_NO_FETCH', 'no fetch implementation available')
      }
      let response
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(toOtlpDocument(spans, { serviceName })),
          signal: options.signal,
        })
      } catch (error) {
        throw new OtelExportError(
          'OTEL_ENDPOINT_UNREACHABLE',
          `could not reach ${endpoint}: ${error.message}`,
          { endpoint },
        )
      }
      if (!response.ok) {
        throw new OtelExportError(
          'OTEL_ENDPOINT_REJECTED',
          `${endpoint} answered ${response.status}`,
          { endpoint, status: response.status },
        )
      }
      return {
        exported: spans.length,
        exporter: name,
        endpoint,
        status: response.status ?? null,
      }
    },
  }
}
