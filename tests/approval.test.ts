#!/usr/bin/env npx ts-node
/**
 * Approval Gate Tests
 *
 * Tests the dangerous command intercept system:
 * - Pattern detection for all dangerous command variants
 * - Safe commands do NOT trigger
 * - buildConfirmInstruction includes all pattern labels
 * - buildApprovalMessage formats correctly
 * - parseApprovalReply handles all yes/no variants
 *
 * Run: npx ts-node tests/approval.test.ts
 */

import {
    DANGEROUS_PATTERNS,
    buildConfirmInstruction,
    detectConfirmRequired,
    buildApprovalMessage,
    parseApprovalReply,
} from '../src/lib/approval';

const COLORS = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m',
};

let passed = 0;
let failed = 0;

function pass(name: string) {
    passed++;
    console.log(`${COLORS.green}✓${COLORS.reset} ${name}`);
}

function fail(name: string, error?: string) {
    failed++;
    console.log(`${COLORS.red}✗${COLORS.reset} ${name}`);
    if (error) console.log(`  ${COLORS.red}${error}${COLORS.reset}`);
}

function assert(condition: boolean, name: string, error?: string) {
    condition ? pass(name) : fail(name, error);
}

// ============================================================================
// Dangerous pattern detection
// ============================================================================

function testDangerousPatterns() {
    console.log(`\n${COLORS.cyan}## Dangerous Pattern Detection${COLORS.reset}`);

    const dangerousCases: { input: string; label: string }[] = [
        { input: 'I will run: vercel --prod', label: 'vercel deploy' },
        { input: 'Running: eas build --platform ios', label: 'eas build/submit' },
        { input: 'Running: eas submit --platform android', label: 'eas build/submit' },
        { input: 'Executing: git push origin main', label: 'git push' },
        { input: 'Clean up: rm -rf node_modules', label: 'rm -rf' },
        { input: 'Build: npm run build', label: 'npm run build (prod)' },
        { input: 'stripe customers create {}', label: 'stripe write op' },
        { input: 'stripe charges capture ch_123', label: 'stripe write op' },
        { input: 'twilio messages.create({ to: "+1..." })', label: 'twilio send' },
        { input: 'railway up', label: 'railway deploy' },
        { input: 'railway deploy', label: 'railway deploy' },
        { input: 'fly deploy', label: 'fly deploy' },
        { input: 'fly launch', label: 'fly launch' },
    ];

    for (const { input, label } of dangerousCases) {
        const matched = DANGEROUS_PATTERNS.some(p => p.pattern.test(input));
        assert(matched, `detects "${label}": ${input.substring(0, 60)}`);
    }
}

// ============================================================================
// Safe command non-triggering
// ============================================================================

function testSafeCommands() {
    console.log(`\n${COLORS.cyan}## Safe Commands (should NOT trigger)${COLORS.reset}`);

    const safeCases = [
        'ls -la',
        'cat package.json',
        'npm install',
        'npm run dev',
        'git status',
        'git diff HEAD',
        'git log --oneline -10',
        'git add .',
        'git commit -m "fix: bug"',
        'vercel dev',
        'stripe customers list',
        'stripe customers retrieve cus_123',
        'echo hello world',
        'npm run test',
        'npm run lint',
    ];

    for (const input of safeCases) {
        const matched = DANGEROUS_PATTERNS.some(p => p.pattern.test(input));
        assert(!matched, `safe command not flagged: "${input}"`);
    }
}

// ============================================================================
// detectConfirmRequired
// ============================================================================

function testDetectConfirmRequired() {
    console.log(`\n${COLORS.cyan}## detectConfirmRequired()${COLORS.reset}`);

    // Should detect
    const detected = detectConfirmRequired('I need to run [CONFIRM_REQUIRED: deploy to production via vercel] before proceeding.');
    assert(detected !== null, 'detects CONFIRM_REQUIRED token');
    assert(detected === 'deploy to production via vercel', `extracts description: "${detected}"`);

    // Case insensitive
    const detectedLower = detectConfirmRequired('[confirm_required: git push to main]');
    assert(detectedLower !== null, 'case-insensitive detection');

    // Should NOT detect for safe responses
    const notDetected = detectConfirmRequired('I ran npm install and git status looks clean.');
    assert(notDetected === null, 'no false positive for safe response');

    // Empty response
    const empty = detectConfirmRequired('');
    assert(empty === null, 'no detection on empty string');

    // With surrounding text
    const withContext = detectConfirmRequired('Sure, I can help with that!\n\n[CONFIRM_REQUIRED: rm -rf the build directory]\n\nThis will delete all build artifacts.');
    assert(withContext === 'rm -rf the build directory', `extracts from multi-line: "${withContext}"`);
}

// ============================================================================
// buildConfirmInstruction
// ============================================================================

function testBuildConfirmInstruction() {
    console.log(`\n${COLORS.cyan}## buildConfirmInstruction()${COLORS.reset}`);

    const instruction = buildConfirmInstruction();

    assert(instruction.includes('CONFIRM_REQUIRED'), 'instruction includes CONFIRM_REQUIRED token format');
    assert(instruction.includes('[SYSTEM: APPROVAL GATE]'), 'instruction has SYSTEM header');

    // All pattern labels should appear in the instruction
    for (const { label } of DANGEROUS_PATTERNS) {
        assert(instruction.includes(label), `instruction includes label: "${label}"`);
    }
}

// ============================================================================
// buildApprovalMessage
// ============================================================================

function testBuildApprovalMessage() {
    console.log(`\n${COLORS.cyan}## buildApprovalMessage()${COLORS.reset}`);

    const msg = buildApprovalMessage('pepe', 'deploy to production', 'deploy iteachyouai.com');

    assert(msg.includes('@pepe'), 'includes agent id');
    assert(msg.includes('deploy to production'), 'includes description');
    assert(msg.includes('deploy iteachyouai.com'), 'includes original message');
    assert(msg.includes('yes'), 'includes yes instruction');
    assert(msg.includes('no'), 'includes no instruction');

    // Long message truncation
    const longMessage = 'a'.repeat(200);
    const msgLong = buildApprovalMessage('mac-claude', 'git push origin main', longMessage);
    assert(msgLong.includes('...'), 'truncates long original message');
}

// ============================================================================
// parseApprovalReply
// ============================================================================

function testParseApprovalReply() {
    console.log(`\n${COLORS.cyan}## parseApprovalReply()${COLORS.reset}`);

    const approvedInputs = ['yes', 'YES', 'y', 'Y', 'approve', 'approved', 'confirm', 'ok', 'yep', 'yup', 'do it'];
    for (const input of approvedInputs) {
        assert(parseApprovalReply(input) === 'approved', `"${input}" → approved`);
    }

    const deniedInputs = ['no', 'NO', 'n', 'N', 'deny', 'denied', 'cancel', 'abort', 'stop', 'nope'];
    for (const input of deniedInputs) {
        assert(parseApprovalReply(input) === 'denied', `"${input}" → denied`);
    }

    // Neutral/unrelated messages should return null
    const neutralInputs = ['maybe', 'what?', 'hello', 'fix the bug', '@mac do this'];
    for (const input of neutralInputs) {
        assert(parseApprovalReply(input) === null, `"${input}" → null (not approval)`);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log(`${COLORS.cyan}========================================`);
    console.log('  Approval Gate Tests');
    console.log(`========================================${COLORS.reset}`);

    testDangerousPatterns();
    testSafeCommands();
    testDetectConfirmRequired();
    testBuildConfirmInstruction();
    testBuildApprovalMessage();
    testParseApprovalReply();

    console.log(`\n${COLORS.cyan}========================================${COLORS.reset}`);
    console.log(`Results: ${COLORS.green}${passed} passed${COLORS.reset}, ${failed > 0 ? COLORS.red : ''}${failed} failed${COLORS.reset}`);

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
