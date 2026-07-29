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
 *    - Throttle check: если рано — deferred re-queue (timer port)
 *    - Coalescing: если стратегия running — rerunRequested = true
 *    - Иначе: buildSnapshot → tick → execute
 * 4. После execute: если rerunRequested — немедленный rerun с fresh snapshot
 *
 * ### Lifecycle стратегии (ACTIVE → STOPPING → STOPPED):
 * `unregister()` — единственный безопасный stop-flow:
 * 1. атомарный переход ACTIVE → STOPPING (повторный unregister ждёт тот же Promise);
 * 2. немедленный detach: heartbeat, routing, deferred timer, queue;
 * 3. ожидание активного `executionPromise` (обычный execution);
 * 4. `strategy.stop()` → final intents;
 * 5. исполнение final intents (никогда не параллельно с обычным execution);
 * 6. только после этого — удаление entry и переход в STOPPED.
 * События (BOOK/FILL/ORDER_UPDATE) во время STOPPING не ставят стратегию в очередь.
 *
 * ### Exception isolation:
 * Каждый queue item обёрнут в exception boundary: сбой snapshot/tick одной
 * стратегии не останавливает worker для остальных. Dirty reasons при сбое
 * сливаются обратно (атомарный drain: take → try → merge-back on error),
 * retry — deferred с backoff (без tight loop).
 *
 * ### Детерминизм:
 * Все таймеры — через порт `ISchedulerTimer` (production: NodeSchedulerTimer;
 * replay/backtest: DeterministicSchedulerTimer). Прямых setTimeout/setInterval
 * в оркестрации нет.
 *
 * ### Watchdog:
 * Зависший `ExecutionEngine.execute()` (> config.executionTimeoutMs) помечает
 * стратегию `faulted`: новые тики блокируются до `unregister()` (controlled
 * recovery). Параллельный второй execution НЕ запускается.
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
import type { InstrumentConstraints } from './types/InstrumentConstraints.js';
import type { TriggerReason } from './types/TriggerReason.js';
import type { ScheduleConfig } from './types/ScheduleConfig.js';
import { DEFAULT_SCHEDULE_CONFIG, validateScheduleConfig } from './types/ScheduleConfig.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import type { ExecutionContext } from './ExecutionEngine.js';
import type { ISchedulerTimer, TimerHandle } from './ports/SchedulerTimer.js';

// ── Публичные типы ─────────────────────────────────────────

/**
 * Lifecycle-состояние зарегистрированной стратегии.
 *
 * @remarks
 * - `ACTIVE` — стратегия тикает и исполняет intents.
 * - `STOPPING` — начат unregister: новые тики/enqueue запрещены, идёт
 *   ожидание активного execution и исполнение final intents.
 * - `STOPPED` — stop-flow завершён, entry удалена.
 */
export type StrategyLifecycle = 'ACTIVE' | 'STOPPING' | 'STOPPED';

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
   * `complementaryInstrumentId` сюда дублировать НЕ нужно — он добавляется
   * в routing автоматически.
   */
  readonly additionalInstrumentIds?: readonly InstrumentId[];
  /**
   * ID комплементарного токена (другой outcome того же рынка).
   *
   * @remarks
   * Для binary рынков: если основной = UP (outcomeIndex=0), complementary = DOWN (outcomeIndex=1).
   * Автоматически добавляется в instrument routing (book/trade/fill/order
   * события комплементарного токена триггерят тик стратегии).
   * Обязателен ПАРОЙ с `complementaryAsset` (оба или ни одного).
   */
  readonly complementaryInstrumentId?: InstrumentId;
  /**
   * Торговый актив комплементарного токена.
   *
   * @remarks
   * Нужен для auto-selection: стратегия передаёт в PlaceIntent.targetAsset
   * при размещении ордера на комплементарный инструмент.
   * Обязателен ПАРОЙ с `complementaryInstrumentId`.
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
  /** Порт таймеров (production: NodeSchedulerTimer; replay: DeterministicSchedulerTimer). */
  readonly timer: ISchedulerTimer;
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
  /** Дедуплицированные instrument-ключи routing-а (primary+additional+complementary). */
  readonly routingInstrumentKeys: readonly string[];
  /** Lifecycle-состояние (см. {@link StrategyLifecycle}). */
  lifecycle: StrategyLifecycle;
  /** Promise stop-flow (устанавливается при переходе в STOPPING). */
  stopPromise: Promise<void> | undefined;
  /** Promise текущего обычного execution (undefined, если execution не идёт). */
  executionPromise: Promise<void> | undefined;
  /** Watchdog сработал: execution завис, стратегия заблокирована до unregister. */
  faulted: boolean;
  /** Подряд неуспешных snapshot/tick — для deferred backoff. */
  consecutiveFailures: number;
  lastRunMs: number;
  running: boolean;
  rerunRequested: boolean;
  heartbeatTimer: TimerHandle | undefined;
}

/** Максимальная задержка deferred retry при повторных сбоях snapshot/tick (ms). */
const FAILURE_BACKOFF_MAX_MS = 5_000;
/** Базовая задержка deferred retry при сбое snapshot/tick (ms). */
const FAILURE_BACKOFF_BASE_MS = 100;

// ── Реализация ─────────────────────────────────────────────

export class StrategyScheduler {
  private readonly _logger: ILogger;
  /** strategyId → накопленные reasons для следующего tick */
  private readonly _dirty = new Map<string, Set<TriggerReason>>();

  /** strategyId → entry */
  private readonly _entries = new Map<string, StrategyEntry>();
  /** Registrations-in-progress (single-flight guard от concurrent register одного ID). */
  private readonly _registrationsInProgress = new Set<string>();
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
  /** Timer handles для deferred re-queue (throttled strategies / failure backoff) */
  private readonly _deferredTimers = new Map<string, TimerHandle>();

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
   * Запускает (или возобновляет) scheduler.
   *
   * @remarks
   * Идемпотентен: повторный вызов на уже запущенном scheduler — no-op.
   * Возобновление после `stop()`:
   * - сохранённая queue продолжает обрабатываться;
   * - dirty-но-не-queued стратегии ставятся обратно в очередь;
   * - `_scheduleProcessing()` вызывается при наличии работы.
   * Стратегия, находившаяся в queue до `stop()`, обрабатывается сразу после
   * `start()` без ожидания нового внешнего события.
   */
  public start(): void {
    if (!this._stopped) return;
    this._stopped = false;

    // Resume: dirty стратегии, не попавшие в очередь (события пришли во время
    // паузы — _enqueue при stopped return-ится, но dirty сохраняется).
    for (const [strategyId, entry] of this._entries) {
      if (entry.lifecycle !== 'ACTIVE') continue;
      if (this._isDirty(strategyId)) {
        this._enqueue(strategyId);
      }
    }

    if (this._queue.length > 0) {
      this._scheduleProcessing();
    }

    this._logger.info('StrategyScheduler started');
  }

  /**
   * Приостанавливает scheduler (pause).
   *
   * @remarks
   * - новые тики не запускаются;
   * - АКТИВНЫЕ execute не прерываются (докатываются до конца);
   * - queue и dirty reasons сохраняются;
   * - deferred timers очищаются (пересоздадутся после `start()` при
   *   обработке сохранённой queue/dirty);
   * - стратегии остаются зарегистрированными, heartbeat продолжает
   *   помечать dirty (enqueue при stopped — no-op, dirty сохраняется).
   */
  public stop(): void {
    this._stopped = true;
    // Очищаем все deferred timers — dirty state сохранён, start() восстановит.
    for (const handle of this._deferredTimers.values()) {
      this._deps.timer.clearTimeout(handle);
    }
    this._deferredTimers.clear();
    this._logger.info('StrategyScheduler stopped');
  }

  /**
   * Регистрирует стратегию.
   *
   * @param reg - Параметры регистрации
   * @returns Ok при успехе; Err если: дубликат strategy.id (включая
   *   registration-in-progress), невалидный ScheduleConfig, неполная
   *   complementary-пара, либо initialize() вернул ошибку/бросил
   *
   * @remarks
   * Вызывает strategy.initialize(). При ошибке — стратегия не регистрируется.
   * При успехе — запускает heartbeat timer и стратегия готова к tick().
   * Concurrent register одного ID защищён single-flight guard-ом
   * (`_registrationsInProgress`): initialize() вызывается ровно один раз.
   */
  public async register(reg: StrategyRegistration): Promise<Result<void, Error>> {
    const strategyId = reg.strategy.id;

    // Duplicate → Err (НЕ Ok): молчаливый Ok маскировал бы двойную регистрацию.
    if (this._entries.has(strategyId) || this._registrationsInProgress.has(strategyId)) {
      this._logger.warn('Strategy already registered (or registration in progress)', { strategyId });
      return Err(new Error(`Strategy already registered: ${strategyId}`));
    }

    // Комплементарная пара — атомарно: оба поля или ни одного.
    if ((reg.complementaryInstrumentId === undefined) !== (reg.complementaryAsset === undefined)) {
      return Err(new Error(
        `Strategy registration requires complementaryInstrumentId and complementaryAsset as a pair: ${strategyId}`,
      ));
    }

    // Конфигурация: копируем внешний Set (защита от последующей мутации caller-ом)
    // и валидируем ДО initialize/heartbeat.
    const config: ScheduleConfig = {
      minIntervalMs: reg.config?.minIntervalMs ?? DEFAULT_SCHEDULE_CONFIG.minIntervalMs,
      priorityTriggers: new Set(reg.config?.priorityTriggers ?? DEFAULT_SCHEDULE_CONFIG.priorityTriggers),
      maxIdleMs: reg.config?.maxIdleMs ?? DEFAULT_SCHEDULE_CONFIG.maxIdleMs,
      executionTimeoutMs: reg.config?.executionTimeoutMs ?? DEFAULT_SCHEDULE_CONFIG.executionTimeoutMs,
    };
    const configResult = validateScheduleConfig(config);
    if (!configResult.ok) {
      this._logger.error('Strategy registration rejected — invalid ScheduleConfig', {
        strategyId,
        error: configResult.error.message,
      });
      return Err(configResult.error);
    }

    // Single-flight: с этого момента concurrent register того же ID получает Err.
    this._registrationsInProgress.add(strategyId);
    try {
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

      // Routing instruments: primary + additional + complementary, дедуплицированно.
      const routingKeys = new Set<string>();
      routingKeys.add(String(reg.instrumentId));
      for (const addId of reg.additionalInstrumentIds ?? []) {
        routingKeys.add(String(addId));
      }
      if (reg.complementaryInstrumentId !== undefined) {
        routingKeys.add(String(reg.complementaryInstrumentId));
      }

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
        routingInstrumentKeys: [...routingKeys],
        lifecycle: 'ACTIVE',
        stopPromise: undefined,
        executionPromise: undefined,
        faulted: false,
        consecutiveFailures: 0,
        lastRunMs: 0,
        running: false,
        rerunRequested: false,
        heartbeatTimer: undefined,
      };

      this._entries.set(strategyId, entry);

      // Маппинг instrument → strategies (primary + additional + complementary).
      for (const key of entry.routingInstrumentKeys) {
        let set = this._instrumentToStrategies.get(key);
        if (set === undefined) {
          set = new Set<string>();
          this._instrumentToStrategies.set(key, set);
        }
        set.add(strategyId);
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

      // Запуск heartbeat (через timer port — детерминизм в replay).
      entry.heartbeatTimer = this._deps.timer.setInterval(() => {
        const current = this._entries.get(strategyId);
        if (!current || current.lifecycle !== 'ACTIVE') return;
        this._markDirty(strategyId, 'TIMER');
        this._enqueue(strategyId);
      }, config.maxIdleMs);

      this._logger.info('Strategy registered', {
        strategyId,
        name: reg.strategy.name,
        instrumentId: String(reg.instrumentId),
        routingInstruments: entry.routingInstrumentKeys,
      });

      return Ok(undefined);
    } finally {
      this._registrationsInProgress.delete(strategyId);
    }
  }

  /**
   * Безопасно снимает регистрацию стратегии (lifecycle-aware stop-flow).
   *
   * @param strategyId - ID стратегии
   *
   * @remarks
   * Инварианты:
   * - ACTIVE → STOPPING атомарно (synchronous до первого await);
   * - немедленно: heartbeat остановлен, routing удалён, deferred timer
   *   отменён, стратегия убрана из queue — новые тики невозможны;
   * - ждёт активный `executionPromise` (обычный execution) ДО strategy.stop();
   * - final intents исполняются ПОСЛЕ обычного execution (никогда параллельно);
   * - entry удаляется и lifecycle → STOPPED только после final intents;
   * - повторный/concurrent unregister ждёт ТОТ ЖЕ stopPromise
   *   (strategy.stop() и final intents выполняются ровно один раз).
   */
  public async unregister(strategyId: string): Promise<void> {
    const entry = this._entries.get(strategyId);
    if (!entry) {
      this._logger.warn('Strategy not found for unregister', { strategyId });
      return;
    }

    if (entry.lifecycle !== 'ACTIVE') {
      // Уже STOPPING/STOPPED — ждём существующий stop-flow (idempotent).
      if (entry.stopPromise) {
        await entry.stopPromise;
      }
      return;
    }

    // Атомарный переход ACTIVE → STOPPING (synchronous — второй unregister
    // в этом же tick увидит STOPPING и уйдёт в ветку ожидания выше).
    entry.lifecycle = 'STOPPING';
    const stopPromise = this._stopEntry(strategyId, entry);
    entry.stopPromise = stopPromise;
    await stopPromise;
  }

  /**
   * Полный stop-flow одной стратегии (вызывается ровно один раз).
   *
   * @param strategyId - ID стратегии
   * @param entry - Entry в состоянии STOPPING
   */
  private async _stopEntry(strategyId: string, entry: StrategyEntry): Promise<void> {
    // Шаг 1: немедленный detach — новые тики/enqueue невозможны.
    this._detachEntry(strategyId, entry);

    // Шаг 2: дождаться текущего обычного execution (если идёт).
    // Faulted (watchdog сработал) — НЕ ждём: promise может никогда не
    // завершиться; исход уже классифицирован как небезопасный.
    if (entry.executionPromise !== undefined && !entry.faulted) {
      try {
        await entry.executionPromise;
      } catch {
        // executionPromise обёрнут (.catch в _executeTick) и не должен
        // отклоняться; boundary на случай нарушения инварианта.
      }
    } else if (entry.faulted) {
      this._logger.error('Unregister proceeding without waiting for faulted (hung) execution', {
        strategyId,
      });
    }

    // Шаг 3: strategy.stop() → final intents (ПОСЛЕ завершения execution).
    let finalIntents: StrategyIntent[] = [];
    try {
      finalIntents = entry.strategy.stop();
    } catch (err) {
      this._logger.error('Strategy.stop() threw', {
        strategyId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    // Шаг 4: исполнение final intents (обычный execution уже завершён —
    // final CANCEL_ALL видит в repo и ордера, сохранённые «поздним» PLACE).
    if (finalIntents.length > 0) {
      const ctx = this._makeExecutionContext(entry);
      try {
        await this._deps.executionEngine.execute(ctx, finalIntents);
      } catch (err) {
        this._logger.error('Failed to execute final intents', {
          strategyId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    // Шаг 5: финализация — только после final intents.
    entry.lifecycle = 'STOPPED';
    this._entries.delete(strategyId);
    this._logger.info('Strategy unregistered', { strategyId });
  }

  /**
   * Останавливает и снимает регистрацию всех стратегий (безопасный flow).
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
   * Стратегии в STOPPING/STOPPED не enqueue-ятся.
   */
  public onOrderChanged(strategyId: string, reason: TriggerReason): void {
    const entry = this._entries.get(strategyId);
    if (!entry || entry.lifecycle !== 'ACTIVE') return;
    this._markDirty(strategyId, reason);
    this._enqueue(strategyId);
  }

  /**
   * Вызывается при получении FILL_RECEIVED для инструмента (до finality).
   *
   * @param instrumentId - Инструмент (tokenId → InstrumentId)
   *
   * @remarks
   * ТОЛЬКО пометка dirty + enqueue связанных стратегий. НЕ снимает
   * post-cancel cooldown и НЕ выполняет finality-dependent cleanup:
   * received-fill ещё не финален — размещение поверх него небезопасно.
   */
  public onFillReceivedForInstrument(instrumentId: InstrumentId): void {
    const strategyIds = this._instrumentToStrategies.get(String(instrumentId));
    if (!strategyIds) return;

    for (const id of strategyIds) {
      const entry = this._entries.get(id);
      if (!entry || entry.lifecycle !== 'ACTIVE') continue;
      this._markDirty(id, 'FILL');
      this._enqueue(id);
    }
  }

  /**
   * Вызывается при получении FILL_CONFIRMED для инструмента (finality).
   *
   * @param instrumentId - Инструмент (tokenId → InstrumentId)
   *
   * @remarks
   * Finality-dependent cleanup: снимает post-cancel cooldown и exchange
   * rejection cooldown (on-chain settlement завершён — безопасно размещать
   * новые ордера), затем помечает связанные стратегии dirty и enqueue-ит.
   */
  public onFillConfirmedForInstrument(instrumentId: InstrumentId): void {
    this._deps.executionEngine.clearPostCancelCooldown(instrumentId);
    this._deps.executionEngine.clearExchangeRejectionCooldown(instrumentId);

    const strategyIds = this._instrumentToStrategies.get(String(instrumentId));
    if (!strategyIds) return;

    for (const id of strategyIds) {
      const entry = this._entries.get(id);
      if (!entry || entry.lifecycle !== 'ACTIVE') continue;
      this._markDirty(id, 'FILL');
      this._enqueue(id);
    }
  }

  /**
   * Возвращает метрики стратегии (с exception boundary).
   *
   * @param strategyId - ID стратегии
   * @returns Метрики; `{}` если getMetrics() бросил; undefined если стратегия не найдена
   *
   * @remarks
   * Ошибка метрик не ломает scheduler/caller: логируется, возвращается
   * безопасный пустой объект.
   */
  public getMetrics(strategyId: string): Record<string, unknown> | undefined {
    const entry = this._entries.get(strategyId);
    if (!entry) return undefined;
    try {
      return entry.strategy.getMetrics();
    } catch (err) {
      this._logger.error('Strategy.getMetrics() threw', {
        strategyId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return {};
    }
  }

  // ── Внутренний механизм: event-driven queue ──────────────

  private _onCryptoMarketDataChanged(asset: string, reason: CryptoMarketDataReason): void {
    const strategyIds = this._collectCryptoStrategyIds(asset);
    if (strategyIds.size === 0) return;

    for (const id of strategyIds) {
      const entry = this._entries.get(id);
      if (!entry || entry.lifecycle !== 'ACTIVE') continue;
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
   * Находит все стратегии подписанные на данный инструмент (включая
   * complementary/additional routing), помечает их dirty и ставит в очередь.
   * STOPPING/STOPPED стратегии игнорируются.
   */
  private _onMarketDataChanged(instrumentId: InstrumentId, reason: TriggerReason): void {
    const strategyIds = this._instrumentToStrategies.get(String(instrumentId));
    if (!strategyIds) return;

    for (const id of strategyIds) {
      const entry = this._entries.get(id);
      if (!entry || entry.lifecycle !== 'ACTIVE') continue;
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

    const entry = this._entries.get(strategyId);
    if (!entry || entry.lifecycle !== 'ACTIVE' || entry.faulted) return;

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
   * `.catch()` обязателен: unhandled rejection из worker-а не должен
   * ронять процесс.
   */
  private _scheduleProcessing(): void {
    if (this._processing) return;
    void Promise.resolve()
      .then(() => this._processQueue())
      .catch((err) => {
        this._logger.error('StrategyScheduler queue processing failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      });
  }

  /**
   * Обрабатывает очередь стратегий.
   *
   * @remarks
   * Microtask worker: берёт стратегии из очереди, проверяет throttle,
   * вызывает tick и запускает execution. КАЖДЫЙ item обёрнут в exception
   * boundary — сбой одной стратегии не останавливает worker для остальных.
   */
  private _processQueue(): void {
    if (this._processing) return;
    this._processing = true;

    try {
      while (this._queue.length > 0 && !this._stopped) {
        const strategyId = this._queue.shift()!;
        this._queued.delete(strategyId);

        try {
          this._processQueueItem(strategyId);
        } catch (err) {
          // Boundary последней линии: _processQueueItem сам изолирует
          // snapshot/tick; сюда попадают только неожиданные сбои.
          this._logger.error('StrategyScheduler: queue item processing threw', {
            strategyId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    } finally {
      this._processing = false;
    }
  }

  /**
   * Обрабатывает один элемент очереди (throttle → coalescing → tick).
   *
   * @param strategyId - ID стратегии
   */
  private _processQueueItem(strategyId: string): void {
    const entry = this._entries.get(strategyId);
    if (!entry || entry.lifecycle !== 'ACTIVE' || entry.faulted) return;

    // ── Throttle check ──────────────────────────────
    const hasPriority = this._hasPriorityTrigger(strategyId, entry.config.priorityTriggers);
    const now = this._deps.clock.now().getTime();
    const elapsed = now - entry.lastRunMs;
    const remaining = entry.config.minIntervalMs - elapsed;

    if (remaining > 0 && !hasPriority) {
      this._deferRequeue(strategyId, remaining);
      return;
    }

    // ── Coalescing: если уже running → запомнить и вернуться ──
    if (entry.running) {
      entry.rerunRequested = true;
      return;
    }

    // ── Execute tick ────────────────────────────────
    this._executeTick(strategyId, entry);
  }

  /**
   * Откладывает re-queue стратегии на delayMs (через timer port).
   *
   * @param strategyId - ID стратегии
   * @param delayMs - Задержка в ms
   */
  private _deferRequeue(strategyId: string, delayMs: number): void {
    // Отменяем предыдущий таймер если есть
    const existing = this._deferredTimers.get(strategyId);
    if (existing !== undefined) {
      this._deps.timer.clearTimeout(existing);
    }

    this._deferredTimers.set(
      strategyId,
      this._deps.timer.setTimeout(() => {
        this._deferredTimers.delete(strategyId);
        if (this._isDirty(strategyId)) {
          this._enqueue(strategyId);
        }
      }, delayMs),
    );
  }

  /**
   * Обрабатывает сбой snapshot/tick: merge reasons обратно + deferred retry с backoff.
   *
   * @param strategyId - ID стратегии
   * @param entry - Entry
   * @param reasons - Reasons, взятые для этого tick (возвращаются в dirty)
   * @param err - Ошибка
   * @param stage - Этап сбоя ('snapshot' | 'tick')
   *
   * @remarks
   * Атомарный drain-контракт: reasons считаются обработанными ТОЛЬКО при
   * успешном tick; при сбое они сливаются обратно в dirty state. Retry —
   * deferred с экспоненциальным backoff (base 100ms, cap 5s) — никакого
   * tight loop на постоянно падающей стратегии; плюс её всё равно
   * подстрахует следующий heartbeat/event.
   */
  private _handleTickFailure(
    strategyId: string,
    entry: StrategyEntry,
    reasons: ReadonlySet<TriggerReason>,
    err: unknown,
    stage: 'snapshot' | 'tick',
  ): void {
    this._logger.error(`Strategy ${stage} failed — controlled retry with backoff`, {
      strategyId,
      stage,
      consecutiveFailures: entry.consecutiveFailures + 1,
      err: err instanceof Error ? err : new Error(String(err)),
    });

    // Merge reasons обратно (dirty не теряется).
    for (const reason of reasons) {
      this._markDirty(strategyId, reason);
    }

    entry.consecutiveFailures += 1;
    const backoffMs = Math.min(
      FAILURE_BACKOFF_MAX_MS,
      FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(entry.consecutiveFailures - 1, 10),
    );
    this._deferRequeue(strategyId, backoffMs);
  }

  /**
   * Выполняет tick стратегии и запускает execution.
   *
   * @param strategyId - ID стратегии
   * @param entry - Запись стратегии
   *
   * @remarks
   * Exception boundaries: buildSnapshot и strategy.tick() изолированы —
   * сбой приводит к merge-back dirty reasons + deferred retry (см.
   * {@link _handleTickFailure}), worker продолжает остальные стратегии.
   * `entry.lastRunMs` обновляется ТОЛЬКО после успешного tick.
   * Execution обёрнут в watchdog (config.executionTimeoutMs).
   */
  private _executeTick(strategyId: string, entry: StrategyEntry): void {
    // Атомарный drain: take reasons → try snapshot/tick → merge-back on error.
    const reasons = this._getDirtyReasons(strategyId);
    this._clearDirty(strategyId);

    let snapshot: StrategySnapshot;
    try {
      snapshot = this._buildSnapshot(entry);
    } catch (err) {
      this._handleTickFailure(strategyId, entry, reasons, err, 'snapshot');
      return;
    }

    let intents: StrategyIntent[];
    try {
      intents = entry.strategy.tick(snapshot, reasons);
    } catch (err) {
      this._handleTickFailure(strategyId, entry, reasons, err, 'tick');
      return;
    }

    // Успешный tick: reasons обработаны, failure-счётчик сбрасывается,
    // lastRunMs фиксируется (throttle отсчитывается от успешного tick).
    entry.consecutiveFailures = 0;
    entry.lastRunMs = this._deps.clock.now().getTime();

    if (intents.length === 0) return;

    this._logger.debug('StrategyScheduler: executing intents', {
      strategyId,
      intentCount: intents.length,
      types: intents.map((i) => i.type === 'PLACE' ? `${i.type}:${i.side}` : i.type).join(','),
    });

    // Async execution с coalescing + watchdog.
    entry.running = true;
    const ctx = this._makeExecutionContext(entry);

    // Watchdog: state-machine защита от зависшего execute(). Мы НЕ отменяем
    // Promise (JS не может отменить неотменяемую операцию) — стратегия
    // помечается faulted и блокируется до unregister (controlled recovery).
    let watchdogFired = false;
    const watchdogHandle = this._deps.timer.setTimeout(() => {
      watchdogFired = true;
      entry.faulted = true;
      this._logger.error('CRITICAL: ExecutionEngine.execute() exceeded executionTimeoutMs — strategy marked faulted, requires unregister/manual recovery', {
        strategyId,
        executionTimeoutMs: entry.config.executionTimeoutMs,
      });
    }, entry.config.executionTimeoutMs);

    const executionPromise = this._deps.executionEngine
      .execute(ctx, intents)
      .then((report) => {
        if (report.errors.length > 0) {
          this._logger.warn('Execution completed with errors', {
            strategyId,
            placed: report.placed,
            cancelled: report.cancelled,
            blockedByUnsafeCancel: report.blockedByUnsafeCancel,
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
        this._deps.timer.clearTimeout(watchdogHandle);
        entry.running = false;
        if (entry.executionPromise === executionPromise) {
          entry.executionPromise = undefined;
        }
        if (watchdogFired) {
          // Watchdog уже сработал: исход НЕ считается безопасным, faulted
          // остаётся до unregister (controlled recovery).
          this._logger.error('Execution finished AFTER watchdog timeout — strategy remains faulted until unregister', {
            strategyId,
          });
          return;
        }
        // Coalescing: новые данные пришли пока мы исполняли
        if (entry.rerunRequested) {
          entry.rerunRequested = false;
          if (entry.lifecycle === 'ACTIVE') {
            this._enqueue(strategyId);
          }
        }
      });

    entry.executionPromise = executionPromise;
  }

  // ── Snapshot building ────────────────────────────────────

  /**
   * Собирает InstrumentConstraints из каталога.
   *
   * @param instrumentId - ID инструмента
   * @returns Constraints или undefined если инструмент неизвестен каталогу
   */
  private _constraintsFor(instrumentId: InstrumentId): InstrumentConstraints | undefined {
    const info = this._deps.catalog.get(instrumentId);
    return info
      ? { minOrderSize: info.minOrderSize, minOrderValue: info.minOrderValue, tickSize: info.tickSize }
      : undefined;
  }

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

    // Instrument-level unsettled detection (Stage 6): venue in-flight (MATCHED/
    // MINED без CONFIRMED) ЛИБО application processing-блок (FAILED_RETRYABLE/
    // RECONCILIATION_REQUIRED). Единый guard hasUnsettledFills — ловит и fill в
    // пути on-chain, и fill, не долитый до конца в ProcessFillUseCase.
    const hasInFlightFills = this._deps.orderStateStore.hasUnsettledFills(id);
    if (hasInFlightFills && matchedOrders.length === 0) {
      this._deps.logger.debug('Instrument has unsettled fills (no matched orders in repo)', {
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
    const constraints = this._constraintsFor(id);

    // Крипто-цена: проекция из единых источников истины — цены из
    // CryptoMarketDataStore, strike/resolution из CryptoResolutionStore.
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

      hasComplementaryInFlightFills = this._deps.orderStateStore.hasUnsettledFills(compId);
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
      complementaryConstraints: compId ? this._constraintsFor(compId) : undefined,
      hasComplementaryInFlightFills,
      complementaryTradeTape: compId ? this._deps.marketDataStore.getTradeTape(compId) : undefined,
    };
  }

  /**
   * Создаёт ExecutionContext из entry.
   *
   * @remarks
   * `allowedInstruments` — routing-инструменты регистрации (primary +
   * additional + complementary): ExecutionEngine отклоняет PLACE с
   * targetInstrumentId вне этого набора (fail-closed).
   */
  private _makeExecutionContext(entry: StrategyEntry): ExecutionContext {
    return {
      strategyId: entry.strategy.id,
      accountId: entry.accountId,
      instrumentId: entry.instrumentId,
      asset: entry.asset,
      allowedInstruments: new Set(entry.routingInstrumentKeys),
    };
  }

  /**
   * Немедленный detach стратегии из всех активных структур (шаг 1 stop-flow).
   *
   * @param strategyId - ID стратегии
   * @param entry - Entry
   *
   * @remarks
   * Останавливает heartbeat, отменяет deferred timer, удаляет routing
   * (instrument/symbol/asset), убирает из queue и dirty. Entry остаётся в
   * `_entries` (в состоянии STOPPING) до завершения final intents — чтобы
   * concurrent unregister мог дождаться того же stopPromise.
   */
  private _detachEntry(strategyId: string, entry: StrategyEntry): void {
    // Stop heartbeat
    if (entry.heartbeatTimer !== undefined) {
      this._deps.timer.clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = undefined;
    }

    // Cancel deferred timer
    const deferred = this._deferredTimers.get(strategyId);
    if (deferred !== undefined) {
      this._deps.timer.clearTimeout(deferred);
      this._deferredTimers.delete(strategyId);
    }

    // Remove all instrument routing (primary + additional + complementary)
    for (const key of entry.routingInstrumentKeys) {
      const set = this._instrumentToStrategies.get(key);
      if (set) {
        set.delete(strategyId);
        if (set.size === 0) {
          this._instrumentToStrategies.delete(key);
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
    const queueIndex = this._queue.indexOf(strategyId);
    if (queueIndex >= 0) {
      this._queue.splice(queueIndex, 1);
    }

    // Remove dirty tracking
    this._removeDirty(strategyId);

    // Coalescing rerun после detach невозможен.
    entry.rerunRequested = false;
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
