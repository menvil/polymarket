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

export const POLYMARKET_CRYPTO_TAKER_FEE_RATE = 0.072;
export const POLYMARKET_MIN_FEE_USDC = 0.00001;

const MIN_FEE_USDC = new Decimal(POLYMARKET_MIN_FEE_USDC);

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
  return calculatePolymarketTakerFeeWithRate(size, price, POLYMARKET_CRYPTO_TAKER_FEE_RATE);
}

/**
 * Рассчитывает taker fee с явно заданным feeRate.
 *
 * Используется теми местами, где Polymarket отдаёт категорийный feeRate
 * из market metadata, но формула остаётся той же самой.
 */
export function calculatePolymarketTakerFeeWithRate(
  size: Decimal,
  price: Decimal,
  feeRate: number | Decimal,
): Decimal {
  const feeRateDecimal = new Decimal(feeRate);
  if (size.lte(0) || price.lte(0) || price.gte(1) || feeRateDecimal.lte(0)) {
    return new Decimal(0);
  }

  const rawFee = size
    .mul(feeRateDecimal)
    .mul(price)
    .mul(new Decimal(1).minus(price));

  const roundedFee = rawFee.toDecimalPlaces(5, Decimal.ROUND_HALF_UP);
  return roundedFee.gte(MIN_FEE_USDC) ? roundedFee : new Decimal(0);
}

export function calculatePolymarketTakerFeeNumber(
  size: number,
  price: number,
  feeRate: number = POLYMARKET_CRYPTO_TAKER_FEE_RATE,
): number {
  return calculatePolymarketTakerFeeWithRate(
    new Decimal(size),
    new Decimal(price),
    feeRate,
  ).toNumber();
}
