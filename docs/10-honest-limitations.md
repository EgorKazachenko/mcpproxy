# 10 — Honest Limitations

This document exists because a technical audience trusts a project that knows its limits,
and does not trust a project that claims to have "protected everything."
The final demo slide is assembled from this document.

## What We Protect Well

| Area | Mechanism | Why we're confident |
|---|---|---|
| Command injection via parameters | argv-only, schemas with mandatory regex | Structural protection: there is no command string to inject into |
| Escaping directory boundaries | realpath + confinement, plus `denyRead`/`allowWrite` in the kernel | Two independent lines of defense |
| Secret leakage from the environment | env-allowlist — secrets never enter the process | Protection at the entry point, not filtering at the exit |
| Exfiltration to a disallowed domain | Deny-by-default egress through the proxy | A kernel-level restriction, inherited by the whole process tree |
| Persistence via shell configs and git hooks | Non-removable mandatory deny paths | Cannot be allowed by mistake |
| Silent recipe substitution | Lock file + diff-approve | Confirmed as a real attack class by CVE-2025-54136 |
| Forging confirmation | Out-of-band channel outside the model's context | The confirmation doesn't live in a channel that can be compromised |
| Undetected tampering with the call history | Hash-chain audit | A discrepancy is detected deterministically |

## What We Protect Partially

| Area | What works | Where the gap is |
|---|---|---|
| **Exfiltration to an allowed domain** | Domains outside the allowlist are blocked | Once you allow `github.com`, you can push data to your own repository. Filtering is by domain, not by content |
| **Domain fronting** | Normal traffic is filtered | Technically bypassable — the proxy doesn't inspect content |
| **Indirect prompt injection in output** | Output is marked untrusted, scanned, and truncated | The model still reads it. We reduce the probability; we don't eliminate the class |
| **Secret redaction in output** | Two-sided scan: 22 rules from gitleaks/Secrets-Patterns-DB on the RE2 engine plus base64 entropy scoring. The order is frozen — redaction happens BEFORE truncation, otherwise the byte cap would cut a secret in half and the head would leak into the model | Two measured limits. **By length:** the entropy detector catches 1% of tokens 23 characters long, 29% at 28 characters, 98% at 40 characters. Below ~28 characters it essentially doesn't work, and such secrets are caught only by regex — meaning only the ones with a characteristic prefix. **By alphabet:** for hex there is no threshold at all — a 32-character Twilio key (entropy p50 3.62) and a git sha (3.70) are indistinguishable, and any threshold that catches the first also cuts out every other git sha. This is exactly why И4 calls redaction a safety net, with the real protection being the env-allowlist at the entry point |
| **Secret parameter without a characteristic format** | Named rules strip it from the `argv` copy used for logging | The entropy detector is deliberately disabled on the inbound direction: on `argv` it produces false positives on paths and build identifiers, and a placeholder in their place destroys the forensic value of the record. The result: a long session key passed by the model as a parameter lands in the append-only log **verbatim** and ends up in exports |
| **The output cap applies per stream** | `stdout` and `stderr` are each capped at `output.maxBytes` | This means up to `2 × maxBytes` can reach the model. A shared budget would be worse: a long `stdout` would eat all of `stderr`, and on a failed build the model would get a pile of logs with no error line. But the event schema carries a **single** `output.{bytes,truncated}` pair, so `bytes ≤ maxBytes` cannot be read as an invariant |
| **Regex quality in the manifest** | A `string` without a `pattern` is a load error | A weak regex written by the author is a weak first line of defense. Only the second line saves you |
| **ReDoS via the manifest `pattern`** | Patterns are compiled with **RE2**, which never backtracks; inside the daemon, consumers are handed a compiled matcher, not a string | The guarantee ends at the daemon boundary: **the `pattern` string itself travels to the MCP client** inside `Tool.inputSchema`, and the client's engine does backtrack — `^(a+)+$` is a legal RE2 pattern. Also, RE2 doesn't support lookahead or backreferences, so a legitimate pattern may be rejected, and there's a residual cost: `re2` is a native module built on every developer's machine and on every CI runner |
| **TOCTOU during path resolution** | Resolution is correct | The file can be swapped between resolution and opening. Mitigated by the fact that `denyRead` in the sandbox doesn't depend on resolution |
| **Confirmation fatigue** | Tiers are assigned automatically, high-risk is rare | If there are too many high-risk operations, a human will start clicking through without looking |
| **Writing to the project's executable files** | Persistence paths outside the project are closed | Inside the project's allowed directory, writing to a script is possible — a deliberate trade-off for usability |

### ReDoS: What the Measurement Cost

This vector wasn't in the threat model, and the first formulation of the defense was wrong.
Measured on node 22.15.0: `(a+)+$` on a 30-character input — 4.5 s, growing ×4 for every +2
characters; extrapolated to 64 characters — on the order of 10¹³ ms. **Limiting input length
does not save you** — 64 characters is the length from our own example `^[\w./-]{0,64}$`. RE2 on
the same pattern at the same length — 0.009 ms.

Closed **inside the daemon**, at two boundaries: the pattern is compiled with RE2 at manifest
load time (if it fails to compile — a load error with code `pattern` and a stated reason), and
consumers inside the process are handed a compiled matcher that exposes neither `source` nor
`flags`. The matcher exists precisely so that E2 never has to call `new RegExp(pattern)` and
reopen a vector that was closed at load time.

**What this boundary does NOT close — and earlier this was overstated relative to reality.**
The `pattern` string from the package doesn't disappear: it's mandatory in the schema, the type
is generated from that same schema, so it lives in `Manifest` — and, crucially, `toTool` places
it into `inputSchema`, which travels to the model via `tools/list`. Without it, the model has no
way to validate the argument. That means the untrusted string does reach the MCP client's JS
engine, and that engine does backtrack. Concretely: `^(a+)+$` is a **legal** manifest pattern
(RE2 is linear on it and passes it in 0.009 ms, `parseManifest` returns `ok: true`), and that
same pattern travels to the client as a string. RE2's syntax forbids lookahead and backreferences
but allows nested quantifiers, so "RE2 accepted it" does not mean "safe at the consumer." The
guarantee extends to the daemon, not to the MCP client.

The price we pay: RE2 syntax is declared part of the contract, so lookahead and backreferences
don't work in the manifest — and they don't work in **our own** schema either, because the same
engine is threaded into the validator. Also, `re2` is a native module: it gets built on every
developer's machine and on every CI runner regardless of which entry point imports it, because
package managers have no dependency scoping by entry point. Only macOS arm64 has been verified;
building on Linux and Windows has not been tested.

### Canonical Serialization: What's Not Covered

The JCS (RFC 8785) implementation is verified against the test vectors from the RFC text,
including boundary numeric values, key ordering by UTF-16 code units, and escaping. The full
numeric test file `es6testfile100m.txt` (≈3.8 GB, 100 million values) **is neither vendored nor
run** — coverage of the numeric domain is partial.

## What We Don't Protect At All

| Not protected | Why |
|---|---|
| **A malicious user** | It's their machine. The threat model is "the user is benevolent, but content is untrusted" |
| **The macOS kernel and `sandbox-exec` itself** | We rely on the OS. A vulnerability in seatbelt goes straight through us. Also, Apple formally considers `sandbox-exec` deprecated |
| **The model itself** | We have no influence over what the model decides to call. We only influence what it can physically call and what the called thing can do |
| **The Node/npm supply chain prior to execution** | We catch a malicious dependency's behavior at runtime. We don't verify package provenance (that's done by Docker MCP Gateway via `--verify-signatures` and similar tools) |
| **Tamper-proof audit** | Our log is tamper-**evident**. An attacker with file permissions can rewrite it entirely and recompute the chain. Fixed by publishing the Merkle root externally — cheap, but not in the current scope |
| **Truncating the tail of the log** | By removing the last entries entirely, an attacker leaves the chain internally consistent: the verification predicate links each record to the previous one, not to an external anchor. Needs the same Merkle root or an external timestamp |
| **Plain-text injection in `description`** | Sanitization strips invisible content — control characters, ANSI, zero-width, bidi — and caps length. It does not and cannot touch text like `IGNORE PREVIOUS INSTRUCTIONS`: the contract promises that the description is **reduced**, not that it is safe |
| **Multi-user and enterprise scenarios** | RBAC, SSO, fleet-wide agent policy — that's the job of MCP gateways, not ours |
| **Windows and Linux** | The sandbox interface is cross-platform, but only macOS/seatbelt is implemented |

## Known Weaknesses of the Borrowed Layer

Declared in `@anthropic-ai/sandbox-runtime` and inherited by us:

- `allowUnixSockets` with `/var/run/docker.sock` = full host access
- `enableWeakerNetworkIsolation` (needed for Go TLS) opens a vector through `trustd`
- `allowAppleEvents` "removes code-execution isolation" — applications launched via
  `open`/`osascript` run outside the sandbox
- Writing, inside an allowed directory, to a file that later gets executed — a bypass
- On Linux, bubblewrap only blocks files that already exist

We **don't support these flags at all**: `allowUnixSockets`, `allowAppleEvents`, and
`enableWeakerNetworkIsolation` are inexpressible in the manifest's frozen `SandboxProfile` — there
is no field for them and none can be added. The "weakened mode" badge in the UI covers what is
expressible: a bare `*` in `network.allow` and patterns the vendor's schema considers too broad
(`*.com`).

## What the srt Investigation Found: Boundaries Discovered by Measurement

Deliberately kept separate from the previous list: that one is what the vendor declared;
this one is what we found through probes on `@anthropic-ai/sandbox-runtime@0.0.74`
(`docs/vibe-coding/27.08.2026-e3-sandbox/probes.md`).

| Boundary | Specifics | Measurement |
|---|---|---|
| **There is no real `setrlimit`** | A fork bomb is caught by a timeout and `SIGKILL` sent to the process **group**, not by a limit on the number of processes or on memory. Killing by a single pid leaves the tree alive | П4: "surviving sleep processes after kill(pid): 3" vs. "after kill(-pgid): 0" |
| **On macOS, `bash -c` is in the chain** | The srt wrapper produces `['/bin/bash', '-c', <string>]`. There is no command string **before** the sandbox, but one appears inside the wrapper | П1: `argv[0] = /bin/bash`, `argv.length = 3` |
| **`none` doesn't see a process that ignores proxy variables** | A raw socket, Go, or a JVM without an agent bypass the proxy entirely. In the baseline they simply go unobserved | consequence of mechanism D2 |
| **Raw TCP through SOCKS doesn't reach our callback** | A denial on it does make it into the violations stream (the proxy writes that), but an **allowed** connection produces no record at all: `filterRequest` is only called on the two HTTP paths, and the vendor only writes to the violations store on denials. So for raw TCP, the "how much went out" counter isn't just zero — there's no record. Such traffic is bounded only by the manifest's domain union | П9: the `nc` leg is uninformative, the SOCKS-path behavior is marked `ASSUMED` |
| **We terminate the child process's TLS** | `network.tlsTerminate` is enabled for S5's byte counts, so the daemon sees the child's **full URLs with query strings and HTTPS request bodies**. This doesn't leave the machine — the proxy is local — but the content is accessible inside the daemon | П10: `bodyBytes: 1234` for an HTTPS POST |
| **Loopback is closed and cannot be opened by address** | `127.0.0.1` and all RFC1918 ranges are hardcoded by the vendor into `NO_PROXY`, so `network.allow: ["127.0.0.1"]` accomplishes nothing: the client bypasses the proxy and seatbelt denies it. Tests and the attack corpus must connect by **hostname** | reading `sandbox-utils.js`: `NO_PROXY=localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` |
| **A blocked HTTP request doesn't fail the command** | The child process gets `exit=0` and a body of `Connection blocked by network allowlist`. This means the Utility under Attack metric must distinguish "the command ran" from "the command was cut off" using violations, not the exit code | П2: `exit=0`, body in stdout |
| **Network policy is applied one call at a time** | `updateConfig` swaps out the **global** config, so calls are serialized behind a semaphore with a cap of 1. The daemon cannot execute two recipes in parallel while a network restriction is in effect | П5: `customConfig.network` has no effect at all |
| **The effective write set is always wider than the manifest's** | On every wrap, srt adds in `getDefaultWritePaths()` — `/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug`, `/dev/*` — plus its own mandatory-deny entries and credential paths. The consent modal shows only the **manifest's** set | reading `sandbox-utils.js` |
| **The file-violation counter is a lower bound** | The kernel monitor emits at most one violation per `log stream` output chunk, so a burst of file denials gets coalesced by the vendor. Network denials are counted exactly: each one is a single record with no deduplication | reading `macos-sandbox-utils.js`; coalescence itself hasn't been measured |
| **Mandatory denies are anchored to the daemon's cwd** | `macGetMandatoryDenyPatterns` builds paths from the **daemon's** `process.cwd()`, and the `cwd` parameter of `wrapWithSandboxArgv` is not used on macOS. We build our own list and anchor it to every `write.allow` root; the vendor's list stays in effect on top of ours | П3 vs. П3b: the same write gives `exit=0` and `exit=1` with only the cwd differing |
| **A process that escapes to a new group via `setsid`** | Survives the group kill **and stays invisible to verification**: we check emptiness with `kill(-pid, 0)`, which knows nothing about a different group. So the call finishes quietly and green, with no trace. The loud-failure guarantee (R52) only covers a child that STAYS in the group | not covered by П4 |
| **We do not verify the socket peer's credentials** | Node 22 exposes peer credentials of a unix socket through nothing: `socket.address()` is empty, `remoteAddress` is undefined, and `_handle` carries no suitable property. `LOCAL_PEERCRED` is reachable only through a native module, which we do not pull in. The property a uid check would give — "only this user's processes can connect" — is held instead by the `0700` directory: a foreign uid fails even to resolve the path to the socket. The residual difference is small and named plainly: a uid check would not have stopped this user's **own** process either, and against root neither it nor the permissions help | П11: `свойств у сокета: 55, совпавших по peer\|cred\|uid\|gid\|pid: ["_getpeername"]` |
| **The handshake token protects no more than the file permissions** | The token lives in a `0600` file next to the socket, and any process of this user can read it — just as it can connect to the socket directly. It does not fence off foreign processes any better than the directory does; it serves a second purpose: without it anyone who reached the path would open a session silently. The real boundary for A5 is not the token but И5 — full control of the socket buys a call to an existing recipe with validated parameters, not arbitrary execution | e2e: a wrong token closes the connection with no reply |

## Framing for the Stage

> We do not solve prompt injection. We reduce the attack surface to zero where a shell used
> to be, and we make everything else visible.
>
> We do not make an attack impossible. We raise its cost and guarantee
> that it leaves a trace.

## What Honestly Counts as Failure

If the measurements end up showing that:

- the attack corpus gets through via arguments, paths, or output — the hypothesis is falsified;
- typical tasks require more than 5% exceptions — the hypothesis is falsified;
- false blocks exceed 5% — the hypothesis is falsified;
- the `sandbox: none` baseline shows an ASR close to that of seatbelt mode — meaning the
  sandbox provides no improvement, and the hypothesis is falsified.

These thresholds are fixed **before** the run. Adjusting them afterward means you're not
running an experiment.
