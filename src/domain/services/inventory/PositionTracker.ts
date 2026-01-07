/**
 * PositionTracker - отслеживание позиций
 *
 * @remarks
 * Доменный сервис для отслеживания и анализа позиций портфеля.
 *
 * Функции:
 * - Вычисление net position (signed)
 * - Вычисление gross position (absolute)
 * - Расчет hedge ratio (соотношение YES/NO)
 * - Расчет inventory imbalance
 * - Определение dominant side (YES или NO)
 *
 * Зачем нужен PositionTracker?
 * - Контроль за размером позиций
 * - Расчет skew для котировок маркет-мейкера
 * - Обнаружение перекосов в inventory
 * - Риск-менеджмент (position limits)
 *
 * @example
 * ```typescript
 * const tracker = new PositionTracker();
 *
 * const metrics = tracker.calculateMetrics(portfolio, 'market-123');
 *
 * console.log(`Net position: ${metrics.netPosition}`);
 * console.log(`Gross position: ${metrics.grossPosition}`);
 * console.log(`Hedge ratio: ${metrics.hedgeRatio}`);
 * console.log(`Dominant side: ${metrics.dominantSide}`);
 * ```
 */
import { Portfolio } from '../../aggregates/Portfolio.js';
import { ConfigLoader } from '../../../infrastructure/config/ConfigLoader.js';

/**
 * Position metrics
 */
export interface PositionMetrics {
  /**
   * Net position (yesQty - noQty)
   */
  netPosition: number;

  /**
   * Gross position (|yesQty| + |noQty|)
   */
  grossPosition: number;

  /**
   * YES position quantity
   */
  yesQuantity: number;

  /**
   * NO position quantity
   */
  noQuantity: number;

  /**
   * Hedge ratio (min/max of YES and NO)
   */
  hedgeRatio: number;

  /**
   * Inventory imbalance (-1 to 1)
   */
  imbalance: number;

  /**
   * Dominant side ('YES' | 'NO' | 'NEUTRAL')
   */
  dominantSide: 'YES' | 'NO' | 'NEUTRAL';
}

/**
 * PositionTracker
 *
 * @remarks
 * Stateless сервис для анализа позиций.
 *
 * Формулы:
 * ```
 * netPosition = yesQuantity - noQuantity
 * grossPosition = |yesQuantity| + |noQuantity|
 * hedgeRatio = min(yesQty, noQty) / max(yesQty, noQty)
 * imbalance = netPosition / grossPosition
 * ```
 *
 * @example
 * ```typescript
 * const tracker = new PositionTracker();
 *
 * // Scenario 1: Balanced position
 * // 100 YES, 100 NO
 * const metrics1 = tracker.calculateMetrics(portfolio1, 'market-1');
 * // netPosition = 0, grossPosition = 200, hedgeRatio = 1.0
 * // imbalance = 0, dominantSide = 'NEUTRAL'
 *
 * // Scenario 2: Long YES bias
 * // 150 YES, 50 NO
 * const metrics2 = tracker.calculateMetrics(portfolio2, 'market-1');
 * // netPosition = +100, grossPosition = 200, hedgeRatio = 0.33
 * // imbalance = +0.5, dominantSide = 'YES'
 * ```
 */
export class PositionTracker {
  /**
   * Creates PositionTracker
   *
   * @example
   * ```typescript
   * const tracker = new PositionTracker();
   * ```
   */
  constructor() {}

  /**
   * Calculates position metrics for market
   *
   * @param portfolio - Portfolio to analyze
   * @param marketId - Market ID
   * @returns Position metrics
   *
   * @remarks
   * Алгоритм:
   * 1. Найти YES и NO позиции для рынка
   * 2. Извлечь количества
   * 3. Рассчитать метрики:
   *    - netPosition = yesQty - noQty
   *    - grossPosition = |yesQty| + |noQty|
   *    - hedgeRatio = min / max
   *    - imbalance = net / gross
   *    - dominantSide = based on netPosition
   *
   * @example
   * ```typescript
   * const tracker = new PositionTracker();
   *
   * const metrics = tracker.calculateMetrics(portfolio, 'market-123');
   *
   * if (metrics.imbalance > 0.3) {
   *   console.log('High YES imbalance, skew quotes to reduce position');
   * } else if (metrics.imbalance < -0.3) {
   *   console.log('High NO imbalance, skew quotes to reduce position');
   * }
   * ```
   */
  public calculateMetrics(portfolio: Portfolio, marketId: string): PositionMetrics {
    // Find YES and NO positions
    const yesTokenId = `${marketId}-YES`;
    const noTokenId = `${marketId}-NO`;

    const yesPosition = portfolio.positions.get(yesTokenId);
    const noPosition = portfolio.positions.get(noTokenId);

    const yesQuantity = yesPosition ? yesPosition.totalQuantity.value : 0;
    const noQuantity = noPosition ? noPosition.totalQuantity.value : 0;

    // Calculate net position (signed)
    const netPosition = yesQuantity - noQuantity;

    // Calculate gross position (absolute)
    const grossPosition = Math.abs(yesQuantity) + Math.abs(noQuantity);

    // Calculate hedge ratio
    let hedgeRatio = 0;
    if (yesQuantity > 0 || noQuantity > 0) {
      const minQty = Math.min(yesQuantity, noQuantity);
      const maxQty = Math.max(yesQuantity, noQuantity);
      hedgeRatio = maxQty > 0 ? minQty / maxQty : 0;
    }

    // Calculate imbalance (-1 to 1)
    const imbalance = grossPosition > 0 ? netPosition / grossPosition : 0;

    // Determine dominant side (threshold from config)
    const positionConfig = ConfigLoader.getInstance().getPositionConfig();
    let dominantSide: 'YES' | 'NO' | 'NEUTRAL';
    if (Math.abs(imbalance) < positionConfig.neutralThreshold) {
      dominantSide = 'NEUTRAL';
    } else if (imbalance > 0) {
      dominantSide = 'YES';
    } else {
      dominantSide = 'NO';
    }

    return {
      netPosition,
      grossPosition,
      yesQuantity,
      noQuantity,
      hedgeRatio,
      imbalance,
      dominantSide,
    };
  }

  /**
   * Calculates skew for quote generation
   *
   * @param portfolio - Portfolio
   * @param marketId - Market ID
   * @param maxSkew - Maximum skew value (default: 1.0)
   * @returns Skew value (-maxSkew to +maxSkew)
   *
   * @remarks
   * Skew используется для корректировки котировок маркет-мейкера
   * в зависимости от текущего inventory.
   *
   * Логика:
   * - Positive imbalance (больше YES) → positive skew → widen ask, narrow bid
   * - Negative imbalance (больше NO) → negative skew → narrow ask, widen bid
   *
   * Формула:
   * ```
   * skew = imbalance * maxSkew
   * ```
   *
   * @example
   * ```typescript
   * const tracker = new PositionTracker();
   *
   * // Scenario 1: Balanced (no skew)
   * // 100 YES, 100 NO → imbalance = 0
   * const skew1 = tracker.calculateSkew(portfolio1, 'market-1');
   * console.log(skew1); // 0
   *
   * // Scenario 2: Long YES (positive skew)
   * // 150 YES, 50 NO → imbalance = +0.5
   * const skew2 = tracker.calculateSkew(portfolio2, 'market-1');
   * console.log(skew2); // +0.5
   *
   * // Scenario 3: Long NO (negative skew)
   * // 50 YES, 150 NO → imbalance = -0.5
   * const skew3 = tracker.calculateSkew(portfolio3, 'market-1');
   * console.log(skew3); // -0.5
   * ```
   */
  public calculateSkew(
    portfolio: Portfolio,
    marketId: string,
    maxSkew: number = 1.0
  ): number {
    const metrics = this.calculateMetrics(portfolio, marketId);
    return metrics.imbalance * maxSkew;
  }

  /**
   * Checks if position exceeds limit
   *
   * @param portfolio - Portfolio
   * @param marketId - Market ID
   * @param netLimit - Net position limit
   * @param grossLimit - Gross position limit
   * @returns True if position exceeds any limit
   *
   * @remarks
   * Проверяет, превышает ли позиция заданные лимиты.
   * Используется для риск-контроля перед размещением новых ордеров.
   *
   * @example
   * ```typescript
   * const tracker = new PositionTracker();
   *
   * const exceedsLimit = tracker.exceedsLimit(
   *   portfolio,
   *   'market-123',
   *   1000, // net limit
   *   2000  // gross limit
   * );
   *
   * if (exceedsLimit) {
   *   console.error('Position limit exceeded, cannot place order');
   *   throw new Error('Position limit exceeded');
   * }
   * ```
   */
  public exceedsLimit(
    portfolio: Portfolio,
    marketId: string,
    netLimit: number,
    grossLimit: number
  ): boolean {
    const metrics = this.calculateMetrics(portfolio, marketId);

    const netExceeds = Math.abs(metrics.netPosition) > netLimit;
    const grossExceeds = metrics.grossPosition > grossLimit;

    return netExceeds || grossExceeds;
  }
}
