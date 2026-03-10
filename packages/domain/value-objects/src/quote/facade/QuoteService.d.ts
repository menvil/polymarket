import { Result } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import type { IClock } from '@polymarket/time';
import type { MarketDataSourceId, InstrumentId } from '@polymarket/ids';
import { Price } from '../../price/core/Price.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { Quote } from '../core/index.js';
import { Ratio } from '../../ratio/core/Ratio.js';
/**
 * Фасад для работы с Quote - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с котировками.
 * Оркестрирует Core + Rules + errorUtils.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы QuoteService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.raw - сырой ввод (для ошибок парсинга): { field, value }
 * - context.cause - для math/core исключений: { name, message, stack? }
 * - context.reason - типизированная причина (QuoteErrorReason)
 *
 * @example
 * ```typescript
 * import { QuoteService } from '@polymarket/value-objects/quote';
 *
 * const result = QuoteService.create(0.48, 0.52, 100, 150);
 * if (result.ok) {
 *   const quote = result.value;
 * } else {
 *   console.error(result.error.message);
 *   console.error(result.error.context?.reason); // QuoteErrorReason enum
 * }
 * ```
 */
export declare class QuoteService {
    private static readonly SERVICE_NAME;
    /**
     * Helper: парсит Decimal из гибкого типа
     *
     * @internal
     * @param field - Название поля для error context
     * @param value - Значение для парсинга
     * @param reason - Причина ошибки (QuoteErrorReason)
     * @returns Result с Decimal или InvalidQuoteError
     *
     * @remarks
     * Централизованный парсинг для всех входных параметров.
     * Использует toDecimal() и оборачивает ошибку через rewrap().
     */
    private static parseDecimal;
    /**
     * Helper: парсит опциональный Decimal (может быть null)
     *
     * @internal
     * @param field - Название поля для error context
     * @param value - Значение для парсинга или null
     * @param reason - Причина ошибки (QuoteErrorReason)
     * @returns Result с Decimal | null или InvalidQuoteError
     *
     * @remarks
     * Для bid/ask которые могут быть null (one-sided quotes).
     * Если value === null, возвращает Ok(null) без парсинга.
     *
     */
    private static parseOptionalDecimal;
    /**
     * Создаёт Quote
     *
     * @remarks
     * Публичный метод для создания котировок.
     * Использует parseOptionalDecimal() и parseDecimal() helpers для безопасного парсинга всех входных параметров.
     * Принимает number | string | Decimal для гибкости использования.
     *
     * @param bidValue - Значение bid (Decimal | number | string | null)
     * @param askValue - Значение ask (Decimal | number | string | null)
     * @param bidSizeValue - Значение bid size (Decimal | number | string)
     * @param askSizeValue - Значение ask size (Decimal | number | string)
     * @param sourceId - ID источника маркет-данных
     * @param instrumentId - ID инструмента
     * @param timestamp - Временная метка (опционально, Date | Decimal | number | string)
     * @returns Result с Quote или InvalidQuoteError
     *
     * @example
     * ```typescript
     * import { KnownMarketDataSources } from '@polymarket/ids';
     *
     * // С numbers
     * const result1 = QuoteService.create(
     *   0.50, 0.51, 100, 200,
     *   KnownMarketDataSources.POLYMARKET_WS,
     *   '123456789' as InstrumentId
     * );
     *
     * // С strings
     * const result2 = QuoteService.create(
     *   "0.50", "0.51", "100", "200",
     *   KnownMarketDataSources.POLYMARKET_WS,
     *   '123456789' as InstrumentId
     * );
     *
     * // С custom timestamp
     * const result4 = QuoteService.create(
     *   0.50, 0.51, 100, 200,
     *   KnownMarketDataSources.POLYMARKET_WS,
     *   '123456789' as InstrumentId,
     *   new Decimal(Date.now())
     * );
     *
     * // Односторонняя котировка
     * const result5 = QuoteService.create(
     *   0.50, null, 100, 0,
     *   KnownMarketDataSources.POLYMARKET_WS,
     *   '123456789' as InstrumentId
     * );
     *
     * if (result1.ok) {
     *   const quote = result1.value;
     *   console.log(quote.isTwoSided()); // true
     *   console.log(quote.sourceId()); // 'POLYMARKET_WS'
     * } else {
     *   // Структурированная ошибка
     *   console.error(result1.error.context?.op); // 'create'
     *   console.error(result1.error.context?.reason); // QuoteErrorReason
     *   console.error(result1.error.context?.raw); // { field, value }
     * }
     * ```
     */
    static create(bidValue: Decimal | number | string | null, askValue: Decimal | number | string | null, bidSizeValue: Decimal | number | string, askSizeValue: Decimal | number | string, sourceId: MarketDataSourceId, instrumentId: InstrumentId, timestamp?: Date | Decimal | number | string): Result<Quote, InvalidQuoteError>;
    /**
     * Создаёт одностороннюю bid котировку
     *
     * @param bidValue - Значение bid (Decimal | number | string)
     * @param bidSizeValue - Значение bid size (Decimal | number | string)
     * @param sourceId - ID источника маркет-данных
     * @param instrumentId - ID инструмента
     * @param timestamp - Временная метка (опционально, Date | Decimal | number | string)
     * @returns Result с Quote или InvalidQuoteError
     *
     * @example
     * ```typescript
     * import { KnownMarketDataSources } from '@polymarket/ids';
     *
     * const result = QuoteService.bidOnly(
     *   0.50, 100,
     *   KnownMarketDataSources.POLYMARKET_WS,
     *   '123456789' as InstrumentId
     * );
     * if (result.ok) {
     *   const quote = result.value;
     *   console.log(quote.hasBid()); // true
     *   console.log(quote.hasAsk()); // false
     * }
     * ```
     */
    static bidOnly(bidValue: Decimal | number | string, bidSizeValue: Decimal | number | string, sourceId: MarketDataSourceId, instrumentId: InstrumentId, timestamp?: Date | Decimal | number | string): Result<Quote, InvalidQuoteError>;
    /**
     * Создаёт одностороннюю ask котировку
     *
     * @param askValue - Значение ask (Decimal | number | string)
     * @param askSizeValue - Значение ask size (Decimal | number | string)
     * @param sourceId - ID источника маркет-данных
     * @param instrumentId - ID инструмента
     * @param timestamp - Временная метка (опционально, Date | Decimal | number | string)
     * @returns Result с Quote или InvalidQuoteError
     *
     * @example
     * ```typescript
     * import { KnownMarketDataSources } from '@polymarket/ids';
     *
     * const result = QuoteService.askOnly(
     *   0.51, 200,
     *   KnownMarketDataSources.POLYMARKET_WS,
     *   '123456789' as InstrumentId
     * );
     * if (result.ok) {
     *   const quote = result.value;
     *   console.log(quote.hasBid()); // false
     *   console.log(quote.hasAsk()); // true
     * }
     * ```
     */
    static askOnly(askValue: Decimal | number | string, askSizeValue: Decimal | number | string, sourceId: MarketDataSourceId, instrumentId: InstrumentId, timestamp?: Date | Decimal | number | string): Result<Quote, InvalidQuoteError>;
    /**
     * Сдвигает котировку на указанную величину (нейтральная трансформация)
     *
     * @remarks
     * Shift - это параллельный сдвиг bid и ask на одинаковую величину.
     * Spread остаётся неизменным.
     *
     * **Важно**: Сохраняет timestamp исходной котировки.
     * Это нейтральная трансформация - изменяются только цены.
     * Для создания новой котировки с обновленным timestamp используйте shiftWithRefresh().
     *
     * @param quote - Исходная котировка
     * @param shiftAmount - Величина сдвига (Decimal | number | string, может быть отрицательной)
     * @returns Result с новой Quote или InvalidQuoteError
     *
     * @example
     * ```typescript
     * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
     * const originalTimestamp = quote.timestampMs();
     *
     * // Сдвиг вверх - timestamp сохраняется
     * const shifted = expectOk(QuoteService.shift(quote, 0.01));
     * console.log(shifted.timestampMs().equals(originalTimestamp)); // true
     * // bid: 0.48 → 0.49, ask: 0.52 → 0.53
     * ```
     */
    static shift(quote: Quote, shiftAmount: Decimal | number | string): Result<Quote, InvalidQuoteError>;
    /**
     * Сдвигает котировку с обновлением timestamp
     *
     * @remarks
     * То же что shift(), но создаёт новую котировку с текущим временем.
     * Используйте когда сдвиг означает новые рыночные данные.
     *
     * @param quote - Исходная котировка
     * @param shiftAmount - Величина сдвига (Decimal | number | string)
     * @param clock - Источник времени (IClock)
     * @returns Result с новой Quote или InvalidQuoteError
     *
     * @example
     * ```typescript
     * import { LiveClock } from '@polymarket/time';
     *
     * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
     * const clock = new LiveClock();
     *
     * // Сдвиг с обновлением времени (новые данные с рынка)
     * const refreshed = expectOk(QuoteService.shiftWithRefresh(quote, 0.01, clock));
     * console.log(refreshed.timestampMs().greaterThan(quote.timestampMs())); // true
     * ```
     */
    static shiftWithRefresh(quote: Quote, shiftAmount: Decimal | number | string, clock: IClock): Result<Quote, InvalidQuoteError>;
    /**
     * Применяет skew к котировке
     *
     * @remarks
     * Skew - это асимметричное изменение bid и ask.
     * Позволяет наклонить котировку в одну сторону.
     *
     * @param quote - Исходная котировка
     * @param bidAdjustment - Adjustment для bid (Decimal | number | string, может быть отрицательным)
     * @param askAdjustment - Adjustment для ask (Decimal | number | string, может быть отрицательным)
     * @returns Result с новой Quote или InvalidQuoteError
     *
     * @example
     * ```typescript
     * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
     *
     * // Используя number - сдвинуть bid вниз, ask вверх (расширить spread)
     * const result = QuoteService.skew(quote, -0.01, 0.01);
     * // bid: 0.48 → 0.47, ask: 0.52 → 0.53, spread: 0.04 → 0.06
     *
     * // Или используя Decimal
     * const result2 = QuoteService.skew(
     *   quote,
     *   new Decimal(-0.01), // bid вниз
     *   new Decimal(0.01)   // ask вверх
     * );
     * ```
     */
    static skew(quote: Quote, bidAdjustment: Decimal | number | string, askAdjustment: Decimal | number | string): Result<Quote, InvalidQuoteError>;
    /**
     * Применяет skew с обновлением timestamp
     *
     * @remarks
     * То же что skew(), но создаёт новую котировку с текущим временем.
     * Используйте когда skew означает новые рыночные данные.
     *
     * @param quote - Исходная котировка
     * @param bidAdjustment - Adjustment для bid (Decimal | number | string)
     * @param askAdjustment - Adjustment для ask (Decimal | number | string)
     * @param clock - Источник времени (IClock)
     * @returns Result с новой Quote или InvalidQuoteError
     *
     * @example
     * ```typescript
     * import { LiveClock } from '@polymarket/time';
     *
     * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
     * const clock = new LiveClock();
     *
     * // Skew с обновлением времени (новые данные с рынка)
     * const refreshed = expectOk(QuoteService.skewWithRefresh(quote, -0.01, 0.01, clock));
     * console.log(refreshed.timestampMs().greaterThan(quote.timestampMs())); // true
     * ```
     */
    static skewWithRefresh(quote: Quote, bidAdjustment: Decimal | number | string, askAdjustment: Decimal | number | string, clock: IClock): Result<Quote, InvalidQuoteError>;
    /**
     * Обновляет размеры котировки (нейтральная трансформация)
     *
     * @remarks
     * **Важно**: Сохраняет timestamp исходной котировки.
     * Для создания новой котировки с обновленным timestamp используйте updateSizesWithRefresh().
     *
     * @param quote - Исходная котировка
     * @param newBidSize - Новый bid size (number, string, Decimal или Quantity)
     * @param newAskSize - Новый ask size (number, string, Decimal или Quantity)
     * @returns Result с новой Quote или InvalidQuoteError
     *
     * @example
     * ```typescript
     * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
     *
     * // С number
     * const result1 = QuoteService.updateSizes(quote, 200, 300);
     *
     * // С string (удобно для API данных)
     * const result2 = QuoteService.updateSizes(quote, "200", "300");
     *
     * // С Decimal
     * const result3 = QuoteService.updateSizes(quote, new Decimal(200), new Decimal(300));
     *
     * // С готовым Quantity
     * const bidQty = expectOk(QuantityService.create(200));
     * const result4 = QuoteService.updateSizes(quote, bidQty, 300);
     *
     * if (result1.ok) {
     *   const updated = result1.value;
     *   console.log(updated.bidSize().value().toNumber()); // 200
     *   console.log(updated.askSize().value().toNumber()); // 300
     * }
     * ```
     */
    static updateSizes(quote: Quote, newBidSize: Decimal | number | string | Quantity, newAskSize: Decimal | number | string | Quantity): Result<Quote, InvalidQuoteError>;
    /**
     * Обновляет размеры ставок котировки с обновлением timestamp через IClock.
     *
     * Использует IClock для получения актуального времени и обновления timestamp котировки.
     * Аналогична updateSizes(), но обновляет timestamp вместо его сохранения.
     *
     * @param quote - Исходная котировка
     * @param newBidSize - Новый размер bid (Decimal, number, string или Quantity)
     * @param newAskSize - Новый размер ask (Decimal, number, string или Quantity)
     * @param clock - IClock для получения актуального времени
     * @returns Result с новой котировкой или InvalidQuoteError
     *
     * @throws {InvalidQuoteError} При некорректных размерах или нарушении инвариантов Quote
     *
     * @example
     * ```typescript
     * import { LiveClock } from '@polymarket/time';
     * const clock = new LiveClock();
     * const result = QuoteService.updateSizesWithRefresh(quote, 200, 150, clock);
     * if (result.ok) {
     *   console.log('Updated sizes with new timestamp:', result.value.timestampMs());
     * }
     * ```
     *
     * @remarks
     * Алгоритм:
     * 1. Парсинг newBidSize и newAskSize (поддержка Decimal | number | string | Quantity)
     * 2. Создание новой котировки через Quote.of с теми же ценами и обновлённым timestamp
     * 3. Обработка QuoteInvariantViolation при нарушении бизнес-правил
     * 4. IClock dependency injection для deterministic time handling
     */
    static updateSizesWithRefresh(quote: Quote, newBidSize: Decimal | number | string | Quantity, newAskSize: Decimal | number | string | Quantity, clock: IClock): Result<Quote, InvalidQuoteError>;
    /**
     * Вычисляет midpoint quote
     *
     * @param quote - Quote для анализа
     * @returns Result с Price (midpoint) или InvalidQuoteError
     *
     * @remarks
     * Делегирует в SpreadService.getMidPrice(quote.spread()).
     * Переупаковывает SpreadError в QuoteError.
     *
     * **Возможные ошибки:**
     * - NOT_TWO_SIDED — если quote не two-sided (не применимо для Spread, но для Quote может быть)
     *
     * **Never Throw Contract**: Гарантированно возвращает Result, никогда не бросает.
     *
     * @example
     * ```typescript
     * const quote = QuoteService.create(...);
     * const midResult = QuoteService.getMidPrice(quote);
     *
     * if (midResult.ok) {
     *   console.log(midResult.value.value().toString()); // "0.50"
     * }
     * ```
     */
    static getMidPrice(quote: Quote): Result<Price, InvalidQuoteError>;
    /**
     * Вычисляет относительный spread quote (width / midpoint)
     *
     * @param quote - Quote для анализа
     * @returns Result с Ratio или InvalidQuoteError
     *
     * @remarks
     * Делегирует в SpreadService.getSpreadRatio(quote.spread()).
     *
     * **Возможные ошибки:**
     * - NOT_TWO_SIDED — если quote не two-sided
     * - MID_UNAVAILABLE — если midpoint = 0
     *
     * **Never Throw Contract**: Гарантированно возвращает Result, никогда не бросает.
     *
     * @example
     * ```typescript
     * const quote = QuoteService.create(...);
     * const ratioResult = QuoteService.getSpreadRatio(quote);
     *
     * if (ratioResult.ok) {
     *   console.log(ratioResult.value.toPercent()); // "8%"
     * }
     * ```
     */
    static getSpreadRatio(quote: Quote): Result<Ratio, InvalidQuoteError>;
    /**
     * Сдвигает quote на долю от midpoint (цены меняются, sizes сохраняются)
     *
     * @param quote - Исходный quote
     * @param shiftRatio - Доля для сдвига (Ratio)
     * @returns Result с новым Quote или InvalidQuoteError
     *
     * @remarks
     * Делегирует spread операцию в SpreadService.shiftByRatio,
     * пересоздает Quote с новым spread и теми же sizes.
     *
     * **Процесс:**
     * 1. newSpread = SpreadService.shiftByRatio(quote.spread(), shiftRatio)
     * 2. Quote.of(newSpread, quote.bidSize(), quote.askSize(), ...)
     *
     * **Never Throw Contract**: Гарантированно возвращает Result.
     *
     * @example
     * ```typescript
     * const quote = QuoteService.create(...);
     * const shiftRatio = Ratio.of(new Decimal(0.05)); // 5% вверх
     *
     * const result = QuoteService.shiftByRatio(quote, shiftRatio);
     * if (result.ok) {
     *   console.log(result.value.bidPrice().value()); // shifted bid
     *   console.log(result.value.bidSize().toNumber()); // same size
     * }
     * ```
     */
    static shiftByRatio(quote: Quote, shiftRatio: Ratio): Result<Quote, InvalidQuoteError>;
    /**
     * Расширяет spread quote на долю от midpoint
     */
    static widenByRatio(quote: Quote, deltaWidthRatio: Ratio): Result<Quote, InvalidQuoteError>;
    /**
     * Сужает spread quote на долю от midpoint
     */
    static tightenByRatio(quote: Quote, deltaWidthRatio: Ratio): Result<Quote, InvalidQuoteError>;
    /**
     * Наклоняет quote spread на доли от midpoint
     */
    static skewByRatio(quote: Quote, bidRatio: Ratio, askRatio: Ratio): Result<Quote, InvalidQuoteError>;
    /**
     * Масштабирует sizes quote на factor (цены сохраняются)
     *
     * @param quote - Исходный quote
     * @param sizeFactor - Factor для масштабирования sizes (Ratio), должен быть > 0
     * @returns Result с новым Quote или InvalidQuoteError
     *
     * @remarks
     * **⚠️ UNSAFE: Не применяет venue-specific stepSize/minSize/maxSize.**
     *
     * **Семантика:** "Масштабировать размеры на X%"
     *
     * **Use cases:**
     * - Risk management: shrink sizes на 50% при большой позиции
     * - Scaling: увеличить sizes на 200% при высокой confidence
     *
     * **Процесс:**
     * 1. Validate sizeFactor > 0
     * 2. newBidSize = QuantityService.multiply(quote.bidSize(), sizeFactor.toDecimal())
     * 3. newAskSize = QuantityService.multiply(quote.askSize(), sizeFactor.toDecimal())
     * 4. Quote.of(quote.spread(), newBidSize, newAskSize, ...)
     *
     * **Возможные ошибки:**
     * - INVALID_SIZE_FACTOR — если sizeFactor <= 0
     * - INVALID_FORMAT — если результат не валиден для Quantity
     *
     * **Never Throw Contract**: Гарантированно возвращает Result.
     *
     * @example
     * ```typescript
     * const quote = QuoteService.create(...); // bidSize=100, askSize=100
     * const factor = Ratio.of(new Decimal(0.5)); // 50%
     *
     * const result = QuoteService.scaleSizesByRatio(quote, factor);
     * if (result.ok) {
     *   console.log(result.value.bidSize().toNumber()); // 50
     *   console.log(result.value.askSize().toNumber()); // 50
     *   console.log(result.value.bidPrice().value()); // same price
     * }
     * ```
     */
    static scaleSizesByRatio(quote: Quote, sizeFactor: Ratio): Result<Quote, InvalidQuoteError>;
    /**
     * Helper: создаёт Price из Decimal (с обработкой null)
     *
     * @internal
     * @param value - Decimal значение или null
     * @param field - Название поля ('bid' или 'ask')
     * @param op - Название операции для error context
     * @returns Result с Price или InvalidQuoteError
     */
    private static createPrice;
    /**
     * Helper: создаёт Quantity из Decimal
     *
     * @internal
     * @param value - Decimal значение
     * @param field - Название поля ('bidSize' или 'askSize')
     * @param op - Название операции для error context
     * @returns Result с Quantity или InvalidQuoteError
     */
    private static createQuantity;
}
//# sourceMappingURL=QuoteService.d.ts.map