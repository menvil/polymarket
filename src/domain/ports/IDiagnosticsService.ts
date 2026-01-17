/**
 * IDiagnosticsService - интерфейс для системной диагностики
 *
 * @remarks
 * Предоставляет доступ к health checks, metrics, state snapshots.
 * Используется для мониторинга, отладки, логирования состояния системы.
 *
 * @example
 * ```typescript
 * const diagnostics = container.resolve<IDiagnosticsService>('diagnostics');
 *
 * // Health check
 * const health = await diagnostics.getHealth();
 * console.log(`System status: ${health.status}`);
 *
 * // Metrics
 * const snapshot = await diagnostics.getDiagnostics();
 * console.log(`Orders filled: ${snapshot.executionMetrics.ordersFilled}`);
 * ```
 */

import type {
  SystemHealth,
  DiagnosticsSnapshot,
  ExecutionMetrics,
  StateSnapshot,
} from '../types/diagnostics.js';

/**
 * IDiagnosticsService interface
 */
export interface IDiagnosticsService {
  /**
   * Получает health status системы
   *
   * @returns System health с проверками компонентов
   *
   * @remarks
   * Проверяет:
   * - EventBus (работает ли)
   * - Adapters (доступны ли)
   * - Projectors (запущены ли)
   *
   * @example
   * ```typescript
   * const health = await diagnostics.getHealth();
   * if (health.status !== 'healthy') {
   *   logger.warn('System is unhealthy', health);
   * }
   * ```
   */
  getHealth(): Promise<SystemHealth>;

  /**
   * Получает полный diagnostics snapshot
   *
   * @returns Полный снимок диагностики системы
   *
   * @remarks
   * Включает:
   * - Health status
   * - Execution metrics (orders placed/filled/rejected)
   * - EventBus metrics (subscribers count)
   * - Adapters health
   * - State snapshot (active orders, subscriptions)
   *
   * @example
   * ```typescript
   * const snapshot = await diagnostics.getDiagnostics();
   * logger.info('System diagnostics', snapshot);
   * ```
   */
  getDiagnostics(): Promise<DiagnosticsSnapshot>;

  /**
   * Получает execution метрики
   *
   * @returns Execution метрики (orders placed/filled/rejected)
   *
   * @remarks
   * Использует MetricsProjector.getMetrics() для получения данных.
   *
   * @example
   * ```typescript
   * const metrics = await diagnostics.getExecutionMetrics();
   * console.log(`Fill rate: ${(metrics.fillRate * 100).toFixed(2)}%`);
   * ```
   */
  getExecutionMetrics(): Promise<ExecutionMetrics>;

  /**
   * Получает state snapshot
   *
   * @returns Текущее состояние системы
   *
   * @remarks
   * Snapshot включает:
   * - Количество активных ордеров
   * - Количество отслеживаемых маркетов
   * - Количество подписок (orderbook, trades, user events)
   *
   * @example
   * ```typescript
   * const state = await diagnostics.getStateSnapshot();
   * console.log(`Active orders: ${state.activeOrders}`);
   * ```
   */
  getStateSnapshot(): Promise<StateSnapshot>;
}
