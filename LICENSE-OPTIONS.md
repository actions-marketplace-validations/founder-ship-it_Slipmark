# Licensing options for DriftGuard

A reference so you can make an informed, unhurried decision. **Current license:
Apache-2.0** (switched from MIT for v0.1.0, for the explicit patent grant). Changing it later is a one-line swap (plus this doc). Nothing here is legal
advice — for a venture-scale raise, confirm the final choice with a lawyer.

## The core trade-off

```
more adoption  ←─────────────────────────────────────────→  more protection
   MIT  ·  Apache-2.0          AGPL-3.0          BSL / Fair Source        Proprietary
 (permissive, OSI)         (copyleft, OSI)      (source-available)       (closed)
```

The more permissive the license, the easier developers adopt it (good for the
OSS flywheel) but the easier a competitor can take it closed. The protection that
actually matters for an open-core business is **not** the license — it's the
closed cloud you don't open-source, the trademarked name, and your velocity. The
license mainly decides whether a competitor can legally build a **closed rival
SaaS** directly from your code.

---

## Option A — MIT (previous)

- **What it allows:** use, modify, sell, embed in closed products. Only
  requirement: keep the copyright notice. No warranty.
- **OSI open source:** yes.
- **Pros:** maximum adoption and trust; zero friction; the most familiar license
  to developers; what Promptfoo and Langfuse's core use.
- **Cons:** least protective — a competitor can fork it, rebrand (subject to
  trademark), and launch a closed competing service.
- **Best if:** adoption is everything and your moat is the cloud + brand.

## Option B — Apache-2.0  *(current)*

- **What it allows:** same permissive rights as MIT, **plus an explicit patent
  grant** and a patent-retaliation clause.
- **OSI open source:** yes.
- **Pros:** everything MIT gives, but the patent grant makes **enterprises and
  their lawyers more comfortable** adopting it; still maximal adoption.
- **Cons:** slightly longer license text; a NOTICE file convention to maintain.
- **Best if:** you want max adoption *and* enterprise-friendliness. For a
  venture-scale dev tool this is usually the sweet spot.

## Option C — AGPL-3.0

- **What it allows:** use/modify/distribute, **but** anyone who runs a modified
  version *as a network service* must release their modified source under AGPL too
  ("copyleft over the network").
- **OSI open source:** yes (strong copyleft).
- **Pros:** specifically deters a competitor from taking your code and launching
  a **closed** rival SaaS — they'd have to open their changes. Still free/OSS, so
  community adoption is real.
- **Cons:** many enterprises **ban AGPL** in internal policy, so some adoption
  friction; can scare risk-averse buyers.
- **Best if:** "someone clones my SaaS off my code" is your single biggest fear
  and you still want to be genuinely open source. Often paired with a paid
  commercial license (dual licensing) for companies that can't use AGPL.

## Option D — BSL 1.1 / Fair Source (source-available)

- **What it allows:** view, modify, self-host, and use — **except** offering it as
  a competing commercial service. A time delay (e.g. 3–4 years) after each release
  auto-converts that version to a true open-source license (often Apache-2.0).
- **OSI open source:** **no** (it's "source-available", not OSI-approved).
- **Pros:** strongest practical anti-clone protection while still showing all the
  code; used by Sentry, HashiCorp (Terraform), MariaDB.
- **Cons:** not "real" open source — you lose some community goodwill and can't
  claim the OSI badge; more nuanced to explain; some contributors won't touch it.
- **Best if:** protecting a future commercial cloud is paramount and you accept
  the "not truly open source" optics.

## Option E — Dual licensing (AGPL + commercial)

- **What it is:** release the core under AGPL-3.0 (Option C) **and** sell a
  separate commercial license to companies that want to avoid copyleft.
- **Pros:** community gets open source; you capture revenue from enterprises who
  need permissive terms; deters closed forks.
- **Cons:** you must own/collect rights to all contributions (a Contributor
  License Agreement), adding process overhead.
- **Best if:** you want both broad OSS reach and a direct license revenue line.

---

## How the moat works regardless of license (open-core)

1. **Closed cloud.** The engine/CLI is open; the hosted dashboards, run history,
   team accounts, RBAC, and scale live in a **proprietary** backend only you run.
   Forking the open core does not give anyone your service.
2. **Trademark.** Register the **name and logo**. Code can be copied; the identity
   cannot. A fork legally cannot be "DriftGuard".
3. **Velocity + community + trust + integrations.** By the time anyone forks,
   you're ahead and you have the users. Forks of healthy projects rarely survive.

## Recommendation snapshot

| Your priority | Pick |
|---|---|
| Max adoption, enterprise-friendly (default) | **Apache-2.0** |
| Max adoption, keep it dead simple | MIT |
| Still open source but block closed-SaaS clones | AGPL-3.0 (often dual-licensed) |
| Maximum anti-clone, accept "not OSI open source" | BSL / Fair Source |

For DriftGuard's stated strategy (open-core + cloud, venture-scale) the common
winning path is **Apache-2.0 core + closed cloud + trademarked name**, switching
to AGPL/dual-license only if a copycat SaaS becomes a real, observed threat.

---

*DriftGuard is part of Reply Intelligence Group.*
