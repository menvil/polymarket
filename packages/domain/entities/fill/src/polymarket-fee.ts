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
 *
 * ### VO на публичной границе (Этап 3 плана миграции):
 * `calculatePolymarketTakerFee`/`calculatePolymarketTakerFeeWithRate` принимают
 * `Quantity`/`OutcomePrice` и возвращают `Fee` — по ADR (`docs/architecture/boundary-contract.md`,
 * Решение 1) голый `Decimal` на публичной сигнатуре легитимен только внутри
 * `value-objects`/`math`. `calculatePolymarketTakerFeeNumber` **не переводится** —
 * её сигнатура уже полностью на примитивах (`number`, не `Decimal`), уже ADR-совместима,
 * и у неё 11+ реальных потребителей в `apps/bot/strategies/*`/`apps/pnl`/`domain/cross-market`,
 * ожидающих `number`.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import { OutcomePrice, Quantity, Fee, AssetQuantity } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';

export const POLYMARKET_CRYPTO_TAKER_FEE_RATE = 0.072;
export const POLYMARKET_MIN_FEE_USDC = 0.00001;

const MIN_FEE_USDC = new Decimal(POLYMARKET_MIN_FEE_USDC);

/**
 * Рассчитывает taker fee на Polymarket для crypto-рынков.
 *
 * @param size - Размер ордера (Quantity VO)
 * @param price - Цена исполнения (OutcomePrice VO, диапазон [0.0001, 0.9999])
 * @returns Комиссия как `Fee` VO (валюта USDC). Всегда >= 0.
 *
 * @remarks
 * MAKER fee = 0 — вызывающий код должен проверять trader_side
 * и вызывать эту функцию ТОЛЬКО для TAKER fills.
 *
 * @example
 * ```typescript
 * // TAKER fill: BUY 10 @ 0.50
 * const fee = calculatePolymarketTakerFee(Quantity.of(new Decimal('10')), OutcomePrice.of(new Decimal('0.50')));
 * // fee.quantity.amount().value() = 0.18000 (10 × 0.072 × 0.50 × 0.50)
 * ```
 */
export function calculatePolymarketTakerFee(size: Quantity, price: OutcomePrice): Fee {
  return calculatePolymarketTakerFeeWithRate(size, price, POLYMARKET_CRYPTO_TAKER_FEE_RATE);
}

/**
 * Рассчитывает taker fee с явно заданным feeRate.
 *
 * @param size - Размер ордера (Quantity VO)
 * @param price - Цена исполнения (OutcomePrice VO)
 * @param feeRate - Ставка комиссии (доля, например 0.072); допускает голый `number`/`Decimal` —
 *   ставка не является отдельным VO в текущем коде, приходит из market metadata как примитив
 * @returns Комиссия как `Fee` VO (валюта USDC). Всегда >= 0.
 *
 * @remarks
 * Используется теми местами, где Polymarket отдаёт категорийный feeRate
 * из market metadata, но формула остаётся той же самой.
 *
 * @example
 * ```typescript
 * const fee = calculatePolymarketTakerFeeWithRate(size, price, 0.05);
 * ```
 */
export function calculatePolymarketTakerFeeWithRate(
  size: Quantity,
  price: OutcomePrice,
  feeRate: number | Decimal,
): Fee {
  const feeRateDecimal = new Decimal(feeRate);
  const sizeDecimal = size.value();
  const priceDecimal = price.value();

  if (sizeDecimal.lte(0) || priceDecimal.lte(0) || priceDecimal.gte(1) || feeRateDecimal.lte(0)) {
    return Fee.zero(AssetIdHelpers.USDC);
  }

  const rawFee = sizeDecimal
    .mul(feeRateDecimal)
    .mul(priceDecimal)
    .mul(new Decimal(1).minus(priceDecimal));

  const roundedFee = rawFee.toDecimalPlaces(5, Decimal.ROUND_HALF_UP);
  const finalFee = roundedFee.gte(MIN_FEE_USDC) ? roundedFee : new Decimal(0);

  return Fee.of(new AssetQuantity(AssetIdHelpers.USDC, Quantity.of(finalFee)));
}

/**
 * Рассчитывает taker fee на примитивах (number → number).
 *
 * @param size - Размер ордера
 * @param price - Цена исполнения
 * @param feeRate - Ставка комиссии (по умолчанию `POLYMARKET_CRYPTO_TAKER_FEE_RATE`)
 * @returns Комиссия в USDC как `number`
 *
 * @remarks
 * Сигнатура уже полностью на примитивах — не переводится на VO (см. докблок файла).
 * Используется для строчных вычислений/бэктестов в `apps/bot`/`apps/pnl`, где
 * весь остальной расчёт уже ведётся на `number`.
 *
 * Guard-проверки на невалидный вход (size/price вне диапазона, feeRate <= 0) выполняются
 * ЗДЕСЬ, на сырых значениях, ДО конструирования `Quantity`/`OutcomePrice` VO — эти VO бросают
 * исключение при значении вне инварианта (`OutcomePrice` — диапазон [0.0001, 0.9999]), а эта
 * функция должна сохранить прежний контракт "невалидный вход → тихо 0", не throw
 * (вызывающий код в `apps/bot`/`apps/pnl` полагается на graceful zero, не try/catch).
 *
 * @example
 * ```typescript
 * const feeDollars = calculatePolymarketTakerFeeNumber(10, 0.5);
 * // 0.18
 * ```
 */
export function calculatePolymarketTakerFeeNumber(
  size: number,
  price: number,
  feeRate: number = POLYMARKET_CRYPTO_TAKER_FEE_RATE,
): number {
  if (
    !Number.isFinite(size) || size <= 0 ||
    !Number.isFinite(price) || price <= 0 || price >= 1 ||
    !Number.isFinite(feeRate) || feeRate <= 0
  ) {
    return 0;
  }
  return calculatePolymarketTakerFeeWithRate(
    Quantity.of(new Decimal(size)),
    OutcomePrice.of(new Decimal(price)),
    feeRate,
  ).quantity.amount().value().toNumber();
}
