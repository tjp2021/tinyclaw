#!/usr/bin/env npx ts-node
/**
 * Routing Tests — including alias resolution
 *
 * Tests parseAgentRouting() with:
 * - Agent ID match
 * - Agent name match
 * - Alias match (new)
 * - Team ID match
 * - Default fallback
 *
 * Run: npx ts-node tests/routing.test.ts
 */

import { parseAgentRouting } from '../src/lib/routing';
import { AgentConfig, TeamConfig } from '../src/lib/types';

const COLORS = {
    green: '\x1b[32m',
    red: '\x1b[31m',
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
    console.log(`\x1b[31m✗\x1b[0m ${name}`);
    if (error) console.log(`  \x1b[31m${error}\x1b[0m`);
}

function assert(condition: boolean, name: string, error?: string) {
    condition ? pass(name) : fail(name, error);
}

// ============================================================================
// Test fixture
// ============================================================================

const agents: Record<string, AgentConfig> = {
    'pepe': {
        name: 'Pepe',
        provider: 'anthropic',
        model: 'opus',
        working_directory: 'pepe',
        aliases: [],
    },
    'mac-claude': {
        name: 'Mac Daddy',
        provider: 'mac',
        model: 'claude-opus-4-6',
        working_directory: 'mac-claude',
        aliases: ['mac', 'macdaddy', 'mac-daddy', 'laptop', 'macbook', 'code', 'coder'],
        description: 'Heavy coding via MacBook Claude Code',
    },
    'researcher': {
        name: 'Researcher',
        provider: 'anthropic',
        model: 'sonnet',
        working_directory: 'researcher',
    },
};

const teams: Record<string, TeamConfig> = {
    'dev-team': {
        name: 'Dev Team',
        agents: ['pepe', 'researcher'],
        leader_agent: 'pepe',
    },
};

// ============================================================================
// Tests
// ============================================================================

function testAgentIdMatch() {
    console.log(`\n${COLORS.cyan}## Agent ID match${COLORS.reset}`);

    const result = parseAgentRouting('@pepe fix the bug', agents, teams);
    assert(result.agentId === 'pepe', 'routes @pepe by ID');
    assert(result.message === 'fix the bug', 'strips @pepe prefix');

    const result2 = parseAgentRouting('@mac-claude build the feature', agents, teams);
    assert(result2.agentId === 'mac-claude', 'routes @mac-claude by ID');
    assert(result2.message === 'build the feature', 'strips @mac-claude prefix');
}

function testAgentNameMatch() {
    console.log(`\n${COLORS.cyan}## Agent name match${COLORS.reset}`);

    const result = parseAgentRouting('@researcher look this up', agents, teams);
    assert(result.agentId === 'researcher', 'routes @researcher by ID');

    // "@mac" is an alias for mac-claude, so "@mac daddy build this" routes to mac-claude
    // with message "daddy build this" — alias takes precedence over "name not found"
    const result2 = parseAgentRouting('@mac daddy build this', agents, teams);
    assert(result2.agentId === 'mac-claude', '@mac (alias) → mac-claude even with trailing words');
    assert(result2.message === 'daddy build this', 'message is everything after @mac');
}

function testAliasMatch() {
    console.log(`\n${COLORS.cyan}## Alias match (mac-claude)${COLORS.reset}`);

    const aliases = ['mac', 'macdaddy', 'mac-daddy', 'laptop', 'macbook', 'code', 'coder'];
    for (const alias of aliases) {
        const result = parseAgentRouting(`@${alias} fix the auth bug`, agents, teams);
        assert(
            result.agentId === 'mac-claude',
            `@${alias} → mac-claude`,
            `got agentId="${result.agentId}" instead of "mac-claude"`
        );
        assert(
            result.message === 'fix the auth bug',
            `@${alias} strips prefix correctly`
        );
    }

    // Case insensitive
    const resultUpper = parseAgentRouting('@MAC fix this', agents, teams);
    assert(resultUpper.agentId === 'mac-claude', '@MAC (uppercase) → mac-claude');

    const resultMixed = parseAgentRouting('@MacBook check the logs', agents, teams);
    assert(resultMixed.agentId === 'mac-claude', '@MacBook (mixed case) → mac-claude');
}

function testTeamMatch() {
    console.log(`\n${COLORS.cyan}## Team match${COLORS.reset}`);

    const result = parseAgentRouting('@dev-team work on this together', agents, teams);
    assert(result.agentId === 'pepe', '@dev-team routes to leader (pepe)');
    assert(result.isTeam === true, '@dev-team sets isTeam=true');
    assert(result.message === 'work on this together', '@dev-team strips prefix');
}

function testDefaultFallback() {
    console.log(`\n${COLORS.cyan}## Default fallback${COLORS.reset}`);

    const result = parseAgentRouting('just a normal message', agents, teams);
    assert(result.agentId === 'default', 'unrouted → default');
    assert(result.message === 'just a normal message', 'message preserved');

    const result2 = parseAgentRouting('@nonexistent do something', agents, teams);
    assert(result2.agentId === 'default', '@nonexistent → default');
}

function testMultilineMessages() {
    console.log(`\n${COLORS.cyan}## Multiline messages${COLORS.reset}`);

    const result = parseAgentRouting('@mac fix the bug\nhere are the details:\n- line 1\n- line 2', agents, teams);
    assert(result.agentId === 'mac-claude', 'routes @mac with multiline message');
    assert(result.message.includes('here are the details'), 'preserves multiline content');
}

function testNoAtSign() {
    console.log(`\n${COLORS.cyan}## No @ sign required${COLORS.reset}`);

    // Agent ID without @
    const r1 = parseAgentRouting('pepe what is up', agents, teams);
    assert(r1.agentId === 'pepe', 'pepe (no @) → pepe');
    assert(r1.message === 'what is up', 'strips bare agent prefix');

    // Alias without @
    const r2 = parseAgentRouting('mac fix this bug', agents, teams);
    assert(r2.agentId === 'mac-claude', 'mac (no @) → mac-claude');
    assert(r2.message === 'fix this bug', 'strips bare alias prefix');

    const r3 = parseAgentRouting('laptop check the logs', agents, teams);
    assert(r3.agentId === 'mac-claude', 'laptop (no @) → mac-claude');

    const r4 = parseAgentRouting('coder write a test', agents, teams);
    assert(r4.agentId === 'mac-claude', 'coder (no @) → mac-claude');

    const r5 = parseAgentRouting('macbook what files are here', agents, teams);
    assert(r5.agentId === 'mac-claude', 'macbook (no @) → mac-claude');

    // Case-insensitive without @
    const r6 = parseAgentRouting('MAC fix this', agents, teams);
    assert(r6.agentId === 'mac-claude', 'MAC (uppercase, no @) → mac-claude');

    // Unrecognized first word still falls to default
    const r7 = parseAgentRouting('just a normal message', agents, teams);
    assert(r7.agentId === 'default', 'unknown first word → default (no false routing)');

    // Single-word message (no space) → default
    const r8 = parseAgentRouting('hello', agents, teams);
    assert(r8.agentId === 'default', 'single word with no body → default');

    // Voice-to-text style: no punctuation, no @
    const r9 = parseAgentRouting('mac what time is it in tokyo right now', agents, teams);
    assert(r9.agentId === 'mac-claude', 'natural voice message routes correctly');
    assert(r9.message === 'what time is it in tokyo right now', 'voice message body correct');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log(`${COLORS.cyan}========================================`);
    console.log('  Routing Tests (with alias support)');
    console.log(`========================================${COLORS.reset}`);

    testAgentIdMatch();
    testAgentNameMatch();
    testAliasMatch();
    testTeamMatch();
    testDefaultFallback();
    testMultilineMessages();
    testNoAtSign();

    console.log(`\n${COLORS.cyan}========================================${COLORS.reset}`);
    console.log(`Results: ${COLORS.green}${passed} passed${COLORS.reset}, ${failed > 0 ? '\x1b[31m' : ''}${failed} failed\x1b[0m`);

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
