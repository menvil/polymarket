/**
 * Математика исполнений — приватный модуль пакета
 *
 * @remarks
 * Не экспортируется из index.ts.
 * Содержит всю арифметику fill-состояния:
 * - addFill: добавить исполнение с валидацией
 * - isFull: заявка полностью исполнена
 * - emptyFill: начальное состояние
 * - VWAP: взвешенная средняя цена
 */

import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { Quantity, Price } from '@polymarket/value-objects';
import type { FillState, FillData } from './OrderState.js';
import { TradingError } from '@polymarket/errors';

/**
 * Порог «пыли» для определения полного исполнения.
 *
 * @remarks
 * Polymarket CLOB округляет fill size до 2 знаков после запятой.
 * Если ордер на 5.071832064 → fill приходит на 5.07.
 * Остаток 0.001832064 меньше минимального размера ордера (0.01).
 * Без dust threshold ордер навсегда застревает в PARTIALLY_FILLED.
 */
const DUST_THRESHOLD = new Decimal('0.01');

/**
 * Создаёт пустое fill-состояние для новой заявки
 */
export function emptyFill(): FillState {
  return {
    filledSize: Quantity.ZERO,
    averagePrice: undefined,
    fillIds: [],
  };
}

/**
 * Добавляет исполнение к текущему fill-состоянию
 *
 * @param state - Текущее fill-состояние
 * @param fill - Данные нового исполнения
 * @param orderSize - Полный размер заявки (для проверки превышения)
 * @returns Новое fill-состояние или ошибка
 *
 * @remarks
 * Алгоритм:
 * 1. Проверяет что fillSize > 0
 * 2. Проверяет отсутствие дубликата fillId
 * 3. Проверяет что fillSize <= remainingSize
 * 4. Вычисляет новый filledSize
 * 5. Вычисляет VWAP
 */
export function addFill(
  state: FillState,
  fill: FillData,
  orderSize: Quantity,
): Result<FillState, TradingError> {
  if (fill.size.isZero()) {
    return Err(new TradingError('Fill size must be positive', { context: { fillId: fill.id } }));
  }

  if ((state.fillIds as unknown as string[]).includes(fill.id as string)) {
    return Err(new TradingError(`Duplicate fill id: ${fill.id}`, { context: { fillId: fill.id } }));
  }

  const remaining = orderSize.value().minus(state.filledSize.value());
  if (fill.size.value().gt(remaining)) {
    return Err(new TradingError(
      `Fill size (${fill.size.value()}) exceeds remaining size (${remaining})`,
      { context: { fillId: fill.id } },
    ));
  }

  const newFilledSize = Quantity.of(state.filledSize.value().plus(fill.size.value()));
  const newAvgPrice = _vwap(state.filledSize, state.averagePrice, fill.size, fill.price);

  return Ok({
    filledSize: newFilledSize,
    averagePrice: newAvgPrice,
    fillIds: [...state.fillIds, fill.id],
  });
}

/**
 * Проверяет что заявка полностью исполнена.
 *
 * @remarks
 * Учитывает dust threshold: если остаток (orderSize - filledSize) < DUST_THRESHOLD (0.01),
 * ордер считается полностью исполненным. Это необходимо потому что Polymarket CLOB
 * округляет fill size до 2 знаков после запятой, и остаток может быть меньше
 * минимального размера ордера.
 *
 * @example
 * ```typescript
 * // orderSize = 5.071832064, filledSize = 5.07
 * // remaining = 0.001832064 < 0.01 → true (FILLED)
 * isFull(state, orderSize); // true
 * ```
 */
export function isFull(state: FillState, orderSize: Quantity): boolean {
  if (state.filledSize.equals(orderSize)) return true;
  const remaining = orderSize.value().minus(state.filledSize.value());
  return remaining.gte(0) && remaining.lt(DUST_THRESHOLD);
}

/**
 * Взвешенная средняя цена (VWAP)
 *
 * @remarks
 * Формула: (currentSize * currentAvg + newSize * newPrice) / (currentSize + newSize)
 * Если первое исполнение — возвращает newPrice напрямую.
 */
function _vwap(
  currentSize: Quantity,
  currentAvg: Price | undefined,
  newSize: Quantity,
  newPrice: Price,
): Price {
  if (currentSize.isZero() || !currentAvg) {
    return newPrice;
  }

  const currentNotional = currentSize.value().times(currentAvg.value());
  const newNotional = newSize.value().times(newPrice.value());
  const totalSize = currentSize.value().plus(newSize.value());

  return Price.of(currentNotional.plus(newNotional).dividedBy(totalSize));
}
