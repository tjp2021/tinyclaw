import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AgentConfig, TeamConfig } from './types';
import { SCRIPT_DIR, resolveClaudeModel, resolveCodexModel } from './config';
import { log } from './logging';
import { ensureAgentDirectory, ensureMemoryDirectory, updateAgentTeammates } from './agent-setup';

/**
 * Load memory context from an agent's working directory.
 * Reads knowledge.md, recent reflections, relevant episodes, and relevant skills.
 * Returns a formatted string to prepend to the user message.
 */
function loadMemoryContext(workingDir: string, userMessage: string): string {
    const memoryDir = path.join(workingDir, 'memory');
    if (!fs.existsSync(memoryDir)) return '';

    const sections: string[] = [];

    // 1. Core Memory: knowledge.md (always loaded)
    const knowledgeFile = path.join(memoryDir, 'knowledge.md');
    if (fs.existsSync(knowledgeFile)) {
        const knowledge = fs.readFileSync(knowledgeFile, 'utf8').trim();
        if (knowledge && !knowledge.includes('_No entries yet')) {
            sections.push(`## Knowledge\n${knowledge}`);
        }
    }

    // 2. Recent Reflections: last 10 from reflections.jsonl
    const reflectionsFile = path.join(memoryDir, 'reflections.jsonl');
    if (fs.existsSync(reflectionsFile)) {
        const content = fs.readFileSync(reflectionsFile, 'utf8').trim();
        if (content) {
            const lines = content.split('\n').filter(l => l.trim());
            const recent = lines.slice(-10);
            if (recent.length > 0) {
                const formatted = recent.map(line => {
                    try {
                        const r = JSON.parse(line);
                        return `- [${r.type}] ${r.context}: ${r.lesson}${r.action ? ` → ${r.action}` : ''}`;
                    } catch {
                        return null;
                    }
                }).filter(Boolean).join('\n');
                if (formatted) {
                    sections.push(`## Recent Reflections\n${formatted}`);
                }
            }
        }
    }

    // 3. Relevant Episodes: keyword match against user message
    const episodesFile = path.join(memoryDir, 'episodes.jsonl');
    if (fs.existsSync(episodesFile)) {
        const content = fs.readFileSync(episodesFile, 'utf8').trim();
        if (content) {
            const lines = content.split('\n').filter(l => l.trim());
            const msgWords = userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            const scored: { line: string; score: number }[] = [];

            for (const line of lines) {
                try {
                    const ep = JSON.parse(line);
                    const text = `${ep.summary || ''} ${(ep.tags || []).join(' ')}`.toLowerCase();
                    let score = 0;
                    for (const word of msgWords) {
                        if (text.includes(word)) score++;
                    }
                    if (score > 0) scored.push({ line, score });
                } catch {
                    // skip malformed lines
                }
            }

            scored.sort((a, b) => b.score - a.score);
            const topEpisodes = scored.slice(0, 3);
            if (topEpisodes.length > 0) {
                const formatted = topEpisodes.map(({ line }) => {
                    try {
                        const ep = JSON.parse(line);
                        return `- [${ep.outcome || 'unknown'}] ${ep.summary}${ep.tags ? ` (${ep.tags.join(', ')})` : ''}`;
                    } catch {
                        return null;
                    }
                }).filter(Boolean).join('\n');
                if (formatted) {
                    sections.push(`## Relevant Past Conversations\n${formatted}`);
                }
            }
        }
    }

    // 4. Relevant Skills: match skill descriptions against user message
    const skillsIndex = path.join(memoryDir, 'skills', 'index.json');
    if (fs.existsSync(skillsIndex)) {
        try {
            const index: Record<string, string> = JSON.parse(fs.readFileSync(skillsIndex, 'utf8'));
            const msgLower = userMessage.toLowerCase();
            const matchedSkills: string[] = [];

            for (const [skillId, description] of Object.entries(index)) {
                const descWords = description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                const matches = descWords.some(w => msgLower.includes(w));
                if (matches) {
                    const skillFile = path.join(memoryDir, 'skills', `${skillId}.md`);
                    if (fs.existsSync(skillFile)) {
                        const skillContent = fs.readFileSync(skillFile, 'utf8').trim();
                        matchedSkills.push(`### ${skillId}\n${skillContent}`);
                    }
                }
            }

            if (matchedSkills.length > 0) {
                sections.push(`## Relevant Skills\n${matchedSkills.join('\n\n')}`);
            }
        } catch {
            // skip if index is malformed
        }
    }

    if (sections.length === 0) return '';
    return `[MEMORY]\n${sections.join('\n\n')}\n[/MEMORY]\n\n`;
}

export async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: cwd || SCRIPT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });

        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }

            const errorMessage = stderr.trim() || `Command exited with code ${code}`;
            reject(new Error(errorMessage));
        });
    });
}

/**
 * Invoke a single agent with a message. Contains all Claude/Codex invocation logic.
 * Returns the raw response text.
 */
export async function invokeAgent(
    agent: AgentConfig,
    agentId: string,
    message: string,
    workspacePath: string,
    shouldReset: boolean,
    agents: Record<string, AgentConfig> = {},
    teams: Record<string, TeamConfig> = {}
): Promise<string> {
    // Ensure agent directory exists with config files
    const agentDir = path.join(workspacePath, agentId);
    const isNewAgent = !fs.existsSync(agentDir);
    ensureAgentDirectory(agentDir);
    if (isNewAgent) {
        log('INFO', `Initialized agent directory with config files: ${agentDir}`);
    }

    // Update AGENTS.md with current teammate info
    updateAgentTeammates(agentDir, agentId, agents, teams);

    // Resolve working directory
    const workingDir = agent.working_directory
        ? (path.isAbsolute(agent.working_directory)
            ? agent.working_directory
            : path.join(workspacePath, agent.working_directory))
        : agentDir;

    // Ensure memory directory exists and load memory context
    ensureMemoryDirectory(workingDir);
    const memoryContext = loadMemoryContext(workingDir, message);
    if (memoryContext) {
        message = memoryContext + message;
        log('INFO', `Injected memory context for agent ${agentId} (${memoryContext.length} chars)`);
    }

    const provider = agent.provider || 'anthropic';

    if (provider === 'openai') {
        log('INFO', `Using Codex CLI (agent: ${agentId})`);

        const shouldResume = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting Codex conversation for agent: ${agentId}`);
        }

        const modelId = resolveCodexModel(agent.model);
        const codexArgs = ['exec'];
        if (shouldResume) {
            codexArgs.push('resume', '--last');
        }
        if (modelId) {
            codexArgs.push('--model', modelId);
        }
        codexArgs.push('--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', message);

        const codexOutput = await runCommand('codex', codexArgs, workingDir);

        // Parse JSONL output and extract final agent_message
        let response = '';
        const lines = codexOutput.trim().split('\n');
        for (const line of lines) {
            try {
                const json = JSON.parse(line);
                if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
                    response = json.item.text;
                }
            } catch (e) {
                // Ignore lines that aren't valid JSON
            }
        }

        return response || 'Sorry, I could not generate a response from Codex.';
    } else {
        // Default to Claude (Anthropic)
        log('INFO', `Using Claude provider (agent: ${agentId})`);

        const continueConversation = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting conversation for agent: ${agentId}`);
        }

        const modelId = resolveClaudeModel(agent.model);
        const claudeArgs = ['--dangerously-skip-permissions'];
        if (modelId) {
            claudeArgs.push('--model', modelId);
        }
        if (continueConversation) {
            claudeArgs.push('-c');
        }
        claudeArgs.push('-p', message);

        return await runCommand('claude', claudeArgs, workingDir);
    }
}
