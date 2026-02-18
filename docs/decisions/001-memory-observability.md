# ADR 001: Memory System Observability

**Status**: Accepted
**Date**: 2026-02-17
**Author**: Tim + Claude

## Context

TinyClaw implements a self-learning agent memory system with four components:
- `knowledge.md` — Core facts, always loaded
- `reflections.jsonl` — Failure/success learnings
- `episodes.jsonl` — Compressed conversation summaries
- `memory/skills/` — Reusable procedures

### The Problem

We have no visibility into:
1. When memory is being updated
2. What's in memory at any given time
3. Whether memory is growing unbounded
4. Why an agent failed to recall something

### The Challenge

The agent writes to memory files directly via Claude's file tools. **Our code doesn't intercept those writes.** This limits what code-level instrumentation can observe.

## Decision

**Implement a hybrid approach: File Watcher + Event System integration.**

1. Add a file watcher on `memory/` directories
2. When files change, emit events via the existing `emitEvent()` system
3. Events include: file changed, old/new size, diff summary, timestamp
4. Query events with grep/jq, or build dashboards on top later

## Alternatives Considered

### Option A: Extend Existing Event System Only

Add `emitEvent('memory.injected', {...})` calls to TinyClaw code.

| Pros | Cons |
|------|------|
| Already exists, zero new deps | Only captures what *our code* does |
| File-based, fits TinyClaw philosophy | **Misses agent's direct file writes** |
| Query with grep/jq | No UI, no dashboards |
| Simple to implement | No alerting |
| Works offline | No cross-agent correlation |

**Verdict**: Insufficient. Misses half the picture (agent writes).

### Option B: File Watcher + Structured Logs

Run a watcher process (chokidar/fswatch) on `memory/` directories. Log all changes.

| Pros | Cons |
|------|------|
| Catches ALL changes (including agent writes) | New process to run and monitor |
| Can compute diffs, track growth | File watchers can be flaky |
| Sees the actual content changes | Doesn't capture *why* something changed |
| Works regardless of how files are modified | Still need to build aggregation on top |

**Verdict**: Good for *what* changed, but loses context of *which conversation* triggered it.

### Option C: OpenTelemetry Tracing

Instrument TinyClaw with OTel SDK. Export spans to Langfuse/Braintrust/Jaeger.

| Pros | Cons |
|------|------|
| Industry standard, huge ecosystem | More complex setup |
| Correlates traces across full request lifecycle | Adds dependencies (@opentelemetry/*) |
| Rich UIs, dashboards, alerting built-in | **Still misses agent's direct file writes** |
| Can tie memory ops to specific conversations | Overkill for 1-2 agents |
| Works with LLM-specific tools (Langfuse, Braintrust) | Requires running a collector or SaaS |

**Verdict**: Best for scale, but premature for current needs. Same blind spot as Option A.

### Option D: Hybrid (File Watcher + Events) — CHOSEN

Combine file watching with the existing event system.

| Pros | Cons |
|------|------|
| Complete picture: what changed AND why | Two mechanisms (watcher + events) |
| Correlate file changes with conversations | Slightly more complex |
| Catches agent writes AND our code's actions | |
| No new external dependencies | |
| Fits existing TinyClaw architecture | |

## Implementation

```
Agent writes to knowledge.md
    ↓
File watcher detects change
    ↓
emitEvent('memory.knowledge_updated', {
    agent: 'pepe',
    file: 'knowledge.md',
    oldSize: 150,
    newSize: 180,
    linesAdded: 2,
    timestamp: '2026-02-17T12:00:00Z'
})
    ↓
Event written to events/ directory
    ↓
Query with grep/jq, build dashboards, or set up alerts
```

### Events to Emit

| Event | Trigger | Data |
|-------|---------|------|
| `memory.injected` | Before agent invocation | agent, totalSize, sectionsLoaded |
| `memory.knowledge_updated` | knowledge.md changed | agent, oldSize, newSize, diff |
| `memory.reflection_added` | reflections.jsonl changed | agent, newEntryCount |
| `memory.episode_captured` | episodes.jsonl changed | agent, summary, tags |
| `memory.skill_added` | skills/ changed | agent, skillId, description |
| `memory.size_warning` | Any file exceeds threshold | agent, file, size, threshold |

### File Watcher Implementation

Use Node.js `fs.watch()` or `chokidar` library:
- Watch: `{workspace}/**/memory/**`
- Debounce: 500ms (avoid duplicate events)
- On change: Read file, compute diff, emit event

### Memory Lifecycle Rules

| File | Max Size | Pruning Strategy |
|------|----------|------------------|
| knowledge.md | 200 lines | Agent instructed to consolidate |
| reflections.jsonl | 100 entries | Keep last 100, archive older |
| episodes.jsonl | 500 entries | Keep last 500, archive older |
| skills/*.md | 50 files | No auto-pruning, manual review |

Emit `memory.size_warning` when 80% of limit reached.

## Consequences

### Positive
- Full visibility into memory system behavior
- Can debug recall failures ("what was in memory when agent responded?")
- Can detect memory bloat before it causes problems
- Foundation for future dashboards/alerting
- No external dependencies required

### Negative
- File watcher adds a background process
- Events directory will grow (need rotation/archival)
- Still no built-in UI (grep/jq for now)

### Future Migration Path

When TinyClaw scales to multiple instances or needs richer analytics:
1. Add OpenTelemetry instrumentation alongside events
2. Export to Langfuse or Braintrust for LLM-specific insights
3. Keep file watcher — it's the only way to catch agent writes

## References

- [TinyClaw Memory System Docs](../MEMORY.md)
- [Braintrust: AI Observability Tools Guide 2026](https://www.braintrust.dev/articles/best-ai-observability-tools-2026)
- [LangChain: State of Agent Engineering](https://www.langchain.com/state-of-agent-engineering)
- [Adaline: Complete Guide to LLM & AI Agent Evaluation 2026](https://www.adaline.ai/blog/complete-guide-llm-ai-agent-evaluation-2026)
