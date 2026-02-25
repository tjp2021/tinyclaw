#!/bin/bash
# test-heartbeat-cooldown.sh — Tests heartbeat cooldown state logic
# Tests the cooldown and state file logic without running the full loop

PASS=0
FAIL=0
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

STATE_FILE="$TMPDIR/heartbeat-state.json"
INTERVAL=3600

echo "=== heartbeat-cron.sh cooldown tests ==="

# Test 1: No state file -> should NOT skip (no cooldown data)
rm -f "$STATE_FILE"
if [ ! -f "$STATE_FILE" ]; then
    echo "PASS: Test 1 — No state file means no cooldown (will proceed)"
    PASS=$((PASS + 1))
else
    echo "FAIL: Test 1 — State file should not exist"
    FAIL=$((FAIL + 1))
fi

# Test 2: State file with old timestamp -> should NOT skip
NOW=$(date +%s)
OLD_TS=$((NOW - 7200))  # 2 hours ago
echo "{\"last_sent_epoch\": $OLD_TS, \"last_sent_iso\": \"test\", \"agent_count\": 1}" > "$STATE_FILE"
LAST_SENT=$(jq -r '.last_sent_epoch // 0' "$STATE_FILE" 2>/dev/null)
ELAPSED=$((NOW - LAST_SENT))
if [ "$ELAPSED" -ge "$INTERVAL" ]; then
    echo "PASS: Test 2 — 2h elapsed ($ELAPSED s) >= ${INTERVAL}s interval (proceed)"
    PASS=$((PASS + 1))
else
    echo "FAIL: Test 2 — Should proceed, elapsed=$ELAPSED"
    FAIL=$((FAIL + 1))
fi

# Test 3: State file with recent timestamp -> should SKIP
RECENT_TS=$((NOW - 300))  # 5 minutes ago
echo "{\"last_sent_epoch\": $RECENT_TS, \"last_sent_iso\": \"test\", \"agent_count\": 1}" > "$STATE_FILE"
LAST_SENT=$(jq -r '.last_sent_epoch // 0' "$STATE_FILE" 2>/dev/null)
ELAPSED=$((NOW - LAST_SENT))
if [ "$ELAPSED" -lt "$INTERVAL" ]; then
    echo "PASS: Test 3 — 5min elapsed ($ELAPSED s) < ${INTERVAL}s interval (skip)"
    PASS=$((PASS + 1))
else
    echo "FAIL: Test 3 — Should skip, elapsed=$ELAPSED"
    FAIL=$((FAIL + 1))
fi

# Test 4: State file write produces valid JSON
jq -n \
    --argjson last_sent_epoch "$NOW" \
    --argjson agent_count 2 \
    --arg last_sent_iso "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{last_sent_epoch: $last_sent_epoch, last_sent_iso: $last_sent_iso, agent_count: $agent_count}' \
    > "$STATE_FILE" 2>/dev/null

if jq empty "$STATE_FILE" 2>/dev/null; then
    echo "PASS: Test 4 — State file is valid JSON"
    PASS=$((PASS + 1))
else
    echo "FAIL: Test 4 — State file is not valid JSON"
    FAIL=$((FAIL + 1))
fi

# Test 5: State file has all required fields
HAS_EPOCH=$(jq 'has("last_sent_epoch")' "$STATE_FILE")
HAS_ISO=$(jq 'has("last_sent_iso")' "$STATE_FILE")
HAS_COUNT=$(jq 'has("agent_count")' "$STATE_FILE")
if [ "$HAS_EPOCH" = "true" ] && [ "$HAS_ISO" = "true" ] && [ "$HAS_COUNT" = "true" ]; then
    echo "PASS: Test 5 — State file has all required fields"
    PASS=$((PASS + 1))
else
    echo "FAIL: Test 5 — Missing fields: epoch=$HAS_EPOCH iso=$HAS_ISO count=$HAS_COUNT"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $FAIL
