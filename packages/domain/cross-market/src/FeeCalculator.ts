/**
 * Калькулятор комиссий Polymarket
 *
 * @remarks
 * Текущая формула комиссии Polymarket для crypto-рынков:
 * `fee = round5(size × 0.072 × price × (1 - price))`
 *
 * Комиссия взимается только с taker-ордеров. Maker = 0%.
 *
 * @example
 * ```typescript
 * import { FeeCalculator } from '@polymarket/cross-market';
 * import { FEE_MODEL_CURRENT } from '@polymarket/cross-market';
 *
 * const calc = new FeeCalculator(FEE_MODEL_CURRENT);
 * const fee = calc.takerFee(0.50); // 0.018 для 1 share
 * const cost = calc.pairFee(0.45, true, 0.55, false); // taker + maker
 * ```
 */

import type { FeeModel } from './types.js';
import { calculatePolymarketTakerFeeNumber } from '@polymarket/fill/polymarket-fee';

/**
 * Калькулятор комиссий Polymarket.
 *
 * @param model - Модель комиссий (feeRate + exponent)
 *
 * @remarks
 * `model.feeRate` (`Ratio`) распаковывается один раз здесь, в конструкторе — `takerFee()`
 * вызывается на каждый depth-level каждого снапшота ордербука (хот-путь, см. TSDoc
 * `NumericLevel` в `types.ts`), поэтому дальше используется сохранённый plain `number`,
 * а не `Ratio.toNumber()` на каждый вызов.
 *
 * @example
 * ```typescript
 * const calc = new FeeCalculator({ feeRate: Ratio.of(new Decimal('0.072')), exponent: 1 });
 * console.log(calc.takerFee(0.50)); // 0.018
 * ```
 */
export class FeeCalculator {
  private readonly _feeRate: number;
  private readonly _exponent: number;

  constructor(model: FeeModel) {
    this._feeRate = model.feeRate.toNumber();
    this._exponent = model.exponent;
  }

  /**
   * Рассчитывает комиссию taker-ордера.
   *
   * @param price - Цена исполнения (0..1)
   * @param size - Размер сделки в shares (default: 1)
   * @returns Абсолютная комиссия в USDC-equivalent
   *
   * @remarks
   * Для текущей модели используется единый helper из @polymarket/fill.
   * Для явно переданной legacy-модели оставлена обобщённая форма:
   * `round5(size × feeRate × (price × (1-price))^exponent)`.
   * При price=0 или price=1 комиссия = 0.
   */
  takerFee(price: number, size = 1): number {
    if (price <= 0 || price >= 1) return 0;

    if (this._exponent === 1) {
      return calculatePolymarketTakerFeeNumber(size, price, this._feeRate);
    }

    const rawFee = size * this._feeRate * Math.pow(price * (1 - price), this._exponent);
    return this._roundFee(rawFee);
  }

  /**
   * Рассчитывает суммарную комиссию для пары ног арбитража.
   *
   * @param easyPrice - Цена покупки easy_Up
   * @param easyIsTaker - true если easy leg — taker
   * @param hardDownPrice - Цена покупки hard_Down (= 1 - hard_Up_bid)
   * @param hardIsTaker - true если hard leg — taker
   * @param size - Размер каждой ноги в shares (default: 1)
   * @returns Суммарная комиссия в USDC-equivalent
   */
  pairFee(
    easyPrice: number,
    easyIsTaker: boolean,
    hardDownPrice: number,
    hardIsTaker: boolean,
    size = 1,
  ): number {
    const easyFee = easyIsTaker ? this.takerFee(easyPrice, size) : 0;
    const hardFee = hardIsTaker ? this.takerFee(hardDownPrice, size) : 0;
    return easyFee + hardFee;
  }

  private _roundFee(fee: number): number {
    const rounded = Number(fee.toFixed(5));
    return rounded >= 0.00001 ? rounded : 0;
  }
}
