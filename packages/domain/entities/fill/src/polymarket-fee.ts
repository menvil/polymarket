/**
 * Расчёт taker-комиссии на Polymarket в USDC-equivalent.
 *
 * @remarks
 * Формула площадки (docs.polymarket.com/trading/fees):
 *   fee = C × feeRate × p × (1 - p)
 *
 * Для crypto-рынков `feeRate = 0.07`.
 *
 * **Ставку платит только TAKER.** Мейкер не платит никогда — это прямо
 * сказано в документации и подтверждено замером: позиции, закрытые
 * мейкерскими филами, дают нулевую разницу с `realizedPnl` площадки.
 *
 * Комиссия считается в USDC (не в токенах), округляется до 5 знаков,
 * всё меньше 0.00001 USDC считается нулём.
 *
 * ### Чем она удерживается
 *
 * Платится из ТОГО, ЧТО ПОЛУЧАЕМ, а количество токенов не трогается никогда:
 *
 * ```text
 * BUY  тейкер   отдаём  номинал + fee    получаем ПОЛНЫЕ size шар
 * SELL тейкер   получаем номинал − fee   отдаём  ПОЛНЫЕ size шар
 * мейкер        ровно номинал            комиссии нет
 * ```
 *
 * Измерено на публичной ленте активности, 2898 реальных сделок: `amount`
 * (фактически перемещённый USDC) расходится с `size × price` ровно на
 * комиссию, со знаком по стороне. Совпадение с формулой точное:
 *
 * ```text
 * size 20, p 0.50  fee 0.35000   20 × 0.07 × 0.50 × 0.50 = 0.35000
 * size 20, p 0.38  fee 0.32984   20 × 0.07 × 0.38 × 0.62 = 0.32984
 * size  5, p 0.47  fee 0.08718    5 × 0.07 × 0.47 × 0.53 = 0.087185
 * ```
 *
 * Нулевые расхождения (1857 покупок и 732 продажи) — мейкерские филы.
 *
 * **Комиссия НЕ уменьшает количество полученных шар.** Расчёт вида
 * `feeInTokens = feeUSDC / price` описывает механизм, которого не существует;
 * ни одна из 1888 покупок не показала уменьшенного количества. Экономика
 * исполнения уже выражена дельтами самого `Fill` — `getSignedQuantity()`
 * (валовое количество) и `getNetCashFlow()` (деньги с учётом комиссии), — и
 * потребителю следует применять их, а не пересчитывать.
 *
 * ### Откуда взялась ставка
 * Здесь стояло `0.072` — величина, не совпадающая ни с документацией, ни с
 * фактическими списаниями. Проверено на 28 закрытых позициях: отношение
 * (наша арифметика − `realizedPnl`) к базе `p × (1 - p) × size` держится на
 * **0.0700–0.0704**, тогда как 0.072 завышает комиссию примерно на 2.9%.
 *
 * Ставку **нельзя** брать из ответов API:
 * - `feeRateBps` в записи сделки приходит `"0"` — поле не заполняется;
 * - `taker_base_fee`/`maker_base_fee` рынка равны `1000`, что противоречит
 *   и замеру, и правилу «мейкер не платит»; это конфигурационный потолок,
 *   а не эффективная ставка.
 *
 * ### VO на публичной границе (Этап 3 плана миграции):
 * `calculatePolymarketTakerFee`/`calculatePolymarketTakerFeeWithRate` принимают
 * `Quantity`/`OutcomePrice` и возвращают `Fee` — по ADR (`docs/architecture/boundary-contract.md`,
 * Решение 1) голый `Decimal` на публичной сигнатуре легитимен только внутри
 * `value-objects`/`math`. `calculatePolymarketTakerFeeNumber` остаётся на примитивах:
 * её потребители (`domain/cross-market`, `apps/pnl`) заворачивают результат в VO у
 * себя, на границе своего слоя — см. ADR, Решение 14. Прежнее обоснование ссылалось
 * на удалённые приложения и больше не соответствует действительности.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import { OutcomePrice, Quantity, Fee, AssetQuantity } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';

export const POLYMARKET_CRYPTO_TAKER_FEE_RATE = 0.07;
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
 * // fee.quantity.amount().value() = 0.17500 (10 × 0.07 × 0.50 × 0.50)
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
 * @param feeRate - Ставка комиссии (доля, например 0.07); допускает голый `number`/`Decimal` —
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
 * Используется для строчных вычислений/бэктестов, где
 * весь остальной расчёт уже ведётся на `number`.
 *
 * Guard-проверки на невалидный вход (size/price вне диапазона, feeRate <= 0) выполняются
 * ЗДЕСЬ, на сырых значениях, ДО конструирования `Quantity`/`OutcomePrice` VO — эти VO бросают
 * исключение при значении вне инварианта (`OutcomePrice` — диапазон [0.0001, 0.9999]), а эта
 * функция должна сохранить прежний контракт "невалидный вход → тихо 0", не throw
 * (вызывающий код полагался на graceful zero, не try/catch).
 *
 * @example
 * ```typescript
 * const feeDollars = calculatePolymarketTakerFeeNumber(10, 0.5);
 * // 0.175
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
