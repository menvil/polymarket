/**
 * @polymarket/strategy — Reactive scheduling архитектура для торговых стратегий.
 *
 * @remarks
 * ### Содержимое пакета:
 *
 * **Типы:**
 * - `TriggerReason` — причина пересчёта (BOOK, TRADE, FILL, ORDER_UPDATE, TIMER)
 * - `StrategyIntent` — декларативное намерение (PLACE, CANCEL, CANCEL_ALL)
 * - `StrategySnapshot` — readonly snapshot состояния
 * - `ScheduleConfig` — конфигурация расписания
 *
 * **Интерфейсы:**
 * - `IStrategy` — контракт пользовательской стратегии (tick-based)
 *
 * **Реализации:**
 * - `BaseStrategy` — абстрактный класс с gather → decide → toIntents pipeline
 * - `ExecutionEngine` — нормализация и исполнение intents
 * - `StrategyScheduler` — ядро: event-driven queue + coalescing
 *
 * **Интеграция:**
 * - `OrderEventBridge` — мост между Order domain events и StrategyScheduler
 *
 * @example
 * ```typescript
 * import type { IStrategy, StrategySnapshot, TriggerReason, StrategyIntent } from '@polymarket/strategy';
 * import { StrategyScheduler, BaseStrategy } from '@polymarket/strategy';
 *
 * class SimpleQuoter extends BaseStrategy<MyData, MyAction> {
 *   readonly id = 'simple-quoter-1';
 *   readonly name = 'SimpleQuoter';
 *
 *   protected gather(snapshot: StrategySnapshot) { ... }
 *   protected decide(data: MyData, reasons: ReadonlySet<TriggerReason>) { ... }
 *   protected toIntents(actions: MyAction[]): StrategyIntent[] { ... }
 * }
 *
 * const scheduler = new StrategyScheduler(deps);
 * scheduler.start();
 * await scheduler.register({ strategy: new SimpleQuoter(), instrumentId, asset, accountId, market });
 * ```
 *
 * @packageDocumentation
 */

// ── Новая архитектура: types ────────────────────────────────
export type { TriggerReason } from './types/index.js';
export { KNOWN_TRIGGER_REASONS, placeTarget } from './types/index.js';
export type {
  StrategyIntent,
  BasePlaceIntent,
  PlaceIntent,
  CancelIntent,
  CancelAllIntent,
  StrategyStopIntent,
} from './types/index.js';
export type { StopStrategyErrorCode } from './types/index.js';
export { StopStrategyError } from './types/index.js';
export type {
  CexBookTick,
  CexTradeTick,
  CexVenue,
  CexVenueState,
  CryptoSignalDirection,
  CryptoSignalRegistryView,
  CryptoSignalRequest,
  CryptoSignalResult,
  CryptoPriceHistoryView,
  CryptoPricePoint,
  CryptoPriceSource,
  CryptoVenueHistoryView,
  CryptoVenueStateView,
  StrategySnapshot,
} from './types/index.js';
export type { InstrumentConstraints } from './types/index.js';
export type { ScheduleConfig } from './types/index.js';
export { createDefaultScheduleConfig, validateScheduleConfig } from './types/index.js';

// ── Ports: timers + order ID generation (determinism) ───────
export type { ISchedulerTimer, TimerHandle } from './ports/SchedulerTimer.js';
export { NodeSchedulerTimer, DeterministicSchedulerTimer } from './ports/SchedulerTimer.js';
export type { IOrderIdGenerator } from './ports/OrderIdGenerator.js';
export {
  UuidOrderIdGenerator,
  SequentialOrderIdGenerator,
  OrderIdGeneratorConfigError,
  OrderIdGeneratorInvariantError,
} from './ports/OrderIdGenerator.js';

// ── Новая архитектура: интерфейсы ───────────────────────────
export type { IStrategy } from './IStrategy.js';

// ── Новая архитектура: реализации ───────────────────────────
export { BaseStrategy } from './BaseStrategy.js';
export { ExecutionEngine, LocalIntentRejectionError } from './ExecutionEngine.js';
export type {
  ExecutionEngineDeps,
  ExecutionContext,
  ExecutionReport,
  EffectiveOrderTarget,
  CancelExecutionResult,
  IntentOutcome,
  IntentOutcomeKind,
  ITokenBalanceChecker,
} from './ExecutionEngine.js';
export { StrategyScheduler } from './StrategyScheduler.js';
export type {
  StrategySchedulerDeps,
  StrategyRegistration,
  StrategyLifecycle,
  IMarketDataStore,
  ICryptoMarketDataStore,
  ICryptoResolutionStore,
  ICryptoSignalRegistry,
} from './StrategyScheduler.js';
// IOrderStateStore re-exported from ports for backward compatibility
export type { IOrderStateStore } from '@polymarket/ports';

// ── Интеграция ───────────────────────────────────────────────
export { OrderEventBridge } from './OrderEventBridge.js';
export type { OrderEventBridgeDeps } from './OrderEventBridge.js';
