# ADR-0001 — Shim / daemon / UI split

**Status:** accepted · 2026-08-27

## Context

The MCP client spawns the server as a subprocess over stdio. An Electron observability loop is required.

## Options

1. Electron as the MCP server host. Spawning Electron per session: multiple windows,
   heavy startup, no unified audit trail.
2. A single headless daemon + Electron as a separate viewer connecting to the daemon.
3. A thin stdio shim → daemon → UI. **Chosen.**

## Decision

Three parts: `mcpproxy-shim` (stdio bridge), `mcpproxyd` (core), Electron (observation and approvals).
`packages/core` — all daemon logic as a library **with no Electron import**.

The daemon embeds `core`; if the app isn't running, the shim launches it.
The `--require-ui` flag enables strict fail-closed mode ("no UI → no audit → no execution").

## Consequences

- ✅ One audit trail and one policy across all client sessions
- ✅ `core` is testable in CI without a display
- ✅ Approvals are possible outside the model's context
- ⚠️ An IPC boundary appears, and it becomes an attack vector in its own right — see the ADR and
  invariant И6, and the MCP spec section "stdio Transport Security in Proxy Scenarios."
  Mitigation: 0600 socket permissions, peer-cred check, per-session token, and most importantly —
  the daemon only accepts `{recipe, params}`, never argv.
