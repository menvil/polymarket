/**
 * Service facade для безопасного создания {@link AssetPrice}.
 *
 * @remarks
 * ## Never Throw Contract
 * ВСЕ методы ГАРАНТИРУЮТ возврат `Result<T, E>` и НИКОГДА не бросают
 * исключения.
 *
 * ## Facade Error Contract
 * Каждый `Err` содержит context с полями:
 * - `context.reason`: {@link AssetPriceErrorReason} (typed enum)
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
 * import { AssetPriceService } from '@polymarket/value-objects';
 *
 * const result = AssetPriceService.create('79341.36626633028');
 * if (result.ok) {
 *   console.log(result.value.value().toString()); // "79341.36626633028"
 * } else {
 *   console.error(result.error.context.reason);
 * }
 * ```
 */
import Decimal from 'decimal.js';
import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidAssetPriceError, toDecimal, wrapOp, rewrap } from '@polymarket/errors';
import { AssetPrice } from '../core/AssetPrice.js';
import { AssetPriceErrorReason } from '../errors/AssetPriceErrorReason.js';

export class AssetPriceService {
  private static readonly SERVICE_NAME = 'AssetPriceService';

  /**
   * Создаёт {@link AssetPrice} из десятичной строки, числа либо `Decimal`.
   *
   * @param value - Значение цены актива. Для vendor-данных ВСЕГДА передавай
   *   исходную десятичную строку — только так сохраняется точность источника
   * @returns `Ok(AssetPrice)` либо `Err(InvalidAssetPriceError)` с
   *   типизированной причиной в `context.reason`
   * @throws Никогда — все ошибки оборачиваются в `Result`
   *
   * @remarks
   * Алгоритм:
   * 1. Парсинг входа в `Decimal` через `toDecimal()` (NaN → `NAN`,
   *    Infinity → `NON_FINITE`, мусор → `INVALID_FORMAT`).
   * 2. Создание VO через `AssetPrice.of()` — Core проверяет инварианты
   *    и бросает `AssetPriceInvariantViolation` при `<= 0`; `wrapOp`
   *    ловит его и превращает в `Err` с `reason: NOT_POSITIVE`.
   *
   * @example
   * ```typescript
   * AssetPriceService.create('79341.36626633028'); // Ok
   * AssetPriceService.create('0');                 // Err, reason NOT_POSITIVE
   * AssetPriceService.create('-1');                // Err, reason NOT_POSITIVE
   * AssetPriceService.create('nonsense');          // Err, reason INVALID_FORMAT
   * ```
   */
  public static create(
    value: number | string | Decimal,
  ): Result<AssetPrice, InvalidAssetPriceError> {
    const decimalResult = toDecimal(
      'value',
      value,
      AssetPriceErrorReason.INVALID_FORMAT,
      InvalidAssetPriceError,
      {
        nanReason: AssetPriceErrorReason.NAN,
        nonFiniteReason: AssetPriceErrorReason.NON_FINITE,
      },
    );
    if (isErr(decimalResult)) {
      return Err(
        rewrap(
          AssetPriceService.SERVICE_NAME,
          'create',
          {},
          decimalResult.error,
          InvalidAssetPriceError,
        ),
      );
    }

    return wrapOp(
      AssetPriceService.SERVICE_NAME,
      'create',
      { raw: { field: 'value', value: String(value) } },
      // Core получает уже готовый Decimal — только проверка инвариантов
      () => Ok(AssetPrice.of(decimalResult.value)),
      InvalidAssetPriceError,
    );
  }
}
