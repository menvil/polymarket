/**
 * FIFO/LIFO алгоритмы для управления лотами позиций
 *
 * @remarks
 * Эти алгоритмы определяют какие лоты закрываются первыми
 * при частичном закрытии позиции, что влияет на расчет realized P&L.
 *
 * ### FIFO (First-In-First-Out)
 * - Закрывает самые старые лоты первыми
 * - Более консервативный подход
 * - Соответствует бухгалтерским стандартам
 *
 * ### LIFO (Last-In-First-Out)
 * - Закрывает самые новые лоты первыми
 * - Более агрессивный подход
 * - Может влиять на налогообложение
 *
 * @example
 * ```typescript
 * import { closeFIFO, closeLIFO } from './algorithms/fifo-lifo';
 *
 * const result = closeFIFO(position, closeQuantity, closePrice);
 * if (result.ok) {
 *   const { newPosition, realizedPnL } = result.value();
 *   console.log('Realized P&L:', realizedPnL.value().toNumber());
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import { Quantity, Price } from '@polymarket/value-objects';
import { SignedQuantity } from '@polymarket/value-objects/signed-quantity';
import Decimal from 'decimal.js';
import { Position } from '../Position.js';
import { PositionLot } from '../core/PositionLot.js';

/**
 * Результат закрытия позиции
 *
 * @remarks
 * Содержит новую позицию после закрытия и реализованный P&L.
 */
export interface CloseResult {
  readonly newPosition: Position;
  readonly realizedPnL: SignedQuantity;
  readonly closedLots: readonly ClosedLotInfo[];
}

/**
 * Информация о закрытом лоте
 *
 * @remarks
 * Используется для аудита и отчетности.
 */
export interface ClosedLotInfo {
  readonly lot: PositionLot;
  readonly closedQuantity: Quantity;
  readonly closePrice: Price;
  readonly pnl: SignedQuantity;
}

/**
 * Закрывает позицию используя FIFO алгоритм
 *
 * @param position - Позиция для закрытия
 * @param closeQuantity - Количество для закрытия
 * @param closePrice - Цена закрытия
 * @returns Result с новой позицией и realized P&L
 *
 * @remarks
 * FIFO (First-In-First-Out) закрывает самые старые лоты первыми.
 *
 * ### Алгоритм:
 * 1. Сортирует лоты по timestamp (старые первые)
 * 2. Закрывает лоты по порядку до исчерпания closeQuantity
 * 3. Рассчитывает realized P&L для каждого закрытого лота
 * 4. Создает новую позицию с обновленными лотами и quantity
 *
 * ### Валидации:
 * - closeQuantity должен быть > 0
 * - closeQuantity не должен превышать position.quantity
 * - position должна иметь лоты
 *
 * @example
 * ```typescript
 * // Позиция с 3 лотами:
 * // Lot 1: 50 @ 0.60 (timestamp: 100)
 * // Lot 2: 30 @ 0.65 (timestamp: 200)
 * // Lot 3: 20 @ 0.70 (timestamp: 300)
 *
 * const closeQty = Quantity.of(new Decimal(60));
 * const closePrice = Price.of(new Decimal(0.75));
 *
 * const result = closeFIFO(position, closeQty, closePrice);
 * if (result.ok) {
 *   const { newPosition, realizedPnL } = result.value();
 *   // Закроются: Lot 1 полностью (50) + 10 из Lot 2
 *   // Realized P&L: (0.75 - 0.60) * 50 + (0.75 - 0.65) * 10 = 8.5
 * }
 * ```
 */
export function closeFIFO(
  position: Position,
  closeQuantity: Quantity,
  closePrice: Price
): Result<CloseResult, ValidationError> {
  // Валидация входных параметров
  const validation = validateCloseParams(position, closeQuantity);
  if (!validation.ok) {
    return Err(validation.error);
  }

  // Сортируем лоты по timestamp (старые первые)
  const sortedLots = [...position.lots].sort((a, b) =>
    a.timestamp.toNumber() - b.timestamp.toNumber()
  );

  // Закрываем лоты по алгоритму FIFO
  return closeLots(position, sortedLots, closeQuantity, closePrice);
}

/**
 * Закрывает позицию используя LIFO алгоритм
 *
 * @param position - Позиция для закрытия
 * @param closeQuantity - Количество для закрытия
 * @param closePrice - Цена закрытия
 * @returns Result с новой позицией и realized P&L
 *
 * @remarks
 * LIFO (Last-In-First-Out) закрывает самые новые лоты первыми.
 *
 * ### Алгоритм:
 * 1. Сортирует лоты по timestamp (новые первые)
 * 2. Закрывает лоты по порядку до исчерпания closeQuantity
 * 3. Рассчитывает realized P&L для каждого закрытого лота
 * 4. Создает новую позицию с обновленными лотами и quantity
 *
 * ### Валидации:
 * - closeQuantity должен быть > 0
 * - closeQuantity не должен превышать position.quantity
 * - position должна иметь лоты
 *
 * @example
 * ```typescript
 * // Позиция с 3 лотами:
 * // Lot 1: 50 @ 0.60 (timestamp: 100)
 * // Lot 2: 30 @ 0.65 (timestamp: 200)
 * // Lot 3: 20 @ 0.70 (timestamp: 300)
 *
 * const closeQty = Quantity.of(new Decimal(60));
 * const closePrice = Price.of(new Decimal(0.75));
 *
 * const result = closeLIFO(position, closeQty, closePrice);
 * if (result.ok) {
 *   const { newPosition, realizedPnL } = result.value();
 *   // Закроются: Lot 3 полностью (20) + Lot 2 полностью (30) + 10 из Lot 1
 *   // Realized P&L: (0.75 - 0.70) * 20 + (0.75 - 0.65) * 30 + (0.75 - 0.60) * 10 = 5.5
 * }
 * ```
 */
export function closeLIFO(
  position: Position,
  closeQuantity: Quantity,
  closePrice: Price
): Result<CloseResult, ValidationError> {
  // Валидация входных параметров
  const validation = validateCloseParams(position, closeQuantity);
  if (!validation.ok) {
    return Err(validation.error);
  }

  // Сортируем лоты по timestamp (новые первые)
  const sortedLots = [...position.lots].sort((a, b) =>
    b.timestamp.toNumber() - a.timestamp.toNumber()
  );

  // Закрываем лоты по алгоритму LIFO
  return closeLots(position, sortedLots, closeQuantity, closePrice);
}

/**
 * Валидирует параметры закрытия позиции
 *
 * @param position - Позиция для закрытия
 * @param closeQuantity - Количество для закрытия
 * @returns Result с ValidationError если валидация не прошла
 *
 * @internal
 */
function validateCloseParams(
  position: Position,
  closeQuantity: Quantity
): Result<void, ValidationError> {
  // Валидация 1: closeQuantity должен быть > 0
  if (closeQuantity.isZero() || closeQuantity.value().isNegative()) {
    return Err(
      new ValidationError('Close quantity must be positive', {
        context: {
          positionId: position.id,
          closeQuantity: closeQuantity.value().toNumber(),
        },
      })
    );
  }

  // Валидация 2: closeQuantity не должен превышать position.quantity
  if (closeQuantity.value().gt(position.quantity.value())) {
    return Err(
      new ValidationError('Close quantity exceeds position quantity', {
        context: {
          positionId: position.id,
          closeQuantity: closeQuantity.value().toNumber(),
          positionQuantity: position.quantity.value().toNumber(),
        },
      })
    );
  }

  // Валидация 3: position должна иметь лоты
  if (position.lots.length === 0) {
    return Err(
      new ValidationError('Position has no lots to close', {
        context: {
          positionId: position.id,
        },
      })
    );
  }

  return Ok(undefined);
}

/**
 * Закрывает лоты в указанном порядке
 *
 * @param position - Исходная позиция
 * @param sortedLots - Отсортированные лоты (FIFO или LIFO)
 * @param closeQuantity - Количество для закрытия
 * @param closePrice - Цена закрытия
 * @returns Result с CloseResult
 *
 * @remarks
 * Универсальная функция для закрытия лотов.
 * Порядок определяется входным массивом sortedLots.
 *
 * @internal
 */
function closeLots(
  position: Position,
  sortedLots: PositionLot[],
  closeQuantity: Quantity,
  closePrice: Price
): Result<CloseResult, ValidationError> {
  let remaining = closeQuantity.value();
  let totalRealizedPnL = new Decimal(0);
  const newLots: PositionLot[] = [];
  const closedLots: ClosedLotInfo[] = [];

  for (const lot of sortedLots) {
    // Если уже закрыли нужное количество, остальные лоты остаются без изменений
    if (remaining.isZero()) {
      newLots.push(lot);
      continue;
    }

    const lotSize = lot.quantity.value();

    if (lotSize.lte(remaining)) {
      // Случай 1: Закрываем лот полностью
      const pnl = calculateLotPnL(lot, lot.quantity, closePrice, position.side);
      totalRealizedPnL = totalRealizedPnL.plus(pnl);
      remaining = remaining.minus(lotSize);

      closedLots.push({
        lot,
        closedQuantity: lot.quantity,
        closePrice,
        pnl: SignedQuantity.of(pnl),
      });
    } else {
      // Случай 2: Частичное закрытие лота
      const closedPart = Quantity.of(remaining);
      const pnl = calculateLotPnL(lot, closedPart, closePrice, position.side);
      totalRealizedPnL = totalRealizedPnL.plus(pnl);

      closedLots.push({
        lot,
        closedQuantity: closedPart,
        closePrice,
        pnl: SignedQuantity.of(pnl),
      });

      // Создаем новый лот с оставшимся количеством
      const remainingLotQuantity = lotSize.minus(remaining);
      newLots.push(lot.withQuantity(Quantity.of(remainingLotQuantity)));

      remaining = new Decimal(0);
    }
  }

  // Создаем новую позицию с обновленными лотами
  const newQuantity = position.quantity.value().minus(closeQuantity.value());
  const newRealizedPnL = position.realizedPnL.value().plus(totalRealizedPnL);

  const newPositionResult = Position.create({
    id: position.id,
    accountId: position.accountId,
    instrumentId: position.instrumentId,
    asset: position.asset,
    side: position.side,
    quantity: Quantity.of(newQuantity),
    averageEntryPrice: position.averageEntryPrice,
    timestamp: position.timestamp,
    lots: newLots,
    realizedPnL: SignedQuantity.of(newRealizedPnL),
    fees: position.fees,
  });

  if (!newPositionResult.ok) {
    return newPositionResult;
  }

  return Ok({
    newPosition: newPositionResult.value,
    realizedPnL: SignedQuantity.of(totalRealizedPnL),
    closedLots,
  });
}

/**
 * Рассчитывает P&L для лота
 *
 * @param lot - Лот позиции
 * @param closedQuantity - Закрываемое количество
 * @param closePrice - Цена закрытия
 * @param side - Сторона позиции (LONG/SHORT)
 * @returns P&L как Decimal
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
  closePrice: Price,
  side: 'LONG' | 'SHORT'
): Decimal {
  const priceDiff = closePrice.value().minus(lot.entryPrice.value());
  const pnl = priceDiff.times(closedQuantity.value());

  // Для SHORT позиции инвертируем знак
  return side === 'LONG' ? pnl : pnl.negated();
}

/**
 * Вычисляет weighted average entry price для лотов
 *
 * @param lots - Массив лотов
 * @returns Weighted average price
 *
 * @remarks
 * Формула: sum(lot.entryPrice * lot.quantity) / sum(lot.quantity)
 *
 * @example
 * ```typescript
 * const lots = [
 *   { quantity: Quantity(50), entryPrice: Price(0.60), ... },
 *   { quantity: Quantity(50), entryPrice: Price(0.70), ... },
 * ];
 *
 * const avgPrice = calculateWeightedAveragePrice(lots);
 * // (0.60 * 50 + 0.70 * 50) / 100 = 0.65
 * ```
 */
export function calculateWeightedAveragePrice(lots: readonly PositionLot[]): Price {
  if (lots.length === 0) {
    return Price.MIN;
  }

  let totalNotional = new Decimal(0);
  let totalQuantity = new Decimal(0);

  for (const lot of lots) {
    const notional = lot.entryPrice.value().times(lot.quantity.value());
    totalNotional = totalNotional.plus(notional);
    totalQuantity = totalQuantity.plus(lot.quantity.value());
  }

  if (totalQuantity.isZero()) {
    return Price.MIN;
  }

  const avgPrice = totalNotional.dividedBy(totalQuantity);
  return Price.of(avgPrice);
}

/**
 * Проверяет согласованность лотов с позицией
 *
 * @param position - Позиция для проверки
 * @returns True если лоты согласованы с quantity
 *
 * @remarks
 * Проверяет что:
 * - sum(lot.quantity) === position.quantity
 * - averageEntryPrice соответствует weighted average лотов
 *
 * @example
 * ```typescript
 * if (!validateLotsConsistency(position)) {
 *   console.error('Position lots are inconsistent');
 * }
 * ```
 */
export function validateLotsConsistency(position: Position): boolean {
  if (position.lots.length === 0) {
    // Нет лотов - это OK если quantity === 0
    return position.quantity.isZero();
  }

  // Проверка 1: sum(lot.quantity) === position.quantity
  let totalLotsQuantity = new Decimal(0);
  for (const lot of position.lots) {
    totalLotsQuantity = totalLotsQuantity.plus(lot.quantity.value());
  }

  if (!totalLotsQuantity.equals(position.quantity.value())) {
    return false;
  }

  // Проверка 2: averageEntryPrice соответствует weighted average
  const calculatedAvgPrice = calculateWeightedAveragePrice(position.lots);
  const expectedAvgPrice = position.averageEntryPrice.value();

  // Допускаем небольшую погрешность для floating point
  const tolerance = new Decimal('0.000001');
  const diff = calculatedAvgPrice.value().minus(expectedAvgPrice).abs();

  return diff.lte(tolerance);
}
