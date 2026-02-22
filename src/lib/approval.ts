/**
 * Approval gate for TinyClaw — intercepts dangerous commands before execution.
 *
 * Flow:
 *   1. buildConfirmInstruction() is prepended to every agent message
 *   2. Claude outputs [CONFIRM_REQUIRED: description] and stops before running dangerous commands
 *   3. detectConfirmRequired() scans responses for this pattern
 *   4. buildApprovalMessage() formats the Telegram approval request
 *   5. Queue blocks until Tim replies yes/no
 */

/**
 * Patterns that require explicit approval before execution.
 * Each entry is a regex tested against the Claude response text.
 */
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

/**
 * System instruction prepended to every agent message.
 * Tells Claude to output [CONFIRM_REQUIRED: ...] and stop before running dangerous commands.
 */
export function buildConfirmInstruction(): string {
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

/**
 * Scan a response string for [CONFIRM_REQUIRED: ...] pattern.
 * Returns the description if found, null otherwise.
 */
export function detectConfirmRequired(response: string): string | null {
    const match = response.match(/\[CONFIRM_REQUIRED:\s*([^\]]+)\]/i);
    return match ? match[1].trim() : null;
}

/**
 * Format the Telegram approval request message.
 */
export function buildApprovalMessage(agentId: string, description: string, originalMsg: string): string {
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

/**
 * Check if a message is an approval reply (yes/no).
 * Returns 'approved', 'denied', or null.
 */
export function parseApprovalReply(text: string): 'approved' | 'denied' | null {
    const normalized = text.trim().toLowerCase();
    if (['yes', 'y', 'approve', 'approved', 'confirm', 'ok', 'yep', 'yup', 'do it'].includes(normalized)) {
        return 'approved';
    }
    if (['no', 'n', 'deny', 'denied', 'cancel', 'abort', 'stop', 'nope'].includes(normalized)) {
        return 'denied';
    }
    return null;
}
