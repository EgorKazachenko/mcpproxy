# ADR-0004 — Risk tiers on standard MCP tool annotations

**Status:** accepted · 2026-08-27 · **Blocks E0**

## Context

A risk classification is needed for the "auto / confirm" decision.
The original plan was our own `risk: low | medium | high` field.

## Decision

Don't invent one. Use the four standard annotations from the MCP spec:
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
The manifest declares them, `tools/list` emits them, and the tier is derived internally.

| Condition | Tier |
|---|---|
| `readOnlyHint: true` | low |
| not readOnly, not destructive, not openWorld | medium |
| `readOnlyHint: false` and (`destructiveHint: true` **or** `openWorldHint: true`) | high |
| **annotations not set** | **high** |

Spec caveat: `destructiveHint` and `idempotentHint` are meaningful **only** when
`readOnlyHint == false`. A recipe with `readOnlyHint: true` and `destructiveHint: true` is still low.

## Key detail

**The spec's defaults are pessimistic:** `destructiveHint` defaults to `true`,
`openWorldHint` defaults to `true`. A tool with no annotations is treated as destructive
and open to the outside world: forgetting to declare it gets you the maximum tier, not the minimum.

**But "fail-safe by construction" is the wrong phrasing, and it has been replaced.** The actual
guarantee is: manifest silence can only make a recipe **more** dangerous; an explicit
`readOnlyHint: true` **lowers** the tier, and the spec explicitly requires treating annotations as
untrusted. So the second line of defense is the sandbox and the lock, not tier inference.

## Consequences

- ✅ Compatible with any MCP client, not just Claude Code
- ✅ We don't invent our own risk vocabulary where the industry has already converged
- ✅ UI badges are readable by anyone who knows MCP
- ⚠️ Annotations are hints, not guarantees. We use them as **input** to the decision,
  but enforcement is done by the sandbox, not the annotation
