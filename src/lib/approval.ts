/**
 * Approval gate for TinyClaw — intercepts dangerous commands before execution.
 *
 * The local module remains as a thin compatibility wrapper over the
 * canonical shared capability extracted into `approval-gate`.
 */

import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';

export const DANGEROUS_PATTERNS: { label: string; pattern: RegExp }[] = [
    { label: 'vercel deploy',       pattern: /\bvercel\b(?!.*\bdev\b)/i },
    { label: 'eas build/submit',    pattern: /\beas\s+(build|submit)\b/i },
    { label: 'git push',            pattern: /\bgit\s+push\b/i },
    { label: 'rm -rf',              pattern: /\brm\s+-rf?\b/i },
    { label: 'npm run build (prod)', pattern: /\bnpm\s+run\s+build\b(?!.*\bdev\b)/i },
    { label: 'stripe write op',     pattern: /stripe\s+\S*\s*(create|update|delete|cancel|capture|confirm|refund|transfer)/i },
    { label: 'twilio send',         pattern: /\btwilio\b.*\b(send|create|messages\.create)/i },
    { label: 'railway deploy',      pattern: /\brailway\s+(up|deploy)\b/i },
    { label: 'fly deploy',          pattern: /\bfly\s+deploy\b/i },
    { label: 'fly launch',          pattern: /\bfly\s+launch\b/i },
];

interface ApprovalGateModule {
    buildConfirmInstruction(): string;
    detectConfirmRequired(response: string): string | null;
    buildApprovalMessage(agentId: string, description: string, originalMessage: string): string;
    parseApprovalReply(text: string): 'approved' | 'denied' | null;
}

let capabilityModule: ApprovalGateModule | null | undefined;

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

function useApprovalGateCapability(): boolean {
    return (process.env.TINYCLAW_USE_APPROVAL_GATE_CAPABILITY || 'true').toLowerCase() !== 'false';
}

function resolveCapabilityPath(): string {
    const candidates: string[] = [];
    const override = process.env.TINYCLAW_APPROVAL_GATE_CAPABILITY_PATH;
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
                'approval-gate',
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

    throw new Error(`approval-gate capability not found. Checked: ${candidates.join(', ')}`);
}

function loadCapabilityModule(): ApprovalGateModule | null {
    if (capabilityModule !== undefined) {
        return capabilityModule;
    }

    if (!useApprovalGateCapability()) {
        capabilityModule = null;
        return capabilityModule;
    }

    capabilityModule = require(resolveCapabilityPath()) as ApprovalGateModule;
    return capabilityModule;
}

function legacyBuildConfirmInstruction(): string {
    const labels = DANGEROUS_PATTERNS.map(p => `- ${p.label}`).join('\n');
    return `[SYSTEM: APPROVAL GATE]
Before executing any of the following dangerous operations, you MUST output the exact token:
  [CONFIRM_REQUIRED: <brief description of what you are about to do>]
Then STOP — do not execute the command. Wait for explicit approval.

Dangerous operations requiring confirmation:
${labels}

If you are about to run any of these, output [CONFIRM_REQUIRED: <description>] and stop immediately.
Do NOT proceed until you receive "yes" or "approve".
[/SYSTEM]

`;
}

function legacyDetectConfirmRequired(response: string): string | null {
    const match = response.match(/\[CONFIRM_REQUIRED:\s*([^\]]+)\]/i);
    return match ? match[1].trim() : null;
}

function legacyBuildApprovalMessage(agentId: string, description: string, originalMsg: string): string {
    const preview = originalMsg.length > 120 ? originalMsg.substring(0, 120) + '...' : originalMsg;
    return [
        `⚠️ *Approval Required*`,
        ``,
        `Agent: @${agentId}`,
        `Action: ${description}`,
        ``,
        `Original request:`,
        `_${preview}_`,
        ``,
        `Reply *yes* to confirm or *no* to cancel.`,
    ].join('\n');
}

function legacyParseApprovalReply(text: string): 'approved' | 'denied' | null {
    const normalized = text.trim().toLowerCase();
    if (['yes', 'y', 'approve', 'approved', 'confirm', 'ok', 'yep', 'yup', 'do it'].includes(normalized)) {
        return 'approved';
    }
    if (['no', 'n', 'deny', 'denied', 'cancel', 'abort', 'stop', 'nope'].includes(normalized)) {
        return 'denied';
    }
    return null;
}

export function buildConfirmInstruction(): string {
    return (loadCapabilityModule()?.buildConfirmInstruction ?? legacyBuildConfirmInstruction)();
}

export function detectConfirmRequired(response: string): string | null {
    return (loadCapabilityModule()?.detectConfirmRequired ?? legacyDetectConfirmRequired)(response);
}

export function buildApprovalMessage(agentId: string, description: string, originalMsg: string): string {
    return (loadCapabilityModule()?.buildApprovalMessage ?? legacyBuildApprovalMessage)(agentId, description, originalMsg);
}

export function parseApprovalReply(text: string): 'approved' | 'denied' | null {
    return (loadCapabilityModule()?.parseApprovalReply ?? legacyParseApprovalReply)(text);
}
