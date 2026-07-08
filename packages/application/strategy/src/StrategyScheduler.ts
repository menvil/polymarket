/**
 * StrategyScheduler — ядро reactive scheduling архитектуры.
 *
 * @remarks
 * ### Назначение:
 * Связывает state stores, стратегии и execution engine в единый event-driven цикл.
 *
 * ### Алгоритм:
 * 1. State store обновляется → `_onStateChanged(instrumentId, reason)`
 * 2. _markDirty() → стратегия ставится в очередь
 * 3. Microtask worker обрабатывает очередь:
 *    - Throttle check: если рано — deferred re-queue (setTimeout)
 *    - Coalescing: если стратегия running — rerunRequested = true
 *    - Иначе: buildSnapshot → tick → execute
 * 4. После execute: если rerunRequested — немедленный rerun с fresh snapshot
 *
 * ### Event-driven, не polling:
 * Нет `setInterval(5ms)`. Стратегии обрабатываются ТОЛЬКО когда есть данные.
 * - O(events) вместо O(strategies × time)
 * - Zero CPU при idle
 * - Latency < 1ms (microtask)
 *
 * ### Heartbeat:
 * Per-strategy `setInterval(maxIdleMs)` гарантирует periodic tick
 * даже при отсутствии событий (TIMER reason).
 *
 * @example
 * ```typescript
 * const scheduler = new StrategyScheduler(deps);
 * scheduler.start();
 *
 * await scheduler.register({
 *   strategy: new SimpleMarketMaker(),
 *   instrumentId,
 *   asset,
 *   accountId,
 *   market,
 * });
 *
 * // events → state stores → scheduler automatically ticks strategies
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { AccountId, AssetId, InstrumentId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { IPortfolioStore, IOrderStateStore, IMarketCatalog } from '@polymarket/ports';
import type { Market } from '@polymarket/market';
import type { IStrategy } from './IStrategy.js';
import type { StrategySnapshot } from './types/StrategySnapshot.js';
import type { StrategyIntent } from './types/StrategyIntent.js';
import type { TriggerReason } from './types/TriggerReason.js';
import type { ScheduleConfig } from './types/ScheduleConfig.js';
import { DEFAULT_SCHEDULE_CONFIG } from './types/ScheduleConfig.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import type { ExecutionContext } from './ExecutionEngine.js';

// ── Публичные типы ─────────────────────────────────────────

/**
 * Параметры регистрации стратегии.
 */
export interface StrategyRegistration {
  /** Стратегия для регистрации */
  readonly strategy: IStrategy;
  /** Инструмент (outcome token) */
  readonly instrumentId: InstrumentId;
  /** Торговый актив */
  readonly asset: AssetId;
  /** Аккаунт */
  readonly accountId: AccountId;
  /** Рынок (для snapshot) */
  readonly market: Market;
  /** Конфигурация расписания (опционально, по умолчанию DEFAULT_SCHEDULE_CONFIG) */
  readonly config?: Partial<ScheduleConfig>;
  /** Символ крипто-актива для привязки к CryptoPriceStore (e.g. 'btcusdt') */
  readonly cryptoSymbol?: string;
  /** Базовый крипто-актив для asset-scoped history/state (e.g. 'btc'). */
  readonly cryptoAsset?: string;
  /** Время начала торговли на рынке (epoch ms). Из Gamma API eventStartTime. */
  readonly eventStartMs?: number;
  /**
   * Дополнительные инструменты, обновления которых триггерят тик стратегии.
   *
   * @remarks
   * Используется для арбитражных стратегий: стратегия зарегистрирована на hard_Up,
   * но должна тикать и при обновлении easy_Up книги.
   * Snapshot.topOfBook по-прежнему содержит основной instrumentId.
   */
  readonly additionalInstrumentIds?: readonly InstrumentId[];
  /**
   * ID комплементарного токена (другой outcome того же рынка).
   *
   * @remarks
   * Для binary рынков: если основной = UP (outcomeIndex=0), complementary = DOWN (outcomeIndex=1).
   * Trade tape комплементарного токена включается в snapshot как `complementaryTradeTape`.
   * Используется стратегиями для сравнения momentum обоих сторон.
   */
  readonly complementaryInstrumentId?: InstrumentId;
  /**
   * Торговый актив комплементарного токена.
   *
   * @remarks
   * Нужен для auto-selection: стратегия передаёт в PlaceIntent.targetAsset
   * при размещении ордера на комплементарный инструмент.
   */
  readonly complementaryAsset?: AssetId;
}

/**
 * Интерфейс для подачи market data в scheduler.
 *
 * @remarks
 * MarketDataStore вызывает `onStateChanged` при обновлении данных.
 * Scheduler маршрутизирует reason к подписанным стратегиям.
 */
export interface IMarketDataStore {
  /** Подписка на изменения данных */
  setOnChange(cb: (instrumentId: InstrumentId, reason: TriggerReason) => void): void;
  /** Sync read: последний TopOfBook */
  getTopOfBook(instrumentId: InstrumentId): import('@polymarket/event-bus').TopOfBook | undefined;
  /** Sync read: история стакана */
  getBookHistory(instrumentId: InstrumentId): import('@polymarket/order-book').OrderBookHistory | undefined;
  /** Sync read: лента трейдов */
  getTradeTape(instrumentId: InstrumentId): import('@polymarket/trade-tape').TradeTape | undefined;
}

// IOrderStateStore импортирован из @polymarket/ports (re-export для обратной совместимости)

/**
 * Интерфейс strike/resolution-слоя для StrategyScheduler.
 *
 * @remarks
 * Минимальный интерфейс (реализуется `CryptoResolutionStore`). Хранит только
 * lifecycle-метаданные рынка; цены берутся из {@link ICryptoMarketDataStore}.
 */
export interface ICryptoResolutionStore {
  getTarget(symbolOrAsset: string): number | undefined;
  getResolutionPrice(symbolOrAsset: string): number | undefined;
}

export type CryptoMarketDataReason = Extract<TriggerReason, 'CRYPTO_PRICE' | 'CRYPTO_MARKET_DATA'>;

export interface ICryptoMarketDataStore {
  getPriceHistory(symbolOrAsset: string): StrategySnapshot['cryptoPriceHistory'];
  getVenueState(symbolOrAsset: string): StrategySnapshot['cryptoVenueState'];
  getVenueHistory(symbolOrAsset: string): StrategySnapshot['cryptoVenueHistory'];
  setOnChange(cb: (asset: string, reason: CryptoMarketDataReason) => void): void;
}

export interface ICryptoSignalRegistry {
  createView(context: {
    readonly asset: string;
    readonly nowMs: number;
    readonly priceHistory?: StrategySnapshot['cryptoPriceHistory'];
    readonly venueState?: StrategySnapshot['cryptoVenueState'];
    readonly venueHistory?: StrategySnapshot['cryptoVenueHistory'];
  }): StrategySnapshot['cryptoSignals'];
}

/**
 * Зависимости StrategyScheduler.
 */
export interface StrategySchedulerDeps {
  readonly marketDataStore: IMarketDataStore;
  readonly orderStateStore: IOrderStateStore;
  readonly portfolioStore: IPortfolioStore;
  /** Каталог инструментов — для передачи constraints в snapshot */
  readonly catalog: IMarketCatalog;
  readonly executionEngine: ExecutionEngine;
  readonly clock: IClock;
  readonly logger: ILogger;
  /** Опциональный store strike/resolution (для крипто-рынков settlement/snapshot). */
  readonly cryptoResolutionStore?: ICryptoResolutionStore;
  /** Опциональный long-lived store истории и состояния CEX/crypto market data. */
  readonly cryptoMarketDataStore?: ICryptoMarketDataStore;
  /** Опциональный registry reusable signal calculators. */
  readonly cryptoSignalRegistry?: ICryptoSignalRegistry;
}

// ── Внутренние типы ────────────────────────────────────────

interface StrategyEntry {
  readonly strategy: IStrategy;
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
  readonly accountId: AccountId;
  readonly market: Market;
  readonly config: ScheduleConfig;
  /** Символ крипто-актива (e.g. 'btcusdt') — для CryptoPriceStore lookup */
  readonly cryptoSymbol?: string;
  /** Базовый crypto asset (e.g. 'btc') — для долгоживущей истории. */
  readonly cryptoAsset?: string;
  /** Время начала торговли на рынке (epoch ms) */
  readonly eventStartMs?: number;
  /** Дополнительные инструменты для триггера тика */
  readonly additionalInstrumentIds?: readonly InstrumentId[];
  /** ID комплементарного токена */
  readonly complementaryInstrumentId?: InstrumentId;
  /** Торговый актив комплементарного токена */
  readonly complementaryAsset?: AssetId;
  lastRunMs: number;
  running: boolean;
  rerunRequested: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
}

// ── Реализация ─────────────────────────────────────────────

export class StrategyScheduler {
  private readonly _logger: ILogger;
  /** strategyId → накопленные reasons для следующего tick */
  private readonly _dirty = new Map<string, Set<TriggerReason>>();

  /** strategyId → entry */
  private readonly _entries = new Map<string, StrategyEntry>();
  /** instrumentId → Set<strategyId> */
  private readonly _instrumentToStrategies = new Map<string, Set<string>>();
  /** cryptoSymbol → Set<strategyId> */
  private readonly _symbolToStrategies = new Map<string, Set<string>>();
  /** normalized asset → Set<strategyId> */
  private readonly _assetToStrategies = new Map<string, Set<string>>();

  /** Event-driven queue: стратегии ожидающие tick */
  private readonly _queue: string[] = [];
  /** Set для O(1) проверки «уже в очереди?» */
  private readonly _queued = new Set<string>();
  /** Timer IDs для deferred re-queue (throttled strategies) */
  private readonly _deferredTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private _stopped = true;
  private _processing = false;

  constructor(private readonly _deps: StrategySchedulerDeps) {
    this._logger = _deps.logger.child({ component: 'StrategyScheduler' });
    _deps.marketDataStore.setOnChange((instrumentId, reason) => {
      this._onMarketDataChanged(instrumentId, reason);
    });
    // Подписка на обновления крипто-цен/market data. CryptoMarketDataStore
    // эмитит CRYPTO_PRICE на каждом ценовом апдейте — отдельная подписка на
    // ценовой стор больше не нужна (single source of truth).
    if (_deps.cryptoMarketDataStore) {
      _deps.cryptoMarketDataStore.setOnChange((asset, reason) => {
        this._onCryptoMarketDataChanged(asset, reason);
      });
    }
  }

  // ── Публичный API ────────────────────────────────────────

  /**
   * Запускает scheduler.
   *
   * @remarks
   * Активирует обработку очереди. До вызова start() события накапливаются
   * во внутреннем dirty state, но стратегии не tick'аются.
   */
  public start(): void {
    this._stopped = false;
    this._logger.info('StrategyScheduler started');
  }

  /**
   * Останавливает scheduler.
   *
   * @remarks
   * Прекращает обработку очереди. Очередь и dirty flags сохраняются.
   * Стратегии остаются зарегистрированными.
   */
  public stop(): void {
    this._stopped = true;
    // Очищаем все deferred timers
    for (const timer of this._deferredTimers.values()) {
      clearTimeout(timer);
    }
    this._deferredTimers.clear();
    this._logger.info('StrategyScheduler stopped');
  }

  /**
   * Регистрирует стратегию.
   *
   * @param reg - Параметры регистрации
   * @returns Ok при успехе, Err если initialize() вернул ошибку
   *
   * @remarks
   * Вызывает strategy.initialize(). При ошибке — стратегия не регистрируется.
   * При успехе — запускает heartbeat timer и стратегия готова к tick().
   */
  public async register(reg: StrategyRegistration): Promise<Result<void, Error>> {
    const strategyId = reg.strategy.id;

    if (this._entries.has(strategyId)) {
      this._logger.warn('Strategy already registered', { strategyId });
      return Ok(undefined);
    }

    // Initialize strategy
    let initResult;
    try {
      initResult = await reg.strategy.initialize();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._logger.error('Strategy initialization threw', { strategyId, error: error.message });
      return Err(error);
    }

    if (!initResult.ok) {
      this._logger.error('Strategy initialization failed', {
        strategyId,
        error: initResult.error.message,
      });
      return initResult;
    }

    const config: ScheduleConfig = {
      minIntervalMs: reg.config?.minIntervalMs ?? DEFAULT_SCHEDULE_CONFIG.minIntervalMs,
      priorityTriggers: reg.config?.priorityTriggers ?? DEFAULT_SCHEDULE_CONFIG.priorityTriggers,
      maxIdleMs: reg.config?.maxIdleMs ?? DEFAULT_SCHEDULE_CONFIG.maxIdleMs,
    };

    const entry: StrategyEntry = {
      strategy: reg.strategy,
      instrumentId: reg.instrumentId,
      asset: reg.asset,
      accountId: reg.accountId,
      market: reg.market,
      config,
      cryptoSymbol: reg.cryptoSymbol,
      cryptoAsset: reg.cryptoAsset ?? normalizeCryptoAsset(reg.cryptoSymbol),
      eventStartMs: reg.eventStartMs,
      additionalInstrumentIds: reg.additionalInstrumentIds,
      complementaryInstrumentId: reg.complementaryInstrumentId,
      complementaryAsset: reg.complementaryAsset,
      lastRunMs: 0,
      running: false,
      rerunRequested: false,
      heartbeatTimer: undefined,
    };

    this._entries.set(strategyId, entry);

    // Маппинг instrument → strategies
    const instrumentKey = String(reg.instrumentId);
    let set = this._instrumentToStrategies.get(instrumentKey);
    if (set === undefined) {
      set = new Set<string>();
      this._instrumentToStrategies.set(instrumentKey, set);
    }
    set.add(strategyId);

    // Маппинг дополнительных instruments → та же стратегия (для арбитража)
    if (reg.additionalInstrumentIds) {
      for (const addId of reg.additionalInstrumentIds) {
        const addKey = String(addId);
        let addSet = this._instrumentToStrategies.get(addKey);
        if (addSet === undefined) {
          addSet = new Set<string>();
          this._instrumentToStrategies.set(addKey, addSet);
        }
        addSet.add(strategyId);
      }
    }

    // Маппинг cryptoSymbol → strategies
    if (reg.cryptoSymbol) {
      let symSet = this._symbolToStrategies.get(reg.cryptoSymbol);
      if (symSet === undefined) {
        symSet = new Set<string>();
        this._symbolToStrategies.set(reg.cryptoSymbol, symSet);
      }
      symSet.add(strategyId);
    }

    const cryptoAsset = entry.cryptoAsset;
    if (cryptoAsset) {
      let assetSet = this._assetToStrategies.get(cryptoAsset);
      if (assetSet === undefined) {
        assetSet = new Set<string>();
        this._assetToStrategies.set(cryptoAsset, assetSet);
      }
      assetSet.add(strategyId);
    }

    // Запуск heartbeat
    entry.heartbeatTimer = setInterval(() => {
      this._markDirty(strategyId, 'TIMER');
      this._enqueue(strategyId);
    }, config.maxIdleMs).unref();

    this._logger.info('Strategy registered', {
      strategyId,
      name: reg.strategy.name,
      instrumentId: instrumentKey,
    });

    return Ok(undefined);
  }

  /**
   * Снимает регистрацию стратегии.
   *
   * @param strategyId - ID стратегии
   *
   * @remarks
   * Вызывает strategy.stop(), исполняет финальные intents,
   * удаляет из всех внутренних структур.
   */
  public async unregister(strategyId: string): Promise<void> {
    const entry = this._entries.get(strategyId);
    if (!entry) {
      this._logger.warn('Strategy not found for unregister', { strategyId });
      return;
    }

    // Финальные intents
    let finalIntents: StrategyIntent[] = [];
    try {
      finalIntents = entry.strategy.stop();
    } catch (err) {
      this._logger.error('Strategy.stop() threw', {
        strategyId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    // Cleanup ДО execute: удаляем из _entries и останавливаем таймеры
    // прежде чем любой await даст возможность heartbeat/market-data событиям
    // поставить стратегию в очередь ещё раз (race condition fix).
    const ctx = this._makeExecutionContext(entry);
    this._cleanup(strategyId, entry);

    // Исполнение финальных intents (entry уже удалена — новых тиков не будет)
    if (finalIntents.length > 0) {
      try {
        await this._deps.executionEngine.execute(ctx, finalIntents);
      } catch (err) {
        this._logger.error('Failed to execute final intents', {
          strategyId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    this._logger.info('Strategy unregistered', { strategyId });
  }

  /**
   * Останавливает и снимает регистрацию всех стратегий.
   */
  public async stopAll(): Promise<void> {
    const ids = [...this._entries.keys()];
    if (ids.length === 0) return;

    this._logger.warn('Stopping all strategies', { count: ids.length });
    await Promise.all(ids.map((id) => this.unregister(id)));
    this._logger.info('All strategies stopped');
  }

  /**
   * Вызывается при изменении ордера стратегии.
   *
   * @param strategyId - ID стратегии
   * @param reason - Причина (FILL, ORDER_UPDATE)
   *
   * @remarks
   * Вызывается OrderEventBridge при получении ORDER_* событий.
   */
  public onOrderChanged(strategyId: string, reason: TriggerReason): void {
    if (!this._entries.has(strategyId)) return;
    this._markDirty(strategyId, reason);
    this._enqueue(strategyId);
  }

  /**
   * Вызывается при получении FILL_RECEIVED для инструмента.
   *
   * @param instrumentId - Инструмент (tokenId → InstrumentId)
   *
   * @remarks
   * Маршрутизирует fill-уведомление ко всем стратегиям, подписанным на инструмент.
   * Необходим для direct fill path: когда fill приходит на отсутствующий/terminal ордер,
   * ProcessFillUseCase обновляет Portfolio, но не публикует ORDER_* событий.
   * Без этого метода scheduler никогда не узнает о direct fill → стратегия не тикнет.
   */
  public onFillForInstrument(instrumentId: InstrumentId): void {
    // CONFIRMED fill пришёл → on-chain settlement завершён.
    // Сбрасываем post-cancel cooldown — безопасно размещать новые ордера.
    this._deps.executionEngine.clearPostCancelCooldown(instrumentId);

    const strategyIds = this._instrumentToStrategies.get(String(instrumentId));
    if (!strategyIds) return;

    for (const id of strategyIds) {
      this._markDirty(id, 'FILL');
      this._enqueue(id);
    }
  }

  /**
   * Возвращает метрики стратегии.
   *
   * @param strategyId - ID стратегии
   * @returns Метрики или undefined если стратегия не найдена
   */
  public getMetrics(strategyId: string): Record<string, unknown> | undefined {
    return this._entries.get(strategyId)?.strategy.getMetrics();
  }

  // ── Внутренний механизм: event-driven queue ──────────────

  private _onCryptoMarketDataChanged(asset: string, reason: CryptoMarketDataReason): void {
    const strategyIds = this._collectCryptoStrategyIds(asset);
    if (strategyIds.size === 0) return;

    for (const id of strategyIds) {
      this._markDirty(id, reason);
      this._enqueue(id);
    }
  }

  private _collectCryptoStrategyIds(symbolOrAsset: string): Set<string> {
    const result = new Set<string>();

    const exact = this._symbolToStrategies.get(symbolOrAsset);
    if (exact) {
      for (const id of exact) result.add(id);
    }

    const asset = normalizeCryptoAsset(symbolOrAsset);
    if (asset) {
      const byAsset = this._assetToStrategies.get(asset);
      if (byAsset) {
        for (const id of byAsset) result.add(id);
      }
    }

    return result;
  }

  /**
   * Маршрутизация market data events к стратегиям.
   *
   * @remarks
   * Находит все стратегии подписанные на данный инструмент,
   * помечает их dirty и ставит в очередь.
   */
  private _onMarketDataChanged(instrumentId: InstrumentId, reason: TriggerReason): void {
    const strategyIds = this._instrumentToStrategies.get(String(instrumentId));
    if (!strategyIds) return;

    for (const id of strategyIds) {
      this._markDirty(id, reason);
      this._enqueue(id);
    }
  }

  /**
   * Ставит стратегию в очередь если ещё не в ней.
   *
   * @param strategyId - ID стратегии
   */
  private _enqueue(strategyId: string): void {
    if (this._stopped) return;
    if (this._queued.has(strategyId)) return;

    this._queued.add(strategyId);
    this._queue.push(strategyId);
    this._scheduleProcessing();
  }

  /**
   * Планирует обработку очереди через Promise.resolve().then().
   *
   * @remarks
   * Если обработка уже идёт — ничего не делаем, текущий цикл while
   * подхватит новые элементы.
   * Используем Promise.resolve().then() вместо queueMicrotask() чтобы
   * корректно работать с jest.useFakeTimers() в тестах.
   */
  private _scheduleProcessing(): void {
    if (this._processing) return;
    void Promise.resolve().then(() => this._processQueue());
  }

  /**
   * Обрабатывает очередь стратегий.
   *
   * @remarks
   * Microtask worker: берёт стратегии из очереди, проверяет throttle,
   * вызывает tick и запускает execution.
   */
  private _processQueue(): void {
    if (this._processing) return;
    this._processing = true;

    try {
      while (this._queue.length > 0 && !this._stopped) {
        const strategyId = this._queue.shift()!;
        this._queued.delete(strategyId);

        const entry = this._entries.get(strategyId);
        if (!entry) continue;

        // ── Throttle check ──────────────────────────────
        const hasPriority = this._hasPriorityTrigger(strategyId, entry.config.priorityTriggers);
        const now = this._deps.clock.now().getTime();
        const elapsed = now - entry.lastRunMs;
        const remaining = entry.config.minIntervalMs - elapsed;

        if (remaining > 0 && !hasPriority) {
          this._deferRequeue(strategyId, remaining);
          continue;
        }

        // ── Coalescing: если уже running → запомнить и вернуться ──
        if (entry.running) {
          entry.rerunRequested = true;
          continue;
        }

        // ── Execute tick ────────────────────────────────
        this._executeTick(strategyId, entry);
      }
    } finally {
      this._processing = false;
    }
  }

  /**
   * Откладывает re-queue стратегии на delayMs.
   *
   * @param strategyId - ID стратегии
   * @param delayMs - Задержка в ms
   */
  private _deferRequeue(strategyId: string, delayMs: number): void {
    // Отменяем предыдущий таймер если есть
    const existing = this._deferredTimers.get(strategyId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    this._deferredTimers.set(
      strategyId,
      setTimeout(() => {
        this._deferredTimers.delete(strategyId);
        if (this._isDirty(strategyId)) {
          this._enqueue(strategyId);
        }
      }, delayMs).unref(),
    );
  }

  /**
   * Выполняет tick стратегии и запускает execution.
   *
   * @param strategyId - ID стратегии
   * @param entry - Запись стратегии
   *
   * @remarks
   * Coalescing pattern: если rerunRequested после execute — enqueue немедленно.
   */
  private _executeTick(strategyId: string, entry: StrategyEntry): void {
    const snapshot = this._buildSnapshot(entry);
    const reasons = this._getDirtyReasons(strategyId);
    this._clearDirty(strategyId);
    entry.lastRunMs = this._deps.clock.now().getTime();

    let intents: StrategyIntent[];
    try {
      intents = entry.strategy.tick(snapshot, reasons);
    } catch (err) {
      this._logger.error('Strategy.tick() threw', {
        strategyId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    if (intents.length === 0) return;

    this._logger.debug('StrategyScheduler: executing intents', {
      strategyId,
      intentCount: intents.length,
      types: intents.map((i) => i.type === 'PLACE' ? `${i.type}:${i.side}` : i.type).join(','),
    });

    // Async execution с coalescing
    entry.running = true;
    const ctx = this._makeExecutionContext(entry);

    this._deps.executionEngine
      .execute(ctx, intents)
      .then((report) => {
        if (report.errors.length > 0) {
          this._logger.warn('Execution completed with errors', {
            strategyId,
            placed: report.placed,
            cancelled: report.cancelled,
            errors: report.errors.length,
          });
        } else if (report.skipped > 0) {
          this._logger.debug('Execution skipped (market conditions unfavorable)', {
            strategyId,
            skipped: report.skipped,
          });
        }
      })
      .catch((err) => {
        this._logger.error('Execution failed', {
          strategyId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      })
      .finally(() => {
        entry.running = false;
        // Coalescing: новые данные пришли пока мы исполняли
        if (entry.rerunRequested) {
          entry.rerunRequested = false;
          this._enqueue(strategyId);
        }
      });
  }

  // ── Snapshot building ────────────────────────────────────

  /**
   * Собирает StrategySnapshot из in-memory stores.
   *
   * @param entry - Запись стратегии
   * @returns Readonly snapshot для передачи в tick()
   *
   * @remarks
   * Все данные доступны синхронно. O(1) для каждого поля.
   */
  private _buildSnapshot(entry: StrategyEntry): StrategySnapshot {
    const id = entry.instrumentId;

    // Разделяем ордера на cancellable (openOrders) и in-flight (matchedOrders).
    // MATCHED = fill(ы) в пути (MATCHED → MINED → CONFIRMED), отменить нельзя.
    // openOrders — стратегия может отменять/переставлять.
    // matchedOrders — стратегия должна учитывать (чтобы не перекупать), но не отменять.
    const allOpen = this._deps.orderStateStore.getOpenOrdersByInstrument(entry.strategy.id, id);
    const openOrders: import('@polymarket/order').Order[] = [];
    const matchedOrders: import('@polymarket/order').Order[] = [];
    for (const o of allOpen) {
      if (this._deps.orderStateStore.hasMatchedFills(o.id)) {
        matchedOrders.push(o);
      } else {
        openOrders.push(o);
      }
    }

    // Instrument-level in-flight detection:
    // Если есть in-flight fills на инструменте (MATCHED/MINED пришёл, CONFIRMED ещё нет),
    // добавляем виртуальный matched-маркер. Это ловит случай когда ордер уже cancelled/deleted
    // из repo, но fill ещё в пути on-chain.
    const hasInFlightFills = this._deps.orderStateStore.hasInFlightFills(id);
    if (hasInFlightFills && matchedOrders.length === 0) {
      this._deps.logger.debug('Instrument has in-flight fills (no matched orders in repo)', {
        strategyId: entry.strategy.id,
        instrumentId: String(id),
      });
    }

    // Диагностика: логируем застрявшие matched ордера для отладки.
    if (matchedOrders.length > 0) {
      this._deps.logger.debug('Snapshot has matched orders (strategy will HOLD)', {
        strategyId: entry.strategy.id,
        matchedCount: matchedOrders.length,
        matchedOrderIds: matchedOrders.map(o => String(o.id)),
        matchedOrderStatuses: matchedOrders.map(o => o.status),
        matchedOrderSides: matchedOrders.map(o => o.side),
      });
    }

    // Ограничения инструмента из каталога.
    // Стратегия использует для адаптации размеров ордеров вместо
    // молчаливого клампирования в ExecutionEngine.
    const info = this._deps.catalog.get(id);
    const constraints = info
      ? { minOrderSize: info.minOrderSize, minOrderValue: info.minOrderValue, tickSize: info.tickSize }
      : undefined;

    // Крипто-цена: проекция из единых источников истины — цены из
    // CryptoMarketDataStore, strike/resolution из CryptoResolutionStore.
    // (Раньше собиралось из CryptoPriceStore, который дублировал ценовой поток.)
    let cryptoPrice: StrategySnapshot['cryptoPrice'];
    if (entry.cryptoSymbol && this._deps.cryptoMarketDataStore) {
      const ph = this._deps.cryptoMarketDataStore.getPriceHistory(entry.cryptoSymbol);
      const cl = ph?.getLatest('polymarket_chainlink');
      const bn = ph?.getLatest('polymarket_binance');
      const current = cl ?? bn; // Chainlink приоритет (как в прежнем CryptoPriceStore)
      if (current) {
        const targetPrice = this._deps.cryptoResolutionStore?.getTarget(entry.cryptoSymbol);
        const resolutionPrice = this._deps.cryptoResolutionStore?.getResolutionPrice(entry.cryptoSymbol);
        cryptoPrice = {
          asset: normalizeCryptoAsset(entry.cryptoSymbol) ?? entry.cryptoSymbol,
          chainlink: cl ? { price: cl.price, timestampMs: cl.exchangeTsMs } : undefined,
          binance: bn ? { price: bn.price, timestampMs: bn.exchangeTsMs } : undefined,
          targetPrice,
          resolutionPrice,
          resolved: resolutionPrice !== undefined,
          currentPrice: current.price,
          symbol: entry.cryptoSymbol,
        };
      }
    }

    const cryptoLookupKey = entry.cryptoAsset ?? entry.cryptoSymbol;
    const cryptoPriceHistory = cryptoLookupKey && this._deps.cryptoMarketDataStore
      ? this._deps.cryptoMarketDataStore.getPriceHistory(cryptoLookupKey)
      : undefined;
    const cryptoVenueState = cryptoLookupKey && this._deps.cryptoMarketDataStore
      ? this._deps.cryptoMarketDataStore.getVenueState(cryptoLookupKey)
      : undefined;
    const cryptoVenueHistory = cryptoLookupKey && this._deps.cryptoMarketDataStore
      ? this._deps.cryptoMarketDataStore.getVenueHistory(cryptoLookupKey)
      : undefined;
    const nowMs = this._deps.clock.now().getTime();
    const cryptoSignals = cryptoLookupKey && this._deps.cryptoSignalRegistry
      ? this._deps.cryptoSignalRegistry.createView({
          asset: normalizeCryptoAsset(cryptoLookupKey) ?? cryptoLookupKey,
          nowMs,
          priceHistory: cryptoPriceHistory,
          venueState: cryptoVenueState,
          venueHistory: cryptoVenueHistory,
        })
      : undefined;

    const compId = entry.complementaryInstrumentId;
    let complementaryOpenOrders: import('@polymarket/order').Order[] | undefined;
    let complementaryMatchedOrders: import('@polymarket/order').Order[] | undefined;
    let hasComplementaryInFlightFills = false;

    if (compId) {
      const allCompOpen = this._deps.orderStateStore.getOpenOrdersByInstrument(entry.strategy.id, compId);
      complementaryOpenOrders = [];
      complementaryMatchedOrders = [];
      for (const o of allCompOpen) {
        if (this._deps.orderStateStore.hasMatchedFills(o.id)) {
          complementaryMatchedOrders.push(o);
        } else {
          complementaryOpenOrders.push(o);
        }
      }

      hasComplementaryInFlightFills = this._deps.orderStateStore.hasInFlightFills(compId);
      if (hasComplementaryInFlightFills && complementaryMatchedOrders.length === 0) {
        this._deps.logger.debug('Complementary instrument has in-flight fills (no matched orders in repo)', {
          strategyId: entry.strategy.id,
          instrumentId: String(compId),
        });
      }
    }

    return {
      instrumentId: id,
      market: entry.market,
      topOfBook: this._deps.marketDataStore.getTopOfBook(id),
      bookHistory: this._deps.marketDataStore.getBookHistory(id),
      tradeTape: this._deps.marketDataStore.getTradeTape(id),
      openOrders,
      matchedOrders,
      hasInFlightFills,
      constraints,
      cryptoPrice,
      cryptoPriceHistory,
      cryptoVenueState,
      cryptoVenueHistory,
      cryptoSignals,
      portfolio: this._deps.portfolioStore.get(entry.accountId),
      nowMs,
      eventStartMs: entry.eventStartMs,
      complementaryInstrumentId: compId,
      complementaryAsset: entry.complementaryAsset,
      complementaryTopOfBook: compId ? this._deps.marketDataStore.getTopOfBook(compId) : undefined,
      complementaryOpenOrders,
      complementaryMatchedOrders,
      hasComplementaryInFlightFills,
      complementaryTradeTape: compId ? this._deps.marketDataStore.getTradeTape(compId) : undefined,
    };
  }

  /**
   * Создаёт ExecutionContext из entry.
   */
  private _makeExecutionContext(entry: StrategyEntry): ExecutionContext {
    return {
      strategyId: entry.strategy.id,
      accountId: entry.accountId,
      instrumentId: entry.instrumentId,
      asset: entry.asset,
    };
  }

  /**
   * Очищает все внутренние структуры для стратегии.
   */
  private _cleanup(strategyId: string, entry: StrategyEntry): void {
    // Stop heartbeat
    if (entry.heartbeatTimer !== undefined) {
      clearInterval(entry.heartbeatTimer);
    }

    // Cancel deferred timer
    const deferred = this._deferredTimers.get(strategyId);
    if (deferred !== undefined) {
      clearTimeout(deferred);
      this._deferredTimers.delete(strategyId);
    }

    // Remove from instrument map
    const instrumentKey = String(entry.instrumentId);
    const set = this._instrumentToStrategies.get(instrumentKey);
    if (set) {
      set.delete(strategyId);
      if (set.size === 0) {
        this._instrumentToStrategies.delete(instrumentKey);
      }
    }

    // Remove additional instrument mappings
    if (entry.additionalInstrumentIds) {
      for (const addId of entry.additionalInstrumentIds) {
        const addKey = String(addId);
        const addSet = this._instrumentToStrategies.get(addKey);
        if (addSet) {
          addSet.delete(strategyId);
          if (addSet.size === 0) {
            this._instrumentToStrategies.delete(addKey);
          }
        }
      }
    }

    // Remove from symbol map
    if (entry.cryptoSymbol) {
      const symSet = this._symbolToStrategies.get(entry.cryptoSymbol);
      if (symSet) {
        symSet.delete(strategyId);
        if (symSet.size === 0) {
          this._symbolToStrategies.delete(entry.cryptoSymbol);
        }
      }
    }

    if (entry.cryptoAsset) {
      const assetSet = this._assetToStrategies.get(entry.cryptoAsset);
      if (assetSet) {
        assetSet.delete(strategyId);
        if (assetSet.size === 0) {
          this._assetToStrategies.delete(entry.cryptoAsset);
        }
      }
    }

    // Remove from queue
    this._queued.delete(strategyId);

    // Remove dirty tracking
    this._removeDirty(strategyId);

    // Remove entry
    this._entries.delete(strategyId);
  }

  // ── Dirty tracking (инлайн из DirtyTracker) ───────────────

  private _markDirty(strategyId: string, reason: TriggerReason): void {
    let reasons = this._dirty.get(strategyId);
    if (reasons === undefined) {
      reasons = new Set<TriggerReason>();
      this._dirty.set(strategyId, reasons);
    }
    reasons.add(reason);
  }

  private _isDirty(strategyId: string): boolean {
    const reasons = this._dirty.get(strategyId);
    return reasons !== undefined && reasons.size > 0;
  }

  /** Возвращает копию накопленных reasons, чтобы внешний код не мог мутировать внутренний Set. */
  private _getDirtyReasons(strategyId: string): ReadonlySet<TriggerReason> {
    const reasons = this._dirty.get(strategyId);
    if (reasons === undefined || reasons.size === 0) return _EMPTY_DIRTY_SET;
    return new Set(reasons);
  }

  private _clearDirty(strategyId: string): void {
    this._dirty.get(strategyId)?.clear();
  }

  private _hasPriorityTrigger(strategyId: string, priorities: ReadonlySet<TriggerReason>): boolean {
    const reasons = this._dirty.get(strategyId);
    if (!reasons || reasons.size === 0) return false;
    for (const reason of reasons) {
      if (priorities.has(reason)) return true;
    }
    return false;
  }

  private _removeDirty(strategyId: string): void {
    this._dirty.delete(strategyId);
  }
}

function normalizeCryptoAsset(symbolOrAsset: string | undefined): string | undefined {
  if (!symbolOrAsset) return undefined;
  const normalized = symbolOrAsset.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('/')) return normalized.split('/')[0] || undefined;
  if (normalized.includes('-')) return normalized.split('-')[0] || undefined;
  return normalized.replace(/usd[tc]?$/i, '') || undefined;
}

/** Singleton пустой Set для _getDirtyReasons() — не аллоцируем объект каждый вызов */
const _EMPTY_DIRTY_SET: ReadonlySet<TriggerReason> = new Set();
