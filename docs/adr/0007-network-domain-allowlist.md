# ADR-0007 — Network domain allowlist instead of a binary deny

**Status:** accepted · 2026-08-27

## Context

The original plan was `network: none` — a binary network ban for the child process.

## Problem

Half of legitimate tasks need network access: `npm ci` hits the registry, builds pull
dependencies. A hard deny generates a mountain of false blocks — and that's one of the metrics
we're judged on, and one of the falsification criteria's own points ("blocks safe actions too
aggressively").

## What the industry does

ToolHive wraps an MCP server with an egress proxy + container DNS + ingress proxy;
traffic is allowed only to hosts from the permission profile. `sandbox-runtime` does the same
proxy on the host: an HTTP proxy for HTTP/HTTPS, SOCKS5 for the rest of TCP, and a seatbelt
profile that allows connections only to the proxy's localhost ports. It's the same pattern.

## Decision

```yaml
sandbox:
  network:
    allow: ["registry.npmjs.org", "*.github.com"]   # a list of domains, not a bool
```

Deny-by-default is preserved: an empty `allow` means no network.

## Bonus for the UI

The proxy sees **every connection attempt, including blocked ones**.
In the timeline we don't show "network denied" — we show "process reached out to
`evil.io:443`, denied, 0 bytes" — with domain, timestamp, and volume.

## Consequences

- ✅ Sharply fewer false blocks on real tasks
- ✅ Far better visibility in the UI than a binary ban
- ⚠️ Filtering is by domain, not content: allow `github.com` and you can still push
  data to your own repo
- ⚠️ Domain fronting technically bypasses it
- ⚠️ A broad allowlist defeats the purpose. In the UI we flag recipes with overly broad
  rules (`*` in the domain) as weakened
