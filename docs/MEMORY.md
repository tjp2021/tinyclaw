# TinyClaw Memory System

A file-based memory and learning system that lets agents remember things across sessions, reflect on failures, accumulate knowledge, and improve over time.

## Design Philosophy

- **File-based, not database-based** — Markdown and JSONL files the agent reads/writes itself
- **Agent-managed memory** — The agent decides what to remember (via CLAUDE.md instructions), not a separate system
- **Minimal framework changes** — Hooks into existing extension points
- **Three tiers**: Core memory (always loaded), Recall memory (searchable), Archive (overflow)

## Directory Structure

Each agent's working directory contains:

```
{agent_working_dir}/
├── memory/
│   ├── knowledge.md       ← CORE: Always injected into context
│   ├── reflections.jsonl  ← RECALL: Structured failure/success reflections
│   ├── episodes.jsonl     ← RECALL: Compressed conversation summaries
│   └── skills/            ← ARCHIVE: Learned procedures/recipes
│       └── index.json     ← Skill manifest with descriptions
```

## Components

### 1. Core Memory (knowledge.md)

A single markdown file the agent reads at every invocation and updates itself.

**File**: `memory/knowledge.md`

**How it works**:
- Before each invocation, `invokeAgent()` reads `knowledge.md`
- Content is prepended to the message as context under `## Knowledge`
- Agent updates this file directly using file write tools
- Should stay small (< 200 lines) — agent consolidates/prunes as needed

**Example content**:
```markdown
# Knowledge

- Tim prefers concise responses
- The droplet IP is 165.22.11.9
- Always use --dangerously-skip-permissions for agent invocations
```

### 2. Reflection Loop (reflections.jsonl)

Structured records of what worked and what didn't.

**File**: `memory/reflections.jsonl`

**Format** (one JSON object per line):
```json
{"ts":"2026-02-12T10:30:00Z","type":"failure","context":"user asked about X","lesson":"Y doesn't work because Z","action":"Use W instead"}
{"ts":"2026-02-12T11:45:00Z","type":"success","context":"user asked about X","lesson":"Approach Y worked well","action":"Remember to use Y for similar tasks"}
```

**How it works**:
- Agent writes reflections as part of normal tool use
- On invocation, the last 10 reflections are loaded and included in context under `## Recent Reflections`
- Creates a feedback loop: fail → reflect → remember → improve

**Fields**:
| Field | Description |
|-------|-------------|
| `ts` | ISO timestamp |
| `type` | `failure`, `success`, or `insight` |
| `context` | What the user asked or what was happening |
| `lesson` | What was learned |
| `action` | What to do differently (optional) |

### 3. Episode Memory (episodes.jsonl)

Compressed summaries of past conversations for long-term recall.

**File**: `memory/episodes.jsonl`

**Format**:
```json
{"ts":"2026-02-12T10:30:00Z","user":"tim","summary":"Debugged queue jamming. Root cause: no timeout on runCommand(). Fixed with 5min timeout.","tags":["tinyclaw","debugging","queue"],"outcome":"resolved"}
```

**How it works**:
- After each conversation completes, `captureEpisode()` generates a summary
- Summary is created using claude-haiku-4-5 (lightweight, fast)
- Runs in the background — does not block response delivery
- On next invocation, episodes are keyword-matched against the incoming message
- Top 3 relevant episodes are included in context under `## Relevant Past Conversations`

**Fields**:
| Field | Description |
|-------|-------------|
| `ts` | ISO timestamp |
| `user` | Who sent the message |
| `summary` | 1-2 sentence conversation summary |
| `tags` | 3-5 keyword tags for matching |
| `outcome` | `resolved`, `unresolved`, or `informational` |

### 4. Skill Library (memory/skills/)

Learned procedures the agent can retrieve and reuse.

**Files**:
```
memory/skills/
├── index.json           ← Skill descriptions for matching
├── fix-queue-jam.md     ← Step-by-step procedure
└── deploy-to-droplet.md ← Step-by-step procedure
```

**index.json format**:
```json
{
  "fix-queue-jam": "Steps to diagnose and fix TinyClaw queue jams",
  "deploy-to-droplet": "How to deploy TinyClaw to the production droplet"
}
```

**How it works**:
- Agent creates skill files as markdown + updates index.json
- On invocation, skill descriptions are keyword-matched against incoming message
- Relevant skill files are read and included in context under `## Relevant Skills`

## Source Files

| File | Purpose |
|------|---------|
| `src/lib/invoke.ts` | `loadMemoryContext()` — reads all memory files and injects into context |
| `src/lib/agent-setup.ts` | `ensureAgentDirectory()` — creates memory directory structure on agent init |
| `src/queue-processor.ts` | `captureEpisode()` — generates and saves episode summaries after conversations |

## Context Injection

Memory context is prepended to the user message in this format:

```
[MEMORY]
## Knowledge
{contents of knowledge.md}

## Recent Reflections
- [failure] user asked about X: Y doesn't work because Z → Use W instead
- [success] user asked about Y: Approach worked well

## Relevant Past Conversations
- [resolved] Debugged queue jamming issue (tinyclaw, debugging, queue)

## Relevant Skills
### fix-queue-jam
{contents of fix-queue-jam.md}
[/MEMORY]

{actual user message}
```

## Agent Instructions

For agents to use the memory system, add these instructions to their CLAUDE.md:

```markdown
## Memory Management

You have a persistent memory system in the `memory/` directory:

1. **knowledge.md** — Key facts, user preferences, lessons learned. Update this after important conversations. Keep it under 200 lines by consolidating related items.

2. **reflections.jsonl** — When you encounter an error or learn something new, append a reflection:
   ```json
   {"ts":"2026-...","type":"failure|success|insight","context":"...","lesson":"...","action":"..."}
   ```

3. **skills/** — When you solve a complex task, save the procedure as a markdown file and update index.json.

Your memory files are loaded automatically at the start of each conversation.
```

## Initialization

Memory directories are created automatically when an agent directory is initialized via `ensureAgentDirectory()`. The initial structure includes:

- `memory/knowledge.md` — Seeded with placeholder text
- `memory/reflections.jsonl` — Empty file
- `memory/episodes.jsonl` — Empty file
- `memory/skills/index.json` — Empty JSON object `{}`

## Testing

Run the test suite:

```bash
# Unit tests (fast, no Claude invocation)
npm test

# Live integration tests (invokes Claude, slower)
npm run test:live

# All tests
npm run test:all
```

### Unit Tests (`tests/memory.test.ts`)

Tests memory loading logic without invoking Claude:
- Directory creation
- Knowledge loading (including placeholder detection)
- Reflections parsing
- Episodes keyword matching
- Skills matching
- Full context injection

### Live Tests (`tests/memory-live.test.ts`)

Actually invokes Claude to test end-to-end:
- Ask agent to remember a fact → verify knowledge.md updated
- New session with memory injection → verify recall works
- Reflection capture

## Performance Notes

- Episode capture uses claude-haiku-4-5 for fast, cheap summarization
- Episode capture is fire-and-forget (non-blocking)
- Keyword matching is simple substring matching (no embeddings)
- Only top 3 relevant episodes/skills are loaded to limit context size
- Knowledge.md should be kept under 200 lines by the agent
