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
import type { PriceDomain, TickRoundingMode } from '../../shared/index.js';
import {
  applyRelativeChangeToPrice,
  averagePrices,
  dividePrice,
  ensurePriceAlignedToTick,
  multiplyPrice,
  roundPriceToTick,
} from '../../shared/index.js';
import { InvalidAssetPriceError, toDecimal, wrapOp, rewrap } from '@polymarket/errors';
import { AssetPrice } from '../core/AssetPrice.js';
import { AssetPriceErrorReason } from '../errors/AssetPriceErrorReason.js';

/**
 * Домен цены актива для общих операций над ценами.
 *
 * @remarks
 * Арифметика и выравнивание к тику берутся из `shared/price/priceOperations` —
 * они те же, что у рынка предсказаний. Различие ровно в этой записи:
 * фабрика проверяет результат инвариантом «строго положительно» (без
 * верхней границы), а ошибки сообщаются типом этого домена.
 *
 * Базовый тик здесь НЕ константа: у каждого инструмента биржи он свой и
 * приходит из market info, поэтому операции принимают его параметром.
 */
export const ASSET_PRICE_DOMAIN: PriceDomain<AssetPrice, InvalidAssetPriceError> = {
  serviceName: 'AssetPriceService',
  ErrorConstructor: InvalidAssetPriceError,
  invalidFormatReason: AssetPriceErrorReason.INVALID_FORMAT,
  create: (value) => AssetPriceService.create(value),
};

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

  /**
   * Умножает цену актива на множитель.
   *
   * @param price - Исходная цена
   * @param factor - Множитель
   * @returns Новая цена либо `InvalidAssetPriceError`
   * @throws Никогда — все ошибки в `Result`
   *
   * @example
   * ```typescript
   * AssetPriceService.multiply(price, 2); // 78468.5 → 156937
   * ```
   */
  public static multiply(
    price: AssetPrice,
    factor: number | string | Decimal,
  ): Result<AssetPrice, InvalidAssetPriceError> {
    return multiplyPrice(ASSET_PRICE_DOMAIN, price, factor);
  }

  /**
   * Делит цену актива на делитель.
   *
   * @param price - Исходная цена
   * @param divisor - Делитель
   * @returns Новая цена либо `InvalidAssetPriceError`
   * @throws Никогда — все ошибки в `Result`
   *
   * @remarks
   * Нулевой и отрицательный делитель отвергаются до самого деления.
   */
  public static divide(
    price: AssetPrice,
    divisor: number | string | Decimal,
  ): Result<AssetPrice, InvalidAssetPriceError> {
    return dividePrice(ASSET_PRICE_DOMAIN, price, divisor);
  }

  /**
   * Среднее двух цен актива.
   *
   * @param price1 - Первая цена
   * @param price2 - Вторая цена
   * @returns Средняя цена либо `InvalidAssetPriceError`
   * @throws Никогда — все ошибки в `Result`
   */
  public static average(
    price1: AssetPrice,
    price2: AssetPrice,
  ): Result<AssetPrice, InvalidAssetPriceError> {
    return averagePrices(ASSET_PRICE_DOMAIN, price1, price2);
  }

  /**
   * Округляет цену к сетке тика инструмента.
   *
   * @param price - Исходная цена
   * @param tickSize - Шаг сетки инструмента
   * @param baseTick - Базовый тик площадки (из market info биржи)
   * @param mode - Режим округления (по умолчанию `nearest`)
   * @returns Выровненная цена либо `InvalidAssetPriceError`
   * @throws Никогда — все ошибки в `Result`
   *
   * @remarks
   * В отличие от рынка предсказаний, где базовый тик один на всю площадку
   * (`0.0001`), у биржи он свой на КАЖДЫЙ инструмент — поэтому передаётся
   * параметром, а не берётся из константы.
   *
   * @example
   * ```typescript
   * AssetPriceService.roundToTick(price, '0.01', '0.00000001', 'floor');
   * ```
   */
  public static roundToTick(
    price: AssetPrice,
    tickSize: number | string | Decimal,
    baseTick: number | string | Decimal,
    mode: TickRoundingMode = 'nearest',
  ): Result<AssetPrice, InvalidAssetPriceError> {
    return roundPriceToTick(ASSET_PRICE_DOMAIN, price, tickSize, baseTick, mode);
  }

  /**
   * Проверяет, что цена лежит точно на сетке тика инструмента.
   *
   * @param price - Проверяемая цена
   * @param tickSize - Шаг сетки инструмента
   * @param baseTick - Базовый тик площадки
   * @returns `Ok(void)` либо `InvalidAssetPriceError`
   * @throws Никогда — все ошибки в `Result`
   *
   * @remarks
   * Нужна перед отправкой ордера: биржа отвергнет цену вне своей сетки, и
   * узнать об этом дешевле до отправки.
   */
  public static ensureAlignedToTick(
    price: AssetPrice,
    tickSize: number | string | Decimal,
    baseTick: number | string | Decimal,
  ): Result<void, InvalidAssetPriceError> {
    return ensurePriceAlignedToTick(ASSET_PRICE_DOMAIN, price, tickSize, baseTick);
  }

  /**
   * Применяет относительное изменение к цене и выравнивает к тику.
   *
   * @param price - Исходная цена
   * @param change - Изменение дробью (`0.02` = +2%)
   * @param tickSize - Шаг сетки инструмента
   * @param baseTick - Базовый тик площадки
   * @param mode - Режим округления (по умолчанию `nearest`)
   * @returns Новая цена либо `InvalidAssetPriceError`
   * @throws Никогда — все ошибки в `Result`
   */
  public static applyRelativeChange(
    price: AssetPrice,
    change: number | string | Decimal,
    tickSize: number | string | Decimal,
    baseTick: number | string | Decimal,
    mode: TickRoundingMode = 'nearest',
  ): Result<AssetPrice, InvalidAssetPriceError> {
    return applyRelativeChangeToPrice(ASSET_PRICE_DOMAIN, price, change, tickSize, baseTick, mode);
  }
}
