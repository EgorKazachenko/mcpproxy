#!/usr/bin/env bash
# Deliberately trivial. This file is registered in .claude/settings.json, so every session and
# every parallel agent working in this repository runs it on every tool call. A syntax error here
# once locked the author out of Bash and Edit in ALL sessions at once.
#
# Therefore: no logic lives here, and every failure path exits 0 (allow). A broken harness must
# never halt unrelated work — availability wins at THIS layer. Enforcement is recovered by the
# canary: `gate-run init` runs the same probe and refuses to START a run while the guard is dead,
# so a silently open guard cannot survive into a real gated run. `ship-lint --self-test` probes it
# too, on demand and in CI, but nothing calls it automatically — which is why init does.

input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || exit 0
logic="$here/vibe-guard.mjs"
[ -f "$logic" ] || exit 0

errlog="$HOME/.claude/harness-logs/guard-errors.log"
mkdir -p "$(dirname "$errlog")" 2>/dev/null

printf '%s' "$input" | node "$logic" 2>>"$errlog" || exit 0
exit 0
