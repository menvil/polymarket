/**
 * FairValueCalculator - расчет справедливой стоимости
 *
 * @remarks
 * Доменный сервис для вычисления fair value токена на основе данных ордербука.
 *
 * Алгоритм:
 * 1. Получить mid-price из ордербука
 * 2. Вычислить microprice (weighted by volume)
 * 3. Применить EMA smoothing к предыдущему fair value
 * 4. Комбинировать компоненты: W_MID * mid + W_MICRO * microprice + W_EMA * ema
 *
 * Зачем нужен fair value?
 * - Определение "правильной" цены актива
 * - Обнаружение мисприсингов (арбитражных возможностей)
 * - Базис для генерации котировок маркет-мейкера
 * - Проверка YES + NO = 1.0 (арбитражное условие)
 *
 * @example
 * ```typescript
 * const calculator = new FairValueCalculator();
 * const config: FairValueConfig = {
 *   weightMid: 0.4,
 *   weightMicroprice: 0.4,
 *   weightEma: 0.2,
 *   emaAlpha: 0.1,
 * };
 *
 * const fairValue = calculator.calculate(orderbook, previousFairValue, config);
 * console.log(`Fair value: ${fairValue.value}`);
 * ```
 */
import { Orderbook } from '../../entities/Orderbook.js';
import { Price } from '../../value-objects/Price.js';
import { Percentage } from '../../value-objects/Percentage.js';
import { MicropriceCalculator } from './MicropriceCalculator.js';

/**
 * Fair value configuration
 *
 * @remarks
 * Параметры для вычисления fair value.
 * Веса должны суммироваться в 1.0.
 */
export interface FairValueConfig {
  /**
   * Weight for mid-price component (default: 0.4)
   */
  weightMid: number;

  /**
   * Weight for microprice component (default: 0.4)
   */
  weightMicroprice: number;

  /**
   * Weight for EMA component (default: 0.2)
   */
  weightEma: number;

  /**
   * EMA smoothing factor (0 to 1, default: 0.1)
   * Higher = more reactive, Lower = smoother
   */
  emaAlpha: number;
}

/**
 * FairValueCalculator
 *
 * @remarks
 * Stateless сервис для расчета справедливой стоимости.
 * Использует комбинацию mid-price, microprice и EMA.
 *
 * Формула:
 * ```
 * fairValue = W_MID * midPrice +
 *             W_MICRO * microprice +
 *             W_EMA * ema
 *
 * где:
 * - midPrice = (bestBid + bestAsk) / 2
 * - microprice = (bidPrice * askSize + askPrice * bidSize) / (bidSize + askSize)
 * - ema = emaAlpha * midPrice + (1 - emaAlpha) * previousEma
 * ```
 *
 * @example
 * ```typescript
 * const calculator = new FairValueCalculator();
 *
 * const config: FairValueConfig = {
 *   weightMid: 0.4,
 *   weightMicroprice: 0.4,
 *   weightEma: 0.2,
 *   emaAlpha: 0.1,
 * };
 *
 * // Первый вызов
 * const fairValue1 = calculator.calculate(
 *   orderbook,
 *   Price.fromNumber(0.5), // initial guess
 *   config
 * );
 *
 * // Последующие вызовы используют предыдущий fair value
 * const fairValue2 = calculator.calculate(orderbook, fairValue1, config);
 * ```
 */
export class FairValueCalculator {
  private readonly micropriceCalculator: MicropriceCalculator;

  /**
   * Creates FairValueCalculator
   *
   * @example
   * ```typescript
   * const calculator = new FairValueCalculator();
   * ```
   */
  constructor() {
    this.micropriceCalculator = new MicropriceCalculator();
  }

  /**
   * Calculates fair value from orderbook
   *
   * @param orderbook - Current orderbook state
   * @param previousFairValue - Previous fair value for EMA smoothing
   * @param config - Fair value calculation parameters
   * @returns Calculated fair value
   *
   * @throws {Error} If orderbook is empty or weights don't sum to 1.0
   *
   * @remarks
   * Алгоритм:
   * 1. Валидация весов (должны суммироваться в 1.0 ± 0.001)
   * 2. Получение mid-price из ордербука
   * 3. Вычисление microprice
   * 4. Вычисление EMA: ema = alpha * mid + (1 - alpha) * previousFairValue
   * 5. Комбинирование компонентов с весами
   * 6. Возврат нового Price объекта
   *
   * @example
   * ```typescript
   * const calculator = new FairValueCalculator();
   * const config: FairValueConfig = {
   *   weightMid: 0.5,
   *   weightMicroprice: 0.3,
   *   weightEma: 0.2,
   *   emaAlpha: 0.1,
   * };
   *
   * const fairValue = calculator.calculate(
   *   orderbook,
   *   Price.fromNumber(0.65),
   *   config
   * );
   *
   * console.log(`Fair value: ${fairValue.value}`);
   * ```
   */
  public calculate(
    orderbook: Orderbook,
    previousFairValue: Price,
    config: FairValueConfig
  ): Price {
    // 1. Validate weights
    const totalWeight = config.weightMid + config.weightMicroprice + config.weightEma;
    if (Math.abs(totalWeight - 1.0) > 0.001) {
      throw new Error(
        `Weights must sum to 1.0, got ${totalWeight}. ` +
          `(weightMid=${config.weightMid}, weightMicroprice=${config.weightMicroprice}, weightEma=${config.weightEma})`
      );
    }

    // 2. Get mid-price
    const midPrice = orderbook.getMidPrice();
    if (!midPrice) {
      throw new Error('Cannot calculate fair value: orderbook has no mid-price');
    }

    // 3. Calculate microprice
    const microprice = this.micropriceCalculator.calculate(
      orderbook.bids.map((level) => ({
        price: level.price,
        quantity: level.quantity,
      })),
      orderbook.asks.map((level) => ({
        price: level.price,
        quantity: level.quantity,
      }))
    );

    // 4. Calculate EMA
    // ema = alpha * currentMid + (1 - alpha) * previousEma
    const ema =
      config.emaAlpha * midPrice.value + (1 - config.emaAlpha) * previousFairValue.value;

    // 5. Combine components with weights
    const fairValue =
      config.weightMid * midPrice.value +
      config.weightMicroprice * microprice.value +
      config.weightEma * ema;

    return Price.fromNumber(fairValue);
  }

  /**
   * Calculates YES/NO mismatch percentage
   *
   * @param fairYes - Fair value of YES token
   * @param fairNo - Fair value of NO token
   * @returns Percentage mismatch (should be close to 0%)
   *
   * @remarks
   * В идеале: fairYes + fairNo = 1.0
   * Если сумма отклоняется от 1.0, это может указывать на:
   * - Арбитражную возможность
   * - Проблемы с ликвидностью
   * - Неточность в расчетах
   *
   * Формула:
   * ```
   * mismatch = |fairYes + fairNo - 1.0| / 1.0 * 100%
   * ```
   *
   * @example
   * ```typescript
   * const calculator = new FairValueCalculator();
   *
   * const fairYes = Price.fromNumber(0.65);
   * const fairNo = Price.fromNumber(0.34);
   *
   * const mismatch = calculator.calculateYesNoMismatch(fairYes, fairNo);
   * console.log(`Mismatch: ${mismatch.value}%`); // 1%
   *
   * if (mismatch.value > 1.0) {
   *   console.warn('Significant YES/NO mismatch detected!');
   * }
   * ```
   */
  public calculateYesNoMismatch(fairYes: Price, fairNo: Price): Percentage {
    const sum = fairYes.value + fairNo.value;
    const expectedSum = 1.0;
    const mismatch = Math.abs(sum - expectedSum);
    const mismatchPercent = (mismatch / expectedSum) * 100;

    return Percentage.fromNumber(mismatchPercent);
  }
}
