/**
 * StrategyScheduler — ядро reactive scheduling архитектуры.
 *
 * @remarks
 * ### Назначение:
 * Связывает state stores, dirty tracker, стратегии и execution engine
 * в единый event-driven цикл.
 *
 * ### Алгоритм:
 * 1. State store обновляется → `_onStateChanged(instrumentId, reason)`
 * 2. DirtyTracker.markDirty() → стратегия ставится в очередь
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
import type { RiskLimitBreachedEvent } from '@polymarket/event-bus';
import type { IPortfolioStore, IOrderStateStore, IMarketCatalog } from '@polymarket/ports';
import type { Market } from '@polymarket/market';
import type { IStrategy } from './IStrategy.js';
import type { StrategySnapshot } from './types/StrategySnapshot.js';
import type { StrategyIntent } from './types/StrategyIntent.js';
import type { TriggerReason } from './types/TriggerReason.js';
import type { ScheduleConfig } from './types/ScheduleConfig.js';
import { DEFAULT_SCHEDULE_CONFIG } from './types/ScheduleConfig.js';
import { DirtyTracker } from './DirtyTracker.js';
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
}

// ── Внутренние типы ────────────────────────────────────────

interface StrategyEntry {
  readonly strategy: IStrategy;
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
  readonly accountId: AccountId;
  readonly market: Market;
  readonly config: ScheduleConfig;
  lastRunMs: number;
  running: boolean;
  rerunRequested: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
}

// ── Реализация ─────────────────────────────────────────────

export class StrategyScheduler {
  private readonly _logger: ILogger;
  private readonly _dirtyTracker = new DirtyTracker();

  /** strategyId → entry */
  private readonly _entries = new Map<string, StrategyEntry>();
  /** instrumentId → Set<strategyId> */
  private readonly _instrumentToStrategies = new Map<string, Set<string>>();

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
  }

  // ── Публичный API ────────────────────────────────────────

  /**
   * Запускает scheduler.
   *
   * @remarks
   * Активирует обработку очереди. До вызова start() события накапливаются
   * в DirtyTracker, но стратегии не tick'аются.
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

    // Запуск heartbeat
    entry.heartbeatTimer = setInterval(() => {
      this._dirtyTracker.markDirty(strategyId, 'TIMER');
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
    this._dirtyTracker.markDirty(strategyId, reason);
    this._enqueue(strategyId);
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

  /**
   * Реагирует на нарушение риск-лимита.
   *
   * @param event - RiskLimitBreachedEvent
   *
   * @remarks
   * - `event.strategyId` указан → unregister конкретной стратегии
   * - `event.strategyId` undefined → системное нарушение → stopAll
   */
  public async onRiskBreached(event: RiskLimitBreachedEvent): Promise<void> {
    if (event.strategyId) {
      this._logger.warn('Risk limit breached, stopping strategy', {
        strategyId: event.strategyId,
        violationType: event.violationType,
      });
      await this.unregister(event.strategyId);
    } else {
      this._logger.warn('System-wide risk breach, stopping all', {
        violationType: event.violationType,
      });
      await this.stopAll();
    }
  }

  // ── Внутренний механизм: event-driven queue ──────────────

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
      this._dirtyTracker.markDirty(id, reason);
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
        const hasPriority = this._dirtyTracker.hasPriorityTrigger(
          strategyId,
          entry.config.priorityTriggers,
        );
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
        if (this._dirtyTracker.isDirty(strategyId)) {
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
    const reasons = this._dirtyTracker.getReasons(strategyId);
    this._dirtyTracker.clearDirty(strategyId);
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
      if (this._deps.orderStateStore.isMatchedOnExchange(o.id)) {
        matchedOrders.push(o);
      } else {
        openOrders.push(o);
      }
    }

    // Ограничения инструмента из каталога.
    // Стратегия использует для адаптации размеров ордеров вместо
    // молчаливого клампирования в ExecutionEngine.
    const info = this._deps.catalog.get(id);
    const constraints = info
      ? { minOrderSize: info.minOrderSize, minOrderValue: info.minOrderValue, tickSize: info.tickSize }
      : undefined;

    return {
      instrumentId: id,
      market: entry.market,
      topOfBook: this._deps.marketDataStore.getTopOfBook(id),
      bookHistory: this._deps.marketDataStore.getBookHistory(id),
      tradeTape: this._deps.marketDataStore.getTradeTape(id),
      openOrders,
      matchedOrders,
      constraints,
      portfolio: this._deps.portfolioStore.get(entry.accountId),
      nowMs: this._deps.clock.now().getTime(),
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

    // Remove from queue
    this._queued.delete(strategyId);

    // Remove dirty tracking
    this._dirtyTracker.remove(strategyId);

    // Remove entry
    this._entries.delete(strategyId);
  }
}
