/**
 * Чистые вычисления для закрытия лотов позиции
 *
 * @remarks
 * Этот модуль содержит только pure функции без зависимости от Position.
 * Это исключает циклические зависимости и упрощает тестирование.
 *
 * ### Dependency graph:
 * ```
 * lot-closing.ts → PositionLot.ts, value-objects   (НЕТ импорта Position)
 * Position.ts    → lot-closing.ts
 * fifo-lifo.ts   → Position.ts
 * ```
 *
 * @example
 * ```typescript
 * import { computeClose } from './lot-closing';
 *
 * const result = computeClose(lots, 'LONG', closeQuantity, closePrice);
 * if (result.ok) {
 *   const { remainingLots, totalRealizedPnL, closedLots } = result.value;
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import { Quantity, OutcomePrice } from '@polymarket/value-objects';
import { SignedQuantity } from '@polymarket/value-objects/signed-quantity';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import { PositionLot } from '../core/PositionLot.js';

/**
 * Информация о закрытом лоте
 *
 * @remarks
 * Используется для аудита и отчётности при закрытии позиции.
 */
export interface ClosedLotInfo {
  readonly lot: PositionLot;
  readonly closedQuantity: Quantity;
  readonly closePrice: OutcomePrice;
  readonly pnl: SignedQuantity;
}

/**
 * Результат вычисления закрытия лотов (pure computation)
 *
 * @remarks
 * Содержит итог вычисления без ссылки на Position.
 * Position создаёт новый экземпляр самостоятельно через applyClose().
 */
export interface LotCloseComputation {
  readonly remainingLots: readonly PositionLot[];
  readonly totalRealizedPnL: Decimal;
  readonly closedLots: readonly ClosedLotInfo[];
}

/**
 * Вычисляет закрытие лотов в переданном порядке (caller решает FIFO/LIFO)
 *
 * @param orderedLots - Лоты в порядке закрытия (FIFO = ASC, LIFO = DESC по timestamp)
 * @param side - Сторона позиции ('LONG' | 'SHORT')
 * @param closeQuantity - Количество для закрытия
 * @param closePrice - Цена закрытия
 * @returns Result с LotCloseComputation или ValidationError
 *
 * @remarks
 * ### Алгоритм:
 * 1. Валидация: closeQuantity > 0, lots.length > 0, closeQuantity <= sum(lots)
 * 2. Итерация по лотам в переданном порядке
 * 3. Полное или частичное закрытие каждого лота
 * 4. Возврат remainingLots и totalRealizedPnL
 *
 * ### Валидации:
 * - closeQuantity > 0 (положительное)
 * - lots.length > 0 (есть лоты)
 * - closeQuantity <= sum(lots) (не превышает доступное)
 *
 * @throws Не бросает — возвращает Result<LotCloseComputation, ValidationError>
 *
 * @example
 * ```typescript
 * // FIFO: передаём лоты в порядке ASC (старые первые)
 * const result = computeClose(position.lots, 'LONG', closeQty, closePrice);
 *
 * // LIFO: передаём лоты в порядке DESC (новые первые)
 * const reversed = [...position.lots].reverse();
 * const result = computeClose(reversed, 'LONG', closeQty, closePrice);
 * ```
 */
export function computeClose(
  orderedLots: readonly PositionLot[],
  side: 'LONG' | 'SHORT',
  closeQuantity: Quantity,
  closePrice: OutcomePrice
): Result<LotCloseComputation, ValidationError> {
  // Валидация 1: closeQuantity > 0
  if (closeQuantity.isZero() || closeQuantity.value().isNegative()) {
    return Err(
      new ValidationError('Close quantity must be positive', {
        context: { closeQuantity: closeQuantity.value().toString() },
      })
    );
  }

  // Валидация 2: есть лоты
  if (orderedLots.length === 0) {
    return Err(
      new ValidationError('Position has no lots to close', {
        context: {},
      })
    );
  }

  // Валидация 3: closeQuantity <= sum(lots)
  const totalLotsQty = orderedLots.reduce(
    (sum, lot) => sum.plus(lot.quantity.value()),
    new Decimal(0)
  );
  if (closeQuantity.value().gt(totalLotsQty)) {
    return Err(
      new ValidationError('Close quantity exceeds position quantity', {
        context: {
          closeQuantity: closeQuantity.value().toString(),
          positionQuantity: totalLotsQty.toString(),
        },
      })
    );
  }

  let remaining = closeQuantity.value();
  let totalRealizedPnL = new Decimal(0);
  const newLots: PositionLot[] = [];
  const closedLots: ClosedLotInfo[] = [];

  for (const lot of orderedLots) {
    // Если уже закрыли нужное количество — лот остаётся без изменений
    if (remaining.isZero()) {
      newLots.push(lot);
      continue;
    }

    const lotSize = lot.quantity.value();

    if (lotSize.lte(remaining)) {
      // Случай 1: закрываем лот полностью
      const pnl = calculateLotPnL(lot, lot.quantity, closePrice, side);
      totalRealizedPnL = totalRealizedPnL.plus(pnl);
      remaining = remaining.minus(lotSize);

      closedLots.push({
        lot,
        closedQuantity: lot.quantity,
        closePrice,
        pnl: SignedQuantity.of(pnl),
      });
    } else {
      // Случай 2: частичное закрытие лота
      const closedPart = Quantity.of(remaining);
      const pnl = calculateLotPnL(lot, closedPart, closePrice, side);
      totalRealizedPnL = totalRealizedPnL.plus(pnl);

      closedLots.push({
        lot,
        closedQuantity: closedPart,
        closePrice,
        pnl: SignedQuantity.of(pnl),
      });

      const remainingLotQty = lotSize.minus(remaining);
      newLots.push(lot.withQuantity(Quantity.of(remainingLotQty)));
      remaining = new Decimal(0);
    }
  }

  return Ok({
    remainingLots: newLots,
    totalRealizedPnL,
    closedLots,
  });
}

/**
 * Вычисляет weighted average entry price для массива лотов
 *
 * @param lots - Массив лотов
 * @returns Weighted average price или OutcomePrice.MIN для пустого массива
 *
 * @remarks
 * Формула: sum(lot.entryPrice * lot.quantity) / sum(lot.quantity)
 * Использует Decimal для точности промежуточных вычислений.
 *
 * @example
 * ```typescript
 * import Decimal from 'decimal.js';
 *
 * const lots = [
 *   PositionLot.create({ quantity: Quantity.of(new Decimal(50)), entryPrice: OutcomePrice.of(new Decimal(0.60)), timestamp }),
 *   PositionLot.create({ quantity: Quantity.of(new Decimal(50)), entryPrice: OutcomePrice.of(new Decimal(0.70)), timestamp }),
 * ];
 *
 * const avgPrice = calculateWeightedAveragePrice(lots);
 * console.log(avgPrice.value().toNumber()); // 0.65
 * ```
 */
export function calculateWeightedAveragePrice(lots: readonly PositionLot[]): OutcomePrice {
  if (lots.length === 0) {
    return OutcomePrice.MIN;
  }

  let totalNotional = new Decimal(0);
  let totalQuantity = new Decimal(0);

  for (const lot of lots) {
    totalNotional = totalNotional.plus(lot.getNotional());
    totalQuantity = totalQuantity.plus(lot.quantity.value());
  }

  if (totalQuantity.isZero()) {
    return OutcomePrice.MIN;
  }

  return OutcomePrice.of(totalNotional.dividedBy(totalQuantity));
}

/**
 * Рассчитывает P&L для лота
 *
 * @param lot - Лот позиции
 * @param closedQuantity - Закрываемое количество
 * @param closePrice - Цена закрытия
 * @param side - Сторона позиции
 * @returns P&L как Decimal (может быть отрицательным)
 *
 * @remarks
 * Формула:
 * - LONG: (closePrice - entryPrice) * closedQuantity
 * - SHORT: (entryPrice - closePrice) * closedQuantity
 *
 * @internal
 */
function calculateLotPnL(
  lot: PositionLot,
  closedQuantity: Quantity,
  closePrice: OutcomePrice,
  side: 'LONG' | 'SHORT'
): Decimal {
  const priceDiff = closePrice.value().minus(lot.entryPrice.value());
  const pnl = priceDiff.times(closedQuantity.value());
  return side === 'LONG' ? pnl : pnl.negated();
}
