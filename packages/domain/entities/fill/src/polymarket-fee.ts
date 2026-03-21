/**
 * Расчёт комиссии на Polymarket.
 *
 * @remarks
 * На Polymarket комиссию платит только TAKER. MAKER fee = 0.
 *
 * Формула для crypto-рынков:
 *   feeUSDC = C × p × feeRate × (p × (1 - p))^exponent
 *
 * Параметры по типу рынка (из документации Polymarket):
 *   Crypto:  feeRate = 0.25,   exponent = 2
 *   Sports:  feeRate = 0.0175, exponent = 1
 *
 * На данный момент все торгуемые рынки — crypto.
 * TODO: параметризовать по типу рынка для поддержки sports-рынков.
 *
 * FUTURE: Этот файл переедет в infrastructure/polymarket/ вместе с FillMapper
 * при разделении на PolymarketTradeEventParser + FillSnapshotMapper.
 */
import Decimal from 'decimal.js';

/** Параметры комиссии для crypto-рынков Polymarket */
const CRYPTO_FEE_RATE = new Decimal('0.25');
const CRYPTO_FEE_EXPONENT = 2;

/**
 * Рассчитывает TAKER fee на Polymarket для crypto-рынков.
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
 * // fee = 10 × 0.50 × 0.25 × (0.50 × 0.50)^2 = 0.078125
 * ```
 */
export function calculatePolymarketTakerFee(size: Decimal, price: Decimal): Decimal {
  const pq = price.mul(new Decimal(1).minus(price));
  return size.mul(price).mul(CRYPTO_FEE_RATE).mul(pq.pow(CRYPTO_FEE_EXPONENT));
}
