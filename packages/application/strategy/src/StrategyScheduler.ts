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
 * ### Lifecycle стратегии (ACTIVE → STOPPING/FAULTED → STOPPED):
 * `unregister()` возвращает `Result<void, StopStrategyError>` — единственный
 * безопасный stop-flow:
 * 1. атомарный переход ACTIVE → STOPPING (повторный/concurrent unregister
 *    коалесцируется на тот же in-flight attempt);
 * 2. немедленный detach: heartbeat, routing, deferred timer, queue;
 * 3. ожидание активного `executionPromise` (обычный execution) — ЕСЛИ
 *    стратегия НЕ `FAULTED` с ещё не завершившимся execution (см. Watchdog);
 * 4. `strategy.stop()` → final intents (кэшируются — вызывается ровно один раз);
 * 5. исполнение final intents (никогда не параллельно с обычным execution);
 * 6. authoritative post-check (нет живых ордеров стратегии) — только после
 *    этого entry удаляется и lifecycle → STOPPED.
 * Любой небезопасный исход (execution всё ещё идёт, final cleanup не
 * подтверждён, `strategy.stop()` вернул небезопасный intent) возвращает typed
 * `Err(StopStrategyError)`, НЕ удаляет entry и оставляет стратегию retryable.
 * События (BOOK/FILL/ORDER_UPDATE) во время STOPPING/FAULTED не ставят
 * стратегию в очередь.
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
 * Зависший `ExecutionEngine.execute()` (> config.executionTimeoutMs) переводит
 * стратегию в lifecycle `FAULTED` (но ТОЛЬКО из `ACTIVE` — не перезаписывает
 * `STOPPING`/`STOPPED`): новые тики блокируются. Параллельный второй execution
 * НЕ запускается. `unregister()`, вызванный, пока зависший `executionPromise`
 * ещё не разрешился, НЕ запускает `strategy.stop()`/final intents и НЕ
 * удаляет entry — возвращает `Err(EXECUTION_TIMED_OUT)`, retryable. Только
 * после того как hung promise фактически завершится, последующий explicit
 * `unregister()` продолжает fresh cleanup.
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
import { assetIdToInstrumentId, assetIdToString } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { IPortfolioStore, IOrderStateStore, IMarketCatalog } from '@polymarket/ports';
import type { Market } from '@polymarket/market';
import type { IStrategy } from './IStrategy.js';
import type { StrategySnapshot } from './types/StrategySnapshot.js';
import type { StrategyIntent, StrategyStopIntent } from './types/StrategyIntent.js';
import type { InstrumentConstraints } from './types/InstrumentConstraints.js';
import type { TriggerReason } from './types/TriggerReason.js';
import type { ScheduleConfig } from './types/ScheduleConfig.js';
import { createDefaultScheduleConfig, validateScheduleConfig } from './types/ScheduleConfig.js';
import { StopStrategyError } from './types/StopStrategyError.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import type { ExecutionContext, ExecutionReport } from './ExecutionEngine.js';
import type { ISchedulerTimer, TimerHandle } from './ports/SchedulerTimer.js';

// ── Публичные типы ─────────────────────────────────────────

/**
 * Lifecycle-состояние зарегистрированной стратегии.
 *
 * @remarks
 * - `ACTIVE` — стратегия тикает и исполняет intents.
 * - `STOPPING` — начат unregister: новые тики/enqueue запрещены, идёт
 *   ожидание активного execution и исполнение final intents. Может быть
 *   достигнут повторно (retry) после небезопасного final cleanup — entry
 *   остаётся tracked, `finalIntents` кэшированы (не пересчитываются).
 * - `FAULTED` — watchdog обнаружил зависший `execute()`: новые тики
 *   запрещены. Пока `executionPromise` не разрешился, `unregister()` НЕ
 *   запускает final intents (чтобы не исполнить их параллельно с ordinary
 *   execution) — возвращает retryable `Err`. После разрешения promise
 *   следующий explicit `unregister()` продолжает как `STOPPING`.
 * - `STOPPED` — stop-flow завершён и подтверждён, entry удалена.
 */
export type StrategyLifecycle = 'ACTIVE' | 'STOPPING' | 'FAULTED' | 'STOPPED';

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
  /** Конфигурация расписания (опционально, по умолчанию createDefaultScheduleConfig()) */
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
  /**
   * Дополнительные торговые targets (помимо primary + complementary).
   *
   * @remarks
   * В отличие от `additionalInstrumentIds` (routing-only — только триггерят
   * tick), каждая пара здесь становится разрешённым PLACE-таргетом
   * (`ExecutionContext.tradableInstrumentKeys`). Валидируется при регистрации
   * так же строго, как primary/complementary (catalog entry + asset↔instrument
   * mapping) — до `strategy.initialize()`.
   */
  readonly additionalTradableTargets?: readonly {
    readonly instrumentId: InstrumentId;
    readonly asset: AssetId;
  }[];
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
  /**
   * Разрешённые PLACE-таргеты (primary+complementary+additionalTradableTargets).
   *
   * @remarks
   * Строгое подмножество `routingInstrumentKeys` — routing-only
   * `additionalInstrumentIds` НЕ входят сюда: они триггерят tick, но не
   * являются разрешённым таргетом для PLACE (см. {@link ExecutionContext}).
   */
  readonly tradableInstrumentKeys: ReadonlySet<string>;
  /** Lifecycle-состояние (см. {@link StrategyLifecycle}). */
  lifecycle: StrategyLifecycle;
  /** Promise текущего in-flight unregister-attempt (коалесцирует concurrent вызовы). */
  stopAttemptPromise: Promise<Result<void, StopStrategyError>> | undefined;
  /** Промежуточные final intents от `strategy.stop()` — вычисляются ровно один раз, кэшируются для retry. */
  finalIntents: readonly StrategyStopIntent[] | undefined;
  /** Promise текущего обычного execution (undefined, если execution не идёт). */
  executionPromise: Promise<void> | undefined;
  /** Подряд неуспешных snapshot/tick — для deferred backoff. */
  consecutiveFailures: number;
  lastRunMs: number;
  running: boolean;
  rerunRequested: boolean;
  heartbeatTimer: TimerHandle | undefined;
}

/**
 * Registration-in-progress: control record вместо plain `Set<string>`.
 *
 * @remarks
 * Plain `Set<string>` (прежняя реализация) не позволял отменить регистрацию,
 * пока стратегия висит в `initialize()` — `unregister()` не находил entry
 * (её ещё не существует) и не мог остановить publication после того как
 * `initialize()` наконец резолвится. `PendingRegistration` даёт `unregister()`
 * точку зацепления: выставить `cancelled = true` и дождаться `completion`.
 */
interface PendingRegistration {
  readonly strategyId: string;
  readonly strategy: IStrategy;
  /** Resolves когда register() полностью завершился (успешно или с Err). Никогда не rejects. */
  completion: Promise<Result<void, Error>>;
  /** Выставляется unregister()-ом, вызванным во время initialize(). */
  cancelled: boolean;
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
  /**
   * Registrations-in-progress: single-flight guard + cancellation point для
   * `unregister()`, вызванного во время `initialize()`.
   */
  private readonly _pendingRegistrations = new Map<string, PendingRegistration>();
  /**
   * Global stopping barrier — выставляется `stopAll()`. Как только `true`,
   * никакая новая регистрация (ACTIVE entry) не публикуется.
   */
  private _globalStopping = false;
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
   * Валидирует identity одной target-пары против каталога (fail-closed).
   *
   * @param instrumentId - Инструмент
   * @param asset - Актив
   * @param label - Метка для сообщения об ошибке (English)
   * @returns Ok(void) либо Err с описанием нарушения
   *
   * @remarks
   * Две проверки: instrument существует в каталоге; asset маппится ровно на
   * этот instrument (`assetIdToInstrumentId(asset) === instrumentId`).
   * Используется для primary, complementary и `additionalTradableTargets` —
   * одна и та же строгость для всех.
   */
  private _validateTargetIdentity(
    instrumentId: InstrumentId,
    asset: AssetId,
    label: string,
  ): Result<void, Error> {
    if (!this._deps.catalog.get(instrumentId)) {
      return Err(new Error(
        `Strategy registration rejected — ${label} instrument ${String(instrumentId)} is missing from catalog`,
      ));
    }
    const mapped = assetIdToInstrumentId(asset);
    if (mapped === undefined || String(mapped) !== String(instrumentId)) {
      return Err(new Error(
        `Strategy registration rejected — ${label} asset does not map to instrument ${String(instrumentId)}`,
      ));
    }
    return Ok(undefined);
  }

  /**
   * Регистрирует стратегию.
   *
   * @param reg - Параметры регистрации
   * @returns Ok при успехе; Err если: дубликат strategy.id (включая
   *   registration-in-progress), global stopping barrier активен, невалидная
   *   primary/complementary/additional target identity, невалидный
   *   ScheduleConfig, неполная complementary-пара, либо initialize() вернул
   *   ошибку/бросил, либо регистрация была отменена через `unregister()` во
   *   время `initialize()`
   *
   * @remarks
   * Вызывает strategy.initialize(). При ошибке — стратегия не регистрируется.
   * При успехе — запускает heartbeat timer и стратегия готова к tick().
   * Concurrent register одного ID защищён single-flight guard-ом
   * (`_pendingRegistrations`): initialize() вызывается ровно один раз.
   * Primary/complementary/additional target identity валидируется СИНХРОННО,
   * ДО initialize() — невалидная пара никогда не доходит до стратегии.
   */
  public async register(reg: StrategyRegistration): Promise<Result<void, Error>> {
    const strategyId = reg.strategy.id;

    if (this._globalStopping) {
      return Err(new Error(`StrategyScheduler is stopping — registration rejected: ${strategyId}`));
    }

    // Duplicate → Err (НЕ Ok): молчаливый Ok маскировал бы двойную регистрацию.
    if (this._entries.has(strategyId) || this._pendingRegistrations.has(strategyId)) {
      this._logger.warn('Strategy already registered (or registration in progress)', { strategyId });
      return Err(new Error(`Strategy already registered: ${strategyId}`));
    }

    // Комплементарная пара — атомарно: оба поля или ни одного.
    if ((reg.complementaryInstrumentId === undefined) !== (reg.complementaryAsset === undefined)) {
      return Err(new Error(
        `Strategy registration requires complementaryInstrumentId and complementaryAsset as a pair: ${strategyId}`,
      ));
    }

    // Primary/complementary/additional target identity — синхронно, ДО initialize().
    const primaryCheck = this._validateTargetIdentity(reg.instrumentId, reg.asset, 'primary');
    if (!primaryCheck.ok) {
      this._logger.error(primaryCheck.error.message, { strategyId });
      return primaryCheck;
    }

    if (reg.complementaryInstrumentId !== undefined && reg.complementaryAsset !== undefined) {
      const compCheck = this._validateTargetIdentity(reg.complementaryInstrumentId, reg.complementaryAsset, 'complementary');
      if (!compCheck.ok) {
        this._logger.error(compCheck.error.message, { strategyId });
        return compCheck;
      }
      if (String(reg.complementaryInstrumentId) === String(reg.instrumentId)) {
        const error = new Error(`Strategy registration rejected — complementary instrument must differ from primary: ${strategyId}`);
        this._logger.error(error.message, { strategyId });
        return Err(error);
      }
      if (assetIdToString(reg.complementaryAsset) === assetIdToString(reg.asset)) {
        const error = new Error(`Strategy registration rejected — complementary asset must differ from primary: ${strategyId}`);
        this._logger.error(error.message, { strategyId });
        return Err(error);
      }
    }

    for (const target of reg.additionalTradableTargets ?? []) {
      const check = this._validateTargetIdentity(target.instrumentId, target.asset, 'additional tradable target');
      if (!check.ok) {
        this._logger.error(check.error.message, { strategyId });
        return check;
      }
    }

    // Конфигурация: копируем внешний Set (защита от последующей мутации caller-ом)
    // и валидируем ДО initialize/heartbeat.
    const defaultConfig = createDefaultScheduleConfig();
    const config: ScheduleConfig = {
      minIntervalMs: reg.config?.minIntervalMs ?? defaultConfig.minIntervalMs,
      priorityTriggers: new Set(reg.config?.priorityTriggers ?? defaultConfig.priorityTriggers),
      maxIdleMs: reg.config?.maxIdleMs ?? defaultConfig.maxIdleMs,
      executionTimeoutMs: reg.config?.executionTimeoutMs ?? defaultConfig.executionTimeoutMs,
    };
    const configResult = validateScheduleConfig(config);
    if (!configResult.ok) {
      this._logger.error('Strategy registration rejected — invalid ScheduleConfig', {
        strategyId,
        error: configResult.error.message,
      });
      return Err(configResult.error);
    }

    // Single-flight + cancellation point: с этого момента concurrent register
    // того же ID получает Err; unregister() во время initialize() может найти
    // эту запись и отменить публикацию.
    const pending: PendingRegistration = {
      strategyId,
      strategy: reg.strategy,
      completion: Promise.resolve(Ok(undefined)),
      cancelled: false,
    };
    this._pendingRegistrations.set(strategyId, pending);
    const completion = this._completeRegistration(reg, config, pending);
    pending.completion = completion;

    try {
      return await completion;
    } finally {
      if (this._pendingRegistrations.get(strategyId) === pending) {
        this._pendingRegistrations.delete(strategyId);
      }
    }
  }

  /**
   * Завершает регистрацию: initialize() → post-check cancellation → entry.
   *
   * @param reg - Параметры регистрации
   * @param config - Провалидированный ScheduleConfig
   * @param pending - PendingRegistration record (для post-init cancellation check)
   * @returns Ok(void) при успехе; Err если initialize() провалился/бросил,
   *   либо регистрация была отменена (unregister во время initialize(),
   *   либо global stopping barrier активирован в это время)
   *
   * @remarks
   * НИКОГДА не бросает — все ошибки конвертируются в `Err`, чтобы
   * `pending.completion` было безопасно `await`-ить из `unregister()`.
   */
  private async _completeRegistration(
    reg: StrategyRegistration,
    config: ScheduleConfig,
    pending: PendingRegistration,
  ): Promise<Result<void, Error>> {
    const strategyId = reg.strategy.id;

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

    // Post-init re-check: unregister() может было отменить регистрацию, пока
    // initialize() выполнялся; stopAll() может было поднять global barrier.
    if (pending.cancelled || this._globalStopping) {
      this._logger.warn('Strategy registration aborted — cancelled during initialize() (no ACTIVE entry published)', {
        strategyId,
      });
      return Err(new Error(`Strategy registration cancelled during initialize(): ${strategyId}`));
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

    // Tradable targets: ТОЛЬКО primary + complementary + explicit additional
    // tradable targets — routing-only additionalInstrumentIds исключены:
    // они триггерят tick, но не являются разрешённым PLACE-таргетом.
    const tradableKeys = new Set<string>();
    tradableKeys.add(String(reg.instrumentId));
    if (reg.complementaryInstrumentId !== undefined) {
      tradableKeys.add(String(reg.complementaryInstrumentId));
    }
    for (const target of reg.additionalTradableTargets ?? []) {
      tradableKeys.add(String(target.instrumentId));
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
      tradableInstrumentKeys: tradableKeys,
      lifecycle: 'ACTIVE',
      stopAttemptPromise: undefined,
      finalIntents: undefined,
      executionPromise: undefined,
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
      tradableInstruments: [...entry.tradableInstrumentKeys],
    });

    return Ok(undefined);
  }

  /**
   * Безопасно снимает регистрацию стратегии (lifecycle-aware stop-flow).
   *
   * @param strategyId - ID стратегии
   * @returns Ok(void) при подтверждённой остановке; Err(StopStrategyError)
   *   при любом небезопасном/незавершённом исходе (retryable)
   *
   * @remarks
   * Обрабатывает три случая:
   * 1. Pending registration (initialize() ещё выполняется) — отменяет
   *    публикацию, дожидается completion, возвращает `REGISTRATION_CANCELLED`.
   * 2. Неизвестный ID — `STRATEGY_NOT_FOUND`.
   * 3. Существующая entry — коалесцирует concurrent вызовы на один
   *    in-flight attempt (`entry.stopAttemptPromise`) и делегирует в
   *    {@link _attemptStop}.
   */
  public async unregister(strategyId: string): Promise<Result<void, StopStrategyError>> {
    const pending = this._pendingRegistrations.get(strategyId);
    if (pending) {
      pending.cancelled = true;
      await pending.completion; // никогда не rejects (см. _completeRegistration)

      // Race: register() мог уже опубликовать entry до того, как заметил
      // cancelled (например, cancelled выставлен ПОСЛЕ post-init check, но
      // ДО this._entries.set — крайне маловероятно, т.к. cancelled проверяется
      // прямо перед публикацией, но проверяем защитно). Если entry всё же
      // существует — продолжаем обычным unregister-flow вместо того чтобы
      // оставить ACTIVE стратегию без stop.
      if (this._entries.has(strategyId)) {
        return this.unregister(strategyId);
      }

      return Err(new StopStrategyError(
        'REGISTRATION_CANCELLED',
        strategyId,
        `Strategy registration cancelled during initialize(): ${strategyId}`,
      ));
    }

    const entry = this._entries.get(strategyId);
    if (!entry) {
      this._logger.warn('Strategy not found for unregister', { strategyId });
      return Err(new StopStrategyError('STRATEGY_NOT_FOUND', strategyId, `Strategy not found: ${strategyId}`));
    }

    // Коалесцирование: concurrent/repeated unregister ждёт ТОТ ЖЕ attempt —
    // strategy.stop() и final intents не запускаются параллельно дважды.
    if (entry.stopAttemptPromise) {
      return entry.stopAttemptPromise;
    }

    const attempt = this._attemptStop(strategyId, entry);
    entry.stopAttemptPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (entry.stopAttemptPromise === attempt) {
        entry.stopAttemptPromise = undefined;
      }
    }
  }

  /**
   * Один attempt lifecycle-aware stop-flow (может быть вызван повторно —
   * retry после небезопасного final cleanup).
   *
   * @param strategyId - ID стратегии
   * @param entry - Entry (в состоянии ACTIVE/FAULTED/STOPPING)
   * @returns Ok(void) только при authoritative-подтверждённой остановке
   *
   * @remarks
   * ### Порядок:
   * 1. ACTIVE → STOPPING: detach (routing/heartbeat/queue) немедленно.
   *    FAULTED с ещё не разрешившимся `executionPromise` — НЕ проходит
   *    дальше (см. ниже); STOPPING (retry) — detach уже выполнен ранее.
   * 2. Дождаться `executionPromise` (обычный execution), если он есть и
   *    гарантированно завершится (не FAULTED-с-pending-promise).
   * 3. `strategy.stop()` → validated final intents (кэшируются в
   *    `entry.finalIntents`, вычисляются РОВНО ОДИН РАЗ).
   * 4. Исполнить final intents (идемпотентно safe для retry — CANCEL_ALL/
   *    CANCEL повторно на уже-пустом наборе ордеров безопасны).
   * 5. Оценить безопасность: report (errors/failed/blockedByUnsafeCancel/
   *    unsafe cancel outcomes) + authoritative post-check (нет открытых
   *    ордеров стратегии в `orderStateStore`).
   * 6. Только при подтверждённой безопасности — STOPPED + удаление entry.
   */
  private async _attemptStop(strategyId: string, entry: StrategyEntry): Promise<Result<void, StopStrategyError>> {
    if (entry.lifecycle === 'ACTIVE') {
      entry.lifecycle = 'STOPPING';
      this._detachEntry(strategyId, entry);
    } else if (entry.lifecycle === 'FAULTED') {
      if (entry.executionPromise !== undefined) {
        // Watchdog уже сработал, и hung execution ЕЩЁ НЕ завершился: НЕ
        // запускаем strategy.stop()/final intents — они исполнялись бы
        // параллельно с ordinary execution (см. module docstring). Entry
        // остаётся tracked/FAULTED; caller может повторить unregister позже.
        this._logger.error('Unregister blocked — faulted execution has not completed yet, retry later', {
          strategyId,
        });
        return Err(new StopStrategyError(
          'EXECUTION_TIMED_OUT',
          strategyId,
          `Strategy ${strategyId} watchdog fired and the hung execution has not resolved yet — retry unregister later`,
        ));
      }
      // Hung execution фактически завершился (entry.executionPromise уже
      // undefined — см. .finally() в _executeTick) — безопасно продолжить
      // fresh cleanup. Остаёмся классифицированы как небезопасный запуск
      // (watchdog сработал), но теперь можем detach + очистить.
      entry.lifecycle = 'STOPPING';
      this._detachEntry(strategyId, entry);
    }
    // else: уже 'STOPPING' — retry предыдущего небезопасного final cleanup;
    // detach уже выполнен, executionPromise уже разрешён (ACTIVE execution
    // не может начаться в STOPPING — _enqueue/_processQueueItem блокируют).

    if (entry.executionPromise !== undefined) {
      try {
        await entry.executionPromise;
      } catch {
        // executionPromise обёрнут (.catch в _executeTick) и не должен
        // отклоняться; boundary на случай нарушения инварианта.
      }
    }

    // strategy.stop() вызывается РОВНО ОДИН РАЗ — результат кэшируется для retry.
    if (entry.finalIntents === undefined) {
      let rawIntents: StrategyIntent[] = [];
      try {
        rawIntents = entry.strategy.stop();
      } catch (err) {
        this._logger.error('Strategy.stop() threw', {
          strategyId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }

      const validated = this._validateStopIntents(rawIntents);
      if (!validated.ok) {
        this._logger.error('Strategy.stop() returned an unsafe final intent — programming/configuration error', {
          strategyId,
          error: validated.error.message,
        });
        return Err(new StopStrategyError('UNSAFE_FINAL_INTENT', strategyId, validated.error.message));
      }
      entry.finalIntents = validated.value;
    }

    let report: ExecutionReport | undefined;
    let executionThrew: Error | undefined;
    if (entry.finalIntents.length > 0) {
      const ctx = this._makeExecutionContext(entry);
      try {
        report = await this._deps.executionEngine.execute(ctx, entry.finalIntents);
      } catch (err) {
        executionThrew = err instanceof Error ? err : new Error(String(err));
        this._logger.error('Failed to execute final intents', { strategyId, err: executionThrew });
      }
    }

    let unsafeReason: string | undefined;
    if (executionThrew) {
      unsafeReason = `final execution threw: ${executionThrew.message}`;
    } else if (report) {
      const unsafeOutcome = report.outcomes.find(
        (o) => o.kind === 'CANCEL_PENDING' || o.kind === 'CANCEL_FAILED' || o.kind === 'CANCEL_CONFIRMED_TARGET_UNKNOWN',
      );
      if (report.errors.length > 0 || report.failed > 0 || report.blockedByUnsafeCancel > 0 || unsafeOutcome) {
        unsafeReason = `unsafe final execution report: errors=${report.errors.length}, failed=${report.failed}, blockedByUnsafeCancel=${report.blockedByUnsafeCancel}${unsafeOutcome ? `, unsafeOutcome=${unsafeOutcome.kind}` : ''}`;
      }
    }

    if (unsafeReason === undefined) {
      // Authoritative post-condition: нет открытых ордеров этой стратегии.
      // Переиспользуем orderStateStore (тот же authoritative repo, что и у
      // ExecutionEngine — см. buildStrategyEngine: orderStateStore: orderRepo).
      try {
        const remaining = this._deps.orderStateStore.getOpenOrders(strategyId);
        if (remaining.length > 0) {
          unsafeReason = `authoritative post-check found ${remaining.length} live order(s) for strategy`;
        }
      } catch (err) {
        unsafeReason = `authoritative post-check threw: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (unsafeReason !== undefined) {
      this._logger.error('Strategy final cleanup unconfirmed — entry NOT removed, unregister must be retried', {
        strategyId,
        reason: unsafeReason,
      });
      return Err(new StopStrategyError('FINAL_CLEANUP_UNCONFIRMED', strategyId, unsafeReason, { report }));
    }

    entry.lifecycle = 'STOPPED';
    this._entries.delete(strategyId);
    this._logger.info('Strategy unregistered', { strategyId });
    return Ok(undefined);
  }

  /**
   * Валидирует, что `strategy.stop()` вернул ТОЛЬКО CANCEL/CANCEL_ALL.
   *
   * @param raw - Сырые intents из `strategy.stop()`
   * @returns Ok(StrategyStopIntent[]) либо Err, если найден PLACE (или
   *   любой другой не-CANCEL/CANCEL_ALL intent)
   *
   * @remarks
   * Runtime-защита в дополнение к compile-time типу `StrategyStopIntent` —
   * стратегия может прийти из JavaScript или использовать unsafe casts.
   * `stop()` не предназначен для liquidation PLACE или новых торговых
   * операций: PLACE здесь — programming/configuration error.
   */
  private _validateStopIntents(raw: readonly StrategyIntent[]): Result<StrategyStopIntent[], Error> {
    for (const intent of raw) {
      if (intent.type !== 'CANCEL' && intent.type !== 'CANCEL_ALL') {
        return Err(new Error(
          `strategy.stop() returned an unsafe intent type "${intent.type}" — only CANCEL/CANCEL_ALL are allowed from stop()`,
        ));
      }
    }
    return Ok(raw as StrategyStopIntent[]);
  }

  /**
   * Останавливает и снимает регистрацию всех стратегий (безопасный flow).
   *
   * @returns Ok(void) если все стратегии (и pending registrations) успешно
   *   остановлены; Err(readonly StopStrategyError[]) с накопленными ошибками
   *
   * @remarks
   * Порядок:
   * 1. Поднимает global stopping barrier — `register()` немедленно отклоняет
   *    новые регистрации.
   * 2. Отменяет ВСЕ pending registrations (initialize() в процессе) и ждёт
   *    их completion — гарантирует, что ни одна не опубликует ACTIVE entry
   *    после начала stopAll().
   * 3. Останавливает все существующие entries через safe `unregister()`.
   * НЕ логирует «All strategies stopped», если хотя бы одна регистрация или
   * стратегия не остановлена подтверждённо.
   */
  public async stopAll(): Promise<Result<void, readonly StopStrategyError[]>> {
    this._globalStopping = true;

    const pendingIds = [...this._pendingRegistrations.keys()];
    for (const id of pendingIds) {
      const p = this._pendingRegistrations.get(id);
      if (p) p.cancelled = true;
    }
    await Promise.all(pendingIds.map((id) => this._pendingRegistrations.get(id)?.completion ?? Promise.resolve()));

    const entryIds = [...this._entries.keys()];
    if (entryIds.length === 0) {
      this._logger.info('All strategies stopped', { count: 0 });
      return Ok(undefined);
    }

    this._logger.warn('Stopping all strategies', { count: entryIds.length });
    const results = await Promise.all(entryIds.map((id) => this.unregister(id)));

    const failures = results
      .filter((r): r is { ok: false; error: StopStrategyError } => !r.ok)
      .map((r) => r.error);

    if (failures.length > 0) {
      this._logger.error('stopAll: some strategies failed to stop cleanly', {
        failedCount: failures.length,
        total: entryIds.length,
      });
      return Err(failures);
    }

    this._logger.info('All strategies stopped', { count: entryIds.length });
    return Ok(undefined);
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
    if (!entry || entry.lifecycle !== 'ACTIVE') return;

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
    if (!entry || entry.lifecycle !== 'ACTIVE') return;

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
    // переводится в lifecycle FAULTED и блокируется до unregister (controlled
    // recovery). Guard `lifecycle === 'ACTIVE'`: если unregister() уже начал
    // STOPPING (или entry уже STOPPED/удалена) до срабатывания таймера, watchdog
    // НЕ должен перезаписывать/конфликтовать с уже идущим stop-flow.
    let watchdogFired = false;
    const watchdogHandle = this._deps.timer.setTimeout(() => {
      if (entry.lifecycle !== 'ACTIVE') return;
      watchdogFired = true;
      entry.lifecycle = 'FAULTED';
      this._logger.error('CRITICAL: ExecutionEngine.execute() exceeded executionTimeoutMs — strategy marked FAULTED, requires unregister/manual recovery', {
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
   * `tradableInstrumentKeys` — ТОЛЬКО разрешённые PLACE-таргеты (primary +
   * complementary + explicit additionalTradableTargets). Routing-only
   * `additionalInstrumentIds` (routingInstrumentKeys \ tradableInstrumentKeys)
   * триггерят tick, но НЕ являются разрешённым таргетом — ExecutionEngine
   * отклоняет PLACE с targetInstrumentId вне tradable-набора (fail-closed).
   */
  private _makeExecutionContext(entry: StrategyEntry): ExecutionContext {
    return {
      strategyId: entry.strategy.id,
      accountId: entry.accountId,
      instrumentId: entry.instrumentId,
      asset: entry.asset,
      tradableInstrumentKeys: entry.tradableInstrumentKeys,
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
   * `_entries` (в состоянии STOPPING/FAULTED) до завершения final intents —
   * чтобы concurrent unregister мог дождаться того же `stopAttemptPromise`.
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
