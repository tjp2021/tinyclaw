/**
 * Shuffle — Re-partitions map outputs by key before reduction.
 *
 * This is the MapReduce "shuffle" phase. Without it, items that land in
 * different map batches are never compared. With it, items sharing a key
 * (e.g., same changed file, same semantic tag) are co-located in the same
 * reduce partition — guaranteeing cross-batch comparison.
 *
 * Flow:
 *   Map outputs (per-batch fingerprints)
 *     → parse structured items from each batch result
 *     → extract partition key(s) from each item
 *     → group items by key
 *     → (optional) sub-split large partitions
 *     → reduce each partition independently
 *     → final merge of partition results
 *
 * Example for PR dedup:
 *   Map output per batch: JSON array of {pr_number, title, intent, key_files, tags}
 *   Shuffle key: "tags"
 *   Partitions: {"auth": [PR#42, PR#1876, ...], "bugfix": [PR#42, PR#55, ...], ...}
 *   Reduce per partition: find duplicates among PRs sharing each tag
 *   Final merge: deduplicate the duplicate reports across partitions
 */

import { AgentConfig, TeamConfig } from '../lib/types';
import { invokeAgent } from '../lib/invoke';
import { log, emitEvent } from '../lib/logging';
import { SwarmConfig, SWARM_DEFAULTS } from './types';

export interface ShuffleResult {
    /** Partitions keyed by partition value. Each entry is a list of serialized items. */
    partitions: Map<string, string[]>;
    /** Items that couldn't be parsed or had no key (go into a catch-all partition) */
    unkeyed: string[];
    /** Total items processed */
    totalItems: number;
    /** Items that appear in multiple partitions (due to multi-key: 'duplicate') */
    duplicatedItems: number;
}

export interface ShuffleReduceOptions {
    swarmId: string;
    jobId: string;
    config: SwarmConfig;
    agent: AgentConfig;
    agentId: string;
    workspacePath: string;
    agents: Record<string, AgentConfig>;
    teams: Record<string, TeamConfig>;
    userMessage: string;
    concurrency: number;
}

/**
 * Parse map batch results into individual structured items.
 *
 * Handles multiple output formats:
 *   - Each batch result is a JSON array → extract items from each
 *   - Each batch result contains embedded JSON arrays → extract them
 *   - Each batch result is line-separated JSON objects → parse each line
 */
function parseMapOutputs(batchResults: string[]): object[] {
    const allItems: object[] = [];

    for (const result of batchResults) {
        // Try 1: Entire result is a JSON array
        try {
            const parsed = JSON.parse(result.trim());
            if (Array.isArray(parsed)) {
                allItems.push(...parsed.filter(item => item && typeof item === 'object'));
                continue;
            }
            if (typeof parsed === 'object') {
                allItems.push(parsed);
                continue;
            }
        } catch {
            // Not a single JSON value
        }

        // Try 2: Extract JSON array from markdown code fence or mixed text
        const jsonArrayMatch = result.match(/\[[\s\S]*\]/);
        if (jsonArrayMatch) {
            try {
                const parsed = JSON.parse(jsonArrayMatch[0]);
                if (Array.isArray(parsed)) {
                    allItems.push(...parsed.filter(item => item && typeof item === 'object'));
                    continue;
                }
            } catch {
                // Not valid JSON array
            }
        }

        // Try 3: Line-separated JSON objects (JSONL)
        const lines = result.split('\n');
        let foundJsonl = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('{')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (typeof parsed === 'object') {
                        allItems.push(parsed);
                        foundJsonl = true;
                    }
                } catch {
                    // Not JSON
                }
            }
        }
        if (foundJsonl) continue;

        // Fallback: couldn't parse this batch result as structured data
        log('WARN', `Shuffle: could not parse batch result as structured data (${result.length} chars)`);
    }

    return allItems;
}

/**
 * Extract partition key values from an item.
 * Returns an array because the key field might be an array (e.g., tags: ["auth", "bugfix"]).
 */
function extractKeys(item: object, keyField: string): string[] {
    const value = (item as Record<string, unknown>)[keyField];

    if (value === undefined || value === null) return [];

    if (Array.isArray(value)) {
        return value
            .map(v => String(v).toLowerCase().trim())
            .filter(Boolean);
    }

    return [String(value).toLowerCase().trim()].filter(Boolean);
}

/**
 * Perform the shuffle: parse map outputs, group by key, return partitions.
 */
export function shuffleByKey(
    batchResults: string[],
    config: SwarmConfig
): ShuffleResult {
    const shuffleConfig = config.shuffle!;
    const keyField = shuffleConfig.key_field;
    const multiKey = shuffleConfig.multi_key || 'duplicate';
    const maxPartitionSize = shuffleConfig.max_partition_size || SWARM_DEFAULTS.max_partition_size;

    log('INFO', `Shuffle: parsing map outputs, key_field="${keyField}", multi_key="${multiKey}"`);

    // Parse all map outputs into structured items
    const items = parseMapOutputs(batchResults);
    log('INFO', `Shuffle: parsed ${items.length} structured items from ${batchResults.length} batch results`);

    // Group by key
    const partitions = new Map<string, string[]>();
    const unkeyed: string[] = [];
    let duplicatedItems = 0;

    for (const item of items) {
        const keys = extractKeys(item, keyField);
        const serialized = JSON.stringify(item);

        if (keys.length === 0) {
            unkeyed.push(serialized);
            continue;
        }

        const keysToUse = multiKey === 'first' ? [keys[0]] : keys;
        if (keysToUse.length > 1) duplicatedItems++;

        for (const key of keysToUse) {
            const existing = partitions.get(key) || [];
            existing.push(serialized);
            partitions.set(key, existing);
        }
    }

    // Sub-split oversized partitions
    const finalPartitions = new Map<string, string[]>();
    for (const [key, partitionItems] of partitions) {
        if (partitionItems.length <= maxPartitionSize) {
            finalPartitions.set(key, partitionItems);
        } else {
            // Split into sub-partitions: "auth_1", "auth_2", etc.
            const chunks = Math.ceil(partitionItems.length / maxPartitionSize);
            for (let i = 0; i < chunks; i++) {
                const subKey = `${key}_part${i + 1}`;
                finalPartitions.set(subKey, partitionItems.slice(i * maxPartitionSize, (i + 1) * maxPartitionSize));
            }
            log('INFO', `Shuffle: split oversized partition "${key}" (${partitionItems.length} items) into ${chunks} sub-partitions`);
        }
    }

    log('INFO', `Shuffle: ${finalPartitions.size} partitions, ${unkeyed.length} unkeyed items, ${duplicatedItems} cross-partition items`);

    return {
        partitions: finalPartitions,
        unkeyed,
        totalItems: items.length,
        duplicatedItems,
    };
}

/**
 * Reduce each partition independently, then merge all partition results.
 *
 * This is where the magic happens for dedup: each partition contains all items
 * sharing a key, so cross-batch duplicates are guaranteed to be compared.
 */
export async function shuffleReducePartitions(
    shuffleResult: ShuffleResult,
    options: ShuffleReduceOptions
): Promise<string> {
    const { config } = options;
    const shuffleConfig = config.shuffle!;
    const partitionReducePrompt = shuffleConfig.reduce_prompt || config.reduce?.prompt || '';
    const mergePrompt = shuffleConfig.merge_prompt || config.reduce?.prompt || '';

    const partitionKeys = Array.from(shuffleResult.partitions.keys()).sort();
    log('INFO', `Shuffle-reduce: processing ${partitionKeys.length} partitions with concurrency=${options.concurrency}`);

    emitEvent('swarm_shuffle_reduce_start', {
        swarmId: options.swarmId,
        jobId: options.jobId,
        partitionCount: partitionKeys.length,
        unkeyedCount: shuffleResult.unkeyed.length,
    });

    // Resolve reduce agent
    const reduceAgentId = config.reduce?.agent || options.agentId;
    const reduceAgent = options.agents[reduceAgentId] || options.agent;

    // Process partitions with bounded concurrency (reuse semaphore pattern)
    const semaphore = new Semaphore(options.concurrency);
    const partitionResults: { key: string; result: string }[] = [];

    const promises = partitionKeys.map(async (key) => {
        await semaphore.acquire();
        try {
            const items = shuffleResult.partitions.get(key)!;
            const itemsText = items.join('\n');

            const prompt = buildPartitionReducePrompt(
                partitionReducePrompt,
                key,
                itemsText,
                items.length,
                options.userMessage
            );

            log('INFO', `Shuffle-reduce: partition "${key}" (${items.length} items)`);

            const result = await invokeAgent(
                reduceAgent,
                reduceAgentId,
                prompt,
                options.workspacePath,
                true, // fresh conversation per partition
                options.agents,
                options.teams
            );

            partitionResults.push({ key, result });
        } catch (error) {
            log('ERROR', `Shuffle-reduce: partition "${key}" failed: ${(error as Error).message}`);
            partitionResults.push({ key, result: `[Partition "${key}" failed: ${(error as Error).message}]` });
        } finally {
            semaphore.release();
        }
    });

    // Also process unkeyed items if any
    if (shuffleResult.unkeyed.length > 0) {
        promises.push((async () => {
            await semaphore.acquire();
            try {
                const prompt = buildPartitionReducePrompt(
                    partitionReducePrompt,
                    '_unkeyed',
                    shuffleResult.unkeyed.join('\n'),
                    shuffleResult.unkeyed.length,
                    options.userMessage
                );

                const result = await invokeAgent(
                    reduceAgent,
                    reduceAgentId,
                    prompt,
                    options.workspacePath,
                    true,
                    options.agents,
                    options.teams
                );

                partitionResults.push({ key: '_unkeyed', result });
            } catch (error) {
                log('ERROR', `Shuffle-reduce: unkeyed partition failed: ${(error as Error).message}`);
            } finally {
                semaphore.release();
            }
        })());
    }

    await Promise.all(promises);

    emitEvent('swarm_shuffle_reduce_done', {
        swarmId: options.swarmId,
        jobId: options.jobId,
        partitionCount: partitionResults.length,
    });

    // --- Final merge: combine all partition results ---
    log('INFO', `Shuffle-reduce: merging ${partitionResults.length} partition results`);

    // Sort by key for deterministic output
    partitionResults.sort((a, b) => a.key.localeCompare(b.key));

    const combinedPartitionResults = partitionResults
        .map(pr => `## Partition: ${pr.key}\n\n${pr.result}`)
        .join('\n\n---\n\n');

    // If few enough partitions, do a single merge pass
    if (partitionResults.length <= SWARM_DEFAULTS.hierarchical_reduce_fanin) {
        const finalPrompt = buildMergePrompt(
            mergePrompt,
            combinedPartitionResults,
            partitionResults.length,
            shuffleResult.totalItems,
            shuffleResult.duplicatedItems,
            options.userMessage
        );

        try {
            return await invokeAgent(
                reduceAgent,
                reduceAgentId,
                finalPrompt,
                options.workspacePath,
                true,
                options.agents,
                options.teams
            );
        } catch (error) {
            log('ERROR', `Shuffle-reduce: final merge failed: ${(error as Error).message}`);
            return combinedPartitionResults; // fallback to raw partition results
        }
    }

    // Too many partitions for single merge — return concatenated
    // (this is rare since partition count is usually much smaller than batch count)
    log('WARN', `Shuffle-reduce: ${partitionResults.length} partitions too many for single merge, returning concatenated`);
    return combinedPartitionResults;
}

function buildPartitionReducePrompt(
    customPrompt: string,
    partitionKey: string,
    itemsText: string,
    itemCount: number,
    userMessage: string
): string {
    const defaultPrompt = `Analyze the following ${itemCount} items that share the key "${partitionKey}". Identify any duplicates, near-duplicates, or closely related items.`;

    const prompt = customPrompt
        ? customPrompt
            .replace(/\{\{partition_key\}\}/g, partitionKey)
            .replace(/\{\{items\}\}/g, itemsText)
            .replace(/\{\{item_count\}\}/g, String(itemCount))
            .replace(/\{\{user_message\}\}/g, userMessage)
        : defaultPrompt;

    return `${prompt}\n\nOriginal task: ${userMessage}\n\nPartition "${partitionKey}" (${itemCount} items):\n${itemsText}`;
}

function buildMergePrompt(
    customPrompt: string,
    combinedResults: string,
    partitionCount: number,
    totalItems: number,
    duplicatedItems: number,
    userMessage: string
): string {
    const crossPartitionNote = duplicatedItems > 0
        ? `\n\nNote: ${duplicatedItems} items appeared in multiple partitions (shared multiple keys). Deduplicate any findings that appear across partitions.`
        : '';

    const defaultPrompt = `Below are results from ${partitionCount} partitions analyzing ${totalItems} total items. ` +
        `Merge these results into a single consolidated report. Remove duplicate findings that appear across partitions.` +
        crossPartitionNote;

    const prompt = customPrompt || defaultPrompt;

    return `${prompt}\n\nOriginal task: ${userMessage}\n\n---\n\n${combinedResults}`;
}

/** Simple semaphore for concurrency control */
class Semaphore {
    private queue: (() => void)[] = [];
    private current = 0;

    constructor(private max: number) {}

    async acquire(): Promise<void> {
        if (this.current < this.max) {
            this.current++;
            return;
        }
        return new Promise<void>(resolve => {
            this.queue.push(resolve);
        });
    }

    release(): void {
        this.current--;
        const next = this.queue.shift();
        if (next) {
            this.current++;
            next();
        }
    }
}
