# Security Policy

## Reporting a Vulnerability

Please do not open a public GitHub issue for a security report.

Use GitHub's private advisory form:

https://github.com/jwilson411/dsh-otel/security/advisories/new

Include the version or commit, steps to reproduce, and what an attacker gains.

## Scope

dsh-otel is a DeepSeek Harness function plugin and a CLI. It registers one model-facing tool, `otel_export`. The tool reads a session log and builds OpenTelemetry spans: one span per turn, per step, and per tool call, linked into one trace.

The exporter is off by default (`exporter: off`, or `DSH_OTEL_EXPORTER`). With no exporter configured the spans are still built and counted, but nothing leaves the process. `stdout` writes the OTLP/JSON document to stdout. `otlp-http` POSTs that document as `application/json` to a collector. The default endpoint is `http://127.0.0.1:4318/v1/traces`. There is no API key.

A span carries names, ids, timings, and the token counts the log itself reported. Prompts, tool arguments, and tool results are never placed on a span. Ids are derived from the session id and the log's coordinates, not generated at random.

The package does not observe the harness at runtime. It does not write to the session log. It does not ship an OpenTelemetry SDK.

Pointing `endpoint` at a remote collector is a deployment choice. An attacker who already controls the process running the harness, or who can read the session log this package exports, is out of scope.

## Supported versions

Only the latest release receives security fixes.
