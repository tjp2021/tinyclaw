#!/usr/bin/env npx ts-node
/**
 * Live Memory System Integration Test
 *
 * Actually invokes Claude to test the full memory flow:
 * 1. Tell agent to remember something
 * 2. Check that knowledge.md was updated
 * 3. New "session" - ask agent to recall
 * 4. Verify recall is correct
 *
 * Requires: claude CLI installed and authenticated
 * Run: npx ts-node tests/memory-live.test.ts
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const TEST_DIR = path.join(__dirname, '../.test-workspace-live');
const COLORS = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
    reset: '\x1b[0m',
};

function log(msg: string) {
    console.log(msg);
}

function runClaude(message: string, workingDir: string, continueSession: boolean = false): Promise<string> {
    return new Promise((resolve, reject) => {
        const args = ['--dangerously-skip-permissions'];
        if (continueSession) {
            args.push('-c');
        }
        args.push('-p', message);

        log(`${COLORS.dim}> claude ${args.slice(0, -1).join(' ')} "${message.substring(0, 50)}..."${COLORS.reset}`);

        const child = spawn('claude', args, {
            cwd: workingDir,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`Claude exited with code ${code}: ${stderr}`));
            }
        });

        child.on('error', reject);
    });
}

async function setup() {
    log(`\n${COLORS.cyan}Setting up test workspace...${COLORS.reset}`);

    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Create memory directory structure
    const memoryDir = path.join(TEST_DIR, 'memory');
    const skillsDir = path.join(memoryDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    // Seed empty memory files
    fs.writeFileSync(path.join(memoryDir, 'knowledge.md'),
        '# Knowledge\n\n_No entries yet. This file will be updated as I learn._\n');
    fs.writeFileSync(path.join(memoryDir, 'reflections.jsonl'), '');
    fs.writeFileSync(path.join(memoryDir, 'episodes.jsonl'), '');
    fs.writeFileSync(path.join(skillsDir, 'index.json'), '{}');

    // Create a CLAUDE.md with memory instructions
    const claudeDir = path.join(TEST_DIR, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), `# Test Agent

You are a test agent for the TinyClaw memory system.

## Memory Management

You have a persistent memory system in the \`memory/\` directory:

1. **knowledge.md** — Key facts, user preferences, lessons learned.
   - When asked to remember something, immediately update this file
   - Use the Write tool to save information
   - Format as bullet points

2. **reflections.jsonl** — When you learn something important, append a reflection.

IMPORTANT: When the user asks you to "remember" something, you MUST:
1. Use the Write tool to update memory/knowledge.md
2. Include the exact information they asked you to remember
3. Confirm that you've saved it

Keep responses brief.
`);

    log(`${COLORS.green}✓${COLORS.reset} Test workspace created at ${TEST_DIR}`);
}

function cleanup() {
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true });
    }
}

async function testRememberAndRecall() {
    log(`\n${COLORS.cyan}═══════════════════════════════════════════════════════════${COLORS.reset}`);
    log(`${COLORS.cyan}Test: Remember and Recall${COLORS.reset}`);
    log(`${COLORS.cyan}═══════════════════════════════════════════════════════════${COLORS.reset}`);

    const testFact = 'The secret password is purple-elephant-42';

    // Step 1: Tell agent to remember something
    log(`\n${COLORS.yellow}Step 1: Ask agent to remember a fact${COLORS.reset}`);
    try {
        const response1 = await runClaude(
            `Remember this fact and save it to memory/knowledge.md: "${testFact}"`,
            TEST_DIR
        );
        log(`${COLORS.dim}Response: ${response1.substring(0, 200)}...${COLORS.reset}`);
    } catch (e: any) {
        log(`${COLORS.red}✗ Failed to invoke Claude: ${e.message}${COLORS.reset}`);
        return false;
    }

    // Step 2: Check knowledge.md was updated
    log(`\n${COLORS.yellow}Step 2: Verify knowledge.md was updated${COLORS.reset}`);
    const knowledgeFile = path.join(TEST_DIR, 'memory', 'knowledge.md');
    const knowledgeContent = fs.readFileSync(knowledgeFile, 'utf8');

    if (knowledgeContent.includes('purple-elephant-42')) {
        log(`${COLORS.green}✓${COLORS.reset} knowledge.md contains the remembered fact`);
        log(`${COLORS.dim}Content:\n${knowledgeContent}${COLORS.reset}`);
    } else {
        log(`${COLORS.red}✗${COLORS.reset} knowledge.md does NOT contain the fact`);
        log(`${COLORS.dim}Content:\n${knowledgeContent}${COLORS.reset}`);
        return false;
    }

    // Step 3: New session - inject memory and ask for recall
    log(`\n${COLORS.yellow}Step 3: New session - test recall with memory injection${COLORS.reset}`);

    // Simulate memory injection (what invoke.ts does)
    const memoryContext = `[MEMORY]
## Knowledge
${knowledgeContent}
[/MEMORY]

`;
    const recallQuestion = 'What is the secret password?';
    const messageWithMemory = memoryContext + recallQuestion;

    try {
        // Don't continue session (-c), simulating fresh conversation
        const response2 = await runClaude(messageWithMemory, TEST_DIR, false);
        log(`${COLORS.dim}Response: ${response2}${COLORS.reset}`);

        if (response2.toLowerCase().includes('purple-elephant-42') ||
            response2.toLowerCase().includes('purple elephant 42')) {
            log(`${COLORS.green}✓${COLORS.reset} Agent correctly recalled the secret password`);
            return true;
        } else {
            log(`${COLORS.red}✗${COLORS.reset} Agent did NOT recall the password correctly`);
            return false;
        }
    } catch (e: any) {
        log(`${COLORS.red}✗ Failed to invoke Claude: ${e.message}${COLORS.reset}`);
        return false;
    }
}

async function testReflectionCapture() {
    log(`\n${COLORS.cyan}═══════════════════════════════════════════════════════════${COLORS.reset}`);
    log(`${COLORS.cyan}Test: Reflection Capture${COLORS.reset}`);
    log(`${COLORS.cyan}═══════════════════════════════════════════════════════════${COLORS.reset}`);

    const reflectionsFile = path.join(TEST_DIR, 'memory', 'reflections.jsonl');

    try {
        const response = await runClaude(
            `You just learned an important lesson: "Always validate user input before processing."

Please add a reflection to memory/reflections.jsonl with this format (one JSON line):
{"ts":"2026-02-17T12:00:00Z","type":"insight","context":"code review","lesson":"Always validate user input before processing","action":"Add input validation to all endpoints"}`,
            TEST_DIR,
            true  // Continue session
        );
        log(`${COLORS.dim}Response: ${response.substring(0, 200)}...${COLORS.reset}`);
    } catch (e: any) {
        log(`${COLORS.red}✗ Failed to invoke Claude: ${e.message}${COLORS.reset}`);
        return false;
    }

    // Check reflections file
    const content = fs.readFileSync(reflectionsFile, 'utf8').trim();
    if (content && content.includes('validate')) {
        log(`${COLORS.green}✓${COLORS.reset} Reflection was captured`);
        log(`${COLORS.dim}Content: ${content}${COLORS.reset}`);
        return true;
    } else {
        log(`${COLORS.yellow}⚠${COLORS.reset} Reflection not found (agent may not have written it)`);
        log(`${COLORS.dim}File content: "${content}"${COLORS.reset}`);
        return false;
    }
}

async function runLiveTests() {
    log(`${COLORS.cyan}╔════════════════════════════════════════════════════════════╗${COLORS.reset}`);
    log(`${COLORS.cyan}║        TinyClaw Memory System - LIVE Integration Tests     ║${COLORS.reset}`);
    log(`${COLORS.cyan}╚════════════════════════════════════════════════════════════╝${COLORS.reset}`);

    // Check claude CLI is available
    try {
        execSync('which claude', { stdio: 'ignore' });
    } catch {
        log(`${COLORS.red}Error: 'claude' CLI not found. Please install Claude Code.${COLORS.reset}`);
        process.exit(1);
    }

    await setup();

    let passed = 0;
    let failed = 0;

    try {
        if (await testRememberAndRecall()) passed++; else failed++;
        if (await testReflectionCapture()) passed++; else failed++;
    } finally {
        log(`\n${COLORS.yellow}Cleaning up...${COLORS.reset}`);
        cleanup();
    }

    // Summary
    log(`\n${COLORS.cyan}════════════════════════════════════════════════════════════${COLORS.reset}`);
    log(`${COLORS.green}Passed: ${passed}${COLORS.reset}`);
    if (failed > 0) {
        log(`${COLORS.red}Failed: ${failed}${COLORS.reset}`);
    }
    log(`${COLORS.cyan}════════════════════════════════════════════════════════════${COLORS.reset}`);

    process.exit(failed > 0 ? 1 : 0);
}

runLiveTests().catch(console.error);
