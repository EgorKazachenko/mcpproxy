# ADR-0005 — Dual-channel approvals

**Status:** accepted · 2026-08-27

## Context

The MCP 2025-06-18 spec has a built-in confirmation mechanism — **elicitation**:
the server sends `elicitation/create` with a schema, the client shows it to the user.
The temptation is to use only that and skip writing a modal in Electron.

## Problem

Elicitation goes **through the client and the model**. That means the confirmation lives in the
same channel that our threat model considers compromised. This is OWASP ASI09
(Human-Agent Trust Exploitation) in its pure form: an attacker who controls the context
can simulate or bypass the confirmation.

## Decision

Two channels, different roles:

| Channel | Tier | Role |
|---|---|---|
| `elicitation/create` | low, medium | Soft path, convenient, works in any client |
| Electron modal (separate process) | **high** | **The sole authoritative channel** |

On high risk, the proxy responds to any elicitation attempt with "this recipe requires
out-of-band confirmation" and raises the window.

The modal shows things **unabridged**: the exact argv, cwd, sandbox profile, domains.
The MCP spec requires showing the full command; truncation is treated as deception.

Decision options — `ApprovalScope` in the frozen contract: `once` (this call only),
`until` (until an **absolute** `expiresAt`), `recipe_and_args` (for this recipe with this
`argsHash`). Headless mode (CI, no UI) defaults to **deny**.

**Time is absolute, not a TTL.** The earlier phrasing "for 10 minutes" doesn't work for an
append-only record: it gets read months later, and by then a relative TTL means nothing.
`expiresAt` is an ISO timestamp; a separate `decidedAt` field isn't needed — the moment of
decision is the timestamp of the `approval` stage in the event.

**Scope is scoped to the session.** `ApprovalRequest` and `ApprovalVerdict` both carry an
opaque `requestId` and a `sessionId`. Without `requestId`, a message from the renderer could
approve the wrong pending call — not the one shown to the human. Without `sessionId`, a
confirmation scoped to `until` or `recipe_and_args` is keyed only on `(recipeName, argsHash,
expiresAt)` and ends up implicitly valid across every session — including one the human was
never shown. Keying is E5's job; E0 must make session attribution expressible, because the
field can't be added after the freeze.

The decision is `approved` or `denied`. There is no third member: expiry and cancellation are
expressed by the **absence** of a verdict, not by a value inside one.

## Consequences

- ✅ The confirmation can't be forged by content
- ✅ A clear demo moment: "the model said you agreed" vs. "you clicked the button"
- ⚠️ Doesn't protect against approval fatigue. Mitigation — high risk should be rare,
  since the tier is derived automatically
