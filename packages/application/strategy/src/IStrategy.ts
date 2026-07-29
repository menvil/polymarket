/**
 * IStrategy — публичный интерфейс для пользовательских стратегий.
 *
 * @remarks
 * ### Новая архитектура: reactive scheduling
 * Стратегия **НЕ** подписывается на события. Вместо этого:
 * 1. Events → State Stores (in-memory, sync)
 * 2. State Stores → StrategyScheduler._markDirty()
 * 3. StrategyScheduler → strategy.tick(snapshot, reasons) → StrategyIntent[]
 * 4. ExecutionEngine → исполняет intents
 *
 * ### Жизненный цикл:
 * 1. `StrategyScheduler.register(registration)` → `strategy.initialize()`
 * 2. Данные обновляются → scheduler вызывает `strategy.tick(snapshot, reasons)`
 * 3. tick() возвращает StrategyIntent[] — декларативные намерения
 * 4. При остановке ЗАРЕГИСТРИРОВАННОЙ (ACTIVE) стратегии: `strategy.stop()` →
 *    финальные intents (только CANCEL/CANCEL_ALL, см. {@link StrategyStopIntent})
 *
 * ### `initialize()` vs `dispose()` vs `stop()`:
 * - `initialize()` — открыть внешние ресурсы (подключения, подписки и т.п.)
 *   ПЕРЕД тем, как стратегия станет ACTIVE и начнёт получать `tick()`.
 * - `dispose()` — освободить эти же ресурсы, если регистрация была ОТМЕНЕНА
 *   (`unregister()`/`stopAll()` пришли ПОКА `initialize()` ещё выполнялся, ДО
 *   того как стратегия стала ACTIVE). Стратегия в этот момент НЕ имеет
 *   безопасного execution context (routing/heartbeat никогда не создавались)
 *   — `dispose()` НЕ возвращает торговые intents, только освобождает ресурсы.
 * - `stop()` — штатная остановка УЖЕ ACTIVE стратегии: возвращает
 *   CANCEL/CANCEL_ALL для отмены открытых ордеров. Не вызывается, если
 *   регистрация была отменена до публикации (в этом случае вызывается
 *   `dispose()` вместо `stop()`).
 *
 * @example
 * ```typescript
 * class SimpleQuoter implements IStrategy {
 *   readonly id = 'simple-quoter-1';
 *   readonly name = 'SimpleQuoter';
 *   private _tickCount = 0;
 *
 *   async initialize(): Promise<Result<void, Error>> {
 *     // Без подписок — стратегия работает через tick()
 *     return Ok(undefined);
 *   }
 *
 *   async dispose(): Promise<Result<void, Error>> {
 *     // Нечего освобождать — initialize() ничего не открывал
 *     return Ok(undefined);
 *   }
 *
 *   tick(snapshot: StrategySnapshot, reasons: ReadonlySet<TriggerReason>): StrategyIntent[] {
 *     this._tickCount++;
 *     const { topOfBook, portfolio } = snapshot;
 *     if (!topOfBook || !portfolio) return [];
 *
 *     return [
 *       { type: 'CANCEL_ALL' },
 *       { type: 'PLACE', side: 'BUY', price: topOfBook.bestBid, size: Quantity.of(new Decimal('10')) },
 *     ];
 *   }
 *
 *   stop(): StrategyStopIntent[] {
 *     return [{ type: 'CANCEL_ALL' }];
 *   }
 *
 *   getMetrics() {
 *     return { tickCount: this._tickCount };
 *   }
 * }
 * ```
 */
import type { Result } from '@polymarket/result';
import type { StrategySnapshot } from './types/StrategySnapshot.js';
import type { StrategyIntent, StrategyStopIntent } from './types/StrategyIntent.js';
import type { TriggerReason } from './types/TriggerReason.js';

/**
 * Интерфейс торговой стратегии.
 *
 * @remarks
 * Реализуется пользовательскими стратегиями.
 * StrategyScheduler управляет жизненным циклом и вызывает tick().
 */
export interface IStrategy {
  /**
   * Уникальный идентификатор стратегии.
   *
   * @remarks
   * Используется для трекинга в StrategyScheduler,
   * маршрутизации dirty flags и изоляции ордеров.
   */
  readonly id: string;

  /**
   * Человекочитаемое имя стратегии (для логирования).
   */
  readonly name: string;

  /**
   * Однократная инициализация.
   *
   * @returns `Ok(undefined)` при успехе или `Err(Error)` при ошибке
   *
   * @remarks
   * Вызывается один раз при `StrategyScheduler.register()`.
   * Без подписок на events — стратегия работает через tick().
   * Используется для загрузки конфигурации, подключения к внешним сервисам и т.п.
   *
   * Если `initialize()` вернул `Err`, StrategyScheduler:
   * - НЕ регистрирует стратегию
   * - Возвращает ошибку вызывающей стороне
   */
  initialize(): Promise<Result<void, Error>>;

  /**
   * Освобождает ресурсы, открытые в `initialize()`, если регистрация была
   * отменена ДО того, как стратегия стала ACTIVE.
   *
   * @returns `Ok(undefined)` при успехе или `Err(Error)` при ошибке
   *
   * @remarks
   * Вызывается `StrategyScheduler` ТОЛЬКО когда:
   * - `initialize()` вернул `Ok` (успешно открыл ресурсы), И
   * - `unregister()`/`stopAll()` пришли ПОКА регистрация ещё обрабатывалась
   *   (стратегия никогда не публиковалась как ACTIVE entry).
   *
   * НЕ вызывается, если `initialize()` вернул `Err` или бросил — в этом
   * случае предполагается, что ресурсы не были успешно открыты.
   * НЕ вызывается для уже ACTIVE стратегий — для них используется `stop()`.
   *
   * В отличие от `stop()`, `dispose()`:
   * - НЕ возвращает `StrategyIntent[]` — у стратегии на этом этапе нет
   *   безопасного execution context (routing/heartbeat не создавались);
   * - НЕ должен размещать или отменять ордера;
   * - должен быть безопасен для вызова ровно один раз после успешного
   *   `initialize()` (scheduler вызывает его не более одного раза на
   *   попытку регистрации).
   */
  dispose(): Promise<Result<void, Error>>;

  /**
   * Один цикл: данные → решение → намерения.
   *
   * @param snapshot - Readonly snapshot состояния (market data, orders, portfolio, timing)
   * @param reasons - Что изменилось с последнего tick (BOOK, TRADE, FILL, ...)
   * @returns Массив намерений (PLACE, CANCEL, CANCEL_ALL) или [] (ничего не делать)
   *
   * @remarks
   * **СИНХРОННЫЙ.** Scheduler вызывает, передаёт готовый snapshot.
   * Стратегия не делает async calls — только чтение из snapshot и логика.
   *
   * Возвращённые intents передаются в ExecutionEngine для нормализации
   * (dedupe) и исполнения.
   */
  tick(snapshot: StrategySnapshot, reasons: ReadonlySet<TriggerReason>): StrategyIntent[];

  /**
   * Cleanup. Возвращает финальные intents.
   *
   * @returns Финальные intents (обычно `[{ type: 'CANCEL_ALL' }]`)
   *
   * @remarks
   * Вызывается при:
   * - Явном запросе: `StrategyScheduler.unregister(strategyId)`
   * - Срабатывании риск-лимита: `scheduler.onRiskBreached()`
   * - Системной остановке: `scheduler.stopAll()`
   *
   * Возвращённые intents исполняются ExecutionEngine перед удалением стратегии.
   *
   * `stop()` прекращает активность и отменяет ордера. `stop()` НЕ предназначен
   * для liquidation PLACE или новых торговых операций — возвращаемый тип
   * ограничен CANCEL/CANCEL_ALL на уровне компиляции; `StrategyScheduler`
   * дополнительно проверяет это в рантайме (стратегия может прийти из JS или
   * использовать unsafe casts) и блокирует ВЕСЬ final batch, если обнаружит
   * PLACE.
   */
  stop(): StrategyStopIntent[];

  /**
   * Текущие метрики стратегии.
   *
   * @returns Объект с метриками (формат на усмотрение стратегии)
   *
   * @remarks
   * Должен быть безопасен для частых вызовов и не изменять состояние.
   */
  getMetrics(): Record<string, unknown>;
}
