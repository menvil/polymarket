import { type Result } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { Price } from '../../price/index.js';
import { Spread } from '../core/index.js';
import { Ratio } from '../../ratio/index.js';
/**
 * Фасад для работы с Spread - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций со спредами.
 * Оркестрирует Core + Math + Rules.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы SpreadService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из @polymarket/math, Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.bid/ask - входные цены (если применимо)
 * - context.spread - входной spread (если применимо)
 * - context.amount - входная величина операции (если применимо)
 * - context.cause - для math-исключений: { name, message, stack? } (root-cause, не перетирается)
 * - context.reason - для инвариантов Core (SpreadErrorReason enum)
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidSpreadError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 * Все внутренние ошибки (InvalidPriceError, InvalidRatioError) преобразуются в InvalidSpreadError через rewrap
 *
 * @example
 * ```typescript
 * import { SpreadService } from '@polymarket/value-objects/spread';
 * import { PriceService } from '@polymarket/value-objects/price';
 *
 * const bidResult = PriceService.create(0.48);
 * const askResult = PriceService.create(0.52);
 * if (isErr(bidResult) || isErr(askResult)) {
 *   // handle error
 * }
 *
 * const result = SpreadService.create(bidResult.value, askResult.value);
 * if (result.ok) {
 *   console.log(result.value.width()); // Decimal(0.04)
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export declare class SpreadService {
    private static readonly SERVICE_NAME;
    /**
     * Создать Spread из Price объектов
     *
     * @param bid - Bid price
     * @param ask - Ask price
     * @returns Result со Spread или InvalidSpreadError
     *
     * @remarks
     * Валидирует что bid <= ask через Rules перед созданием Core объекта.
     * Ловит SpreadInvariantViolation из Core и преобразует в Result.Err.
     *
     * @example
     * ```typescript
     * const bidResult = PriceService.create(0.48);
     * const askResult = PriceService.create(0.52);
     * if (isErr(bidResult) || isErr(askResult)) return;
     *
     * const result = SpreadService.create(bidResult.value, askResult.value);
     * if (result.ok) {
     *   console.log(result.value.width()); // Decimal(0.04)
     * } else {
     *   console.error(result.error.context); // { op, bid, ask, reason?, cause? }
     * }
     * ```
     */
    static create(bid: Price, ask: Price): Result<Spread, InvalidSpreadError>;
    /**
     * Создать Spread из числовых значений
     *
     * @param bidValue - Значение bid
     * @param askValue - Значение ask
     * @returns Result со Spread или InvalidSpreadError
     *
     * @example
     * ```typescript
     * const result = SpreadService.fromValues(0.48, 0.52);
     * if (result.ok) {
     *   const spread = result.value;
     *   console.log(spread.width()); // Decimal(0.04)
     * }
     * ```
     */
    static fromValues(bidValue: number | string | Decimal, askValue: number | string | Decimal): Result<Spread, InvalidSpreadError>;
    /**
     * Создать spread с нулевой шириной
     *
     * @param price - Цена для bid и ask
     * @returns Spread с нулевой шириной
     *
     * @remarks
     * **Исключение из контракта "Never Throw"**: этот метод возвращает Spread напрямую
     * (не Result), поскольку нулевой spread из валидного Price гарантированно валиден.
     * Все остальные методы SpreadService возвращают Result.
     *
     * @example
     * ```typescript
     * const priceResult = PriceService.create(0.50);
     * if (priceResult.ok) {
     *   const spread = SpreadService.zero(priceResult.value);
     *   console.log(spread.width().toNumber()); // 0
     * }
     * ```
     */
    static zero(price: Price): Spread;
    /**
     * Создать Spread от midpoint и относительной ширины
     *
     * @param mid - Midpoint цена (Price | Decimal | number | string)
     * @param widthRatio - Относительная ширина как Ratio (Ratio | Decimal | number | string)
     * @returns Result со Spread или InvalidSpreadError
     *
     * @remarks
     * **Алгоритм:**
     * 1. Parse mid to Price
     * 2. Parse widthRatio to Ratio
     * 3. Validate widthRatio >= 0
     * 4. widthAbs = mid * widthRatio
     * 5. half = widthAbs / 2
     * 6. bid = mid - half
     * 7. ask = mid + half
     * 8. Create spread через create(bid, ask)
     *
     * **Validation:**
     * - widthRatio должен быть >= 0 (отрицательная ширина запрещена)
     * - Результирующие bid/ask должны быть в пределах [MIN_PRICE, MAX_PRICE]
     *
     * **Never Throw Contract:**
     * Гарантированно возвращает Result, никогда не бросает.
     *
     * @example
     * ```typescript
     * // Создать spread с mid=0.50, width=8% от mid
     * const result = SpreadService.fromMidAndWidthRatio(
     *   0.50,
     *   Ratio.of(new Decimal(0.08))
     * );
     *
     * if (result.ok) {
     *   const spread = result.value;
     *   console.log(spread.bid().value().toString());  // "0.48" (0.50 - 0.02)
     *   console.log(spread.ask().value().toString());  // "0.52" (0.50 + 0.02)
     *   console.log(spread.width().toString());        // "0.04" (0.50 * 0.08)
     * }
     *
     * // Из чисел
     * const result2 = SpreadService.fromMidAndWidthRatio(0.50, 0.08);
     * ```
     */
    static fromMidAndWidthRatio(mid: Price | Decimal | number | string, widthRatio: Ratio | Decimal | number | string): Result<Spread, InvalidSpreadError>;
    /**
     * Сузить spread (bid ↑, ask ↓)
     *
     * @param spread - Исходный spread
     * @param amount - Величина сужения (должна быть >= 0)
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Операция:**
     * - Сдвигает bid вверх на amount: `newBid = bid + amount`
     * - Сдвигает ask вниз на amount: `newAsk = ask - amount`
     * - Результат: ширина уменьшается на `2 * amount`
     *
     * **Boundary behavior:**
     * - Если `amount > width/2`, автоматически ограничивается до `width/2`
     * - Минимальная ширина результата: 0 (zero-width spread)
     * - Если новые цены выходят за [MIN_PRICE, MAX_PRICE], возвращает Err
     *
     * **Immutability:**
     * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
     *
     * **Validation:**
     * - amount должен быть finite
     * - amount должен быть non-negative
     * - amount может быть 0 (возвращает эквивалентный spread)
     *
     * @example
     * ```typescript
     * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
     *
     * // Нормальное сужение
     * const tightened = SpreadService.tighten(spread, new Decimal(0.01));
     * if (tightened.ok) {
     *   console.log(tightened.value.bid().value()); // 0.49
     *   console.log(tightened.value.ask().value()); // 0.51
     *   console.log(tightened.value.width()); // 0.02
     * }
     *
     * // Сужение > width/2 → zero-width spread
     * const collapsed = SpreadService.tighten(spread, new Decimal(0.05));
     * if (collapsed.ok) {
     *   console.log(collapsed.value.width().toNumber()); // 0
     *   console.log(collapsed.value.bid().equals(collapsed.value.ask())); // true
     * }
     * ```
     */
    static tighten(spread: Spread, amount: Decimal | number | string): Result<Spread, InvalidSpreadError>;
    /**
     * Сузить spread на процент от текущей ширины
     *
     * @param spread - Исходный spread
     * @param ratio - Процент сужения как Ratio (например, 10% = Ratio.fromPercent(10))
     * @param options - Опции для валидации Ratio
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Операция:**
     * - Вычисляет текущую ширину: `currentWidth = ask - bid`
     * - Вычисляет уменьшение: `decrease = currentWidth * ratio`
     * - Сужает на половину с каждой стороны: `tighten(spread, decrease / 2)`
     *
     * **Отличие от tighten():**
     * - `tighten(spread, 0.01)` - сузить на абсолютную величину 0.01
     * - `tightenBy(spread, Ratio.fromPercent(10))` - сузить на 10% от текущей ширины
     *
     * **Валидация:**
     * - ratio должен быть валидным Ratio
     * - Опциональная ensureLteOne: гарантировать ratio <= 1 (не можем сузить > 100%)
     *
     * **Boundary behavior:**
     * - Если decrease > текущая ширина, spread сжимается до минимума (bid = ask = mid)
     * - Делегируется в tighten(), который ограничивает amount до halfWidth
     *
     * @example
     * ```typescript
     * const spread = unwrap(SpreadService.fromValues(0.48, 0.52)); // width = 0.04
     *
     * // Сузить на 25%
     * const ratio = unwrap(RatioService.fromPercent(25));
     * const tightened = SpreadService.tightenBy(spread, ratio);
     * if (tightened.ok) {
     *   // decrease = 0.04 * 0.25 = 0.01
     *   // tighten each side by 0.005
     *   console.log(tightened.value.bid().value()); // 0.485
     *   console.log(tightened.value.ask().value()); // 0.515
     *   console.log(tightened.value.width());       // 0.03
     * }
     * ```
     */
    static tightenBy(spread: Spread, ratio: Decimal | number | string, options?: {
        ensureLteOne?: boolean;
    }): Result<Spread, InvalidSpreadError>;
    /**
     * Расширить spread (bid ↓, ask ↑)
     *
     * @param spread - Исходный spread
     * @param amount - Величина расширения (должна быть >= 0)
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Операция:**
     * - Сдвигает bid вниз на amount: `newBid = bid - amount`
     * - Сдвигает ask вверх на amount: `newAsk = ask + amount`
     * - Результат: ширина увеличивается на `2 * amount`
     *
     * **Boundary behavior:**
     * - Если новые цены выходят за [MIN_PRICE, MAX_PRICE], возвращает Err
     * - Нет автоматического ограничения amount (в отличие от tighten)
     * - Максимальная ширина результата: `MAX_PRICE - MIN_PRICE`
     *
     * **Immutability:**
     * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
     *
     * **Validation:**
     * - amount должен быть finite
     * - amount должен быть non-negative
     * - amount может быть 0 (возвращает эквивалентный spread)
     *
     * @example
     * ```typescript
     * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
     *
     * // Нормальное расширение
     * const widened = SpreadService.widen(spread, new Decimal(0.02));
     * if (widened.ok) {
     *   console.log(widened.value.bid().value()); // 0.46
     *   console.log(widened.value.ask().value()); // 0.54
     *   console.log(widened.value.width()); // 0.08
     * }
     *
     * // Расширение за границы → Err
     * const tooWide = SpreadService.widen(spread, new Decimal(0.5));
     * console.log(tooWide.ok); // false (bid < MIN_PRICE или ask > MAX_PRICE)
     * ```
     */
    static widen(spread: Spread, amount: Decimal | number | string): Result<Spread, InvalidSpreadError>;
    /**
     * Расширить spread на процент от текущей ширины
     *
     * @param spread - Исходный spread
     * @param ratio - Процент расширения как Ratio (например, 10% = Ratio.fromPercent(10))
     * @param options - Опции для валидации Ratio
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Операция:**
     * - Вычисляет текущую ширину: `currentWidth = ask - bid`
     * - Вычисляет увеличение: `increase = currentWidth * ratio`
     * - Расширяет на половину с каждой стороны: `widen(spread, increase / 2)`
     *
     * **Отличие от widen():**
     * - `widen(spread, 0.01)` - расширить на абсолютную величину 0.01
     * - `widenBy(spread, Ratio.fromPercent(10))` - расширить на 10% от текущей ширины
     *
     * **Валидация:**
     * - ratio должен быть валидным Ratio
     * - Опциональная ensureGteMinusOne: гарантировать ratio >= -1
     *
     * @example
     * ```typescript
     * const spread = unwrap(SpreadService.fromValues(0.48, 0.52)); // width = 0.04
     *
     * // Расширить на 25%
     * const ratio = unwrap(RatioService.fromPercent(25));
     * const widened = SpreadService.widenBy(spread, ratio);
     * if (widened.ok) {
     *   // increase = 0.04 * 0.25 = 0.01
     *   // widen each side by 0.005
     *   console.log(widened.value.bid().value()); // 0.475
     *   console.log(widened.value.ask().value()); // 0.525
     *   console.log(widened.value.width());       // 0.05
     * }
     * ```
     */
    static widenBy(spread: Spread, ratio: Decimal | number | string, options?: {
        ensureGteMinusOne?: boolean;
    }): Result<Spread, InvalidSpreadError>;
    /**
     * Сдвинуть spread вверх или вниз
     *
     * @param spread - Исходный spread
     * @param amount - Величина сдвига (+ вверх, - вниз, может быть отрицательным)
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Операция:**
     * - Сдвигает bid на amount: `newBid = bid + amount`
     * - Сдвигает ask на amount: `newAsk = ask + amount`
     * - Результат: ширина сохраняется `width = ask - bid` (unchanged)
     *
     * **Boundary behavior:**
     * - Если новые цены выходят за [MIN_PRICE, MAX_PRICE], возвращает Err
     * - amount может быть отрицательным (сдвиг вниз)
     * - amount может быть 0 (возвращает эквивалентный spread)
     *
     * **Immutability:**
     * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
     *
     * **Validation:**
     * - amount должен быть finite
     * - amount может быть отрицательным (в отличие от tighten/widen)
     * - Проверка границ выполняется для обеих новых цен
     *
     * @example
     * ```typescript
     * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
     *
     * // Сдвиг вверх
     * const shiftedUp = SpreadService.shift(spread, new Decimal(0.05));
     * if (shiftedUp.ok) {
     *   console.log(shiftedUp.value.bid().value()); // 0.53
     *   console.log(shiftedUp.value.ask().value()); // 0.57
     *   console.log(shiftedUp.value.width()); // 0.04 (unchanged)
     * }
     *
     * // Сдвиг вниз (отрицательный amount)
     * const shiftedDown = SpreadService.shift(spread, new Decimal(-0.03));
     * if (shiftedDown.ok) {
     *   console.log(shiftedDown.value.bid().value()); // 0.45
     *   console.log(shiftedDown.value.ask().value()); // 0.49
     * }
     *
     * // Сдвиг за границы → Err
     * const outOfBounds = SpreadService.shift(spread, new Decimal(0.5));
     * console.log(outOfBounds.ok); // false (ask > MAX_PRICE)
     * ```
     */
    static shift(spread: Spread, amount: Decimal | number | string): Result<Spread, InvalidSpreadError>;
    /**
     * Получает mid price для spread
     *
     * @remarks
     * Создаёт Price из spread.mid() Decimal значения через PriceService.
     * Математически mid всегда в границах если bid/ask валидны, но метод возвращает
     * Result для соблюдения контракта "Never Throw".
     *
     * Алгоритм:
     * 1. Вычисляет mid через spread.mid() - (bid + ask) / 2
     * 2. Создаёт Price объект через PriceService.create()
     * 3. Если создание не удалось (не должно случиться), возвращает Err
     *
     * @param spread - Spread для вычисления mid
     * @returns Result с Price mid или InvalidSpreadError
     *
     * @throws {InvalidSpreadError} Никогда не бросает - возвращает Result
     *
     * @example
     * ```typescript
     * const spreadResult = SpreadService.fromValues(0.48, 0.52);
     * if (spreadResult.ok) {
     *   const midResult = SpreadService.getMidPrice(spreadResult.value);
     *   if (midResult.ok) {
     *     console.log(midResult.value.value().toString()); // "0.5"
     *   }
     * }
     * ```
     */
    static getMidPrice(spread: Spread): Result<Price, InvalidSpreadError>;
    /**
     * Вычисляет абсолютную ширину spread
     *
     * @param spread - Spread для анализа
     * @returns Result с Decimal (width = ask - bid)
     *
     * @remarks
     * Простая утилита для явного получения width через Result API.
     * Всегда успешна (т.к. bid <= ask инвариант).
     *
     * **Never Throw Contract**: Гарантированно возвращает Result, никогда не бросает.
     *
     * @example
     * ```typescript
     * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
     * const widthResult = SpreadService.getSpreadWidth(spread);
     *
     * if (widthResult.ok) {
     *   console.log(widthResult.value.toString()); // "0.04"
     * }
     * ```
     */
    static getSpreadWidth(spread: Spread): Result<Decimal, InvalidSpreadError>;
    /**
     * Вычисляет относительный spread (width / midpoint)
     *
     * @param spread - Spread для анализа
     * @returns Result с Ratio или InvalidSpreadError
     *
     * @remarks
     * **Формула:** spreadRatio = width / midpoint
     *
     * **Use cases:**
     * - Скоринг качества котировки (меньше = лучше ликвидность)
     * - Нормализация спреда для сравнения рынков
     * - Оценка transaction costs
     *
     * **Процесс:**
     * 1. Вычисляем midpoint через getMidPrice(spread)
     * 2. width / mid
     * 3. Создаем Ratio.of(result)
     *
     * **Возможные ошибки:**
     * - MID_UNAVAILABLE — если midpoint = 0 (теоретически невозможно для Price, но защита)
     *
     * **Never Throw Contract**: Гарантированно возвращает Result, никогда не бросает.
     *
     * @example
     * ```typescript
     * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
     * const ratioResult = SpreadService.getSpreadRatio(spread);
     *
     * if (ratioResult.ok) {
     *   console.log(ratioResult.value.toDecimal().toString()); // "0.08" (8%)
     *   console.log(ratioResult.value.toPercent());             // 8%
     * }
     * ```
     */
    static getSpreadRatio(spread: Spread): Result<Ratio, InvalidSpreadError>;
    /**
     * Создать spread из mid и width
     *
     * @param mid - Midpoint (середина между bid и ask)
     * @param width - Ширина спреда (ask - bid)
     * @returns Result со Spread или InvalidSpreadError
     *
     * @remarks
     * Вычисляет:
     * - bid = mid - width/2
     * - ask = mid + width/2
     *
     * **Валидация:**
     * - mid и width должны быть finite
     * - width должен быть неотрицательным
     * - Результирующие bid и ask должны быть валидными Price
     *
     * @example
     * ```typescript
     * const result = SpreadService.fromMidAndWidth(0.50, 0.04);
     * if (result.ok) {
     *   console.log(result.value.bid().value()); // 0.48
     *   console.log(result.value.ask().value()); // 0.52
     * }
     * ```
     */
    static fromMidAndWidth(mid: Decimal | number | string, width: Decimal | number | string): Result<Spread, InvalidSpreadError>;
    /**
     * Создать spread из mid и ширины в процентах
     *
     * @param mid - Midpoint (середина между bid и ask)
     * @param widthPercentage - Ширина в процентах от mid
     * @param options - Опции для валидации Ratio
     * @returns Result со Spread или InvalidSpreadError
     *
     * @remarks
     * Вычисляет:
     * - width = mid * (widthPercentage / 100)
     * - bid = mid - width/2
     * - ask = mid + width/2
     *
     * **Валидация:**
     * - mid должен быть finite
     * - widthPercentage должен быть валидным процентом (через RatioService)
     * - Результирующие bid и ask должны быть валидными Price
     *
     * **Опции:**
     * - ensureLteOne: гарантировать что ratio <= 1 (для ширины <= 100%)
     *
     * @example
     * ```typescript
     * const result = SpreadService.fromMidAndWidthPercentage(0.50, 8);
     * if (result.ok) {
     *   // width = 0.50 * 0.08 = 0.04
     *   console.log(result.value.bid().value()); // 0.48
     *   console.log(result.value.ask().value()); // 0.52
     * }
     *
     * // С валидацией: ширина не может быть > 100%
     * const result2 = SpreadService.fromMidAndWidthPercentage(0.50, 150, { ensureLteOne: true });
     * // isErr(result2) === true, reason: GREATER_THAN_ONE
     * ```
     */
    static fromMidAndWidthPercentage(mid: Decimal | number | string, widthPercentage: Decimal | number | string, options?: {
        ensureLteOne?: boolean;
    }): Result<Spread, InvalidSpreadError>;
    /**
     * Независимо скорректировать bid цену
     *
     * @param spread - Исходный spread
     * @param amount - Величина корректировки (+ вверх, - вниз)
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Операция:**
     * - Изменяет только bid: `newBid = bid + amount`
     * - Ask остаётся неизменным
     * - Ширина изменяется на `-amount`
     *
     * **Boundary behavior:**
     * - Если newBid > ask, возвращает Err (нарушение инварианта)
     * - Если newBid выходит за [MIN_PRICE, MAX_PRICE], возвращает Err
     *
     * **Immutability:**
     * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
     *
     * @example
     * ```typescript
     * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
     *
     * // Поднять bid
     * const adjusted = SpreadService.adjustBid(spread, new Decimal(0.01));
     * if (adjusted.ok) {
     *   console.log(adjusted.value.bid().value()); // 0.49
     *   console.log(adjusted.value.ask().value()); // 0.52 (unchanged)
     *   console.log(adjusted.value.width()); // 0.03 (was 0.04)
     * }
     * ```
     */
    static adjustBid(spread: Spread, amount: Decimal | number | string): Result<Spread, InvalidSpreadError>;
    /**
     * Независимо скорректировать ask цену
     *
     * @param spread - Исходный spread
     * @param amount - Величина корректировки (+ вверх, - вниз)
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Операция:**
     * - Изменяет только ask: `newAsk = ask + amount`
     * - Bid остаётся неизменным
     * - Ширина изменяется на `+amount`
     *
     * **Boundary behavior:**
     * - Если newAsk < bid, возвращает Err (нарушение инварианта)
     * - Если newAsk выходит за [MIN_PRICE, MAX_PRICE], возвращает Err
     *
     * **Immutability:**
     * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
     *
     * @example
     * ```typescript
     * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
     *
     * // Поднять ask
     * const adjusted = SpreadService.adjustAsk(spread, new Decimal(0.02));
     * if (adjusted.ok) {
     *   console.log(adjusted.value.bid().value()); // 0.48 (unchanged)
     *   console.log(adjusted.value.ask().value()); // 0.54
     *   console.log(adjusted.value.width()); // 0.06 (was 0.04)
     * }
     * ```
     */
    static adjustAsk(spread: Spread, amount: Decimal | number | string): Result<Spread, InvalidSpreadError>;
    /**
     * Независимо скорректировать bid и ask цены
     *
     * @param spread - Исходный spread
     * @param bidAmount - Величина корректировки bid (+ вверх, - вниз)
     * @param askAmount - Величина корректировки ask (+ вверх, - вниз)
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * Комбинация adjustBid() и adjustAsk() в одной операции.
     * Сначала применяет adjustBid(), затем adjustAsk().
     *
     * **Immutability:**
     * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
     *
     * @example
     * ```typescript
     * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
     *
     * // Поднять bid на 0.01, опустить ask на 0.01
     * const adjusted = SpreadService.adjustBidAsk(
     *   spread,
     *   new Decimal(0.01),
     *   new Decimal(-0.01)
     * );
     * if (adjusted.ok) {
     *   console.log(adjusted.value.bid().value()); // 0.49
     *   console.log(adjusted.value.ask().value()); // 0.51
     *   console.log(adjusted.value.width()); // 0.02 (was 0.04)
     * }
     * ```
     */
    static adjustBidAsk(spread: Spread, bidAmount: Decimal | number | string, askAmount: Decimal | number | string): Result<Spread, InvalidSpreadError>;
    /**
     * Объединить два spread в один охватывающий оба
     *
     * @param s1 - Первый spread
     * @param s2 - Второй spread
     * @returns Result со Spread охватывающим оба входных
     *
     * @remarks
     * **Операция:**
     * - Результат.bid = min(s1.bid, s2.bid)
     * - Результат.ask = max(s1.ask, s2.ask)
     * - Результат содержит оба входных спреда
     *
     * **Use case:**
     * Объединение order books с разных бирж.
     *
     * **Immutability:**
     * Входные spreads НЕ изменяются. Возвращается новый Spread объект.
     *
     * @example
     * ```typescript
     * const s1 = unwrap(SpreadService.fromValues(0.48, 0.52));
     * const s2 = unwrap(SpreadService.fromValues(0.50, 0.54));
     *
     * const merged = SpreadService.merge(s1, s2);
     * if (merged.ok) {
     *   console.log(merged.value.bid().value()); // 0.48 (min)
     *   console.log(merged.value.ask().value()); // 0.54 (max)
     *   console.log(merged.value.width()); // 0.06
     * }
     * ```
     */
    static merge(s1: Spread, s2: Spread): Result<Spread, InvalidSpreadError>;
    /**
     * Найти пересечение двух spread
     *
     * @param s1 - Первый spread
     * @param s2 - Второй spread
     * @returns Result со Spread пересечением или Err если нет пересечения
     *
     * @remarks
     * **Операция:**
     * - Результат.bid = max(s1.bid, s2.bid)
     * - Результат.ask = min(s1.ask, s2.ask)
     * - Возвращает Err если результирующий bid > ask (нет пересечения)
     *
     * **Use case:**
     * Нахождение общего диапазона цен на разных биржах.
     *
     * **Immutability:**
     * Входные spreads НЕ изменяются. Возвращается новый Spread объект.
     *
     * @example
     * ```typescript
     * const s1 = unwrap(SpreadService.fromValues(0.40, 0.60));
     * const s2 = unwrap(SpreadService.fromValues(0.50, 0.70));
     *
     * const intersection = SpreadService.intersect(s1, s2);
     * if (intersection.ok) {
     *   console.log(intersection.value.bid().value()); // 0.50 (max)
     *   console.log(intersection.value.ask().value()); // 0.60 (min)
     *   console.log(intersection.value.width()); // 0.10
     * }
     *
     * // Нет пересечения
     * const s3 = unwrap(SpreadService.fromValues(0.70, 0.80));
     * const noIntersect = SpreadService.intersect(s1, s3);
     * console.log(noIntersect.ok); // false
     * ```
     */
    static intersect(s1: Spread, s2: Spread): Result<Spread, InvalidSpreadError>;
    /**
     * Сдвигает spread на долю от midpoint
     *
     * @param spread - Исходный spread
     * @param shiftRatio - Доля для сдвига (Ratio), положительная = вверх, отрицательная = вниз
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Семантика:** "Сдвинуть котировку на X% от midpoint"
     *
     * **Формула:**
     * 1. mid = (bid + ask) / 2
     * 2. shiftAbs = mid * shiftRatio
     * 3. shift(spread, shiftAbs)
     *
     * **Use cases:**
     * - Market making: сдвиг котировки на 5% вверх при росте volatility
     * - Risk adjustment: сдвиг на -2% при большой позиции
     *
     * **Процесс:**
     * 1. Вычисляем midpoint через getMidPrice(spread)
     * 2. shiftAbs = mid * shiftRatio.toDecimal()
     * 3. Вызываем существующий shift(spread, shiftAbs)
     *
     * **Возможные ошибки:**
     * - MID_UNAVAILABLE — если getMidPrice вернул ошибку
     * - RATIO_OUT_OF_BOUNDS — если после сдвига bid/ask выходят за границы Price [0.0001, 0.9999]
     *
     * **Never Throw Contract**: Гарантированно возвращает Result, никогда не бросает.
     *
     * @example
     * ```typescript
     * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
     * const shiftRatio = Ratio.of(new Decimal(0.05)); // 5% вверх
     *
     * const result = SpreadService.shiftByRatio(spread, shiftRatio);
     * if (result.ok) {
     *   // mid = 0.50, shiftAbs = 0.50 * 0.05 = 0.025
     *   console.log(result.value.bid().value()); // 0.505
     *   console.log(result.value.ask().value()); // 0.545
     * }
     * ```
     */
    static shiftByRatio(spread: Spread, shiftRatio: Ratio): Result<Spread, InvalidSpreadError>;
    /**
     * Расширяет spread на долю от midpoint
     *
     * @param spread - Исходный spread
     * @param deltaWidthRatio - Доля для расширения (Ratio), должен быть >= 0
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Семантика:** "Расширить spread на X% от midpoint"
     *
     * **Формула:**
     * 1. mid = (bid + ask) / 2
     * 2. deltaWidthAbs = mid * deltaWidthRatio
     * 3. amountAbs = deltaWidthAbs / 2
     * 4. newBid = bid - amountAbs
     * 5. newAsk = ask + amountAbs
     *
     * **Реализация через adjustBidAsk:**
     * - adjustBidAsk(spread, -amountAbs, +amountAbs)
     *
     * **Use cases:**
     * - Market making: расширение spread на 2% при низкой ликвидности
     * - Risk management: расширение spread на 5% при высокой volatility
     *
     * **Процесс:**
     * 1. Проверяем deltaWidthRatio >= 0
     * 2. Вычисляем midpoint через getMidPrice(spread)
     * 3. deltaWidthAbs = mid * deltaWidthRatio.toDecimal()
     * 4. amountAbs = deltaWidthAbs / 2
     * 5. Вызываем adjustBidAsk(spread, -amountAbs, +amountAbs)
     *
     * **Возможные ошибки:**
     * - NEGATIVE_RATIO_NOT_ALLOWED — если deltaWidthRatio < 0
     * - MID_UNAVAILABLE — если getMidPrice вернул ошибку
     * - RATIO_OUT_OF_BOUNDS — если после расширения bid/ask выходят за границы Price
     *
     * **Never Throw Contract**: Гарантированно возвращает Result, никогда не бросает.
     *
     * @example
     * ```typescript
     * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
     * const deltaRatio = Ratio.of(new Decimal(0.02)); // 2% от mid
     *
     * const result = SpreadService.widenByRatio(spread, deltaRatio);
     * if (result.ok) {
     *   // mid = 0.50, deltaAbs = 0.01, amountAbs = 0.005
     *   console.log(result.value.bid().value()); // 0.475
     *   console.log(result.value.ask().value()); // 0.525
     * }
     * ```
     */
    static widenByRatio(spread: Spread, deltaWidthRatio: Ratio): Result<Spread, InvalidSpreadError>;
    /**
     * Сужает spread на долю от midpoint
     *
     * @param spread - Исходный spread
     * @param deltaWidthRatio - Доля для сужения (Ratio), должен быть >= 0
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Семантика:** "Сузить spread на X% от midpoint"
     *
     * **Формула:**
     * 1. mid = (bid + ask) / 2
     * 2. deltaWidthAbs = mid * deltaWidthRatio
     * 3. amountAbs = deltaWidthAbs / 2
     * 4. Clamp: amountAbs = min(amountAbs, currentWidth/2) (чтобы не пересечь bid/ask)
     * 5. newBid = bid + amountAbs
     * 6. newAsk = ask - amountAbs
     *
     * **Реализация через tighten:**
     * - Вызываем существующий tighten(spread, amountAbs) который уже делает clamp
     *
     * **Use cases:**
     * - Market making: сужение spread на 1% при высокой ликвидности
     * - Competitive pricing: сужение spread на 0.5% чтобы быть внутри рынка
     *
     * **Процесс:**
     * 1. Проверяем deltaWidthRatio >= 0
     * 2. Вычисляем midpoint через getMidPrice(spread)
     * 3. deltaWidthAbs = mid * deltaWidthRatio.toDecimal()
     * 4. amountAbs = deltaWidthAbs / 2
     * 5. Вызываем существующий tighten(spread, amountAbs) (он делает clamp)
     *
     * **Возможные ошибки:**
     * - NEGATIVE_RATIO_NOT_ALLOWED — если deltaWidthRatio < 0
     * - MID_UNAVAILABLE — если getMidPrice вернул ошибку
     * - RATIO_OUT_OF_BOUNDS — если после сужения bid/ask выходят за границы Price
     *
     * **Never Throw Contract**: Гарантированно возвращает Result, никогда не бросает.
     *
     * @example
     * ```typescript
     * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
     * const deltaRatio = Ratio.of(new Decimal(0.02)); // 2% от mid
     *
     * const result = SpreadService.tightenByRatio(spread, deltaRatio);
     * if (result.ok) {
     *   // mid = 0.50, deltaAbs = 0.01, amountAbs = 0.005
     *   console.log(result.value.bid().value()); // 0.485
     *   console.log(result.value.ask().value()); // 0.515
     * }
     * ```
     */
    static tightenByRatio(spread: Spread, deltaWidthRatio: Ratio): Result<Spread, InvalidSpreadError>;
    /**
     * Наклоняет spread на доли от midpoint
     *
     * @param spread - Исходный spread
     * @param bidRatio - Доля для изменения bid (Ratio), положительная = вверх
     * @param askRatio - Доля для изменения ask (Ratio), положительная = вверх
     * @returns Result с новым Spread или InvalidSpreadError
     *
     * @remarks
     * **Семантика:** "Наклонить spread на X% и Y% от midpoint"
     *
     * **Формула:**
     * 1. mid = (bid + ask) / 2
     * 2. bidAdjAbs = mid * bidRatio
     * 3. askAdjAbs = mid * askRatio
     * 4. newBid = bid + bidAdjAbs
     * 5. newAsk = ask + askAdjAbs
     *
     * **Реализация через adjustBidAsk:**
     * - adjustBidAsk(spread, bidAdjAbs, askAdjAbs)
     *
     * **Use cases:**
     * - Inventory skew: bidRatio=+2%, askRatio=-1% (сдвиг вверх с наклоном)
     * - Asymmetric adjustment: bidRatio=+1%, askRatio=+3% (расширение с наклоном вверх)
     *
     * **Процесс:**
     * 1. Вычисляем midpoint через getMidPrice(spread)
     * 2. bidAdjAbs = mid * bidRatio.toDecimal()
     * 3. askAdjAbs = mid * askRatio.toDecimal()
     * 4. Вызываем существующий adjustBidAsk(spread, bidAdjAbs, askAdjAbs)
     *
     * **Возможные ошибки:**
     * - MID_UNAVAILABLE — если getMidPrice вернул ошибку
     * - RATIO_OUT_OF_BOUNDS — если после skew bid/ask выходят за границы Price или bid > ask
     *
     * **Never Throw Contract**: Гарантированно возвращает Result, никогда не бросает.
     *
     * @example
     * ```typescript
     * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
     * const bidRatio = Ratio.of(new Decimal(0.02));  // +2% от mid
     * const askRatio = Ratio.of(new Decimal(-0.01)); // -1% от mid
     *
     * const result = SpreadService.skewByRatio(spread, bidRatio, askRatio);
     * if (result.ok) {
     *   // mid = 0.50, bidAdj = 0.01, askAdj = -0.005
     *   console.log(result.value.bid().value()); // 0.49
     *   console.log(result.value.ask().value()); // 0.515
     * }
     * ```
     */
    static skewByRatio(spread: Spread, bidRatio: Ratio, askRatio: Ratio): Result<Spread, InvalidSpreadError>;
    /**
     * Создать Price с полным error context
     *
     * @remarks
     * Централизует логику создания Price объектов в операциях (tighten/widen/shift).
     * Добавляет полный error context включая source, raw, reason fields.
     *
     * @param op - Название операции (tighten/widen/shift)
     * @param field - Название поля ('bid' или 'ask')
     * @param value - Decimal значение для Price
     * @param spread - Исходный spread для контекста
     * @param operationDesc - Описание операции для контекста
     * @returns Result с Price или InvalidSpreadError
     *
     * @example
     * ```typescript
     * const result = SpreadService.createPrice(
     *   'tighten',
     *   'bid',
     *   new Decimal(0.49),
     *   spread,
     *   'add to bid'
     * );
     * ```
     */
    private static createPrice;
}
//# sourceMappingURL=SpreadService.d.ts.map