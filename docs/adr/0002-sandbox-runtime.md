# ADR-0002 — Sandboxing via `@anthropic-ai/sandbox-runtime`

**Status:** accepted · 2026-08-27

## Context

OS-level filesystem and network isolation is needed on macOS. The original plan was to hand-write
SBPL profiles for `sandbox-exec` — the most tedious part of epic E3.

## Options

1. Our own SBPL profiles. Full control, 1–2 days of debugging, our own bugs, no network filtering.
2. A Docker container. Cross-platform, but requires Docker on the demo viewer's machine,
   +300–800 ms per call (hurts the overhead metric), and write policy via mounts is more complex.
3. **`@anthropic-ai/sandbox-runtime` (srt).** Chosen.

## Decision

A wrapper around `srt`. Our manifest maps onto its config; `getViolationsForCommand`
is forwarded to the event bus and to the UI timeline.

We implement three modes: `none` (demo baseline), `seatbelt` (primary), `container` (stub).

## What we get for free

- Generation of seatbelt profiles, bubblewrap on Linux, WFP on Windows
- HTTP + SOCKS5 proxy for domain-based network filtering
- Asymmetric permission model: reads are deny-then-allow, writes are allow-only
- Mandatory deny paths (`.bashrc`, `.git/hooks/`, `.claude/commands/`, etc.)
- **A structured stream of sandbox violations** — ready-made content for the UI

## Consequences

- ✅ E3 is roughly three times cheaper
- ✅ Same foundation as Claude Code's native sandbox
- ⚠️ We inherit its limitations (domains rather than content, domain fronting,
  `allowUnixSockets`, `allowAppleEvents`) — documented in 10-honest-limitations.md
- ⚠️ Research preview: the API may change. We isolate it behind our own `Sandbox` interface
