import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidOutcomePriceError, toDecimal, rewrap, wrapOp } from '@polymarket/errors';
import { OutcomePrice } from '../core/OutcomePrice.js';
import { OutcomePriceErrorReason } from '../errors/OutcomePriceErrorReason.js';
import { ValidateAligned } from '../rules/ValidateAligned.js';
import { subtractDecimal } from '@polymarket/math';
import Decimal from 'decimal.js';
import type { Ratio } from '../../ratio/core/Ratio.js';
import type { PriceDomain, TickRoundingMode } from '../../shared/index.js';
import {
  applyRelativeChangeToPrice,
  averagePrices,
  dividePrice,
  multiplyPrice,
  roundPriceToTick,
} from '../../shared/index.js';

/**
 * Базовый тик рынка предсказаний Polymarket.
 *
 * @remarks
 * Совпадает с `OutcomePrice.MIN`: любой tickSize площадки обязан быть ему
 * кратен. Раньше значение было захардкожено внутри правил выравнивания —
 * именно поэтому логика не переносилась на биржевой домен, где тик свой на
 * каждый инструмент. Теперь оно передаётся параметром.
 */
const BASE_TICK = '0.0001';

/**
 * Фасад для работы с OutcomePrice - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с ценами.
 * Оркестрирует Core + Math + Rules.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы OutcomePriceService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
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
 * ВСЕ операции возвращают Result<T, InvalidOutcomePriceError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 *
 * @example
 * ```typescript
 * import { OutcomePriceService } from '@polymarket/value-objects/outcome-price';
 *
 * const result = OutcomePriceService.create(0.5);
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 0.5
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */

/**
 * Домен цены рынка предсказаний для общих операций над ценами.
 *
 * @remarks
 * Арифметика, тик и форматирование живут в `shared/priceOperations` — они
 * одинаковы для всех ценовых доменов. Доменным их делает эта запись:
 * фабрика проверяет результат инвариантом `[0.0001, 0.9999]`, а ошибки
 * сообщаются типом этого домена.
 */
const OUTCOME_PRICE_DOMAIN: PriceDomain<OutcomePrice, InvalidOutcomePriceError> = {
  serviceName: 'OutcomePriceService',
  ErrorConstructor: InvalidOutcomePriceError,
  invalidFormatReason: OutcomePriceErrorReason.INVALID_FORMAT,
  create: (value) => OutcomePriceService.create(value),
};

export class OutcomePriceService {
  private static readonly SERVICE_NAME = 'OutcomePriceService';

  /**
   * Константа для арифметических операций - избегаем создания new Decimal(1) каждый раз
   */
  private static readonly ONE = new Decimal(1);

  /**
   * Создаёт OutcomePrice из значения (безопасно - никогда не бросает)
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания OutcomePrice.
   * Возвращает Result вместо исключений.
   *
   * Инварианты проверяются автоматически через OutcomePrice.of():
   * - finite (не NaN, не Infinity)
   * - диапазон [0.0001, 0.9999]
   *
   * @param value - Значение цены (number, string, или Decimal)
   * @returns Result<OutcomePrice, InvalidOutcomePriceError>
   *
   * @example
   * ```typescript
   * const result = OutcomePriceService.create(0.5);
   * if (isErr(result)) {
   *   console.error(result.error.context.value); // '0.5'
   *   return;
   * }
   * const price = result.value;
   * ```
   */
  public static create(
    value: number | string | Decimal
  ): Result<OutcomePrice, InvalidOutcomePriceError> {
    // Безопасный парсинг value через toDecimal
    const decimalResult = toDecimal('value', value, OutcomePriceErrorReason.INVALID_FORMAT, InvalidOutcomePriceError);
    if (isErr(decimalResult)) {
      // raw уже внутри err.context.raw от toDecimal
      return Err(rewrap(OutcomePriceService.SERVICE_NAME, 'create', {}, decimalResult.error, InvalidOutcomePriceError));
    }

    return wrapOp(
      OutcomePriceService.SERVICE_NAME,
      'create',
      { raw: { field: 'value', value: String(value) } },
      () => {
        // ВАЖНО: Core получает уже Decimal -> только проверка инвариантов, не парсинг
        const price = OutcomePrice.of(decimalResult.value);
        return Ok(price);
      },
      InvalidOutcomePriceError
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
   * @returns Result с дополнением или InvalidOutcomePriceError
   *
   * @example
   * ```typescript
   * const price = expectOk(OutcomePriceService.create(0.3));
   * const result = OutcomePriceService.complement(price);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.7
   * }
   * ```
   */
  public static complement(price: OutcomePrice): Result<OutcomePrice, InvalidOutcomePriceError> {
    const ctx = { price: price.value().toString() };

    return wrapOp(OutcomePriceService.SERVICE_NAME, 'complement', ctx, () => {
      const result = subtractDecimal(this.ONE, price.value());
      return this.create(result); // wrapOp сам сделает rewrap если Err
    }, InvalidOutcomePriceError);
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
   * @returns Result со средним значением или InvalidOutcomePriceError
   *
   * @example
   * ```typescript
   * const p1 = expectOk(OutcomePriceService.create(0.2));
   * const p2 = expectOk(OutcomePriceService.create(0.8));
   * const result = OutcomePriceService.average(p1, p2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.5
   * }
   * ```
   */
  public static average(
    price1: OutcomePrice,
    price2: OutcomePrice
  ): Result<OutcomePrice, InvalidOutcomePriceError> {
    return averagePrices(OUTCOME_PRICE_DOMAIN, price1, price2);
  }

  /**
   * Умножает цену на множитель
   *
   * @remarks
   * multiply(0.5, 2) = 1.0 (выйдет за диапазон → Err)
   * multiply(0.3, 2) = 0.6
   *
   * Парсит factor через toDecimal, валидирует через rule, выполняет умножение.
   * ВСЕ ошибки (парсинг, валидация, math, инварианты) оборачиваются в InvalidOutcomePriceError.
   *
   * @param price - Исходная цена
   * @param factor - Множитель (number, string, или Decimal)
   * @returns Result с результатом или InvalidOutcomePriceError
   *
   * @example
   * ```typescript
   * const price = expectOk(OutcomePriceService.create(0.3));
   * const result = OutcomePriceService.multiply(price, 2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.6
   * }
   * ```
   */
  public static multiply(
    price: OutcomePrice,
    factor: number | string | Decimal
  ): Result<OutcomePrice, InvalidOutcomePriceError> {
    return multiplyPrice(OUTCOME_PRICE_DOMAIN, price, factor);
  }

  /**
   * Делит цену на делитель
   *
   * @param price - Исходная цена
   * @param divisor - Делитель (number, string, или Decimal)
   * @returns Result с результатом или InvalidOutcomePriceError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * divide(0.6, 2) = 0.3
   * divide(0.5, 0) → Err (проверка через ValidateDivisorForPriceDivision)
   *
   * Алгоритм:
   * 1. Парсинг divisor через toDecimal
   * 2. Валидация divisor через ValidateDivisorForPriceDivision (isNaN, isFinite, isZero, isNegative)
   * 3. Деление через divideDecimal() из @polymarket/math
   * 4. Создание OutcomePrice из результата
   *
   * ВСЕ ошибки (парсинг, валидация, math, инварианты) оборачиваются в InvalidOutcomePriceError.
   * Метод никогда не бросает исключения.
   *
   * @example
   * ```typescript
   * const price = expectOk(OutcomePriceService.create(0.6));
   * const result = OutcomePriceService.divide(price, 2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.3
   * }
   * ```
   */
  public static divide(
    price: OutcomePrice,
    divisor: number | string | Decimal
  ): Result<OutcomePrice, InvalidOutcomePriceError> {
    return dividePrice(OUTCOME_PRICE_DOMAIN, price, divisor);
  }

  /**
   * Округляет цену до ближайшего тика
   *
   * @param price - Исходная цена
   * @param tickSize - Размер тика (number, string, или Decimal)
   * @param mode - Режим округления ('nearest' | 'floor' | 'ceil')
   * @returns Result с округлённой ценой или InvalidOutcomePriceError
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
   * 5. Создание OutcomePrice из округлённого значения
   *
   * ВСЕ ошибки (парсинг, валидация, math, инварианты) оборачиваются в InvalidOutcomePriceError.
   * Метод никогда не бросает исключения.
   *
   * @example
   * ```typescript
   * const price = expectOk(OutcomePriceService.create(0.12345));
   * const result = OutcomePriceService.roundToMarketTick(price, 0.001);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.123
   * }
   * ```
   */
  public static roundToMarketTick(
    price: OutcomePrice,
    tickSize: number | string | Decimal,
    mode: TickRoundingMode = 'nearest'
  ): Result<OutcomePrice, InvalidOutcomePriceError> {
    return roundPriceToTick(OUTCOME_PRICE_DOMAIN, price, tickSize, BASE_TICK, mode, 'roundToMarketTick');
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
   * ВСЕ ошибки (парсинг tickSize, валидация, alignment) оборачиваются в InvalidOutcomePriceError.
   *
   * @param price - Цена для проверки
   * @param tickSize - Размер тика (number, string, или Decimal)
   * @returns Result<void> если кратен, InvalidOutcomePriceError если нет
   *
   * @example
   * ```typescript
   * const price = expectOk(OutcomePriceService.create(0.5));
   * const result = OutcomePriceService.ensureAlignedToMarketTick(price, 0.01);
   * if (result.ok) {
   *   console.log('OutcomePrice aligned to tick size');
   * } else {
   *   console.error(result.error.context.reason); // 'not_aligned'
   * }
   * ```
   */
  public static ensureAlignedToMarketTick(
    price: OutcomePrice,
    tickSize: number | string | Decimal
  ): Result<void, InvalidOutcomePriceError> {
    // Делегирует ПРЕДИКЦИОННОМУ правилу `ValidateAligned`, а не общей
    // `ensurePriceAlignedToTick`: правило типизировано `OutcomePrice` и несёт
    // доменные reason, на которые опираются потребители. Общая версия
    // существует для доменов, у которых своего правила нет (CEX).
    const tickDecimalResult = toDecimal(
      'tickSize',
      tickSize,
      OutcomePriceErrorReason.INVALID_FORMAT,
      InvalidOutcomePriceError,
    );
    if (isErr(tickDecimalResult)) {
      return Err(
        rewrap(
          'OutcomePriceService',
          'ensureAlignedToMarketTick',
          { price: price.value().toString(), tickSize: String(tickSize) },
          tickDecimalResult.error,
          InvalidOutcomePriceError,
        ),
      );
    }
    const aligned = ValidateAligned.check(price, tickDecimalResult.value);
    if (isErr(aligned)) {
      return Err(
        rewrap(
          'OutcomePriceService',
          'ensureAlignedToMarketTick',
          { price: price.value().toString(), tickSize: tickDecimalResult.value.toString() },
          aligned.error as InvalidOutcomePriceError,
          InvalidOutcomePriceError,
        ),
      );
    }
    return Ok(undefined);
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
   * Все ошибки (парсинг, валидация, math, выход за границы) оборачиваются в InvalidOutcomePriceError.
   *
   * @param price - Исходная цена
   * @param ratio - Относительное изменение (например, 0.02 для +2%, -0.05 для -5%)
   * @param tickSize - Размер тика рынка
   * @param options - Опции округления
   * @returns Result с новой ценой или InvalidOutcomePriceError
   *
   * @example
   * ```typescript
   * import { OutcomePriceService, RatioService } from '@polymarket/value-objects';
   *
   * // Markup +2%
   * const price = expectOk(OutcomePriceService.create(0.50));
   * const markup = expectOk(RatioService.fromPercent(2));
   * const result = OutcomePriceService.applyRelativeChange(price, markup, 0.01);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.51 (0.50 * 1.02 = 0.51)
   * }
   *
   * // Markdown -5%
   * const markdown = expectOk(RatioService.fromPercent(-5));
   * const result2 = OutcomePriceService.applyRelativeChange(price, markdown, 0.01);
   * if (result2.ok) {
   *   console.log(result2.value.toNumber()); // 0.48 (0.50 * 0.95 = 0.475 → round to 0.48)
   * }
   *
   * // С округлением вниз (для bid)
   * const result3 = OutcomePriceService.applyRelativeChange(
   *   price, markup, 0.01, { roundingMode: 'floor' }
   * );
   *
   * // С округлением вверх (для ask)
   * const result4 = OutcomePriceService.applyRelativeChange(
   *   price, markup, 0.01, { roundingMode: 'ceil' }
   * );
   * ```
   */
  public static applyRelativeChange(
    price: OutcomePrice,
    ratio: Ratio,
    tickSize: number | string | Decimal,
    options?: { roundingMode?: TickRoundingMode }
  ): Result<OutcomePrice, InvalidOutcomePriceError> {
    return applyRelativeChangeToPrice(
      OUTCOME_PRICE_DOMAIN,
      price,
      ratio.toDecimal(),
      tickSize,
      BASE_TICK,
      options?.roundingMode ?? 'nearest',
    );
  }
}
