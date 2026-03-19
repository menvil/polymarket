/**
 * MarketExpiryMonitor — периодическая проверка истечения рынков.
 *
 * @remarks
 * ### Назначение:
 * Отслеживает активные рынки через `IRemovalPolicy` и закрывает их
 * когда политика решает, что пора: освобождает аллокацию и публикует `MARKET_CLOSED`.
 *
 * ### Алгоритм:
 * 1. `MARKET_OPENED` → `marketCatalog.getByMarketId()` → запомнить `{marketId, expiresAt}`
 * 2. `setInterval(checkIntervalMs)` → строим `MarketContext[]` → `policy.evaluate()`
 * 3. Для каждого возвращённого marketId:
 *    - `balanceAllocator.release(marketId)` — освободить аллокацию
 *    - `eventBus.publish(MARKET_CLOSED)` — уведомить стратегию
 * 4. `MARKET_CLOSED` → убрать из `_trackedMarkets`
 *
 * ### Ответственность:
 * Только административная: освобождение ресурсов бота.
 * Управление ордерами — зона ответственности стратегии, реагирующей на MARKET_CLOSED.
 *
 * @example
 * ```typescript
 * const policy = new ExpirationRemovalPolicy(clock, 30 * 60 * 1000);
 * const monitor = new MarketExpiryMonitor(
 *   { balanceAllocator, policy, marketCatalog, eventBus, clock, logger },
 *   { accountId, checkIntervalMs: 5_000 },
 * );
 *
 * monitor.start();
 * monitor.stop();
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { AccountId, MarketId } from '@polymarket/ids';
import type { IMarketCatalog, IBalanceAllocator } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import type { IClock } from '@polymarket/time';
import { Money, TimestampService } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/value-objects';
import type { IRemovalPolicy, MarketContext } from './IRemovalPolicy.js';

/**
 * Зависимости MarketExpiryMonitor.
 */
export interface MarketExpiryMonitorDeps {
  /** Аллокатор баланса (для освобождения при закрытии) */
  readonly balanceAllocator: IBalanceAllocator;
  /** Политика удаления рынков */
  readonly policy: IRemovalPolicy;
  /** Каталог инструментов (для получения expiresAt по marketId) */
  readonly marketCatalog: IMarketCatalog;
  /** Event bus */
  readonly eventBus: IEventBus;
  /** Источник времени */
  readonly clock: IClock;
  /** Logger */
  readonly logger: ILogger;
}

/**
 * Конфигурация MarketExpiryMonitor.
 */
export interface MarketExpiryMonitorConfig {
  /** ID аккаунта для публикации событий */
  readonly accountId: AccountId;
  /** Интервал проверки (мс) */
  readonly checkIntervalMs: number;
}

/**
 * Монитор истечения рынков.
 */
export class MarketExpiryMonitor {
  private readonly _logger: ILogger;
  private _intervalId: ReturnType<typeof setInterval> | undefined;
  private readonly _trackedMarkets = new Map<string, { marketId: MarketId; expiresAt: Timestamp }>();
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
   * Запускает монитор.
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
          expiresAt: instrument.expiresAt,
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
   * Останавливает монитор.
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
   * Проверяет рынки через политику и закрывает те, которые она вернула.
   *
   * @remarks
   * Собирает snapshot перед await, чтобы избежать concurrent modification
   * при удалении через MARKET_CLOSED.
   */
  private async _checkExpired(): Promise<void> {
    if (this._trackedMarkets.size === 0) return;

    const contexts: MarketContext[] = [...this._trackedMarkets.values()].map(({ marketId, expiresAt }) => ({
      marketId,
      expiresAt,
      allocatedBalance: this._deps.balanceAllocator.getAllocation(marketId) ?? Money.ZERO.USDC,
      realizedPnL: Money.ZERO.USDC,
      openOrdersCount: 0,
    }));

    const toClose = this._deps.policy.evaluate(contexts);

    if (toClose.length === 0) return;

    this._logger.info('Expiry check: closing expired markets', { count: toClose.length });

    for (const marketId of toClose) {
      try {
        this._deps.balanceAllocator.release(marketId);

        const timestampResult = TimestampService.fromDate(this._deps.clock.now());
        if (timestampResult.ok) {
          await this._deps.eventBus.publish({
            type: 'MARKET_CLOSED',
            marketId,
            reason: 'EXPIRED',
            realizedPnL: Money.ZERO.USDC,
            timestamp: timestampResult.value,
          });
        } else {
          this._logger.error('Failed to create timestamp for MARKET_CLOSED event', {
            marketId: String(marketId),
          });
        }
      } catch (err) {
        this._logger.error('Unexpected error closing expired market', {
          marketId: String(marketId),
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }
}
