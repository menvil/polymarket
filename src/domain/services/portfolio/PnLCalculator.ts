/**
 * PnLCalculator - pure function для расчёта PnL
 *
 * @remarks
 * КРИТИЧНО v4.2: PnL = derived view над positions!
 *
 * НЕ accumulator (не процессирует fills напрямую).
 * Получает positions от PortfolioProjector.
 * Вычисляет realized + unrealized PnL.
 *
 * Архитектура v4.2:
 * ```
 * fills → PortfolioProjector → positions (source of truth)
 * positions + market prices → PnLCalculator → PnL (derived view)
 * ```
 *
 * Инварианты DumbStrategy (ОБЯЗАТЕЛЬНЫ):
 * 1. Только long (buy → sell → buy)
 * 2. Полный fill перед reverse order
 * 3. NO flip, NO interleaving
 *
 * Если стратегия нарушает инварианты → PnL НЕВЕРНЫЙ!
 *
 * TODO (v5): Полный FIFO accounting для любых flows
 *
 * @example
 * ```typescript
 * const calculator = new PnLCalculator();
 * const positions = new Map([
 *   ['token1', { tokenId: 'token1', quantity: 100, averageCost: 0.52, realizedPnL: 2.5 }]
 * ]);
 * const marketPrices = new Map([['token1', 0.53]]);
 *
 * const pnl = calculator.calculatePnL(positions, marketPrices);
 * // → { realized: Money(2.5), unrealized: Money(1.0), total: Money(3.5) }
 * ```
 */

import { Money } from '../../value-objects/Money.js';

/**
 * Position - позиция по одному токену
 *
 * @remarks
 * Source of truth для PnL расчётов.
 * Создаётся и управляется PortfolioProjector.
 *
 * v5.5: Расширено для отслеживания инвентаря и cash flow:
 * - inventory (quantity) - сколько токенов держим
 * - totalCost - сколько USDC потратили на покупки
 * - totalRevenue - сколько USDC получили от продаж
 * - netCashFlow = totalRevenue - totalCost (отрицательный = в минусе)
 *
 * @property tokenId - ID токена
 * @property quantity - Инвентарь (количество токенов)
 * @property averageCost - Средняя цена входа (FIFO approximation)
 * @property realizedPnL - Накопленный realized PnL
 * @property totalCost - Общая сумма потраченная на покупки (USDC)
 * @property totalRevenue - Общая сумма полученная от продаж (USDC)
 * @property totalBought - Общее количество купленных токенов
 * @property totalSold - Общее количество проданных токенов
 */
export interface Position {
  tokenId: string;
  quantity: number; // Инвентарь (inventory)
  averageCost: number; // Средняя цена входа
  realizedPnL: number; // Accumulated realized PnL

  // v5.5: Cash flow tracking
  totalCost: number; // Потрачено USDC на покупки
  totalRevenue: number; // Получено USDC от продаж
  totalBought: number; // Куплено токенов (всего)
  totalSold: number; // Продано токенов (всего)
}

/**
 * PnL результат
 *
 * @property realized - Реализованный PnL (зафиксированный)
 * @property unrealized - Нереализованный PnL (текущая открытая позиция)
 * @property total - Общий PnL (realized + unrealized)
 */
export interface PnLResult {
  realized: Money;
  unrealized: Money;
  total: Money;
}

/**
 * IPnLCalculator - интерфейс для PnL калькулятора
 */
export interface IPnLCalculator {
  /**
   * Рассчитать ОБЩИЙ PnL из positions
   *
   * @param positions - Текущие позиции (от PortfolioProjector)
   * @param marketPrices - Рыночные цены для unrealized PnL
   * @returns PnL result (realized, unrealized, total)
   *
   * @remarks
   * КРИТИЧНО v4.2: Pure function над positions!
   *
   * Realized PnL: берётся из position.realizedPnL (вычислен PortfolioProjector)
   * Unrealized PnL: вычисляется как position.quantity × (market price - avg cost)
   * Total PnL: realized + unrealized
   *
   * @example
   * ```typescript
   * const positions = new Map([
   *   ['token1', { tokenId: 'token1', quantity: 100, averageCost: 0.52, realizedPnL: 2.5 }]
   * ]);
   * const marketPrices = new Map([['token1', 0.53]]);
   *
   * const pnl = calculator.calculatePnL(positions, marketPrices);
   * // realized = 2.5 (from position.realizedPnL)
   * // unrealized = 100 × (0.53 - 0.52) = 1.0
   * // total = 3.5
   * ```
   */
  calculatePnL(
    positions: Map<string, Position>,
    marketPrices: Map<string, number>
  ): PnLResult;
}

/**
 * PnLCalculator - pure function реализация
 *
 * @remarks
 * КРИТИЧНО v4.2:
 * - PnL = derived view над positions (НЕ accumulator)
 * - Realized PnL берётся из positions (вычислен PortfolioProjector)
 * - Unrealized PnL вычисляется on-the-fly из текущих цен
 *
 * @example
 * ```typescript
 * const calculator = new PnLCalculator();
 *
 * // Scenario: Buy 100 @ 0.52, Sell 100 @ 0.53, Buy 50 @ 0.51
 * const positions = new Map([
 *   ['token1', {
 *     tokenId: 'token1',
 *     quantity: 50, // Текущая позиция
 *     averageCost: 0.51, // Последняя покупка
 *     realizedPnL: 1.0 // (0.53 - 0.52) × 100 = 1.0
 *   }]
 * ]);
 *
 * const marketPrices = new Map([['token1', 0.52]]);
 *
 * const pnl = calculator.calculatePnL(positions, marketPrices);
 * // realized = 1.0 (зафиксировано)
 * // unrealized = 50 × (0.52 - 0.51) = 0.5 (открытая позиция)
 * // total = 1.5
 * ```
 */
export class PnLCalculator implements IPnLCalculator {
  /**
   * Рассчитать PnL из positions (pure function)
   *
   * @param positions - Текущие позиции (от PortfolioProjector)
   * @param marketPrices - Рыночные цены
   * @returns PnL result
   *
   * @remarks
   * Алгоритм:
   * 1. Суммируем position.realizedPnL для всех позиций → total realized
   * 2. Для каждой позиции с qty ≠ 0: вычисляем unrealized = qty × (market - avg cost)
   * 3. Суммируем unrealized → total unrealized
   * 4. total = realized + unrealized
   */
  calculatePnL(
    positions: Map<string, Position>,
    marketPrices: Map<string, number>
  ): PnLResult {
    let totalRealized = 0;
    let totalUnrealized = 0;

    for (const [tokenId, position] of positions) {
      // Realized PnL (уже вычислен PortfolioProjector)
      totalRealized += position.realizedPnL;

      // Unrealized PnL (текущая позиция × (market price - avg cost))
      const marketPrice = marketPrices.get(tokenId);
      if (marketPrice !== undefined && position.quantity !== 0) {
        const unrealizedPnL = position.quantity * (marketPrice - position.averageCost);
        totalUnrealized += unrealizedPnL;
      }
    }

    return {
      realized: Money.fromSignedUSDC(totalRealized),
      unrealized: Money.fromSignedUSDC(totalUnrealized),
      total: Money.fromSignedUSDC(totalRealized + totalUnrealized),
    };
  }
}
