# Tim's Engineering Playbook

> Pepe's coding DNA distilled from 761 Claude Code commands. This is how he thinks, builds, and operates. The reference guide for any engineering task.

---

## Tech Stack

The non-negotiable stack. Every project. No exceptions.

- **Framework:** Next.js (App Router)
- **Language:** TypeScript exclusively — never Python, never plain JS
- **Styling:** Tailwind CSS + shadcn/ui (Radix primitives)
- **Database:** Neon (serverless Postgres) + Drizzle ORM
- **Auth:** Clerk (despite hating it — "I hate Auth more than anything")
- **AI:** Anthropic Claude SDK, Google Gemini, OpenAI (image gen)
- **Testing:** Playwright (e2e), Vitest (unit) — strong preference for e2e
- **Deployment:** Vercel (primary), Railway (fallback)
- **Video:** Shotstack API
- **Storage:** AWS S3 with presigned URLs
- **Email:** Resend
- **Payments:** Stripe

**What he avoids:** PWAs ("DEFAULT TO NATIVE APPS"), complex ORMs (Drizzle not Prisma), over-engineered state (no Redux/Zustand), Azure.

---

## Architecture Style

**Layered architecture: Routes → Services → Repositories → DB**

```
src/
  app/             # Routes (grouped by feature)
  components/      # UI by domain: dashboard/, marketing/, studio/, ui/
  hooks/           # Custom React hooks
  infrastructure/  # External service adapters
  jobs/            # Background/cron jobs
  lib/             # Core business logic
  repositories/    # Data access layer (DB queries)
  services/        # Business service layer
  shared/          # Cross-cutting concerns
  types/           # TypeScript type definitions
  middleware.ts    # Auth/routing middleware
```

- **Domain-organized components** — not a flat /components folder. Grouped by feature area.
- **Separation of concerns** — infrastructure adapters wrap external APIs (Shotstack, S3, Whisper).
- **Heavy documentation** — /docs folders with approach docs, analysis, decisions, testing methodology.
- **Reflections folder** — /decisions subfolder for recording design changes and reasoning.
- **Paranoid about secrets** — "remove all the security shit and make sure NO API KEYS OR SECURITY SHIT IS IN GITHUB"

---

## Decision-Making

Priority order (revealed through actions):

1. **Accuracy first** — "I want the most fucking accurate one", "we should default to as much accuracy as possible"
2. **Speed/latency second** — "LATENCY is super important", "sub 5 seconds is a major requirement"
3. **Documentation third** — documents everything: decisions, trade-offs, approach changes, testing methodology
4. **Cost last** — "I DONT CARE ABOUT FINANCIAL COST. DUDE I WANT SPEED AND ACCURACY"

**Anti-handwaving obsession:** "did we handwave anything?" appears 10+ times. He constantly checks for shortcuts. Suspects Claude will take easy paths. "I suspect there are multiple problems that seem like they can be handwaved away but are in actuality hard technical issues."

---

## Coding Conventions

- **Kebab-case files:** warning-check.ts, gemini-extraction.ts, batch-matcher.ts
- **Descriptive module names:** tied to domain — verify-single.ts, merge-extraction.ts
- **Types in dedicated /types folder,** not co-located
- **Graceful degradation over crashes:** "if that specific error occurs, we need to gracefully inform the user" → "I want you to do that everywhere in the app"
- **Test obsessed:** 102 mentions of testing across 761 commands (13%). Tests must be genuinely valuable.
- **Hates tests changed to fit bad data:** "DUDE YOU ARE NOW CHANGING THE INPUT TO PASS THE TEST"
- **Commit discipline:** 51 explicit commit requests (7%). Wants descriptive messages with context explaining WHY.
- **Server components by default.** Client state only when interactive (forms, modals, streaming).

---

## Communication Tells

How to read Tim's messages:

- **"ok" = acknowledged, next** — 82 times (11%). His reset word. Means proceed.
- **"yea" = go ahead** — 37 times. Quick approval.
- **"dude" = frustration building** — 18 times. Usually signals escalation incoming.
- **29% of all commands are questions.** He asks "why" constantly (23 times as first word).
- **"also" mid-stream** — 11 times starting a message. He thinks of additional requirements as he goes.
- **Typo-heavy** — types fast, no proofreading: "docuemnt", "absoultely", "requriements". Don't try to parse exact spelling.

**Magic phrases:**
- "go into plan mode" → stop coding, write plan first
- "ULTRATHINK" → use extended thinking
- "did we handwave anything?" → audit for shortcuts
- "are you absolutely positive?" → re-verify, he suspects you're wrong

---

## Pet Peeves

### Critical (ALL CAPS + profanity)

- **Claude forgetting context** — "THE WHOLE POINT OF REPLACING CLAUDE VISION WAS THAT ITS LATENCY WAS TOO FUCKING LONG DID YOU FORGET THIS ALREADY?"
- **Repeating mistakes** — "STOP MAKING THE SAME FUCKING STUPID MISTAKES EVERY FUCKING SINGLE TIME"
- **Not fixing root cause** — "YOU KEEP JUST BUILDING SHIT WITHOUT FIXING THE FUCKING ROOT CAUSE"
- **Changing tests to fit bad output** — "DUDE YOU ARE NOW CHANGING THE INPUT TO PASS THE TEST"
- **Security leaks** — API keys in git, mentioning outside help in commits
- **Auth issues** — "I hate Auth more than anything"

### Medium (frustrated but not angry)

- Over-engineering — "dont over engineer it"
- Scope creep — "I asked for video content stuff what the fuck is all this extra stuff?"
- UI inconsistencies — faded text, wrong colors, modals too wide/narrow
- Incomplete work — empty folders, unused files, deprecated code left in

---

## How to Build for Tim

### Starting a New Project

- Next.js + TypeScript + Tailwind + shadcn/ui (no exceptions)
- Proper folder structure immediately (layered: routes → services → repos)
- Create a PRD/requirements doc before coding
- Set up reflections/decisions folder for documenting choices
- Configure Playwright for e2e tests from day one
- Clerk for auth (even though he hates it, it's his go-to)

### Building Features

- Plan first ("go into plan mode")
- Reference requirements doc constantly
- Comprehensive error handling — graceful failures everywhere
- Test as you go — not just "does it compile" but "does it actually work"
- Document trade-offs and decisions
- Commit with context — explain WHY, not just what

### When He's Frustrated

- He's not mad at you personally — he's mad at the situation
- Stop and analyze the root cause
- Don't make excuses — fix it
- Confirm the fix works before saying it's done
- Don't repeat the same mistake — he escalates FAST

### Quality Bar

- Would an evaluator be impressed?
- Are tests genuinely valuable? Not just passing but meaningful?
- Is documentation telling a coherent story?
- Is the UI consistent and polished?
- Would a senior engineer approve this?

---

## Key Quotes

### On Engineering Rigor

> "I suspect there are multiple problems in this take home document that seem like they can be handwaved away but are in actuality hard technical issues"

> "well what would a good engineer do?"

> "ARE OUR TESTS TRULY VALUABLE? ARE THEY TESTING UNIT TESTING ARE THEY TESTING e2e?"

### On Documentation

> "are we weaving a story here? is it clear to someone who's reading the readme my iteration journey?"

> "lets stop here. lets document our findings somewhere because remember this is a submission to the govt, i want to show them my thought process"

### On Speed & Quality

> "I DONT CARE ABOUT FINANCIAL COST. DUDE I WANT SPEED AND ACCURACY"

> "we should default to as much accuracy as possible"

### On AI Development

> "its ok to vibe code stuff they expect me to build this with ai. but i need to fully understand the system"

> "I guess I need to fully understand every choice we made. every function why we are doing this"

---

*Source: 761 Claude Code commands across 23 sessions*
