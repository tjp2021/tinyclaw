/**
 * Supermemory integration for TinyClaw.
 * Stores every conversation turn and retrieves relevant context before each message.
 */

import { log } from './logging';

let client: any = null;

function getClient(): any | null {
    if (client) return client;
    const apiKey = process.env.SUPERMEMORY_API_KEY;
    if (!apiKey) {
        log('WARN', 'SUPERMEMORY_API_KEY not set — memory disabled');
        return null;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sm = require('supermemory');
        client = new sm.default({ apiKey });
        log('INFO', 'Supermemory client initialized');
        return client;
    } catch (e) {
        log('WARN', `Supermemory init failed: ${(e as Error).message}`);
        return null;
    }
}

/**
 * Store a conversation turn in Supermemory.
 * Called after each message/response pair.
 */
export async function storeMemory(
    senderId: string,
    agentId: string,
    userMessage: string,
    agentResponse: string
): Promise<void> {
    const sm = getClient();
    if (!sm) return;
    try {
        const content = `[${new Date().toISOString()}] Conversation with ${agentId}\nUser: ${userMessage.substring(0, 1000)}\nAssistant: ${agentResponse.substring(0, 1000)}`;
        await sm.documents.add({
            content,
            metadata: { userId: senderId, agentId, source: 'tinyclaw', type: 'conversation' },
        });
    } catch (e) {
        log('WARN', `Supermemory store failed: ${(e as Error).message}`);
    }
}

/**
 * Search Supermemory for memories relevant to the current message.
 * Returns a formatted string to prepend to the prompt, or empty string if nothing found.
 */
export async function searchMemory(
    senderId: string,
    query: string
): Promise<string> {
    const sm = getClient();
    if (!sm) return '';
    try {
        const results = await sm.search.execute({
            q: query.substring(0, 500),
            limit: 5,
        });

        if (!results?.results?.length) return '';

        const chunks: string[] = [];
        for (const result of results.results) {
            if (result.chunks) {
                for (const chunk of result.chunks) {
                    if (chunk.content) chunks.push(chunk.content.substring(0, 400));
                }
            }
            if (chunks.length >= 5) break;
        }

        if (chunks.length === 0) return '';

        return `[RELEVANT MEMORIES FROM PAST CONVERSATIONS]\n${chunks.join('\n---\n')}\n[END MEMORIES]\n\n`;
    } catch (e) {
        log('WARN', `Supermemory search failed: ${(e as Error).message}`);
        return '';
    }
}
