/**
 * HedgeRatioCalculator - расчет hedge ratio
 *
 * @remarks
 * Доменный сервис для расчета коэффициента хеджирования позиций.
 *
 * Hedge Ratio:
 * ```
 * hedgeRatio = min(upQuantity, downQuantity) / max(upQuantity, downQuantity)
 * ```
 *
 * Интерпретация:
 * - hedgeRatio = 1.0 → Perfect hedge (YES = NO)
 * - hedgeRatio = 0.8 → Well-hedged (80% coverage)
 * - hedgeRatio = 0.5 → Moderate hedge (50% coverage)
 * - hedgeRatio = 0.0 → No hedge (directional bet)
 *
 * Зачем нужен HedgeRatioCalculator?
 * - Оценка качества хеджирования
 * - Расчет оптимального размера hedge order
 * - Риск-менеджмент для маркет-мейкера
 * - Определение необходимости ребалансировки
 *
 * @example
 * ```typescript
 * const calculator = new HedgeRatioCalculator();
 *
 * const ratio = calculator.calculate(
 *   Quantity.fromNumber(100), // YES
 *   Quantity.fromNumber(80)   // NO
 * );
 *
 * console.log(`Hedge ratio: ${ratio.value}`); // 0.8
 * ```
 */
import { Portfolio } from '../../aggregates/Portfolio.js';
import { Quantity } from '../../value-objects/Quantity.js';
import { Percentage } from '../../value-objects/Percentage.js';
import { ConfigLoader } from '../../../infrastructure/config/ConfigLoader.js';

/**
 * Hedge ratio result
 */
export interface HedgeRatioResult {
  /**
   * Hedge ratio (0 to 1)
   */
  ratio: number;

  /**
   * YES quantity
   */
  upQuantity: number;

  /**
   * NO quantity
   */
  downQuantity: number;

  /**
   * Hedge quality ('PERFECT' | 'GOOD' | 'MODERATE' | 'POOR' | 'NONE')
   */
  quality: 'PERFECT' | 'GOOD' | 'MODERATE' | 'POOR' | 'NONE';

  /**
   * Recommended hedge size to reach target ratio
   */
  recommendedHedgeSize: number;

  /**
   * Side to hedge ('YES' | 'NO' | 'NEUTRAL')
   */
  hedgeSide: 'YES' | 'NO' | 'NEUTRAL';
}

/**
 * HedgeRatioCalculator
 *
 * @remarks
 * Stateless сервис для расчета hedge ratio и рекомендаций.
 *
 * Формулы:
 * ```
 * hedgeRatio = min(yesQty, noQty) / max(yesQty, noQty)
 *
 * Качество хеджирования:
 * - ratio >= 0.95 → PERFECT
 * - ratio >= 0.80 → GOOD
 * - ratio >= 0.50 → MODERATE
 * - ratio >= 0.20 → POOR
 * - ratio < 0.20 → NONE
 * ```
 *
 * @example
 * ```typescript
 * const calculator = new HedgeRatioCalculator();
 *
 * // Perfect hedge
 * const result1 = calculator.calculate(
 *   Quantity.fromNumber(100),
 *   Quantity.fromNumber(100)
 * );
 * // result1.ratio = 1.0, quality = 'PERFECT'
 *
 * // Good hedge
 * const result2 = calculator.calculate(
 *   Quantity.fromNumber(100),
 *   Quantity.fromNumber(85)
 * );
 * // result2.ratio = 0.85, quality = 'GOOD'
 * ```
 */
export class HedgeRatioCalculator {
  /**
   * Creates HedgeRatioCalculator
   *
   * @example
   * ```typescript
   * const calculator = new HedgeRatioCalculator();
   * ```
   */
  constructor() {}

  /**
   * Calculates hedge ratio
   *
   * @param upQuantity - YES position quantity
   * @param downQuantity - NO position quantity
   * @param targetRatio - Target hedge ratio (default: 1.0)
   * @returns Hedge ratio result with recommendations
   *
   * @remarks
   * Алгоритм:
   *
   * 1. **Расчет hedge ratio**:
   *    ```
   *    if (yesQty = 0 && noQty = 0) → ratio = 0
   *    else ratio = min(yesQty, noQty) / max(yesQty, noQty)
   *    ```
   *
   * 2. **Определение качества**:
   *    ```
   *    if ratio >= 0.95 → PERFECT
   *    else if ratio >= 0.80 → GOOD
   *    else if ratio >= 0.50 → MODERATE
   *    else if ratio >= 0.20 → POOR
   *    else → NONE
   *    ```
   *
   * 3. **Расчет recommendedHedgeSize**:
   *    ```
   *    Чтобы достичь targetRatio:
   *    if yesQty > noQty:
   *      recommendedHedgeSize = yesQty * targetRatio - noQty (buy NO)
   *    else:
   *      recommendedHedgeSize = noQty * targetRatio - yesQty (buy YES)
   *    ```
   *
   * @example
   * ```typescript
   * const calculator = new HedgeRatioCalculator();
   *
   * // Example 1: Well-hedged position
   * const result1 = calculator.calculate(
   *   Quantity.fromNumber(100),
   *   Quantity.fromNumber(90),
   *   0.95 // target 95% hedge
   * );
   * // result1.ratio = 0.90
   * // result1.quality = 'GOOD'
   * // result1.recommendedHedgeSize = 5 (buy 5 more NO to reach 95% hedge)
   * // result1.hedgeSide = 'NO'
   *
   * // Example 2: Directional position (no hedge)
   * const result2 = calculator.calculate(
   *   Quantity.fromNumber(100),
   *   Quantity.fromNumber(0),
   *   0.95
   * );
   * // result2.ratio = 0
   * // result2.quality = 'NONE'
   * // result2.recommendedHedgeSize = 95 (buy 95 NO to reach 95% hedge)
   * // result2.hedgeSide = 'NO'
   * ```
   */
  public calculate(
    upQuantity: Quantity,
    downQuantity: Quantity,
    targetRatio: number = 1.0
  ): HedgeRatioResult {
    const yesQty = upQuantity.value;
    const noQty = downQuantity.value;

    // Calculate hedge ratio
    let ratio = 0;
    if (yesQty > 0 || noQty > 0) {
      const minQty = Math.min(yesQty, noQty);
      const maxQty = Math.max(yesQty, noQty);
      ratio = maxQty > 0 ? minQty / maxQty : 0;
    }

    // Determine quality (thresholds from config)
    const positionConfig = ConfigLoader.getInstance().getPositionConfig();
    let quality: 'PERFECT' | 'GOOD' | 'MODERATE' | 'POOR' | 'NONE';
    if (ratio >= positionConfig.hedgePerfectThreshold) {
      quality = 'PERFECT';
    } else if (ratio >= positionConfig.hedgeGoodThreshold) {
      quality = 'GOOD';
    } else if (ratio >= positionConfig.hedgeModerateThreshold) {
      quality = 'MODERATE';
    } else if (ratio >= positionConfig.hedgePoorThreshold) {
      quality = 'POOR';
    } else {
      quality = 'NONE';
    }

    // Calculate recommended hedge size to reach target ratio
    let recommendedHedgeSize = 0;
    let hedgeSide: 'YES' | 'NO' | 'NEUTRAL' = 'NEUTRAL';

    if (yesQty > noQty) {
      // Need to buy NO to balance
      recommendedHedgeSize = Math.max(0, yesQty * targetRatio - noQty);
      hedgeSide = 'NO';
    } else if (noQty > yesQty) {
      // Need to buy YES to balance
      recommendedHedgeSize = Math.max(0, noQty * targetRatio - yesQty);
      hedgeSide = 'YES';
    } else {
      // Already balanced
      hedgeSide = 'NEUTRAL';
    }

    return {
      ratio,
      upQuantity: yesQty,
      downQuantity: noQty,
      quality,
      recommendedHedgeSize,
      hedgeSide,
    };
  }

  /**
   * Calculates hedge ratio for market in portfolio
   *
   * @param portfolio - Portfolio
   * @param marketId - Market ID
   * @param targetRatio - Target hedge ratio
   * @returns Hedge ratio result
   *
   * @remarks
   * Convenience метод для расчета hedge ratio для конкретного рынка.
   *
   * @example
   * ```typescript
   * const calculator = new HedgeRatioCalculator();
   *
   * const result = calculator.calculateForMarket(
   *   portfolio,
   *   'market-123',
   *   0.95
   * );
   *
   * if (result.quality !== 'PERFECT' && result.quality !== 'GOOD') {
   *   console.warn(`Hedge quality is ${result.quality}`);
   *   console.log(`Recommendation: Buy ${result.recommendedHedgeSize} ${result.hedgeSide}`);
   * }
   * ```
   */
  public calculateForMarket(
    portfolio: Portfolio,
    marketId: string,
    targetRatio: number = 1.0
  ): HedgeRatioResult {
    const upTokenId = `${marketId}-UP`;
    const downTokenId = `${marketId}-DOWN`;

    const upPosition = portfolio.positions.get(upTokenId);
    const downPosition = portfolio.positions.get(downTokenId);

    const upQuantity = upPosition
      ? upPosition.totalQuantity
      : Quantity.fromNumber(0);
    const downQuantity = downPosition
      ? downPosition.totalQuantity
      : Quantity.fromNumber(0);

    return this.calculate(upQuantity, downQuantity, targetRatio);
  }

  /**
   * Calculates hedge effectiveness
   *
   * @param upQuantity - YES quantity
   * @param downQuantity - NO quantity
   * @returns Hedge effectiveness percentage (0-100%)
   *
   * @remarks
   * Hedge effectiveness = hedge ratio * 100%
   *
   * Интерпретация:
   * - 100% → Perfect hedge (fully protected)
   * - 80% → Good hedge (80% protection)
   * - 50% → Moderate hedge (50% protection)
   * - 0% → No hedge (directional bet)
   *
   * @example
   * ```typescript
   * const calculator = new HedgeRatioCalculator();
   *
   * const effectiveness = calculator.calculateEffectiveness(
   *   Quantity.fromNumber(100),
   *   Quantity.fromNumber(85)
   * );
   *
   * console.log(`Hedge effectiveness: ${effectiveness.value}%`); // 85%
   * ```
   */
  public calculateEffectiveness(
    upQuantity: Quantity,
    downQuantity: Quantity
  ): Percentage {
    const result = this.calculate(upQuantity, downQuantity);
    return Percentage.fromNumber(result.ratio * 100);
  }

  /**
   * Checks if position needs rebalancing
   *
   * @param upQuantity - YES quantity
   * @param downQuantity - NO quantity
   * @param minAcceptableRatio - Minimum acceptable hedge ratio (default: 0.8)
   * @returns True if position needs rebalancing
   *
   * @remarks
   * Позиция требует ребалансировки, если hedge ratio < minAcceptableRatio.
   *
   * @example
   * ```typescript
   * const calculator = new HedgeRatioCalculator();
   *
   * const needsRebalancing = calculator.needsRebalancing(
   *   Quantity.fromNumber(100),
   *   Quantity.fromNumber(60),
   *   0.8 // min 80% hedge
   * );
   *
   * if (needsRebalancing) {
   *   console.log('Position needs rebalancing');
   *   const result = calculator.calculate(yesQty, noQty, 0.95);
   *   console.log(`Buy ${result.recommendedHedgeSize} ${result.hedgeSide}`);
   * }
   * ```
   */
  public needsRebalancing(
    upQuantity: Quantity,
    downQuantity: Quantity,
    minAcceptableRatio?: number
  ): boolean {
    // Use config default if not specified
    const threshold = minAcceptableRatio ??
      ConfigLoader.getInstance().getPositionConfig().hedgeMinAcceptable;
    const result = this.calculate(upQuantity, downQuantity);
    return result.ratio < threshold;
  }
}
