# 07 — Contracts (E0)

Everything in this document is **frozen** in `packages/contracts`. Seven epics depend on it.

**What "frozen" means.** The package's public surface — the `.d.ts` of all three entry
points plus the schema file — is captured as a snapshot in `packages/contracts/api-surface.snapshot.txt`,
and `api-surface.test.ts` turns red on any change. The snapshot is updated with the command
`node packages/contracts/scripts/update-api-surface.mjs`, and only together with an explicit
decision from the owner. The update lives in a separate script, and **not** in the test
itself: a gate that can rewrite its own reference via an environment variable is not a gate —
a variable set once in the shell or in a CI job would make it green forever.

`CONTRACTS_VERSION` moves **only** on an incompatible change to the public surface —
removal or narrowing of an export, a change to the shape of a frozen type, a change to any
of the **four** digest formulas. Adding an optional field does not move the version. A bump
always goes out in a single commit together with the snapshot and a review of dependent
branches.

Three entry points, each with its own dependency rights: `.` — types and pure functions with
no dependencies at all; `./validate` — `parseManifest` (`ajv`, `yaml`, `re2`); `./audit` —
hashes (`node:crypto`). The boundary is enforced by `deps.test.ts`, not by a promise in this
paragraph.

## Recipe Manifest — `mcpproxy.yaml`

Lives in the project repository. Treated as **untrusted** content (see the threat model).

```yaml
version: 1

defaults:
  timeout: 120s
  output:
    maxBytes: 65536
    redact: true
  env:
    allow: ["PATH", "HOME", "LANG", "CI"]     # everything else is stripped
  sandbox:
    read:  { deny: ["~/.ssh", "~/.aws", "~/.config/gh"], allow: ["."] }
    write: { allow: [] }
    network: { allow: [] }

tools:
  # A recipe can override any leaf of defaults: sandbox, timeout, env, output.
  # The merge rule is below, in the "Merging with defaults" section.
  run_tests:
    description: "Run the project's tests"
    exec: ["pnpm", "test"]         # exec[0] is resolved to an absolute path from the allowlist
    cwd: "."
    params:
      pattern:
        type: string
        required: false
        pattern: "^[\\w./-]{0,64}$"
        argv: ["--testPathPattern", "{}"]     # TWO separate argv elements
      update_snapshots:                       # name must match ^[a-z][a-z0-9_]{0,63}$
        type: boolean
        required: false
        argv: ["-u"]                          # boolean → flag present or absent
    annotations:
      readOnlyHint: false
      destructiveHint: false
      idempotentHint: true
      openWorldHint: false
    sandbox:
      write:   { allow: ["coverage", "node_modules/.cache", "/tmp"] }
      network: { allow: [] }
    timeout: 300s

  build_project:
    description: "Build the project"
    exec: ["pnpm", "build"]
    cwd: "."
    params:
      target:
        type: enum
        required: false
        values: ["debug", "release"]
        argv: ["--mode", "{}"]
    annotations:
      readOnlyHint: false
      destructiveHint: false
      idempotentHint: true
      openWorldHint: false
    sandbox:
      write: { allow: ["dist", "node_modules/.cache", "/tmp"] }
      network: { allow: [] }
    timeout: 600s

  analyze_logs:
    description: "Parse the application logs"
    exec: ["./scripts/analyze-logs.sh"]
    params:
      file:
        type: path                            # special type: realpath + confinement
        root: "./logs"                        # required for type: path
        required: true
        argv: ["{}"]
    annotations:
      readOnlyHint: true
    sandbox:
      read: { allow: ["./logs"] }

  publish_release:
    description: "Publish a release"
    exec: ["./scripts/publish.sh"]
    params:
      tag: { type: string, pattern: "^v\\d+\\.\\d+\\.\\d+$", required: true, argv: ["{}"] }
    annotations:
      readOnlyHint: false
      destructiveHint: true                   # → high risk → out-of-band approval
      idempotentHint: false
      openWorldHint: true
    sandbox:
      network: { allow: ["registry.npmjs.org", "api.github.com"] }
```

### Parameter Types

| `type` | Validation | Expansion in argv |
|---|---|---|
| `string` | `pattern` — **RE2 syntax**, required; `maxLength` | substituted into `{}` |
| `enum` | value from `values` | substituted into `{}` |
| `number` | `min`, `max`, integrality | substituted into `{}` |
| `boolean` | — | flag present or absent |
| `path` | realpath, then confinement under `root`; rejected if it escapes the boundary | absolute resolved path |

**Schema invariants** — expressed structurally and checked on load, not by a comment:

- `string` **must** have a `pattern`. A missing regex is a manifest load error, not a warning.
- `pattern` is compiled by the **RE2** engine: lookahead and backreferences are a load error.
  This is part of the contract (ADR: decision D3), not a defect. Limiting input length does
  not protect against catastrophic backtracking — measured in `10-honest-limitations.md`.
- `path` **must** have a `root`. `root: "/"` and a relative `root` that escapes the manifest's
  directory are both load errors.
- `exec[0]` is an absolute path, a bare name, or a path descending from the manifest
  (`./scripts/x.sh`), with no shell metacharacters. Resolving it to an absolute path and
  checking it against the binary allowlist is the daemon's job.
- No parameter can affect `exec`, `cwd`, or the sandbox profile: a `{}` slot in any of them
  is a load error.
- Each parameter's `argv` is an array of literals; `{}` may appear at most once per element.
- `number` bounds must be **satisfiable**: `min > max` is a load error, and so is `integer: true`
  with no integers in the range (`min: 1.2, max: 1.8`). A recipe whose bounds admit no value
  used to reject 100% of calls anyway — but silently, on every value and with no diagnostic;
  now it fails to load.

  **This tightening applies to a file an installation already has**, and a `parseManifest`
  rejection is whole-manifest: an installation with one such recipe loses **all** of its
  tools, not just one. There is no "warning" tier at load time, and none can be added —
  `Diagnostic` has no `severity` field, and the surface is frozen. An update must carry this
  in the release notes as a breaking change.
- Recipe and parameter names are constrained to `^[a-z][a-z0-9_]{0,63}$` **and** an explicit
  ban on `constructor`, `prototype`, `__proto__`. The pattern alone is not enough: `constructor`
  matches it.
- `enum` values cannot contain control or format characters (`\p{Cc}`, `\p{Cf}`) — a poisoned
  value becomes a load error rather than being silently rewritten by a sanitizer. Only the
  free-text descriptions are subject to sanitization.
- A recipe's `deny`, if the key is present, must be **non-empty**: an empty array is the only
  syntactic form for "lift a defaults-level deny", and that form is forbidden.
- A document with a `%YAML` directive is rejected outright, and so are unknown tags and
  duplicate keys. File size is bounded before parsing.

### Merging with defaults

| Node | Operation | Why |
|---|---|---|
| `sandbox.*.allow` | replaced leaf-wise | the recipe deliberately narrows or widens its own blast radius |
| `sandbox.*.deny` | **union**; a recipe cannot shrink it | a deny from `defaults` cannot be lifted |
| `env.allow` | replaced leaf-wise, **but only as a subset of** `defaults.env.allow` | the recipe sets the list in full, but `defaults` is a ceiling, not a default value: otherwise a recipe could grant itself a variable that isn't in `defaults`, even though `sandbox.*.deny` cannot be lifted. A superset is a load error |
| `output.*`, `timeout` | replaced | scalars |
| silence in `defaults.output` | `redact: true`, `maxBytes: 65536` | manifest silence must make a call **more dangerous** to attempt, not safer — the same principle as with annotations, where absence yields `high` |
| a recipe's `output` | scalars replaced, **but only in the direction of tightening** | `defaults.output` is a floor: a recipe cannot lift redaction enabled in `defaults` or raise the byte ceiling. Otherwise the principle in the row above would hold for silence and not for explicit relaxation, and `redact: false` would carry a secret through to the model. Turning redaction on and lowering the ceiling is legal |

The floor and ceiling are held **in two places**: the load rules in `./validate`, and the
merge itself in `normalizeRecipe`. The second is not duplication: the rules live in the
validator, while the merge lives in the root entry point, and a consumer that assembles a
`Recipe` programmatically bypasses the loader along with all of its diagnostics. `effective`
is clamped in that path, while `own` holds what was declared — the hash is computed over
`own`, otherwise a lock diff would show something other than what's in the manifest.
| key absent | inherited from `defaults` | |
| empty array in `allow` | "zero out", not "inherit" | `network: {allow: []}` — network is closed |
| empty array in `deny` | **load error** | see invariants above |

### Risk Tiers

Derived from annotations, not set directly. Defaults are pessimistic (as in the MCP spec).

| Condition | Tier | Behavior |
|---|---|---|
| `readOnlyHint: true` | low | automatic |
| `readOnlyHint: true` **and** `destructiveHint: true` | low | `destructiveHint` is ignored — see below |
| `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false` | medium | automatic, loud log entry |
| `readOnlyHint: false` and (`destructiveHint: true` **or** `openWorldHint: true`) | **high** | **out-of-band approval in Electron** |
| annotations not set | **high** | pessimistic spec defaults |

The second row is an MCP spec caveat: `destructiveHint` and `idempotentHint` are meaningful
**only** when `readOnlyHint == false`. It's easy to implement incorrectly, so it's checked by
a test.

**Boundary of the guarantee.** The phrase "fail-safe by construction" is inaccurate and has
been replaced with a narrower one: manifest silence can only make a recipe **more dangerous**
— unset fields take pessimistic defaults. But an explicit `readOnlyHint: true` **lowers** the
tier, and the spec requires treating annotations as untrusted. So the second line of defense
is the sandbox and the lock, not the tier derivation. A lock mismatch does **not** show up in
the tier: it's a separate `LockStatus` state that forces a hard stop at the `lock_check`
stage, not an ordinary high-risk approval.

## Lock File — `mcpproxy.lock`

```json
{
  "version": 2,
  "manifestHash": "e3c9b249…",
  "defaults": { "timeoutMs": 120000, "output": {…}, "env": {…}, "sandbox": {…} },
  "tools": {
    "run_tests":      { "recipeHash": "a1b2…", "approvedAt": "2026-08-27T10:00:00Z", "snapshot": {…} },
    "publish_release":{ "recipeHash": "c3d4…", "approvedAt": "2026-08-27T10:00:00Z", "snapshot": {…} }
  }
}
```

The digest is 64 lowercase hex characters **with no `sha256:` prefix**. Four frozen formulas:

```
recipeHash   = sha256(utf8(canonicalizeJcs(normalized.own)))
manifestHash = sha256(utf8(canonicalizeJcs(normalizeManifest(manifest))))
argsHash     = sha256(utf8(canonicalizeJcs({ recipeName, params })))
chain.self   = sha256(utf8(canonicalizeJcs({ prev, event })))     // event — without the chain field
```

`chain.self` is the fourth and most expensive: it's on the list precisely because the bump
rule above refers to this block, and the audit log is append-only and cannot be regenerated.

Canonicalization is bounded to a depth of `JCS_MAX_DEPTH` (128). This isn't a matter of taste:
without a ceiling, recursion produced an engine-level `RangeError` instead of a module-level
rejection, and 3,930 bytes of arbitrary JSON in `IpcRequest.params` would crash `argsHash` —
that is, the approval path.

The normalized recipe representation holds **two sides**. `own` is the recipe's own block
(`exec`, `cwd`, parameter schemas **in declared order**, annotations with defaults applied,
`description`, its own `sandbox`/`timeout`/`env`/`output`); this is exactly what gets hashed.
`effective` is `defaults` merged with the recipe's block; it lives in the snapshot **for the
diff, and is not hashed**. Otherwise widening `defaults.env.allow` would shift `recipeHash`
for every recipe at once and mark all of them `drifted`.

**Version `2`, not `1`.** The shape changed incompatibly relative to what was documented
before: the `hash` field became `recipeHash`, and the mandatory `snapshot` and `defaults` slot
appeared. Keeping the number at `1` would mean a file of the old shape honestly declares
itself current — and the discriminator exists precisely so that doesn't happen.

The lock is read via `parseLockFile(text)` from `./validate`, not via `JSON.parse(...) as
LockFile`. The difference isn't stylistic: `diffLock` dereferences `entry.snapshot` and
`lock.defaults` without checking, so a file of the old shape produced not a diagnostic but an
unhandled exception — **at the `lock_check` stage, i.e. on the decision path itself**. If the
lock fails to parse, there is no approval, so the recipe goes back for re-approval:
fail-closed. Cross-checking the two copies of an approved recipe within the file
(`recipeHash` against `snapshot`) is done by `verifyLockEntries` from `./audit` — without it,
a lock with a swapped-out snapshot would produce a clean diff across all four slots.

Parameter **order** is part of the shape — argv is assembled from it. Recipe **order** is not:
recipes are addressed by name everywhere, and freezing their order would have given us a hard
stop on reordering two `tools:` keys, with an empty diff in the modal.

`manifestHash` is needed because `defaults.env.allow: [..., "AWS_SECRET_ACCESS_KEY"]` or an
emptied-out `defaults.sandbox.read.deny` change none of the recipe objects: all per-recipe
hashes match, `lock_check` stays green, and the substitution goes through silently.

`snapshot` is mandatory: SHA-256 is irreversible, and without it there's nothing to build the
"before" side of the diff from. The diff (`diffLock`) returns four slots — `defaults`,
`added`, `removed`, `changed` — and a change to `defaults` lands in its own slot rather than
being duplicated across every recipe.

A mismatch → hard stop at the `lock_check` stage (`verdict: denied`) + a modal with a
"before / after" diff. Without this, a recipe's approval would not survive a change to the
file (CVE-2025-54136).

## Audit Event Schema

**The source of truth is the `AuditEvent` type in `packages/contracts/src/event.ts`.** This
section describes what it is and why; the fields are enumerated there, and duplicating them
as a list here would create a second copy that drifts from the first.

The shape is **nested**, times are ISO-8601, enums are strings. This is our internal format,
not native OTel: the status of all of `gen_ai.*` is Development, MCP conventions have already
migrated between repositories, and a frozen contract cannot be pinned to a drifting schema.
A pure function, `toOtlp`, maps the event to OTLP.

```jsonc
{
  "operation": "execute_tool",
  "toolName": "run_tests",
  "sessionId": "…", "traceId": "…", "spanId": "…", "parentSpanId": null,
  "startTime": "2026-08-27T10:00:00.000000Z",
  "endTime":   "2026-08-27T10:00:12.412500Z",
  "durationUs": 9120,                   // monotonic duration of the STAGE
  "stage": "spawn",                     // see the stage table below
  "verdict": "allowed",                 // allowed | denied | pending_approval | error
  "recipe": { "name": "run_tests", "hash": "a1b2…" },
  "argv": ["/opt/homebrew/bin/pnpm", "test", "--testPathPattern", "auth"],
  "cwd": "/Users/…/proj",
  "env": { "allowed": ["PATH", "HOME"] },
  "sandbox": { "mode": "seatbelt", "profile": {…}, "violations": [{…}] },
  "risk": { "tier": "low", "annotations": {…} },
  "approval": { "channel": "electron", "decision": "approved", "scope": "until",
                "expiresAt": "2026-08-27T10:10:00.000Z", "argsHash": "…", "sessionId": "…" },
  "exit": { "code": 0, "signal": null },
  "output": { "bytes": 4211, "truncated": false },
  "redactions": [{ "rule": "aws-access-key-id", "count": 1, "stream": "stdout" }],
  "duration": { "overheadMs": 14 }      // only on complete
}
```

**Mandatory core** — what exists at every stage, including `received`: `operation`,
`toolName`, `sessionId`, `traceId`, `spanId`, `parentSpanId`, `startTime`, `endTime`,
`durationUs`, `stage`, `verdict`, `recipe.name`. `sessionId` being in the core is not
incidental: without it, the append-only log of a multi-session daemon cannot say which IPC
session made the call — and that is the only forensic artifact available when a token is
stolen.

**Everything else is optional and appears at its own stage.** An optional field is
**absent as a key**, not present with a `null` value. `null` means exactly "known and empty"
(`exit.signal`, `denyReason` when `verdict: allowed`). The distinction is not stylistic: JCS
distinguishes an absent key from `null` byte-for-byte, and both variants flow into the chain
hash. A call stopped at `lock_check` must be able to **have no `argv` at all** — otherwise it
would carry a fabricated `argv: []`, and the UI would render it as a genuine empty command.

`durationUs` is the stage's monotonic duration from `process.hrtime.bigint()`, as an integer.
It sits alongside the ISO timestamp, not in place of it: timestamps quantized to the
millisecond carry an error on the order of the measurement itself, and wall clocks also jump
around under NTP. Proxy overhead is computed over a **disjoint** set of stages:

```
overheadMs = round(Σ durationUs over stages ∉ {spawn, violation, approval, complete} / 1000)
```

`spawn` is child-process time; `violation` occurs within the `spawn` window and would double
count something already counted; `approval` is a human looking at the modal; `complete` is
the event on which the value itself is computed, so its own `durationUs` is not yet known.

### OTLP Export

`toOtlp(event)` produces a valid OTLP/JSON span. Field names are **lowerCamelCase**, and this
is an OTLP spec requirement, not a style choice: a receiver is required to **silently ignore**
fields with unrecognized names, so `trace_id` doesn't error — it's simply dropped. Hence the
test that forbids any underscored key in the output.

Attributes are limited to names that actually exist in the conventions registry:

| Attribute | Value |
|---|---|
| `gen_ai.operation.name` | the event's `operation` |
| `gen_ai.tool.name` | recipe name |
| `network.transport` | constant `"pipe"` |
| `mcp.session.id` | `sessionId` |
| `mcp.method.name` | constant `"tools/call"` |
| `mcp.protocol.version` | the event's `protocolVersion` — the revision **negotiated in the session**, not a build-time constant |

`mcp.tool.name`, `mcp.request.id`, and `mcp.transport` **do not exist** — they aren't there
and won't be. `jsonrpc.request.id` is deliberately not emitted: the id lives between the
client and the shim and does not travel through `IpcRequest`; correlation goes through
`traceId`. `mcp.resource.uri` is not emitted — we have no resources. Our own fields go into
the `mcpproxy.*` namespace.

### Call Stages

Each is a separate event. It's exactly this step-by-step structure that makes the timeline
legible: you can see at which step a call stopped.

| `mcpproxy.stage` | What happens |
|---|---|
| `received` | A call arrived from the client |
| `lock_check` | The recipe is checked against the lock file |
| `validate` | Parameters are validated against the schema |
| `resolve_paths` | realpath + confinement |
| `build_argv` | argv is assembled from the slots |
| `classify_risk` | The tier is determined from annotations |
| `approval` | Waiting for, and the result of, approval |
| `build_env` | The environment is assembled from the allowlist |
| `build_profile` | The sandbox profile is generated |
| `spawn` | The process is launched |
| `violation` | A sandbox violation (there can be several) |
| `redact` | Output redaction |
| `complete` | Completion, chain entry written |

**Rule:** an event is written at every stage, including a denial. A denial with no audit
entry is a bug, not an optimization.

**Boundary of the rule.** It applies to **call** stages — the thirteen in the table above. A
manifest-load failure does not fit this shape and shouldn't be made to: `operation` is
single-valued, there's no `manifest_load` stage, and `sessionId`/`traceId`/`recipe` don't
exist yet at load time — the manifest is read at daemon startup or on file change, outside any
session. Load diagnostics are written by the daemon's structured log (E1), with the
diagnostic's `pointer` as the lookup key; they don't enter the audit chain. Extending `Stage`
and `operation` to accommodate them would cost more than stating this boundary: consumers
build exhaustive `Record<Union, …>` over both unions.

**What the record itself carries.** `schema: "mcpproxy.audit/1"` is the shape version, and it
is mandatory: `chain.self` hashes the event as a whole, so adding a discriminator later would
mean a new digest for every subsequent record. The reader must be tolerant: an unrecognized
value is a readable record flagged "shape newer than me," not an exception. A single record
from the future has no right to make the entire log before it unreadable.

### Record Shape Evolution Rules

The log is append-only: it cannot be regenerated, so the rules below are not a matter of
style but a condition for what's already recorded to remain verifiable. Each has been checked
against a measurement on the E6 implementation.

1. **Only optional fields are added to `AuditEvent`.** Old records don't have them, their
   digests don't change, and the file remains verifiable in full. Measured: a file where a
   record without field `X` precedes a record with field `X` passes `verifyChain` — old and
   new records within one chain **mix freely**. The phrasing "old and new records don't mix,"
   which stood here before, was misleading in the pessimistic direction: taken literally, the
   next epic would have paid for it with file rotation, which breaks the chain across files.
2. **A record already on disk is never rewritten or re-serialized.** Export copies bytes
   (`copyFileSync`) rather than piping parsed records back through `JSON.stringify`: key order
   could shift, and with it the digests that the recipient computes independently.
3. **Canonicalization and the digest formula don't change without a shape-version bump.** Such
   a change would invalidate all historical logs at once, not just new records. The formula is
   guarded by a golden vector in `packages/contracts/src/audit/chain.test.ts` — that's exactly
   what it guards.

Removing a core field or changing its type is an incompatible change: it breaks the reader on
records already on disk, and can only be remedied by a new shape version.

**The OTLP export is a summary, not the full record.** The span carries lengths
(`mcpproxy.redactions.count`, `mcpproxy.sandbox.violations.count`), not the arrays themselves,
and carries no `sandbox.profile`, `risk.annotations`, or `chain` at all. The full record lives
in the JSONL file. Span status is set only for `verdict: "error"`: a policy denial is a
normal decision outcome, and flagging it as an error would paint a working policy as a failed
service.

### Load Diagnostics

`parseManifest` returns a tagged result rather than throwing. A diagnostic carries `pointer`
(a dotted path into the document), `line`, `column`, `message` — and `code`, which is what
the consumer is required to branch on. The `message` text is for humans and **is not frozen**;
branching on it breaks silently on the first wording change.

| `code` | What it means |
|---|---|
| `size-limit` | File exceeds the ceiling, rejected before parsing |
| `yaml` | Syntax, unknown tag, duplicate key, alias bomb, directive, second document |
| `schema` | Document parsed, but doesn't match the schema |
| `invariant` | A check the schema itself can't express: confinement, slots, the shape of `exec[0]`, the `env` ceiling, the `output` floor, satisfiability of bounds, manifest hashability |
| `pattern` | `pattern` was rejected by the RE2 engine |
| `lock` | Parsing `mcpproxy.lock`, not the manifest. A separate member because the response differs: a broken or stale lock leads to re-approval, a broken manifest leads to startup failure |

`pointer` alone isn't enough here: "RE2 rejected the pattern" and "`pattern` failed the
schema's `SafeText`" share the same one — `tools.X.params.Y.pattern` — yet the consequences
differ.

**A manifest that passes loading must be hashable.** This is symmetric with `parseLockFile`,
and for the same reason: `diffLock(lock, manifest)` takes two arguments, and both need
safeguarding. A single lone surrogate in any string crashes canonicalization — that is,
`manifestHash` and `diffLock` — as an exception at the `lock_check` stage, before the stage
event is written. The rule above calls a denial with no audit trace a bug, so such a manifest
doesn't load at all.

**Duration is bounded by value; the shape check is only sanitary.** Above the platform timer
maximum (`2^31 − 1` ms), Node silently clamps the timeout to 1 ms: a manifest asking to
"almost never time out" would get interrupted immediately. There is a single arbiter here —
the value; the digit limit in the schema only cuts off absurdly long strings and matches the
limit in the parser, otherwise the "link" between them would exist only in words. While the
limit stood at nine digits, a 1.1-billion-ms gap separated it from the constant:
`2147483647ms` — that exact constant — was rejected as "ten digits," and a human got a
pattern diagnostic instead of an explanation about the timer.

`message` and `pointer` are safe to render, and sanitization sits **in the diagnostic
constructors**, not with the message producers: there are five of those — ajv, `yaml`,
`refine`, the pattern compiler, and the lock parser — and a guarantee placed on one of them
would simply go unnoticed by the next. Measured: at least three of them splice in a verbatim
fragment of the untrusted file: RE2's message echoes the pattern, `yaml@2.9.0` splices in the
source line along with a caret, and V8's `JSON.parse` splices in a fragment of the lock file.

`pointer` is sanitized on equal footing with `message`, and the argument "the schema
constrains names via `propertyNames`, so the pointer is clean" doesn't hold: with
`allErrors: true`, ajv keeps validating the value **under the rejected key**, so the key
rides along to the pointer together with its own diagnostic about itself. And `pointer` is
the key used to search the log.

A useful side effect of sanitization: the message becomes single-line.

**The pointer is lossy and therefore not unique.** Sanitization strips invisible characters,
so `tools.a<U+200B>b` and the legitimate `tools.ab` produce the same `pointer`, with
`<U+200B>` collapsing to an empty string — indistinguishable from the sentinel "no pointer
into the document." Hence two rules for the consumer: `pointer` must not be fed back into
document navigation, and record identity should be taken as `pointer` **together with**
`line` and `column` — those remain exact. An empty `pointer` with `line: 1, column: 1` means
a document-level failure: size, syntax, unhashability.

## Approval Contract

The shapes are declared in E0 in full, because a field can't be added here after the freeze,
and without them neither scenario S8, nor attack A14, nor ASI09 is implementable.

| Type | Values / fields |
|---|---|
| `ApprovalChannel` | `electron` \| `elicitation` |
| `ApprovalDecision` | `approved` \| `denied` — there is no third member: expiry and cancellation are the **absence** of a verdict |
| `ApprovalScope` | `once` \| `until` \| `recipe_and_args` |
| `ApprovalRequest` | `requestId`, `sessionId`, `recipeName`, `argsHash`, `tier`, `argv`, `cwd`, `profile` |
| `ApprovalVerdict` | `requestId`, `sessionId`, `channel`, `decision`, `scope`, `expiresAt` |
| `ApprovalRecord` (in the event) | `channel`, `decision`, `scope`, `expiresAt`, `argsHash`, `sessionId` |

`expiresAt` is an **absolute** ISO timestamp, not a relative TTL: an append-only record gets
read months later, and "10 minutes" in it would no longer mean anything by then. `requestId`
is opaque and branded — without it, a verdict from the renderer could get attributed to a
different pending call. `sessionId` is present in the request, the verdict, and the event
record: otherwise an approval with `until` scope would end up implicitly valid across every
session.

## IPC Contract

The single request shape from the shim to the daemon:

```jsonc
{ "recipeName": "run_tests", "params": { "pattern": "auth" }, "sessionId": "…" }
```

Both identifiers are branded in the contract (`RecipeName`, `SessionId`), so swapping
arguments at this boundary is a compile error, not an accepted request from someone else's
session. An extra field in this shape also fails to compile: `argv` cannot be tacked on here.

**Never** argv, a path to a binary, cwd, or sandbox settings. This is structural protection
against the "stdio Transport Security in Proxy Scenarios" attack from the MCP spec: even full
control over the socket doesn't grant arbitrary execution.

Transport: unix domain socket, `0600` permissions, peer credential (uid) verification on
connect, a per-session token.
