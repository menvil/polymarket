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
import Decimal from 'decimal.js';
import type { IStrategy } from './IStrategy.js';
import type { StrategySnapshot } from './types/StrategySnapshot.js';
import type { StrategyIntent, StrategyStopIntent } from './types/StrategyIntent.js';
import type { TriggerReason } from './types/TriggerReason.js';

/**
 * Опциональный базовый класс для стратегий с gather → decide → toIntents pipeline.
 *
 * @remarks
 * Подробное описание pipeline, типовых параметров и дефолтного поведения —
 * см. TSDoc модуля в начале файла.
 */
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
   * Освобождение ресурсов по умолчанию — noop.
   *
   * @returns Ok(undefined)
   *
   * @remarks
   * Переопределите, если `initialize()` открывает НЕторговые ресурсы —
   * `dispose()` вызывается И при отменённой (до публикации) регистрации, И
   * как последний шаг нормальной остановки УЖЕ ACTIVE стратегии (после
   * `stop()`/authoritative post-check, перед удалением entry). См. различие
   * `initialize()`/`stop()`/`dispose()` в {@link IStrategy}.
   */
  public async dispose(): Promise<Result<void, Error>> {
    return Ok(undefined);
  }

  /**
   * Остановка по умолчанию — отменить все ордера.
   *
   * @returns [{ type: 'CANCEL_ALL' }]
   *
   * @remarks
   * Переопределите если нужна другая логика остановки (например, набор
   * точечных CANCEL вместо CANCEL_ALL). `stop()` не предназначен для
   * liquidation PLACE или новых торговых операций — возвращаемый тип
   * ограничен CANCEL/CANCEL_ALL.
   */
  public stop(): StrategyStopIntent[] {
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

  // ── Helpers для учёта ограничений инструмента ───────────

  /**
   * Корректирует размер SELL с учётом minOrderSize.
   *
   * @param desiredSize - Желаемый размер продажи
   * @param positionQty - Текущий размер позиции
   * @param minOrderSize - Минимальный размер ордера из constraints
   * @returns Скорректированный размер
   *
   * @remarks
   * Логика:
   * - Если после продажи остаток < minOrderSize → продать всю позицию.
   *   Иначе остаток «застрянет» — Polymarket отклоняет ордера < minOrderSize.
   * - Если desiredSize < minOrderSize и positionQty >= minOrderSize →
   *   клампировать к minOrderSize.
   * - Если positionQty < minOrderSize → вернуть positionQty
   *   (может быть отклонён биржей, но стратегия решает сама).
   *
   * @example
   * ```typescript
   * // positionQty=9, desired=5, minOrderSize=5 → остаток 4<5 → продаём 9
   * adjustSellSize(5, 9, 5) // → 9
   *
   * // positionQty=15, desired=5, minOrderSize=5 → остаток 10>=5 → продаём 5
   * adjustSellSize(5, 15, 5) // → 5
   *
   * // positionQty=4, desired=4, minOrderSize=5 → positionQty<minOrderSize → 4
   * adjustSellSize(4, 4, 5) // → 4
   * ```
   */
  protected adjustSellSize(desiredSize: Decimal, positionQty: Decimal, minOrderSize: Decimal): Decimal {
    // Позиция слишком мала для любого валидного SELL — возвращаем как есть
    if (positionQty.lt(minOrderSize)) {
      return positionQty;
    }

    // Клампируем вверх если desired < minOrderSize
    const effectiveSize = Decimal.max(desiredSize, minOrderSize);

    // Ограничиваем позицией
    const clamped = Decimal.min(effectiveSize, positionQty);

    // Если после продажи остаток < minOrderSize — продать всё
    const remainder = positionQty.minus(clamped);
    if (remainder.gt(0) && remainder.lt(minOrderSize)) {
      return positionQty;
    }

    return clamped;
  }

  /**
   * Проверяет размер BUY против minOrderSize и minOrderValue (честный контракт).
   *
   * @param desiredSize - Желаемый размер покупки
   * @param price - Цена ордера (USDC за токен)
   * @param minOrderValue - Минимальная стоимость ордера в USDC (notional)
   * @param minOrderSize - Минимальный размер ордера в токенах
   * @returns `desiredSize`, если он проходит ОБА ограничения; `undefined`,
   *   если ордер невозможен без увеличения размера (overbuy запрещён)
   *
   * @remarks
   * Helper НИКОГДА не увеличивает размер молча:
   * 1. `desiredSize < minOrderSize` → `undefined` (клампирование вверх
   *    покупало бы больше конфигурации стратегии);
   * 2. `price × desiredSize < minOrderValue` → `undefined` (то же самое);
   * 3. Иначе → `desiredSize` без изменений.
   *
   * Если стратегии нужен явный opt-in overbuy до venue-минимумов —
   * используйте {@link BaseStrategy.adjustBuySizeAllowingIncrease}.
   *
   * Fail-closed на некорректном вводе: `NaN`/`Infinity`/не-finite значения
   * любого аргумента, либо отрицательные `minOrderValue`/`minOrderSize`,
   * возвращают `undefined` — так же, как и нарушение размерных ограничений.
   * Никогда не создаёт `Decimal` из `number` там, где на входе уже `Decimal`.
   *
   * @example
   * ```typescript
   * // desired=5, price=0.55, minOrderValue=1, minOrderSize=5 → 5 (валиден)
   * adjustBuySize(new Decimal(5), new Decimal('0.55'), new Decimal(1), new Decimal(5))
   *
   * // desired=3 < minOrderSize=5 → undefined (не overbuy до 5)
   * adjustBuySize(new Decimal(3), new Decimal('0.55'), new Decimal(1), new Decimal(5))
   *
   * // price=0.11, desired=5 → notional 0.55 < minOrderValue=1 → undefined
   * adjustBuySize(new Decimal(5), new Decimal('0.11'), new Decimal(1), new Decimal(5))
   *
   * // price=NaN → undefined (fail-closed на некорректном вводе)
   * adjustBuySize(new Decimal(5), new Decimal(NaN), new Decimal(1), new Decimal(5))
   * ```
   */
  protected adjustBuySize(
    desiredSize: Decimal,
    price: Decimal,
    minOrderValue: Decimal,
    minOrderSize: Decimal,
  ): Decimal | undefined {
    if (
      !desiredSize.isFinite() ||
      !price.isFinite() ||
      !minOrderValue.isFinite() ||
      !minOrderSize.isFinite()
    ) {
      return undefined;
    }
    if (!desiredSize.gt(0) || !price.gt(0) || minOrderValue.lt(0) || minOrderSize.lt(0)) return undefined;
    if (desiredSize.lt(minOrderSize)) return undefined;
    if (price.mul(desiredSize).lt(minOrderValue)) return undefined;
    return desiredSize;
  }

  /**
   * Увеличивает размер BUY до venue-минимумов (ЯВНЫЙ opt-in overbuy).
   *
   * @param desiredSize - Желаемый размер покупки
   * @param price - Цена ордера (USDC за токен)
   * @param minOrderValue - Минимальная стоимость ордера в USDC (notional)
   * @param minOrderSize - Минимальный размер ордера в токенах
   * @returns Минимальный размер >= desiredSize, удовлетворяющий обоим
   *   ограничениям; `undefined` если desiredSize <= 0, price <= 0, любой
   *   аргумент non-finite, либо minOrderValue/minOrderSize отрицательны
   *
   * @remarks
   * В отличие от {@link BaseStrategy.adjustBuySize} МОЖЕТ вернуть размер
   * БОЛЬШЕ desiredSize (покупка сверх конфигурации стратегии) — вызывающая
   * стратегия обязана осознанно допускать overbuy. Размер под minOrderValue
   * округляется вверх до 2 знаков (шаг размера Polymarket).
   * Fail-closed на некорректном вводе — те же правила, что и у
   * {@link BaseStrategy.adjustBuySize}.
   *
   * @example
   * ```typescript
   * // desired=3, minOrderSize=5 → 5 (overbuy разрешён явно)
   * adjustBuySizeAllowingIncrease(new Decimal(3), new Decimal('0.55'), new Decimal(1), new Decimal(5))
   * ```
   */
  protected adjustBuySizeAllowingIncrease(
    desiredSize: Decimal,
    price: Decimal,
    minOrderValue: Decimal,
    minOrderSize: Decimal,
  ): Decimal | undefined {
    if (
      !desiredSize.isFinite() ||
      !price.isFinite() ||
      !minOrderValue.isFinite() ||
      !minOrderSize.isFinite()
    ) {
      return undefined;
    }
    if (!desiredSize.gt(0) || !price.gt(0) || minOrderValue.lt(0) || minOrderSize.lt(0)) return undefined;
    let size = Decimal.max(desiredSize, minOrderSize);
    if (price.mul(size).lt(minOrderValue)) {
      size = Decimal.max(size, minOrderValue.div(price).toDecimalPlaces(2, Decimal.ROUND_UP));
    }
    return size;
  }
}
