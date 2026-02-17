/**
 * Swarm Processor — Main orchestrator for agent swarm jobs.
 *
 * Pipeline: Input Resolution → Batch Splitting → Worker Pool (Map) → Shuffle (optional) → Reducer → Output
 *
 * The swarm processor runs as part of the queue processor. When a message is
 * routed to a swarm (via @swarm_id), processSwarmJob() is called instead of
 * the normal agent invocation.
 */

import fs from 'fs';
import path from 'path';
import { MessageData, ResponseData, AgentConfig, TeamConfig } from '../lib/types';
import { QUEUE_OUTGOING, FILES_DIR } from '../lib/config';
import { log, emitEvent } from '../lib/logging';
import { SwarmConfig, SwarmJob, SwarmJobContext, SWARM_DEFAULTS } from './types';
import { resolveInputItems, splitIntoBatches } from './batch-splitter';
import { processAllBatches, WorkerPoolOptions } from './worker-pool';
import { reduceBatchResults, ReduceOptions } from './reducer';
import { shuffleByKey, shuffleReducePartitions, ShuffleReduceOptions } from './shuffle';

/** Active swarm jobs — for status queries and progress tracking */
const activeJobs = new Map<string, SwarmJob>();

/**
 * Get all active swarm jobs.
 */
export function getActiveSwarmJobs(): Map<string, SwarmJob> {
    return activeJobs;
}

/**
 * Process a swarm job end-to-end.
 *
 * This is the main entry point called from the queue processor when
 * a message is routed to a swarm.
 */
export async function processSwarmJob(
    swarmId: string,
    config: SwarmConfig,
    messageData: MessageData,
    agentId: string,
    agent: AgentConfig,
    workspacePath: string,
    agents: Record<string, AgentConfig>,
    teams: Record<string, TeamConfig>
): Promise<void> {
    const jobId = `swarm_${swarmId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const userMessage = messageData.message;

    const context: SwarmJobContext = {
        channel: messageData.channel,
        sender: messageData.sender,
        senderId: messageData.senderId,
        messageId: messageData.messageId,
        originalMessage: userMessage,
    };

    const job: SwarmJob = {
        id: jobId,
        swarmId,
        config,
        status: 'initializing',
        batches: [],
        progress: {
            total: 0,
            completed: 0,
            failed: 0,
            inFlight: 0,
            startTime: Date.now(),
        },
        context,
    };

    activeJobs.set(jobId, job);

    log('INFO', `Swarm job ${jobId} started — swarm: ${swarmId} (${config.name})`);
    emitEvent('swarm_job_start', {
        jobId,
        swarmId,
        swarmName: config.name,
        channel: context.channel,
        sender: context.sender,
    });

    // Send initial acknowledgment to user
    sendProgressUpdate(context, `**${config.name}** swarm activated. Preparing to process your request...`);

    try {
        // --- Phase 1: Input Resolution ---
        job.status = 'fetching_input';
        log('INFO', `Swarm ${jobId}: resolving input items...`);

        const items = await resolveInputItems(config, userMessage, messageData.files);

        if (items.length === 0) {
            throw new Error('No input items found. Provide items inline (JSON array), attach a file, or configure an input command in the swarm settings.');
        }

        if (items.length > SWARM_DEFAULTS.max_items) {
            throw new Error(`Too many items (${items.length}). Maximum is ${SWARM_DEFAULTS.max_items}. Reduce the input or increase the limit.`);
        }

        job.inputItems = items;
        log('INFO', `Swarm ${jobId}: resolved ${items.length} input items`);

        // --- Phase 2: Batch Splitting ---
        job.status = 'splitting';
        const batchSize = config.batch_size || SWARM_DEFAULTS.batch_size;
        const batches = splitIntoBatches(items, batchSize);
        job.batches = batches;
        job.progress.total = batches.length;

        log('INFO', `Swarm ${jobId}: split ${items.length} items into ${batches.length} batches (size=${batchSize})`);
        emitEvent('swarm_split_done', {
            jobId,
            swarmId,
            totalItems: items.length,
            totalBatches: batches.length,
            batchSize,
        });

        sendProgressUpdate(
            context,
            `**${config.name}**: Processing **${items.length}** items in **${batches.length}** batches (${batchSize} per batch, ${config.concurrency || SWARM_DEFAULTS.concurrency} workers)...`
        );

        // --- Phase 3: Map (Worker Pool) ---
        job.status = 'processing';
        const progressInterval = config.progress_interval || SWARM_DEFAULTS.progress_interval;
        let lastProgressUpdate = 0;

        const poolOptions: WorkerPoolOptions = {
            swarmId,
            jobId,
            config,
            agent,
            agentId,
            workspacePath,
            agents,
            teams,
            userMessage,
            onBatchComplete: (result, progress) => {
                job.progress.completed = progress.completed;
                job.progress.failed = progress.failed;
                job.progress.inFlight = progress.total - progress.completed - progress.failed;

                // Estimate remaining time
                const elapsed = Date.now() - job.progress.startTime;
                const avgPerBatch = elapsed / progress.completed;
                const remaining = (progress.total - progress.completed) * avgPerBatch;
                job.progress.estimatedRemaining = Math.round(remaining / 1000);

                // Send periodic progress updates
                if (progressInterval > 0 && progress.completed - lastProgressUpdate >= progressInterval) {
                    lastProgressUpdate = progress.completed;
                    const pct = Math.round((progress.completed / progress.total) * 100);
                    sendProgressUpdate(
                        context,
                        `**${config.name}** progress: ${progress.completed}/${progress.total} batches (${pct}%)` +
                        (progress.failed > 0 ? ` | ${progress.failed} failed` : '') +
                        (job.progress.estimatedRemaining ? ` | ~${formatDuration(job.progress.estimatedRemaining)} remaining` : '')
                    );
                }
            },
        };

        const batchResults = await processAllBatches(batches, poolOptions);

        // Collect successful results
        const successResults: string[] = [];
        for (const br of batchResults) {
            if (br.success && br.result) {
                successResults.push(br.result);
            }
        }

        if (successResults.length === 0) {
            throw new Error(`All ${batches.length} batches failed. Check agent configuration and logs.`);
        }

        job.batchResults = successResults;

        const failedCount = batchResults.filter(r => !r.success).length;
        if (failedCount > 0) {
            log('WARN', `Swarm ${jobId}: ${failedCount}/${batches.length} batches failed`);
        }

        // --- Phase 4: Shuffle (optional) + Reduce ---
        let finalResult: string;

        if (config.shuffle) {
            // Shuffle-reduce path: re-partition map outputs by key, then
            // reduce each partition independently, then merge.
            // This guarantees cross-batch comparison for tasks like dedup.
            job.status = 'shuffling';
            log('INFO', `Swarm ${jobId}: shuffling ${successResults.length} batch results by key "${config.shuffle.key_field}"...`);
            sendProgressUpdate(context, `**${config.name}**: All batches complete. Shuffling results by "${config.shuffle.key_field}"...`);

            const shuffleResult = shuffleByKey(successResults, config);

            emitEvent('swarm_shuffle_done', {
                jobId,
                swarmId,
                partitions: shuffleResult.partitions.size,
                totalItems: shuffleResult.totalItems,
                unkeyedItems: shuffleResult.unkeyed.length,
                duplicatedItems: shuffleResult.duplicatedItems,
            });

            sendProgressUpdate(
                context,
                `**${config.name}**: Shuffled into **${shuffleResult.partitions.size}** partitions ` +
                `(${shuffleResult.totalItems} items` +
                (shuffleResult.duplicatedItems > 0 ? `, ${shuffleResult.duplicatedItems} cross-partition` : '') +
                `). Reducing partitions...`
            );

            job.status = 'reducing';
            const concurrency = config.concurrency || SWARM_DEFAULTS.concurrency;

            const shuffleReduceOpts: ShuffleReduceOptions = {
                swarmId,
                jobId,
                config,
                agent,
                agentId,
                workspacePath,
                agents,
                teams,
                userMessage,
                concurrency,
            };

            finalResult = await shuffleReducePartitions(shuffleResult, shuffleReduceOpts);
        } else {
            // Standard reduce path (no shuffle)
            job.status = 'reducing';
            log('INFO', `Swarm ${jobId}: reducing ${successResults.length} batch results...`);

            if (successResults.length > 1) {
                sendProgressUpdate(context, `**${config.name}**: All batches complete. Aggregating results...`);
            }

            const reduceOptions: ReduceOptions = {
                swarmId,
                jobId,
                config,
                agent,
                agentId,
                workspacePath,
                agents,
                teams,
                userMessage,
            };

            finalResult = await reduceBatchResults(successResults, reduceOptions);
        }

        job.result = finalResult;

        // --- Phase 5: Output ---
        job.status = 'completed';
        job.progress.endTime = Date.now();

        const totalDuration = Math.round((job.progress.endTime - job.progress.startTime) / 1000);

        log('INFO', `Swarm ${jobId}: completed in ${formatDuration(totalDuration)} — ${successResults.length}/${batches.length} batches succeeded`);
        emitEvent('swarm_job_done', {
            jobId,
            swarmId,
            duration: totalDuration,
            totalBatches: batches.length,
            successBatches: successResults.length,
            failedBatches: failedCount,
            resultLength: finalResult.length,
        });

        // Build response with stats header
        const statsHeader = `**${config.name}** completed in ${formatDuration(totalDuration)}\n` +
            `Items: ${items.length} | Batches: ${batches.length} (${successResults.length} ok, ${failedCount} failed) | Workers: ${config.concurrency || SWARM_DEFAULTS.concurrency}\n\n---\n\n`;

        const fullResponse = statsHeader + finalResult;

        // Send final response
        sendFinalResponse(context, fullResponse);

    } catch (error) {
        job.status = 'failed';
        job.error = (error as Error).message;
        job.progress.endTime = Date.now();

        log('ERROR', `Swarm ${jobId} failed: ${job.error}`);
        emitEvent('swarm_job_failed', { jobId, swarmId, error: job.error });

        sendFinalResponse(
            context,
            `**${config.name}** swarm failed: ${job.error}\n\nPlease check the swarm configuration and try again.`
        );
    } finally {
        // Keep job in memory for a while for status queries, then clean up
        setTimeout(() => {
            activeJobs.delete(jobId);
        }, 300000); // 5 minutes
    }
}

/**
 * Send a progress update to the user's channel (non-blocking).
 */
function sendProgressUpdate(context: SwarmJobContext, message: string): void {
    try {
        const responseData: ResponseData = {
            channel: context.channel,
            sender: context.sender,
            message,
            originalMessage: context.originalMessage,
            timestamp: Date.now(),
            messageId: context.messageId,
        };

        const filename = `swarm_progress_${context.messageId}_${Date.now()}.json`;
        fs.writeFileSync(path.join(QUEUE_OUTGOING, filename), JSON.stringify(responseData, null, 2));
    } catch (error) {
        log('WARN', `Failed to send swarm progress update: ${(error as Error).message}`);
    }
}

/**
 * Send the final swarm response. Handles long responses by saving to file.
 */
function sendFinalResponse(context: SwarmJobContext, response: string): void {
    const LONG_RESPONSE_THRESHOLD = 4000;
    let message = response;
    let files: string[] | undefined;

    if (response.length > LONG_RESPONSE_THRESHOLD) {
        // Save full response as a file
        const filename = `swarm_result_${Date.now()}.md`;
        const filePath = path.join(FILES_DIR, filename);
        fs.writeFileSync(filePath, response);

        message = response.substring(0, LONG_RESPONSE_THRESHOLD) + '\n\n_(Full swarm report attached as file)_';
        files = [filePath];
        log('INFO', `Swarm response (${response.length} chars) saved to ${filename}`);
    }

    const responseData: ResponseData = {
        channel: context.channel,
        sender: context.sender,
        message,
        originalMessage: context.originalMessage,
        timestamp: Date.now(),
        messageId: context.messageId,
        files,
    };

    const filename = `swarm_result_${context.messageId}_${Date.now()}.json`;
    fs.writeFileSync(path.join(QUEUE_OUTGOING, filename), JSON.stringify(responseData, null, 2));
}

/**
 * Format seconds into human-readable duration.
 */
function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
}
