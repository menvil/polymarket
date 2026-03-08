/**
 * Функции оценки стоимости и P&L портфеля
 *
 * @remarks
 * Вынесены из Portfolio aggregate намеренно — требуют внешних рыночных цен,
 * которые не являются частью доменного состояния.
 *
 * ### Почему функции, не класс:
 * Stateless-операции не нуждаются в классах. Функции проще тестировать,
 * импортировать и использовать по отдельности.
 *
 * ### Почему не в Portfolio:
 * Оценка требует текущих котировок — внешних данных.
 * Portfolio aggregate не должен зависеть от рыночного состояния.
 *
 * ### Отсутствие cast:
 * Функции принимают `Iterable<IPosition>` — тот же тип, что возвращает
 * `portfolio.getPositions()`. Нет промежуточных интерфейсов, нет cast.
 *
 * @example
 * ```typescript
 * import { getTotalValue, getTotalUnrealizedPnL } from './services/PortfolioValuationService';
 *
 * const getPrice = (instrumentId: InstrumentId) => prices.get(instrumentId);
 *
 * const totalValue = getTotalValue(portfolio.getPositions(), getPrice, 'USDC');
 * const pnl = getTotalUnrealizedPnL(portfolio.getPositions(), getPrice);
 * ```
 */

import type { InstrumentId } from '@polymarket/ids';
import { Money, type SupportedCurrency } from '@polymarket/value-objects/money';
import { SignedQuantity } from '@polymarket/value-objects/signed-quantity';
import Decimal from 'decimal.js';
import type { IPosition } from '../Portfolio.js';

/**
 * Функция-провайдер текущих цен
 */
export type PriceProvider = (instrumentId: InstrumentId) => { value(): Decimal } | undefined;

/**
 * Считает суммарную стоимость позиций портфеля
 *
 * @param positions - Итерируемые позиции (из portfolio.getPositions())
 * @param getPrice - Провайдер текущих цен
 * @param currency - Валюта результата (обычно 'USDC')
 * @returns Суммарная стоимость как Money
 *
 * @remarks
 * Алгоритм: для каждой позиции вычисляет quantity × price.
 * LONG — положительная стоимость, SHORT — отрицательная.
 * Позиции без цены пропускаются.
 *
 * @example
 * ```typescript
 * const value = getTotalValue(portfolio.getPositions(), getPrice, 'USDC');
 * console.log(value.value().toNumber()); // 12500
 * ```
 */
export function getTotalValue(
  positions: Iterable<IPosition>,
  getPrice: PriceProvider,
  currency: SupportedCurrency
): Money {
  let total = new Decimal(0);

  for (const position of positions) {
    const price = getPrice(position.instrumentId);
    if (!price) continue;

    const positionValue = position.quantity.value().times(price.value());
    total = position.side === 'LONG'
      ? total.plus(positionValue)
      : total.minus(positionValue);
  }

  return Money.of(total, currency);
}

/**
 * Считает суммарный unrealized P&L по всем позициям
 *
 * @param positions - Итерируемые позиции (из portfolio.getPositions())
 * @param getPrice - Провайдер текущих цен
 * @returns Суммарный unrealized P&L как SignedQuantity
 *
 * @remarks
 * Делегирует расчёт каждой позиции через `position.getUnrealizedPnL(price)`.
 * Позиции без цены пропускаются (PnL не считается).
 *
 * @example
 * ```typescript
 * const pnl = getTotalUnrealizedPnL(portfolio.getPositions(), getPrice);
 * console.log(pnl.value().toNumber()); // -150.5
 * ```
 */
export function getTotalUnrealizedPnL(
  positions: Iterable<IPosition>,
  getPrice: PriceProvider
): SignedQuantity {
  let total = new Decimal(0);

  for (const position of positions) {
    const price = getPrice(position.instrumentId);
    if (!price) continue;

    total = total.plus(position.getUnrealizedPnL(price).value());
  }

  return SignedQuantity.of(total);
}
