import { Result } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';
import { Price } from '../core/Price.js';
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
export declare class PriceService {
    private static readonly SERVICE_NAME;
    /**
     * Константа для арифметических операций - избегаем создания new Decimal(1) каждый раз
     */
    private static readonly ONE;
    /**
     * Константа для арифметических операций - избегаем создания new Decimal(2) каждый раз
     */
    private static readonly TWO;
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
    static create(value: number | string | Decimal): Result<Price, InvalidPriceError>;
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
    static complement(price: Price): Result<Price, InvalidPriceError>;
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
    static average(price1: Price, price2: Price): Result<Price, InvalidPriceError>;
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
    static multiply(price: Price, factor: number | string | Decimal): Result<Price, InvalidPriceError>;
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
     * 2. Валидация divisor через ValidateDivisorForPriceDivision (isNaN, isFinite, isZero, isNegative)
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
    static divide(price: Price, divisor: number | string | Decimal): Result<Price, InvalidPriceError>;
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
    static roundToMarketTick(price: Price, tickSize: number | string | Decimal, mode?: 'nearest' | 'floor' | 'ceil'): Result<Price, InvalidPriceError>;
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
    static ensureAlignedToMarketTick(price: Price, tickSize: number | string | Decimal): Result<void, InvalidPriceError>;
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
    static applyRelativeChange(price: Price, ratio: Ratio, tickSize: number | string | Decimal, options?: {
        roundingMode?: 'nearest' | 'floor' | 'ceil';
    }): Result<Price, InvalidPriceError>;
}
//# sourceMappingURL=PriceService.d.ts.map