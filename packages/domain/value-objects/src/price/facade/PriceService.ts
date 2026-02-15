import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidPriceError, toDecimal, rewrap, wrapOp } from '@polymarket/errors';
import { Price } from '../core/Price.js';
import { PriceErrorReason } from '../errors/PriceErrorReason.js';
import { ValidateTickSizeMultipleOfBaseTick } from '../rules/ValidateTickSizeMultipleOfBaseTick.js';
import { ValidateAligned } from '../rules/ValidateAligned.js';
import { ValidateFactorForPriceMultiplication } from '../rules/ValidateFactorForPriceMultiplication.js';
import { ValidateDivisorForPriceDivision } from '../rules/ValidateDivisorForPriceDivision.js';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick,
  floorToTick,
  ceilToTick
} from '@polymarket/math';
import Decimal from 'decimal.js';
import { Ratio } from '../../ratio/core/Ratio.js';

/**
 * Фасад для работы с Price - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с ценами.
 * Оркестрирует Core + Math + Rules.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы PriceService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из @polymarket/math, Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.price/dividend - входная цена (если применимо)
 * - context.divisor|factor|tickSize - входные параметры (если применимо)
 * - context.raw - сырой ввод (для ошибок парсинга): { field, value }
 * - context.cause - для math-исключений: { name, message, stack? } (root-cause, не перетирается)
 * - context.reason - для инвариантов Core (root, не перетирается)
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidPriceError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 *
 * @example
 * ```typescript
 * import { PriceService } from '@polymarket/value-objects/price';
 *
 * const result = PriceService.create(0.5);
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 0.5
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export class PriceService {
  private static readonly SERVICE_NAME = 'PriceService';

  /**
   * Константа для арифметических операций - избегаем создания new Decimal(1) каждый раз
   */
  private static readonly ONE = new Decimal(1);

  /**
   * Константа для арифметических операций - избегаем создания new Decimal(2) каждый раз
   */
  private static readonly TWO = new Decimal(2);

  /**
   * Создаёт Price из значения (безопасно - никогда не бросает)
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания Price.
   * Возвращает Result вместо исключений.
   *
   * Инварианты проверяются автоматически через Price.of():
   * - finite (не NaN, не Infinity)
   * - диапазон [0.0001, 0.9999]
   *
   * @param value - Значение цены (number, string, или Decimal)
   * @returns Result<Price, InvalidPriceError>
   *
   * @example
   * ```typescript
   * const result = PriceService.create(0.5);
   * if (isErr(result)) {
   *   console.error(result.error.context.value); // '0.5'
   *   return;
   * }
   * const price = result.value;
   * ```
   */
  public static create(
    value: number | string | Decimal
  ): Result<Price, InvalidPriceError> {
    // Безопасный парсинг value через toDecimal
    const decimalResult = toDecimal('value', value, PriceErrorReason.INVALID_FORMAT, InvalidPriceError);
    if (isErr(decimalResult)) {
      // raw уже внутри err.context.raw от toDecimal
      return Err(rewrap(PriceService.SERVICE_NAME, 'create', {}, decimalResult.error, InvalidPriceError));
    }

    return wrapOp(
      PriceService.SERVICE_NAME,
      'create',
      { raw: { field: 'value', value: String(value) } },
      () => {
        // ВАЖНО: Core получает уже Decimal -> только проверка инвариантов, не парсинг
        const price = Price.of(decimalResult.value);
        return Ok(price);
      },
      InvalidPriceError
    );
  }

  /**
   * Вычисляет дополнение цены до 1
   *
   * @remarks
   * complement(0.3) = 0.7
   * Используется для вычисления противоположной стороны бинарного маркета.
   *
   * Может вернуть Err если результат выходит за диапазон [0.0001, 0.9999].
   *
   * @param price - Исходная цена
   * @returns Result с дополнением или InvalidPriceError
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.3));
   * const result = PriceService.complement(price);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.7
   * }
   * ```
   */
  public static complement(price: Price): Result<Price, InvalidPriceError> {
    const ctx = { price: price.value().toString() };

    return wrapOp(PriceService.SERVICE_NAME, 'complement', ctx, () => {
      const result = subtractDecimal(this.ONE, price.value());
      return this.create(result); // wrapOp сам сделает rewrap если Err
    }, InvalidPriceError);
  }

  /**
   * Вычисляет среднее двух цен
   *
   * @remarks
   * average(0.2, 0.8) = 0.5
   * Используется для вычисления mid-price.
   *
   * @param price1 - Первая цена
   * @param price2 - Вторая цена
   * @returns Result со средним значением или InvalidPriceError
   *
   * @example
   * ```typescript
   * const p1 = expectOk(PriceService.create(0.2));
   * const p2 = expectOk(PriceService.create(0.8));
   * const result = PriceService.average(p1, p2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.5
   * }
   * ```
   */
  public static average(
    price1: Price,
    price2: Price
  ): Result<Price, InvalidPriceError> {
    const ctx = { price1: price1.value().toString(), price2: price2.value().toString() };

    return wrapOp(PriceService.SERVICE_NAME, 'average', ctx, () => {
      const sum = addDecimal(price1.value(), price2.value());
      const avgValue = divideDecimal(sum, this.TWO);
      return this.create(avgValue); // wrapOp сам сделает rewrap если Err
    }, InvalidPriceError);
  }

  /**
   * Умножает цену на множитель
   *
   * @remarks
   * multiply(0.5, 2) = 1.0 (выйдет за диапазон → Err)
   * multiply(0.3, 2) = 0.6
   *
   * Парсит factor через toDecimal, валидирует через rule, выполняет умножение.
   * ВСЕ ошибки (парсинг, валидация, math, инварианты) оборачиваются в InvalidPriceError.
   *
   * @param price - Исходная цена
   * @param factor - Множитель (number, string, или Decimal)
   * @returns Result с результатом или InvalidPriceError
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.3));
   * const result = PriceService.multiply(price, 2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.6
   * }
   * ```
   */
  public static multiply(
    price: Price,
    factor: number | string | Decimal
  ): Result<Price, InvalidPriceError> {
    // Безопасный парсинг factor через toDecimal
    const factorResult = toDecimal('factor', factor, PriceErrorReason.INVALID_FORMAT, InvalidPriceError);
    if (isErr(factorResult)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'multiply', {
          price: price.value().toString(),
          factor: String(factor)
        }, factorResult.error, InvalidPriceError)
      );
    }

    const factorDecimal = factorResult.value;

    // Валидация через rule (проверяет isNaN, isFinite)
    const validateResult = ValidateFactorForPriceMultiplication.check(factorDecimal);
    if (isErr(validateResult)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'multiply', {
          price: price.value().toString(),
          factor: factorDecimal.toString()
        }, validateResult.error, InvalidPriceError)
      );
    }

    // Умножение с обработкой ожидаемых арифметических исключений
    const ctx = {
      price: price.value().toString(),
      factor: factorDecimal.toString()
    };

    return wrapOp(PriceService.SERVICE_NAME, 'multiply', ctx, () => {
      const result = multiplyDecimal(price.value(), factorDecimal);
      return this.create(result); // wrapOp сам сделает rewrap если Err
    }, InvalidPriceError);
  }

  /**
   * Делит цену на делитель
   *
   * @param price - Исходная цена
   * @param divisor - Делитель (number, string, или Decimal)
   * @returns Result с результатом или InvalidPriceError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * divide(0.6, 2) = 0.3
   * divide(0.5, 0) → Err (проверка через ValidateDivisorForPriceDivision)
   *
   * Алгоритм:
   * 1. Парсинг divisor через toDecimal
   * 2. Валидация divisor через ValidateDivisorForPriceDivision (isNaN, isFinite, isZero)
   * 3. Деление через divideDecimal() из @polymarket/math
   * 4. Создание Price из результата
   *
   * ВСЕ ошибки (парсинг, валидация, math, инварианты) оборачиваются в InvalidPriceError.
   * Метод никогда не бросает исключения.
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.6));
   * const result = PriceService.divide(price, 2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.3
   * }
   * ```
   */
  public static divide(
    price: Price,
    divisor: number | string | Decimal
  ): Result<Price, InvalidPriceError> {
    // Безопасный парсинг divisor через toDecimal
    const divisorResult = toDecimal('divisor', divisor, PriceErrorReason.INVALID_FORMAT, InvalidPriceError);
    if (isErr(divisorResult)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'divide', {
          price: price.value().toString(),
          divisor: String(divisor)
        }, divisorResult.error, InvalidPriceError)
      );
    }

    const divisorDecimal = divisorResult.value;

    // Валидация через rule
    const validateResult = ValidateDivisorForPriceDivision.check(divisorDecimal);
    if (isErr(validateResult)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'divide', {
          price: price.value().toString(),
          divisor: divisorDecimal.toString()
        }, validateResult.error, InvalidPriceError)
      );
    }

    // Делим с обработкой ожидаемых арифметических исключений
    const ctx = {
      price: price.value().toString(),
      divisor: divisorDecimal.toString()
    };

    return wrapOp(PriceService.SERVICE_NAME, 'divide', ctx, () => {
      const result = divideDecimal(price.value(), divisorDecimal);
      return this.create(result); // wrapOp сам сделает rewrap если Err
    }, InvalidPriceError);
  }

  /**
   * Округляет цену до ближайшего тика
   *
   * @param price - Исходная цена
   * @param tickSize - Размер тика (number, string, или Decimal)
   * @param mode - Режим округления ('nearest' | 'floor' | 'ceil')
   * @returns Result с округлённой ценой или InvalidPriceError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * НЕ требует что price уже aligned.
   * Это функция округления, а не валидации.
   *
   * Режимы округления:
   * - nearest: к ближайшему тику (по умолчанию)
   * - floor: вниз — используй для bid price
   * - ceil: вверх — используй для ask price
   *
   * КОНТРАКТ: результат ДОЛЖЕН проходить ValidateAligned.check()
   *
   * Алгоритм:
   * 1. Парсинг tickSize через toDecimal
   * 2. Валидация tickSize через ValidateTickSizeMultipleOfBaseTick (кратность 0.0001)
   * 3. Выбор направления округления (nearest/floor/ceil)
   * 4. Округление через @polymarket/math функции (roundToTick/floorToTick/ceilToTick)
   * 5. Создание Price из округлённого значения
   *
   * ВСЕ ошибки (парсинг, валидация, math, инварианты) оборачиваются в InvalidPriceError.
   * Метод никогда не бросает исключения.
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.12345));
   * const result = PriceService.roundToMarketTick(price, 0.001);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.123
   * }
   * ```
   */
  public static roundToMarketTick(
    price: Price,
    tickSize: number | string | Decimal,
    mode: 'nearest' | 'floor' | 'ceil' = 'nearest'
  ): Result<Price, InvalidPriceError> {
    // Безопасный парсинг tickSize через toDecimal
    const tickDecimalResult = toDecimal('tickSize', tickSize, PriceErrorReason.INVALID_FORMAT, InvalidPriceError);
    if (isErr(tickDecimalResult)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'roundToMarketTick', {
          price: price.value().toString(),
          tickSize: String(tickSize),
          mode
        }, tickDecimalResult.error, InvalidPriceError)
      );
    }

    // Валидация через rule (уже принимает Decimal)
    const tickRes = ValidateTickSizeMultipleOfBaseTick.check(tickDecimalResult.value);
    if (isErr(tickRes)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'roundToMarketTick', {
          price: price.value().toString(),
          tickSize: tickDecimalResult.value.toString(),
          mode
        }, tickRes.error, InvalidPriceError)
      );
    }
    const tick = tickRes.value;

    const ctx = {
      price: price.value().toString(),
      tickSize: tick.toString(),
      mode
    };

    return wrapOp(PriceService.SERVICE_NAME, 'roundToMarketTick', ctx, () => {
      let out: Decimal;

      switch (mode) {
        case 'floor':
          out = floorToTick(price.value(), tick);
          break;

        case 'ceil':
          out = ceilToTick(price.value(), tick);
          break;

        case 'nearest':
        default:
          out = roundToTick(price.value(), tick, Decimal.ROUND_HALF_UP);
          break;
      }

      return this.create(out); // wrapOp сам сделает rewrap если Err
    }, InvalidPriceError);
  }

  /**
   * Проверяет что price кратен tickSize
   *
   * @remarks
   * Проверяет что price УЖЕ кратен tickSize.
   * Для округления используй roundToMarketTick().
   *
   * Используется для валидации после округления или
   * для проверки входящих данных.
   *
   * ВСЕ ошибки (парсинг tickSize, валидация, alignment) оборачиваются в InvalidPriceError.
   *
   * @param price - Цена для проверки
   * @param tickSize - Размер тика (number, string, или Decimal)
   * @returns Result<void> если кратен, InvalidPriceError если нет
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * const result = PriceService.ensureAlignedToMarketTick(price, 0.01);
   * if (result.ok) {
   *   console.log('Price aligned to tick size');
   * } else {
   *   console.error(result.error.context.reason); // 'not_aligned'
   * }
   * ```
   */
  public static ensureAlignedToMarketTick(
    price: Price,
    tickSize: number | string | Decimal
  ): Result<void, InvalidPriceError> {
    // Безопасный парсинг tickSize через toDecimal
    const tickDecimalResult = toDecimal('tickSize', tickSize, PriceErrorReason.INVALID_FORMAT, InvalidPriceError);
    if (isErr(tickDecimalResult)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'ensureAlignedToMarketTick', {
          price: price.value().toString(),
          tickSize: String(tickSize)
        }, tickDecimalResult.error, InvalidPriceError)
      );
    }

    // Валидация tickSize через ValidateTickSizeMultipleOfBaseTick (как в roundToMarketTick)
    const tickRes = ValidateTickSizeMultipleOfBaseTick.check(tickDecimalResult.value);
    if (isErr(tickRes)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'ensureAlignedToMarketTick', {
          price: price.value().toString(),
          tickSize: tickDecimalResult.value.toString()
        }, tickRes.error, InvalidPriceError)
      );
    }

    const tick = tickRes.value;

    // Проверка alignment
    const result = ValidateAligned.check(price, tick);
    if (isErr(result)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'ensureAlignedToMarketTick', {
          price: price.value().toString(),
          tickSize: tick.toString()
        }, result.error, InvalidPriceError)
      );
    }
    return result;
  }

  /**
   * Применяет относительное изменение (markup/markdown) к цене
   *
   * @remarks
   * Вычисляет новую цену как: `price * (1 + ratio)`
   *
   * **Примеры:**
   * - Markup +2%: `price * 1.02`
   * - Markdown -5%: `price * 0.95`
   *
   * **Округление к тику:**
   * Результат округляется с учётом режима:
   * - `nearest` (по умолчанию): к ближайшему тику
   * - `floor`: вниз — используй для агрессивных bid quotes
   * - `ceil`: вверх — используй для агрессивных ask quotes
   *
   * **Валидация:**
   * - Ratio может быть отрицательным (для markdown)
   * - Результат должен оставаться в диапазоне [MIN_PRICE, MAX_PRICE]
   * - Результат должен быть кратен tickSize после округления
   *
   * **Контракт "Never Throw":**
   * Все ошибки (парсинг, валидация, math, выход за границы) оборачиваются в InvalidPriceError.
   *
   * @param price - Исходная цена
   * @param ratio - Относительное изменение (например, 0.02 для +2%, -0.05 для -5%)
   * @param tickSize - Размер тика рынка
   * @param options - Опции округления
   * @returns Result с новой ценой или InvalidPriceError
   *
   * @example
   * ```typescript
   * import { PriceService, RatioService } from '@polymarket/value-objects';
   *
   * // Markup +2%
   * const price = expectOk(PriceService.create(0.50));
   * const markup = expectOk(RatioService.fromPercent(2));
   * const result = PriceService.applyRelativeChange(price, markup, 0.01);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.51 (0.50 * 1.02 = 0.51)
   * }
   *
   * // Markdown -5%
   * const markdown = expectOk(RatioService.fromPercent(-5));
   * const result2 = PriceService.applyRelativeChange(price, markdown, 0.01);
   * if (result2.ok) {
   *   console.log(result2.value.toNumber()); // 0.48 (0.50 * 0.95 = 0.475 → round to 0.48)
   * }
   *
   * // С округлением вниз (для bid)
   * const result3 = PriceService.applyRelativeChange(
   *   price, markup, 0.01, { roundingMode: 'floor' }
   * );
   *
   * // С округлением вверх (для ask)
   * const result4 = PriceService.applyRelativeChange(
   *   price, markup, 0.01, { roundingMode: 'ceil' }
   * );
   * ```
   */
  public static applyRelativeChange(
    price: Price,
    ratio: Ratio,
    tickSize: number | string | Decimal,
    options?: { roundingMode?: 'nearest' | 'floor' | 'ceil' }
  ): Result<Price, InvalidPriceError> {
    const roundingMode = options?.roundingMode ?? 'nearest';

    // Безопасный парсинг tickSize через toDecimal
    const tickDecimalResult = toDecimal('tickSize', tickSize, PriceErrorReason.INVALID_FORMAT, InvalidPriceError);
    if (isErr(tickDecimalResult)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'applyRelativeChange', {
          price: price.value().toString(),
          ratio: ratio.toDecimal().toString(),
          tickSize: String(tickSize),
          roundingMode
        }, tickDecimalResult.error, InvalidPriceError)
      );
    }

    // Валидация tickSize через ValidateTickSizeMultipleOfBaseTick
    const tickRes = ValidateTickSizeMultipleOfBaseTick.check(tickDecimalResult.value);
    if (isErr(tickRes)) {
      return Err(
        rewrap(PriceService.SERVICE_NAME, 'applyRelativeChange', {
          price: price.value().toString(),
          ratio: ratio.toDecimal().toString(),
          tickSize: tickDecimalResult.value.toString(),
          roundingMode
        }, tickRes.error, InvalidPriceError)
      );
    }
    const tick = tickRes.value;

    const ctx = {
      price: price.value().toString(),
      ratio: ratio.toDecimal().toString(),
      tickSize: tick.toString(),
      roundingMode
    };

    return wrapOp(PriceService.SERVICE_NAME, 'applyRelativeChange', ctx, () => {
      // Вычисляем новое значение: price * (1 + ratio)
      const multiplier = ratio.onePlus();
      const newValue = multiplyDecimal(price.value(), multiplier);

      // Округляем к тику с учётом режима
      let rounded: Decimal;
      switch (roundingMode) {
        case 'floor':
          rounded = floorToTick(newValue, tick);
          break;

        case 'ceil':
          rounded = ceilToTick(newValue, tick);
          break;

        case 'nearest':
        default:
          rounded = roundToTick(newValue, tick, Decimal.ROUND_HALF_UP);
          break;
      }

      // Создаём Price (автоматически проверит границы [MIN_PRICE, MAX_PRICE])
      return this.create(rounded);
    }, InvalidPriceError);
  }
}
