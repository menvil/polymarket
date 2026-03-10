import Decimal from 'decimal.js';
import type { MarketDataSourceId, InstrumentId } from '@polymarket/ids';
import { Price } from '../../price/core/Price.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { Spread } from '../../spread/core/Spread.js';
import { Ratio } from '../../ratio/core/Ratio.js';
import { Timestamp } from '../../timestamp/core/Timestamp.js';
/**
 * Core Quote Value Object
 *
 * @remarks
 * Представляет котировку рынка (bid/ask pair) с размерами и временной меткой.
 *
 * Содержит:
 * 1. **Инварианты существования** (проверки при создании):
 *    - Хотя бы одна сторона определена (bid или ask)
 *    - bid <= ask (если оба определены)
 *    - Sizes >= 0 (гарантирует Quantity)
 *    - Структурная согласованность: bid=null → bidSize=0, ask=null → askSize=0
 *    - Валидный timestamp (гарантирует Timestamp VO)
 *
 * 2. **Чистую математику** (query методы, вычисления):
 *    - spreadWidthOrZero() - вычисление ширины спреда
 *    - midOrNull() - вычисление средней цены
 *    - spreadPercentage() - вычисление процента спреда
 *    - equals() - сравнение рыночных данных
 *
 * НЕ содержит:
 * - Бизнес-правила про размеры (используй Rules)
 * - Валидацию spread границ (используй Rules)
 * - Market crossing detection бизнес-логику (используй Rules)
 *
 * Внутреннее представление: композиция Price + Quantity + Timestamp.
 *
 * @example
 * ```typescript
 * // ✅ В Core и Facade (throws)
 * const ts = Timestamp.now();
 * const quote = Quote.of(
 *   Price.of(0.48),
 *   Price.of(0.52),
 *   Quantity.of(100),
 *   Quantity.of(150),
 *   ts,
 *   'POLYMARKET_WS' as MarketDataSourceId,
 *   'TEST_MARKET' as InstrumentId
 * );
 *
 * // One-sided quote
 * const bidOnly = Quote.of(
 *   Price.of(0.50),
 *   null,
 *   Quantity.of(100),
 *   Quantity.ZERO,
 *   ts,
 *   'POLYMARKET_WS' as MarketDataSourceId,
 *   'TEST_MARKET' as InstrumentId
 * );
 *
 * // Query methods (чистая математика)
 * console.log(quote.isTwoSided()); // true
 * const spread = quote.spreadWidthOrZero(); // Decimal
 * const mid = quote.midOrNull(); // Decimal | null
 *
 * // ❌ В публичном коде - используй QuoteService:
 * const result = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');
 * if (!result.ok) {
 *   console.error(result.error);
 * }
 * ```
 */
export declare class Quote {
    private readonly _bid;
    private readonly _ask;
    private readonly _bidSize;
    private readonly _askSize;
    private readonly _timestamp;
    private readonly _sourceId;
    private readonly _instrumentId;
    private constructor();
    /**
     * Создаёт Quote из компонентов
     *
     * @internal ТОЛЬКО для внутреннего использования в Core и Facade
     *
     * @remarks
     * Бросает QuoteInvariantViolation при нарушении инвариантов.
     * Для публичного API используйте QuoteService.create().
     *
     * ВАЖНО: timestamp должен быть Timestamp VO.
     * Конвертация Date/number/string → Timestamp делается в QuoteService.
     *
     * @param bid - Цена покупки (может быть null)
     * @param ask - Цена продажи (может быть null)
     * @param bidSize - Объём на покупку
     * @param askSize - Объём на продажу
     * @param timestamp - Временная метка (Timestamp VO)
     * @param sourceId - Источник маркет-данных
     * @param instrumentId - ID инструмента
     * @returns Новый Quote объект
     * @throws {QuoteInvariantViolation} Если нарушены инварианты
     *
     * @example
     * ```typescript
     * // ✅ В Core и Facade
     * const ts = TimestampService.create(Date.now()).value!;
     * Quote.of(bid, ask, bidSize, askSize, ts, sourceId, instrumentId);
     *
     * // ❌ В публичном коде - используй QuoteService
     * const result = QuoteService.create(0.48, 0.52, 100, 150, sourceId, instrumentId);
     * ```
     */
    static of(bid: Price | null, ask: Price | null, bidSize: Quantity, askSize: Quantity, timestamp: Timestamp, sourceId: MarketDataSourceId, instrumentId: InstrumentId): Quote;
    /**
     * Возвращает bid цену
     *
     * @returns Price или null
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * const bid = quote.bid();
     * if (bid !== null) {
     *   console.log(bid.value().toString());
     * }
     * ```
     */
    bid(): Price | null;
    /**
     * Возвращает ask цену
     *
     * @returns Price или null
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * const ask = quote.ask();
     * if (ask !== null) {
     *   console.log(ask.value().toString());
     * }
     * ```
     */
    ask(): Price | null;
    /**
     * Возвращает bid размер
     *
     * @returns Quantity
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * console.log(quote.bidSize().value().toNumber());
     * ```
     */
    bidSize(): Quantity;
    /**
     * Возвращает ask размер
     *
     * @returns Quantity
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * console.log(quote.askSize().value().toNumber());
     * ```
     */
    askSize(): Quantity;
    /**
     * Возвращает Timestamp VO
     *
     * @returns Timestamp объект
     *
     * @remarks
     * Возвращает внутренний Timestamp для использования в операциях с котировками.
     * Для получения только миллисекунд используйте `timestampMs()`.
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * const ts = quote.timestamp();
     * console.log(ts.toISO());
     * ```
     */
    timestamp(): Timestamp;
    /**
     * Возвращает timestamp в Unix ms
     *
     * @returns Decimal (Unix ms)
     *
     * @remarks
     * Возвращает Decimal для единообразия с внутренним представлением.
     * Для преобразования в number используйте `.toNumber()`.
     * Для создания Date используйте `getTimestamp()` или `new Date(timestampMs().toNumber())`.
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * const tsMs = quote.timestampMs();  // Decimal
     * console.log(new Date(tsMs.toNumber()).toISOString());
     * ```
     */
    timestampMs(): Decimal;
    /**
     * Возвращает source ID маркет-данных
     *
     * @returns MarketDataSourceId
     *
     * @remarks
     * Идентифицирует источник данных (WebSocket, REST, Replay и т.д.)
     * Позволяет отследить откуда пришла котировка.
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * const sourceId = quote.sourceId();
     * console.log(sourceId); // 'POLYMARKET_WS'
     * ```
     */
    sourceId(): MarketDataSourceId;
    /**
     * Возвращает ID инструмента
     *
     * @returns InstrumentId
     *
     * @remarks
     * Venue-specific идентификатор инструмента:
     * - Polymarket: token_id (ERC1155 token ID)
     * - Kalshi: ticker (e.g., "INXD-23DEC31-T4120")
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * const instrumentId = quote.instrumentId();
     * console.log(instrumentId); // '123456789' (Polymarket token_id)
     * ```
     */
    instrumentId(): InstrumentId;
    /**
     * Получает timestamp как Date объект
     *
     * @remarks
     * Каждый вызов создаёт новый Date объект (immutability).
     *
     * @returns Date объект (новая копия)
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * const date = quote.getTimestamp();
     * date.setFullYear(2050); // ✅ OK - не влияет на Quote
     * ```
     */
    getTimestamp(): Date;
    /**
     * Вычисляет возраст котировки в миллисекундах
     *
     * @param now - Текущее время (Timestamp VO, по умолчанию Timestamp.now())
     * @returns Возраст котировки в миллисекундах как Decimal
     *
     * @remarks
     * Чистая математика: now - timestamp с использованием Timestamp.diffMs().
     * Полезно для проверок устаревания котировок.
     * Если now < timestamp, возвращает отрицательное значение (котировка из будущего).
     *
     * Timestamp VO гарантирует все инварианты:
     * - Not NaN
     * - Finite
     * - Integer (Unix ms - целое число)
     * - >= 0 (Unix epoch начинается с 0)
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     *
     * // Использование с текущим временем (по умолчанию)
     * const age = quote.age();
     *
     * // Использование с конкретным временем
     * const now = Timestamp.now();
     * const age2 = quote.age(now);
     *
     * // Проверка устаревания
     * if (age.greaterThan(5000)) {
     *   console.log('Quote is older than 5 seconds');
     * }
     * ```
     */
    age(now?: Timestamp): Decimal;
    /**
     * Проверяет, является ли котировка двусторонней
     *
     * @returns true если есть и bid, и ask
     *
     * @example
     * ```typescript
     * const quote = Quote.of(bid, ask, bidSize, askSize, Timestamp.now(), sourceId, instrumentId);
     * if (quote.isTwoSided()) {
     *   console.log('Both sides available');
     * }
     * ```
     */
    isTwoSided(): boolean;
    /**
     * Проверяет, есть ли bid сторона
     *
     * @returns true если bid определён
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * if (quote.hasBid()) {
     *   console.log('Bid:', quote.bid()!.value());
     * }
     * ```
     */
    hasBid(): boolean;
    /**
     * Проверяет, есть ли ask сторона
     *
     * @returns true если ask определён
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * if (quote.hasAsk()) {
     *   console.log('Ask:', quote.ask()!.value());
     * }
     * ```
     */
    hasAsk(): boolean;
    /**
     * Создает объект Spread из bid и ask
     *
     * @returns Spread объект или null если не two-sided
     *
     * @remarks
     * Делегирует создание Spread.of() для двусторонних котировок.
     * Возвращает null для односторонних котировок (bid-only или ask-only).
     *
     * @example
     * ```typescript
     * const quote = Quote.of(bid, ask, bidSize, askSize, Timestamp.now(), sourceId, instrumentId);
     * const spread = quote.spread();
     * if (spread !== null) {
     *   console.log(`Width: ${spread.width().toString()}`);
     *   console.log(`Mid: ${spread.mid().toString()}`);
     * }
     * ```
     */
    spread(): Spread | null;
    /**
     * Сравнивает рыночные данные с другой котировкой
     *
     * @remarks
     * СТРОГОЕ равенство без epsilon.
     * Сравнивает bid, ask и sizes БЕЗ timestamp.
     *
     * Timestamp не включён, так как:
     * - Market data приходит с различной точностью timestamp
     * - Разные источники/адаптеры используют локальное время
     * - Семантически важно "одинаковые рыночные условия", а не "один снимок"
     *
     * Для строгого сравнения включая timestamp используйте equalsWithTimestamp().
     * Консистентно с Price.equals() и Spread.equals() которые не сравнивают метаданные.
     *
     * @param other - Другая котировка
     * @returns true если котировки имеют одинаковые рыночные данные
     *
     * @example
     * ```typescript
     * const ts1 = Timestamp.now();
     * const ts2 = TimestampService.addMs(ts1, 100).value!;
     * const quote1 = Quote.of(bid, ask, bidSize, askSize, ts1, sourceId, instrumentId);
     * const quote2 = Quote.of(bid, ask, bidSize, askSize, ts2, sourceId, instrumentId);
     *
     * // true - одинаковые рыночные условия, разное время
     * console.log(quote1.equals(quote2));
     *
     * // false - это разные снимки данных
     * console.log(quote1.equalsWithTimestamp(quote2));
     * ```
     */
    equals(other: Quote): boolean;
    /**
     * Строгое сравнение включая timestamp
     *
     * @remarks
     * Сравнивает bid, ask, sizes И timestamp.
     * Используйте когда нужно проверить что это именно тот же самый снимок данных.
     *
     * Для большинства случаев используйте equals() без timestamp.
     *
     * @param other - Другая котировка
     * @returns true если котировки полностью идентичны включая timestamp
     *
     * @example
     * ```typescript
     * const ts = Timestamp.now();
     * const quote1 = Quote.of(bid, ask, bidSize, askSize, ts);
     * const quote2 = Quote.of(bid, ask, bidSize, askSize, ts);
     * const quote3 = Quote.of(bid, ask, bidSize, askSize, TimestampService.addMs(ts, 1000).value!);
     *
     * console.log(quote1.equalsWithTimestamp(quote2)); // true
     * console.log(quote1.equalsWithTimestamp(quote3)); // false - разное время
     * console.log(quote1.equals(quote3)); // true - одинаковые рыночные данные
     * ```
     */
    equalsWithTimestamp(other: Quote): boolean;
    /**
     * Ширина spread или 0 если не two-sided
     *
     * @returns Ширина spread (Decimal) или 0
     *
     * @remarks
     * Удобный метод для получения spread без проверки на null.
     * Если котировка не two-sided, возвращает 0.
     *
     * Эквивалентно: `quote.spread()?.width() ?? Decimal.ZERO`
     *
     * @example
     * ```typescript
     * // Two-sided quote
     * const ts = Timestamp.now();
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(100), Quantity.of(150), ts, sourceId, instrumentId);
     * console.log(quote.spreadWidthOrZero().toNumber()); // 0.04
     *
     * // Bid-only quote
     * const bidOnly = Quote.of(Price.of(0.50), null, Quantity.of(100), Quantity.ZERO, ts, sourceId, instrumentId);
     * console.log(bidOnly.spreadWidthOrZero().toNumber()); // 0
     * ```
     */
    spreadWidthOrZero(): Decimal;
    /**
     * Mid price (средняя цена между bid и ask) или null
     *
     * @returns Decimal mid price или null если не two-sided
     *
     * @remarks
     * Mid price - это метрика, не рыночная сущность.
     * Возвращает Decimal, а не Price, чтобы избежать ложной типизации.
     *
     * Если нужен Price объект, вызывающий должен явно создать его:
     * ```typescript
     * const mid = quote.midOrNull();
     * if (mid !== null) {
     *   const priceResult = PriceService.create(mid);
     * }
     * ```
     *
     * Формула: (bid + ask) / 2
     *
     * @example
     * ```typescript
     * // Two-sided quote
     * const ts = Timestamp.now();
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(100), Quantity.of(150), ts, sourceId, instrumentId);
     * const mid = quote.midOrNull();
     * console.log(mid?.toNumber()); // 0.50
     *
     * // Bid-only quote
     * const bidOnly = Quote.of(Price.of(0.50), null, Quantity.of(100), Quantity.ZERO, ts, sourceId, instrumentId);
     * console.log(bidOnly.midOrNull()); // null
     * ```
     */
    midOrNull(): Decimal | null;
    /**
     * Дисбаланс размеров bid/ask
     *
     * @returns Decimal от -1 до 1:
     *   - `-1` = только ask (no bid)
     *   - `0` = идеальный баланс (bidSize === askSize)
     *   - `+1` = только bid (no ask)
     *
     * @remarks
     * Формула: (bidSize - askSize) / (bidSize + askSize)
     *
     * Если оба размера 0, возвращает 0 (нейтральный дисбаланс).
     *
     * Интерпретация:
     * - Положительный imbalance → больше bid ликвидности
     * - Отрицательный imbalance → больше ask ликвидности
     * - Близко к 0 → сбалансированная ликвидность
     *
     * @example
     * ```typescript
     * const ts = Timestamp.now();
     * // Сбалансированная котировка
     * const balanced = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(100), Quantity.of(100), ts, sourceId, instrumentId);
     * console.log(balanced.imbalance().toNumber()); // 0
     *
     * // Больше bid ликвидности
     * const bidHeavy = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(150), Quantity.of(50), ts, sourceId, instrumentId);
     * console.log(bidHeavy.imbalance().toNumber()); // 0.5 (50% дисбаланс в сторону bid)
     *
     * // Больше ask ликвидности
     * const askHeavy = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(50), Quantity.of(150), ts, sourceId, instrumentId);
     * console.log(askHeavy.imbalance().toNumber()); // -0.5 (50% дисбаланс в сторону ask)
     * ```
     */
    imbalance(): Decimal;
    /**
     * Spread в процентах от mid price (как дробь)
     *
     * @returns Ratio с дробным представлением процента, или null если не two-sided
     *
     * @remarks
     * **ВАЖНО:** Возвращает дробь (fraction), не проценты!
     * - Ratio хранит дробь: 0.08 означает 8%, не число 8
     * - Для отображения: умножьте на 100 (например, `ratio.toDecimal().times(100)`)
     *
     * Формула: spread.width / mid (БЕЗ умножения на 100)
     *
     * Пример для bid 0.48, ask 0.52:
     * - mid = 0.50
     * - spread = 0.04
     * - результат = 0.04 / 0.50 = 0.08 (представляет 8%)
     *
     * @example
     * ```typescript
     * const quote = Quote.of(
     *   Price.of(new Decimal(0.48)),
     *   Price.of(new Decimal(0.52)),
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(150)),
     *   Timestamp.now(),
     *   'POLYMARKET_WS' as MarketDataSourceId,
     *   'TEST_MARKET' as InstrumentId
     * );
     * const ratio = quote.spreadPercentage();
     * console.log(ratio?.toDecimal().toNumber()); // 0.08 (8% как дробь)
     *
     * // Для отображения в процентах:
     * const percent = ratio?.toDecimal().times(100).toNumber(); // 8.0
     * ```
     */
    spreadPercentage(): Ratio | null;
}
//# sourceMappingURL=Quote.d.ts.map