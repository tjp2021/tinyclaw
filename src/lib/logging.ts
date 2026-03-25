import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { EVENTS_DIR } from './config';

/**
 * Structured Pino logger for TinyClaw.
 *
 * JSON output to stdout (PM2 captures it). No sync file writes.
 * OTel PinoInstrumentation will inject trace_id/span_id when active.
 */
export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
        level: (label) => ({ level: label }),
    },
    base: { service: 'tinyclaw' },
});

/**
 * Backwards-compatible log function.
 * Maps string levels to Pino levels. Callers can migrate to logger.info() etc. over time.
 */
export function log(level: string, message: string): void {
    const pinoLevel = level.toLowerCase();
    switch (pinoLevel) {
        case 'error':
            logger.error(message);
            break;
        case 'warn':
        case 'warning':
            logger.warn(message);
            break;
        case 'debug':
            logger.debug(message);
            break;
        default:
            logger.info(message);
            break;
    }
}

/**
 * Emit a structured event for the team visualizer TUI.
 * Events are written as JSON files to EVENTS_DIR, watched by the visualizer.
 */
export function emitEvent(type: string, data: Record<string, unknown>): void {
    try {
        if (!fs.existsSync(EVENTS_DIR)) {
            fs.mkdirSync(EVENTS_DIR, { recursive: true });
        }
        const event = { type, timestamp: Date.now(), ...data };
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
        fs.writeFileSync(path.join(EVENTS_DIR, filename), JSON.stringify(event) + '\n');
    } catch {
        // Visualizer events are best-effort; never break the queue processor
    }
}
