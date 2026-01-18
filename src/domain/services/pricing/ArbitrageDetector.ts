/**
 * ArbitrageDetector - обнаружение арбитража
 *
 * @remarks
 * Доменный сервис для обнаружения арбитражных возможностей в бинарных рынках.
 *
 * Принцип арбитража в бинарных рынках:
 * ```
 * Условие арбитража:
 * 1. YES + NO > 1.0 + fees → можно продать оба токена с прибылью
 * 2. YES + NO < 1.0 - fees → можно купить оба токена с прибылью
 * ```
 *
 * Почему возникает арбитраж?
 * - Временная неэффективность рынка
 * - Разная ликвидность на YES и NO токенах
 * - Эмоциональная торговля участников
 * - Задержки в обновлении цен
 *
 * Зачем нужен детектор?
 * - Автоматическое обнаружение безрисковых возможностей
 * - Контроль корректности котировок маркет-мейкера
 * - Валидация fair value (YES + NO должно быть ≈ 1.0)
 *
 * @example
 * ```typescript
 * const detector = new ArbitrageDetector();
 * const fees = Percentage.fromNumber(1.0); // 1%
 *
 * const opportunity = detector.detect(yesOrderbook, noOrderbook, fees);
 *
 * if (opportunity) {
 *   console.log(`Arbitrage found! Type: ${opportunity.type}`);
 *   console.log(`Profit: ${opportunity.profitPercent}%`);
 *   console.log(`Action: ${opportunity.action}`);
 * }
 * ```
 */
import { Orderbook } from '../../entities/Orderbook.js';
import { Price } from '../../value-objects/Price.js';
import { Percentage } from '../../value-objects/Percentage.js';
import { Money } from '../../value-objects/Money.js';

/**
 * Arbitrage opportunity type
 */
export type ArbitrageType = 'SELL_BOTH' | 'BUY_BOTH';

/**
 * Arbitrage opportunity
 *
 * @remarks
 * Описывает обнаруженную арбитражную возможность.
 */
export interface ArbitrageOpportunity {
  /**
   * Type of arbitrage
   */
  type: ArbitrageType;

  /**
   * Current YES price
   */
  yesPrice: Price;

  /**
   * Current NO price
   */
  noPrice: Price;

  /**
   * Sum of YES + NO prices
   */
  sum: number;

  /**
   * Expected sum (should be 1.0)
   */
  expectedSum: number;

  /**
   * Profit percentage (after fees)
   */
  profitPercent: number;

  /**
   * Recommended action
   */
  action: string;

  /**
   * Estimated profit per 1 USDC invested
   */
  profitPerUSDC: Money;
}

/**
 * ArbitrageDetector
 *
 * @remarks
 * Stateless сервис для обнаружения арбитражных возможностей.
 *
 * Алгоритм:
 * 1. Получить лучшие bid/ask цены из обоих ордербуков
 * 2. Вычислить сумму цен: sum = priceYes + priceNo
 * 3. Проверить условия арбитража:
 *    - Если sum > 1.0 + fees → SELL_BOTH
 *    - Если sum < 1.0 - fees → BUY_BOTH
 * 4. Рассчитать ожидаемую прибыль
 *
 * @example
 * ```typescript
 * const detector = new ArbitrageDetector();
 * const fees = Percentage.fromNumber(1.0); // 1% fee
 *
 * // Scenario 1: YES + NO > 1.0 (sell both)
 * // yesOrderbook: best bid = 0.66
 * // noOrderbook: best bid = 0.36
 * // sum = 1.02 > 1.01 (1.0 + 1% fees)
 *
 * const opportunity1 = detector.detect(yesOrderbook, noOrderbook, fees);
 * // opportunity1.type = 'SELL_BOTH'
 * // opportunity1.profitPercent ≈ 1%
 *
 * // Scenario 2: YES + NO < 1.0 (buy both)
 * // yesOrderbook: best ask = 0.62
 * // noOrderbook: best ask = 0.36
 * // sum = 0.98 < 0.99 (1.0 - 1% fees)
 *
 * const opportunity2 = detector.detect(yesOrderbook2, noOrderbook2, fees);
 * // opportunity2.type = 'BUY_BOTH'
 * // opportunity2.profitPercent ≈ 1%
 * ```
 */
export class ArbitrageDetector {
  /**
   * Creates ArbitrageDetector
   *
   * @example
   * ```typescript
   * const detector = new ArbitrageDetector();
   * ```
   */
  constructor() {}

  /**
   * Detects arbitrage opportunity
   *
   * @param yesOrderbook - YES token orderbook
   * @param noOrderbook - NO token orderbook
   * @param fees - Trading fees percentage (e.g., 1.0 for 1%)
   * @returns ArbitrageOpportunity if found, null otherwise
   *
   * @remarks
   * Алгоритм детекции:
   *
   * 1. **Подготовка данных**:
   *    - Получить лучшие bid/ask из YES ордербука
   *    - Получить лучшие bid/ask из NO ордербука
   *    - Конвертировать fees в коэффициент (1% → 0.01)
   *
   * 2. **Проверка SELL_BOTH**:
   *    ```
   *    Условие: (yesBid + noBid) > 1.0 + fees
   *    Действие: Sell YES at yesBid, Sell NO at noBid
   *    Прибыль: (yesBid + noBid - 1.0 - fees) * 100%
   *    ```
   *
   * 3. **Проверка BUY_BOTH**:
   *    ```
   *    Условие: (yesAsk + noAsk) < 1.0 - fees
   *    Действие: Buy YES at yesAsk, Buy NO at noAsk
   *    Прибыль: (1.0 - fees - yesAsk - noAsk) * 100%
   *    ```
   *
   * 4. **Расчет метрик**:
   *    - profitPercent: процент прибыли после fees
   *    - profitPerUSDC: прибыль на каждый вложенный USDC
   *    - action: рекомендуемое действие
   *
   * @example
   * ```typescript
   * const detector = new ArbitrageDetector();
   * const fees = Percentage.fromNumber(1.0); // 1%
   *
   * // Example 1: SELL_BOTH opportunity
   * // YES best bid: 0.66, NO best bid: 0.36
   * // sum = 1.02 > 1.01 (threshold with fees)
   * const opp1 = detector.detect(yesOrderbook1, noOrderbook1, fees);
   * if (opp1) {
   *   console.log(opp1.type); // 'SELL_BOTH'
   *   console.log(opp1.profitPercent); // ~1%
   *   console.log(opp1.action); // 'Sell YES at 0.66, Sell NO at 0.36'
   * }
   *
   * // Example 2: BUY_BOTH opportunity
   * // YES best ask: 0.62, NO best ask: 0.36
   * // sum = 0.98 < 0.99 (threshold with fees)
   * const opp2 = detector.detect(yesOrderbook2, noOrderbook2, fees);
   * if (opp2) {
   *   console.log(opp2.type); // 'BUY_BOTH'
   *   console.log(opp2.profitPercent); // ~1%
   *   console.log(opp2.action); // 'Buy YES at 0.62, Buy NO at 0.36'
   * }
   *
   * // Example 3: No arbitrage
   * // YES bid: 0.64, NO bid: 0.35, sum = 0.99 (within threshold)
   * const opp3 = detector.detect(yesOrderbook3, noOrderbook3, fees);
   * console.log(opp3); // null
   * ```
   */
  public detect(
    yesOrderbook: Orderbook,
    noOrderbook: Orderbook,
    fees: Percentage
  ): ArbitrageOpportunity | null {
    // Get best prices from orderbooks
    const yesBestBid = yesOrderbook.getBestBid();
    const yesBestAsk = yesOrderbook.getBestAsk();
    const noBestBid = noOrderbook.getBestBid();
    const noBestAsk = noOrderbook.getBestAsk();

    if (!yesBestBid || !yesBestAsk || !noBestBid || !noBestAsk) {
      // Insufficient data for arbitrage detection
      return null;
    }

    const feesFraction = fees.value / 100; // Convert 1% to 0.01

    // Check SELL_BOTH opportunity
    // Condition: (yesBid + noBid) > 1.0 + fees
    const sellBothSum = yesBestBid.value + noBestBid.value;
    const sellThreshold = 1.0 + feesFraction;

    if (sellBothSum > sellThreshold) {
      const profitPercent = (sellBothSum - 1.0 - feesFraction) * 100;

      return {
        type: 'SELL_BOTH',
        yesPrice: yesBestBid,
        noPrice: noBestBid,
        sum: sellBothSum,
        expectedSum: 1.0,
        profitPercent,
        action: `Sell YES at ${yesBestBid.value.toFixed(4)}, Sell NO at ${noBestBid.value.toFixed(4)}`,
        profitPerUSDC: Money.fromUSDC(profitPercent / 100),
      };
    }

    // Check BUY_BOTH opportunity
    // Condition: (yesAsk + noAsk) < 1.0 - fees
    const buyBothSum = yesBestAsk.value + noBestAsk.value;
    const buyThreshold = 1.0 - feesFraction;

    if (buyBothSum < buyThreshold) {
      const profitPercent = (1.0 - feesFraction - buyBothSum) * 100;

      return {
        type: 'BUY_BOTH',
        yesPrice: yesBestAsk,
        noPrice: noBestAsk,
        sum: buyBothSum,
        expectedSum: 1.0,
        profitPercent,
        action: `Buy YES at ${yesBestAsk.value.toFixed(4)}, Buy NO at ${noBestAsk.value.toFixed(4)}`,
        profitPerUSDC: Money.fromUSDC(profitPercent / 100),
      };
    }

    // No arbitrage opportunity
    return null;
  }

  /**
   * Checks if current quotes would create arbitrage
   *
   * @param yesBid - Proposed YES bid price
   * @param yesAsk - Proposed YES ask price
   * @param noBid - Proposed NO bid price
   * @param noAsk - Proposed NO ask price
   * @param fees - Trading fees percentage
   * @returns True if quotes would create arbitrage
   *
   * @remarks
   * Используется для валидации котировок маркет-мейкера.
   * Перед размещением ордеров проверяем, что они не создают арбитраж.
   *
   * Проверяемые условия:
   * 1. yesBid + noBid не должно быть > 1.0 + fees (иначе SELL_BOTH arbitrage)
   * 2. yesAsk + noAsk не должно быть < 1.0 - fees (иначе BUY_BOTH arbitrage)
   *
   * @example
   * ```typescript
   * const detector = new ArbitrageDetector();
   * const fees = Percentage.fromNumber(1.0);
   *
   * // Проверка перед размещением котировок
   * const wouldCreateArbitrage = detector.wouldCreateArbitrage(
   *   Price.fromNumber(0.64), // yesBid
   *   Price.fromNumber(0.66), // yesAsk
   *   Price.fromNumber(0.35), // noBid
   *   Price.fromNumber(0.37), // noAsk
   *   fees
   * );
   *
   * if (wouldCreateArbitrage) {
   *   console.warn('Quote adjustment needed to avoid arbitrage');
   * }
   * ```
   */
  public wouldCreateArbitrage(
    yesBid: Price,
    yesAsk: Price,
    noBid: Price,
    noAsk: Price,
    fees: Percentage
  ): boolean {
    const feesFraction = fees.value / 100;

    // Check SELL_BOTH condition
    const sellBothSum = yesBid.value + noBid.value;
    if (sellBothSum > 1.0 + feesFraction) {
      return true;
    }

    // Check BUY_BOTH condition
    const buyBothSum = yesAsk.value + noAsk.value;
    if (buyBothSum < 1.0 - feesFraction) {
      return true;
    }

    return false;
  }
}
