/**
 * BaseStrategy — опциональный абстрактный класс с gather → decide → toIntents pipeline.
 *
 * @remarks
 * ### Pipeline:
 * 1. `gather(snapshot)` — извлечь типизированные данные из generic StrategySnapshot.
 *    Вернуть `undefined` если данных недостаточно (tick вернёт []).
 * 2. `decide(data, reasons)` — чистая логика: данные → domain-specific actions.
 *    Легко unit-тестировать — нет зависимостей от инфраструктуры.
 * 3. `toIntents(actions)` — конвертировать domain actions в StrategyIntent[].
 *
 * ### Типовые параметры:
 * - `TSnapshot` — типизированный snapshot для конкретной стратегии
 * - `TAction` — domain-specific actions (enum/union для конкретной стратегии)
 *
 * ### Дефолтное поведение:
 * - `initialize()` — Ok(undefined) (noop)
 * - `stop()` — [{ type: 'CANCEL_ALL' }] (отменить все ордера)
 * - `getMetrics()` — {} (пустой)
 *
 * @example
 * ```typescript
 * interface MakerData {
 *   bestBid: Price;
 *   bestAsk: Price;
 *   position: IPosition | undefined;
 *   availableUSDC: Money;
 * }
 *
 * type MakerAction = 'QUOTE_BID' | 'QUOTE_ASK' | 'CANCEL_ALL';
 *
 * class SimpleMarketMaker extends BaseStrategy<MakerData, MakerAction> {
 *   readonly id = 'mm-1';
 *   readonly name = 'SimpleMarketMaker';
 *
 *   protected gather(snapshot: StrategySnapshot): MakerData | undefined {
 *     if (!snapshot.topOfBook || !snapshot.portfolio) return undefined;
 *     return {
 *       bestBid: snapshot.topOfBook.bestBid,
 *       bestAsk: snapshot.topOfBook.bestAsk,
 *       position: snapshot.portfolio.getPosition(snapshot.instrumentId),
 *       availableUSDC: snapshot.portfolio.balance.available(),
 *     };
 *   }
 *
 *   protected decide(data: MakerData): MakerAction[] {
 *     return ['QUOTE_BID', 'QUOTE_ASK'];
 *   }
 *
 *   protected toIntents(actions: MakerAction[]): StrategyIntent[] {
 *     // ...конвертация в PLACE/CANCEL intents
 *     return [];
 *   }
 * }
 * ```
 */
import { Ok } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import type { IStrategy } from './IStrategy.js';
import type { StrategySnapshot } from './types/StrategySnapshot.js';
import type { StrategyIntent } from './types/StrategyIntent.js';
import type { TriggerReason } from './types/TriggerReason.js';

export abstract class BaseStrategy<TSnapshot, TAction> implements IStrategy {
  abstract readonly id: string;
  abstract readonly name: string;

  /**
   * Извлечь типизированный snapshot из generic StrategySnapshot.
   *
   * @param snapshot - Generic snapshot от scheduler
   * @returns Типизированные данные или undefined если данных недостаточно
   *
   * @remarks
   * Если вернул `undefined` — tick() вернёт пустой массив intents.
   * Типичная проверка: topOfBook, portfolio не undefined.
   */
  protected abstract gather(snapshot: StrategySnapshot): TSnapshot | undefined;

  /**
   * Чистая логика: данные + reasons → domain-specific actions.
   *
   * @param data - Типизированные данные из gather()
   * @param reasons - Что изменилось с последнего tick
   * @returns Массив domain-specific actions
   *
   * @remarks
   * Чистая функция — легко unit-тестировать.
   * Нет зависимостей от инфраструктуры — только данные и логика.
   */
  protected abstract decide(data: TSnapshot, reasons: ReadonlySet<TriggerReason>): TAction[];

  /**
   * Конвертировать domain actions в StrategyIntent[].
   *
   * @param actions - Domain-specific actions из decide()
   * @returns Массив StrategyIntent для ExecutionEngine
   */
  protected abstract toIntents(actions: TAction[]): StrategyIntent[];

  /**
   * Pipeline: gather → decide → toIntents.
   *
   * @param snapshot - Readonly snapshot состояния
   * @param reasons - Что изменилось с последнего tick
   * @returns StrategyIntent[] или [] если данных нет или решение пустое
   */
  public tick(snapshot: StrategySnapshot, reasons: ReadonlySet<TriggerReason>): StrategyIntent[] {
    const data = this.gather(snapshot);
    if (data === undefined) return [];

    const actions = this.decide(data, reasons);
    if (actions.length === 0) return [];

    return this.toIntents(actions);
  }

  /**
   * Инициализация по умолчанию — noop.
   *
   * @returns Ok(undefined)
   *
   * @remarks
   * Переопределите если нужна загрузка конфигурации или подключение к внешним сервисам.
   */
  public async initialize(): Promise<Result<void, Error>> {
    return Ok(undefined);
  }

  /**
   * Остановка по умолчанию — отменить все ордера.
   *
   * @returns [{ type: 'CANCEL_ALL' }]
   *
   * @remarks
   * Переопределите если нужна другая логика остановки
   * (например, ликвидация позиции вместо простой отмены).
   */
  public stop(): StrategyIntent[] {
    return [{ type: 'CANCEL_ALL' }];
  }

  /**
   * Метрики по умолчанию — пустой объект.
   *
   * @returns {}
   */
  public getMetrics(): Record<string, unknown> {
    return {};
  }
}
