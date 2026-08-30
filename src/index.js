/**
 * dsh-otel — a DeepSeek Harness function plugin that exports OpenTelemetry
 * spans for a session's turns, steps, and tool calls.
 *
 * The plugin registers exactly one model-facing tool, `otel_export`, against
 * the `tools` service and owns nothing else. Registration happens inside
 * `apply` so the Cordis fiber owns the effect: stopping, updating, or reloading
 * the plugin unregisters the tool with no bookkeeping here. Named exports
 * preserve the loader's injection metadata.
 *
 * The scope is one direction: **the session log out, as spans.** This package
 * does not observe the harness at runtime, does not buffer, does not sample,
 * does not replace or annotate the session log, and ships no UI — the log is
 * already the durable record, and Jaeger, Phoenix, or an OTLP collector is
 * already the viewer. What is missing is the translation, and that is all this
 * is.
 *
 * **Off by default.** With no `exporter` configured, `apply` still registers
 * the tool and the tool still builds and counts spans, but nothing leaves the
 * process. Telemetry that leaves a machine should be a thing someone turned on.
 *
 * @module dsh-otel
 */
import { resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { exportSessionLog } from './export.js'
import { DEFAULT_ENDPOINT, EXPORTERS, OtelExportError } from './otlp.js'

export { exportSessionLog } from './export.js'
export { parseSessionLog } from './session.js'
export {
  SESSION_SPAN_NAME,
  SPAN_NAMES,
  STEP_SPAN_NAME,
  TOOL_SPAN_NAME,
  TURN_SPAN_NAME,
  UNKNOWN_SESSION_ID,
  attributesToObject,
  buildSpans,
  spanIdFor,
  traceIdFor,
} from './spans.js'
export {
  DEFAULT_ENDPOINT,
  DEFAULT_SERVICE_NAME,
  EXPORTERS,
  OtelExportError,
  SCOPE_NAME,
  SCOPE_VERSION,
  createExporter,
  toOtlpDocument,
} from './otlp.js'

/** The plugin's own identity, echoed by the tool so a caller can confirm the source. */
export const PLUGIN_NAME = 'dsh-otel'

/** The one model-facing tool name this plugin owns. */
export const OTEL_EXPORT_TOOL_NAME = 'otel_export'

/** Cordis plugin name, used in loader diagnostics and the runtime plugin tree. */
export const name = 'otel'

/**
 * `tools` is a hard dependency: with no registry there is nothing for this
 * plugin to do, so it waits rather than degrading.
 */
export const inject = ['tools']

/** The exporter used when neither config nor environment names one. */
export const DEFAULT_EXPORTER = 'off'

/**
 * Resolve the plugin's effective settings.
 *
 * Precedence is patch config, then environment, then default — the patch row is
 * the deployment's stated intent, so it wins over an ambient variable.
 * @param config - The `config` block of the plugin's row in the composed patch.
 * @param env - Environment to read, injectable for tests.
 * @returns `{ exporter, endpoint, sessionLog, sessionId }`, `sessionLog` absolute.
 * @throws {OtelExportError} On an exporter name this package does not know —
 *   a misconfigured exporter fails at load, not at the first export.
 */
export function resolveConfig(config = {}, env = process.env) {
  const exporter = config.exporter ?? env.DSH_OTEL_EXPORTER ?? DEFAULT_EXPORTER
  if (!EXPORTERS.includes(exporter)) {
    throw new OtelExportError(
      'OTEL_UNKNOWN_EXPORTER',
      `unknown exporter '${exporter}' (expected one of: ${EXPORTERS.join(', ')})`,
    )
  }
  const rawLog = config.sessionLog ?? env.DSH_OTEL_SESSION_LOG ?? null
  return {
    exporter,
    endpoint: config.endpoint ?? env.DSH_OTEL_ENDPOINT ?? DEFAULT_ENDPOINT,
    sessionLog: rawLog === null ? null : resolve(rawLog),
    sessionId: config.sessionId ?? env.DSH_OTEL_SESSION_ID ?? null,
  }
}

/**
 * Build the `otel_export` tool definition.
 *
 * Kept as a factory rather than a module-scope constant so nothing is
 * constructed at import time, each `apply` owns its own definition bound to its
 * own resolved config, and the `sink` and `fetch` seams can be substituted.
 * Exported so a host can drive the tool without booting a profile.
 * @param settings - Resolved settings from {@link resolveConfig}, plus the
 *   optional `sink` and `fetch` seams.
 * @returns A registry-ready tool definition.
 */
export function createOtelExportTool(settings = {}) {
  return defineTool({
    name: OTEL_EXPORT_TOOL_NAME,
    description:
      'Export this session as OpenTelemetry spans, read from the session log: one span per ' +
      'turn, per step, and per tool call, linked into one trace. Reach for it when asked to ' +
      'send a run to Jaeger, Phoenix, or an OTLP collector, or to report how a session was ' +
      'shaped — how many turns it took, how long a tool call ran, which one failed. Span ids ' +
      'are derived from the log, so exporting the same session twice produces the same trace ' +
      'rather than a duplicate. Prompts, tool arguments, and tool results are never included: ' +
      'a span carries names, ids, timings, and reported token counts only. If no exporter is ' +
      'configured the spans are still built and counted, but nothing is sent anywhere.',
    parameters: {
      log: {
        type: 'string',
        description:
          'Path to the session log to export, JSONL. Defaults to the configured `sessionLog`; ' +
          'with neither, the call fails rather than exporting an empty trace.',
      },
      session_id: {
        type: 'string',
        description:
          'Session id to attribute the trace to. Defaults to the configured `sessionId`, else ' +
          'the id the log names in its header. The trace id is derived from it, so the same id ' +
          'always lands in the same trace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          log: { type: 'string', required: true, description: 'The log file that was read.' },
          session_id: {
            type: 'string',
            required: true,
            description: 'The session id the trace was attributed to.',
          },
          trace_id: {
            type: 'string',
            required: true,
            description: 'The 32-hex trace id derived from the session id.',
          },
          exporter: {
            type: 'string',
            required: true,
            enum: EXPORTERS,
            description: 'The exporter that ran; `off` means nothing was sent.',
          },
          endpoint: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Where the spans were POSTed, or null for `off` and `stdout`.',
          },
          spans: { type: 'integer', required: true, description: 'How many spans were built.' },
          exported: {
            type: 'integer',
            required: true,
            description: 'How many spans actually left the process; 0 when the exporter is off.',
          },
          turns: { type: 'integer', required: true, description: 'Turn spans in the trace.' },
          steps: { type: 'integer', required: true, description: 'Step spans in the trace.' },
          tools: { type: 'integer', required: true, description: 'Tool-execution spans.' },
          malformed_lines: {
            type: 'array',
            required: true,
            items: { type: 'integer' },
            description: 'Line numbers in the log that did not parse, and were skipped.',
          },
          status: {
            oneOf: [{ type: 'integer' }, { type: 'null' }],
            description: 'The collector’s HTTP status, or null if none was contacted.',
          },
          plugin: {
            type: 'string',
            required: true,
            const: PLUGIN_NAME,
            description: 'The plugin that registered the tool that answered.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
    },
    async execute(args, exec) {
      const result = await exportSessionLog({
        logPath: args.log ?? settings.sessionLog,
        sessionId: args.session_id ?? settings.sessionId,
        exporter: settings.exporter,
        endpoint: settings.endpoint,
        serviceName: settings.serviceName,
        sink: settings.sink,
        fetch: settings.fetch,
        signal: exec?.signal,
      })
      return { ...result, plugin: PLUGIN_NAME }
    },
  })
}

/**
 * Project a validated tool result into the one line of prose the model reads.
 * @param value - The tool's canonical result.
 * @returns A compact summary.
 */
function renderSummary(value) {
  const shape =
    `${value.spans} span(s) — ${value.turns} turn(s), ${value.steps} step(s), ` +
    `${value.tools} tool call(s)`
  const sent =
    value.exporter === 'off'
      ? 'exporter is off, so nothing was sent'
      : value.exporter === 'stdout'
        ? `${value.exported} span(s) written to stdout`
        : `${value.exported} span(s) POSTed to ${value.endpoint}`
  const skipped =
    value.malformed_lines.length === 0
      ? ''
      : ` Skipped ${value.malformed_lines.length} unparseable log line(s): ` +
        `${value.malformed_lines.join(', ')}.`
  return (
    `${shape} built from ${value.log} for session ${value.session_id} ` +
    `(trace ${value.trace_id}); ${sent}.${skipped}`
  )
}

/**
 * Register the plugin's single tool for the lifetime of this plugin's fiber.
 *
 * The raw config is spread under the resolved settings so a host driving
 * `apply` directly can pass the `sink` and `fetch` seams through it; a patch
 * row, being YAML, can only ever supply the documented keys.
 * @param ctx - The injected Cordis context, with `tools` resolved.
 * @param config - The `config` block of this plugin's row in the composed patch.
 */
export function apply(ctx, config = {}) {
  ctx.tools.register(createOtelExportTool({ ...config, ...resolveConfig(config) }))
}
