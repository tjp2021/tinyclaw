## Code Review: PR #55 — Sandboxed Agent Execution

Thanks for this substantial contribution. The overall architecture — three sandbox modes behind a unified `runInSandbox` dispatcher, fail-closed error classification, dead-letter queue, and concurrency permits — is well-structured and thoughtful. Below are the issues I found, organized by severity.

---

### Bugs / Security Issues

**1. Hard-coded UID 1000 in Docker containers (`src/lib/runner.ts:276`)**

```typescript
args.push('--user', '1000:1000');
```

This will cause write failures on any system where the workspace directory is not owned by UID 1000. On macOS with Docker Desktop the default user is often 501. On CI systems it varies. This should be configurable (e.g., a `docker.user` field in `SandboxDockerConfig`) or detected at invocation time via `process.getuid()`.

**2. Unvalidated sandbox mode falls through to Apple runner (`src/lib/runner.ts:369-373`)**

```typescript
export async function runInSandbox(request: InvocationRequest): Promise<InvocationResult> {
    if (request.sandbox.mode === 'host') return runHost(request);
    if (request.sandbox.mode === 'docker') return runContainer(request, 'docker');
    return runContainer(request, 'apple');  // any unrecognized mode silently runs as apple
}
```

If a user typos `"sandbox.mode": "dicker"`, it silently runs in Apple mode (which may not even be installed). Add an explicit validation/default case that throws a terminal `SandboxInvocationError` for unrecognized modes.

**3. API key values passed via `--env` command-line arguments (`src/lib/runner.ts:282-285`)**

```typescript
for (const [key, value] of Object.entries(allowedEnv)) {
    if (typeof value !== 'undefined') {
        args.push('--env', `${key}=${value}`);
    }
}
```

This exposes secrets in `ps aux`, `/proc/*/cmdline`, Docker event logs, etc. Use `--env-file` with a temporary file (mode 0600, deleted after use) or pass env vars through stdin to `docker run`.

**4. Unbounded stdout/stderr buffer accumulation (`src/lib/runner.ts:76-82`)**

```typescript
child.stdout.on('data', (chunk: string) => { stdout += chunk; });
child.stderr.on('data', (chunk: string) => { stderr += chunk; });
```

A misbehaving agent process could produce unbounded output, leading to OOM. Consider capping the buffer (e.g., 10 MB) and truncating after that limit.

---

### Design Issues

**5. `getSandboxConfig` uses falsy-check defaults, breaking valid `0` values (`src/lib/config.ts:138-139`)**

```typescript
timeout_seconds: configured.timeout_seconds || DEFAULT_SANDBOX.timeout_seconds,
max_concurrency: configured.max_concurrency || DEFAULT_SANDBOX.max_concurrency,
```

The `||` operator treats `0` as falsy. If a user sets `"timeout_seconds": 0`, it silently falls back to 600s. Use nullish coalescing (`??`) instead of `||`:

```typescript
timeout_seconds: configured.timeout_seconds ?? DEFAULT_SANDBOX.timeout_seconds,
```

**6. Heartbeat error deduplication cache grows unbounded (`src/queue-processor.ts:78`)**

```typescript
const heartbeatErrorCache = new Map<string, number>();
```

This Map is never pruned. Over time it will leak memory. Add periodic eviction of entries older than `HEARTBEAT_ERROR_DEDUPE_MS`, or use an LRU cache.

**7. Concurrency semaphore waiter queue is unbounded (`src/lib/invoke.ts:16`)**

```typescript
const sandboxWaiters: Array<() => void> = [];
```

If messages arrive faster than containers execute, waiters accumulate without limit. Consider rejecting with a transient error when the waiter queue exceeds a reasonable depth.

**8. Non-zero exit code in host mode always classified as transient (`src/lib/runner.ts:193-201`)**

Host-mode failures always get `classification: 'transient'`, but some host failures (e.g., command not found, invalid args) are clearly terminal. Reuse the `classifyContainerFailure` heuristic here.

---

### Code Quality / Minor

**9. Inconsistent quote style reformatting in `queue-processor.ts`**

The PR reformats the entire imports section from single quotes to double quotes, creating a large diff surface for a purely stylistic change. This makes the actual logic changes harder to review. Style changes should be a separate commit.

**10. `runCommand` removed from `invoke.ts` without migration check**

The old `runCommand` export was removed entirely. Verify there are no other callers.

**11. `parseCodexResponse` silently takes only the last matching message**

```typescript
if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
    response = json.item.text;  // overwrites previous matches
}
```

If Codex emits multiple completed events, only the last is kept. This may be intentional but is worth a comment.

**12. Dockerfile.agent-runner installs no provider CLIs**

`tinyclaw sandbox build-image` builds this image, but `sandbox doctor` will then warn about missing CLIs inside it. The UX gap between "build succeeded" and "doctor reports warnings" will confuse users. Consider either installing CLIs in the base image or having `build-image` print a clear next-step message.

**13. `getSandboxConfig` in TypeScript doesn't validate mode values**

`sandbox_set` in `tinyclaw.sh` validates the three known modes, but the TypeScript `getSandboxConfig` accepts any string. Add runtime validation to match.

---

### Summary

The architecture is sound and the fail-closed / dead-letter design is the right approach. The main issues to address before merge are:

1. **Secret exposure** via `--env` CLI args (security) — issue 3
2. **Hard-coded UID** causing portability failures (bug) — issue 1
3. **Unvalidated sandbox mode** falling through to Apple runner (bug) — issue 2
4. **Unbounded stdout buffer** (reliability) — issue 4

The design issues (5-8) are worth addressing but less urgent. The code quality items (9-13) are minor.
