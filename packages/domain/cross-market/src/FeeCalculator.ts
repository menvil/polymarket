/**
 * Калькулятор комиссий Polymarket
 *
 * @remarks
 * Формула комиссии Polymarket:
 * `fee = price × feeRate × (price × (1 - price))^exponent`
 *
 * Комиссия взимается только с taker-ордеров. Maker = 0%.
 *
 * ### Текущая модель (до 30 марта 2026):
 * - feeRate = 0.25, exponent = 2
 * - Пиковая ставка при p=0.50: ~1.56%
 *
 * ### Новая модель (после 30 марта 2026):
 * - feeRate = 0.072, exponent = 1
 * - Пиковая ставка при p=0.50: ~1.80%
 *
 * @example
 * ```typescript
 * import { FeeCalculator } from '@polymarket/cross-market';
 * import { FEE_MODEL_CURRENT } from '@polymarket/cross-market';
 *
 * const calc = new FeeCalculator(FEE_MODEL_CURRENT);
 * const fee = calc.takerFee(0.50); // ~0.0078 (1.56% от цены 0.50)
 * const cost = calc.totalFee(0.45, true, 0.55, false); // taker + maker
 * ```
 */

import type { FeeModel } from './types.js';

/**
 * Калькулятор комиссий Polymarket.
 *
 * @param model - Модель комиссий (feeRate + exponent)
 *
 * @example
 * ```typescript
 * const calc = new FeeCalculator({ feeRate: 0.25, exponent: 2 });
 * console.log(calc.takerFee(0.50)); // 0.0078125
 * ```
 */
export class FeeCalculator {
  constructor(private readonly _model: FeeModel) {}

  /**
   * Рассчитывает комиссию taker-ордера.
   *
   * @param price - Цена исполнения (0..1)
   * @returns Абсолютная комиссия на 1 контракт
   *
   * @remarks
   * Формула: `price × feeRate × (price × (1 - price))^exponent`
   * При price=0 или price=1 комиссия = 0.
   */
  takerFee(price: number): number {
    if (price <= 0 || price >= 1) return 0;
    return price * this._model.feeRate * Math.pow(price * (1 - price), this._model.exponent);
  }

  /**
   * Рассчитывает суммарную комиссию для пары ног арбитража.
   *
   * @param easyPrice - Цена покупки easy_Up
   * @param easyIsTaker - true если easy leg — taker
   * @param hardDownPrice - Цена покупки hard_Down (= 1 - hard_Up_bid)
   * @param hardIsTaker - true если hard leg — taker
   * @returns Суммарная комиссия на 1 пару контрактов
   */
  pairFee(
    easyPrice: number,
    easyIsTaker: boolean,
    hardDownPrice: number,
    hardIsTaker: boolean,
  ): number {
    const easyFee = easyIsTaker ? this.takerFee(easyPrice) : 0;
    const hardFee = hardIsTaker ? this.takerFee(hardDownPrice) : 0;
    return easyFee + hardFee;
  }
}
