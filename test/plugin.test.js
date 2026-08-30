/**
 * The plugin seam: that `apply` registers the one tool, and that the tool the
 * registry would get behaves the way its declared contract says.
 *
 * `apply` is handed a stub context that records registrations, and the tool is
 * driven through the same `execute` the registry calls, against the checked-in
 * fixture and an injected sink. No profile boots, no socket opens, no key is
 * read, and nothing is written.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import {
  DEFAULT_ENDPOINT,
  DEFAULT_EXPORTER,
  OTEL_EXPORT_TOOL_NAME,
  OtelExportError,
  PLUGIN_NAME,
  SCOPE_VERSION,
  apply,
  createOtelExportTool,
  inject,
  name,
  resolveConfig,
} from '../src/index.js'

import { FIXTURE_SESSION_ID, SESSION_FIXTURE } from './helpers.js'

/** The execution context the registry passes to `execute`. */
const exec = { signal: new AbortController().signal }

/**
 * A context stub exposing only what `apply` is allowed to touch.
 * @returns The stub context and the definitions it recorded.
 */
function stubContext() {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

/**
 * Register the plugin and hand back its one tool.
 * @param config - The `config` block the patch row would supply.
 * @returns The registered tool definition.
 */
function registerTool(config = { sessionLog: SESSION_FIXTURE }) {
  const { ctx, registered } = stubContext()
  apply(ctx, config)
  assert.equal(registered.length, 1)
  return registered[0]
}

test('apply registers exactly one tool, named otel_export', () => {
  const { ctx, registered } = stubContext()

  apply(ctx, { sessionLog: SESSION_FIXTURE })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, OTEL_EXPORT_TOOL_NAME)
  assert.equal(name, 'otel')
  assert.deepEqual(inject, ['tools'])
})

test('the exporter is off unless something turns it on', () => {
  assert.equal(DEFAULT_EXPORTER, 'off')

  const settings = resolveConfig({}, {})

  assert.equal(settings.exporter, 'off')
  assert.equal(settings.endpoint, DEFAULT_ENDPOINT)
  assert.equal(settings.sessionLog, null)
  assert.equal(settings.sessionId, null)
})

test('the environment turns it on, and the patch row outranks the environment', () => {
  const env = {
    DSH_OTEL_EXPORTER: 'stdout',
    DSH_OTEL_ENDPOINT: 'http://collector:4318/v1/traces',
    DSH_OTEL_SESSION_ID: 'from-env',
  }

  assert.equal(resolveConfig({}, env).exporter, 'stdout')
  assert.equal(resolveConfig({}, env).endpoint, 'http://collector:4318/v1/traces')
  assert.equal(resolveConfig({}, env).sessionId, 'from-env')
  assert.equal(resolveConfig({ exporter: 'otlp-http' }, env).exporter, 'otlp-http')
  assert.equal(resolveConfig({ sessionId: 'from-patch' }, env).sessionId, 'from-patch')
})

test('a misconfigured exporter fails at load, not at the first export', () => {
  assert.throws(
    () => resolveConfig({ exporter: 'zipkin' }, {}),
    (error) => {
      assert.ok(error instanceof OtelExportError)
      assert.equal(error.code, 'OTEL_UNKNOWN_EXPORTER')
      return true
    },
  )
})

test('the registered tool declares an object parameter schema, both arguments optional', () => {
  const tool = registerTool()

  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.required, undefined)
  assert.equal(tool.parameters.properties.log.type, 'string')
  assert.equal(tool.parameters.properties.session_id.type, 'string')
  assert.ok(tool.description.length > 0)
})

test('an export returns a value shaped by the declared output schema', async () => {
  const lines = []
  const tool = createOtelExportTool({
    ...resolveConfig({ sessionLog: SESSION_FIXTURE, exporter: 'stdout' }, {}),
    sink: (line) => lines.push(line),
  })

  const value = await tool.execute({}, exec)

  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, OTEL_EXPORT_TOOL_NAME), [])
  assert.equal(value.plugin, PLUGIN_NAME)
  assert.equal(value.log, SESSION_FIXTURE)
  assert.equal(value.session_id, FIXTURE_SESSION_ID)
  assert.equal(value.exporter, 'stdout')
  assert.deepEqual([value.spans, value.turns, value.steps, value.tools], [6, 2, 2, 1])
  assert.equal(value.exported, 6)
  assert.deepEqual(value.malformed_lines, [5])
  assert.equal(lines.length, 1)
})

test('with the exporter off the counts still come back, and nothing is sent', async () => {
  const tool = registerTool()

  const value = await tool.execute({}, exec)

  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, OTEL_EXPORT_TOOL_NAME), [])
  assert.equal(value.exporter, 'off')
  assert.equal(value.exported, 0)
  assert.equal(value.spans, 6)
  assert.equal(value.endpoint, null)
  assert.equal(value.status, null)
})

test('the tool posts through the injected fetch, and never opens a socket', async () => {
  const calls = []
  const tool = createOtelExportTool({
    ...resolveConfig({ sessionLog: SESSION_FIXTURE, exporter: 'otlp-http' }, {}),
    fetch: (url, init) => {
      calls.push({ url, init })
      return Promise.resolve({ ok: true, status: 200 })
    },
  })

  const value = await tool.execute({}, exec)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, DEFAULT_ENDPOINT)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(value.endpoint, DEFAULT_ENDPOINT)
  assert.equal(value.status, 200)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, OTEL_EXPORT_TOOL_NAME), [])
})

test('the arguments override the configured log and session id', async () => {
  const tool = registerTool({})

  const value = await tool.execute({ log: SESSION_FIXTURE, session_id: 'sess-arg' }, exec)

  assert.equal(value.log, SESSION_FIXTURE)
  assert.equal(value.session_id, 'sess-arg')
})

test('a call with no log anywhere fails loudly', async () => {
  const tool = registerTool({})

  await assert.rejects(
    () => tool.execute({}, exec),
    (error) => {
      assert.ok(error instanceof OtelExportError)
      assert.equal(error.code, 'OTEL_NO_LOG')
      return true
    },
  )
})

test('render projects the validated value into one text content block', async () => {
  const tool = registerTool()

  const value = await tool.execute({}, exec)
  const blocks = tool.output.render({}, value)

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /6 span\(s\) — 2 turn\(s\), 2 step\(s\), 1 tool call\(s\)/)
  assert.match(blocks[0].text, /exporter is off, so nothing was sent/)
  assert.match(blocks[0].text, /Skipped 1 unparseable log line\(s\): 5\./)
})

test('invalid arguments fail loudly instead of executing', async () => {
  const tool = registerTool()

  for (const args of [{ log: 7 }, { session_id: false }, { log: [] }, null, [], 'export']) {
    await assert.rejects(
      () => tool.execute(args, exec),
      (error) => {
        assert.ok(error instanceof ToolArgsError)
        assert.ok(error.violations.length > 0)
        return true
      },
      `expected ToolArgsError for ${JSON.stringify(args) ?? String(args)}`,
    )
  }
})

test('an argument the tool does not declare is tolerated, not refused', async () => {
  const tool = registerTool()

  const value = await tool.execute({ verbosity: 'high' }, exec)

  assert.equal(value.plugin, PLUGIN_NAME)
})

test('the manifest declares the bundle patch the profile installer looks for', () => {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.name, PLUGIN_NAME)
  assert.equal(manifest.license, 'MIT')
  // The scope version a collector sees is this package's version.
  assert.equal(manifest.version, SCOPE_VERSION)

  const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
  assert.match(patch, /^- insert:$/m)
  assert.match(patch, new RegExp(`name: ${manifest.name}$`, 'm'))
  assert.match(patch, new RegExp(`id: ${name}$`, 'm'))
})
