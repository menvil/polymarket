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
 * безопасный stop-flow, 13 шагов (см. `_attemptStop` doc для деталей):
 * 1. атомарный переход ACTIVE/FAULTED → STOPPING;
 * 2. немедленный detach: heartbeat, routing, deferred timer, queue (идемпотентно);
 * 3. ожидание `entry.activeExecution` — РЕЗУЛЬТАТ execution ИЛИ TIMEOUT сигнал
 *    (см. Watchdog) — НЕЗАВИСИМО от lifecycle;
 * 4. `strategy.stop()` → final intents (кэшируются при успехе — вызывается
 *    ровно один раз; исключение НЕ кэшируется, см. `STOP_HOOK_FAILED`);
 * 5. final cleanup — ОДНА tracked `ExecutionEngine.execute()` (completion либо
 *    `finalCleanupTimeoutMs` timeout), fresh `CANCEL_ALL` добавляется только
 *    когда операция РЕАЛЬНО (пере)запускается (не при join уже идущей);
 * 6-7. верификация `ExecutionReport` + authoritative open-order post-check;
 * 8. commitment post-check — tracked (completion либо `commitmentCheckTimeoutMs`);
 * 9. `strategy.dispose()` — tracked (completion либо `disposeTimeoutMs`),
 *    пропускается, если уже успешно выполнен ранее (`entry.disposed`);
 * 10-11. ПОВТОРНЫЙ open-order + commitment post-check (dispose мог занять
 *    время, за которое могли появиться поздние ордера/commitments);
 * 12-13. STOPPED, удаление entry.
 * Любой timeout/небезопасный исход НА ЛЮБОМ шаге возвращает typed
 * `Err(StopStrategyError)` БЕЗ выполнения последующих шагов, НЕ удаляет entry
 * и оставляет стратегию retryable — retry никогда не запускает вторую
 * параллельную попытку того же шага (single-flight tracked operations, см.
 * {@link TrackedAsyncOperation}). События (BOOK/FILL/ORDER_UPDATE) во время
 * STOPPING/FAULTED не ставят стратегию в очередь.
 *
 * ### Persistent disposal для отменённых регистраций (`PendingDisposal`):
 * Если регистрация отменяется (`unregister()`/`stopAll()` во время
 * `initialize()`) ПОСЛЕ того как `initialize()` успешно вернул `Ok`,
 * `dispose()` вызывается через persistent tombstone в `_pendingDisposals` —
 * НЕ инлайново. Если `dispose()` зависнет/бросит/вернёт `Err`, strategy
 * instance НЕ теряется: tombstone остаётся до фактического успеха, следующий
 * `unregister(strategyId)` (или `stopAll()`) находит его и повторяет попытку
 * (коалесцируясь с любым уже идущим attempt через `attemptPromise`).
 * `register()` с тем же ID отклоняется, пока tombstone существует.
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
 * ### Watchdog (независим от lifecycle):
 * Зависший `ExecutionEngine.execute()` (> config.executionTimeoutMs) отмечает
 * `entry.activeExecution.timedOut = true` и резолвит `timeoutSignal`
 * НЕЗАВИСИМО от текущего lifecycle стратегии — execution существует сам по
 * себе, вне зависимости от того, ACTIVE стратегия или уже STOPPING
 * (unregister() мог быть вызван ДО срабатывания watchdog). Lifecycle-переход
 * в `FAULTED` guarded — ТОЛЬКО из `ACTIVE` (не перезаписывает `STOPPING`/
 * `STOPPED`). `_attemptStop()` ждёт `Promise.race([execution.promise,
 * execution.timeoutSignal])` — если timeout сработал раньше, немедленно
 * возвращает `Err(EXECUTION_TIMED_OUT)` (retryable), НЕ запуская
 * `strategy.stop()`/final intents параллельно с ordinary execution. После
 * того как hung promise фактически завершится (`activeExecution` становится
 * `undefined`), следующий explicit `unregister()` продолжает fresh cleanup.
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
import type { AccountId, AssetId, InstrumentId, CryptoAssetId } from '@polymarket/ids';
import { assetIdToInstrumentId, assetIdToString, asOrderId, asCryptoAssetId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { IPortfolioStore, IOrderStateStore, IMarketCatalog, IStrategyCommitmentReader, StrategyCommitment } from '@polymarket/ports';
import type { Market } from '@polymarket/market';
import type { Order } from '@polymarket/order';
import type { IStrategy } from './IStrategy.js';
import type { StrategySnapshot, TradableInstrumentSnapshot } from './types/StrategySnapshot.js';
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

/** Подмножество {@link TriggerReason}, которое несёт `ICryptoMarketDataStore.setOnChange`. */
export type CryptoMarketDataReason = Extract<TriggerReason, 'CRYPTO_PRICE' | 'CRYPTO_MARKET_DATA'>;

/**
 * Интерфейс long-lived crypto market data store для StrategyScheduler.
 *
 * @remarks
 * Реализуется `CryptoMarketDataStore` (`@polymarket/market-state`).
 * `symbolOrAsset` — сырая строка (символ биржи или уже нормализованный asset)
 * — тот же контракт, что у реального стора; внутри `StrategyScheduler`
 * нормализованный asset хранится как `CryptoAssetId` (см. `entry.cryptoAsset`),
 * но на границе вызова в этот интерфейс распаковывается обратно в `string`.
 */
export interface ICryptoMarketDataStore {
  getPriceHistory(symbolOrAsset: string): StrategySnapshot['cryptoPriceHistory'];
  getVenueState(symbolOrAsset: string): StrategySnapshot['cryptoVenueState'];
  getVenueHistory(symbolOrAsset: string): StrategySnapshot['cryptoVenueHistory'];
  setOnChange(cb: (asset: string, reason: CryptoMarketDataReason) => void): void;
}

/**
 * Интерфейс реестра переиспользуемых crypto signal calculators.
 *
 * @remarks
 * Реализуется `CryptoSignalRegistry` (`@polymarket/market-state`). Один
 * scheduler-managed `createView()` на снапшот — сама стратегия выбирает,
 * какой calculator/venues/weights использовать через возвращённый view.
 */
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
  /**
   * Authoritative reader незавершённых submission/reservation/fill commitments.
   *
   * @remarks
   * Обязательный (НЕ опциональный): final cleanup post-check в `_attemptStop`
   * полагается на него, чтобы не удалить entry, пока есть unresolved
   * UNKNOWN/VENUE_ACCEPTED submission, RECONCILIATION_REQUIRED reservation
   * либо unsettled fill (см. `IStrategyCommitmentReader`). Production wiring
   * ОБЯЗАН передать реальную реализацию (например,
   * `SubmissionJournalStrategyCommitmentReader` из `@polymarket/use-cases`) —
   * пустая/no-op реализация замаскировала бы именно те race conditions,
   * которые этот порт должен ловить.
   */
  readonly commitmentReader: IStrategyCommitmentReader;
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
  readonly cryptoAsset?: CryptoAssetId;
  /** Время начала торговли на рынке (epoch ms) */
  readonly eventStartMs?: number;
  /** Дополнительные инструменты для триггера тика */
  readonly additionalInstrumentIds?: readonly InstrumentId[];
  /** ID комплементарного токена */
  readonly complementaryInstrumentId?: InstrumentId;
  /** Торговый актив комплементарного токена */
  readonly complementaryAsset?: AssetId;
  /**
   * Полные пары дополнительных tradable targets (instrumentId + asset).
   *
   * @remarks
   * В отличие от `tradableInstrumentKeys` (string-ключи, для fail-closed
   * проверки в `ExecutionEngine`), здесь хранятся ПОЛНЫЕ пары — нужны для
   * построения `StrategySnapshot.additionalTradableInstruments` (book/
   * constraints/orders per-target) и для {@link _commitmentInstrumentIds}.
   */
  readonly additionalTradableTargets: readonly {
    readonly instrumentId: InstrumentId;
    readonly asset: AssetId;
  }[];
  /** Дедуплицированные instrument-ключи routing-а (primary+additional+complementary+additionalTradableTargets). */
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
  /**
   * Текущий обычный execution (undefined, если ничего не выполняется).
   *
   * @remarks
   * Единый execution state вместо разрозненных `running`/`executionPromise` —
   * см. {@link ActiveExecution}. `activeExecution !== undefined` одновременно
   * означает «running» и служит источником timeout-сигнала для `_attemptStop`.
   */
  activeExecution: ActiveExecution | undefined;
  /** Tracked final cleanup execution (см. {@link TrackedAsyncOperation}) — не более одной in-flight. */
  finalCleanupExecution: TrackedAsyncOperation<ExecutionReport> | undefined;
  /** Tracked `strategy.dispose()` (ACTIVE shutdown) — не более одной in-flight. */
  disposeExecution: TrackedAsyncOperation<Result<void, Error>> | undefined;
  /** Tracked `commitmentReader.getActiveCommitments()` — не более одной in-flight. */
  commitmentCheckExecution: TrackedAsyncOperation<readonly StrategyCommitment[]> | undefined;
  /** `true` после фактически успешного `dispose()` — не вызывается повторно. */
  disposed: boolean;
  /** Подряд неуспешных snapshot/tick — для deferred backoff. */
  consecutiveFailures: number;
  lastRunMs: number;
  rerunRequested: boolean;
  heartbeatTimer: TimerHandle | undefined;
}

/**
 * Состояние одного in-flight `ExecutionEngine.execute()`.
 *
 * @remarks
 * Watchdog-таймаут хранится ЗДЕСЬ, независимо от lifecycle стратегии —
 * зависший execution существует независимо от того, ACTIVE стратегия или уже
 * STOPPING (unregister() мог быть вызван ДО срабатывания watchdog). Единый
 * объект даёт `_attemptStop` возможность ждать РЕЗУЛЬТАТ execution ИЛИ
 * TIMEOUT-сигнал (через `Promise.race`), не полагаясь на lifecycle-проверки.
 */
interface ActiveExecution {
  /** Promise `ExecutionEngine.execute()` (обёрнутый `.then/.catch/.finally` из `_executeTick`). */
  readonly promise: Promise<void>;
  /** Когда execution начался (epoch ms, из IClock — детерминизм в replay). */
  readonly startedAtMs: number;
  /** Watchdog сработал (executionTimeoutMs истёк, promise ещё не resolved). */
  timedOut: boolean;
  /** `promise` фактически завершился (resolved/rejected — не важно как). */
  completed: boolean;
  /** Handle watchdog-таймера (для идентификации «эта же попытка» и clearTimeout). */
  readonly timeoutHandle: TimerHandle;
  /** Resolves В ТОЧНОСТИ когда watchdog срабатывает (для `Promise.race` в `_attemptStop`). */
  readonly timeoutSignal: Promise<void>;
}

/**
 * Generic bounded async operation — единая модель для final cleanup, dispose
 * и commitment check tracked operations.
 *
 * @remarks
 * `ActiveExecution` (ordinary tick execution, см. выше) НЕ переиспользует эту
 * модель — она уже работала и специально не тронута этой доработкой. Эта
 * generic-структура закрывает ТРИ НОВЫХ tracked operations, которые до этой
 * доработки были неограниченными (`await ...` без watchdog): final cleanup
 * execute(), `strategy.dispose()`, `commitmentReader.getActiveCommitments()`.
 *
 * Один и тот же паттерн для всех трёх:
 * - максимум одна in-flight операция данного типа (single-flight);
 * - watchdog через `ISchedulerTimer`, НЕ отменяющий underlying Promise;
 * - `timeoutSignal` resolves В ТОЧНОСТИ когда watchdog сработал — caller
 *   ждёт `Promise.race([promise, timeoutSignal])`;
 * - state (`result`/`error`) сохраняется до explicit processing caller-ом —
 *   `_startTrackedOperation` НЕ решает, когда state можно чистить.
 */
interface TrackedAsyncOperation<T> {
  /** Обёрнутый promise — resolves после того, как `result`/`error` уже записаны. Никогда не rejects. */
  readonly promise: Promise<void>;
  /** Когда операция начата (epoch ms, из IClock). */
  readonly startedAtMs: number;
  /** Watchdog сработал (timeoutMs истёк, promise ещё не завершился). */
  timedOut: boolean;
  /** Promise фактически завершился (successfully или с ошибкой). */
  completed: boolean;
  /** Handle watchdog-таймера (идентификация «та же попытка» + clearTimeout). */
  readonly timeoutHandle: TimerHandle;
  /** Resolves В ТОЧНОСТИ когда watchdog сработал. */
  readonly timeoutSignal: Promise<void>;
  /** Результат `run()`, если он успешно вернул значение (не бросил/не rejected). */
  result: T | undefined;
  /** Ошибка, если `run()` бросил/promise rejected. */
  error: Error | undefined;
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
  /**
   * Сколько ИМЕННО ЭТОТ `unregister()`/`stopAll()` готов ждать `completion`,
   * прежде чем вернуть `INITIALIZATION_CANCELLATION_TIMED_OUT` (см.
   * `ScheduleConfig.initializationCancellationTimeoutMs`). Снимок сделан при
   * регистрации — `initialize()` сам по себе НЕ отменяется этим таймаутом.
   */
  readonly cancellationTimeoutMs: number;
}

/**
 * Persistent retry state для регистрации, отменённой во время `initialize()`,
 * ПОСЛЕ того как `initialize()` успешно вернул `Ok` (ресурсы уже открыты).
 *
 * @remarks
 * Раньше `dispose()` вызывался inline внутри `_completeRegistration()` и, при
 * неудаче, состояние просто терялось — strategy instance был недостижим для
 * повторной попытки cleanup-а, повторный `unregister(strategyId)` получал
 * `STRATEGY_NOT_FOUND`. `PendingDisposal` — persistent tombstone: остаётся в
 * `_pendingDisposals` до тех пор, пока `dispose()` фактически НЕ завершится
 * успехом; `unregister()`/`stopAll()` могут найти его снова и повторить попытку.
 */
interface PendingDisposal {
  readonly strategyId: string;
  readonly strategy: IStrategy;
  /** Tracked dispose operation (см. {@link TrackedAsyncOperation}) — не более одной in-flight. */
  disposeExecution: TrackedAsyncOperation<Result<void, Error>> | undefined;
  /** `true` только после фактически успешного `dispose()`. */
  disposed: boolean;
  /**
   * Коалесцирует concurrent `unregister()`/`stopAll()` попытки на один
   * in-flight attempt (аналог `StrategyEntry.stopAttemptPromise`).
   */
  attemptPromise: Promise<Result<void, StopStrategyError>> | undefined;
  /** Снимок `config.disposeTimeoutMs` на момент создания tombstone. */
  readonly disposeTimeoutMs: number;
}

/** Максимальная задержка deferred retry при повторных сбоях snapshot/tick (ms). */
const FAILURE_BACKOFF_MAX_MS = 5_000;
/** Базовая задержка deferred retry при сбое snapshot/tick (ms). */
const FAILURE_BACKOFF_BASE_MS = 100;

// ── Реализация ─────────────────────────────────────────────

/**
 * Ядро reactive scheduling архитектуры — связывает state stores, стратегии и
 * `ExecutionEngine` в единый event-driven цикл.
 *
 * @remarks
 * Подробное описание алгоритма, lifecycle стратегии (`unregister()`'s 13
 * шагов) и persistent disposal — см. TSDoc модуля в начале файла.
 */
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
   * Persistent retry-tombstones для регистраций, отменённых во время
   * `initialize()` ПОСЛЕ успешного `Ok` (см. {@link PendingDisposal}).
   * Запись удаляется ТОЛЬКО после фактически успешного `dispose()`.
   */
  private readonly _pendingDisposals = new Map<string, PendingDisposal>();
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
  private readonly _assetToStrategies = new Map<CryptoAssetId, Set<string>>();

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
    // _pendingDisposals включён: strategyId с незавершённым retry-tombstone
    // (dispose() ещё не подтверждён) не должен получить новый register(),
    // пока старая strategy instance не будет гарантированно disposed.
    if (this._entries.has(strategyId) || this._pendingRegistrations.has(strategyId) || this._pendingDisposals.has(strategyId)) {
      this._logger.warn('Strategy already registered (or registration/disposal in progress)', { strategyId });
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

    // additionalTradableTargets: identity check (catalog + asset↔instrument
    // mapping) — та же строгость, что и primary/complementary. Плюс:
    // - дубликат instrumentId с ДРУГИМ asset → Err (конфликтующая пара);
    // - дубликат ТОЙ ЖЕ пары → silently dedupe (не Err, см. _completeRegistration);
    // - совпадение с primary/complementary instrumentId → Err (нельзя торговать
    //   ту же пару дважды через два разных механизма).
    const seenAdditionalTargets = new Map<string, AssetId>();
    for (const target of reg.additionalTradableTargets ?? []) {
      const check = this._validateTargetIdentity(target.instrumentId, target.asset, 'additional tradable target');
      if (!check.ok) {
        this._logger.error(check.error.message, { strategyId });
        return check;
      }
      const key = String(target.instrumentId);
      if (key === String(reg.instrumentId) || (reg.complementaryInstrumentId !== undefined && key === String(reg.complementaryInstrumentId))) {
        const error = new Error(
          `Strategy registration rejected — additionalTradableTargets must not duplicate primary/complementary instrument: ${strategyId}`,
        );
        this._logger.error(error.message, { strategyId });
        return Err(error);
      }
      const existingAsset = seenAdditionalTargets.get(key);
      if (existingAsset !== undefined && assetIdToString(existingAsset) !== assetIdToString(target.asset)) {
        const error = new Error(
          `Strategy registration rejected — additionalTradableTargets has conflicting assets for instrument ${key}: ${strategyId}`,
        );
        this._logger.error(error.message, { strategyId });
        return Err(error);
      }
      seenAdditionalTargets.set(key, target.asset);
    }

    // Конфигурация: копируем внешний Set (защита от последующей мутации caller-ом)
    // и валидируем ДО initialize/heartbeat.
    const defaultConfig = createDefaultScheduleConfig();
    const config: ScheduleConfig = {
      minIntervalMs: reg.config?.minIntervalMs ?? defaultConfig.minIntervalMs,
      priorityTriggers: new Set(reg.config?.priorityTriggers ?? defaultConfig.priorityTriggers),
      maxIdleMs: reg.config?.maxIdleMs ?? defaultConfig.maxIdleMs,
      executionTimeoutMs: reg.config?.executionTimeoutMs ?? defaultConfig.executionTimeoutMs,
      finalCleanupTimeoutMs: reg.config?.finalCleanupTimeoutMs ?? defaultConfig.finalCleanupTimeoutMs,
      disposeTimeoutMs: reg.config?.disposeTimeoutMs ?? defaultConfig.disposeTimeoutMs,
      initializationCancellationTimeoutMs:
        reg.config?.initializationCancellationTimeoutMs ?? defaultConfig.initializationCancellationTimeoutMs,
      commitmentCheckTimeoutMs: reg.config?.commitmentCheckTimeoutMs ?? defaultConfig.commitmentCheckTimeoutMs,
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
      cancellationTimeoutMs: config.initializationCancellationTimeoutMs,
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
      this._logger.warn('Strategy registration aborted — cancelled during initialize(), scheduling bounded dispose', {
        strategyId,
      });

      // dispose() — НЕторговый cleanup hook. Стратегия ещё НИКОГДА не была
      // опубликована (нет routing/heartbeat/execution context) — strategy.stop()
      // здесь неприменим (он возвращает trading intents для ACTIVE стратегии).
      //
      // Persistent tombstone (см. {@link PendingDisposal}): если dispose()
      // зависнет/бросит, strategy instance НЕ теряется — она остаётся
      // достижимой через `_pendingDisposals` для последующего retry через
      // unregister()/stopAll(), вместо того чтобы результат просто терялся
      // здесь. `attemptPromise` выставляется СИНХРОННО внутри
      // `_joinOrStartPendingDisposalAttempt` (до первого await) — конкурентный
      // unregister(), нашедший tombstone, коалесцируется на ЭТУ ЖЕ попытку.
      const pendingDisposal: PendingDisposal = {
        strategyId,
        strategy: reg.strategy,
        disposeExecution: undefined,
        disposed: false,
        attemptPromise: undefined,
        disposeTimeoutMs: config.disposeTimeoutMs,
      };
      this._pendingDisposals.set(strategyId, pendingDisposal);

      // Стартуем bounded dispose СИНХРОННО (attemptPromise выставляется до
      // возврата из `_joinOrStartPendingDisposalAttempt`, т.к. присваивание
      // происходит ДО первого await внутри async-функции) — НЕ ждём его
      // завершения здесь: `unregister()`/`stopAll()`, найдя tombstone в
      // `_pendingDisposals`, JOIN-ятся на ЭТУ ЖЕ попытку. Если бы мы здесь
      // await-или её до конца, повторная проверка tombstone в `unregister()`
      // нашла бы attemptPromise УЖЕ очищенным и запустила бы dispose() ВТОРОЙ
      // раз параллельно — именно этого не должно происходить.
      void this._joinOrStartPendingDisposalAttempt(pendingDisposal);

      // Реальный исход dispose() (Ok/DISPOSE_FAILED/DISPOSE_TIMED_OUT)
      // сообщается вызывающему unregister()/stopAll() через отдельную
      // проверку `_pendingDisposals` ПОСЛЕ того как `pending.completion`
      // (этот promise) разрешится — см. `unregister()`. Здесь всегда
      // возвращаем единообразный cancellation Error: регистрация в любом
      // случае никогда не была опубликована.
      return Err(new Error(`Strategy registration cancelled during initialize(): ${strategyId}`));
    }

    // Дедупликация additionalTradableTargets по instrumentId — конфликтующие
    // пары уже отклонены в register(), одинаковые дубли здесь молча схлопываются
    // в одну запись (сохраняем ПЕРВОЕ вхождение).
    const dedupedAdditionalTargets: { readonly instrumentId: InstrumentId; readonly asset: AssetId }[] = [];
    const seenAdditionalKeys = new Set<string>();
    for (const target of reg.additionalTradableTargets ?? []) {
      const key = String(target.instrumentId);
      if (seenAdditionalKeys.has(key)) continue;
      seenAdditionalKeys.add(key);
      dedupedAdditionalTargets.push(target);
    }

    // Routing instruments: primary + additional + complementary + КАЖДЫЙ
    // additionalTradableTarget (tradable target ОБЯЗАН триггерить tick —
    // иначе стратегия могла бы торговать инструментом, чьи BOOK/FILL события
    // никогда не доходят до неё).
    const routingKeys = new Set<string>();
    routingKeys.add(String(reg.instrumentId));
    for (const addId of reg.additionalInstrumentIds ?? []) {
      routingKeys.add(String(addId));
    }
    if (reg.complementaryInstrumentId !== undefined) {
      routingKeys.add(String(reg.complementaryInstrumentId));
    }
    for (const target of dedupedAdditionalTargets) {
      routingKeys.add(String(target.instrumentId));
    }

    // Tradable targets: ТОЛЬКО primary + complementary + explicit additional
    // tradable targets — routing-only additionalInstrumentIds исключены:
    // они триггерят tick, но не являются разрешённым PLACE-таргетом.
    const tradableKeys = new Set<string>();
    tradableKeys.add(String(reg.instrumentId));
    if (reg.complementaryInstrumentId !== undefined) {
      tradableKeys.add(String(reg.complementaryInstrumentId));
    }
    for (const target of dedupedAdditionalTargets) {
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
      cryptoAsset: (reg.cryptoAsset !== undefined ? asCryptoAssetId(reg.cryptoAsset) : undefined)
        ?? normalizeCryptoAsset(reg.cryptoSymbol),
      eventStartMs: reg.eventStartMs,
      additionalInstrumentIds: reg.additionalInstrumentIds,
      complementaryInstrumentId: reg.complementaryInstrumentId,
      complementaryAsset: reg.complementaryAsset,
      additionalTradableTargets: dedupedAdditionalTargets,
      routingInstrumentKeys: [...routingKeys],
      tradableInstrumentKeys: tradableKeys,
      lifecycle: 'ACTIVE',
      stopAttemptPromise: undefined,
      finalIntents: undefined,
      activeExecution: undefined,
      finalCleanupExecution: undefined,
      disposeExecution: undefined,
      commitmentCheckExecution: undefined,
      disposed: false,
      consecutiveFailures: 0,
      lastRunMs: 0,
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
   *   при любом небезопасном/незавершённом/timeout исходе (retryable)
   *
   * @remarks
   * Порядок поиска (см. также class-level doc):
   * 1. `_pendingDisposals` (persistent tombstone) — strategy instance здесь
   *    НЕДОСТИЖИМА никаким другим путём: НИКОГДА не возвращает
   *    `STRATEGY_NOT_FOUND`, коалесцирует concurrent вызовы, удаляется
   *    ТОЛЬКО после фактически успешного `dispose()`.
   * 2. Pending registration (`initialize()` ещё выполняется) — отменяет
   *    публикацию; ждёт completion максимум `cancellationTimeoutMs`
   *    (`INITIALIZATION_CANCELLATION_TIMED_OUT` при превышении — `initialize()`
   *    НЕ отменяется, продолжает выполняться в фоне). После завершения:
   *    если возникла `PendingDisposal` — коалесцируется на ту же попытку и
   *    транслирует Ok→`REGISTRATION_CANCELLED` (успешная отмена ЭТИМ вызовом),
   *    Err→реальный код (`DISPOSE_FAILED`/`DISPOSE_TIMED_OUT`).
   * 3. Неизвестный ID — `STRATEGY_NOT_FOUND`.
   * 4. Существующая entry — коалесцирует concurrent вызовы на один
   *    in-flight attempt (`entry.stopAttemptPromise`) и делегирует в
   *    {@link _attemptStop}.
   */
  public async unregister(strategyId: string): Promise<Result<void, StopStrategyError>> {
    // 1. Persistent pending-disposal tombstone — retry на ранее провалившийся/
    // зависший dispose() отменённой регистрации.
    const pendingDisposal = this._pendingDisposals.get(strategyId);
    if (pendingDisposal) {
      return this._joinOrStartPendingDisposalAttempt(pendingDisposal);
    }

    // 2. Pending registration — initialize() ещё выполняется.
    const pending = this._pendingRegistrations.get(strategyId);
    if (pending) {
      pending.cancelled = true;

      const waitOutcome = await this._raceWithTimeout(pending.completion, pending.cancellationTimeoutMs);
      if (waitOutcome.kind === 'timed-out') {
        this._logger.error('Unregister blocked — initialize() has not completed yet within cancellationTimeoutMs, retry later', {
          strategyId,
        });
        return Err(new StopStrategyError(
          'INITIALIZATION_CANCELLATION_TIMED_OUT',
          strategyId,
          `Strategy ${strategyId} initialize() has not completed yet — cancellation requested, retry unregister later`,
        ));
      }

      // Race: register() мог уже опубликовать entry до того, как заметил
      // cancelled (например, cancelled выставлен ПОСЛЕ post-init check, но
      // ДО this._entries.set — крайне маловероятно, т.к. cancelled проверяется
      // прямо перед публикацией, но проверяем защитно). Если entry всё же
      // существует — продолжаем обычным unregister-flow вместо того чтобы
      // оставить ACTIVE стратегию без stop.
      if (this._entries.has(strategyId)) {
        return this.unregister(strategyId);
      }

      // Cancelled-ветка _completeRegistration уже создала PendingDisposal и
      // запустила bounded dispose (attemptPromise выставлен синхронно) —
      // коалесцируемся на ТУ ЖЕ попытку, НЕ запускаем второй параллельный dispose.
      const tombstone = this._pendingDisposals.get(strategyId);
      if (tombstone) {
        const result = await this._joinOrStartPendingDisposalAttempt(tombstone);
        if (!result.ok) {
          return result;
        }
        // Успешный dispose: именно ЭТОТ вызов инициировал отмену — по контракту
        // возвращает REGISTRATION_CANCELLED (а не Ok), в отличие от отдельного
        // retry-вызова через ветку #1 выше.
        return Err(new StopStrategyError(
          'REGISTRATION_CANCELLED',
          strategyId,
          `Strategy registration cancelled during initialize(): ${strategyId}`,
        ));
      }

      // Нет tombstone — initialize() сам провалился/бросил (dispose()
      // неприменим, см. _completeRegistration) либо cancelled без успешного init.
      return Err(new StopStrategyError(
        'REGISTRATION_CANCELLED',
        strategyId,
        `Strategy registration cancelled during initialize(): ${strategyId}`,
      ));
    }

    // 3. Неизвестный ID.
    const entry = this._entries.get(strategyId);
    if (!entry) {
      this._logger.warn('Strategy not found for unregister', { strategyId });
      return Err(new StopStrategyError('STRATEGY_NOT_FOUND', strategyId, `Strategy not found: ${strategyId}`));
    }

    // 4. Коалесцирование: concurrent/repeated unregister ждёт ТОТ ЖЕ attempt —
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
   * retry после timeout/небезопасного исхода на ЛЮБОМ шаге).
   *
   * @param strategyId - ID стратегии
   * @param entry - Entry (в состоянии ACTIVE/FAULTED/STOPPING)
   * @returns Ok(void) только при authoritative-подтверждённой остановке
   *
   * @remarks
   * ### 13-шаговый порядок (полностью повторяется на КАЖДОМ retry-attempt,
   * кроме шага 9 — dispose пропускается, если `entry.disposed === true`):
   * 1. ACTIVE/FAULTED → STOPPING.
   * 2. detach (routing/heartbeat/queue) — идемпотентен.
   * 3. ordinary execution: `Promise.race([execution.promise, timeoutSignal])`
   *    — таймаут НЕ отменяет Promise, просто возвращает retryable Err.
   * 4. `strategy.stop()` — вызывается РОВНО ОДИН РАЗ при успехе (кэш в
   *    `entry.finalIntents`); исключение НЕ кэшируется.
   * 5. final cleanup — ОДНА tracked `ExecutionEngine.execute()` (см.
   *    {@link TrackedAsyncOperation}), completion либо timeout. Fresh
   *    `CANCEL_ALL` добавляется, только когда операция РЕАЛЬНО (пере)запускается
   *    (не при join уже идущей).
   * 6. верификация `ExecutionReport` (errors/failed/blockedByUnsafeCancel/
   *    unsafe cancel outcomes).
   * 7. open-order post-check (authoritative, синхронный).
   * 8. commitment post-check — tracked, completion либо timeout.
   * 9. dispose — tracked, completion либо timeout; пропускается, если уже
   *    `disposed === true` (dispose() не вызывается повторно после успеха).
   * 10. ПОВТОРНЫЙ open-order post-check (после dispose могли появиться
   *     поздние ордера/recovery).
   * 11. ПОВТОРНЫЙ commitment post-check.
   * 12. STOPPED.
   * 13. удаление entry.
   *
   * Любой timeout (шаги 3/5/8/9) возвращает retryable `Err` БЕЗ выполнения
   * последующих шагов и БЕЗ очистки соответствующего tracked-state — retry
   * коалесцируется на ту же операцию (single-flight), никогда не запускает
   * параллельную вторую попытку.
   */
  private async _attemptStop(strategyId: string, entry: StrategyEntry): Promise<Result<void, StopStrategyError>> {
    // 1.
    if (entry.lifecycle === 'ACTIVE') {
      entry.lifecycle = 'STOPPING';
    }
    // 2. Detach идемпотентен (heartbeat/routing/queue guards уже no-op при
    // повторном вызове) — безопасно на КАЖДОМ attempt, включая retry.
    this._detachEntry(strategyId, entry);

    // 3.
    const execution = entry.activeExecution;
    if (execution !== undefined) {
      const outcome = await Promise.race([
        execution.promise.then((): 'completed' => 'completed'),
        execution.timeoutSignal.then((): 'timed-out' => 'timed-out'),
      ]);

      if (outcome === 'timed-out') {
        // Execution ЕЩЁ НЕ завершился (либо watchdog сработал раньше, либо
        // сработает совсем скоро) — НЕ запускаем strategy.stop()/final intents
        // параллельно с ordinary execution. Entry остаётся tracked; caller
        // может повторить unregister позже, когда execution.promise реально
        // разрешится (тогда race вернёт 'completed').
        this._logger.error('Unregister blocked — execution exceeded executionTimeoutMs and has not completed yet, retry later', {
          strategyId,
          lifecycle: entry.lifecycle,
        });
        return Err(new StopStrategyError(
          'EXECUTION_TIMED_OUT',
          strategyId,
          `Strategy ${strategyId} execution exceeded executionTimeoutMs and has not resolved yet — retry unregister later`,
        ));
      }
    }

    // Execution (если был) завершился без таймаута — FAULTED (watchdog
    // сработал для УЖЕ завершившегося execution) может безопасно перейти в
    // STOPPING для консистентности состояния.
    if (entry.lifecycle === 'FAULTED') {
      entry.lifecycle = 'STOPPING';
    }

    // 4. strategy.stop() вызывается РОВНО ОДИН РАЗ ПРИ УСПЕХЕ — исключение НЕ
    // кэшируется (entry.finalIntents остаётся undefined), следующий
    // unregister() вызовет strategy.stop() заново.
    if (entry.finalIntents === undefined) {
      // Тип возврата `entry.strategy.stop()` — `StrategyStopIntent[]` на
      // уровне compile-time контракта `IStrategy`, но runtime boundary ниже
      // (`_validateStopIntents`) обязана относиться к нему как к `unknown` —
      // стратегия может прийти из JavaScript, через unsafe cast, либо быть
      // повреждённым плагином. `unknown` здесь — ТОЛЬКО внутри scheduler-а,
      // публичный контракт `IStrategy.stop()` не меняется.
      let rawIntents: unknown;
      try {
        rawIntents = entry.strategy.stop();
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this._logger.error('Strategy.stop() threw — NOT treated as successful stop, retryable', {
          strategyId,
          error: error.message,
        });
        return Err(new StopStrategyError(
          'STOP_HOOK_FAILED',
          strategyId,
          `Strategy.stop() failed for ${strategyId}: ${error.message}`,
          { cause: error },
        ));
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

    // 5. Final cleanup — ОДНА tracked execute(), fresh CANCEL_ALL добавляется
    // ТОЛЬКО когда операция реально (пере)запускается (не при join).
    // Захватываем entry.finalIntents в локальную const СРАЗУ после того, как
    // шаг 4 гарантировал её определённость — TS корректно сужает тип этой
    // const-переменной внутри замыкания ниже (в отличие от mutable-поля).
    const cachedFinalIntents = entry.finalIntents;
    const ctx = this._makeExecutionContext(entry);
    const cleanupOutcome = await this._runOrJoinTrackedOperation<ExecutionReport>(
      () => entry.finalCleanupExecution,
      (op) => { entry.finalCleanupExecution = op; },
      () => {
        // Fresh CANCEL_ALL вычисляется ЗДЕСЬ (внутри run()), а не снаружи,
        // чтобы batch строился заново при каждом РЕАЛЬНОМ (пере)запуске
        // операции, а не при join уже идущей.
        const finalBatch = this._withFreshCancelAll(cachedFinalIntents);
        return this._deps.executionEngine.execute(ctx, finalBatch);
      },
      entry.config.finalCleanupTimeoutMs,
    );

    if (cleanupOutcome.kind === 'timed-out') {
      this._logger.error('Final cleanup execution exceeded finalCleanupTimeoutMs — entry retained, retry unregister later', {
        strategyId,
      });
      return Err(new StopStrategyError(
        'FINAL_CLEANUP_TIMED_OUT',
        strategyId,
        `Strategy ${strategyId} final cleanup execution exceeded finalCleanupTimeoutMs and has not resolved yet — retry unregister later`,
      ));
    }

    // 6.
    let report: ExecutionReport | undefined;
    let unsafeReason: string | undefined;
    if (cleanupOutcome.kind === 'error') {
      unsafeReason = `final execution threw: ${cleanupOutcome.error.message}`;
      this._logger.error('Failed to execute final intents', { strategyId, err: cleanupOutcome.error });
    } else {
      report = cleanupOutcome.result;
      const unsafeOutcome = report.outcomes.find(
        (o) => o.kind === 'CANCEL_PENDING' || o.kind === 'CANCEL_FAILED' || o.kind === 'CANCEL_CONFIRMED_TARGET_UNKNOWN',
      );
      if (report.errors.length > 0 || report.failed > 0 || report.blockedByUnsafeCancel > 0 || unsafeOutcome) {
        unsafeReason = `unsafe final execution report: errors=${report.errors.length}, failed=${report.failed}, blockedByUnsafeCancel=${report.blockedByUnsafeCancel}${unsafeOutcome ? `, unsafeOutcome=${unsafeOutcome.kind}` : ''}`;
      }
    }

    // 7-8.
    let commitments: readonly StrategyCommitment[] = [];
    if (unsafeReason === undefined) {
      const postCheck = await this._runPostCheck(strategyId, entry);
      if (postCheck.kind === 'commitment-check-timed-out') {
        return Err(new StopStrategyError(
          'COMMITMENT_CHECK_TIMED_OUT',
          strategyId,
          `Strategy ${strategyId} commitment post-check exceeded commitmentCheckTimeoutMs — retry unregister later`,
        ));
      }
      if (postCheck.kind === 'unsafe') {
        unsafeReason = postCheck.reason;
        commitments = postCheck.commitments;
      }
    }

    if (unsafeReason !== undefined) {
      this._logger.error('Strategy final cleanup unconfirmed — entry NOT removed, unregister must be retried', {
        strategyId,
        reason: unsafeReason,
      });
      return Err(new StopStrategyError('FINAL_CLEANUP_UNCONFIRMED', strategyId, unsafeReason, { report, commitments }));
    }

    // 9. dispose — пропускается, если уже успешно выполнен ранее.
    if (!entry.disposed) {
      const disposeOutcome = await this._runEntryDispose(entry);
      if (disposeOutcome.kind === 'timed-out') {
        this._logger.error('Strategy.dispose() exceeded disposeTimeoutMs — entry retained, retry unregister later', {
          strategyId,
        });
        return Err(new StopStrategyError(
          'DISPOSE_TIMED_OUT',
          strategyId,
          `Strategy.dispose() for ${strategyId} exceeded disposeTimeoutMs — retry unregister later`,
        ));
      }
      if (disposeOutcome.kind === 'error') {
        this._logger.error('Strategy.dispose() failed for ACTIVE shutdown — entry retained, retryable', {
          strategyId,
          error: disposeOutcome.error.message,
        });
        return Err(new StopStrategyError('DISPOSE_FAILED', strategyId, disposeOutcome.error.message, { cause: disposeOutcome.error }));
      }
      entry.disposed = true;
    }

    // 10-11. Повторный post-check: dispose() мог занять время, за которое
    // могли появиться поздние ордера/commitments (recovery, late fill и т.п.).
    const postCheck2 = await this._runPostCheck(strategyId, entry);
    if (postCheck2.kind === 'commitment-check-timed-out') {
      return Err(new StopStrategyError(
        'COMMITMENT_CHECK_TIMED_OUT',
        strategyId,
        `Strategy ${strategyId} post-dispose commitment post-check exceeded commitmentCheckTimeoutMs — retry unregister later`,
      ));
    }
    if (postCheck2.kind === 'unsafe') {
      this._logger.error('Strategy final cleanup unconfirmed AFTER dispose — entry NOT removed, unregister must be retried', {
        strategyId,
        reason: postCheck2.reason,
      });
      return Err(new StopStrategyError('FINAL_CLEANUP_UNCONFIRMED', strategyId, postCheck2.reason, { commitments: postCheck2.commitments }));
    }

    // 12-13.
    entry.lifecycle = 'STOPPED';
    this._entries.delete(strategyId);
    this._logger.info('Strategy unregistered', { strategyId });
    return Ok(undefined);
  }

  /**
   * Authoritative post-check: нет открытых ордеров стратегии + нет unresolved
   * submission/reservation/fill commitments (bounded, tracked).
   *
   * @param strategyId - ID стратегии
   * @param entry - Entry (для `commitmentCheckExecution`/timeout/instrumentIds)
   * @returns `safe` — можно продолжать; `unsafe` — с причиной и commitments;
   *   `commitment-check-timed-out` — reader завис, retry позже (state tracked)
   *
   * @remarks
   * Переиспользуется ДВАЖДЫ в `_attemptStop` (до и после dispose) — единое
   * поле `entry.commitmentCheckExecution` гарантирует, что обе точки вызова
   * используют один и тот же single-flight tracked-slot.
   */
  private async _runPostCheck(
    strategyId: string,
    entry: StrategyEntry,
  ): Promise<
    | { kind: 'safe' }
    | { kind: 'unsafe'; reason: string; commitments: readonly StrategyCommitment[] }
    | { kind: 'commitment-check-timed-out' }
  > {
    // Authoritative post-condition #1: нет открытых ордеров этой стратегии.
    // Переиспользуем orderStateStore (тот же authoritative repo, что и у
    // ExecutionEngine — см. buildStrategyEngine: orderStateStore: orderRepo).
    // Синхронный вызов — не нуждается в watchdog.
    try {
      const remaining = this._deps.orderStateStore.getOpenOrders(strategyId);
      if (remaining.length > 0) {
        return { kind: 'unsafe', reason: `authoritative post-check found ${remaining.length} live order(s) for strategy`, commitments: [] };
      }
    } catch (err) {
      return {
        kind: 'unsafe',
        reason: `authoritative post-check (open orders) threw: ${err instanceof Error ? err.message : String(err)}`,
        commitments: [],
      };
    }

    // Authoritative post-condition #2: нет unresolved submission/reservation/
    // fill commitments (UNKNOWN submission, VENUE_ACCEPTED без локального
    // Order, RECONCILIATION_REQUIRED reservation, unsettled fill). Отсутствие
    // локального Order (#1) НЕ доказывает их отсутствие — см.
    // `IStrategyCommitmentReader` doc. Bounded + tracked (single-flight).
    const commitOutcome = await this._runOrJoinTrackedOperation<readonly StrategyCommitment[]>(
      () => entry.commitmentCheckExecution,
      (op) => { entry.commitmentCheckExecution = op; },
      () => this._deps.commitmentReader.getActiveCommitments({
        strategyId,
        accountId: entry.accountId,
        instrumentIds: this._commitmentInstrumentIds(entry),
      }),
      entry.config.commitmentCheckTimeoutMs,
    );

    if (commitOutcome.kind === 'timed-out') {
      return { kind: 'commitment-check-timed-out' };
    }
    if (commitOutcome.kind === 'error') {
      return {
        kind: 'unsafe',
        reason: `authoritative commitment post-check threw: ${commitOutcome.error.message}`,
        commitments: [],
      };
    }
    if (commitOutcome.result.length > 0) {
      return {
        kind: 'unsafe',
        reason: `authoritative post-check found ${commitOutcome.result.length} unresolved commitment(s): ${commitOutcome.result.map((c) => c.kind).join(', ')}`,
        commitments: commitOutcome.result,
      };
    }
    return { kind: 'safe' };
  }

  /**
   * Bounded, tracked `entry.strategy.dispose()` для НОРМАЛЬНОЙ ACTIVE остановки.
   *
   * @param entry - Entry (использует `entry.disposeExecution`/`config.disposeTimeoutMs`)
   * @returns `timed-out` | `ok` | `error` (Err ИЛИ throw из `dispose()` — объединены)
   */
  private async _runEntryDispose(entry: StrategyEntry): Promise<
    | { kind: 'timed-out' }
    | { kind: 'ok' }
    | { kind: 'error'; error: Error }
  > {
    const outcome = await this._runOrJoinTrackedOperation<Result<void, Error>>(
      () => entry.disposeExecution,
      (op) => { entry.disposeExecution = op; },
      () => entry.strategy.dispose(),
      entry.config.disposeTimeoutMs,
    );
    if (outcome.kind === 'timed-out') return { kind: 'timed-out' };
    if (outcome.kind === 'error') return { kind: 'error', error: outcome.error };
    if (!outcome.result.ok) return { kind: 'error', error: outcome.result.error };
    return { kind: 'ok' };
  }

  /**
   * Bounded, tracked `dispose()` для `PendingDisposal` (отменённая во время
   * `initialize()` регистрация).
   *
   * @param pd - Persistent tombstone
   * @returns `timed-out` | `ok` | `error`
   */
  private async _runPendingDisposal(pd: PendingDisposal): Promise<
    | { kind: 'timed-out' }
    | { kind: 'ok' }
    | { kind: 'error'; error: Error }
  > {
    const outcome = await this._runOrJoinTrackedOperation<Result<void, Error>>(
      () => pd.disposeExecution,
      (op) => { pd.disposeExecution = op; },
      () => pd.strategy.dispose(),
      pd.disposeTimeoutMs,
    );
    if (outcome.kind === 'timed-out') return { kind: 'timed-out' };
    if (outcome.kind === 'error') return { kind: 'error', error: outcome.error };
    if (!outcome.result.ok) return { kind: 'error', error: outcome.result.error };
    return { kind: 'ok' };
  }

  /**
   * Один attempt bounded disposal для `PendingDisposal` tombstone — может
   * быть вызван повторно (retry после timeout/Err), коалесцирует concurrent
   * вызовы через `attemptPromise`.
   *
   * @param pd - Persistent tombstone (из `_pendingDisposals`)
   * @returns Ok(void) только после фактически успешного `dispose()` (tombstone
   *   удалена); Err(DISPOSE_FAILED/DISPOSE_TIMED_OUT) — tombstone остаётся
   *
   * @remarks
   * Если `pd.disposed === true` УЖЕ (не должно происходить — tombstone
   * удаляется сразу после успеха — оставлено как defensive no-op) —
   * немедленно возвращает Ok и удаляет запись.
   */
  private async _attemptPendingDisposal(pd: PendingDisposal): Promise<Result<void, StopStrategyError>> {
    if (!pd.disposed) {
      const outcome = await this._runPendingDisposal(pd);
      if (outcome.kind === 'timed-out') {
        this._logger.error('Pending disposal dispose() exceeded disposeTimeoutMs — tombstone retained, retry unregister later', {
          strategyId: pd.strategyId,
        });
        return Err(new StopStrategyError(
          'DISPOSE_TIMED_OUT',
          pd.strategyId,
          `Strategy.dispose() for ${pd.strategyId} exceeded disposeTimeoutMs — retry unregister later`,
        ));
      }
      if (outcome.kind === 'error') {
        this._logger.error('Pending disposal dispose() failed — tombstone retained, retryable', {
          strategyId: pd.strategyId,
          error: outcome.error.message,
        });
        return Err(new StopStrategyError('DISPOSE_FAILED', pd.strategyId, outcome.error.message, { cause: outcome.error }));
      }
      pd.disposed = true;
    }

    this._pendingDisposals.delete(pd.strategyId);
    this._logger.info('Pending disposal completed — cancelled strategy registration fully cleaned up', { strategyId: pd.strategyId });
    return Ok(undefined);
  }

  /**
   * Коалесцирует concurrent `unregister()`/`stopAll()` попытки на один
   * in-flight `_attemptPendingDisposal` для данного tombstone.
   *
   * @param pd - Persistent tombstone
   * @returns Результат in-flight (joined) либо только что стартовавшего attempt
   */
  private async _joinOrStartPendingDisposalAttempt(pd: PendingDisposal): Promise<Result<void, StopStrategyError>> {
    if (pd.attemptPromise) {
      return pd.attemptPromise;
    }
    const attempt = this._attemptPendingDisposal(pd);
    pd.attemptPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (pd.attemptPromise === attempt) {
        pd.attemptPromise = undefined;
      }
    }
  }

  /**
   * Generic single-flight bounded async operation: старт-или-join + timeout +
   * explicit-processing-then-clear.
   *
   * @param getOp - Читает текущий tracked-slot (например, `entry.disposeExecution`)
   * @param setOp - Записывает tracked-slot (`undefined` — после обработки результата)
   * @param run - Запускается ТОЛЬКО если `getOp()` вернул `undefined` (нет
   *   in-flight операции данного типа) — никогда не запускается параллельно
   * @param timeoutMs - Watchdog-таймаут ДЛЯ ЭТОЙ операции
   * @returns `timed-out` (state остаётся tracked, НЕ очищается) | `ok` | `error`
   *   (оба последних — operation ФАКТИЧЕСКИ завершилась, state уже очищен)
   *
   * @remarks
   * `run()` НЕ считается отменённым при timeout — Promise остаётся tracked в
   * slot-е (через `getOp`), следующий вызов с тем же `getOp`/`setOp` увидит
   * его и присоединится (`Promise.race` вернёт `'completed'` немедленно, если
   * он уже успел завершиться). State очищается (`setOp(undefined)`) ТОЛЬКО
   * когда `run()` фактически разрешился — что позволяет следующему вызову
   * стартовать СВЕЖУЮ операцию (например, final cleanup с fresh CANCEL_ALL).
   */
  private async _runOrJoinTrackedOperation<T>(
    getOp: () => TrackedAsyncOperation<T> | undefined,
    setOp: (op: TrackedAsyncOperation<T> | undefined) => void,
    run: () => Promise<T>,
    timeoutMs: number,
  ): Promise<
    | { kind: 'timed-out' }
    | { kind: 'ok'; result: T }
    | { kind: 'error'; error: Error }
  > {
    let op = getOp();
    if (op === undefined) {
      op = this._startTrackedOperation(run, timeoutMs);
      setOp(op);
    }

    const raceOutcome = await Promise.race([
      op.promise.then((): 'completed' => 'completed'),
      op.timeoutSignal.then((): 'timed-out' => 'timed-out'),
    ]);

    if (raceOutcome === 'timed-out') {
      return { kind: 'timed-out' };
    }

    // Завершилось фактически — обрабатываем результат и очищаем tracked
    // state, разрешая следующему вызову начать СВЕЖУЮ операцию.
    setOp(undefined);
    if (op.error !== undefined) {
      return { kind: 'error', error: op.error };
    }
    return { kind: 'ok', result: op.result as T };
  }

  /**
   * Стартует новый {@link TrackedAsyncOperation} — watchdog через
   * `ISchedulerTimer`, НЕ отменяющий `run()`.
   *
   * @param run - Асинхронная операция (синхронные throws тоже перехватываются)
   * @param timeoutMs - Watchdog-таймаут
   * @returns Новый `TrackedAsyncOperation` (уже запущенный)
   *
   * @remarks
   * `op` объявлена `let` и присваивается ПОСЛЕ настройки timeout callback-а и
   * `promise`-цепочки, но ОБА замыкания ссылаются на неё по имени — оба
   * выполняются асинхронно (таймер callback, `.then/.catch/.finally`), уже
   * ПОСЛЕ синхронного присваивания `op = {...}` в конце функции. TypeScript
   * definite-assignment анализ не отслеживает через отложенные
   * function-expression замыкания, поэтому это НЕ вызывает TS2454 (проверено
   * эмпирически под `--strict`) — тот же паттерн, что и `ActiveExecution` в
   * `_executeTick`.
   */
  private _startTrackedOperation<T>(run: () => Promise<T>, timeoutMs: number): TrackedAsyncOperation<T> {
    const startedAtMs = this._deps.clock.now().getTime();

    let resolveTimeoutSignal: () => void = () => {};
    const timeoutSignal = new Promise<void>((resolve) => {
      resolveTimeoutSignal = resolve;
    });

    // `op` присваивается РОВНО ОДИН РАЗ, но ПОСЛЕ объявления closures (timeout
    // callback, promise chain), которые ссылаются на неё по имени — `const`
    // невозможен: значение ещё не построено (зависит от `timeoutHandle`/
    // `promise`, которые сами ссылаются на `op`). Forward-reference pattern,
    // см. doc выше.
    // eslint-disable-next-line prefer-const
    let op: TrackedAsyncOperation<T>;

    const timeoutHandle = this._deps.timer.setTimeout(() => {
      if (op.completed) return;
      op.timedOut = true;
      resolveTimeoutSignal();
    }, timeoutMs);

    // Promise.resolve().then(run) нормализует СИНХРОННЫЕ throws из run()
    // (например, стратегия/reader с багом, бросающие до возврата Promise) в
    // rejection — чтобы .catch() ниже гарантированно их поймал.
    const promise = Promise.resolve()
      .then(() => run())
      .then((result) => {
        op.result = result;
      })
      .catch((err: unknown) => {
        op.error = err instanceof Error ? err : new Error(String(err));
      })
      .finally(() => {
        op.completed = true;
        this._deps.timer.clearTimeout(timeoutHandle);
      });

    op = {
      promise,
      startedAtMs,
      timedOut: false,
      completed: false,
      timeoutHandle,
      timeoutSignal,
      result: undefined,
      error: undefined,
    };

    return op;
  }

  /**
   * Ограничивает ожидание произвольного (не-tracked) Promise таймаутом —
   * используется для `pending.completion` в `unregister()` (нет
   * single-flight/join семантики — каждый вызов ставит СВОЙ таймер).
   *
   * @param promise - Promise, который никогда не rejects (например,
   *   `PendingRegistration.completion`)
   * @param timeoutMs - Таймаут ожидания
   * @returns `completed` с результатом, либо `timed-out` (promise остаётся
   *   pending — НЕ отменяется)
   */
  private async _raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<{ kind: 'completed'; result: T } | { kind: 'timed-out' }> {
    let resolveTimeoutSignal: () => void = () => {};
    const timeoutSignal = new Promise<void>((resolve) => {
      resolveTimeoutSignal = resolve;
    });
    const timeoutHandle = this._deps.timer.setTimeout(() => {
      resolveTimeoutSignal();
    }, timeoutMs);

    const outcome = await Promise.race([
      promise.then((result): { kind: 'completed'; result: T } => ({ kind: 'completed', result })),
      timeoutSignal.then((): { kind: 'timed-out' } => ({ kind: 'timed-out' })),
    ]);

    this._deps.timer.clearTimeout(timeoutHandle);
    return outcome;
  }

  /**
   * Валидирует, что `strategy.stop()` вернул ТОЛЬКО CANCEL/CANCEL_ALL.
   *
   * @param raw - Сырое (untrusted) значение из `strategy.stop()` — `unknown`,
   *   НЕ `StrategyStopIntent[]`
   * @returns Ok(StrategyStopIntent[]) — с ПЕРЕСТРОЕННЫМИ safe-объектами;
   *   либо Err, если `raw` — не массив, содержит malformed/PLACE/неизвестный
   *   intent, либо CANCEL с невалидным `orderId`
   *
   * @remarks
   * Настоящая runtime boundary, а не просто дополнение к compile-time типу
   * `StrategyStopIntent` — `entry.strategy.stop()` может прийти из
   * JavaScript-реализации, повреждённого plugin-а или unsafe cast, и вернуть
   * ЛЮБОЕ runtime-значение (`undefined`, `42`, `{}`, `[{ type: 'CANCEL' }]`
   * без `orderId`, getter, бросающий при чтении `type`, и т.п.). Ни один из
   * этих случаев не должен приводить к брошенному исключению внутри
   * `_attemptStop` (что превратило бы `unregister()` в rejected Promise) —
   * ВСЕГДА возвращается `Err`, конвертируемый в typed
   * `StopStrategyError('UNSAFE_FINAL_INTENT', ...)`. Парсинг каждого
   * элемента изолирован `try/catch` в `_validateStopIntents` — сбойный
   * getter/proxy на одном элементе не бросает наружу.
   */
  private _validateStopIntents(raw: unknown): Result<StrategyStopIntent[], Error> {
    if (!Array.isArray(raw)) {
      return Err(new Error(
        `strategy.stop() must return an array of CANCEL/CANCEL_ALL intents, got ${typeof raw}`,
      ));
    }

    const validated: StrategyStopIntent[] = [];
    for (const rawIntent of raw) {
      let parsed: Result<StrategyStopIntent, Error>;
      try {
        parsed = this._parseStopIntent(rawIntent);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        parsed = Err(new Error(`strategy.stop() intent parsing threw: ${error.message}`));
      }
      if (!parsed.ok) {
        return parsed;
      }
      validated.push(parsed.value);
    }
    return Ok(validated);
  }

  /**
   * Парсит и валидирует ОДИН runtime-элемент из `strategy.stop()`.
   *
   * @param value - Сырой (untrusted) элемент массива
   * @returns Ok с НОВЫМ, пересобранным safe-объектом (никогда не
   *   `value as StrategyStopIntent`) либо Err с описанием нарушения
   *
   * @remarks
   * Возврат ПЕРЕСТРОЕННОГO объекта (а не приведение типа исходного `value`)
   * гарантирует, что дальнейший код (`_withFreshCancelAll`,
   * `ExecutionEngine.execute`) никогда не получает объект с посторонними
   * полями или повторно читаемыми getter-ами, которые могли бы бросить при
   * следующем доступе. `orderId` валидируется через authoritative
   * `asOrderId()` из `@polymarket/ids` (та же валидация non-empty/length/
   * control-chars, что и везде в системе) — не через локальную ad-hoc
   * проверку. `'type' in value` безопасен даже для getter-based `type`:
   * оператор `in` проверяет только наличие ключа, не вызывает getter.
   */
  private _parseStopIntent(value: unknown): Result<StrategyStopIntent, Error> {
    if (typeof value !== 'object' || value === null || !('type' in value)) {
      return Err(new Error(
        `strategy.stop() returned a malformed intent (expected an object with "type"), got ${JSON.stringify(value)}`,
      ));
    }

    const type: unknown = Reflect.get(value, 'type');

    if (type === 'CANCEL_ALL') {
      return Ok({ type: 'CANCEL_ALL' });
    }

    if (type === 'CANCEL') {
      const rawOrderId: unknown = Reflect.get(value, 'orderId');
      const orderId = typeof rawOrderId === 'string' ? asOrderId(rawOrderId) : undefined;
      if (orderId === undefined) {
        return Err(new Error(
          `strategy.stop() returned CANCEL with invalid orderId: ${JSON.stringify(rawOrderId)}`,
        ));
      }
      return Ok({ type: 'CANCEL', orderId });
    }

    return Err(new Error(
      `strategy.stop() returned an unsafe intent type "${String(type)}" — only CANCEL/CANCEL_ALL are allowed from stop()`,
    ));
  }

  /**
   * Гарантирует наличие РОВНО ОДНОГО `CANCEL_ALL` в final batch.
   *
   * @param finalIntents - Кэшированные intents из `strategy.stop()`
   * @returns Копия с добавленным `CANCEL_ALL`, если его не было; без
   *   изменений (кроме копирования), если он уже присутствовал
   *
   * @remarks
   * `strategy.stop()` вызывается один раз и кэшируется, но authoritative
   * sweep всех текущих ордеров стратегии обязателен НА КАЖДОЙ retry-попытке —
   * между попытками мог появиться новый Order (поздний PLACE, recovery).
   * Конкретные `CANCEL` из `strategy.stop()` сохраняются как есть.
   */
  private _withFreshCancelAll(finalIntents: readonly StrategyStopIntent[]): StrategyStopIntent[] {
    if (finalIntents.some((intent) => intent.type === 'CANCEL_ALL')) {
      return [...finalIntents];
    }
    return [...finalIntents, { type: 'CANCEL_ALL' }];
  }

  /**
   * Инструменты, для которых `IStrategyCommitmentReader` проверяет unsettled fills.
   *
   * @param entry - Entry стратегии
   * @returns Primary + complementary (если задан) + все `additionalTradableTargets` (deduplicated)
   */
  private _commitmentInstrumentIds(entry: StrategyEntry): readonly InstrumentId[] {
    const ids: InstrumentId[] = [entry.instrumentId];
    const seen = new Set<string>([String(entry.instrumentId)]);
    if (entry.complementaryInstrumentId !== undefined) {
      const key = String(entry.complementaryInstrumentId);
      if (!seen.has(key)) {
        seen.add(key);
        ids.push(entry.complementaryInstrumentId);
      }
    }
    for (const target of entry.additionalTradableTargets) {
      const key = String(target.instrumentId);
      if (!seen.has(key)) {
        seen.add(key);
        ids.push(target.instrumentId);
      }
    }
    return ids;
  }

  /**
   * Останавливает и снимает регистрацию всех стратегий (безопасный flow).
   *
   * @returns Ok(void) если все стратегии (pending registrations, pending
   *   disposals и registered entries) успешно остановлены; иначе
   *   Err(readonly StopStrategyError[]) с накопленными ошибками
   *
   * @remarks
   * ### Порядок (критично — existing entries детачатся ДО любого await):
   * 1. Поднимает global stopping barrier — `register()` немедленно отклоняет
   *    новые регистрации; ЛЮБАЯ pending registration, чей `initialize()`
   *    разрешится ПОСЛЕ этой точки, тоже пойдёт по cancelled-ветке
   *    `_completeRegistration` (barrier проверяется ТАМ, не только `cancelled`).
   * 2. Помечает ВСЕ текущие pending registrations `cancelled = true`.
   * 3. **Синхронно, ДО первого await**, стартует `unregister()` для КАЖДОЙ
   *    существующей entry (`this.unregister(id)` — вызов async-функции
   *    исполняет её тело синхронно вплоть до первого await; `_attemptStop`
   *    переводит ACTIVE/FAULTED → STOPPING и выполняет detach
   *    (routing/heartbeat/queue/deferred timers) ДО того, как этот метод
   *    дойдёт до своего первого await). Гарантия: сразу после синхронного
   *    возврата `stopAll()` (т.е. до того, как caller успеет сделать
   *    `await`), НИ ОДНА из существовавших на тот момент entries уже не
   *    тикает, не в routing и не в queue — единственное, что ещё может
   *    продолжаться — уже запущенный ДО stopAll() ordinary execution,
   *    который донашивается штатным bounded stop-flow (см. `_attemptStop`).
   * 4. Bounded ожидание completion всех pending registrations (каждая своим
   *    `cancellationTimeoutMs`) — `initialize()` НЕ отменяется.
   * 5. Снимок `_pendingDisposals` берётся ПОСЛЕ шага 4 (не раньше!) — только
   *    так он гарантированно включает tombstones, созданные cancelled-веткой
   *    `_completeRegistration()` для регистраций, чей `initialize()` успел
   *    завершиться именно во время ожидания на шаге 4, ПЛЮС любые tombstones,
   *    оставшиеся от предыдущих неудачных `unregister()`. Каждый
   *    коалесцируется на свой in-flight attempt через
   *    `_joinOrStartPendingDisposalAttempt` (никогда не запускает
   *    параллельный второй dispose).
   * 6. Параллельно дожидается: (a) все `unregister()` promises, запущенные
   *    на шаге 3, (b) все disposal attempts с шага 5.
   * 7. Агрегирует ошибки БЕЗ дублей — если конкретная disposal-ошибка
   *    (`DISPOSE_TIMED_OUT`/`DISPOSE_FAILED`) уже получена с шага 6b, generic
   *    "remains unresolved" fallback для ТОГО ЖЕ strategyId не добавляется
   *    повторно.
   * НЕ логирует «All strategies stopped», если хотя бы одна регистрация,
   * disposal или стратегия не остановлена подтверждённо, ЛИБО если
   * `_pendingDisposals` всё ещё непусто по завершении.
   */
  public async stopAll(): Promise<Result<void, readonly StopStrategyError[]>> {
    this._globalStopping = true;

    // 2. Pending registrations — пометить cancelled СИНХРОННО, ДО старта
    // unregister() существующих entries (шаг 3).
    const pendingEntries = [...this._pendingRegistrations.entries()];
    for (const [, p] of pendingEntries) {
      p.cancelled = true;
    }

    // 3. КРИТИЧНО: unregister() для ВСЕХ существующих entries запускается
    // ЗДЕСЬ — синхронно, ДО первого await этого метода (см. class-level doc
    // выше). Raньше unregister() существующих entries откладывался ДО того,
    // как разрешатся pending registrations/disposals — всё это время ACTIVE
    // стратегии оставались в routing/queue и продолжали тикать/торговать
    // ПОСЛЕ вызова stopAll(), что нарушало ожидание caller-а «shutdown начат
    // немедленно».
    const entryIds = [...this._entries.keys()];
    const entryStopPromises = entryIds.map((id) => this.unregister(id));

    // 4. Bounded wait — каждая pending registration своим cancellationTimeoutMs.
    const pendingWaitOutcomes = await Promise.all(
      pendingEntries.map(([, p]) => this._raceWithTimeout(p.completion, p.cancellationTimeoutMs)),
    );
    const pendingErrors: StopStrategyError[] = [];
    for (let i = 0; i < pendingEntries.length; i++) {
      const [id] = pendingEntries[i];
      const outcome = pendingWaitOutcomes[i];
      if (outcome.kind === 'timed-out') {
        pendingErrors.push(new StopStrategyError(
          'INITIALIZATION_CANCELLATION_TIMED_OUT',
          id,
          `Strategy ${id} initialize() has not completed yet — cancellation requested, retry unregister later`,
        ));
      }
      // 'completed' (Ok ИЛИ Err от _completeRegistration) само по себе не
      // failure для stopAll — реальный dispose-исход агрегируется отдельно
      // на шаге 5 через _pendingDisposals (tombstone, если он появился).
    }

    // 5. Pending disposals — снимок ПОСЛЕ ожидания pending registrations
    // (шаг 4), чтобы включить tombstones, созданные ИМЕННО во время этого
    // ожидания, а не только уже существовавшие на момент вызова stopAll().
    const disposalEntries = [...this._pendingDisposals.entries()];
    const disposalPromises = disposalEntries.map(([, pd]) => this._joinOrStartPendingDisposalAttempt(pd));

    // 6. Параллельное ожидание entry-stop (запущенных на шаге 3) и disposal
    // attempts (запущенных на шаге 5).
    const [entryResults, disposalResults] = await Promise.all([
      Promise.all(entryStopPromises),
      Promise.all(disposalPromises),
    ]);

    const entryErrors = entryResults
      .filter((r): r is { ok: false; error: StopStrategyError } => !r.ok)
      .map((r) => r.error);
    const disposalErrors = disposalResults
      .filter((r): r is { ok: false; error: StopStrategyError } => !r.ok)
      .map((r) => r.error);

    // 7. Defensive fallback — максимум ОДНА disposal-ошибка на strategyId:
    // если конкретная причина (DISPOSE_TIMED_OUT/DISPOSE_FAILED) для этого ID
    // уже попала в disposalErrors выше, generic "remains unresolved" НЕ
    // дублирует её — иначе одна и та же зависшая disposal-операция считалась
    // бы ДВАЖДЫ в aggregate failures (искажает счётчик и маскирует точный
    // timeout под generic сообщением).
    const reportedDisposalIds = new Set(disposalErrors.map((e) => e.strategyId));
    const staleDisposalErrors = [...this._pendingDisposals.keys()]
      .filter((id) => !reportedDisposalIds.has(id))
      .map((id) => new StopStrategyError('DISPOSE_FAILED', id, `Pending disposal for ${id} remains unresolved after stopAll`));

    const failures = [...pendingErrors, ...disposalErrors, ...entryErrors, ...staleDisposalErrors];
    if (failures.length > 0) {
      this._logger.error('stopAll: some strategies failed to stop cleanly', {
        pendingFailures: pendingErrors.length,
        disposalFailures: disposalErrors.length,
        entryFailures: entryErrors.length,
        totalPending: pendingEntries.length,
        totalDisposals: disposalEntries.length,
        totalEntries: entryIds.length,
        remainingPendingDisposals: this._pendingDisposals.size,
      });
      return Err(failures);
    }

    this._logger.info('All strategies stopped', {
      count: entryIds.length,
      pendingCancelled: pendingEntries.length,
      disposalsResolved: disposalEntries.length,
    });
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
    if (entry.activeExecution !== undefined) {
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

    // Async execution с coalescing + watchdog. entry.activeExecution — единый
    // execution state (заменяет разрозненные running/executionPromise).
    const ctx = this._makeExecutionContext(entry);
    const startedAtMs = this._deps.clock.now().getTime();

    // resolveTimeoutSignal переопределяется СИНХРОННО внутри Promise executor
    // (не требует non-null assertion) — timeoutSignal resolves В ТОЧНОСТИ
    // когда watchdog срабатывает, независимо от lifecycle.
    let resolveTimeoutSignal: () => void = () => {};
    const timeoutSignal = new Promise<void>((resolve) => {
      resolveTimeoutSignal = resolve;
    });

    // Watchdog: state-machine защита от зависшего execute(). Мы НЕ отменяем
    // Promise (JS не может отменить неотменяемую операцию) — вместо этого
    // помечаем execution как timedOut и резолвим timeoutSignal НЕЗАВИСИМО от
    // lifecycle стратегии: execution существует независимо от того, ACTIVE
    // стратегия или уже STOPPING (unregister() мог быть вызван ДО того, как
    // watchdog успел сработать — именно этот сценарий раньше приводил к
    // бесконечному ожиданию в _attemptStop). Lifecycle-мутация в FAULTED
    // остаётся guarded — watchdog не должен перезаписывать уже идущий
    // STOPPING/STOPPED.
    const timeoutHandle = this._deps.timer.setTimeout(() => {
      const current = entry.activeExecution;
      if (!current || current.timeoutHandle !== timeoutHandle || current.completed) return;
      current.timedOut = true;
      if (entry.lifecycle === 'ACTIVE') {
        entry.lifecycle = 'FAULTED';
      }
      this._logger.error('CRITICAL: ExecutionEngine.execute() exceeded executionTimeoutMs — execution marked timed out', {
        strategyId,
        executionTimeoutMs: entry.config.executionTimeoutMs,
        lifecycle: entry.lifecycle,
      });
      resolveTimeoutSignal();
    }, entry.config.executionTimeoutMs);

    const promise = this._deps.executionEngine
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
        const current = entry.activeExecution;
        const isThisExecution = current !== undefined && current.timeoutHandle === timeoutHandle;
        if (isThisExecution) {
          current.completed = true;
          entry.activeExecution = undefined;
        }
        this._deps.timer.clearTimeout(timeoutHandle);

        if (isThisExecution && current.timedOut) {
          // Watchdog уже сработал для ЭТОГО execution: исход НЕ считается
          // безопасным для нормального coalescing rerun — controlled
          // recovery происходит через unregister() (см. _attemptStop).
          this._logger.error('Execution finished AFTER timeout — no automatic rerun, see lifecycle/unregister', {
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

    entry.activeExecution = {
      promise,
      startedAtMs,
      timedOut: false,
      completed: false,
      timeoutHandle,
      timeoutSignal,
    };
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
  /**
   * Разделяет открытые ордера стратегии на инструменте на cancellable
   * (openOrders) и in-flight (matchedOrders).
   *
   * @param strategyId - ID стратегии
   * @param instrumentId - Инструмент
   * @returns `{ openOrders, matchedOrders }` — та же логика разделения, что
   *   для primary/complementary (см. {@link _buildSnapshot}), переиспользуется
   *   для каждого `additionalTradableTargets` элемента.
   */
  private _splitOrdersForInstrument(
    strategyId: string,
    instrumentId: InstrumentId,
  ): { openOrders: Order[]; matchedOrders: Order[] } {
    const all = this._deps.orderStateStore.getOpenOrdersByInstrument(strategyId, instrumentId);
    const openOrders: Order[] = [];
    const matchedOrders: Order[] = [];
    for (const o of all) {
      if (this._deps.orderStateStore.hasMatchedFills(o.id)) {
        matchedOrders.push(o);
      } else {
        openOrders.push(o);
      }
    }
    return { openOrders, matchedOrders };
  }

  private _buildSnapshot(entry: StrategyEntry): StrategySnapshot {
    const id = entry.instrumentId;

    // Разделяем ордера на cancellable (openOrders) и in-flight (matchedOrders).
    // MATCHED = fill(ы) в пути (MATCHED → MINED → CONFIRMED), отменить нельзя.
    // openOrders — стратегия может отменять/переставлять.
    // matchedOrders — стратегия должна учитывать (чтобы не перекупать), но не отменять.
    const { openOrders, matchedOrders } = this._splitOrdersForInstrument(entry.strategy.id, id);

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
    let complementaryOpenOrders: Order[] | undefined;
    let complementaryMatchedOrders: Order[] | undefined;
    let hasComplementaryInFlightFills = false;

    if (compId) {
      const split = this._splitOrdersForInstrument(entry.strategy.id, compId);
      complementaryOpenOrders = split.openOrders;
      complementaryMatchedOrders = split.matchedOrders;

      hasComplementaryInFlightFills = this._deps.orderStateStore.hasUnsettledFills(compId);
      if (hasComplementaryInFlightFills && complementaryMatchedOrders.length === 0) {
        this._deps.logger.debug('Complementary instrument has in-flight fills (no matched orders in repo)', {
          strategyId: entry.strategy.id,
          instrumentId: String(compId),
        });
      }
    }

    // additionalTradableTargets: тот же per-инструмент срез (book/constraints/
    // orders/unsettled), что и primary/complementary — иначе стратегия могла
    // бы получить разрешение торговать инструментом (tradableInstrumentKeys),
    // не видя его данных в snapshot.
    const additionalTradableInstruments = new Map<string, TradableInstrumentSnapshot>();
    for (const target of entry.additionalTradableTargets) {
      const { openOrders: targetOpen, matchedOrders: targetMatched } = this._splitOrdersForInstrument(
        entry.strategy.id,
        target.instrumentId,
      );
      additionalTradableInstruments.set(String(target.instrumentId), {
        instrumentId: target.instrumentId,
        asset: target.asset,
        topOfBook: this._deps.marketDataStore.getTopOfBook(target.instrumentId),
        bookHistory: this._deps.marketDataStore.getBookHistory(target.instrumentId),
        tradeTape: this._deps.marketDataStore.getTradeTape(target.instrumentId),
        constraints: this._constraintsFor(target.instrumentId),
        openOrders: targetOpen,
        matchedOrders: targetMatched,
        hasUnsettledFills: this._deps.orderStateStore.hasUnsettledFills(target.instrumentId),
      });
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
      additionalTradableInstruments,
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

function normalizeCryptoAsset(symbolOrAsset: string | undefined): CryptoAssetId | undefined {
  if (!symbolOrAsset) return undefined;
  const normalized = symbolOrAsset.trim().toLowerCase();
  if (!normalized) return undefined;
  const asset = normalized.includes('/')
    ? normalized.split('/')[0]
    : normalized.includes('-')
      ? normalized.split('-')[0]
      : normalized.replace(/usd[tc]?$/i, '');
  return asset ? asCryptoAssetId(asset) : undefined;
}

/** Singleton пустой Set для _getDirtyReasons() — не аллоцируем объект каждый вызов */
const _EMPTY_DIRTY_SET: ReadonlySet<TriggerReason> = new Set();
