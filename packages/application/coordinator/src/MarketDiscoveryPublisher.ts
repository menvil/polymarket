/**
 * MarketDiscoveryPublisher — автономный публикатор новых торговых рынков.
 *
 * @remarks
 * ### Назначение:
 * Периодически опрашивает `IMarketDiscoveryService` (Gamma API),
 * наполняет каталог инструментов и открывает новые рынки через `OpenMarketUseCase`.
 *
 * ### Алгоритм (цикл с паузой ПОСЛЕ завершения):
 * 1. `discoveryService.findCandidates()` → список кандидатов из кэша
 * 2. `marketCatalog.register(candidate)` для каждого — наполняем каталог
 * 3. `marketCatalog.getAll()` → фильтр: active && не в `_openMarkets`
 * 4. `openMarketUseCase.execute()` для каждого нового рынка (до `maxStrategies`)
 * 5. `setTimeout(loop, scanPauseMs)` — пауза после завершения
 *
 * Подписывается на `MARKET_OPENED` / `MARKET_CLOSED` для отслеживания
 * текущих активных рынков без дополнительного состояния.
 *
 * ### Без STRATEGY_TICK:
 * Использует реальный `setTimeout`. Тестирование через `jest.useFakeTimers()`.
 *
 * @example
 * ```typescript
 * const publisher = new MarketDiscoveryPublisher(
 *   { discoveryService, marketCatalog, openMarketUseCase, eventBus, logger },
 *   { accountId, maxStrategies: 10, scanPauseMs: 30_000 },
 * );
 *
 * publisher.start();
 * // Остановить:
 * publisher.stop();
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import type { IMarketCatalog, IMarketDiscoveryService } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import type { OpenMarketUseCase } from '@polymarket/market-lifecycle';

/**
 * Зависимости MarketDiscoveryPublisher.
 */
export interface MarketDiscoveryPublisherDeps {
  /** Сервис обнаружения рынков (Gamma API, с кэшем) */
  readonly discoveryService: IMarketDiscoveryService;
  /** Каталог торговых инструментов */
  readonly marketCatalog: IMarketCatalog;
  /** Use case открытия рынка */
  readonly openMarketUseCase: OpenMarketUseCase;
  /** Event bus для подписки на MARKET_OPENED/MARKET_CLOSED */
  readonly eventBus: IEventBus;
  /** Logger */
  readonly logger: ILogger;
}

/**
 * Конфигурация MarketDiscoveryPublisher.
 */
export interface MarketDiscoveryPublisherConfig {
  /** ID аккаунта для передачи в OpenMarketUseCase */
  readonly accountId: AccountId;
  /** Максимальное количество одновременно активных стратегий */
  readonly maxStrategies: number;
  /** Пауза между циклами discovery (мс), отсчитывается ПОСЛЕ завершения цикла */
  readonly scanPauseMs: number;
}

/**
 * Автономный публикатор обнаружения рынков.
 *
 * @remarks
 * Запускает независимый цикл опроса Gamma API и открывает новые рынки.
 * Не зависит от внешнего тикера.
 */
export class MarketDiscoveryPublisher {
  private readonly _logger: ILogger;
  /** Флаг работы цикла */
  private _running = false;
  /** Идентификатор текущего таймера (для отмены при stop()) */
  private _timeoutId: ReturnType<typeof setTimeout> | undefined;
  /** Текущие открытые рынки (обновляется через MARKET_OPENED/MARKET_CLOSED) */
  private readonly _openMarkets = new Set<string>();
  private _unsubscribeOpened: (() => void) | undefined;
  private _unsubscribeClosed: (() => void) | undefined;

  /**
   * @param _deps - Зависимости публикатора
   * @param _config - Конфигурация параметров
   */
  constructor(
    private readonly _deps: MarketDiscoveryPublisherDeps,
    private readonly _config: MarketDiscoveryPublisherConfig,
  ) {
    this._logger = _deps.logger.child({ component: 'MarketDiscoveryPublisher' });
  }

  /**
   * Запускает цикл обнаружения рынков.
   *
   * @remarks
   * Повторный вызов без предварительного `stop()` — no-op с предупреждением.
   * Первый цикл запускается немедленно, последующие — через `scanPauseMs` после завершения.
   */
  public start(): void {
    if (this._running) {
      this._logger.warn('MarketDiscoveryPublisher already running, ignoring start()');
      return;
    }

    this._running = true;

    this._unsubscribeOpened = this._deps.eventBus.subscribe('MARKET_OPENED', async (event) => {
      this._openMarkets.add(String(event.marketId));
    });

    this._unsubscribeClosed = this._deps.eventBus.subscribe('MARKET_CLOSED', async (event) => {
      this._openMarkets.delete(String(event.marketId));
    });

    this._logger.info('MarketDiscoveryPublisher started', {
      maxStrategies: this._config.maxStrategies,
      scanPauseMs: this._config.scanPauseMs,
    });

    void this._scheduleLoop();
  }

  /**
   * Останавливает цикл обнаружения рынков и отписывается от событий.
   *
   * @remarks
   * Текущий выполняющийся цикл завершится, следующий не запустится.
   */
  public stop(): void {
    this._running = false;
    if (this._timeoutId !== undefined) {
      clearTimeout(this._timeoutId);
      this._timeoutId = undefined;
    }
    this._unsubscribeOpened?.();
    this._unsubscribeClosed?.();
    this._logger.info('MarketDiscoveryPublisher stopped');
  }

  // ── Приватная логика ──────────────────────────────────────────────────────

  /**
   * Планирует следующую итерацию цикла.
   *
   * @remarks
   * Паттерн «пауза после завершения»: `setTimeout` устанавливается
   * в `finally` блоке, после того как `_discover()` завершился.
   */
  private async _scheduleLoop(): Promise<void> {
    if (!this._running) return;
    try {
      await this._discover();
    } finally {
      if (this._running) {
        this._timeoutId = setTimeout(
          () => void this._scheduleLoop(),
          this._config.scanPauseMs,
        );
      }
    }
  }

  /**
   * Одна итерация обнаружения: обновляет каталог и открывает новые рынки.
   */
  private async _discover(): Promise<void> {
    this._logger.debug('Running market discovery');

    let candidates;
    try {
      candidates = await this._deps.discoveryService.findCandidates();
    } catch (err) {
      this._logger.error('Failed to fetch discovery candidates', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    for (const candidate of candidates) {
      this._deps.marketCatalog.register(candidate);
    }

    this._logger.debug('Market catalog updated from discovery', {
      candidates: candidates.length,
    });

    const remainingSlots = this._config.maxStrategies - this._openMarkets.size;
    if (remainingSlots <= 0) {
      this._logger.debug('Max strategies reached, skipping open');
      return;
    }

    const allInstruments = this._deps.marketCatalog.getAll();
    const newInstruments = allInstruments
      .filter((inst) => inst.active && !this._openMarkets.has(String(inst.marketId)))
      .slice(0, remainingSlots);

    if (newInstruments.length === 0) {
      this._logger.debug('No new instruments to open after discovery');
      return;
    }

    for (const inst of newInstruments) {
      const result = await this._deps.openMarketUseCase.execute({
        marketId: inst.marketId,
        strategyId: String(inst.marketId),
        accountId: this._config.accountId,
      });

      if (result.ok) {
        this._logger.info('New market opened via discovery', {
          marketId: String(inst.marketId),
          allocated: result.value.allocatedAmount.toNumber(),
        });
      } else {
        this._logger.debug('Could not open market (allocation failed)', {
          marketId: String(inst.marketId),
          reason: result.error.message,
        });
        // Нет смысла пробовать дальше: нет слотов/баланса
        break;
      }
    }
  }
}
