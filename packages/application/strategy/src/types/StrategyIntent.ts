/**
 * Декларативное намерение стратегии.
 *
 * @remarks
 * Стратегия не вызывает API напрямую — она возвращает массив intents из tick().
 * ExecutionEngine нормализует (dedupe), сортирует и исполняет их:
 * 1. CANCEL_ALL → удаляет все отдельные CANCEL (дублирование)
 * 2. Dedupe CANCEL по orderId
 * 3. Cancels параллельно, places последовательно
 *
 * AMEND не поддерживается: Polymarket не имеет атомарного amend.
 * Стратегия сама решает когда отменить старый и разместить новый ордер
 * через два отдельных intenta (CANCEL + PLACE).
 *
 * @example
 * ```typescript
 * // Стратегия возвращает из tick():
 * const intents: StrategyIntent[] = [
 *   { type: 'CANCEL_ALL' },
 *   { type: 'PLACE', side: 'BUY', price: Price.of(new Decimal('0.55')), size: Quantity.of(new Decimal('100')) },
 *   { type: 'PLACE', side: 'SELL', price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')) },
 * ];
 * ```
 */
import type { OrderId, InstrumentId, AssetId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';

/**
 * Декларативное намерение стратегии — PLACE, CANCEL или CANCEL_ALL.
 *
 * @remarks
 * Подробное описание нормализации/исполнения — см. TSDoc модуля в начале
 * файла.
 */
export type StrategyIntent =
  | PlaceIntent
  | CancelIntent
  | CancelAllIntent;

/**
 * Общие поля намерения разместить новый ордер.
 *
 * @remarks
 * ExecutionEngine генерирует orderId, привязывает strategyId и instrumentId
 * из ExecutionContext, затем вызывает PlaceOrderUseCase.
 * Risk check — внутри PlaceOrderUseCase (не дублируем).
 */
export interface BasePlaceIntent {
  readonly type: 'PLACE';
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  /** true = post-only order; exchange must reject if order would execute immediately */
  readonly postOnly?: boolean;
}

/**
 * Намерение разместить новый ордер.
 *
 * @remarks
 * ### Атомарная пара target instrument + asset:
 * `targetInstrumentId` и `targetAsset` — discriminated union: либо ОБА поля
 * заданы (auto-selection на комплементарный инструмент), либо НИ ОДНО
 * (ордер идёт на основной instrumentId/asset из ExecutionContext).
 * Compile-time исключает рассинхрон «target instrument + primary asset»,
 * который отправлял ордер на чужой CTF токен.
 *
 * ExecutionEngine дополнительно выполняет fail-closed runtime-валидацию пары
 * (catalog lookup, соответствие asset ↔ instrument, разрешённость target
 * текущей регистрацией стратегии).
 *
 * @example
 * ```typescript
 * // Основной инструмент (пара отсутствует целиком):
 * const primary: PlaceIntent = { type: 'PLACE', side: 'BUY', price, size };
 *
 * // Комплементарный инструмент (пара присутствует целиком):
 * const comp: PlaceIntent = {
 *   type: 'PLACE', side: 'BUY', price, size,
 *   targetInstrumentId: complementaryInstrumentId,
 *   targetAsset: complementaryAsset,
 * };
 * ```
 */
export type PlaceIntent =
  | (BasePlaceIntent & {
      readonly targetInstrumentId?: never;
      readonly targetAsset?: never;
    })
  | (BasePlaceIntent & {
      /** Целевой инструмент для размещения (auto-selection). */
      readonly targetInstrumentId: InstrumentId;
      /** Торговый актив целевого инструмента (обязателен вместе с targetInstrumentId). */
      readonly targetAsset: AssetId;
    });

/**
 * Собирает атомарную пару target-полей для {@link PlaceIntent}.
 *
 * @param instrumentId - Целевой инструмент (или undefined)
 * @param asset - Целевой актив (или undefined)
 * @returns Пара `{ targetInstrumentId, targetAsset }`, если заданы ОБА поля;
 *   `undefined` — если не задано ни одно
 * @throws {Error} Если задано ровно одно поле из пары (программная ошибка
 *   стратегии — fail-fast вместо тихой подмены asset)
 *
 * @remarks
 * Helper для стратегий, у которых target-поля опциональны в domain actions:
 * вместо независимых спредов (`...(a ? { targetInstrumentId: a } : {})`),
 * которые не проходят compile-time union, собирает пару целиком.
 *
 * @example
 * ```typescript
 * const target = placeTarget(data.complementaryInstrumentId, data.complementaryAsset);
 * const intent: PlaceIntent = target
 *   ? { type: 'PLACE', side, price, size, ...target }
 *   : { type: 'PLACE', side, price, size };
 * ```
 */
export function placeTarget(
  instrumentId: InstrumentId | undefined,
  asset: AssetId | undefined,
): { readonly targetInstrumentId: InstrumentId; readonly targetAsset: AssetId } | undefined {
  if (instrumentId === undefined && asset === undefined) return undefined;
  if (instrumentId === undefined || asset === undefined) {
    throw new Error(
      'placeTarget: targetInstrumentId and targetAsset must be provided together (atomic pair)',
    );
  }
  return { targetInstrumentId: instrumentId, targetAsset: asset };
}

/**
 * Намерение отменить конкретный ордер.
 *
 * @remarks
 * ExecutionEngine вызывает CancelOrderUseCase(orderId).
 * Если CANCEL_ALL уже есть в batch — отдельные CANCEL удаляются при нормализации.
 */
export interface CancelIntent {
  readonly type: 'CANCEL';
  readonly orderId: OrderId;
}

/**
 * Намерение отменить все открытые ордера стратегии.
 *
 * @remarks
 * ExecutionEngine получает список из OrderStateStore и отменяет каждый.
 * При нормализации: если CANCEL_ALL присутствует, все отдельные CANCEL удаляются.
 */
export interface CancelAllIntent {
  readonly type: 'CANCEL_ALL';
}

/**
 * Намерения, допустимые в качестве возврата {@link IStrategy.stop}.
 *
 * @remarks
 * `stop()` прекращает активность и отменяет ордера — он НЕ предназначен для
 * liquidation PLACE или размещения новых торговых ордеров. Compile-time
 * ограничивает возврат `stop()` только CANCEL/CANCEL_ALL; `StrategyScheduler`
 * дополнительно валидирует это в рантайме (fail-closed), поскольку стратегия
 * может прийти из JavaScript или использовать unsafe casts — PLACE в
 * `stop()` блокирует ВЕСЬ final batch и возвращает typed `UNSAFE_FINAL_INTENT`.
 */
export type StrategyStopIntent = CancelIntent | CancelAllIntent;
