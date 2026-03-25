/**
 * WhatsApp HTTP API for TinyClaw
 * Exposes the running WhatsApp client via REST endpoints.
 * Reuses the existing client singleton — no new WhatsApp sessions.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { Client, Chat, Message, MessageMedia } from 'whatsapp-web.js';

const SECRETS_DIR = path.join(require('os').homedir(), '.secrets');
const API_KEY_FILE = path.join(SECRETS_DIR, 'whatsapp-api-key');
const EXPORTS_DIR = path.join(require('os').homedir(), '.tinyclaw', 'exports');

// Ensure exports directory exists
if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

function loadApiKey(): string {
    try {
        return fs.readFileSync(API_KEY_FILE, 'utf8').trim();
    } catch {
        console.error(`[whatsapp-api] WARNING: No API key file at ${API_KEY_FILE}. API auth disabled.`);
        return '';
    }
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function parseUrl(url: string): { pathname: string; params: URLSearchParams } {
    const parsed = new URL(url, 'http://localhost');
    return { pathname: parsed.pathname, params: parsed.searchParams };
}

function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [whatsapp-api] [${level}] ${message}`);
}

export function createApiServer(client: Client): http.Server {
    let apiKey = loadApiKey();

    // Reload API key periodically (every 5 min) so rotation doesn't require restart
    setInterval(() => { apiKey = loadApiKey(); }, 5 * 60 * 1000);

    const server = http.createServer(async (req, res) => {
        const method = req.method || 'GET';
        const { pathname, params } = parseUrl(req.url || '/');

        // CORS headers for local dev
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'X-Api-Key, Content-Type');
        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Auth check (skip for health endpoint)
        if (pathname !== '/api/health') {
            const reqKey = req.headers['x-api-key'] as string;
            if (apiKey && reqKey !== apiKey) {
                json(res, 401, { error: 'Unauthorized' });
                return;
            }
        }

        try {
            // GET /api/health
            if (method === 'GET' && pathname === '/api/health') {
                const info = client.info;
                json(res, 200, {
                    status: 'ok',
                    connected: !!info,
                    phone: info?.wid?.user || null,
                    timestamp: Date.now(),
                });
                return;
            }

            // GET /api/chats
            if (method === 'GET' && pathname === '/api/chats') {
                const chats = await client.getChats();
                const result = chats.map((chat: Chat) => ({
                    id: chat.id._serialized,
                    name: chat.name,
                    isGroup: chat.isGroup,
                    lastMessage: chat.lastMessage?.body?.substring(0, 100) || null,
                    timestamp: chat.lastMessage?.timestamp || null,
                }));
                json(res, 200, { chats: result });
                return;
            }

            // GET /api/contacts?q=<name>
            if (method === 'GET' && pathname === '/api/contacts') {
                const query = (params.get('q') || '').toLowerCase();
                if (!query) {
                    json(res, 400, { error: 'Missing ?q= parameter' });
                    return;
                }
                const contacts = await client.getContacts();
                const matches = contacts
                    .filter(c => {
                        const name = (c.pushname || c.name || '').toLowerCase();
                        return name.includes(query);
                    })
                    .map(c => ({
                        id: c.id._serialized,
                        name: c.pushname || c.name || c.id.user,
                        isMyContact: c.isMyContact,
                        isGroup: c.isGroup,
                    }));
                json(res, 200, { contacts: matches });
                return;
            }

            // GET /api/chats/:chatId/messages?limit=100&after=<timestamp>
            const msgMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
            if (method === 'GET' && msgMatch) {
                const chatId = decodeURIComponent(msgMatch[1]);
                const limit = parseInt(params.get('limit') || '100', 10);
                const after = parseInt(params.get('after') || '0', 10);

                const chat = await client.getChatById(chatId);
                const messages = await chat.fetchMessages({ limit: Math.min(limit, 5000) });

                const filtered = messages
                    .filter((m: Message) => !after || (m.timestamp * 1000) > after)
                    .map((m: Message) => ({
                        id: m.id._serialized,
                        from: m.from,
                        fromMe: m.fromMe,
                        body: m.body,
                        timestamp: m.timestamp,
                        type: m.type,
                        hasMedia: m.hasMedia,
                    }));

                json(res, 200, { chatId, count: filtered.length, messages: filtered });
                return;
            }

            // POST /api/chats/:chatId/export
            const exportMatch = pathname.match(/^\/api\/chats\/([^/]+)\/export$/);
            if (method === 'POST' && exportMatch) {
                const chatId = decodeURIComponent(exportMatch[1]);
                const chat = await client.getChatById(chatId);
                const chatName = chat.name.replace(/[^a-zA-Z0-9_-]/g, '_');

                log('INFO', `Exporting chat: ${chat.name} (${chatId})`);

                // Fetch messages in batches
                const allMessages: any[] = [];
                let fetched = await chat.fetchMessages({ limit: 500 });
                allMessages.push(...fetched);

                // whatsapp-web.js fetchMessages with limit is the max we can do per call.
                // For very large chats, we fetch what we can (500 is the practical max).
                log('INFO', `Fetched ${allMessages.length} messages from ${chat.name}`);

                const exportData = {
                    chatId,
                    chatName: chat.name,
                    isGroup: chat.isGroup,
                    exportedAt: new Date().toISOString(),
                    messageCount: allMessages.length,
                    messages: allMessages.map((m: Message) => ({
                        id: m.id._serialized,
                        from: m.from,
                        fromMe: m.fromMe,
                        body: m.body,
                        timestamp: m.timestamp,
                        type: m.type,
                        hasMedia: m.hasMedia,
                    })),
                };

                const filename = `${chatName}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
                const filepath = path.join(EXPORTS_DIR, filename);
                fs.writeFileSync(filepath, JSON.stringify(exportData, null, 2));

                log('INFO', `Export saved: ${filename} (${allMessages.length} messages)`);

                json(res, 200, {
                    filename,
                    path: filepath,
                    messageCount: allMessages.length,
                    chatName: chat.name,
                });
                return;
            }

            // GET /api/exports/:filename
            const dlMatch = pathname.match(/^\/api\/exports\/([^/]+)$/);
            if (method === 'GET' && dlMatch) {
                const filename = decodeURIComponent(dlMatch[1]);
                // Sanitize: no path traversal
                if (filename.includes('..') || filename.includes('/')) {
                    json(res, 400, { error: 'Invalid filename' });
                    return;
                }
                const filepath = path.join(EXPORTS_DIR, filename);
                if (!fs.existsSync(filepath)) {
                    json(res, 404, { error: 'Export not found' });
                    return;
                }
                const stat = fs.statSync(filepath);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Content-Length': stat.size,
                    'Content-Disposition': `attachment; filename="${filename}"`,
                });
                fs.createReadStream(filepath).pipe(res);
                return;
            }

            // GET /api/exports — list all export files
            if (method === 'GET' && pathname === '/api/exports') {
                const files = fs.readdirSync(EXPORTS_DIR)
                    .filter(f => f.endsWith('.json'))
                    .map(f => {
                        const stat = fs.statSync(path.join(EXPORTS_DIR, f));
                        return { filename: f, size: stat.size, created: stat.birthtime.toISOString() };
                    })
                    .sort((a, b) => b.created.localeCompare(a.created));
                json(res, 200, { exports: files });
                return;
            }

            // GET /api/search?q=<query>&chatId=<optional>&limit=100
            if (method === 'GET' && pathname === '/api/search') {
                const query = params.get('q') || '';
                if (!query) {
                    json(res, 400, { error: 'Missing ?q= parameter' });
                    return;
                }
                const chatId = params.get('chatId') || undefined;
                const limit = parseInt(params.get('limit') || '100', 10);

                log('INFO', `Searching messages: q="${query}" chatId=${chatId || 'all'} limit=${limit}`);

                const results = await client.searchMessages(query, { chatId, limit: Math.min(limit, 500) });
                const mapped = results.map((m: Message) => ({
                    id: m.id._serialized,
                    from: m.from,
                    fromMe: m.fromMe,
                    body: m.body,
                    timestamp: m.timestamp,
                    type: m.type,
                    hasMedia: m.hasMedia,
                }));

                json(res, 200, { query, count: mapped.length, messages: mapped });
                return;
            }

            // GET /api/messages/:messageId/media — download media from a specific message
            const mediaMatch = pathname.match(/^\/api\/messages\/([^/]+)\/media$/);
            if (method === 'GET' && mediaMatch) {
                const messageId = decodeURIComponent(mediaMatch[1]);

                // Extract chat ID from message ID format: {fromMe}_{chatId}_{uniqueId}
                const parts = messageId.split('_');
                if (parts.length < 3) {
                    json(res, 400, { error: 'Invalid message ID format. Expected: {fromMe}_{chatId}_{uniqueId}' });
                    return;
                }
                // Chat ID is the middle part(s) — everything between first and last underscore-delimited segments
                const chatId = parts.slice(1, -1).join('_');

                log('INFO', `Media download request: messageId=${messageId}, chatId=${chatId}`);

                const chat = await client.getChatById(chatId);
                const messages = await chat.fetchMessages({ limit: 5000 });
                const target = messages.find((m: Message) => m.id._serialized === messageId);

                if (!target) {
                    json(res, 404, { error: 'Message not found in recent messages (searched last 500)' });
                    return;
                }

                if (!target.hasMedia) {
                    json(res, 400, { error: 'Message does not contain media', type: target.type });
                    return;
                }

                const media = await target.downloadMedia();
                if (!media || !media.data) {
                    json(res, 500, { error: 'Failed to download media from WhatsApp' });
                    return;
                }

                const buffer = Buffer.from(media.data, 'base64');
                const mimeExt: Record<string, string> = {
                    'video/mp4': '.mp4', 'image/jpeg': '.jpg', 'image/png': '.png',
                    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
                    'application/pdf': '.pdf',
                };
                const ext = mimeExt[media.mimetype || ''] || '.bin';

                res.writeHead(200, {
                    'Content-Type': media.mimetype || 'application/octet-stream',
                    'Content-Length': buffer.length,
                    'Content-Disposition': `attachment; filename="media_${Date.now()}${ext}"`,
                });
                res.end(buffer);
                return;
            }

            // 404 fallback
            json(res, 404, { error: 'Not found', availableEndpoints: [
                'GET /api/health',
                'GET /api/chats',
                'GET /api/contacts?q=<name>',
                'GET /api/chats/:chatId/messages?limit=100&after=<timestamp>',
                'GET /api/messages/:messageId/media',
                'POST /api/chats/:chatId/export',
                'GET /api/exports',
                'GET /api/exports/:filename',
            ]});

        } catch (err) {
            log('ERROR', `API error: ${(err as Error).message}`);
            json(res, 500, { error: (err as Error).message });
        }
    });

    return server;
}
