# Research before planning — industry standards and runnable probes

Planning invents a mechanism. If that mechanism is wrong, `plan-review` finds out one round at a
time, and each round costs a full Opus pass plus a rewrite. Two cheap habits prevent most of it:
**look up how the problem is already solved**, and **measure the load-bearing assumption instead of
reasoning about it**.

Both belong to Phase 1 / Phase 2, before `plan.md` is written. Neither is a substitute for reading
our own code, which stays the source of truth about *this* app.

## When to research (any one is enough)

- The plan rests on a **library/protocol/runtime behaviour you have not personally verified** —
  "the MCP SDK re-emits that notification", "the transport preserves ordering", "an aborted
  request settles before the next one starts".
- You are about to **invent a mechanism** for a problem that sounds generic: session multiplexing,
  request cancellation, backpressure, retry and idempotency, sandboxing, capability negotiation.
- A **ticket or doc asserts an API** — check it exists before planning around it. Ticket prose drifts
  from code, and a plan built on a phantom export fails at implementation time.
- You are choosing between approaches and your reason is taste rather than evidence.
- The feature touches a **protocol or trust seam** (the MCP wire format, a transport, a
  sandbox boundary, an auth handshake) where the community has already hit the sharp edges.

Skip it when the answer is already in our code, or the change is mechanical.

## Evidence hierarchy — cite which tier you used

1. **Source code you actually read** (ours, a dependency's in `node_modules`, or a library's on
   GitHub). Strongest. Quote it with a path.
2. **A runnable probe you wrote and ran.** Equal to tier 1 for behaviour questions, and often the
   only way to settle them. See below.
3. **Official docs / a maintainer statement in an issue or PR.**
4. **A blog post or Stack Overflow answer.** Treat as a lead to verify, not a conclusion.
5. **A forum/Reddit thread.** Useful for "what bites people in practice" and for discovering the
   name of an approach. Never a load-bearing citation on its own.

Reddit and forums are worth reading — they surface failure modes docs omit — but promote anything
you take from them to tier 1 or 2 before the plan depends on it.

## Probe, don't reason

For any behavioural claim, write the smallest thing that answers it, run it, paste the numbers into
the plan, and delete the script. In this workspace that is usually a throwaway `.mjs` beside the
package, or a scratch test file under `packages/<pkg>/src/**/__tests__/` — build first so bare
`@mcpproxy/*` imports resolve against real `dist`, not a stale one.

```bash
cat > ./probe.scratch.mjs <<'EOF'
// import the REAL module under test, not a re-implementation of it
import { thing } from '@mcpproxy/core';
console.log(JSON.stringify(await thing(/* the exact shape the plan proposes */)));
EOF
node ./probe.scratch.mjs; rm -f ./probe.scratch.mjs
```

A probe that re-implements the behaviour instead of importing it proves nothing about the code
that will ship — it proves something about the probe.

Rules: probe the **exact** structure the plan proposes (a simplified one answers a different
question), record the raw output in the plan under a "Verified facts" heading, and say what the
probe **cannot** prove — a mocked transport can never settle a question about the real one.

## Parallel research agents

Read-only research may fork freely (the skill's agent whitelist allows it in any phase). Two agents
in one message, with different jobs, beat one generalist:

- **Agent A — industry survey.** WebSearch + WebFetch. "How is X solved in <ecosystem>? Enumerate
  mechanisms with URLs, separate official docs from blog claims, and say which fit our constraints."
- **Agent B — read the source.** Point it at a specific repo and demand quoted code with paths:
  "Read <library>'s implementation of X. What does it actually do on that path? What does it
  require of the caller? What are its stated limitations?"

Give both the workspace's real constraints (the packages involved, the protocol version, the
runtime and Node version, what may not change) so they can rule options in or out instead of
listing everything.

## Where findings go

- **`docs/vibe-coding/<feature>/transition-research.md`** (or `<topic>-research.md`) — the raw notes:
  what was tried, the numbers, the URLs, and the open items. It is what stops the next session
  rediscovering the same walls.
- **`plan.md` → "Verified facts this plan is built on"** — the short list the executor must not
  re-litigate, each with its evidence.
- **A correction, if research contradicts the spec.** A locked owner decision that research proves
  unsound goes **back to the owner** with the evidence — see the worked example below. Do not
  silently substitute a different mechanism.

## The four failure modes this reference exists to prevent

Each cost real rounds on real features. None of them look like mistakes while you are making them.

1. **Reasoning where a probe was needed.** Three designs were produced and reviewed for one
   behaviour, each failing on a property a five-minute probe would have settled up front. If a
   claim is measurable, measuring it is cheaper than one review round, let alone three.

2. **Not asking the industry.** A mechanism was invented for a problem the ecosystem had already
   solved and documented. The answer was one search away, and the invented version had to be
   thrown out. Before inventing, spend one agent on "how is this normally solved?".

3. **Research that changes the plan is the point.** A survey is not a formality that confirms what
   you already wrote. Two of the most valuable results on record were a library that **confirmed**
   an architecture with quoted source, and one that **refuted** a constraint the ticket asserted as
   fact — the second is what saved the feature. When research contradicts a locked owner decision,
   it goes **back to the owner** with the evidence; never silently substitute a mechanism.

4. **Trusting prose over code.** A ticket named two exports that did not exist, and the plan
   carried the phantom API into two tasks. Separately, a reviewer's premise was accepted and
   repeated for two rounds before a grep showed no call site matched it. Verify a premise before
   planning around it, **including** one a reviewer hands you — reviewers are wrong often enough
   that findings get rejected after checking the code, and right often enough that ignoring them
   ships bugs.
