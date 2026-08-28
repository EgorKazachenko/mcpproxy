# 01 — Problem Statement and Hypothesis

## Problem

An AI agent can run local scripts: tests, builds, backups, log analysis.
But direct terminal access gives the model excessively broad permissions and increases the risk of:

- command injection;
- unauthorized file access;
- secret leakage;
- actions dictated by malicious content (indirect prompt injection).

## Hypothesis

A local MCP proxy that exposes to the model **only predefined tools**
and validates their parameters will make it possible to automate local tasks without giving the model
an arbitrary shell.

## Solution scope

1. A local MCP server that maps tools (`run_tests`, `build_project`, `analyze_logs`)
   to approved scripts.
2. **No `execute_command`-style tool** and no arbitrary text flowing into Bash.
3. An allowlist of binaries, arguments, working directories, and network operations.
4. Parameter and path validation before the script is launched.
5. Separate read and write permissions.
6. User confirmation for data deletion, publishing, network access,
   and other high-risk actions.
7. Running processes with minimal privileges, time limits, and bounded output.
8. Secret redaction and an audit log for every call.

**Addition to the original statement:** all of this is packaged as an Electron app
with live logs, so it's easy to see what's happening, how, and in which sandboxes.

## Metrics

| Metric | What it means |
|---|---|
| % of allowed tasks executed correctly | Utility — the proxy doesn't get in the way |
| Effectiveness of blocking injections and path traversal | ASR — Attack Success Rate |
| Number of false blocks | False blocks — the cost of security |
| Proxy overhead | Latency relative to a direct call |
| Number of high-risk operations that required confirmation | How often we have to interrupt the human |
| Number of secrets leaked into output and logs | Should be 0 |

**Utility and ASR are always shown together.** A defense with ASR = 0 and Utility = 0 is
`chmod 000`, not security. One number without the other proves nothing.

## Falsification criterion

The hypothesis is considered refuted if the proxy:

- can be bypassed through tool arguments, paths, or output;
- requires too many exceptions for typical tasks;
- excessively blocks safe actions;
- **fails to provide a clear security improvement over calling scripts directly.**

The last point is the most dangerous, because it's easy to fool yourself about it.
A direct script call gives you neither a sandbox, nor an audit trail, nor confirmations — but
an argument allowlist without a sandbox really adds almost nothing.
See [05-prior-art.md](05-prior-art.md).

## Statement of novelty

**Wrong:** "the novelty is that we allowlist binaries and validate parameters."
That's already been done and is on GitHub (see prior art).

**Right:** the argument allowlist protects against **what the model asks to run**.
It does nothing to protect against **what the code that runs actually does**. Existing solutions
stop at the first. We do the second — and we show it to the human.

## Framing

We are **not** solving prompt injection in general. We reduce the attack surface to zero
in the place where a shell used to be. In theory this is close to the CaMeL approach
(control flow is extracted from the trusted request, untrusted data cannot influence it):
our **recipe is a capability**. The difference is that our domain is narrow (CLI tasks
within a repository), and that's exactly why we can achieve a better result in it than
general-purpose defenses achieve across a broad domain.
