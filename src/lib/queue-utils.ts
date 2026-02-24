/**
 * Pure utility functions for queue processing.
 * Extracted here so they can be unit tested independently of queue-processor.ts
 */

export const TELEGRAM_MAX_CHARS = 4000;
export const MAX_HISTORY_ENTRIES = 10;
export const MAX_HISTORY_CHARS = 6000;
export const MAX_ENTRY_CHARS = 2000;

export interface HistoryEntry { role: 'user' | 'assistant'; content: string; }

/**
 * Split a response into Telegram-safe chunks at natural boundaries.
 * Returns array of strings, each under maxChars.
 */
export function splitIntoChunks(text: string, maxChars = TELEGRAM_MAX_CHARS): string[] {
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxChars) {
        let splitAt = maxChars;

        // Try to split at a paragraph boundary
        const paraBreak = remaining.lastIndexOf('\n\n', maxChars);
        if (paraBreak > maxChars * 0.5) {
            splitAt = paraBreak + 2;
        } else {
            // Fall back to newline
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

/**
 * Build a history prefix string to prepend to agent messages.
 * Walks backwards through history, including as many entries as fit in maxChars.
 */
export function buildHistoryPrefix(history: HistoryEntry[], maxChars = MAX_HISTORY_CHARS): string {
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

/**
 * Add a message to chat history, capping entries and per-entry size.
 */
export function addToHistory(
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

/**
 * Retrieve history for a sender+agent pair.
 */
export function getHistory(
    chatHistory: Map<string, HistoryEntry[]>,
    senderId: string,
    agentId: string
): HistoryEntry[] {
    return chatHistory.get(`${senderId}:${agentId}`) || [];
}

/**
 * Extract [send_file: /path] references from a response.
 * Only adds paths that actually exist on disk.
 */
export function collectFiles(response: string, fileSet: Set<string>, existsCheck = require('fs').existsSync): void {
    const fileRegex = /\[send_file:\s*([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(response)) !== null) {
        const filePath = match[1].trim();
        if (existsCheck(filePath)) fileSet.add(filePath);
    }
}
