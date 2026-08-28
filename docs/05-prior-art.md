# 05 — Prior Art and Differentiation

## An uncomfortable truth

The first half of our scope has already been implemented and is sitting on GitHub.

### `tumf/mcp-shell-server`

Self-description: *"Secure MCP server for whitelisted shell command execution with stdin,
argv pipelines, timeouts, and structured audit logging."* Already has:

- argv execution **without** shell-string interpretation
- command allowlist via environment variable
- isolated child-process environment — doesn't inherit the parent env,
  only minimal launch keys like `PATH`
- server-side timeouts by default
- redirects confined to the working directory
- structured audit logging
- safe pipelines with validation of every argv segment

### `cfdude/mac-shell-mcp`

An MCP server for macOS/ZSH with a built-in whitelist and an approval mechanism.

### One category up: MCP gateways

A different class of solution — enterprise gateways between agents and MCP servers:
[Docker MCP Gateway](https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/),
[ToolHive](https://github.com/stacklok/toolhive), MCPX (Lunar.dev), Obot, Lasso, mcp-firewall,
[Invariant Guardrails](https://invariantlabs.ai/blog/introducing-mcp-scan).
They solve the "many agents × many MCP servers × RBAC/SSO/audit" problem — that's not our problem.
We solve "one developer, local scripts, observability."

## What this means

**The claim "our novelty is that we allowlist binaries and validate parameters"
no longer holds.** That's already been done.

Moreover, this is a genuine hit against our own falsification criterion: allowlisting
arguments without a sandbox gives little improvement over calling a script directly,
because it doesn't protect against what the executed code actually does.

## Where we actually differ

| Capability | mcp-shell-server | MCP gateways | mcpproxy |
|---|---|---|---|
| argv-only, allowlist, timeouts | ✅ | ✅ | ✅ |
| Child-process env isolation | ✅ | ◐ | ✅ |
| **OS-level sandbox (FS + network at kernel level)** | ❌ | ◐ containers | ✅ seatbelt |
| **Risk tiers built on standard MCP annotations** | ❌ | ◐ | ✅ |
| **Out-of-band confirmations outside the model's context** | ❌ | ❌ | ✅ |
| **Secret redaction in + out** | ❌ | ✅ Docker | ✅ |
| **Tamper-evident audit (hash-chain)** | plain log | plain log | ✅ |
| **Manifest lock file against rug pull** | ❌ | ◐ signature verify | ✅ |
| **Real-time visual observability surface** | ❌ | ◐ dashboards | ✅ Electron |
| **Own red-team corpus with published metrics** | ❌ | ❌ | ✅ |
| Orientation | server | infrastructure/enterprise | local developer |

## Demo thesis

> Argument allowlisting protects against **what the model asks to run**.
> It does nothing to protect against **what the executed code does**.
> Existing solutions stop at the first.
> We do the second — and show it to the human.

## Answer to the falsification criterion

*"Does not provide a clear improvement over calling scripts directly"* —
calling a script directly does not give you:

- OS-level filesystem and network isolation,
- verifiable audit,
- confirmations on high-risk operations,
- secret redaction,
- protection against the script itself being swapped between calls.

The `sandbox: none` baseline mode exists in the demo precisely so that this
doesn't have to be asserted — it can be shown.
