/**
 * Service facade для безопасного создания {@link ReferencePrice}.
 *
 * @remarks
 * ## Never Throw Contract
 * ВСЕ методы ГАРАНТИРУЮТ возврат `Result<T, E>` и НИКОГДА не бросают
 * исключения.
 *
 * ## Facade Error Contract
 * Каждый `Err` содержит context с полями:
 * - `context.reason`: {@link ReferencePriceErrorReason} (typed enum)
 * - `context.op`: string (название операции)
 * - `context.raw`: `{ field, value }` (значение, вызвавшее ошибку)
 * - `context.source`: ErrorSource
 *
 * ## Точность
 * Десятичная строка источника (`'79341.36626633028'`) парсится напрямую в
 * `Decimal`. Промежуточного JS `number` НЕТ — именно поэтому семантические
 * адаптеры обязаны передавать сюда исходную строку vendor-а, а не результат
 * `Number(...)`/`parseFloat(...)`.
 *
 * @example
 * ```typescript
 * import { ReferencePriceService } from '@polymarket/value-objects';
 *
 * const result = ReferencePriceService.create('79341.36626633028');
 * if (result.ok) {
 *   console.log(result.value.value().toString()); // "79341.36626633028"
 * } else {
 *   console.error(result.error.context.reason);
 * }
 * ```
 */
import Decimal from 'decimal.js';
import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidReferencePriceError, toDecimal, wrapOp, rewrap } from '@polymarket/errors';
import { ReferencePrice } from '../core/ReferencePrice.js';
import { ReferencePriceErrorReason } from '../errors/ReferencePriceErrorReason.js';

export class ReferencePriceService {
  private static readonly SERVICE_NAME = 'ReferencePriceService';

  /**
   * Создаёт {@link ReferencePrice} из десятичной строки, числа либо `Decimal`.
   *
   * @param value - Значение цены актива. Для vendor-данных ВСЕГДА передавай
   *   исходную десятичную строку — только так сохраняется точность источника
   * @returns `Ok(ReferencePrice)` либо `Err(InvalidReferencePriceError)` с
   *   типизированной причиной в `context.reason`
   * @throws Никогда — все ошибки оборачиваются в `Result`
   *
   * @remarks
   * Алгоритм:
   * 1. Парсинг входа в `Decimal` через `toDecimal()` (NaN → `NAN`,
   *    Infinity → `NON_FINITE`, мусор → `INVALID_FORMAT`).
   * 2. Создание VO через `ReferencePrice.of()` — Core проверяет инварианты
   *    и бросает `ReferencePriceInvariantViolation` при `<= 0`; `wrapOp`
   *    ловит его и превращает в `Err` с `reason: NOT_POSITIVE`.
   *
   * @example
   * ```typescript
   * ReferencePriceService.create('79341.36626633028'); // Ok
   * ReferencePriceService.create('0');                 // Err, reason NOT_POSITIVE
   * ReferencePriceService.create('-1');                // Err, reason NOT_POSITIVE
   * ReferencePriceService.create('nonsense');          // Err, reason INVALID_FORMAT
   * ```
   */
  public static create(
    value: number | string | Decimal,
  ): Result<ReferencePrice, InvalidReferencePriceError> {
    const decimalResult = toDecimal(
      'value',
      value,
      ReferencePriceErrorReason.INVALID_FORMAT,
      InvalidReferencePriceError,
      {
        nanReason: ReferencePriceErrorReason.NAN,
        nonFiniteReason: ReferencePriceErrorReason.NON_FINITE,
      },
    );
    if (isErr(decimalResult)) {
      return Err(
        rewrap(
          ReferencePriceService.SERVICE_NAME,
          'create',
          {},
          decimalResult.error,
          InvalidReferencePriceError,
        ),
      );
    }

    return wrapOp(
      ReferencePriceService.SERVICE_NAME,
      'create',
      { raw: { field: 'value', value: String(value) } },
      // Core получает уже готовый Decimal — только проверка инвариантов
      () => Ok(ReferencePrice.of(decimalResult.value)),
      InvalidReferencePriceError,
    );
  }
}
