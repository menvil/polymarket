/**
 * WsExecutionMapper stub.
 *
 * @remarks
 * Stub — используется UserEventsFeedService до реализации Phase 8.
 */

/** Метрики для WsExecutionMapper */
export interface WsExecutionMapperMetrics {
  increment(counter: 'ws.parse_success' | 'ws.parse_failed' | 'ws.parse_nan'): void;
  sample(event: string, data: unknown): void;
}
