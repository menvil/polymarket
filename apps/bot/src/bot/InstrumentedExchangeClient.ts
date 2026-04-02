/**
 * InstrumentedExchangeClient — декоратор IExchangeClient с измерением latency.
 *
 * @remarks
 * Оборачивает каждый вызов submitOrder/cancelOrder таймингом через `performance.now()`.
 * Накапливает статистику (sliding window последних 200 замеров) и логирует
 * агрегированные метрики каждые 60 секунд.
 *
 * ### Измеряемые метрики:
 * - submitOrder: count, p50, p95, p99, max
 * - cancelOrder: count, p50, p95, p99, max
 *
 * @example
 * ```typescript
 * const inner = new PolymarketExchangeClientAdapter(...);
 * const instrumented = new InstrumentedExchangeClient(inner, logger);
 * // Использовать instrumented вместо inner
 * ```
 */
import { performance } from 'perf_hooks';
import type { ILogger } from '@polymarket/logger';
import type {
  IExchangeClient,
  SubmitOrderParams,
  OpenOrderSnapshot,
  VenueTradeSnapshot,
  ExchangeError,
} from '@polymarket/ports';
import type { Result } from '@polymarket/result';
import type { OrderId, AccountId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';

// ── Sliding window для latency readings ──────────────────────────────────────

class LatencyWindow {
  private readonly _values: number[] = [];
  private readonly _maxSize: number;

  constructor(maxSize = 200) {
    this._maxSize = maxSize;
  }

  push(ms: number): void {
    this._values.push(ms);
    if (this._values.length > this._maxSize) {
      this._values.shift();
    }
  }

  get count(): number { return this._values.length; }

  /**
   * Вычисляет статистику: p50, p95, p99, max.
   */
  stats(): { count: number; p50: number; p95: number; p99: number; max: number } | null {
    if (this._values.length === 0) return null;
    const sorted = [...this._values].sort((a, b) => a - b);
    const p = (pct: number) => sorted[Math.min(Math.floor(sorted.length * pct), sorted.length - 1)]!;
    return {
      count: sorted.length,
      p50: p(0.5),
      p95: p(0.95),
      p99: p(0.99),
      max: sorted[sorted.length - 1]!,
    };
  }

  /** Сбрасывает окно. */
  clear(): void { this._values.length = 0; }
}

// ── Decorator ────────────────────────────────────────────────────────────────

/** Интервал логирования агрегированных метрик (мс). */
const LOG_INTERVAL_MS = 60_000;

export class InstrumentedExchangeClient implements IExchangeClient {
  private readonly _logger: ILogger;
  private readonly _submit = new LatencyWindow();
  private readonly _cancel = new LatencyWindow();
  private _logTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly _inner: IExchangeClient,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'ExchangeLatency' });
    this._logTimer = setInterval(() => this._logStats(), LOG_INTERVAL_MS);
    this._logTimer.unref();
  }

  // ── Instrumented methods ─────────────────────────────────────────────────

  async submitOrder(params: SubmitOrderParams): Promise<Result<OrderId, ExchangeError>> {
    const start = performance.now();
    const result = await this._inner.submitOrder(params);
    const elapsed = performance.now() - start;
    this._submit.push(elapsed);
    this._logger.debug('submitOrder latency', { ms: elapsed.toFixed(0), ok: result.ok });
    return result;
  }

  async cancelOrder(orderId: OrderId): Promise<Result<void, ExchangeError>> {
    const start = performance.now();
    const result = await this._inner.cancelOrder(orderId);
    const elapsed = performance.now() - start;
    this._cancel.push(elapsed);
    this._logger.debug('cancelOrder latency', { ms: elapsed.toFixed(0), ok: result.ok });
    return result;
  }

  // ── Pass-through methods ─────────────────────────────────────────────────

  async getOpenOrders(accountId: AccountId): Promise<Result<OpenOrderSnapshot[], ExchangeError>> {
    return this._inner.getOpenOrders(accountId);
  }

  async getTrades(accountId: AccountId, since?: Timestamp): Promise<Result<VenueTradeSnapshot[], ExchangeError>> {
    return this._inner.getTrades(accountId, since);
  }

  // ── Periodic stats logging ───────────────────────────────────────────────

  private _logStats(): void {
    const submitStats = this._submit.stats();
    const cancelStats = this._cancel.stats();

    if (!submitStats && !cancelStats) return;

    const fmt = (s: ReturnType<LatencyWindow['stats']>) =>
      s ? `n=${s.count} p50=${s.p50.toFixed(0)}ms p95=${s.p95.toFixed(0)}ms max=${s.max.toFixed(0)}ms` : 'n=0';

    this._logger.warn('Exchange latency (60s window)', {
      submit: fmt(submitStats),
      cancel: fmt(cancelStats),
    });
  }

  /** Останавливает таймер логирования. */
  stop(): void {
    if (this._logTimer) {
      clearInterval(this._logTimer);
      this._logTimer = null;
    }
  }
}
