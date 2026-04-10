/**
 * Расчёт taker-комиссии на Polymarket в USDC-equivalent.
 *
 * @remarks
 * Актуальная формула Polymarket:
 *   fee = C × feeRate × p × (1 - p)
 *
 * Для crypto-рынков:
 *   feeRate = 0.072
 *
 * Комиссия округляется до 5 знаков после запятой.
 * Всё меньше 0.00001 USDC считается нулём.
 */
import Decimal from 'decimal.js';

const CRYPTO_TAKER_FEE_RATE = new Decimal('0.072');
const MIN_FEE_USDC = new Decimal('0.00001');

/**
 * Рассчитывает taker fee на Polymarket для crypto-рынков.
 *
 * @param size - Размер ордера (в токенах)
 * @param price - Цена исполнения (0..1)
 * @returns Сумма комиссии в USDC (Decimal). Всегда >= 0.
 *
 * @remarks
 * MAKER fee = 0 — вызывающий код должен проверять trader_side
 * и вызывать эту функцию ТОЛЬКО для TAKER fills.
 *
 * @example
 * ```typescript
 * // TAKER fill: BUY 10 @ 0.50
 * const fee = calculatePolymarketTakerFee(new Decimal('10'), new Decimal('0.50'));
 * // fee = 10 × 0.072 × 0.50 × 0.50 = 0.18000
 * ```
 */
export function calculatePolymarketTakerFee(size: Decimal, price: Decimal): Decimal {
  if (size.lte(0) || price.lte(0) || price.gte(1)) {
    return new Decimal(0);
  }

  const rawFee = size
    .mul(CRYPTO_TAKER_FEE_RATE)
    .mul(price)
    .mul(new Decimal(1).minus(price));

  const roundedFee = rawFee.toDecimalPlaces(5, Decimal.ROUND_HALF_UP);
  return roundedFee.gte(MIN_FEE_USDC) ? roundedFee : new Decimal(0);
}
