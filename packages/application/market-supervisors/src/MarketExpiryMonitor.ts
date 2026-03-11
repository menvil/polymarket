/**
 * MarketExpiryMonitor — периодическая проверка истечения рынков.
 *
 * @remarks
 * ### Назначение:
 * Отслеживает `expiresAt` активных рынков и закрывает их через
 * `CloseMarketUseCase` когда срок истекает.
 *
 * ### Алгоритм:
 * 1. `MARKET_OPENED` → `marketCatalog.getByMarketId()` → запомнить `{marketId, expiresAtMs}`
 * 2. `setInterval(checkIntervalMs)` → для каждого tracked: если `expiresAt <= now` → `closeMarketUseCase(EXPIRED)`
 * 3. `MARKET_CLOSED` → убрать из `_trackedMarkets`
 *
 * ### Без IRemovalPolicy:
 * Проверка истечения встроена напрямую (сравнение `expiresAtMs <= now.getTime()`).
 * `IRemovalPolicy` остаётся доступным для более сложных политик удаления,
 * но `MarketExpiryMonitor` не использует его — его задача только expiry.
 *
 * @example
 * ```typescript
 * const monitor = new MarketExpiryMonitor(
 *   { closeMarketUseCase, marketCatalog, eventBus, clock, logger },
 *   { accountId, checkIntervalMs: 5_000 },
 * );
 *
 * monitor.start();
 * // При остановке:
 * monitor.stop();
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { AccountId, MarketId } from '@polymarket/ids';
import type { IMarketCatalog } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import type { IClock } from '@polymarket/time';
import type { CloseMarketUseCase } from '@polymarket/market-lifecycle';

/**
 * Зависимости MarketExpiryMonitor.
 */
export interface MarketExpiryMonitorDeps {
  /** Use case закрытия рынка */
  readonly closeMarketUseCase: CloseMarketUseCase;
  /** Каталог инструментов (для получения expiresAt по marketId) */
  readonly marketCatalog: IMarketCatalog;
  /** Event bus для подписки на MARKET_OPENED/MARKET_CLOSED */
  readonly eventBus: IEventBus;
  /** Источник текущего времени */
  readonly clock: IClock;
  /** Logger */
  readonly logger: ILogger;
}

/**
 * Конфигурация MarketExpiryMonitor.
 */
export interface MarketExpiryMonitorConfig {
  /** ID аккаунта для передачи в CloseMarketUseCase */
  readonly accountId: AccountId;
  /** Интервал проверки истечения (мс). По умолчанию рекомендуется 5000. */
  readonly checkIntervalMs: number;
}

/**
 * Монитор истечения рынков.
 *
 * @remarks
 * Закрывает рынки когда истекает `expiresAt`, публикуя MARKET_CLOSED
 * через CloseMarketUseCase (который реагирует StrategyRunner).
 */
export class MarketExpiryMonitor {
  private readonly _logger: ILogger;
  /** Идентификатор интервала проверки */
  private _intervalId: ReturnType<typeof setInterval> | undefined;
  /** Отслеживаемые рынки: stringMarketId → {marketId, expiresAtMs} */
  private readonly _trackedMarkets = new Map<string, { marketId: MarketId; expiresAtMs: number }>();
  private _unsubscribeOpened: (() => void) | undefined;
  private _unsubscribeClosed: (() => void) | undefined;

  /**
   * @param _deps - Зависимости монитора
   * @param _config - Конфигурация параметров
   */
  constructor(
    private readonly _deps: MarketExpiryMonitorDeps,
    private readonly _config: MarketExpiryMonitorConfig,
  ) {
    this._logger = _deps.logger.child({ component: 'MarketExpiryMonitor' });
  }

  /**
   * Запускает монитор: подписывается на события и стартует интервал проверки.
   *
   * @remarks
   * Повторный вызов без `stop()` — no-op с предупреждением.
   */
  public start(): void {
    if (this._intervalId !== undefined) {
      this._logger.warn('MarketExpiryMonitor already running, ignoring start()');
      return;
    }

    this._unsubscribeOpened = this._deps.eventBus.subscribe('MARKET_OPENED', async (event) => {
      const instrument = this._deps.marketCatalog.getByMarketId(event.marketId);
      if (instrument) {
        this._trackedMarkets.set(String(event.marketId), {
          marketId: event.marketId,
          expiresAtMs: instrument.expiresAt.toNumber(),
        });
        this._logger.debug('Market expiry tracking started', {
          marketId: String(event.marketId),
          expiresAt: new Date(instrument.expiresAt.toNumber()).toISOString(),
        });
      } else {
        this._logger.warn('MARKET_OPENED: instrument not found in catalog, expiry not tracked', {
          marketId: String(event.marketId),
        });
      }
    });

    this._unsubscribeClosed = this._deps.eventBus.subscribe('MARKET_CLOSED', async (event) => {
      this._trackedMarkets.delete(String(event.marketId));
    });

    this._intervalId = setInterval(
      () => void this._checkExpired(),
      this._config.checkIntervalMs,
    );

    this._logger.info('MarketExpiryMonitor started', {
      checkIntervalMs: this._config.checkIntervalMs,
    });
  }

  /**
   * Останавливает монитор: очищает интервал и отписывается от событий.
   */
  public stop(): void {
    if (this._intervalId !== undefined) {
      clearInterval(this._intervalId);
      this._intervalId = undefined;
    }
    this._unsubscribeOpened?.();
    this._unsubscribeClosed?.();
    this._logger.info('MarketExpiryMonitor stopped');
  }

  // ── Приватная логика ──────────────────────────────────────────────────────

  /**
   * Проверяет истечение всех отслеживаемых рынков и закрывает просроченные.
   *
   * @remarks
   * Вызывается по `setInterval`. Собирает просроченные рынки snapshot'ом
   * (до await), чтобы avoid concurrent modification при удалении через MARKET_CLOSED.
   */
  private async _checkExpired(): Promise<void> {
    const nowMs = this._deps.clock.now().getTime();

    const expired = [...this._trackedMarkets.values()].filter(
      (m) => m.expiresAtMs <= nowMs,
    );

    if (expired.length === 0) return;

    this._logger.info('Expiry check: closing expired markets', { count: expired.length });

    for (const { marketId } of expired) {
      try {
        const result = await this._deps.closeMarketUseCase.execute({
          marketId,
          accountId: this._config.accountId,
          reason: 'EXPIRED',
        });
        if (!result.ok) {
          this._logger.error('Failed to close expired market', {
            marketId: String(marketId),
            error: result.error.message,
          });
        }
        // CloseMarketUseCase публикует MARKET_CLOSED → подписчик удалит из _trackedMarkets
      } catch (err) {
        this._logger.error('Unexpected error closing expired market', {
          marketId: String(marketId),
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }
}
