import { Result, Ok, Err } from '@polymarket/result';
import type { AnyTradingError, ErrorConstructor } from '@polymarket/errors';
import { InvalidTickSizeError, ErrorSource } from '@polymarket/errors';
import type { DecimalPrice } from './DecimalPrice.js';
import { ValidateTickSizeMultipleOfBaseTick } from './ValidateTickSizeMultipleOfBaseTick.js';
import type { AlignedErrorReason } from './priceRuleTypes.js';
import type Decimal from 'decimal.js';

/**
 * Правило: цена должна лежать точно на сетке тика.
 *
 * Работает в ЛЮБОМ ценовом домене: сама проверка — это `price % tick === 0`,
 * и о диапазоне цены она не знает. Доменным правило делает конструктор
 * ошибки, который передаётся вызывающим — так `reason: 'not_aligned'`
 * приходит потребителю в типе ЕГО домена.
 *
 * @remarks
 * КРИТИЧНАЯ ГАРАНТИЯ: после OutcomePriceService.roundToMarketTick()
 * результат ДОЛЖЕН проходить эту проверку.
 *
 * Проверяет что price кратен tickSize (price % tickSize === 0).
 * Использует div().isInteger() для стабильности на дробных числах.
 *
 * @example
 * ```typescript
 * // Домен исходов: базовый тик задан площадкой
 * const alignResult = ValidateAligned.check(
 *   outcomePrice,
 *   new Decimal(0.01),
 *   InvalidOutcomePriceError,
 *   new Decimal(0.0001),
 * );
 * if (!alignResult.ok) {
 *   console.error(alignResult.error.context.reason); // 'not_aligned'
 * }
 *
 * // Домен активов: свой шаг у каждого инструмента
 * ValidateAligned.check(assetPrice, new Decimal(0.01), InvalidAssetPriceError, new Decimal(0.01));
 * ```
 */
export class ValidateAligned {
  /**
   * Проверяет что price выровнен по tickSize
   *
   * @param price - Цена для проверки
   * @param tickSize - Размер тика (уже Decimal — парсинг делается в Facade)
   * @param ErrorConstructorRef - Конструктор ошибки ДОМЕНА цены: через него
   *   `not_aligned` приходит потребителю в его собственном типе
   * @param baseTick - Базовый тик домена: у Polymarket фиксирован площадкой
   *   (`0.0001`), у биржи свой на каждый инструмент
   * @param maxTickSize - Верхний предел тика, если он в домене есть
   * @returns `Ok(void)` либо `TError | InvalidTickSizeError`
   * @throws Никогда — все ошибки в `Result`
   *
   * @remarks
   * ВАЖНО: принимает только `Decimal`. Парсинг делается в Facade через `toDecimal()`.
   *
   * Выполняет две проверки:
   * 1. Валидация тика через `ValidateTickSizeMultipleOfBaseTick` (кратность базовому тику)
   * 2. Проверка кратности цены: `price % tickSize === 0` (через `div().isInteger()`)
   *
   * `InvalidTickSizeError` возвращается, если невалиден сам тик; ошибка домена —
   * если цена не легла на его сетку.
   *
   * @example
   * ```typescript
   * const base = new Decimal(0.0001);
   * const price = OutcomePrice.of(new Decimal(0.5));
   *
   * // ✅ Валидные комбинации
   * ValidateAligned.check(price, new Decimal(0.01), InvalidOutcomePriceError, base); // Ok
   * ValidateAligned.check(price, new Decimal(0.1), InvalidOutcomePriceError, base);  // Ok
   *
   * // ❌ Невалидные (не кратен)
   * ValidateAligned.check(price, new Decimal(0.3), InvalidOutcomePriceError, base);  // Err: not_aligned
   * ```
   */
  public static check<TError extends AnyTradingError>(
    price: DecimalPrice,
    tickSize: Decimal,
    ErrorConstructorRef: ErrorConstructor<TError>,
    baseTick: Decimal,
    maxTickSize?: Decimal,
  ): Result<void, TError | InvalidTickSizeError> {
    // Базовый тик и предел приходят от домена: у Polymarket они фиксированы
    // площадкой, у биржи — свои на каждый инструмент
    const tickResult = ValidateTickSizeMultipleOfBaseTick.check(tickSize, baseTick, maxTickSize);
    if (!tickResult.ok) {
      return Err(tickResult.error);
    }
    const tickDecimal = tickResult.value;

    // Проверка кратности через div().isInteger()
    const quotient = price.value().div(tickDecimal);
    if (!quotient.isInteger()) {
      return Err(
        new ErrorConstructorRef(
          (ctx) => `Price ${ctx.price} is not aligned to tick size ${ctx.tickSize}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              field: 'price',
              reason: 'not_aligned' as AlignedErrorReason,
              price: price.value().toString(),
              tickSize: tickDecimal.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
