#!/usr/bin/env npx ts-node
/**
 * Queue Processor Unit Tests
 *
 * Tests the core logic that was broken and caused real pain:
 *   - splitIntoChunks: messages being cut off or mangled on Telegram
 *   - buildHistoryPrefix: conversation context lost between messages
 *   - addToHistory / getHistory: history storage, trimming, char cap
 *   - collectFiles: [send_file: ...] extraction
 *
 * Run: npx ts-node tests/queue.test.ts
 */

import {
    splitIntoChunks,
    buildHistoryPrefix,
    addToHistory,
    getHistory,
    collectFiles,
    TELEGRAM_MAX_CHARS,
    MAX_HISTORY_ENTRIES,
    MAX_HISTORY_CHARS,
    MAX_ENTRY_CHARS,
    HistoryEntry,
} from '../src/lib/queue-utils';
import fs from 'fs';
import os from 'os';
import path from 'path';

const COLORS = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m',
};

let passed = 0;
let failed = 0;

function pass(name: string): void {
    passed++;
    console.log(`${COLORS.green}✓${COLORS.reset} ${name}`);
}

function fail(name: string, error?: string): void {
    failed++;
    console.log(`${COLORS.red}✗${COLORS.reset} ${name}`);
    if (error) console.log(`  ${COLORS.red}${error}${COLORS.reset}`);
}

function assert(condition: boolean, name: string, error?: string): void {
    condition ? pass(name) : fail(name, error);
}

function assertEqual<T>(actual: T, expected: T, name: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    ok ? pass(name) : fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ============================================================================
// splitIntoChunks
// ============================================================================

function testSplitIntoChunks(): void {
    console.log(`\n${COLORS.cyan}## splitIntoChunks${COLORS.reset}`);

    // Short message → single chunk, no split
    const short = 'Hello world';
    const r1 = splitIntoChunks(short);
    assertEqual(r1.length, 1, 'short message returns 1 chunk');
    assertEqual(r1[0], short, 'short message content unchanged');

    // Exactly at the limit → single chunk
    const exact = 'x'.repeat(TELEGRAM_MAX_CHARS);
    const r2 = splitIntoChunks(exact);
    assertEqual(r2.length, 1, 'exactly-limit message returns 1 chunk');

    // Over limit — splits into 2
    const over = 'x'.repeat(TELEGRAM_MAX_CHARS + 1);
    const r3 = splitIntoChunks(over);
    assert(r3.length >= 2, 'over-limit message splits into at least 2 chunks');
    for (const chunk of r3) {
        assert(chunk.length <= TELEGRAM_MAX_CHARS, `chunk is within limit (len=${chunk.length})`);
    }

    // Respects paragraph boundaries (\n\n) over hard cut
    const para1 = 'A'.repeat(2000);
    const para2 = 'B'.repeat(2000);
    const withPara = para1 + '\n\n' + para2;  // 4002 chars — just over limit
    const r4 = splitIntoChunks(withPara);
    assert(r4.length >= 2, 'paragraph text splits into multiple chunks');
    assert(r4[0]!.endsWith('A'), 'first chunk ends at paragraph boundary (all A)');
    assert(r4[1]!.startsWith('B'), 'second chunk starts after paragraph break');

    // Respects line boundaries (\n) when no paragraph break available
    const line1 = 'L'.repeat(2500);
    const line2 = 'M'.repeat(2000);
    const withLine = line1 + '\n' + line2;  // 4501 chars — over limit
    const r5 = splitIntoChunks(withLine);
    assert(r5.length >= 2, 'line-separated text splits into multiple chunks');
    assert(r5[0]!.includes('L'), 'first chunk contains line1 content');
    assert(r5[1]!.includes('M'), 'second chunk contains line2 content');

    // No natural break — force-cuts at limit
    const noBreaks = 'Z'.repeat(TELEGRAM_MAX_CHARS * 2 + 100);
    const r6 = splitIntoChunks(noBreaks);
    assert(r6.length >= 2, 'no-break long text force-splits');
    for (const chunk of r6) {
        assert(chunk.length <= TELEGRAM_MAX_CHARS, `force-split chunk within limit (len=${chunk.length})`);
    }

    // Reconstructing all chunks gives back the original content (no data loss)
    const original = 'P'.repeat(1500) + '\n\n' + 'Q'.repeat(1500) + '\n\n' + 'R'.repeat(1500);
    const r7 = splitIntoChunks(original);
    const reconstructed = r7.join('\n\n');  // join back at paragraph breaks
    assert(reconstructed.includes('P'.repeat(100)), 'reconstructed content has first paragraph');
    assert(reconstructed.includes('R'.repeat(100)), 'reconstructed content has last paragraph');

    // Custom maxChars parameter
    const r8 = splitIntoChunks('Hello\n\nWorld', 8);
    assert(r8.length >= 2, 'custom maxChars respected');
}

// ============================================================================
// buildHistoryPrefix
// ============================================================================

function testBuildHistoryPrefix(): void {
    console.log(`\n${COLORS.cyan}## buildHistoryPrefix${COLORS.reset}`);

    // Empty history → empty string
    const r1 = buildHistoryPrefix([]);
    assertEqual(r1, '', 'empty history returns empty string');

    // Single user entry
    const single: HistoryEntry[] = [{ role: 'user', content: 'hello' }];
    const r2 = buildHistoryPrefix(single);
    assert(r2.includes('[RECENT CONVERSATION HISTORY]'), 'includes header');
    assert(r2.includes('[END HISTORY]'), 'includes footer');
    assert(r2.includes('Tim: hello'), 'user role shown as "Tim"');

    // Assistant role shown as "Assistant"
    const assistant: HistoryEntry[] = [{ role: 'assistant', content: 'world' }];
    const r3 = buildHistoryPrefix(assistant);
    assert(r3.includes('Assistant: world'), 'assistant role shown as "Assistant"');

    // Multiple entries, correct ordering
    const multi: HistoryEntry[] = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
    ];
    const r4 = buildHistoryPrefix(multi);
    const firstIdx = r4.indexOf('Tim: first');
    const secondIdx = r4.indexOf('Assistant: second');
    const thirdIdx = r4.indexOf('Tim: third');
    assert(firstIdx < secondIdx, 'entries in correct chronological order (first before second)');
    assert(secondIdx < thirdIdx, 'entries in correct chronological order (second before third)');

    // Char limit — old entries excluded when total exceeds maxChars
    // Build history that exceeds limit when combined
    const bigEntry = 'X'.repeat(4000);
    const oldEntry: HistoryEntry = { role: 'user', content: 'old small entry' };
    const bigHistory: HistoryEntry[] = [
        oldEntry,  // oldest — should get dropped
        { role: 'user', content: bigEntry },
        { role: 'assistant', content: bigEntry },
    ];
    const r5 = buildHistoryPrefix(bigHistory, 6000);
    assert(!r5.includes('old small entry'), 'old entry excluded when over char limit');
    assert(r5.includes('X'.repeat(100)), 'recent large entries still included');

    // Always includes most recent entry even if it alone approaches limit
    const hugeRecent: HistoryEntry[] = [{ role: 'user', content: 'Y'.repeat(5000) }];
    const r6 = buildHistoryPrefix(hugeRecent, 6000);
    assert(r6.includes('Y'.repeat(100)), 'most recent entry always included');
}

// ============================================================================
// addToHistory + getHistory
// ============================================================================

function testHistory(): void {
    console.log(`\n${COLORS.cyan}## addToHistory + getHistory${COLORS.reset}`);

    const map = new Map<string, HistoryEntry[]>();

    // Empty history
    const empty = getHistory(map, 'user1', 'agent1');
    assertEqual(empty.length, 0, 'empty history returns empty array');

    // Add one entry
    addToHistory(map, 'user1', 'agent1', 'user', 'hello');
    const h1 = getHistory(map, 'user1', 'agent1');
    assertEqual(h1.length, 1, 'one entry after one add');
    assertEqual(h1[0]!.role, 'user', 'role preserved');
    assertEqual(h1[0]!.content, 'hello', 'content preserved');

    // Different sender+agent is isolated
    const h2 = getHistory(map, 'user2', 'agent1');
    assertEqual(h2.length, 0, 'different sender has independent history');

    // Fills to MAX_HISTORY_ENTRIES
    const map2 = new Map<string, HistoryEntry[]>();
    for (let i = 0; i < MAX_HISTORY_ENTRIES; i++) {
        addToHistory(map2, 'u', 'a', 'user', `msg${i}`);
    }
    const h3 = getHistory(map2, 'u', 'a');
    assertEqual(h3.length, MAX_HISTORY_ENTRIES, `exactly ${MAX_HISTORY_ENTRIES} entries at cap`);

    // Adding one more trims oldest
    addToHistory(map2, 'u', 'a', 'user', 'newest');
    const h4 = getHistory(map2, 'u', 'a');
    assertEqual(h4.length, MAX_HISTORY_ENTRIES, 'still at cap after overflow');
    assert(!h4.some(e => e.content === 'msg0'), 'oldest entry (msg0) was trimmed');
    assertEqual(h4[h4.length - 1]!.content, 'newest', 'newest entry is last');

    // Per-entry content cap at MAX_ENTRY_CHARS
    const map3 = new Map<string, HistoryEntry[]>();
    const huge = 'Z'.repeat(MAX_ENTRY_CHARS + 500);
    addToHistory(map3, 'u', 'a', 'user', huge);
    const h5 = getHistory(map3, 'u', 'a');
    assertEqual(h5[0]!.content.length, MAX_ENTRY_CHARS, `entry capped at ${MAX_ENTRY_CHARS} chars`);

    // Alternating user/assistant entries
    const map4 = new Map<string, HistoryEntry[]>();
    addToHistory(map4, 'u', 'a', 'user', 'question');
    addToHistory(map4, 'u', 'a', 'assistant', 'answer');
    const h6 = getHistory(map4, 'u', 'a');
    assertEqual(h6[0]!.role, 'user', 'user entry first');
    assertEqual(h6[1]!.role, 'assistant', 'assistant entry second');
}

// ============================================================================
// collectFiles
// ============================================================================

function testCollectFiles(): void {
    console.log(`\n${COLORS.cyan}## collectFiles${COLORS.reset}`);

    // Mock existsCheck so we don't need real files
    const exists = (p: string) => ['/real/file.txt', '/real/photo.jpg'].includes(p);

    // Extracts [send_file: ...] references
    const set1 = new Set<string>();
    collectFiles('Here is [send_file: /real/file.txt] for you', set1, exists);
    assert(set1.has('/real/file.txt'), 'extracts real file path');

    // Ignores nonexistent files
    const set2 = new Set<string>();
    collectFiles('[send_file: /fake/missing.txt]', set2, exists);
    assert(!set2.has('/fake/missing.txt'), 'ignores nonexistent file');

    // Multiple files in one response
    const set3 = new Set<string>();
    collectFiles('[send_file: /real/file.txt] and [send_file: /real/photo.jpg]', set3, exists);
    assertEqual(set3.size, 2, 'extracts multiple files');
    assert(set3.has('/real/file.txt'), 'first file extracted');
    assert(set3.has('/real/photo.jpg'), 'second file extracted');

    // No [send_file:] → empty set
    const set4 = new Set<string>();
    collectFiles('Normal response with no file references', set4, exists);
    assertEqual(set4.size, 0, 'no files extracted from normal response');

    // Handles whitespace around path
    const set5 = new Set<string>();
    collectFiles('[send_file:  /real/file.txt  ]', set5, exists);
    assert(set5.has('/real/file.txt'), 'trims whitespace around path');

    // Deduplicates same file mentioned twice
    const set6 = new Set<string>();
    collectFiles('[send_file: /real/file.txt] [send_file: /real/file.txt]', set6, exists);
    assertEqual(set6.size, 1, 'deduplicates same file');
}

// ============================================================================
// Integration: history flows through prefix correctly
// ============================================================================

function testHistoryIntegration(): void {
    console.log(`\n${COLORS.cyan}## History → Prefix integration${COLORS.reset}`);

    const map = new Map<string, HistoryEntry[]>();

    // Simulate 3 exchanges
    addToHistory(map, 'tim', 'mac-claude', 'user', 'fix the auth bug');
    addToHistory(map, 'tim', 'mac-claude', 'assistant', 'I found the bug in auth.ts line 42');
    addToHistory(map, 'tim', 'mac-claude', 'user', 'now deploy it');

    const prefix = buildHistoryPrefix(getHistory(map, 'tim', 'mac-claude'));

    assert(prefix.includes('[RECENT CONVERSATION HISTORY]'), 'has history header');
    assert(prefix.includes('Tim: fix the auth bug'), 'first user message in prefix');
    assert(prefix.includes('Assistant: I found the bug'), 'assistant response in prefix');
    assert(prefix.includes('Tim: now deploy it'), 'latest user message in prefix');
    assert(prefix.includes('[END HISTORY]'), 'has history footer');
    assert(prefix.endsWith('\n\n'), 'ends with double newline for message separation');

    // Verify order: oldest first, newest last
    const firstMsg = prefix.indexOf('fix the auth bug');
    const deployMsg = prefix.indexOf('now deploy it');
    assert(firstMsg < deployMsg, 'older messages appear before newer messages');
}

// ============================================================================
// Run all
// ============================================================================

console.log(`${COLORS.cyan}========================================`);
console.log(`  Queue Processor Unit Tests`);
console.log(`========================================${COLORS.reset}`);

testSplitIntoChunks();
testBuildHistoryPrefix();
testHistory();
testCollectFiles();
testHistoryIntegration();

console.log(`\n${COLORS.cyan}========================================${COLORS.reset}`);
if (failed === 0) {
    console.log(`Results: ${COLORS.green}${passed} passed${COLORS.reset}, ${failed} failed`);
} else {
    console.log(`Results: ${COLORS.green}${passed} passed${COLORS.reset}, ${COLORS.red}${failed} failed${COLORS.reset}`);
    process.exit(1);
}
