# Agent Swarm

A general-purpose framework for coordinating many AI agents processing large datasets. Agents are treated as stateless compute workers in a DAG of phases, with structured data flowing between them.

---

## Why This Needs to Exist

There are two modes of using AI agents:

1. **Conversational**: A human talks to an agent (or a small team of agents). The unit of work is a conversation. Context is maintained. Responses are free-text. TinyClaw's team system does this well.

2. **Batch**: A system feeds thousands of items through agents for classification, analysis, or transformation. The unit of work is a data item. Agents are stateless. Responses are structured. Nothing does this well today.

The batch model breaks down with naive approaches:
- **One giant prompt**: Context window limits mean you can't fit 3,000 items in one call
- **Sequential loop**: Processing items one-at-a-time takes hours and wastes money (no parallelism, no prompt caching)
- **Unstructured fan-out**: If agents return free-text, you can't programmatically aggregate results
- **No fault tolerance**: If the process dies at item #2,847, you start over

The swarm framework solves this with three ideas:
1. **Phases** that compose into a DAG (not just linear pipelines)
2. **Typed data contracts** between phases (JSON schemas, not free text)
3. **Checkpoint-everything** execution (resume from any failure point)

---

## Core Model

### The Execution DAG

A swarm job is a directed acyclic graph of phases. Each phase transforms data.

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│ Ingest  │────▶│  Map    │────▶│ Reduce  │──┐
└─────────┘     └─────────┘     └─────────┘  │
                                              │
                ┌─────────┐     ┌─────────┐   │
                │ Review  │◀────│  Gate   │◀──┘
                └────┬────┘     └─────────┘
                     │
                ┌────▼────┐
                │ Report  │
                └─────────┘
```

Phases don't have to be linear. A `gate` phase can branch conditionally. Two independent map phases can run in parallel. The framework resolves the DAG and executes phases in dependency order.

### Phase Types

| Type | Parallelism | Purpose |
|------|-------------|---------|
| **ingest** | 1 | Fetch data from external source (API, filesystem, database) |
| **map** | N workers | Process each item independently. 1 input item → 1 output item. |
| **filter** | N workers | Like map, but items can be dropped. 1 input → 0 or 1 output. |
| **reduce** | 1-few | Aggregate across all items. N inputs → M outputs (M < N). |
| **gate** | 1 | Conditional routing. Inspect data, decide which downstream phase(s) to activate. |
| **transform** | 1 | Non-AI programmatic transformation. Pure code, no agent invocation. |
| **review** | N workers | Like map, but with enriched context (e.g., full diffs, not just metadata). |
| **report** | 1 | Synthesize all results into final output. |

The key distinction: `map`, `filter`, and `review` phases are **embarrassingly parallel** — every item is independent. `reduce`, `gate`, and `report` phases need to see the full picture.

### Workers

A worker is a single, stateless agent invocation. It receives structured input and must produce structured output matching a declared schema.

```
Worker = (system_prompt, input_json) → output_json
```

Workers have no memory. No conversation history. No personality. They are pure functions over data. This is what makes them parallelizable and retryable — calling a worker twice with the same input should produce equivalent output.

The framework doesn't care what backs a worker:
- Claude CLI subprocess
- Codex CLI subprocess
- Direct Anthropic API call
- Claude Agent SDK (`@anthropic-ai/claude-code`)
- A local script (for non-AI transform phases)

This is configured per-phase, and the worker pool abstraction handles the differences.

### Data Contracts

Every phase declares:
- **Input schema**: What shape of data it expects
- **Output schema**: What shape of data it produces
- **Cardinality**: How inputs map to outputs (1:1, N:1, N:M, conditional)

```typescript
interface PhaseContract {
  input_schema: JSONSchema;
  output_schema: JSONSchema;
  cardinality: '1:1' | 'N:1' | 'N:M' | 'conditional';
}
```

At phase boundaries, the framework validates:
1. The previous phase's output matches the next phase's input schema
2. Each individual worker output matches the phase's output schema

If a worker produces invalid output, the framework retries with the validation error appended to the prompt. This gives the model a chance to self-correct before the batch is marked as failed.

### Checkpointing

Every piece of state is written to disk:

```
~/.tinyclaw/swarm/jobs/{job_id}/
├── job.json                    # Job definition + current status
├── dag.json                    # Resolved execution graph
├── phases/
│   ├── ingest/
│   │   ├── phase.json          # Phase status + progress
│   │   └── output.json         # Complete phase output
│   ├── classify/
│   │   ├── phase.json
│   │   ├── output.json         # Merged output (all batches)
│   │   └── batches/
│   │       ├── 001-input.json
│   │       ├── 001-output.json # Checkpoint per batch
│   │       ├── 002-input.json
│   │       ├── 002-output.json
│   │       └── ...
│   └── ...
├── prompts/                    # Resolved prompts (for reproducibility)
└── events/                     # Real-time event stream for TUI
```

**Resumability rules**:
- If a job crashes, `tinyclaw swarm resume {job_id}` restarts from the last incomplete phase
- Within a map/filter/review phase, completed batches are skipped — only incomplete batches re-run
- Phase outputs are immutable once the phase completes — re-running a phase requires explicit `tinyclaw swarm rerun {job_id} --phase {name}`

---

## The Worker Pool

The worker pool is the execution engine. It manages concurrent agent invocations with backpressure, retry, and cost tracking.

### Concurrency Model

```
                     ┌────────────────────┐
                     │   Phase Executor   │
                     │                    │
                     │  Splits items into │
                     │  batches, submits  │
                     │  to worker pool    │
                     └────────┬───────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         ┌─────────┐    ┌─────────┐    ┌─────────┐
         │ Slot 1  │    │ Slot 2  │    │ Slot 3  │  ... (concurrency N)
         │         │    │         │    │         │
         │ Worker  │    │ Worker  │    │ Worker  │
         │ running │    │ running │    │  idle   │
         └────┬────┘    └────┬────┘    └─────────┘
              │              │
              ▼              ▼
        [batch result]  [batch result]  → merged into phase output
```

When a slot finishes, the next queued batch is dispatched. This is a simple semaphore pattern — no need for complex scheduling.

### Retry Strategy

```
Attempt 1: Run worker normally
  ↓ (fail: parse error)
Attempt 2: Re-run with validation error in prompt
  ↓ (fail: timeout)
Attempt 3: Re-run with increased timeout (2x)
  ↓ (fail: any)
Mark batch as FAILED, continue with remaining batches
```

Failed batches don't block the job. The phase completes with partial results and a list of failed batches. The user can inspect failures and either fix prompts and retry, or accept partial results.

### Cost Controls

```typescript
interface CostConfig {
  budget_usd?: number;          // Hard cap. Job pauses when reached.
  warn_usd?: number;            // Soft cap. Emits warning event.
  track_tokens: boolean;        // Track input/output tokens per batch
}
```

The framework estimates token usage per batch (input size × batch_size) and tracks actual usage from API responses. If a budget is set, the job pauses before starting a batch that would exceed it.

---

## Adaptive Execution

Not every item needs the same treatment. Adaptive execution lets the framework adjust behavior based on the data.

### Model Escalation

Start cheap, escalate only when needed:

```yaml
phases:
  classify:
    type: map
    model: haiku              # Fast + cheap first pass

  review:
    type: review
    model_strategy: escalate  # Dynamic model selection
    escalation:
      default: sonnet
      rules:
        - condition: "item.complexity == 'XL'"
          model: opus
        - condition: "item.flags.includes('security')"
          model: opus
```

Most items get Sonnet. Only complex or security-sensitive items get Opus. This can cut costs 3-5x compared to using Opus for everything.

### Dynamic Batch Sizing

Simple items can be batched aggressively. Complex items need more context per item:

```yaml
phases:
  classify:
    type: map
    batch_strategy: adaptive
    batching:
      default_size: 50
      rules:
        - condition: "item.diff_size > 1000"
          batch_size: 10      # Large diffs need more context per item
        - condition: "item.diff_size < 100"
          batch_size: 100     # Small diffs can pack densely
```

### Conditional Phases

Gate phases inspect the data and decide what happens next:

```yaml
phases:
  triage_gate:
    type: gate
    conditions:
      - if: "data.clusters.length > 500"
        then: deep_reduce     # Too many clusters, need another reduce pass
      - if: "data.clusters.length <= 500"
        then: review          # Manageable, proceed to review
```

---

## Job Definitions

Jobs are declared in YAML (or JSON). The framework resolves the DAG, validates contracts, and executes.

### Anatomy of a Job Definition

```yaml
name: "pr-review"
description: "Scan, classify, de-duplicate, and review open PRs"

# Global config
config:
  default_model: sonnet
  default_provider: anthropic
  budget_usd: 50
  output_dir: ./reports

# Shared context available to all phases
context:
  vision_document: ./VISION.md

# Phase definitions
phases:
  ingest:
    type: ingest
    source:
      type: github-prs        # Built-in data source
      repo: "owner/repo"
      state: open
      fields: [number, title, body, author, files, labels, ci_status]
    output_schema: schemas/pr-metadata.json

  classify:
    type: map
    depends_on: [ingest]
    batch_size: 50
    concurrency: 20
    model: sonnet
    timeout_ms: 120000
    prompt: prompts/classify.md
    input_schema: schemas/pr-metadata.json
    output_schema: schemas/pr-classification.json

  pre_cluster:
    type: transform           # Non-AI, pure code
    depends_on: [classify]
    script: transforms/cluster-by-similarity.ts
    # Groups items by overlapping files, similar titles, matching fingerprints

  refine_clusters:
    type: reduce
    depends_on: [pre_cluster]
    concurrency: 3            # Shard by category
    model: sonnet
    prompt: prompts/refine-clusters.md
    input_schema: schemas/pre-clusters.json
    output_schema: schemas/clusters.json

  review:
    type: review
    depends_on: [refine_clusters]
    batch_size: 5
    concurrency: 10
    model: opus
    timeout_ms: 300000
    prompt: prompts/deep-review.md
    # Enrichment: fetch additional data for each item before sending to worker
    enrich:
      - field: diff
        source: github-pr-diff
    input_schema: schemas/pr-for-review.json
    output_schema: schemas/pr-review.json

  report:
    type: report
    depends_on: [review, refine_clusters]  # Gets both review results and cluster data
    model: opus
    prompt: prompts/synthesize-report.md
    output_format: markdown
```

### Built-in Data Sources (Ingest Phase)

| Source | Description |
|--------|-------------|
| `github-prs` | Fetch PRs from a GitHub repo via `gh` API |
| `github-issues` | Fetch issues from a GitHub repo |
| `filesystem` | List files matching a glob pattern |
| `json-file` | Read a local JSON array |
| `csv-file` | Read a local CSV file |
| `stdin` | Read JSON from standard input |

Data sources are pluggable — new ones can be registered.

### Built-in Enrichment Sources (Review Phase)

| Source | Description |
|--------|-------------|
| `github-pr-diff` | Fetch the full diff for a PR |
| `github-pr-comments` | Fetch all comments on a PR |
| `file-contents` | Read file contents from disk |
| `web-fetch` | Fetch a URL |

Enrichment happens *per-item* just before the item is sent to a worker. This avoids fetching expensive data (like full diffs) for items that get filtered out in earlier phases.

### Built-in Transform Scripts

| Script | Description |
|--------|-------------|
| `cluster-by-similarity` | Group items by overlapping fields, string similarity |
| `sort-by-field` | Sort items by a field |
| `merge-arrays` | Merge multiple input arrays into one |
| `pick-top-k` | Select top K items by a scoring field |

Transform phases run TypeScript functions — no agent invocation, no cost, instant execution. They're the glue between AI phases.

---

## Prompt Design

Swarm prompts are different from conversational prompts. They need to be **mechanical**: precise instructions that produce parseable output.

### Prompt Structure

Every worker prompt follows this template:

```markdown
# Role

You are a {role}. You will process a batch of {items}.

# Instructions

{Specific instructions for this phase.}

# Context

{Shared context like vision documents, rubrics, examples.}

# Output Format

You MUST output ONLY a JSON array. No markdown fences. No commentary.
Each element must match this schema:

{JSON schema, rendered as example}

# Input

{The batch data is injected here by the framework.}
```

Key principles:
- **No conversation**: Workers don't greet, apologize, or explain. They output JSON.
- **Schema as example**: Show a complete example object, not just a schema definition. Models produce more reliable output when they can pattern-match.
- **Explicit enumeration**: If a field has valid values like `["bug-fix", "feature", "refactor"]`, list them all. Don't say "a category string."
- **Failure mode**: Tell the worker what to output if it's unsure: `"If you cannot determine the category, use 'unknown'."` This prevents workers from outputting explanatory text instead of JSON.

### Prompt Caching

When using the Anthropic API, the system prompt + context (which is identical across all batches in a phase) can be cached. Only the batch-specific input varies. This reduces input token costs by ~90% for phases with many batches.

The framework handles this automatically: the worker invocation layer separates the cacheable prefix (system prompt + context) from the variable suffix (batch input).

---

## Progress & Observability

### Event Stream

Every state change emits a JSON event to `~/.tinyclaw/swarm/jobs/{job_id}/events/`:

```jsonc
// Phase started
{ "type": "phase_start", "phase": "classify", "total_batches": 60, "ts": 1708099200000 }

// Batch completed
{ "type": "batch_done", "phase": "classify", "batch": "017", "items": 50, "duration_ms": 23400, "ts": 1708099223000 }

// Batch failed
{ "type": "batch_fail", "phase": "classify", "batch": "012", "error": "JSON parse error", "attempt": 1, "ts": 1708099230000 }

// Phase completed
{ "type": "phase_done", "phase": "classify", "items_processed": 2950, "failed": 50, "duration_ms": 360000, "ts": 1708099560000 }

// Cost update
{ "type": "cost_update", "total_tokens": 1200000, "estimated_usd": 4.80, "ts": 1708099560000 }

// Job completed
{ "type": "job_done", "phases_completed": 5, "total_items": 3000, "total_usd": 27.30, "ts": 1708100100000 }
```

### TUI Dashboard

```
┌─ Swarm Job: pr-review (a1b2c3) ─────────────────────────────────────────────┐
│                                                                              │
│ ✓ ingest          3,127 items                              2s               │
│ ▶ classify         ████████████████████░░░░  78% (47/60)   ~2m left         │
│   ○ pre_cluster    waiting                                                   │
│   ○ refine         waiting                                                   │
│   ○ review         waiting                                                   │
│   ○ report         waiting                                                   │
│                                                                              │
│ Workers: 18/20 active │ Retries: 2 │ Failed: 0                              │
│ Tokens: 1.2M │ Cost: $4.80 / $50.00 budget                                 │
│                                                                              │
│ ┌─ Activity ───────────────────────────────────────────────────────────────┐ │
│ │ 14:23:01  ✓ batch-047  50 items  21s  sonnet                            │ │
│ │ 14:22:58  ✓ batch-046  50 items  24s  sonnet                            │ │
│ │ 14:22:45  ↻ batch-012  retry #1  JSON parse error                       │ │
│ │ 14:22:40  ✓ batch-045  50 items  19s  sonnet                            │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## CLI

```bash
# Run a job from a definition file
tinyclaw swarm run job.yaml

# Run a built-in job type with flags
tinyclaw swarm pr-review owner/repo --vision VISION.md --budget 50

# Job management
tinyclaw swarm list                           # List all jobs
tinyclaw swarm status {job_id}                # Show job status
tinyclaw swarm watch {job_id}                 # Live TUI dashboard
tinyclaw swarm resume {job_id}                # Resume from last checkpoint
tinyclaw swarm cancel {job_id}                # Cancel a running job

# Debugging & iteration
tinyclaw swarm rerun {job_id} --phase classify          # Re-run one phase
tinyclaw swarm rerun {job_id} --phase classify --batch 12  # Re-run one batch
tinyclaw swarm inspect {job_id} --phase classify --batch 12  # View batch I/O
tinyclaw swarm export {job_id} --format json             # Export results

# Dry run — validate the DAG without executing
tinyclaw swarm run job.yaml --dry-run
```

---

## Integration with TinyClaw

The swarm framework lives alongside the existing team system, not replacing it.

### Shared Infrastructure

| Component | Teams | Swarm | Shared? |
|-----------|-------|-------|---------|
| Agent invocation (`invoke.ts`) | `invokeAgent()` — persistent, stateful | `invokeWorker()` — ephemeral, stateless | Shared `runCommand()` base |
| Queue system | File-based message queue | Not used (batch executor manages its own work) | No |
| Data format | Free text | Structured JSON | No |
| Event system | `~/.tinyclaw/events/` | `~/.tinyclaw/swarm/jobs/{id}/events/` | Same format, different directories |
| TUI | `team-visualizer.tsx` | `swarm-visualizer.tsx` | Shared Ink/React framework |
| Config | `settings.json` agents/teams | `job.yaml` definitions | Agents reusable as worker configs |

### Channel Integration

Swarm jobs can be triggered from any channel:

```
@swarm pr-review openclaw/openclaw --vision VISION.md
```

The coordinator runs the job asynchronously and sends a summary back to the channel when complete. For long jobs, periodic progress updates can be sent.

### Teams Triggering Swarms

A team agent can invoke a swarm job as part of a conversation:

```
User: "@dev review all open PRs and give me a summary"
Leader agent → recognizes this is a bulk task → triggers swarm job
Swarm completes → result delivered back to the conversation
```

This bridges the two modes: conversational intent triggers batch execution.

---

## Architecture Decisions

### Why a DAG, Not Just Map-Reduce

MapReduce is two phases. Real workflows need more:
- **Filter** after map (remove spam PRs before expensive review)
- **Enrich** before review (fetch diffs only for candidates that survived filtering)
- **Gate** for conditional branching (if too many clusters, re-reduce)
- **Transform** for cheap code-only steps between AI phases

A DAG of typed phases is the minimal abstraction that supports all of these without special-casing.

### Why File-Based State, Not a Database

Same philosophy as TinyClaw's queue system:
- No setup or dependencies
- Human-readable (you can `cat` any intermediate result)
- Trivially resumable (check which batch files exist)
- Git-friendly (you could commit job results)
- Portable (copy a job directory to another machine)

### Why Stateless Workers, Not Persistent Agents

Persistent agents (TinyClaw team model) maintain conversation history. This is wasteful for batch work:
- Each batch is independent — history from batch #12 doesn't help with batch #13
- Stateless workers can be retried trivially (no corrupted state)
- Stateless workers can run on any available slot (no affinity)
- Lower memory footprint per worker

The one exception: reduce/report phases may benefit from seeing the full context of what came before. But this is handled by the phase executor injecting the right data, not by worker statefulness.

### Why Structured JSON, Not Free Text

Free-text responses can't be:
- Validated against a schema
- Merged across batches programmatically
- Fed as structured input to the next phase
- Queried or filtered without another AI call

JSON schemas make the pipeline mechanical. Each phase boundary is a type-checked interface.

### Why Not Just Use the Anthropic Batch API Directly

The Anthropic Batch API is a possible *backend* for the worker pool, but it's not a framework:
- No phase composition or DAGs
- No schema validation
- No retry with error feedback
- No intermediate checkpointing
- No TUI visualization
- No prompt management
- 24h turnaround (acceptable for some jobs, not all)

The swarm framework can use the Batch API as one execution backend when latency doesn't matter and cost does.

---

## Type Definitions

```typescript
// ─── Job ──────────────────────────────────────────────────

interface SwarmJob {
  id: string;
  name: string;
  description?: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  created_at: number;
  updated_at: number;
  config: JobConfig;
  phases: Record<string, SwarmPhase>;
  dag: DAGEdge[];                   // Phase dependency edges
  current_phases: string[];          // Currently executing phase(s)
  results?: any;                     // Final output
  error?: string;
}

interface JobConfig {
  default_model: string;
  default_provider: string;
  budget_usd?: number;
  warn_usd?: number;
  output_dir?: string;
  context?: Record<string, string>; // Shared context (e.g., vision doc path)
}

interface DAGEdge {
  from: string;                     // Phase name
  to: string;                       // Phase name
  condition?: string;               // Optional condition expression
}

// ─── Phase ────────────────────────────────────────────────

interface SwarmPhase {
  name: string;
  type: 'ingest' | 'map' | 'filter' | 'reduce' | 'gate' | 'transform' | 'review' | 'report';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  depends_on: string[];
  config: PhaseConfig;
  progress: PhaseProgress;
  contract: PhaseContract;
}

interface PhaseConfig {
  // Execution
  batch_size?: number;              // Items per batch (map/filter/review)
  concurrency?: number;             // Max parallel workers
  timeout_ms?: number;              // Per-worker timeout
  retries?: number;                 // Max retries per batch

  // AI
  model?: string;
  provider?: string;
  prompt?: string;                  // Path to prompt file
  model_strategy?: 'fixed' | 'escalate';
  escalation_rules?: EscalationRule[];

  // Non-AI
  script?: string;                  // Path to transform script

  // Data
  enrich?: EnrichmentConfig[];      // Per-item data enrichment
  input_schema?: string;            // Path to JSON schema
  output_schema?: string;

  // Batching
  batch_strategy?: 'fixed' | 'adaptive';
  batch_rules?: BatchRule[];
}

interface PhaseProgress {
  total_items: number;
  processed_items: number;
  total_batches: number;
  completed_batches: number;
  failed_batches: number;
  tokens_used: number;
  cost_usd: number;
  start_time?: number;
  end_time?: number;
}

interface PhaseContract {
  input_schema: object;             // JSON Schema
  output_schema: object;
  cardinality: '1:1' | 'N:1' | 'N:M' | 'conditional';
}

// ─── Worker ───────────────────────────────────────────────

interface WorkerTask {
  task_id: string;
  job_id: string;
  phase: string;
  batch_id: string;
  input: any;
  system_prompt: string;
  model: string;
  provider: string;
  timeout_ms: number;
  attempt: number;
  context?: Record<string, string>; // Shared context values
}

interface WorkerResult {
  task_id: string;
  batch_id: string;
  status: 'success' | 'failed';
  output?: any;
  error?: string;
  duration_ms: number;
  tokens_input?: number;
  tokens_output?: number;
}

// ─── Supporting ───────────────────────────────────────────

interface EscalationRule {
  condition: string;                // JS expression evaluated per item
  model: string;
}

interface BatchRule {
  condition: string;
  batch_size: number;
}

interface EnrichmentConfig {
  field: string;                    // Field to add to each item
  source: string;                   // Data source type
  params?: Record<string, string>;  // Source-specific params
}
```

---

## Example: PR Review as a Job Definition

With all the framework machinery above, the PR review pipeline is just a job definition file:

```yaml
name: pr-review
description: Scan, classify, de-duplicate, and deep-review open PRs

config:
  default_model: sonnet
  default_provider: anthropic
  budget_usd: 50
  context:
    vision: ./VISION.md

phases:
  ingest:
    type: ingest
    source: { type: github-prs, repo: "owner/repo", state: open }

  classify:
    type: map
    depends_on: [ingest]
    batch_size: 50
    concurrency: 20
    model: sonnet
    prompt: prompts/classify.md

  filter_spam:
    type: filter
    depends_on: [classify]
    batch_size: 100
    concurrency: 10
    model: haiku
    prompt: prompts/filter-spam.md

  pre_cluster:
    type: transform
    depends_on: [filter_spam]
    script: transforms/cluster-by-similarity.ts

  refine_clusters:
    type: reduce
    depends_on: [pre_cluster]
    concurrency: 3
    model: sonnet
    prompt: prompts/refine-clusters.md

  review:
    type: review
    depends_on: [refine_clusters]
    batch_size: 5
    concurrency: 10
    model: opus
    timeout_ms: 300000
    prompt: prompts/deep-review.md
    enrich:
      - field: diff
        source: github-pr-diff

  report:
    type: report
    depends_on: [review, refine_clusters]
    model: opus
    prompt: prompts/synthesize-report.md
    output_format: markdown
```

Other use cases (issue triage, codebase audit, dependency review, doc gap analysis) are just different YAML files with different prompts and schemas. The framework doesn't change.

---

## Implementation Milestones

### M1: Core Framework
- `SwarmCoordinator` — parse job YAML, resolve DAG, manage lifecycle
- `PhaseExecutor` — run a single phase (batch splitting, worker dispatch, result merging)
- `WorkerPool` — concurrent invocation with semaphore, retry, timeout
- `invokeWorker()` — stateless Claude/Codex invocation
- `DataStore` — checkpoint read/write per phase and batch
- `SchemaValidator` — validate worker output, produce error feedback for retry
- CLI: `tinyclaw swarm run`, `status`, `resume`, `list`

### M2: Built-in Data Sources & Transforms
- Ingest sources: `github-prs`, `github-issues`, `filesystem`, `json-file`
- Enrichment sources: `github-pr-diff`, `github-pr-comments`, `file-contents`
- Transform scripts: `cluster-by-similarity`, `sort-by-field`, `pick-top-k`
- CLI: `tinyclaw swarm pr-review` (built-in job template)

### M3: Adaptive Execution
- Model escalation (per-item model selection based on rules)
- Dynamic batch sizing
- Gate phases (conditional routing)
- Cost tracking and budget enforcement

### M4: Visualization
- Swarm TUI dashboard (React/Ink)
- Real-time progress, activity log, cost tracker
- CLI: `tinyclaw swarm watch`

### M5: Actions & Integration
- GitHub output: post PR comments, apply labels, close duplicates
- Channel integration: trigger swarm from Discord/Telegram/WhatsApp
- Webhook/cron triggers
- Anthropic Batch API as alternative worker backend

---

## Open Questions

1. **Worker backend**: CLI subprocess (`claude -p`) vs Agent SDK (`@anthropic-ai/claude-code` as library) vs raw API (`@anthropic-ai/sdk`). CLI is simplest but has subprocess overhead. Agent SDK gives tool use. Raw API is fastest but no tool use. Should the framework support all three, or pick one?

2. **Prompt versioning**: When you iterate on a prompt and re-run a phase, should the framework track prompt versions? This would let you diff results across prompt changes — useful for prompt engineering at scale.

3. **Streaming results**: Should the report phase wait for all reviews, or start generating as reviews complete? Streaming would give faster time-to-first-result but complicates the DAG model.

4. **Multi-model composition within a batch**: Could a single batch use multiple models? E.g., Haiku for initial classification, Sonnet for items Haiku was uncertain about? This is micro-level escalation vs the current phase-level escalation.

5. **Shared memory between workers**: In rare cases, workers might benefit from seeing other workers' results (e.g., "this PR was already classified as a duplicate of #X by another worker"). This breaks the stateless model. Is it worth supporting as an opt-in?
