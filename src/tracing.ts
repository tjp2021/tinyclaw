/**
 * OpenTelemetry tracing setup for TinyClaw.
 *
 * Loaded via node --require ./dist/tracing.js BEFORE the app starts.
 * Only exports traces when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Provides:
 * - Auto Pino log correlation (trace_id/span_id injected into log JSON)
 * - Manual span creation via withSpan() for queue processing, agent invocations, etc.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
    const sdk = new NodeSDK({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'tinyclaw',
        }),
        traceExporter: new OTLPTraceExporter({
            url: `${endpoint}/v1/traces`,
            headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
        }),
        instrumentations: [new PinoInstrumentation()],
    });

    sdk.start();

    // Graceful shutdown
    process.on('SIGTERM', () => {
        sdk.shutdown().catch(() => {});
    });
}

/**
 * Parse OTEL_EXPORTER_OTLP_HEADERS env var format: "key1=value1,key2=value2"
 */
function parseOtlpHeaders(raw?: string): Record<string, string> {
    if (!raw) return {};
    const headers: Record<string, string> = {};
    for (const pair of raw.split(',')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
            headers[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
        }
    }
    return headers;
}

// Re-export span utilities for manual instrumentation
export { trace, SpanStatusCode } from '@opentelemetry/api';
export type { Span } from '@opentelemetry/api';

import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('tinyclaw');

/**
 * Wrap an async function in an OTel span.
 */
export async function withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    return tracer.startActiveSpan(name, async (span) => {
        span.setAttributes(attributes);
        try {
            const result = await fn(span);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
        } catch (error) {
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : 'Unknown error',
            });
            span.recordException(error instanceof Error ? error : new Error(String(error)));
            throw error;
        } finally {
            span.end();
        }
    });
}
