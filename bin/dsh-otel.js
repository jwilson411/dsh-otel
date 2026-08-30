#!/usr/bin/env node
/**
 * `dsh-otel` — the same export the `otel_export` tool performs, from a shell.
 *
 * The CLI is deliberately the thinner half: it parses flags, calls the same
 * function the plugin calls, and prints. It imports nothing outside `node:` and
 * this package, so it runs against a checkout with no dependencies installed —
 * useful when the trace is the thing you need and the harness is the thing that
 * is broken.
 *
 *   dsh-otel export --log <path> [--session <id>] [--exporter stdout|otlp-http]
 *                   [--endpoint <url>] [--service <name>] [--json]
 *
 * Unlike the plugin, the CLI defaults to the `stdout` exporter: you asked for
 * an export at a prompt, so printing the document is the least surprising
 * thing it can do, and it still sends nothing anywhere.
 *
 * The two streams do not mix. **stdout carries the OTLP document and nothing
 * else**, so `dsh-otel export --log … > spans.json` is always a valid file;
 * the run's report — how many spans, where they went, which log lines were
 * skipped — goes to **stderr**, as text or, with `--json`, as JSON.
 *
 * @module dsh-otel/cli
 */
import process from 'node:process'

import { exportSessionLog } from '../src/export.js'
import { DEFAULT_ENDPOINT, EXPORTERS } from '../src/otlp.js'

const USAGE = `dsh-otel — export a session log as OpenTelemetry spans

Usage:
  dsh-otel export --log <path> [--session <id>] [--exporter ${EXPORTERS.join('|')}]
                  [--endpoint <url>] [--service <name>] [--json]

Commands:
  export   Read a session log, build turn/step/tool spans, and export them.

Options:
  --log <path>      Session log to read, JSONL. Default: $DSH_OTEL_SESSION_LOG
  --session <id>    Session id to attribute the trace to. Default:
                    $DSH_OTEL_SESSION_ID, else the id the log's header names.
  --exporter <name> One of ${EXPORTERS.join(', ')}. Default: $DSH_OTEL_EXPORTER,
                    else stdout.
  --endpoint <url>  OTLP/HTTP traces endpoint, used by --exporter otlp-http.
                    Default: $DSH_OTEL_ENDPOINT, else ${DEFAULT_ENDPOINT}
  --service <name>  service.name on the exported resource. Default: dsh
  --json            Emit the run's summary as JSON instead of text.
  -h, --help        This message.
`

/**
 * Entry point.
 * @param argv - Arguments after the node binary and script path.
 * @param env - Environment to read.
 * @param stdout - Where the OTLP document is written, and nothing else.
 * @param stderr - Where the run's report, the usage text, and errors go.
 * @returns The process exit code.
 */
export async function main(argv, env = process.env, stdout = process.stdout, stderr = process.stderr) {
  const emit = (text) => stdout.write(`${text}\n`)
  const report = (text) => stderr.write(`${text}\n`)

  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    report(USAGE.trimEnd())
    return 0
  }

  const [command, ...rest] = argv
  if (command !== 'export') {
    report(`error: unknown command '${command}'\n\n${USAGE.trimEnd()}`)
    return 2
  }

  let options
  try {
    options = parseOptions(rest)
  } catch (error) {
    report(`error: ${error.message}`)
    return 2
  }

  const exporter = options.exporter ?? env.DSH_OTEL_EXPORTER ?? 'stdout'
  if (!EXPORTERS.includes(exporter)) {
    report(`error: unknown exporter '${exporter}' (expected one of: ${EXPORTERS.join(', ')})`)
    return 2
  }

  const logPath = options.log ?? env.DSH_OTEL_SESSION_LOG ?? null
  if (logPath === null) {
    report('error: export needs --log <path> (or $DSH_OTEL_SESSION_LOG)')
    return 2
  }

  let summary
  try {
    summary = await exportSessionLog({
      logPath,
      sessionId: options.session ?? env.DSH_OTEL_SESSION_ID ?? null,
      exporter,
      endpoint: options.endpoint ?? env.DSH_OTEL_ENDPOINT ?? DEFAULT_ENDPOINT,
      serviceName: options.service,
      sink: emit,
    })
  } catch (error) {
    report(`error: ${error.message}`)
    return 1
  }

  report(options.json ? JSON.stringify(summary, null, 2) : renderReport(summary))
  return 0
}

/**
 * Parse the flags `export` takes.
 * @param argv - Arguments after the command word.
 * @returns The parsed options.
 * @throws {Error} On an unknown flag, or a flag missing its value.
 */
function parseOptions(argv) {
  const options = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const takeValue = (flag) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${flag} needs a value`)
      index += 1
      return value
    }

    switch (arg) {
      case '--json':
        options.json = true
        break
      case '--log':
        options.log = takeValue('--log')
        break
      case '--session':
        options.session = takeValue('--session')
        break
      case '--exporter':
        options.exporter = takeValue('--exporter')
        break
      case '--endpoint':
        options.endpoint = takeValue('--endpoint')
        break
      case '--service':
        options.service = takeValue('--service')
        break
      default:
        throw new Error(`unknown option '${arg}'`)
    }
  }
  return options
}

/**
 * @param report - The export summary.
 * @returns The summary as a text block.
 */
function renderReport(report) {
  const rows = [
    `session ${report.session_id} → trace ${report.trace_id}`,
    `${report.spans} span(s): ${report.turns} turn(s), ${report.steps} step(s), ` +
      `${report.tools} tool call(s)`,
  ]
  rows.push(
    report.exporter === 'off'
      ? 'exporter off — nothing sent'
      : report.exporter === 'stdout'
        ? `${report.exported} span(s) written to stdout`
        : `${report.exported} span(s) POSTed to ${report.endpoint} (HTTP ${report.status})`,
  )
  if (report.malformed_lines.length > 0) {
    rows.push(`skipped unparseable log line(s): ${report.malformed_lines.join(', ')}`)
  }
  return rows.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2))
}
