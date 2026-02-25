/**
 * PortfolioValuationService — сервис оценки стоимости портфеля
 *
 * @remarks
 * Вынесен из Portfolio aggregate намеренно:
 * - Оценка портфеля — presentation/analytics логика, не доменная.
 * - Требует текущих цен инструментов (внешние данные, не часть домена).
 * - Portfolio aggregate не должен знать о рыночных котировках.
 *
 * ### Архитектура
 * Статический класс-утилита. Не хранит состояния.
 * Принимает `Portfolio` + внешние котировки в виде callback или Map.
 *
 * Использует `IValuablePosition` — структурный интерфейс для позиций с P&L.
 * Совместим с реальным Position entity из `@polymarket/position`.
 *
 * @example
 * ```typescript
 * import { PortfolioValuationService, IValuablePosition } from './services/PortfolioValuationService';
 *
 * const getPrice = (instrumentId: InstrumentId) => prices.get(instrumentId);
 *
 * const totalValue = PortfolioValuationService.getTotalValue(portfolio, getPrice);
 * console.log(totalValue.toNumber()); // сумма стоимостей всех позиций
 *
 * const pnl = PortfolioValuationService.getTotalUnrealizedPnL(portfolio, getPrice);
 * console.log(pnl.toNumber()); // суммарный unrealized P&L
 * ```
 */

import Decimal from 'decimal.js';
import type { InstrumentId } from '@polymarket/ids';
import type { Portfolio, IPosition } from '../Portfolio.js';

/**
 * Интерфейс позиции с данными для оценки стоимости
 *
 * @remarks
 * Расширяет IPosition дополнительными полями для расчёта P&L и стоимости.
 * Совместим структурно с реальным Position entity.
 */
export interface IValuablePosition extends IPosition {
  /** Количество в позиции */
  readonly quantity: {
    /** Возвращает значение количества */
    value(): Decimal;
  };
  /** Сторона позиции */
  readonly side: 'LONG' | 'SHORT';
  /** Средняя цена входа */
  readonly averageEntryPrice: {
    /** Возвращает значение цены */
    value(): Decimal;
  };
}

/**
 * Провайдер цен: функция, возвращающая цену по instrumentId
 */
export type PriceProvider = (instrumentId: InstrumentId) => { value(): Decimal } | undefined;

/**
 * PortfolioValuationService — аналитика стоимости и P&L портфеля
 *
 * @remarks
 * Статический класс. Не инстанциируется.
 */
export class PortfolioValuationService {
  /** @internal */
  private constructor() {
    throw new Error('PortfolioValuationService is a static class');
  }

  /**
   * Считает суммарную стоимость всех позиций портфеля
   *
   * @param portfolio - Портфель с позициями типа IValuablePosition
   * @param getPrice - Функция-провайдер цен по instrumentId
   * @returns Суммарная стоимость (quantity * price) по всем позициям, Decimal
   *
   * @remarks
   * Алгоритм:
   * 1. Для каждой позиции из portfolio.getAllPositions():
   *    - Запрашивает цену через getPrice(instrumentId).
   *    - Если цена не найдена — пропускает позицию.
   *    - Вычисляет стоимость: quantity * price.
   * 2. Для LONG позиции — положительная стоимость.
   * 3. Для SHORT позиции — отрицательная стоимость (short exposure).
   *
   * @example
   * ```typescript
   * const getPrice = (id: InstrumentId) => prices.get(id);
   * const total = PortfolioValuationService.getTotalValue(portfolio, getPrice);
   * // total = sum(quantity_i * price_i) for each position i
   * ```
   */
  public static getTotalValue(
    portfolio: Portfolio,
    getPrice: PriceProvider
  ): Decimal {
    let total = new Decimal(0);

    for (const rawPosition of portfolio.getAllPositions()) {
      const position = rawPosition as IValuablePosition;
      const price = getPrice(position.instrumentId);
      if (!price) continue;

      const positionValue = position.quantity.value().times(price.value());
      const signedValue = position.side === 'LONG' ? positionValue : positionValue.negated();
      total = total.plus(signedValue);
    }

    return total;
  }

  /**
   * Считает суммарный unrealized P&L по всем позициям портфеля
   *
   * @param portfolio - Портфель с позициями типа IValuablePosition
   * @param getPrice - Функция-провайдер цен по instrumentId
   * @returns Суммарный unrealized P&L, Decimal
   *
   * @remarks
   * Алгоритм:
   * 1. Для каждой позиции:
   *    - Запрашивает цену через getPrice(instrumentId).
   *    - Если цена не найдена — пропускает.
   *    - Для LONG: pnl = (currentPrice - avgEntryPrice) * quantity
   *    - Для SHORT: pnl = (avgEntryPrice - currentPrice) * quantity
   * 2. Суммирует P&L всех позиций.
   *
   * @example
   * ```typescript
   * const getPrice = (id: InstrumentId) => prices.get(id);
   * const pnl = PortfolioValuationService.getTotalUnrealizedPnL(portfolio, getPrice);
   * // pnl = sum((currentPrice_i - avgEntry_i) * quantity_i) for LONG positions
   * ```
   */
  public static getTotalUnrealizedPnL(
    portfolio: Portfolio,
    getPrice: PriceProvider
  ): Decimal {
    let totalPnL = new Decimal(0);

    for (const rawPosition of portfolio.getAllPositions()) {
      const position = rawPosition as IValuablePosition;
      const price = getPrice(position.instrumentId);
      if (!price) continue;

      const priceDiff = price.value().minus(position.averageEntryPrice.value());
      const rawPnL = priceDiff.times(position.quantity.value());
      const signedPnL = position.side === 'LONG' ? rawPnL : rawPnL.negated();
      totalPnL = totalPnL.plus(signedPnL);
    }

    return totalPnL;
  }
}
