#!/usr/bin/env node
/**
 * Queue Processor - Handles messages from all channels (WhatsApp, Telegram, etc.)
 *
 * Supports multi-agent routing:
 *   - Messages prefixed with @agent_id are routed to that agent
 *   - Unrouted messages go to the "default" agent
 *   - Each agent has its own provider, model, working directory, and system prompt
 *   - Conversation isolation via per-agent working directories
 *
 * Team conversations use queue-based message passing:
 *   - Agent mentions ([@teammate: message]) become new messages in the queue
 *   - Each agent processes messages naturally via its own promise chain
 *   - Conversations complete when all branches resolve (no more pending mentions)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { MessageData, ResponseData, QueueFile, ChainStep, Conversation, TeamConfig } from './lib/types';
import {
    QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_PROCESSING,
    LOG_FILE, EVENTS_DIR, CHATS_DIR, FILES_DIR,
    getSettings, getAgents, getTeams
} from './lib/config';
import { log, emitEvent } from './lib/logging';
import { parseAgentRouting, findTeamForAgent, getAgentResetFlag, extractTeammateMentions } from './lib/routing';
import { invokeAgent, runCommand } from './lib/invoke';
import { buildConfirmInstruction, detectConfirmRequired, buildApprovalMessage, parseApprovalReply } from './lib/approval';
import { storeMemory, searchMemory } from './lib/supermemory';

const QUEUE_APPROVAL = path.join(path.dirname(QUEUE_INCOMING), 'approval');

// Ensure directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_PROCESSING, QUEUE_APPROVAL, FILES_DIR, path.dirname(LOG_FILE)].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

interface ApprovalState {
    agentId: string;
    senderId: string;
    channel: string;
    sender: string;
    messageId: string;
    originalMessage: string;
    description: string;
    workspacePath: string;
    agentWorkingDir: string;
    timestamp: number;
}

// Files currently queued in a promise chain — prevents duplicate processing across ticks
const queuedFiles = new Set<string>();

// Active conversations — tracks in-flight team message passing
const conversations = new Map<string, Conversation>();

// Per-sender chat history for context injection — survives across messages
// Key: `${senderId}:${agentId}`, Value: array of {role, content} pairs
interface HistoryEntry { role: 'user' | 'assistant'; content: string; }
const chatHistory = new Map<string, HistoryEntry[]>();
const MAX_HISTORY_ENTRIES = 10; // last 5 exchanges (10 turns)
const MAX_HISTORY_CHARS = 6000; // cap total injected history size

function getHistory(senderId: string, agentId: string): HistoryEntry[] {
    return chatHistory.get(`${senderId}:${agentId}`) || [];
}

function addToHistory(senderId: string, agentId: string, role: 'user' | 'assistant', content: string): void {
    const key = `${senderId}:${agentId}`;
    const history = chatHistory.get(key) || [];
    history.push({ role, content: content.substring(0, 2000) }); // cap per-entry size
    // Keep only last MAX_HISTORY_ENTRIES
    if (history.length > MAX_HISTORY_ENTRIES) history.splice(0, history.length - MAX_HISTORY_ENTRIES);
    chatHistory.set(key, history);
}

function buildHistoryPrefix(history: HistoryEntry[]): string {
    if (history.length === 0) return '';
    let block = '[RECENT CONVERSATION HISTORY]\n';
    let totalChars = 0;
    // Walk backwards so we include the most recent turns first (up to char limit)
    const toInclude: HistoryEntry[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
        totalChars += history[i].content.length;
        if (totalChars > MAX_HISTORY_CHARS) break;
        toInclude.unshift(history[i]);
    }
    for (const entry of toInclude) {
        block += `${entry.role === 'user' ? 'Tim' : 'Assistant'}: ${entry.content}\n`;
    }
    block += '[END HISTORY]\n\n';
    return block;
}

const MAX_CONVERSATION_MESSAGES = 50;
const TELEGRAM_MAX_CHARS = 4000; // Telegram limit is 4096, leave headroom

/**
 * Split a response into Telegram-safe chunks at natural boundaries.
 * Returns array of strings, each under TELEGRAM_MAX_CHARS.
 */
function splitIntoChunks(text: string): string[] {
    if (text.length <= TELEGRAM_MAX_CHARS) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > TELEGRAM_MAX_CHARS) {
        let splitAt = TELEGRAM_MAX_CHARS;

        // Try to split at a paragraph boundary
        const paraBreak = remaining.lastIndexOf('\n\n', TELEGRAM_MAX_CHARS);
        if (paraBreak > TELEGRAM_MAX_CHARS * 0.5) {
            splitAt = paraBreak + 2;
        } else {
            // Fall back to newline
            const lineBreak = remaining.lastIndexOf('\n', TELEGRAM_MAX_CHARS);
            if (lineBreak > TELEGRAM_MAX_CHARS * 0.5) {
                splitAt = lineBreak + 1;
            }
        }

        chunks.push(remaining.substring(0, splitAt).trimEnd());
        remaining = remaining.substring(splitAt).trimStart();
    }

    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
}

/**
 * If a response exceeds Telegram's limit, split into multiple chunks.
 * Returns the first chunk as message, rest queued as additional parts.
 * No more file attachments for long text — just split it.
 */
function handleLongResponse(
    response: string,
    existingFiles: string[]
): { message: string; files: string[]; extraChunks?: string[] } {
    const chunks = splitIntoChunks(response);
    if (chunks.length === 1) {
        return { message: chunks[0], files: existingFiles };
    }

    log('INFO', `Long response (${response.length} chars) split into ${chunks.length} chunks`);
    return { message: chunks[0], files: existingFiles, extraChunks: chunks.slice(1) };
}

/**
 * Capture an episode summary after a conversation completes.
 * Sends a lightweight summarization request to Claude and appends to episodes.jsonl.
 * Runs in the background — does not block response delivery.
 */
async function captureEpisode(
    workingDir: string,
    sender: string,
    userMessage: string,
    agentResponse: string,
    agentId: string
): Promise<void> {
    try {
        const episodesFile = path.join(workingDir, 'memory', 'episodes.jsonl');
        if (!fs.existsSync(path.dirname(episodesFile))) return;

        // Truncate inputs to keep the summarization prompt small
        const truncatedMessage = userMessage.substring(0, 500);
        const truncatedResponse = agentResponse.substring(0, 1000);

        const summaryPrompt = `Summarize this conversation in 1-2 sentences and provide 3-5 keyword tags. Respond ONLY with valid JSON in this exact format, no other text:
{"summary": "...", "tags": ["tag1", "tag2", "tag3"], "outcome": "resolved|unresolved|informational"}

User message: ${truncatedMessage}

Agent response: ${truncatedResponse}`;

        const summaryResult = await runCommand('claude', [
            '--dangerously-skip-permissions',
            '--model', 'claude-haiku-4-5',
            '-p', summaryPrompt,
        ], workingDir);

        // Parse the JSON response
        const jsonMatch = summaryResult.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const episode = {
                ts: new Date().toISOString(),
                user: sender,
                agent: agentId,
                summary: parsed.summary || 'No summary',
                tags: parsed.tags || [],
                outcome: parsed.outcome || 'unknown',
            };
            fs.appendFileSync(episodesFile, JSON.stringify(episode) + '\n');
            log('INFO', `Episode captured for agent ${agentId}: ${episode.summary.substring(0, 80)}`);
        }
    } catch (error) {
        log('ERROR', `Failed to capture episode: ${(error as Error).message}`);
    }
}

/**
 * Save approval state to queue/approval/{senderId}.json
 */
function saveApprovalState(state: ApprovalState): void {
    const stateFile = path.join(QUEUE_APPROVAL, `${state.senderId}.json`);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    log('INFO', `Approval state saved for sender ${state.senderId}: ${state.description}`);
}

/**
 * Load approval state for a sender. Returns null if none pending.
 */
function loadApprovalState(senderId: string): ApprovalState | null {
    const stateFile = path.join(QUEUE_APPROVAL, `${senderId}.json`);
    if (!fs.existsSync(stateFile)) return null;
    try {
        return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Delete approval state for a sender.
 */
function clearApprovalState(senderId: string): void {
    const stateFile = path.join(QUEUE_APPROVAL, `${senderId}.json`);
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
}

/**
 * Write a direct response to outgoing queue (used for approval messages and rejections).
 */
function writeDirectResponse(channel: string, sender: string, senderId: string, messageId: string, message: string): void {
    const responseData: ResponseData = {
        channel,
        sender,
        message,
        originalMessage: '',
        timestamp: Date.now(),
        messageId,
    };
    const responseFile = path.join(QUEUE_OUTGOING, `${channel}_${messageId}_${Date.now()}.json`);
    fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));
}

// Recover orphaned files from processing/ on startup (crash recovery)
function recoverOrphanedFiles() {
    for (const f of fs.readdirSync(QUEUE_PROCESSING).filter(f => f.endsWith('.json'))) {
        try {
            fs.renameSync(path.join(QUEUE_PROCESSING, f), path.join(QUEUE_INCOMING, f));
            log('INFO', `Recovered orphaned file: ${f}`);
        } catch (error) {
            log('ERROR', `Failed to recover orphaned file ${f}: ${(error as Error).message}`);
        }
    }
}

/**
 * Enqueue an internal (agent-to-agent) message into QUEUE_INCOMING.
 */
function enqueueInternalMessage(
    conversationId: string,
    fromAgent: string,
    targetAgent: string,
    message: string,
    originalData: MessageData
): void {
    const internalMessage: MessageData = {
        channel: originalData.channel,
        sender: originalData.sender,
        senderId: originalData.senderId,
        message,
        timestamp: Date.now(),
        messageId: originalData.messageId,
        agent: targetAgent,
        conversationId,
        fromAgent,
    };

    const filename = `internal_${conversationId}_${targetAgent}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`;
    fs.writeFileSync(path.join(QUEUE_INCOMING, filename), JSON.stringify(internalMessage, null, 2));
    log('INFO', `Enqueued internal message: @${fromAgent} → @${targetAgent}`);
}

/**
 * Collect files from a response text.
 */
function collectFiles(response: string, fileSet: Set<string>): void {
    const fileRegex = /\[send_file:\s*([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(response)) !== null) {
        const filePath = match[1].trim();
        if (fs.existsSync(filePath)) fileSet.add(filePath);
    }
}

/**
 * Complete a conversation: aggregate responses, write to outgoing queue, save chat history.
 */
function completeConversation(conv: Conversation): void {
    const settings = getSettings();
    const agents = getAgents(settings);

    log('INFO', `Conversation ${conv.id} complete — ${conv.responses.length} response(s), ${conv.totalMessages} total message(s)`);
    emitEvent('team_chain_end', {
        teamId: conv.teamContext.teamId,
        totalSteps: conv.responses.length,
        agents: conv.responses.map(s => s.agentId),
    });

    // Aggregate responses
    let finalResponse: string;
    if (conv.responses.length === 1) {
        finalResponse = conv.responses[0].response;
    } else {
        finalResponse = conv.responses
            .map(step => `@${step.agentId}: ${step.response}`)
            .join('\n\n------\n\n');
    }

    // Save chat history
    try {
        const teamChatsDir = path.join(CHATS_DIR, conv.teamContext.teamId);
        if (!fs.existsSync(teamChatsDir)) {
            fs.mkdirSync(teamChatsDir, { recursive: true });
        }
        const chatLines: string[] = [];
        chatLines.push(`# Team Conversation: ${conv.teamContext.team.name} (@${conv.teamContext.teamId})`);
        chatLines.push(`**Date:** ${new Date().toISOString()}`);
        chatLines.push(`**Channel:** ${conv.channel} | **Sender:** ${conv.sender}`);
        chatLines.push(`**Messages:** ${conv.totalMessages}`);
        chatLines.push('');
        chatLines.push('------');
        chatLines.push('');
        chatLines.push(`## User Message`);
        chatLines.push('');
        chatLines.push(conv.originalMessage);
        chatLines.push('');
        for (let i = 0; i < conv.responses.length; i++) {
            const step = conv.responses[i];
            const stepAgent = agents[step.agentId];
            const stepLabel = stepAgent ? `${stepAgent.name} (@${step.agentId})` : `@${step.agentId}`;
            chatLines.push('------');
            chatLines.push('');
            chatLines.push(`## ${stepLabel}`);
            chatLines.push('');
            chatLines.push(step.response);
            chatLines.push('');
        }
        const now = new Date();
        const dateTime = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
        fs.writeFileSync(path.join(teamChatsDir, `${dateTime}.md`), chatLines.join('\n'));
        log('INFO', `Chat history saved`);
    } catch (e) {
        log('ERROR', `Failed to save chat history: ${(e as Error).message}`);
    }

    // Detect file references
    finalResponse = finalResponse.trim();
    const outboundFilesSet = new Set<string>(conv.files);
    collectFiles(finalResponse, outboundFilesSet);
    const outboundFiles = Array.from(outboundFilesSet);

    // Remove [send_file: ...] tags
    if (outboundFiles.length > 0) {
        finalResponse = finalResponse.replace(/\[send_file:\s*[^\]]+\]/g, '').trim();
    }

    // Remove [@agent: ...] tags from final response
    finalResponse = finalResponse.replace(/\[@\S+?:\s*[\s\S]*?\]/g, '').trim();

    // Handle long responses — send as file attachment
    const { message: responseMessage, files: allFiles } = handleLongResponse(finalResponse, outboundFiles);

    // Write to outgoing queue
    const responseData: ResponseData = {
        channel: conv.channel,
        sender: conv.sender,
        message: responseMessage,
        originalMessage: conv.originalMessage,
        timestamp: Date.now(),
        messageId: conv.messageId,
        files: allFiles.length > 0 ? allFiles : undefined,
    };

    const responseFile = conv.channel === 'heartbeat'
        ? path.join(QUEUE_OUTGOING, `${conv.messageId}.json`)
        : path.join(QUEUE_OUTGOING, `${conv.channel}_${conv.messageId}_${Date.now()}.json`);

    fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));

    log('INFO', `✓ Response ready [${conv.channel}] ${conv.sender} (${finalResponse.length} chars)`);
    emitEvent('response_ready', { channel: conv.channel, sender: conv.sender, responseLength: finalResponse.length, responseText: finalResponse, messageId: conv.messageId });

    // Capture episode for each agent that participated (background, non-blocking)
    const workspacePath = settings?.workspace?.path || path.join(require('os').homedir(), 'tinyclaw-workspace');
    for (const step of conv.responses) {
        const stepAgent = agents[step.agentId];
        if (stepAgent) {
            const agentWorkDir = stepAgent.working_directory
                ? (path.isAbsolute(stepAgent.working_directory) ? stepAgent.working_directory : path.join(workspacePath, stepAgent.working_directory))
                : path.join(workspacePath, step.agentId);
            captureEpisode(agentWorkDir, conv.sender, conv.originalMessage, step.response, step.agentId).catch(() => {});
        }
    }

    // Clean up
    conversations.delete(conv.id);
}

const PROCESS_START_TIME = Date.now();

/**
 * Build a health report for the /status command.
 * Runs fast checks: env, SSH reachability, recent errors.
 */
async function buildStatusReport(): Promise<string> {
    const lines: string[] = ['📊 *TinyClaw Status*', ''];

    // Uptime
    const uptimeSec = Math.floor((Date.now() - PROCESS_START_TIME) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    lines.push(`⏱ Uptime: ${h}h ${m}m ${s}s`);

    // ANTHROPIC_API_KEY
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    lines.push(`🔑 ANTHROPIC_API_KEY: ${hasKey ? '✅ set' : '❌ MISSING'}`);

    // SSH to MacBook
    try {
        execSync('ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes tim@100.114.149.44 echo pong', { timeout: 8000 });
        lines.push('💻 MacBook SSH: ✅ reachable');
    } catch {
        lines.push('💻 MacBook SSH: ❌ unreachable (Tailscale down? MacBook asleep?)');
    }

    // Claude on MacBook
    try {
        execSync('ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes tim@100.114.149.44 "/opt/homebrew/bin/claude --version"', { timeout: 10000 });
        lines.push('🤖 Claude on MacBook: ✅ accessible');
    } catch {
        lines.push('🤖 Claude on MacBook: ❌ not accessible');
    }

    // Recent errors from log
    try {
        const logFile = path.join(path.dirname(LOG_FILE), 'queue.log');
        if (fs.existsSync(logFile)) {
            const logContent = fs.readFileSync(logFile, 'utf8');
            const errorLines = logContent.split('\n')
                .filter(l => l.includes('[ERROR]'))
                .slice(-3);
            if (errorLines.length > 0) {
                lines.push('');
                lines.push('🚨 Recent errors:');
                errorLines.forEach(l => lines.push(`  ${l.substring(0, 120)}`));
            } else {
                lines.push('🚨 Recent errors: none');
            }
        }
    } catch {
        // skip
    }

    // Agents
    const settings = getSettings();
    const agents = getAgents(settings);
    lines.push('');
    lines.push(`👾 Agents: ${Object.keys(agents).join(', ')}`);
    lines.push(`🎯 Default: ${Object.keys(agents)[0]}`);

    return lines.join('\n');
}

// Process a single message
async function processMessage(messageFile: string): Promise<void> {
    const processingFile = path.join(QUEUE_PROCESSING, path.basename(messageFile));

    try {
        // Move to processing to mark as in-progress
        fs.renameSync(messageFile, processingFile);

        // Read message
        const messageData: MessageData = JSON.parse(fs.readFileSync(processingFile, 'utf8'));
        const { channel, sender, message: rawMessage, timestamp, messageId } = messageData;
        const isInternal = !!messageData.conversationId;
        const senderId = messageData.senderId || sender;

        log('INFO', `Processing [${isInternal ? 'internal' : channel}] ${isInternal ? `@${messageData.fromAgent}→@${messageData.agent}` : `from ${sender}`}: ${rawMessage.substring(0, 50)}...`);
        if (!isInternal) {
            emitEvent('message_received', { channel, sender, message: rawMessage.substring(0, 120), messageId });
        }

        // --- Built-in /status command (no agent needed) ---
        if (!isInternal && /^\/?(status|ping|health)$/i.test(rawMessage.trim())) {
            const statusMsg = await buildStatusReport();
            writeDirectResponse(channel, sender, senderId, messageId, statusMsg);
            fs.unlinkSync(processingFile);
            return;
        }

        // --- Approval reply check (only for external, non-internal messages) ---
        if (!isInternal && senderId) {
            const pendingApproval = loadApprovalState(senderId);
            if (pendingApproval) {
                const decision = parseApprovalReply(rawMessage);
                if (decision === 'approved') {
                    log('INFO', `Approval granted by ${sender} for: ${pendingApproval.description}`);
                    clearApprovalState(senderId);

                    // Re-invoke the agent with --continue to proceed with the approved action
                    const settings = getSettings();
                    const agents = getAgents(settings);
                    const teams = getTeams(settings);
                    const approvedAgent = agents[pendingApproval.agentId];
                    if (approvedAgent) {
                        let approvedResponse: string;
                        try {
                            approvedResponse = await invokeAgent(
                                approvedAgent,
                                pendingApproval.agentId,
                                `The user approved the action: "${pendingApproval.description}". Please proceed.`,
                                pendingApproval.workspacePath,
                                false, // continue conversation
                                agents,
                                teams
                            );
                        } catch (err) {
                            approvedResponse = `Error executing approved action: ${(err as Error).message}`;
                        }
                        writeDirectResponse(channel, sender, senderId, messageId, approvedResponse);
                    } else {
                        writeDirectResponse(channel, sender, senderId, messageId, 'Approved, but agent is no longer available.');
                    }
                    fs.unlinkSync(processingFile);
                    return;
                } else if (decision === 'denied') {
                    log('INFO', `Approval denied by ${sender} for: ${pendingApproval.description}`);
                    clearApprovalState(senderId);
                    writeDirectResponse(channel, sender, senderId, messageId, `🚫 Cancelled. Action aborted: ${pendingApproval.description}`);
                    fs.unlinkSync(processingFile);
                    return;
                }
                // Not an approval reply — fall through to normal processing
            }
        }

        // Get settings, agents, and teams
        const settings = getSettings();
        const agents = getAgents(settings);
        const teams = getTeams(settings);

        // Get workspace path from settings
        const workspacePath = settings?.workspace?.path || path.join(require('os').homedir(), 'tinyclaw-workspace');

        // Route message to agent (or team)
        let agentId: string;
        let message: string;
        let isTeamRouted = false;

        if (messageData.agent && agents[messageData.agent]) {
            // Pre-routed (by channel client or internal message)
            agentId = messageData.agent;
            message = rawMessage;
        } else {
            // Parse @agent or @team prefix
            const routing = parseAgentRouting(rawMessage, agents, teams);
            agentId = routing.agentId;
            message = routing.message;
            isTeamRouted = !!routing.isTeam;
        }

        // Easter egg: Handle multiple agent mentions (only for external messages)
        if (!isInternal && agentId === 'error') {
            log('INFO', `Multiple agents detected, sending easter egg message`);

            const responseFile = path.join(QUEUE_OUTGOING, path.basename(processingFile));
            const responseData: ResponseData = {
                channel,
                sender,
                message: message,
                originalMessage: rawMessage,
                timestamp: Date.now(),
                messageId,
            };

            fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));
            fs.unlinkSync(processingFile);
            log('INFO', `✓ Easter egg sent to ${sender}`);
            return;
        }

        // Fall back to default if agent not found
        if (!agents[agentId]) {
            agentId = 'default';
            message = rawMessage;
        }

        // Final fallback: use first available agent if no default
        if (!agents[agentId]) {
            agentId = Object.keys(agents)[0];
        }

        const agent = agents[agentId];
        log('INFO', `Routing to agent: ${agent.name} (${agentId}) [${agent.provider}/${agent.model}]`);
        if (!isInternal) {
            emitEvent('agent_routed', { agentId, agentName: agent.name, provider: agent.provider, model: agent.model, isTeamRouted });
        }

        // Determine team context
        let teamContext: { teamId: string; team: TeamConfig } | null = null;
        if (isInternal) {
            // Internal messages inherit team context from their conversation
            const conv = conversations.get(messageData.conversationId!);
            if (conv) teamContext = conv.teamContext;
        } else {
            if (isTeamRouted) {
                for (const [tid, t] of Object.entries(teams)) {
                    if (t.leader_agent === agentId && t.agents.includes(agentId)) {
                        teamContext = { teamId: tid, team: t };
                        break;
                    }
                }
            }
            if (!teamContext) {
                teamContext = findTeamForAgent(agentId, teams);
            }
        }

        // Check for per-agent reset
        const agentResetFlag = getAgentResetFlag(agentId, workspacePath);
        const shouldReset = fs.existsSync(agentResetFlag);

        if (shouldReset) {
            fs.unlinkSync(agentResetFlag);
        }

        // For internal messages: append pending response indicator so the agent
        // knows other teammates are still processing and won't re-mention them.
        if (isInternal && messageData.conversationId) {
            const conv = conversations.get(messageData.conversationId);
            if (conv) {
                // pending includes this message (not yet decremented), so subtract 1 for "others"
                const othersPending = conv.pending - 1;
                if (othersPending > 0) {
                    message += `\n\n------\n\n[${othersPending} other teammate response(s) are still being processed and will be delivered when ready. Do not re-mention teammates who haven't responded yet.]`;
                }
            }
        }

        // Prepend approval gate instruction for non-internal messages
        // Inject recent conversation history + Supermemory relevant memories
        let messageWithConfirmInstruction: string;
        if (isInternal) {
            messageWithConfirmInstruction = message;
        } else {
            // Recent turns (in-memory, fast)
            const history = getHistory(senderId, agentId);
            const historyPrefix = buildHistoryPrefix(history);
            // Relevant long-term memories (Supermemory, async)
            const memoryPrefix = await searchMemory(senderId, rawMessage);
            messageWithConfirmInstruction = buildConfirmInstruction() + memoryPrefix + historyPrefix + message;
            // Store this user message in recent history
            addToHistory(senderId, agentId, 'user', rawMessage);
        }

        // Invoke agent
        emitEvent('chain_step_start', { agentId, agentName: agent.name, fromAgent: messageData.fromAgent || null });
        let response: string;
        try {
            response = await invokeAgent(agent, agentId, messageWithConfirmInstruction, workspacePath, shouldReset, agents, teams);
        } catch (error) {
            const provider = agent.provider || 'anthropic';
            const errMsg = (error as Error).message;
            log('ERROR', `${provider === 'openai' ? 'Codex' : 'Claude'} error (agent: ${agentId}): ${errMsg}`);
            // Return actual error to user so they can diagnose from phone
            const preview = errMsg.length > 400 ? errMsg.substring(0, 400) + '…' : errMsg;
            response = `⚠️ Agent error (${agentId}): ${preview}`;
        }

        // Store assistant response in history (for external messages only)
        if (!isInternal) {
            addToHistory(senderId, agentId, 'assistant', response);
            // Persist to Supermemory in background (non-blocking)
            storeMemory(senderId, agentId, rawMessage, response).catch(() => {});
        }

        emitEvent('chain_step_done', { agentId, agentName: agent.name, responseLength: response.length, responseText: response });

        // --- Approval gate check ---
        if (!isInternal) {
            const confirmDescription = detectConfirmRequired(response);
            if (confirmDescription) {
                log('INFO', `CONFIRM_REQUIRED detected for agent ${agentId}: ${confirmDescription}`);

                const approvalState: ApprovalState = {
                    agentId,
                    senderId,
                    channel,
                    sender,
                    messageId,
                    originalMessage: rawMessage,
                    description: confirmDescription,
                    workspacePath,
                    agentWorkingDir: agent.working_directory
                        ? (path.isAbsolute(agent.working_directory) ? agent.working_directory : path.join(workspacePath, agent.working_directory))
                        : path.join(workspacePath, agentId),
                    timestamp: Date.now(),
                };
                saveApprovalState(approvalState);

                const approvalMessage = buildApprovalMessage(agentId, confirmDescription, rawMessage);
                writeDirectResponse(channel, sender, senderId, messageId, approvalMessage);

                fs.unlinkSync(processingFile);
                return;
            }
        }

        // --- No team context: simple response to user ---
        if (!teamContext) {
            let finalResponse = response.trim();

            // Detect files
            const outboundFilesSet = new Set<string>();
            collectFiles(finalResponse, outboundFilesSet);
            const outboundFiles = Array.from(outboundFilesSet);
            if (outboundFiles.length > 0) {
                finalResponse = finalResponse.replace(/\[send_file:\s*[^\]]+\]/g, '').trim();
            }

            // Handle long responses — split into multiple messages
            const { message: responseMessage, files: allFiles, extraChunks } = handleLongResponse(finalResponse, outboundFiles);

            const responseData: ResponseData = {
                channel,
                sender,
                message: responseMessage,
                originalMessage: rawMessage,
                timestamp: Date.now(),
                messageId,
                agent: agentId,
                files: allFiles.length > 0 ? allFiles : undefined,
            };

            const responseFile = channel === 'heartbeat'
                ? path.join(QUEUE_OUTGOING, `${messageId}.json`)
                : path.join(QUEUE_OUTGOING, `${channel}_${messageId}_${Date.now()}.json`);

            fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));

            // Write extra chunks as follow-up messages (sequential timestamps)
            if (extraChunks && extraChunks.length > 0 && channel !== 'heartbeat') {
                extraChunks.forEach((chunk, i) => {
                    const chunkData: ResponseData = {
                        channel, sender,
                        message: chunk,
                        originalMessage: '',
                        timestamp: Date.now() + i + 1,
                        messageId: `${messageId}_chunk${i + 2}`,
                        agent: agentId,
                    };
                    fs.writeFileSync(
                        path.join(QUEUE_OUTGOING, `${channel}_${messageId}_chunk${i + 2}_${Date.now() + i + 1}.json`),
                        JSON.stringify(chunkData, null, 2)
                    );
                });
                log('INFO', `Split into ${(extraChunks?.length ?? 0) + 1} messages`);
            }

            log('INFO', `✓ Response ready [${channel}] ${sender} via agent:${agentId} (${finalResponse.length} chars)`);
            emitEvent('response_ready', { channel, sender, agentId, responseLength: finalResponse.length, responseText: finalResponse, messageId });

            // Capture episode in background (non-blocking)
            const soloWorkingDir = agent.working_directory
                ? (path.isAbsolute(agent.working_directory) ? agent.working_directory : path.join(workspacePath, agent.working_directory))
                : path.join(workspacePath, agentId);
            captureEpisode(soloWorkingDir, sender, rawMessage, finalResponse, agentId).catch(() => {});

            fs.unlinkSync(processingFile);
            return;
        }

        // --- Team context: conversation-based message passing ---

        // Get or create conversation
        let conv: Conversation;
        if (isInternal && messageData.conversationId && conversations.has(messageData.conversationId)) {
            conv = conversations.get(messageData.conversationId)!;
        } else {
            // New conversation
            const convId = `${messageId}_${Date.now()}`;
            conv = {
                id: convId,
                channel,
                sender,
                originalMessage: rawMessage,
                messageId,
                pending: 1, // this initial message
                responses: [],
                files: new Set(),
                totalMessages: 0,
                maxMessages: MAX_CONVERSATION_MESSAGES,
                teamContext,
                startTime: Date.now(),
                outgoingMentions: new Map(),
            };
            conversations.set(convId, conv);
            log('INFO', `Conversation started: ${convId} (team: ${teamContext.team.name})`);
            emitEvent('team_chain_start', { teamId: teamContext.teamId, teamName: teamContext.team.name, agents: teamContext.team.agents, leader: teamContext.team.leader_agent });
        }

        // Record this agent's response
        conv.responses.push({ agentId, response });
        conv.totalMessages++;
        collectFiles(response, conv.files);

        // Check for teammate mentions
        const teammateMentions = extractTeammateMentions(
            response, agentId, conv.teamContext.teamId, teams, agents
        );

        if (teammateMentions.length > 0 && conv.totalMessages < conv.maxMessages) {
            // Enqueue internal messages for each mention
            conv.pending += teammateMentions.length;
            conv.outgoingMentions.set(agentId, teammateMentions.length);
            for (const mention of teammateMentions) {
                log('INFO', `@${agentId} → @${mention.teammateId}`);
                emitEvent('chain_handoff', { teamId: conv.teamContext.teamId, fromAgent: agentId, toAgent: mention.teammateId });

                const internalMsg = `[Message from teammate @${agentId}]:\n${mention.message}`;
                enqueueInternalMessage(conv.id, agentId, mention.teammateId, internalMsg, messageData);
            }
        } else if (teammateMentions.length > 0) {
            log('WARN', `Conversation ${conv.id} hit max messages (${conv.maxMessages}) — not enqueuing further mentions`);
        }

        // This branch is done
        conv.pending--;

        if (conv.pending === 0) {
            completeConversation(conv);
        } else {
            log('INFO', `Conversation ${conv.id}: ${conv.pending} branch(es) still pending`);
        }

        // Clean up processing file
        fs.unlinkSync(processingFile);

    } catch (error) {
        log('ERROR', `Processing error: ${(error as Error).message}`);

        // Move back to incoming for retry
        if (fs.existsSync(processingFile)) {
            try {
                fs.renameSync(processingFile, messageFile);
            } catch (e) {
                log('ERROR', `Failed to move file back: ${(e as Error).message}`);
            }
        }
    }
}

// Per-agent processing chains - ensures messages to same agent are sequential
const agentProcessingChains = new Map<string, Promise<void>>();

/**
 * Peek at a message file to determine which agent it's routed to.
 * Also resolves team IDs to their leader agent.
 */
function peekAgentId(filePath: string): string {
    try {
        const messageData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const settings = getSettings();
        const agents = getAgents(settings);
        const teams = getTeams(settings);

        // Check for pre-routed agent
        if (messageData.agent && agents[messageData.agent]) {
            return messageData.agent;
        }

        // Parse @agent_id or @team_id prefix
        const routing = parseAgentRouting(messageData.message || '', agents, teams);
        return routing.agentId || 'default';
    } catch {
        return 'default';
    }
}

// Main processing loop
async function processQueue(): Promise<void> {
    try {
        // Get all files from incoming queue, sorted by timestamp
        const files: QueueFile[] = fs.readdirSync(QUEUE_INCOMING)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                name: f,
                path: path.join(QUEUE_INCOMING, f),
                time: fs.statSync(path.join(QUEUE_INCOMING, f)).mtimeMs
            }))
            .sort((a, b) => a.time - b.time);

        if (files.length > 0) {
            log('DEBUG', `Found ${files.length} message(s) in queue`);

            // Process messages in parallel by agent (sequential within each agent)
            for (const file of files) {
                // Skip files already queued in a promise chain
                if (queuedFiles.has(file.name)) continue;
                queuedFiles.add(file.name);

                // Determine target agent
                const agentId = peekAgentId(file.path);

                // Get or create promise chain for this agent
                const currentChain = agentProcessingChains.get(agentId) || Promise.resolve();

                // Chain this message to the agent's promise
                const newChain = currentChain
                    .then(() => processMessage(file.path))
                    .catch(error => {
                        log('ERROR', `Error processing message for agent ${agentId}: ${error.message}`);
                    })
                    .finally(() => {
                        queuedFiles.delete(file.name);
                    });

                // Update the chain
                agentProcessingChains.set(agentId, newChain);

                // Clean up completed chains to avoid memory leaks
                newChain.finally(() => {
                    if (agentProcessingChains.get(agentId) === newChain) {
                        agentProcessingChains.delete(agentId);
                    }
                });
            }
        }
    } catch (error) {
        log('ERROR', `Queue processing error: ${(error as Error).message}`);
    }
}

// Log agent and team configuration on startup
function logAgentConfig(): void {
    const settings = getSettings();
    const agents = getAgents(settings);
    const teams = getTeams(settings);

    const agentCount = Object.keys(agents).length;
    log('INFO', `Loaded ${agentCount} agent(s):`);
    for (const [id, agent] of Object.entries(agents)) {
        log('INFO', `  ${id}: ${agent.name} [${agent.provider}/${agent.model}] cwd=${agent.working_directory}`);
    }

    const teamCount = Object.keys(teams).length;
    if (teamCount > 0) {
        log('INFO', `Loaded ${teamCount} team(s):`);
        for (const [id, team] of Object.entries(teams)) {
            log('INFO', `  ${id}: ${team.name} [agents: ${team.agents.join(', ')}] leader=${team.leader_agent}`);
        }
    }
}

// Ensure events dir exists
if (!fs.existsSync(EVENTS_DIR)) {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
}

// Main loop
log('INFO', 'Queue processor started');
recoverOrphanedFiles();
log('INFO', `Watching: ${QUEUE_INCOMING}`);
logAgentConfig();
emitEvent('processor_start', { agents: Object.keys(getAgents(getSettings())), teams: Object.keys(getTeams(getSettings())) });

// Process queue every 1 second
setInterval(processQueue, 1000);

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down queue processor...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down queue processor...');
    process.exit(0);
});
