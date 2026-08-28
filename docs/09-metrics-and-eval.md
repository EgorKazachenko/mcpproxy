# 09 — Metrics and Evaluation

## Methodological Framework

We borrow the terminology and a couple of metrics from established agentic security benchmarks
(InjecAgent — 1054 cases; AgentDojo — 97 tasks and 629 security cases). The corpora themselves
don't fit our case (they're about email clients and banking), but the methodology does.

**Main rule: ASR and Utility are always reported as a pair.**

| Metric | Definition | Target |
|---|---|---|
| **ASR** (Attack Success Rate) | Share of corpus attacks that reached their goal | 0% |
| **Utility under Attack** | Share of legitimate tasks completed correctly while the attack corpus is active | ≥ 95% |
| **False blocks** | Legitimate tasks blocked erroneously | ≤ 5% |
| **Overhead** | Proxy latency relative to a direct call of the same script — the sum of stage durations **outside** the set `{spawn, violation, approval, complete}` | ≤ 50 ms p95 |
| **High-risk rate** | Share of calls that required confirmation | low; high = confirmation fatigue |
| **Secret leaks** | Secrets in outputs and logs | 0 |

The excluded set of stages is part of the definition, not an implementation detail: `spawn` is
child-process time, `violation` occurs inside the `spawn` window and would double-count what's
already been counted, `approval` is a human at the modal (otherwise scenario S8 would report tens
of thousands of milliseconds), and `complete` is the event at which the value is computed. It is
computed from the event's monotonic `durationUs`, not from the difference between ISO timestamps:
those are quantized to the millisecond and jump around with NTP.

A defense with ASR = 0 and Utility = 0 is just `chmod 000`. An ASR figure taken in isolation
is not a result.

## Legitimate Task Corpus (Utility)

Measures the cost of security. It must be realistic, not convenient.

| Class | Examples |
|---|---|
| Tests | full run, pattern-matched, snapshot update, with coverage |
| Build | dev, prod, with a clean cache, with dependency installation (requires network) |
| Analysis | log parsing, log search, reporting |
| Formatting | lint, format with writes to source files |

**We deliberately include tasks that require network access** (`npm ci`) and **writes to source
files** (`format --write`) — these are exactly the tasks that generate false blocks and verify
that the domain allowlist and the permission model actually work, rather than just denying
everything.

## Attack Corpus (ASR)

Maps to the attack catalogue in [03-threat-model.md](03-threat-model.md).

| Class | Cases | Source of the class |
|---|---|---|
| A1 Parameter injection | ~15 | baseline (`;`, `&&`, `$()`, backticks, newline, Unicode homoglyphs, null byte) |
| A2 Path traversal | ~10 | baseline (`../`, absolute path, URL-encoding, double encoding) |
| A3 Symlink escape | ~5 | baseline |
| A4 PATH hijack | ~3 | baseline |
| **A5 IPC socket attack** | ~5 | **MCP spec, "stdio Transport Security in Proxy Scenarios"** |
| **A6 Manifest rug pull** | ~5 | **CVE-2025-54136** |
| **A7 Injection into `description`** | ~5 | **tool poisoning / line jumping, Invariant Labs** |
| **A8 Injection in script output** | ~8 | **OWASP ASI01** |
| **A9 Exfiltration via postinstall** | ~5 | **OWASP ASI04** |
| A10 Reading secrets from the filesystem | ~8 | baseline |
| **A11 Writing to persistence paths** | ~8 | **mandatory deny from sandbox-runtime** |
| A12 Secret leakage via env | ~5 | baseline |
| A13 Runaway / fork bomb / output flooding | ~5 | baseline |
| **A14 Forging confirmation via elicitation** | ~3 | **OWASP ASI09** |
| A15 Electron IPC / CSP | ~5 | Electron security checklist |

The six highlighted classes are a direct result of industry reconnaissance, not our own
invention. This is an important point for the demo: the corpus grows from external sources, not
from the author's imagination.

## Run Rules

1. **A baseline is mandatory.** Every attack class is run under both `sandbox: none` and
   `seatbelt`. Without the contrast, a block-rate figure is not interpretable.
2. **No silent truncation.** If a run skips something (timeout, unavailable dependency), that
   is stated explicitly in the report. Silently shrinking coverage reads as "we covered
   everything."
3. **Overhead is measured relative to a direct call** of the same script, not relative to
   zero.
4. **Attacks are executed in an isolated demo repository**; exfiltration targets a local
   listener, not a real external host.
5. The run is part of CI and, at the same time, the "Red team" tab in the UI. One
   implementation, two entry points.

## Report

```
=== mcpproxy red-team ===
Mode: seatbelt             Baseline: none

Utility
  Legitimate tasks:      42
  Completed correctly:   41  (97.6%)
  False blocks:           1  (2.4%)   ← format --write in node_modules/.cache

Attacks
  Total cases:            90
  Blocked:                90  (ASR 0.0%)
  Baseline (none):        31 of 90 passed (ASR 34.4%)

Utility under Attack:   97.6%
Overhead p50/p95:       9 ms / 21 ms
Confirmations:          3 of 42 calls (7.1%)
Secrets in output:      0
Skipped cases:          0
```

This table is the last technical slide of the demo. The pair `ASR 0.0% / Utility 97.6%`
next to the baseline `34.4%` is what makes the result meaningful.
