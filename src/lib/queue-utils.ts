/**
 * Pure utility functions for queue processing.
 * The local module remains as a thin compatibility wrapper over the
 * canonical shared capability extracted into `chat-queue-utils`.
 */

import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';

export const TELEGRAM_MAX_CHARS = 4000;
export const MAX_HISTORY_ENTRIES = 10;
export const MAX_HISTORY_CHARS = 6000;
export const MAX_ENTRY_CHARS = 2000;

export interface HistoryEntry { role: 'user' | 'assistant'; content: string; }

interface ChatQueueUtilsModule {
    splitIntoChunks(text: string, maxChars?: number): string[];
    buildHistoryPrefix(history: HistoryEntry[], maxChars?: number): string;
    addToHistory(
        chatHistory: Map<string, HistoryEntry[]>,
        senderId: string,
        agentId: string,
        role: 'user' | 'assistant',
        content: string
    ): void;
    getHistory(
        chatHistory: Map<string, HistoryEntry[]>,
        senderId: string,
        agentId: string
    ): HistoryEntry[];
    collectFiles(response: string, fileSet: Set<string>, existsCheck?: (filePath: string) => boolean): void;
}

let capabilityModule: ChatQueueUtilsModule | null | undefined;

function findYngRoot(startDir: string): string | null {
    let current = startDir;
    while (true) {
        if (basename(current) === 'YNG') {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}

function useChatQueueUtilsCapability(): boolean {
    return (process.env.TINYCLAW_USE_CHAT_QUEUE_UTILS_CAPABILITY || 'true').toLowerCase() !== 'false';
}

function resolveCapabilityPath(): string {
    const candidates: string[] = [];
    const override = process.env.TINYCLAW_CHAT_QUEUE_UTILS_CAPABILITY_PATH;
    if (override) {
        candidates.push(override, join(override, 'src', 'index.cjs'), join(override, 'index.cjs'));
    }

    const yngRoot = findYngRoot(__dirname);
    if (yngRoot) {
        candidates.push(
            join(
                yngRoot,
                '02_projects',
                'capabilities',
                'app-agnostic',
                'chat-queue-utils',
                'src',
                'index.cjs'
            )
        );
    }

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(`chat-queue-utils capability not found. Checked: ${candidates.join(', ')}`);
}

function loadCapabilityModule(): ChatQueueUtilsModule | null {
    if (capabilityModule !== undefined) {
        return capabilityModule;
    }

    if (!useChatQueueUtilsCapability()) {
        capabilityModule = null;
        return capabilityModule;
    }

    capabilityModule = require(resolveCapabilityPath()) as ChatQueueUtilsModule;
    return capabilityModule;
}

function legacySplitIntoChunks(text: string, maxChars = TELEGRAM_MAX_CHARS): string[] {
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxChars) {
        let splitAt = maxChars;

        const paraBreak = remaining.lastIndexOf('\n\n', maxChars);
        if (paraBreak > maxChars * 0.5) {
            splitAt = paraBreak + 2;
        } else {
            const lineBreak = remaining.lastIndexOf('\n', maxChars);
            if (lineBreak > maxChars * 0.5) {
                splitAt = lineBreak + 1;
            }
        }

        chunks.push(remaining.substring(0, splitAt).trimEnd());
        remaining = remaining.substring(splitAt).trimStart();
    }

    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
}

function legacyBuildHistoryPrefix(history: HistoryEntry[], maxChars = MAX_HISTORY_CHARS): string {
    if (history.length === 0) return '';
    let block = '[RECENT CONVERSATION HISTORY]\n';
    let totalChars = 0;
    const toInclude: HistoryEntry[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
        totalChars += history[i].content.length;
        if (totalChars > maxChars) break;
        toInclude.unshift(history[i]);
    }
    for (const entry of toInclude) {
        block += `${entry.role === 'user' ? 'Tim' : 'Assistant'}: ${entry.content}\n`;
    }
    block += '[END HISTORY]\n\n';
    return block;
}

function legacyAddToHistory(
    chatHistory: Map<string, HistoryEntry[]>,
    senderId: string,
    agentId: string,
    role: 'user' | 'assistant',
    content: string
): void {
    const key = `${senderId}:${agentId}`;
    const history = chatHistory.get(key) || [];
    history.push({ role, content: content.substring(0, MAX_ENTRY_CHARS) });
    if (history.length > MAX_HISTORY_ENTRIES) history.splice(0, history.length - MAX_HISTORY_ENTRIES);
    chatHistory.set(key, history);
}

function legacyGetHistory(
    chatHistory: Map<string, HistoryEntry[]>,
    senderId: string,
    agentId: string
): HistoryEntry[] {
    return chatHistory.get(`${senderId}:${agentId}`) || [];
}

function legacyCollectFiles(
    response: string,
    fileSet: Set<string>,
    existsCheck: (filePath: string) => boolean = existsSync
): void {
    const fileRegex = /\[send_file:\s*([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(response)) !== null) {
        const filePath = match[1].trim();
        if (existsCheck(filePath)) fileSet.add(filePath);
    }
}

export function splitIntoChunks(text: string, maxChars = TELEGRAM_MAX_CHARS): string[] {
    return (loadCapabilityModule()?.splitIntoChunks ?? legacySplitIntoChunks)(text, maxChars);
}

export function buildHistoryPrefix(history: HistoryEntry[], maxChars = MAX_HISTORY_CHARS): string {
    return (loadCapabilityModule()?.buildHistoryPrefix ?? legacyBuildHistoryPrefix)(history, maxChars);
}

export function addToHistory(
    chatHistory: Map<string, HistoryEntry[]>,
    senderId: string,
    agentId: string,
    role: 'user' | 'assistant',
    content: string
): void {
    (loadCapabilityModule()?.addToHistory ?? legacyAddToHistory)(chatHistory, senderId, agentId, role, content);
}

export function getHistory(
    chatHistory: Map<string, HistoryEntry[]>,
    senderId: string,
    agentId: string
): HistoryEntry[] {
    return (loadCapabilityModule()?.getHistory ?? legacyGetHistory)(chatHistory, senderId, agentId);
}

export function collectFiles(
    response: string,
    fileSet: Set<string>,
    existsCheck: (filePath: string) => boolean = existsSync
): void {
    (loadCapabilityModule()?.collectFiles ?? legacyCollectFiles)(response, fileSet, existsCheck);
}
