# Round 5 — verification against the vendor source

I re-derived every round-4 claim from `node_modules/@anthropic-ai/sandbox-runtime/dist/`, not from the plan's prose.

## B1 — conformance table: correct

`sandbox/domain-pattern.js:85` is `matchesDomainPattern(hostname, pattern)`. Walking the four pinned rows through the real body:

- `('github.com', '*.github.com')` → `'github.com'.endsWith('.github.com')` = **false** ✓
- `('api.github.com', '*.github.com')` → **true** ✓, and this is the row that actually catches a swap: reversed, `pattern='api.github.com'` misses the `*.` branch, falls to exact compare, returns false → red. The order canary is real.
- `matchesDomainPatternWithPort('api.github.com', 443, 'api.github.com:8443')` → `splitDomainPatternPort` (`domain-pattern.js:29-60`) yields port 8443 ≠ 443 → **false** ✓. Note this row is *order-insensitive* (swapped it also returns false) — it pins port semantics, not argument order. That's fine, row 2 carries the order.

**The deny-first row (plan.md:458, spec.md:143) is the one that points at nothing.** Deny-before-allow lives in `sandbox-manager.js:216-232`, inside `filterNetworkRequest` — a module-private function. `index.d.ts` exports no policy evaluator, and `domain-pattern.d.ts` exports only the four matchers. So the sentence at spec.md:135 — "каждая строка вызывает настоящую вендорскую функцию" — is false for that row. Written as stated it becomes an assertion over our own helper, which is not on the enforcement path (netpolicy is a validator by design). It is a documentation row wearing a conformance row's clothes.

## B2 — attribution: correct, and the rationale is verifiable line by line

- `proxyUsernameFor` (`sandbox-utils.js:710-715`) drops to bare `srt` past 255 bytes.
- `generateProxyEnvVars` (`sandbox-utils.js:410-420`) bakes the username into the child's own env → child-controlled.
- `encodedCommandFromProxyUser` (`sandbox-utils.js:723`) — vendor's own comment concedes "a forged suffix can only misattribute a denial in the violation report".
- Kernel side, `macos-sandbox-utils.js:909-911`: `lines.find(line => line.includes('Sandbox:'))` and `lines.find(line => line.startsWith('CMD64_'))` — **per chunk**. This confirms two separate plan claims at once: the key is lost across chunk boundaries, and the monitor emits **at most one violation per chunk** — which is exactly why S4's "250" fixture had to move to proxy denials. `addViolation` (`sandbox-violation-store.js:12-27`) is one call per proxy denial with synchronous `notifyListeners`, so 250 is deterministic and the cursor accumulates it despite `maxSize = 100`. Good.

Corroborating checks that also held: `updateConfig` (`sandbox-manager.js:1509-1523`) is `structuredClone` with no merge → R56 correct; `filterRequest` is read once at `sandbox-manager.js:372` when the proxy is built → "register only in `initialize`" correct, while `filter:` closes over live `config` → enforcement via `updateConfig` correct; `encodeSandboxedCommand` (`sandbox-utils.js:691`) truncates at 100 chars → R48/R30 correct; store `maxSize=100`, `clear()` does not reset `totalCount` → R44 correct.

## B3 — fixture shape: correct and non-vacuous

plan.md:521 pairs glob `/tmp/x/**/.git/hooks` against target `/private/tmp/x/sub/.git/hooks/pre-commit`. A `mandatoryPaths.includes(target)` implementation is red; a naive `minimatch(target, pattern)` is also red (the target is a file *inside* the denied subtree). Assertion three (throwing `resolvePath`, non-empty `mandatoryPaths`) can't distinguish "caught the throw" from "never called the resolver" on its own, but assertion six is only satisfiable by actually calling the resolver, so the pair holds.

## Fresh vacuity introduced by the repairs

None that survives. The two repairs most at risk were S7 (`isWeakened` on bare `*`) and S4 (the 250 fixture); both tightened rather than loosened. Task 6's fifth assertion is now equality with `holdBackBytes > 0` pinned in the fixture — it can fail.

## Requirement-diff spot check (sampled 22 of 56)

Task 3, 4, 6, 7, 9 numbering all reconcile against the assertion prose (Task 7 has exactly ten, matching rows R10/R12/R37/R44/R45/R48/R32/R29/R55). **Task 5 does not.** Its Falsification block ends at "Четвёртое" (plan.md:573, the no-mutation assertion), but:

- plan.md:953 (R23) cites "второе, третье и **пятое**" — there is no fifth.
- plan.md:954 (R24) cites "Task 5, четвёртое" and quotes `expect(buildEnv([], {}, {HTTP_PROXY: 'http://x'}).HTTP_PROXY).toBe('http://x')` — that text appears **nowhere in Task 5**. R24's assertion exists only inside the diff row.

---

None of what's left ships a hole in the boundary, none produces a green test whose claimed reason is impossible, and none sends the implementer down a path that has to be undone. The architecture has been stable for two rounds: enforcement via `updateConfig` under semaphore-1, attribution by window, mandatory-deny owned by us with two executable tests (composition + vendor-drift), cursor by `getTotalCount`, hold-back before redact, `PATH` constant always winning. Another cycle would buy assertion-level edits the implementation phase can make while writing them.

## Watch list for the implementer

1. **`network.deny` → `deniedDomains` has zero executable coverage** (plan.md:696, row plan.md:983). The deny-first conformance row cannot call a vendor function — drop it from `netpolicy.test.ts` and instead add a third leg to Task 7's sequential test: allow `*.<host>` + deny one concrete subdomain, assert the denied host is unreachable while the sibling is reachable. That is the only thing that proves an author's explicit deny is not silently dropped.
2. **spec R14's second half is missing from the plan.** spec.md:151-153 and spec.md:144 require `isWeakened` to also flag what the vendor schema calls too broad (`*.com`); plan.md:460 pins only bare `*`. The vendor rule is `sandbox-config.js:28-39` (a `*.X` needs ≥2 labels after the wildcard) and it is reachable via the exported `NetworkConfigSchema` — assert against the schema rather than reimplementing the predicate.
3. **Task 5 needs one more assertion, not a renumber.** Write R24's injected-passthrough case (`buildEnv([], {}, {HTTP_PROXY}) → HTTP_PROXY survives the allowlist filter`) as the actual fifth. Right now the only thing standing behind R24 is Task 8's integration leg.
4. **R13's revalidation in `run()` must accept bare `*` in `allow`.** `isValidDomainPattern` (`sandbox-config.js:41-43`) rejects it, and `allowedDomains` uses that predicate; `deniedDomains` does not. If you mirror the vendor predicate wholesale, every weakened recipe and `none` mode itself fail closed at the wrong place. R54's startup canary is what catches this — run it before the first recipe, not lazily.
5. **`realpathSync.native` on a glob throws ENOENT.** Task 4's stub is a pure string mapper and cannot expose this; resolve the static prefix only. If you get it wrong, assertion three's try/catch swallows it and every `mandatory-deny` silently degrades to `file-write` in production — the S6 badge dies green. Consider one integration assertion in Task 7 that checks `violation.type === 'mandatory-deny'` under real seatbelt with real `realpath`, not just `writeFails === true`.
6. **R52 is only tested on the timeout path.** Task 6's first assertion kills after a timeout; "group killed on *every* exit path" (plan.md:688) needs the same survivor count after a normal exit, otherwise a background child outlives the call and lands under the next recipe's policy.
7. **R50 has no assertion at all** (plan.md:721, row plan.md:980). One line: `await sandbox.dispose(); await expect(sandbox.run(...)).rejects.toThrow()`. Without it, a post-`reset()` run gets `getProxyPort() === undefined` and the network goes quietly open in `none`.
8. **spec R30's wording is now stale** — "Корреляция violation с вызовом — по `commandId`" (spec.md:268) reads as contradicting R45. Read it as "the corroboration key is the commandId, never the command text"; fix the sentence when you touch the spec.
9. Cosmetic while you're in there: plan.md Task 6 prints "Седьмое" before "Шестое", and plan.md carries a doubled colon in the `redact` rationale.

PLAN: 41c42537e38341082a5c2a502537a688d5332a45
VERDICT: APPROVED
