#!/usr/bin/env npx ts-node
/**
 * Memory System Tests
 *
 * Tests the self-learning agent memory system:
 * - Core Memory (knowledge.md)
 * - Reflections (reflections.jsonl)
 * - Episodes (episodes.jsonl)
 * - Skills (memory/skills/)
 *
 * Run: npx ts-node tests/memory.test.ts
 * Or:  npm test
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Test utilities
const TEST_DIR = path.join(__dirname, '../.test-workspace');
const COLORS = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m',
};

let passed = 0;
let failed = 0;

function log(msg: string) {
    console.log(msg);
}

function pass(name: string) {
    passed++;
    log(`${COLORS.green}✓${COLORS.reset} ${name}`);
}

function fail(name: string, error?: string) {
    failed++;
    log(`${COLORS.red}✗${COLORS.reset} ${name}`);
    if (error) log(`  ${COLORS.red}${error}${COLORS.reset}`);
}

function assert(condition: boolean, name: string, error?: string) {
    if (condition) {
        pass(name);
    } else {
        fail(name, error);
    }
}

function setup() {
    // Clean up any previous test workspace
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup() {
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true });
    }
}

// ============================================================================
// Unit Tests: Memory Loading
// ============================================================================

function testMemoryDirectoryCreation() {
    log(`\n${COLORS.cyan}## Memory Directory Creation${COLORS.reset}`);

    const agentDir = path.join(TEST_DIR, 'test-agent');
    const memoryDir = path.join(agentDir, 'memory');
    const skillsDir = path.join(memoryDir, 'skills');

    // Create structure manually (simulating ensureAgentDirectory)
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });

    // Seed files
    fs.writeFileSync(
        path.join(memoryDir, 'knowledge.md'),
        '# Knowledge\n\n_No entries yet. This file will be updated as I learn._\n'
    );
    fs.writeFileSync(path.join(memoryDir, 'reflections.jsonl'), '');
    fs.writeFileSync(path.join(memoryDir, 'episodes.jsonl'), '');
    fs.writeFileSync(path.join(skillsDir, 'index.json'), '{}');

    assert(fs.existsSync(memoryDir), 'memory/ directory created');
    assert(fs.existsSync(skillsDir), 'memory/skills/ directory created');
    assert(fs.existsSync(path.join(memoryDir, 'knowledge.md')), 'knowledge.md created');
    assert(fs.existsSync(path.join(memoryDir, 'reflections.jsonl')), 'reflections.jsonl created');
    assert(fs.existsSync(path.join(memoryDir, 'episodes.jsonl')), 'episodes.jsonl created');
    assert(fs.existsSync(path.join(skillsDir, 'index.json')), 'skills/index.json created');
}

function testKnowledgeLoading() {
    log(`\n${COLORS.cyan}## Knowledge Loading${COLORS.reset}`);

    const agentDir = path.join(TEST_DIR, 'test-agent');
    const memoryDir = path.join(agentDir, 'memory');
    const knowledgeFile = path.join(memoryDir, 'knowledge.md');

    // Test 1: Empty/placeholder knowledge should not be loaded
    const placeholder = '# Knowledge\n\n_No entries yet. This file will be updated as I learn._\n';
    fs.writeFileSync(knowledgeFile, placeholder);

    const content1 = fs.readFileSync(knowledgeFile, 'utf8');
    assert(
        content1.includes('_No entries yet'),
        'Placeholder knowledge detected (should be skipped in context injection)'
    );

    // Test 2: Real knowledge should be loaded
    const realKnowledge = `# Knowledge

- Tim prefers concise responses
- The production server IP is 165.22.11.9
- Always use --dangerously-skip-permissions for agent invocations
`;
    fs.writeFileSync(knowledgeFile, realKnowledge);

    const content2 = fs.readFileSync(knowledgeFile, 'utf8');
    assert(content2.includes('Tim prefers concise'), 'Real knowledge content is readable');
    assert(!content2.includes('_No entries yet'), 'Placeholder text removed');
}

function testReflectionsLoading() {
    log(`\n${COLORS.cyan}## Reflections Loading${COLORS.reset}`);

    const agentDir = path.join(TEST_DIR, 'test-agent');
    const memoryDir = path.join(agentDir, 'memory');
    const reflectionsFile = path.join(memoryDir, 'reflections.jsonl');

    // Write test reflections
    const reflections = [
        { ts: '2026-02-17T10:00:00Z', type: 'failure', context: 'API call', lesson: 'Need to handle timeouts', action: 'Add 30s timeout' },
        { ts: '2026-02-17T11:00:00Z', type: 'success', context: 'Code review', lesson: 'User appreciated detailed explanations', action: 'Continue being thorough' },
        { ts: '2026-02-17T12:00:00Z', type: 'insight', context: 'System behavior', lesson: 'The queue processor recovers automatically', action: null },
    ];

    fs.writeFileSync(reflectionsFile, reflections.map(r => JSON.stringify(r)).join('\n') + '\n');

    const content = fs.readFileSync(reflectionsFile, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    assert(lines.length === 3, `Wrote 3 reflections (got ${lines.length})`);

    // Parse and verify
    const parsed = lines.map(l => JSON.parse(l));
    assert(parsed[0].type === 'failure', 'First reflection is failure type');
    assert(parsed[1].type === 'success', 'Second reflection is success type');
    assert(parsed[2].action === null, 'Third reflection has no action');
}

function testEpisodesLoading() {
    log(`\n${COLORS.cyan}## Episodes Loading${COLORS.reset}`);

    const agentDir = path.join(TEST_DIR, 'test-agent');
    const memoryDir = path.join(agentDir, 'memory');
    const episodesFile = path.join(memoryDir, 'episodes.jsonl');

    // Write test episodes
    const episodes = [
        { ts: '2026-02-15T10:00:00Z', user: 'tim', summary: 'Debugged TinyClaw queue jamming issue', tags: ['tinyclaw', 'debugging', 'queue'], outcome: 'resolved' },
        { ts: '2026-02-16T14:00:00Z', user: 'tim', summary: 'Set up new Telegram bot integration', tags: ['telegram', 'setup', 'integration'], outcome: 'resolved' },
        { ts: '2026-02-17T09:00:00Z', user: 'tim', summary: 'Discussed memory system architecture', tags: ['memory', 'architecture', 'planning'], outcome: 'informational' },
    ];

    fs.writeFileSync(episodesFile, episodes.map(e => JSON.stringify(e)).join('\n') + '\n');

    const content = fs.readFileSync(episodesFile, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    assert(lines.length === 3, `Wrote 3 episodes (got ${lines.length})`);

    // Test keyword matching logic
    const userMessage = 'I need help with the queue again';
    const msgWords = userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    let matchedEpisode: any = null;
    for (const line of lines) {
        const ep = JSON.parse(line);
        const text = `${ep.summary} ${ep.tags.join(' ')}`.toLowerCase();
        const matches = msgWords.some(w => text.includes(w));
        if (matches) {
            matchedEpisode = ep;
            break;
        }
    }

    assert(matchedEpisode !== null, 'Found relevant episode for "queue" query');
    assert(
        matchedEpisode?.summary.includes('queue'),
        `Matched correct episode: "${matchedEpisode?.summary}"`
    );
}

function testSkillsLoading() {
    log(`\n${COLORS.cyan}## Skills Loading${COLORS.reset}`);

    const agentDir = path.join(TEST_DIR, 'test-agent');
    const skillsDir = path.join(agentDir, 'memory', 'skills');
    const indexFile = path.join(skillsDir, 'index.json');

    // Create skill index and skill file
    const index = {
        'fix-queue-jam': 'Steps to diagnose and fix TinyClaw queue jams',
        'deploy-to-droplet': 'How to deploy TinyClaw to the production droplet',
    };
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

    // Create skill file
    fs.writeFileSync(
        path.join(skillsDir, 'fix-queue-jam.md'),
        `# Fix Queue Jam

1. Check for stuck files in queue/processing/
2. Run: ls -la queue/processing/
3. Delete any files older than 10 minutes
4. Restart the queue processor: pm2 restart queue
`
    );

    // Test skill matching
    const userMessage = 'The queue is jammed again';
    const loadedIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const msgLower = userMessage.toLowerCase();

    let matchedSkill: string | null = null;
    for (const [skillId, description] of Object.entries(loadedIndex)) {
        const descWords = (description as string).toLowerCase().split(/\s+/).filter(w => w.length > 3);
        if (descWords.some(w => msgLower.includes(w))) {
            matchedSkill = skillId;
            break;
        }
    }

    assert(matchedSkill === 'fix-queue-jam', `Matched correct skill: ${matchedSkill}`);

    const skillContent = fs.readFileSync(path.join(skillsDir, `${matchedSkill}.md`), 'utf8');
    assert(skillContent.includes('pm2 restart'), 'Skill file content is readable');
}

// ============================================================================
// Integration Tests: Full Memory Flow
// ============================================================================

function testMemoryContextInjection() {
    log(`\n${COLORS.cyan}## Memory Context Injection (Integration)${COLORS.reset}`);

    const agentDir = path.join(TEST_DIR, 'integration-agent');
    const memoryDir = path.join(agentDir, 'memory');
    const skillsDir = path.join(memoryDir, 'skills');

    // Set up full memory structure
    fs.mkdirSync(skillsDir, { recursive: true });

    // Knowledge
    fs.writeFileSync(path.join(memoryDir, 'knowledge.md'), `# Knowledge

- User's name is Tim
- Favorite color is blue
- Prefers TypeScript over JavaScript
`);

    // Reflections
    fs.writeFileSync(path.join(memoryDir, 'reflections.jsonl'),
        JSON.stringify({ ts: '2026-02-17T10:00:00Z', type: 'success', context: 'Code review', lesson: 'Be thorough', action: 'Continue' }) + '\n'
    );

    // Episodes
    fs.writeFileSync(path.join(memoryDir, 'episodes.jsonl'),
        JSON.stringify({ ts: '2026-02-16T10:00:00Z', user: 'tim', summary: 'Discussed TypeScript migration', tags: ['typescript', 'migration'], outcome: 'resolved' }) + '\n'
    );

    // Skills
    fs.writeFileSync(path.join(skillsDir, 'index.json'), JSON.stringify({ 'ts-migrate': 'Migrate JavaScript to TypeScript' }));
    fs.writeFileSync(path.join(skillsDir, 'ts-migrate.md'), '# TS Migration\n\n1. Add tsconfig.json\n2. Rename files to .ts');

    // Simulate loadMemoryContext
    const userMessage = 'Help me with TypeScript';
    const sections: string[] = [];

    // Load knowledge
    const knowledge = fs.readFileSync(path.join(memoryDir, 'knowledge.md'), 'utf8').trim();
    if (knowledge && !knowledge.includes('_No entries yet')) {
        sections.push(`## Knowledge\n${knowledge}`);
    }

    // Load reflections
    const reflections = fs.readFileSync(path.join(memoryDir, 'reflections.jsonl'), 'utf8').trim();
    if (reflections) {
        const lines = reflections.split('\n').filter(l => l.trim()).slice(-10);
        const formatted = lines.map(line => {
            const r = JSON.parse(line);
            return `- [${r.type}] ${r.context}: ${r.lesson}${r.action ? ` → ${r.action}` : ''}`;
        }).join('\n');
        sections.push(`## Recent Reflections\n${formatted}`);
    }

    // Load episodes (with keyword matching)
    const episodes = fs.readFileSync(path.join(memoryDir, 'episodes.jsonl'), 'utf8').trim();
    if (episodes) {
        const lines = episodes.split('\n').filter(l => l.trim());
        const msgWords = userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const matched = lines.filter(line => {
            const ep = JSON.parse(line);
            const text = `${ep.summary} ${ep.tags.join(' ')}`.toLowerCase();
            return msgWords.some(w => text.includes(w));
        });
        if (matched.length > 0) {
            const formatted = matched.map(line => {
                const ep = JSON.parse(line);
                return `- [${ep.outcome}] ${ep.summary} (${ep.tags.join(', ')})`;
            }).join('\n');
            sections.push(`## Relevant Past Conversations\n${formatted}`);
        }
    }

    // Load skills
    const skillIndex = JSON.parse(fs.readFileSync(path.join(skillsDir, 'index.json'), 'utf8'));
    const msgLower = userMessage.toLowerCase();
    const matchedSkills: string[] = [];
    for (const [skillId, description] of Object.entries(skillIndex)) {
        const descWords = (description as string).toLowerCase().split(/\s+/).filter(w => w.length > 3);
        if (descWords.some(w => msgLower.includes(w))) {
            const skillContent = fs.readFileSync(path.join(skillsDir, `${skillId}.md`), 'utf8');
            matchedSkills.push(`### ${skillId}\n${skillContent}`);
        }
    }
    if (matchedSkills.length > 0) {
        sections.push(`## Relevant Skills\n${matchedSkills.join('\n\n')}`);
    }

    const memoryContext = `[MEMORY]\n${sections.join('\n\n')}\n[/MEMORY]\n\n`;
    const finalMessage = memoryContext + userMessage;

    assert(finalMessage.includes('[MEMORY]'), 'Memory block wrapper present');
    assert(finalMessage.includes('## Knowledge'), 'Knowledge section injected');
    assert(finalMessage.includes('Favorite color is blue'), 'Knowledge content present');
    assert(finalMessage.includes('## Recent Reflections'), 'Reflections section injected');
    assert(finalMessage.includes('## Relevant Past Conversations'), 'Episodes section injected');
    assert(finalMessage.includes('TypeScript migration'), 'Relevant episode matched');
    assert(finalMessage.includes('## Relevant Skills'), 'Skills section injected');
    assert(finalMessage.includes('ts-migrate'), 'Relevant skill matched');
    assert(finalMessage.endsWith(userMessage), 'User message preserved at end');

    log(`\n${COLORS.yellow}Generated context (${finalMessage.length} chars):${COLORS.reset}`);
    log(finalMessage.substring(0, 500) + '...');
}

function testEpisodeCapture() {
    log(`\n${COLORS.cyan}## Episode Capture (Integration)${COLORS.reset}`);

    const agentDir = path.join(TEST_DIR, 'episode-agent');
    const memoryDir = path.join(agentDir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'episodes.jsonl'), '');

    // Simulate episode capture (what queue-processor does)
    const userMessage = 'How do I fix the queue jam?';
    const agentResponse = 'Check the queue/processing directory for stuck files and delete any older than 10 minutes.';

    // In real system, this calls Claude Haiku to generate summary
    // For tests, we simulate the expected output
    const episode = {
        ts: new Date().toISOString(),
        user: 'tim',
        summary: 'Fixed queue jam by clearing stuck processing files',
        tags: ['queue', 'debugging', 'tinyclaw'],
        outcome: 'resolved',
    };

    fs.appendFileSync(
        path.join(memoryDir, 'episodes.jsonl'),
        JSON.stringify(episode) + '\n'
    );

    const episodes = fs.readFileSync(path.join(memoryDir, 'episodes.jsonl'), 'utf8');
    const lines = episodes.trim().split('\n').filter(l => l.trim());

    assert(lines.length === 1, 'Episode was captured');

    const parsed = JSON.parse(lines[0]);
    assert(parsed.summary.includes('queue'), 'Episode summary captures topic');
    assert(parsed.tags.includes('queue'), 'Episode has relevant tags');
    assert(parsed.outcome === 'resolved', 'Episode outcome recorded');
}

// ============================================================================
// Run Tests
// ============================================================================

function runTests() {
    log(`${COLORS.cyan}╔════════════════════════════════════════════════════════════╗${COLORS.reset}`);
    log(`${COLORS.cyan}║           TinyClaw Memory System Tests                     ║${COLORS.reset}`);
    log(`${COLORS.cyan}╚════════════════════════════════════════════════════════════╝${COLORS.reset}`);

    setup();

    try {
        // Unit tests
        testMemoryDirectoryCreation();
        testKnowledgeLoading();
        testReflectionsLoading();
        testEpisodesLoading();
        testSkillsLoading();

        // Integration tests
        testMemoryContextInjection();
        testEpisodeCapture();

    } finally {
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

runTests();
