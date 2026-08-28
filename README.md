# mcpproxy — Secure MCP Proxy for CLI Scripts

A secure local Model Context Protocol (MCP) proxy for AI-powered CLI scripts with real-time observability.

The model receives a task ("run tests"), the proxy decides **what exactly** to execute, the OS controls **what the executed code can do**, and the user observes both in real time.

**[📦 GitHub Repository](https://github.com/EgorKazachenko/mcpproxy)** — Source code, PR, issues, development

## Features

- **Parameter Validation (E2)**: Type checking, pattern matching, path confinement
- **Sandbox Execution (E3)**: Network isolation, file system confinement with symlink safety
- **Policy & Approvals (E1, E5)**: Manifest signing, dual-channel approvals
- **Audit & Redaction (E6, E8)**: Secret detection, event logging, threat modeling
- **MCP Integration (E4)**: Protocol bridge with hardened IPC

## Architecture

| Component | Purpose | Status |
|---|---|---|
| E1: Policy + Lock | Manifest verification, lock file | ✅ Complete |
| E2: Validation | Parameter validation, argv assembly | ✅ Complete |
| E3: Sandbox | Network/file isolation via Seatbelt | ✅ Complete |
| E4: MCP Bridge | Tool exposure, IPC hardening | ✅ Complete |
| E5: Approvals | Dual-channel confirmations | ✅ Complete |
| E6: Audit | Secret detection, event logging | ✅ Complete |
| E7: UI | Electron observability layer | ✅ Complete |
| E8: Red-team | Attack corpus, metrics | ✅ Complete |
| E9: Hardening | Threat validation, demo | ✅ Complete |

## Documentation

All documentation is in [`docs/`](docs/README.md):

- **[Problem & Hypothesis](docs/01-problem.md)** — Scope and falsifiability criteria
- **[Architecture](docs/02-architecture.md)** — Topology, components, invariants
- **[Threat Model](docs/03-threat-model.md)** — Attack surface and mitigations
- **[Research Findings](docs/04-research-findings.md)** — Industry research, CVEs
- **[Prior Art](docs/05-prior-art.md)** — Related solutions and differentiation
- **[Epics](docs/06-epics.md)** — Work breakdown and dependencies
- **[Contracts](docs/07-contracts.md)** — API schemas and invariants
- **[Demo Scenarios](docs/08-demo-scenarios.md)** — What we demonstrate
- **[Metrics & Evaluation](docs/09-metrics-and-eval.md)** — Attack corpus and evaluation
- **[Honest Limitations](docs/10-honest-limitations.md)** — What we don't protect and why

## Building & Testing

```bash
# Install dependencies
yarn install

# Type check
yarn typecheck

# Build
yarn build

# Run tests (650+ tests)
yarn test
```

## Development

This monorepo contains:
- `packages/contracts` — Shared API schemas and types
- `packages/core` — Validation, sandbox, audit, policy
- `packages/mcp-server` — MCP protocol bridge
- `packages/desktop` — Electron UI for observability

## License

See repository for license information.
