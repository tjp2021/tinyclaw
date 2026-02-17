# Swarms — Large-Scale Parallel Processing

Swarms are TinyClaw's map-reduce orchestration primitive for large-scale tasks. While **agents** handle single conversations and **teams** enable collaborative workflows, **swarms** process thousands of items in parallel using batching and result aggregation.

## When to Use Swarms

Swarms are ideal for tasks that involve processing many similar items:

- Review 3,000 pull requests across a GitHub organization
- Analyze 500 customer support tickets for patterns
- Process 10,000 log entries for anomalies
- Summarize hundreds of documents
- Audit thousands of configuration files

## Architecture

### Standard Pipeline (aggregation tasks)

```
User Message → @swarm_id
         ↓
    ┌─────────────┐
    │  Input       │  Fetch items (command, file, or inline)
    │  Resolution  │
    └──────┬──────┘
           ↓
    ┌─────────────┐
    │  Batch       │  Split N items into N/batch_size batches
    │  Splitter    │
    └──────┬──────┘
           ↓
    ┌─────────────┐     ┌──────────┐
    │  Worker      │────→│ Worker 1 │──→ Batch result 1
    │  Pool        │────→│ Worker 2 │──→ Batch result 2
    │  (parallel)  │────→│ ...      │──→ ...
    │              │────→│ Worker N │──→ Batch result N
    └──────┬──────┘     └──────────┘
           ↓
    ┌─────────────┐
    │  Reducer     │  Aggregate results (concatenate/summarize/hierarchical)
    └──────┬──────┘
           ↓
    Final Response → User
```

### Shuffle Pipeline (cross-referencing tasks like dedup)

When items must be compared across batches, enable the **shuffle** phase. Like MapReduce's shuffle, this re-groups map outputs by key before reduction — guaranteeing that related items (potential duplicates, conflicting changes) land in the same reduce partition.

```
    ┌─────────────┐     ┌──────────┐
    │  Worker      │────→│ Worker 1 │──→ [{pr:42, tags:["auth"]}, ...]
    │  Pool        │────→│ Worker 2 │──→ [{pr:1876, tags:["auth"]}, ...]
    │  (Map)       │────→│ Worker N │──→ [...]
    └──────┬──────┘     └──────────┘
           ↓
    ┌─────────────┐
    │  Shuffle     │  Group by key field (e.g., "tags")
    │              │  "auth" → [PR#42, PR#1876, PR#99, ...]
    │              │  "bugfix" → [PR#42, PR#55, ...]
    │              │  "refactor" → [PR#200, PR#3001, ...]
    └──────┬──────┘
           ↓
    ┌─────────────┐     ┌──────────────┐
    │  Partition   │────→│ "auth" group │──→ "Duplicates: #42 ↔ #1876"
    │  Reduce      │────→│ "bugfix" grp │──→ "Duplicates: #42 ↔ #55"
    │  (parallel)  │────→│ "refactor"   │──→ "No duplicates"
    └──────┬──────┘     └──────────────┘
           ↓
    ┌─────────────┐
    │  Final Merge │  Deduplicate findings across partitions
    └──────┬──────┘
           ↓
    Final Response → User
```

**Why shuffle solves the cross-batch problem:** Without shuffle, PR#42 (in batch 3) and PR#1876 (in batch 95) are never compared — they live in different batch results that get summarized independently. With shuffle, both PRs share the tag "auth", so they're grouped into the same partition and the reducer sees them side by side.

## Quick Start

### 1. Create a Swarm

```bash
tinyclaw swarm add
```

Or add to `settings.json`:

```json
{
  "swarms": {
    "pr-reviewer": {
      "name": "PR Reviewer",
      "agent": "coder",
      "concurrency": 10,
      "batch_size": 25,
      "input": {
        "command": "gh pr list --repo {{repo}} --limit 5000 --json number,title,url,additions,deletions,changedFiles",
        "type": "json_array"
      },
      "prompt_template": "Review each of these PRs. For each PR, provide:\n1. Summary of changes\n2. Risk level (low/medium/high)\n3. Recommended action (approve/request-changes/needs-discussion)\n\nPRs:\n{{items}}",
      "reduce": {
        "strategy": "hierarchical",
        "prompt": "Compile these PR reviews into a prioritized report. Group by risk level. Highlight PRs that need immediate attention."
      },
      "progress_interval": 10
    }
  }
}
```

### 2. Trigger the Swarm

In any channel:
```
@pr-reviewer review PRs in owner/repo
```

Or from CLI:
```bash
tinyclaw swarm run pr-reviewer "review PRs in owner/repo"
```

### 3. Monitor Progress

The swarm sends periodic progress updates to your channel:
```
PR Reviewer: Processing 3000 items in 120 batches (25 per batch, 10 workers)...
PR Reviewer progress: 30/120 batches (25%)
PR Reviewer progress: 60/120 batches (50%) | ~12m 30s remaining
PR Reviewer progress: 90/120 batches (75%) | ~6m remaining
PR Reviewer completed in 24m 15s
Items: 3000 | Batches: 120 (118 ok, 2 failed) | Workers: 10
```

## Configuration Reference

### SwarmConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Display name for the swarm |
| `agent` | string | required | Agent ID to use as worker (must exist in `agents`) |
| `concurrency` | number | 5 | Max parallel workers |
| `batch_size` | number | 25 | Items per batch |
| `input` | object | — | How to obtain input items |
| `input.command` | string | — | Shell command to generate items |
| `input.type` | string | `"lines"` | Parse output as `"lines"` or `"json_array"` |
| `prompt_template` | string | required | Prompt sent to each worker with batch items |
| `reduce` | object | — | How to aggregate results |
| `reduce.strategy` | string | `"concatenate"` | `"concatenate"`, `"summarize"`, or `"hierarchical"` |
| `reduce.prompt` | string | — | Custom prompt for summarize/hierarchical reduction |
| `reduce.agent` | string | — | Agent ID for reduction (defaults to swarm agent) |
| `shuffle` | object | — | Optional shuffle phase for cross-referencing tasks |
| `shuffle.key_field` | string | required | JSON field to partition by (e.g., `"tags"`, `"key_files"`) |
| `shuffle.multi_key` | string | `"duplicate"` | For array keys: `"duplicate"` puts item in all partitions, `"first"` uses first key only |
| `shuffle.max_partition_size` | number | 200 | Split oversized partitions into sub-partitions |
| `shuffle.reduce_prompt` | string | — | Prompt for each partition (supports `{{partition_key}}`, `{{items}}`, `{{item_count}}`) |
| `shuffle.merge_prompt` | string | — | Prompt for final merge of partition results |
| `progress_interval` | number | 10 | Send progress updates every N batches (0 = none) |

### Prompt Template Placeholders

| Placeholder | Description |
|------------|-------------|
| `{{items}}` | Batch items (one per line) |
| `{{items_json}}` | Batch items as JSON array |
| `{{batch_number}}` | 1-based batch number |
| `{{batch_index}}` | 0-based batch index |
| `{{total_batches}}` | Total number of batches |
| `{{batch_size}}` | Number of items in this batch |
| `{{user_message}}` | The user's original message |

### Input Command Placeholders

The input command supports `{{param}}` placeholders that are resolved from the user's message:

| Placeholder | Resolution |
|------------|------------|
| `{{repo}}` | Extracted from `owner/name` pattern in message |
| `{{limit}}` | Extracted from numeric values in message |
| `key=value` | Explicit key=value pairs in message |

## Input Sources

Swarms accept input items from multiple sources (in priority order):

### 1. Inline JSON Array
```
@pr-reviewer review these: ["PR #1: fix auth", "PR #2: add tests", "PR #3: refactor"]
```

### 2. Attached File
Send a file with items (one per line or JSON array) alongside the message.

### 3. Shell Command (from config)
The `input.command` runs automatically:
```json
{
  "input": {
    "command": "gh pr list --repo {{repo}} --json number,title,url",
    "type": "json_array"
  }
}
```

### 4. Inline Command (backtick)
```
@pr-reviewer review PRs from `gh pr list --repo owner/repo --limit 100 --json number,title`
```

## When to Use Shuffle

| Task Type | Needs Shuffle? | Why |
|-----------|---------------|-----|
| **Summarize** all PRs | No | Each batch summary is independent |
| **Find duplicates** across PRs | **Yes** | Duplicates may be in different batches |
| **Rank/sort** all items | No | Reduce can merge pre-sorted batch results |
| **Find conflicts** between items | **Yes** | Conflicting items may be in different batches |
| **Aggregate counts** (e.g., PRs by author) | No | Counts from each batch can be summed |
| **Find patterns** across items | **Yes** | Patterns require seeing related items together |
| **Classify** each item independently | No | Each item classified on its own |

**Rule of thumb:** If the task requires comparing items against each other (not just processing each independently), you need shuffle.

## Reduce Strategies

### Concatenate (default)
Simply joins all batch results with separators. Best for when you need raw, unprocessed results.

### Summarize
Feeds all batch results to an agent for a single summarization pass. Works well up to ~150k estimated tokens of combined results. Falls back to hierarchical if results are too large.

### Hierarchical
Tree reduction for very large outputs:
1. Groups batch results into chunks of 20
2. Summarizes each chunk using the reduce agent
3. Recursively reduces until a single summary remains

Example with 200 batches:
```
Level 1: 200 results → 10 group summaries
Level 2: 10 summaries → 1 final report
```

## Examples

### PR Duplicate Finder (with shuffle)

This example demonstrates the shuffle phase for cross-batch comparison:

```json
{
  "pr-dedup": {
    "name": "PR Duplicate Finder",
    "agent": "coder",
    "concurrency": 10,
    "batch_size": 50,
    "input": {
      "command": "gh pr list --repo {{repo}} --state open --limit 5000 --json number,title,url,body,headRefName,files,additions,deletions",
      "type": "json_array"
    },
    "prompt_template": "For each PR, extract a structured fingerprint for duplicate detection. Output ONLY a JSON array where each entry has:\n- pr_number (number)\n- title (string)\n- intent (1-sentence summary of what this PR does)\n- key_files (array of primary files changed)\n- tags (3-5 semantic keywords, e.g. 'auth', 'bugfix', 'api', 'refactor')\n\nPRs (batch {{batch_number}}/{{total_batches}}):\n{{items}}",
    "shuffle": {
      "key_field": "tags",
      "multi_key": "duplicate",
      "max_partition_size": 200,
      "reduce_prompt": "Find duplicate and near-duplicate PRs among these {{item_count}} items that share the tag \"{{partition_key}}\".\n\nCompare by: similar intent, overlapping key_files, similar titles.\n\nFor each duplicate pair/group, output:\n- PR numbers involved\n- Why they're duplicates\n- Which to keep (newest, most complete, or most reviewed)\n\nIf no duplicates found, say 'No duplicates in this partition.'\n\n{{items}}",
      "merge_prompt": "Below are duplicate detection results from multiple partitions. Some duplicates may appear in multiple partitions (because PRs share multiple tags). Merge into a single deduplicated report:\n\n## Exact Duplicates\n(PRs doing the same thing)\n\n## Near Duplicates\n(Significant overlap, should consolidate)\n\n## Conflicting PRs\n(Same files, incompatible changes)\n\nFor each group: list PR numbers/titles, explain relationship, recommend action (close/merge/keep)."
    },
    "reduce": {
      "strategy": "summarize"
    }
  }
}
```

**How it works:**
1. **Map**: 10 workers extract compact fingerprints from 50 PRs each (60 batches)
2. **Shuffle**: Fingerprints re-grouped by `tags` — all "auth" PRs together, all "bugfix" PRs together, etc. PRs with multiple tags appear in multiple partitions (`multi_key: "duplicate"`)
3. **Partition Reduce**: Each tag group checked for duplicates independently (parallel)
4. **Final Merge**: Duplicate findings from all partitions merged and deduplicated

### PR Review Swarm
```json
{
  "pr-reviewer": {
    "name": "PR Reviewer",
    "agent": "coder",
    "concurrency": 10,
    "batch_size": 30,
    "input": {
      "command": "gh pr list --repo {{repo}} --state open --limit 5000 --json number,title,url,additions,deletions,changedFiles,labels",
      "type": "json_array"
    },
    "prompt_template": "You are reviewing pull requests. For each PR below, analyze the metadata and provide:\n1. **Summary**: One-line description\n2. **Risk**: low/medium/high based on size and changed files\n3. **Action**: approve/review/discuss\n4. **Priority**: 1-5 (5 = urgent)\n\nPRs (batch {{batch_number}} of {{total_batches}}):\n{{items}}",
    "reduce": {
      "strategy": "hierarchical",
      "prompt": "Create an executive summary of these PR reviews. Include:\n- Total PR counts by risk level\n- Top 10 highest priority PRs that need immediate attention\n- Patterns observed (common issues, areas of codebase with most activity)\n- Recommended review order"
    }
  }
}
```

### Log Analyzer Swarm
```json
{
  "log-analyzer": {
    "name": "Log Analyzer",
    "agent": "analyst",
    "concurrency": 8,
    "batch_size": 100,
    "input": {
      "command": "cat /var/log/app/error.log | tail -10000",
      "type": "lines"
    },
    "prompt_template": "Analyze these error log entries. Group by error type, identify patterns, and flag critical issues.\n\nLog entries:\n{{items}}",
    "reduce": {
      "strategy": "summarize",
      "prompt": "Synthesize these log analysis results into an incident report with: root causes, affected systems, timeline, and recommended fixes."
    }
  }
}
```

### Document Summarizer Swarm
```json
{
  "doc-summarizer": {
    "name": "Document Summarizer",
    "agent": "writer",
    "concurrency": 5,
    "batch_size": 10,
    "prompt_template": "Summarize each of these documents in 2-3 sentences. Preserve key facts and findings.\n\nDocuments:\n{{items}}",
    "reduce": {
      "strategy": "summarize",
      "prompt": "Create a comprehensive literature review from these document summaries. Identify themes, conflicts, and gaps."
    }
  }
}
```

## CLI Commands

```bash
# List all swarms
tinyclaw swarm list

# Add a swarm interactively
tinyclaw swarm add

# Show swarm configuration
tinyclaw swarm show <swarm_id>

# Remove a swarm
tinyclaw swarm remove <swarm_id>

# Trigger a swarm from CLI
tinyclaw swarm run <swarm_id> "<message>"
```

## Limits

| Limit | Value |
|-------|-------|
| Max items per swarm job | 10,000 |
| Max retries per batch | 2 |
| Hierarchical reduce fan-in | 20 |
| Max concurrent workers | Configurable (recommended: 5-20) |

## How It Works with the Queue

Swarms integrate with TinyClaw's existing file-based queue system:

1. A message to `@swarm_id` is detected by the queue processor
2. Instead of invoking a single agent, the swarm processor takes over
3. Each batch invocation uses the configured agent (fresh conversation per batch)
4. Progress updates are written to the outgoing queue as regular messages
5. The final aggregated result is delivered as a response to the original message

Swarm jobs use a dedicated promise chain key (`swarm:id`) so they don't block the underlying agent's regular message processing.
