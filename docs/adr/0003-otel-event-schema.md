# ADR-0003 — Event schema compatible with OpenTelemetry GenAI

**Status:** accepted · 2026-08-27 · **Blocks E0**

## Context

An audit event schema is needed. The temptation is to invent one that's "just for the task."

## Decision

**Our own internal event shape plus a pure exporter function `toOtlp`** — not the native OTel
schema. The internal shape is nested, timestamps are ISO-8601, enums are strings; the exporter
emits a valid OTLP/JSON span with `gen_ai.operation.name: execute_tool`, span kind INTERNAL, and a
trace/span id. Our own fields go under the `mcpproxy.*` namespace.

**2026-08-27 correction.** The earlier statement "as of v1.42.0 the MCP conventions moved into the
same OTel repo" is wrong: the direction is reversed. `model/mcp/registry.yaml` is present in
v1.39.0–v1.41.x and **absent from v1.42.0 onward** — everything under `gen_ai.*` and `model/mcp/`
moved into a separate `open-telemetry/semantic-conventions-genai` repo, which has no tagged
releases at all. Binding a frozen contract directly to a schema that just changed repos and has no
releases is not acceptable — hence the exporter instead of inheritance.

## Consequences

- ✅ Free export into any observability stack — as a **summary**, not the full record: the span
  carries counts (`mcpproxy.redactions.count`, `mcpproxy.sandbox.violations.count`), but not the
  sandbox profile, annotations, or the chain at all. The full record lives in JSONL. Span status
  is set only on `verdict: "error"`; a policy denial is a normal decision outcome, not a failure
- ✅ The pitch is "plugs into an existing pipeline," not "yet another log format"
- ✅ A ready-made attribute dictionary — nothing to invent
- ⚠️ The `gen_ai.*` status is "Development," not Stable, and the repo changed without tags.
  The drift is isolated in a single `toOtlp` function — it does not touch the frozen contract
- ⚠️ An OTLP receiver is required to **silently ignore** fields with unknown names, so a naming
  mistake (`trace_id` instead of `traceId`) is unobservable by anything except a test that
  forbids underscores in output keys
- ❗ **The cost of this decision is zero if it's factored into E0. Redoing it later means
  rewriting seven dependent epics.** That's why the decision is made before the contract freeze
