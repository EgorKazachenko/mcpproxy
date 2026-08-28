# ADR-0006 — Manifest lock file

**Status:** accepted · 2026-08-27 · upgraded to mandatory

## Context

`mcpproxy.yaml` lives in the project repository. It was originally considered trusted.

## Why that's wrong

The repository can be changed by a PR, a dependency, or **the model itself through another
tool**. Approve a recipe today — it does something else tomorrow.

This isn't hypothetical. Invariant Labs described a class of attack called the **rug pull**:
a server changes a tool's description after the user has approved it. According to published
reports, **CVE-2025-54136 (CVSS 8.8)** confirmed that approving a tool definition doesn't survive
a change on the server side. The general structural cause of this class is that clients inherit
trust in servers without continuous verification.

## Decision

`mcpproxy.lock` at the level of the **whole manifest**, not just individual recipes.

The normalized representation of a recipe holds two sides. `own` is the recipe's own block
(`exec`, `cwd`, parameter schemas **in declared order**, annotations, `description`, its own
`sandbox`/`timeout`/`env`/`output`); `recipeHash` is computed over this. `effective` is
`defaults` merged with the recipe's block; it's kept in the snapshot for diffing and is
**not hashed** — otherwise extending `defaults` would shift every recipe's hash at once.
Parameter order is part of the form because argv is built from it; recipe order is not,
since recipes are addressed by name.

Plus `manifestHash` and normalized `defaults` in the lock itself: editing `defaults.env.allow`
or emptying `defaults.sandbox.read.deny` changes no recipe object at all, every per-recipe hash
still matches, and without this the tampering would go through silently.

Plus a **snapshot** of the normalized recipe in every entry: SHA-256 is irreversible, and without
the snapshot there's nothing to build the "before" side of a diff from. The diff distinguishes an
added recipe, a removed one, a changed one, and a change to `defaults` — four separate slots, so
that a single `defaults` edit doesn't fan out across every recipe in the modal.

A mismatch → a **hard stop** at the `lock_check` stage (`verdict: denied`) plus a modal showing
the full **before/after diff**.

A mirror-image concern: we generate tool descriptions from the manifest ourselves, so we're
immune to poisoning from someone else's server — **but that makes the manifest itself an
injection channel into our own model**. Sanitizing `description` when generating `tools/list`
is mandatory.

## Consequences

- ✅ Closes a real attack class with a confirmed CVE
- ✅ A strong demo moment: edit the manifest live → the next call stops with a diff
- ⚠️ Protects against silent tampering, not against a careless "approve" click
- ⚠️ Requires discipline: a legitimate manifest change also requires approval
