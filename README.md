# dsh-otel

A **DeepSeek Harness function plugin** that exports a session as
**OpenTelemetry spans**: one span per turn, per step, and per tool call, linked
into one trace, sent to any OTLP/HTTP collector — Jaeger, Phoenix, Grafana
Tempo, the OpenTelemetry Collector — or written to stdout.

The scope is one direction: **the session log out, as spans.** The harness
already writes a durable record of what happened; Jaeger already knows how to
draw a trace. What is missing is the translation, and that is all this is.
Nothing here observes the harness at runtime, buffers, samples, or writes to
the session log.

It is **off by default**, it takes **no OpenTelemetry SDK** as a runtime
dependency — the OTLP/JSON document is written by hand — and it puts **no
prompts, tool arguments, or tool results** on a span. A span carries names,
ids, timings, and the token counts the log itself reported.

## Install

```sh
dsh plugin --profile web add github:jwilson411/dsh-otel
```

`dsh plugin` forwards to pnpm inside `$DSH_HOME/profiles/web`, then reconciles
the profile: because this package's manifest declares `dsh.bundle.patch`, it is
appended to the profile manifest's ordered `dsh.profile.bundles` list and its
`cordis.patch.yml` becomes a layer. Remove it the same way, with `remove` in
place of `add`.

Note that `@deepseek-ai/dsh-tools`'s npm `latest` tag still points at the older
`0.0.1-rc.1`; the `0.1.1-rc.2` line is published under `next`. Pin explicitly
rather than relying on the tag.

Turn it on from the profile's own `cordis.patch.yml` — note that an id-targeted
patch replaces the row's whole `config`, so restate every field you mean to
keep:

```yaml
- id: otel
  config:
    exporter: otlp-http
    endpoint: http://127.0.0.1:4318/v1/traces
    sessionLog: ~/.dsh/sessions/current.jsonl
    sessionId: sess-1
```

| config key | environment fallback | default |
|---|---|---|
| `exporter` | `DSH_OTEL_EXPORTER` | `off` — one of `off`, `stdout`, `otlp-http` |
| `endpoint` | `DSH_OTEL_ENDPOINT` | `http://127.0.0.1:4318/v1/traces` (used only by `otlp-http`) |
| `sessionLog` | `DSH_OTEL_SESSION_LOG` | unset — a call naming no log fails loudly |
| `sessionId` | `DSH_OTEL_SESSION_ID` | unset — falls back to the log's header, else `unknown` |

**Off is the default on purpose.** With no exporter configured the plugin still
registers its tool and the tool still builds and counts spans — so a model can
answer "how did that run go?" — but nothing leaves the process. Telemetry
crossing a machine boundary should be a thing someone turned on.

## The spans

| span | opened by | closed by | parent |
|---|---|---|---|
| `dsh.session` | the first timed event | the last event | — (root) |
| `dsh.turn` | `turn/start` | `turn/end` | `dsh.session` |
| `dsh.step` | `step/start` | `step/end` | its turn |
| `dsh.tool.execute` | `tool/call` | the `tool/result` with the same `callId` | its step |

Attributes:

| key | on | meaning |
|---|---|---|
| `session.id` | every span | the session the trace belongs to |
| `dsh.turn` | turn, step, tool | the turn number |
| `dsh.step` | step, tool | the step number within the turn |
| `dsh.event.seq.start` / `dsh.event.seq.end` | every span | the log lines the span was opened and closed by |
| `dsh.turn.reason` | turn | `data.reason` from `turn/end`, when the log reported one |
| `tool.name`, `tool.call_id` | tool | the tool and the call it answered |
| `tool.error` | tool | whether the result reported a failure |
| `dsh.usage.*` | step | token counts, copied verbatim from `assistant/message`'s `usage` |
| `dsh.span.unclosed` | any | the log ended before this bracket closed |

Status is `OK` unless a tool result reported an error or a turn ended with a
reason that reads like failure (`error`, `failed`, `cancelled`). The mapping is
deliberately conservative: an unfamiliar reason is reported OK rather than
guessed at.

`dsh.usage.*` is copied, never computed. No text is tokenised, nothing is
summed, and a count the log did not report is simply absent.

### Ids are derived, not generated

The trace id is `sha256(sessionId)` truncated to 32 hex characters; a span id is
`sha256("<sessionId>/<key>")` truncated to 16, where the key is the bracket's
own coordinates in the log:

```
turn:1                      → the turn span
turn:1:step:2               → its second step
turn:1:step:2:tool:call_7   → the tool call inside that step
```

So exporting the same log twice produces the same tree. If the collector was
down the first time, re-run the export — you repair the gap rather than
duplicating it. With no session id anywhere, ids derive from the literal string
`unknown`.

### What the reader tolerates

- A line that is not JSON is counted, reported in `malformed_lines`, and
  skipped. A tail that caught a partial write does not cost you the trace.
- An event type this plugin does not know is ignored.
- A bracket the log never closed is ended at the last event's instant and
  marked `dsh.span.unclosed`, rather than dropped — an in-flight tool call at
  EOF is usually the one you came for.
- A `step/start` with no `turn/start` above it synthesizes its turn, so the
  tree never has a dangling parent.

## Try it against Jaeger

```sh
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
dsh-otel export --log ~/.dsh/sessions/current.jsonl --session sess-1 --exporter otlp-http --endpoint http://127.0.0.1:4318/v1/traces
# UI: http://127.0.0.1:16686
```

## The `otel_export` tool

| | |
|---|---|
| Cordis plugin id | `otel` (the row id in `cordis.patch.yml`) |
| Injects | `tools` — a hard dependency; the plugin waits rather than degrading |
| Tool | `otel_export` |
| Arguments | `log` (string, optional), `session_id` (string, optional) |

`log` defaults to the configured `sessionLog` and `session_id` to the
configured `sessionId`, else the id the log's header names. A call with no log
from either place fails loudly rather than exporting an empty trace.

It returns `log`, `session_id`, `trace_id`, `exporter`, `endpoint`, `spans`,
`exported`, `turns`, `steps`, `tools`, `malformed_lines`, and `status`.
`exported` is how many spans actually left the process, so it is `0` whenever
the exporter is off while the counts still describe the run.

The tool reads a file and, at most, POSTs to the endpoint you configured. It
needs no API key.

## The CLI

The same export from a shell. It imports nothing outside `node:` and this
package, so it runs against a checkout with no dependencies installed — useful
when the trace is the thing you need and the harness is the thing that is
broken.

```sh
dsh-otel export --log <path> [--session <id>] [--exporter off|stdout|otlp-http]
                [--endpoint <url>] [--service <name>] [--json]
```

**stdout carries the OTLP document and nothing else**, so a redirect is always
a valid file; the run's report goes to stderr, as text or, with `--json`, as
JSON. The CLI defaults to the `stdout` exporter — you asked for an export at a
prompt, so printing it is the least surprising thing it can do, and it still
sends nothing anywhere.

```
$ dsh-otel export --log ~/.dsh/sessions/current.jsonl > spans.json
session sess-1 → trace 4f8c…
14 span(s): 3 turn(s), 6 step(s), 4 tool call(s)
14 span(s) written to stdout
skipped unparseable log line(s): 92
```

## Out of scope

- **A hosted product.** This is a file reader and an HTTP POST.
- **A UI.** Jaeger, Phoenix, and Tempo already draw traces.
- **Replacing or annotating the session log.** The log is the source of truth
  and this package only reads it — no sidecar, no cursor file, no state.
- **A Langfuse clone.** No prompt capture, no evals, no datasets, no scoring.
- **Runtime instrumentation.** Spans come from the log after the fact, not from
  hooks inside a running turn.

## Layout

```
package.json        manifest + `dsh.bundle.patch` — what makes this a bundle
cordis.patch.yml    the bundle's patch layer: one insert, one plugin row
src/session.js      reading the session log as JSONL, tolerating bad lines
src/spans.js        events → spans, with ids derived rather than generated
src/otlp.js         the OTLP/JSON document and the three exporters
src/export.js       one export: read, build, send, report
src/index.js        the plugin: `name`, `inject`, `apply(ctx, config)`
bin/                the CLI
test/               offline tests over a checked-in fixture log
package-lock.json   the pinned dependency tree `npm ci` installs in CI
```

## Tests

```sh
npm install
npm test
```

Offline by construction. Every test reads the checked-in
`test/fixtures/session.jsonl`; the `stdout` exporter writes to an injected sink
and `otlp-http` posts through an injected `fetch`, so the whole export path is
exercised without a collector, a socket, or a key.

Only `test/plugin.test.js` needs a dependency: it registers the plugin against a
stub context and validates the tool's result with the real
`@deepseek-ai/dsh-tools`, pinned to `0.1.1-rc.2` in `devDependencies` and in
`package-lock.json` so the contract is tested against one known API. Everything
else — the library, the CLI, and the other three test files — imports nothing
outside `node:` and this package.

CI (`.github/workflows/ci.yml`) runs `npm ci` and `npm test` on Node 22 and 24
from the committed lockfile, against the public registry only. It needs no
credentials and the suite reaches no network.

## License

MIT — see [LICENSE](LICENSE).
