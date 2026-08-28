# mcpproxy — documentation

A secure local MCP proxy for CLI scripts + an Electron observation layer.

The model gives a task ("run the tests"), the proxy decides **exactly what** to run, the OS
decides **what the running process can do**, and a human sees both in real time.

## Document map

| # | Document | About |
|---|---|---|
| 01 | [Problem statement and hypothesis](01-problem.md) | Problem, hypothesis, scope, falsification criterion |
| 02 | [Architecture](02-architecture.md) | Topology, components, invariants, data flows |
| 03 | [Threat model](03-threat-model.md) | Attack map, what catches what, OWASP ASI mapping |
| 04 | [Industry research](04-research-findings.md) | Findings from specs, CVEs, research, tools |
| 05 | [Prior art](05-prior-art.md) | Existing solutions and our differentiation |
| 06 | [Epics](06-epics.md) | Work breakdown, dependencies, parallelization |
| 07 | [Contracts](07-contracts.md) | Manifest schema, event schema, API invariants |
| 08 | [Demo scenarios](08-demo-scenarios.md) | What we show, in what order, what we say |
| 09 | [Metrics and evaluation](09-metrics-and-eval.md) | Red-team corpus, metrics, methodology |
| 10 | [Honest limitations](10-honest-limitations.md) | What we **do not** protect against, and why |

## ADR — recorded decisions

| ADR | Decision |
|---|---|
| [0001](adr/0001-shim-daemon-split.md) | Split shim / daemon / UI instead of a monolithic Electron app |
| [0002](adr/0002-sandbox-runtime.md) | Seatbelt via `@anthropic-ai/sandbox-runtime`, not our own SBPL |
| [0003](adr/0003-otel-event-schema.md) | Event schema compatible with OpenTelemetry GenAI |
| [0004](adr/0004-mcp-tool-annotations.md) | Risk tiers based on standard MCP tool annotations |
| [0005](adr/0005-dual-channel-approvals.md) | Dual-channel approvals: elicitation + out-of-band |
| [0006](adr/0006-manifest-lockfile.md) | Manifest lock file against rug pull |
| [0007](adr/0007-network-domain-allowlist.md) | Network domain allowlist instead of a binary deny |

## Presentations

The `/mcpproxy-deck` skill builds slide decks from these documents:
architecture, a walkthrough of any demo scenario, comparison tables, a coverage map,
honest conclusions. The documents are the source of truth, the decks are derived.

## Status

Design is complete, industry research has been done. The next step is E0 (contracts).
