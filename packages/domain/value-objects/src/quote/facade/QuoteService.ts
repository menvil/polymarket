import { Result, Ok, Err, isErr } from '@polymarket/result';
import {
  InvalidQuoteError,
  ErrorSource,
  toDecimal,
  rewrap,
  wrapOp,
  unexpectedError,
  toCause
} from '@polymarket/errors';
import Decimal from 'decimal.js';
import type { IClock } from '@polymarket/time';
import type { MarketDataSourceId, InstrumentId } from '@polymarket/ids';
import { Price } from '../../price/core/Price.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { Quote, QuoteInvariantViolation } from '../core/index.js';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';
import { PriceService } from '../../price/facade/PriceService.js';
import { QuantityService } from '../../quantity/facade/QuantityService.js';
import { Ratio } from '../../ratio/core/Ratio.js';
import { SpreadService } from '../../spread/facade/SpreadService.js';

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
export class QuoteService {
  private static readonly SERVICE_NAME = 'QuoteService';

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
  private static parseDecimal(
    field: string,
    value: Decimal | number | string,
    reason: QuoteErrorReason
  ): Result<Decimal, InvalidQuoteError> {
    const result = toDecimal(field, value, reason, InvalidQuoteError);
    if (isErr(result)) {
      return Err(rewrap(QuoteService.SERVICE_NAME, 'parseDecimal', {}, result.error, InvalidQuoteError));
    }
    return result;
  }

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
  private static parseOptionalDecimal(
    field: string,
    value: Decimal | number | string | null,
    reason: QuoteErrorReason
  ): Result<Decimal | null, InvalidQuoteError> {
    if (value === null) {
      return Ok(null);
    }
    return QuoteService.parseDecimal(field, value, reason);
  }

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
  public static create(
    bidValue: Decimal | number | string | null,
    askValue: Decimal | number | string | null,
    bidSizeValue: Decimal | number | string,
    askSizeValue: Decimal | number | string,
    sourceId: MarketDataSourceId,
    instrumentId: InstrumentId,
    timestamp?: Date | Decimal | number | string
  ): Result<Quote, InvalidQuoteError> {
    const op = 'create';
    const ctx = {
      bidValue: bidValue !== null ? bidValue.toString() : null,
      askValue: askValue !== null ? askValue.toString() : null,
      bidSizeValue: bidSizeValue.toString(),
      askSizeValue: askSizeValue.toString(),
      timestamp: timestamp !== undefined ? timestamp.toString() : undefined
    };

    return wrapOp(QuoteService.SERVICE_NAME, op, ctx, () => {
      // Конвертируем bid через parseOptionalDecimal
      const bidResult = QuoteService.parseOptionalDecimal(
        'bidValue',
        bidValue,
        QuoteErrorReason.INVALID_FORMAT
      );
      if (isErr(bidResult)) {
        return Err(rewrap(QuoteService.SERVICE_NAME, op, { component: 'bid' }, bidResult.error, InvalidQuoteError));
      }
      const bidDecimal = bidResult.value;

      // Конвертируем ask через parseOptionalDecimal
      const askResult = QuoteService.parseOptionalDecimal(
        'askValue',
        askValue,
        QuoteErrorReason.INVALID_FORMAT
      );
      if (isErr(askResult)) {
        return Err(rewrap(QuoteService.SERVICE_NAME, op, { component: 'ask' }, askResult.error, InvalidQuoteError));
      }
      const askDecimal = askResult.value;

      // Конвертируем bidSize через parseDecimal
      const bidSizeDecimalResult = QuoteService.parseDecimal(
        'bidSizeValue',
        bidSizeValue,
        QuoteErrorReason.INVALID_FORMAT
      );
      if (isErr(bidSizeDecimalResult)) {
        return bidSizeDecimalResult;
      }

      // Конвертируем askSize через parseDecimal
      const askSizeDecimalResult = QuoteService.parseDecimal(
        'askSizeValue',
        askSizeValue,
        QuoteErrorReason.INVALID_FORMAT
      );
      if (isErr(askSizeDecimalResult)) {
        return askSizeDecimalResult;
      }

      // Конвертируем timestamp через parseDecimal
      let timestampDecimal: Decimal;
      if (timestamp !== undefined) {
        // Date → number (getTime)
        const tsValue = timestamp instanceof Date ? timestamp.getTime() : timestamp;
        const tsResult = QuoteService.parseDecimal(
          'timestamp',
          tsValue,
          QuoteErrorReason.INVALID_FORMAT
        );
        if (isErr(tsResult)) {
          return tsResult;
        }
        timestampDecimal = tsResult.value;
      } else {
        // Default: текущее время
        timestampDecimal = new Decimal(Date.now());
      }

      // Создаём Price объекты через helper
      const bidPriceResult = this.createPrice(bidDecimal, 'bid', op);
      if (isErr(bidPriceResult)) return bidPriceResult;
      const bid = bidPriceResult.value;

      const askPriceResult = this.createPrice(askDecimal, 'ask', op);
      if (isErr(askPriceResult)) return askPriceResult;
      const ask = askPriceResult.value;

      // Создаём Quantity объекты через helper
      const bidSizeQuantityResult = this.createQuantity(bidSizeDecimalResult.value, 'bidSize', op);
      if (isErr(bidSizeQuantityResult)) return bidSizeQuantityResult;

      const askSizeQuantityResult = this.createQuantity(askSizeDecimalResult.value, 'askSize', op);
      if (isErr(askSizeQuantityResult)) return askSizeQuantityResult;

      // Создаём Quote через Core (может бросить QuoteInvariantViolation)
      try {
        const quote = Quote.of(
          bid,
          ask,
          bidSizeQuantityResult.value,
          askSizeQuantityResult.value,
          timestampDecimal,
          sourceId,
          instrumentId
        );
        return Ok(quote);
      } catch (error) {
        // Обработка инвариантов Core
        if (error instanceof QuoteInvariantViolation) {
          return Err(
            new InvalidQuoteError(error.message, {
              context: {
                source: ErrorSource.CORE_INVARIANT,
                service: QuoteService.SERVICE_NAME, // Set root service field
                op,
                reason: error.reason
              }
            })
          );
        }

        // Неожиданная ошибка
        return Err(
          unexpectedError(error, InvalidQuoteError)
        );
      }
    }, InvalidQuoteError);
  }

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
  public static bidOnly(
    bidValue: Decimal | number | string,
    bidSizeValue: Decimal | number | string,
    sourceId: MarketDataSourceId,
    instrumentId: InstrumentId,
    timestamp?: Date | Decimal | number | string
  ): Result<Quote, InvalidQuoteError> {
    // Делегируем на create с null для ask
    return QuoteService.create(
      bidValue,
      null, // ask отсутствует
      bidSizeValue,
      0, // zero ask size
      sourceId,
      instrumentId,
      timestamp
    );
  }

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
  public static askOnly(
    askValue: Decimal | number | string,
    askSizeValue: Decimal | number | string,
    sourceId: MarketDataSourceId,
    instrumentId: InstrumentId,
    timestamp?: Date | Decimal | number | string
  ): Result<Quote, InvalidQuoteError> {
    // Делегируем на create с null для bid
    return QuoteService.create(
      null, // bid отсутствует
      askValue,
      0, // zero bid size
      askSizeValue,
      sourceId,
      instrumentId,
      timestamp
    );
  }

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
  public static shift(
    quote: Quote,
    shiftAmount: Decimal | number | string
  ): Result<Quote, InvalidQuoteError> {
    const op = 'shift';
    const ctx = {
      quoteBid: quote.bid()?.value().toString() ?? null,
      quoteAsk: quote.ask()?.value().toString() ?? null,
      shiftAmount: shiftAmount.toString()
    };

    return wrapOp(QuoteService.SERVICE_NAME, op, ctx, () => {
      // Конвертируем shiftAmount в Decimal через parseDecimal
      const shiftDecimalResult = QuoteService.parseDecimal(
        'shiftAmount',
        shiftAmount,
        QuoteErrorReason.INVALID_FORMAT
      );
      if (isErr(shiftDecimalResult)) {
        return shiftDecimalResult;
      }
      const shiftDecimal = shiftDecimalResult.value;

      let newBidDecimal: Decimal | null = null;
      if (quote.bid() !== null) {
        newBidDecimal = quote.bid()!.value().plus(shiftDecimal);
      }

      let newAskDecimal: Decimal | null = null;
      if (quote.ask() !== null) {
        newAskDecimal = quote.ask()!.value().plus(shiftDecimal);
      }

      // ВАЖНО: Сохраняем timestamp исходной котировки (нейтральная трансформация)
      return QuoteService.create(
        newBidDecimal,
        newAskDecimal,
        quote.bidSize().value(),
        quote.askSize().value(),
        quote.sourceId(), // Сохраняем sourceId
        quote.instrumentId(), // Сохраняем instrumentId
        quote.timestampMs() // Сохраняем оригинальный timestamp
      );
    }, InvalidQuoteError);
  }

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
  public static shiftWithRefresh(
    quote: Quote,
    shiftAmount: Decimal | number | string,
    clock: IClock
  ): Result<Quote, InvalidQuoteError> {
    const op = 'shiftWithRefresh';
    const ctx = {
      quoteBid: quote.bid()?.value().toString() ?? null,
      quoteAsk: quote.ask()?.value().toString() ?? null,
      shiftAmount: shiftAmount.toString()
    };

    return wrapOp(QuoteService.SERVICE_NAME, op, ctx, () => {
      // Конвертируем shiftAmount в Decimal через parseDecimal
      const shiftDecimalResult = QuoteService.parseDecimal(
        'shiftAmount',
        shiftAmount,
        QuoteErrorReason.INVALID_FORMAT
      );
      if (isErr(shiftDecimalResult)) {
        return shiftDecimalResult;
      }
      const shiftDecimal = shiftDecimalResult.value;

      let newBidDecimal: Decimal | null = null;
      if (quote.bid() !== null) {
        newBidDecimal = quote.bid()!.value().plus(shiftDecimal);
      }

      let newAskDecimal: Decimal | null = null;
      if (quote.ask() !== null) {
        newAskDecimal = quote.ask()!.value().plus(shiftDecimal);
      }

      // Обновляем timestamp из clock (новая котировка)
      return QuoteService.create(
        newBidDecimal,
        newAskDecimal,
        quote.bidSize().value(),
        quote.askSize().value(),
        quote.sourceId(), // Сохраняем sourceId
        quote.instrumentId(), // Сохраняем instrumentId
        clock.now() // Новый timestamp от clock
      );
    }, InvalidQuoteError);
  }

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
  public static skew(
    quote: Quote,
    bidAdjustment: Decimal | number | string,
    askAdjustment: Decimal | number | string
  ): Result<Quote, InvalidQuoteError> {
    const op = 'skew';
    const ctx = {
      quoteBid: quote.bid()?.value().toString() ?? null,
      quoteAsk: quote.ask()?.value().toString() ?? null,
      rawBidAdjustment: bidAdjustment.toString(),
      rawAskAdjustment: askAdjustment.toString()
    };

    return wrapOp(QuoteService.SERVICE_NAME, op, ctx, () => {
      // Конвертируем bidAdjustment в Decimal через parseDecimal
      const bidAdjustmentResult = QuoteService.parseDecimal(
        'bidAdjustment',
        bidAdjustment,
        QuoteErrorReason.INVALID_FORMAT
      );
      if (isErr(bidAdjustmentResult)) {
        return bidAdjustmentResult;
      }
      const bidAdjustmentDecimal = bidAdjustmentResult.value;

      // Конвертируем askAdjustment в Decimal через parseDecimal
      const askAdjustmentResult = QuoteService.parseDecimal(
        'askAdjustment',
        askAdjustment,
        QuoteErrorReason.INVALID_FORMAT
      );
      if (isErr(askAdjustmentResult)) {
        return askAdjustmentResult;
      }
      const askAdjustmentDecimal = askAdjustmentResult.value;

      let newBidDecimal: Decimal | null = null;
      if (quote.bid() !== null) {
        newBidDecimal = quote.bid()!.value().plus(bidAdjustmentDecimal);
      }

      let newAskDecimal: Decimal | null = null;
      if (quote.ask() !== null) {
        newAskDecimal = quote.ask()!.value().plus(askAdjustmentDecimal);
      }

      // ВАЖНО: Сохраняем timestamp исходной котировки (нейтральная трансформация)
      return QuoteService.create(
        newBidDecimal,
        newAskDecimal,
        quote.bidSize().value(),
        quote.askSize().value(),
        quote.sourceId(), // Сохраняем sourceId
        quote.instrumentId(), // Сохраняем instrumentId
        quote.timestampMs()
      );
    }, InvalidQuoteError);
  }

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
  public static skewWithRefresh(
    quote: Quote,
    bidAdjustment: Decimal | number | string,
    askAdjustment: Decimal | number | string,
    clock: IClock
  ): Result<Quote, InvalidQuoteError> {
    const op = 'skewWithRefresh';
    const ctx = {
      quoteBid: quote.bid()?.value().toString() ?? null,
      quoteAsk: quote.ask()?.value().toString() ?? null,
      rawBidAdjustment: bidAdjustment.toString(),
      rawAskAdjustment: askAdjustment.toString()
    };

    return wrapOp(QuoteService.SERVICE_NAME, op, ctx, () => {
      // Конвертируем bidAdjustment в Decimal через parseDecimal
      const bidAdjustmentResult = QuoteService.parseDecimal(
        'bidAdjustment',
        bidAdjustment,
        QuoteErrorReason.INVALID_FORMAT
      );
      if (isErr(bidAdjustmentResult)) {
        return bidAdjustmentResult;
      }
      const bidAdjustmentDecimal = bidAdjustmentResult.value;

      // Конвертируем askAdjustment в Decimal через parseDecimal
      const askAdjustmentResult = QuoteService.parseDecimal(
        'askAdjustment',
        askAdjustment,
        QuoteErrorReason.INVALID_FORMAT
      );
      if (isErr(askAdjustmentResult)) {
        return askAdjustmentResult;
      }
      const askAdjustmentDecimal = askAdjustmentResult.value;

      let newBidDecimal: Decimal | null = null;
      if (quote.bid() !== null) {
        newBidDecimal = quote.bid()!.value().plus(bidAdjustmentDecimal);
      }

      let newAskDecimal: Decimal | null = null;
      if (quote.ask() !== null) {
        newAskDecimal = quote.ask()!.value().plus(askAdjustmentDecimal);
      }

      // Обновляем timestamp из clock (новая котировка)
      return QuoteService.create(
        newBidDecimal,
        newAskDecimal,
        quote.bidSize().value(),
        quote.askSize().value(),
        quote.sourceId(), // Сохраняем sourceId
        quote.instrumentId(), // Сохраняем instrumentId
        clock.now()
      );
    }, InvalidQuoteError);
  }

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
  public static updateSizes(
    quote: Quote,
    newBidSize: Decimal | number | string | Quantity,
    newAskSize: Decimal | number | string | Quantity
  ): Result<Quote, InvalidQuoteError> {
    const op = 'updateSizes';
    const ctx = {
      quoteBid: quote.bid()?.value().toString() ?? null,
      quoteAsk: quote.ask()?.value().toString() ?? null,
      newBidSize: newBidSize instanceof Quantity ? newBidSize.value().toString() : newBidSize.toString(),
      newAskSize: newAskSize instanceof Quantity ? newAskSize.value().toString() : newAskSize.toString()
    };

    return wrapOp(QuoteService.SERVICE_NAME, op, ctx, () => {
      // Конвертируем в Quantity если нужно
      let bidSize: Quantity;
      if (newBidSize instanceof Quantity) {
        bidSize = newBidSize;
      } else {
        const bidSizeResult = QuantityService.create(newBidSize);
        if (isErr(bidSizeResult)) {
          // Передаём оригинальную ошибку в rewrap, который сохранит все root fields
          return Err(
            rewrap(
              QuoteService.SERVICE_NAME,
              op,
              {
                component: 'bidSize', // Добавляем component т.к. QuantityService.create возвращает field: 'value'
                reason: QuoteErrorReason.INVALID_BID_SIZE, // Override reason
                cause: toCause(bidSizeResult.error) // Add cause
              },
              bidSizeResult.error, // Передаём оригинальную ошибку
              InvalidQuoteError
            )
          );
        }
        bidSize = bidSizeResult.value;
      }

      let askSize: Quantity;
      if (newAskSize instanceof Quantity) {
        askSize = newAskSize;
      } else {
        const askSizeResult = QuantityService.create(newAskSize);
        if (isErr(askSizeResult)) {
          // Передаём оригинальную ошибку в rewrap, который сохранит все root fields
          return Err(
            rewrap(
              QuoteService.SERVICE_NAME,
              op,
              {
                component: 'askSize', // Добавляем component т.к. QuantityService.create возвращает field: 'value'
                reason: QuoteErrorReason.INVALID_ASK_SIZE, // Override reason
                cause: toCause(askSizeResult.error) // Add cause
              },
              askSizeResult.error, // Передаём оригинальную ошибку
              InvalidQuoteError
            )
          );
        }
        askSize = askSizeResult.value;
      }

      // Создаём новую котировку через Core (preserving timestamp)
      try {
        const newQuote = Quote.of(
          quote.bid(),
          quote.ask(),
          bidSize,
          askSize,
          quote.timestampMs(),
          quote.sourceId(), // Сохраняем sourceId
          quote.instrumentId() // Сохраняем instrumentId
        );
        return Ok(newQuote);
      } catch (error) {
        if (error instanceof QuoteInvariantViolation) {
          return Err(
            new InvalidQuoteError(error.message, {
              context: {
                source: ErrorSource.CORE_INVARIANT,
                service: QuoteService.SERVICE_NAME, // Set root service field
                op,
                reason: error.reason
              }
            })
          );
        }

        return Err(
          unexpectedError(error, InvalidQuoteError)
        );
      }
    }, InvalidQuoteError);
  }

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
  public static updateSizesWithRefresh(
    quote: Quote,
    newBidSize: Decimal | number | string | Quantity,
    newAskSize: Decimal | number | string | Quantity,
    clock: IClock
  ): Result<Quote, InvalidQuoteError> {
    const op = 'updateSizesWithRefresh';
    const ctx = {
      quoteBid: quote.bid()?.value().toString() ?? null,
      quoteAsk: quote.ask()?.value().toString() ?? null,
      newBidSize: newBidSize instanceof Quantity ? newBidSize.value().toString() : newBidSize.toString(),
      newAskSize: newAskSize instanceof Quantity ? newAskSize.value().toString() : newAskSize.toString()
    };

    return wrapOp(QuoteService.SERVICE_NAME, op, ctx, () => {

      // Конвертируем в Quantity если нужно
      let bidSize: Quantity;
      if (newBidSize instanceof Quantity) {
        bidSize = newBidSize;
      } else {
        const bidSizeResult = QuantityService.create(newBidSize);
        if (isErr(bidSizeResult)) {
          // Передаём оригинальную ошибку в rewrap, который сохранит все root fields
          return Err(
            rewrap(
              QuoteService.SERVICE_NAME,
              op,
              {
                component: 'bidSize', // Добавляем component т.к. QuantityService.create возвращает field: 'value'
                reason: QuoteErrorReason.INVALID_BID_SIZE, // Override reason
                cause: toCause(bidSizeResult.error) // Add cause
              },
              bidSizeResult.error, // Передаём оригинальную ошибку
              InvalidQuoteError
            )
          );
        }
        bidSize = bidSizeResult.value;
      }

      let askSize: Quantity;
      if (newAskSize instanceof Quantity) {
        askSize = newAskSize;
      } else {
        const askSizeResult = QuantityService.create(newAskSize);
        if (isErr(askSizeResult)) {
          // Передаём оригинальную ошибку в rewrap, который сохранит все root fields
          return Err(
            rewrap(
              QuoteService.SERVICE_NAME,
              op,
              {
                component: 'askSize', // Добавляем component т.к. QuantityService.create возвращает field: 'value'
                reason: QuoteErrorReason.INVALID_ASK_SIZE, // Override reason
                cause: toCause(askSizeResult.error) // Add cause
              },
              askSizeResult.error, // Передаём оригинальную ошибку
              InvalidQuoteError
            )
          );
        }
        askSize = askSizeResult.value;
      }

      // Создаём новую котировку через Core (refreshing timestamp)
      try {
        const newQuote = Quote.of(
          quote.bid(),
          quote.ask(),
          bidSize,
          askSize,
          new Decimal(clock.now().getTime()),
          quote.sourceId(), // Сохраняем sourceId
          quote.instrumentId() // Сохраняем instrumentId
        );
        return Ok(newQuote);
      } catch (error) {
        if (error instanceof QuoteInvariantViolation) {
          return Err(
            new InvalidQuoteError(error.message, {
              context: {
                source: ErrorSource.CORE_INVARIANT,
                service: QuoteService.SERVICE_NAME,
                op,
                reason: error.reason
              }
            })
          );
        }
        return Err(
          unexpectedError(error, InvalidQuoteError)
        );
      }
    }, InvalidQuoteError);
  }

  // ============================================================================
  // Ratio Operations (Metrics)
  // ============================================================================

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
  public static getMidPrice(
    quote: Quote
  ): Result<Price, InvalidQuoteError> {
    return wrapOp(
      QuoteService.SERVICE_NAME,
      'getMidPrice',
      { bid: quote.spread()?.bid()?.value()?.toString() ?? 'null', ask: quote.spread()?.ask()?.value()?.toString() ?? 'null' },
      () => {
        // Validate two-sided quote (required for mid price)
        if (!quote.spread()) {
          throw new InvalidQuoteError(
            () => 'Cannot get mid price for one-sided quote',
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.NOT_TWO_SIDED,
                bid: quote.bid()?.value()?.toString() ?? 'null',
                ask: quote.ask()?.value()?.toString() ?? 'null',
              },
            }
          );
        }

        // Delegate to SpreadService
        const spreadMidResult = SpreadService.getMidPrice(quote.spread()!);

        if (isErr(spreadMidResult)) {
          // Re-wrap SpreadError as QuoteError
          throw new InvalidQuoteError(
            (ctx) => `Cannot get mid price: ${ctx.spreadError}`,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.NOT_TWO_SIDED,
                bid: quote.spread()?.bid()?.value()?.toString() ?? 'null',
                ask: quote.spread()?.ask()?.value()?.toString() ?? 'null',
                spreadError: spreadMidResult.error.message,
              },
            }
          );
        }

        return Ok(spreadMidResult.value);
      },
      InvalidQuoteError
    );
  }

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
  public static getSpreadRatio(
    quote: Quote
  ): Result<Ratio, InvalidQuoteError> {
    return wrapOp(
      QuoteService.SERVICE_NAME,
      'getSpreadRatio',
      { bid: quote.spread()?.bid()?.value()?.toString() ?? 'null', ask: quote.spread()?.ask()?.value()?.toString() ?? 'null' },
      () => {
        // Validate two-sided quote (required for spread ratio)
        if (!quote.spread()) {
          throw new InvalidQuoteError(
            () => 'Cannot get spread ratio for one-sided quote',
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.MID_UNAVAILABLE,
                bid: quote.bid()?.value()?.toString() ?? 'null',
                ask: quote.ask()?.value()?.toString() ?? 'null',
              },
            }
          );
        }

        // Delegate to SpreadService
        const spreadRatioResult = SpreadService.getSpreadRatio(quote.spread()!);

        if (isErr(spreadRatioResult)) {
          // Re-wrap SpreadError as QuoteError
          throw new InvalidQuoteError(
            (ctx) => `Cannot get spread ratio: ${ctx.spreadError}`,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.MID_UNAVAILABLE,
                bid: quote.spread()?.bid()?.value()?.toString() ?? 'null',
                ask: quote.spread()?.ask()?.value()?.toString() ?? 'null',
                spreadError: spreadRatioResult.error.message,
              },
            }
          );
        }

        return Ok(spreadRatioResult.value);
      },
      InvalidQuoteError
    );
  }

  // ============================================================================
  // Ratio Operations (Transformations)
  // ============================================================================

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
  public static shiftByRatio(
    quote: Quote,
    shiftRatio: Ratio
  ): Result<Quote, InvalidQuoteError> {
    return wrapOp(
      QuoteService.SERVICE_NAME,
      'shiftByRatio',
      {
        bid: quote.spread()?.bid()?.value()?.toString() ?? 'null',
        ask: quote.spread()?.ask()?.value()?.toString() ?? 'null',
        shiftRatio: shiftRatio.toDecimal().toString()
      },
      () => {
        // Validate two-sided quote (required for shift operation)
        if (!quote.spread()) {
          throw new InvalidQuoteError(
            () => 'Cannot shift one-sided quote',
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.NOT_TWO_SIDED,
                bid: quote.bid()?.value()?.toString() ?? 'null',
                ask: quote.ask()?.value()?.toString() ?? 'null',
              },
            }
          );
        }

        const newSpreadResult = SpreadService.shiftByRatio(quote.spread()!, shiftRatio);

        if (isErr(newSpreadResult)) {
          throw new InvalidQuoteError(
            (ctx) => `Cannot shift quote by ratio: ${ctx.spreadError}`,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.RATIO_OUT_OF_BOUNDS,
                bid: quote.spread()?.bid()?.value()?.toString() ?? 'null',
                ask: quote.spread()?.ask()?.value()?.toString() ?? 'null',
                shiftRatio: shiftRatio.toDecimal().toString(),
                spreadError: newSpreadResult.error.message,
              },
            }
          );
        }

        const newSpread = newSpreadResult.value;
        const newQuote = Quote.of(
          newSpread.bid()!,
          newSpread.ask()!,
          quote.bidSize(),
          quote.askSize(),
          quote.timestampMs(),
          quote.sourceId(),
          quote.instrumentId()
        );

        return Ok(newQuote);
      },
      InvalidQuoteError
    );
  }

  /**
   * Расширяет spread quote на долю от midpoint
   */
  public static widenByRatio(
    quote: Quote,
    deltaWidthRatio: Ratio
  ): Result<Quote, InvalidQuoteError> {
    return wrapOp(
      QuoteService.SERVICE_NAME,
      'widenByRatio',
      {
        bid: quote.spread()?.bid()?.value()?.toString() ?? 'null',
        ask: quote.spread()?.ask()?.value()?.toString() ?? 'null',
        deltaWidthRatio: deltaWidthRatio.toDecimal().toString()
      },
      () => {
        // Validate two-sided quote (required for widen operation)
        if (!quote.spread()) {
          throw new InvalidQuoteError(
            () => 'Cannot widen one-sided quote',
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.NOT_TWO_SIDED,
                bid: quote.bid()?.value()?.toString() ?? 'null',
                ask: quote.ask()?.value()?.toString() ?? 'null',
              },
            }
          );
        }

        const newSpreadResult = SpreadService.widenByRatio(quote.spread()!, deltaWidthRatio);

        if (isErr(newSpreadResult)) {
          throw new InvalidQuoteError(
            (ctx) => `Cannot widen quote by ratio: ${ctx.spreadError}`,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.RATIO_OUT_OF_BOUNDS,
                bid: quote.spread()?.bid()?.value()?.toString() ?? 'null',
                ask: quote.spread()?.ask()?.value()?.toString() ?? 'null',
                deltaWidthRatio: deltaWidthRatio.toDecimal().toString(),
                spreadError: newSpreadResult.error.message,
              },
            }
          );
        }

        const newSpread = newSpreadResult.value;
        const newQuote = Quote.of(
          newSpread.bid()!,
          newSpread.ask()!,
          quote.bidSize(),
          quote.askSize(),
          quote.timestampMs(),
          quote.sourceId(),
          quote.instrumentId()
        );

        return Ok(newQuote);
      },
      InvalidQuoteError
    );
  }

  /**
   * Сужает spread quote на долю от midpoint
   */
  public static tightenByRatio(
    quote: Quote,
    deltaWidthRatio: Ratio
  ): Result<Quote, InvalidQuoteError> {
    return wrapOp(
      QuoteService.SERVICE_NAME,
      'tightenByRatio',
      {
        bid: quote.spread()?.bid()?.value()?.toString() ?? 'null',
        ask: quote.spread()?.ask()?.value()?.toString() ?? 'null',
        deltaWidthRatio: deltaWidthRatio.toDecimal().toString()
      },
      () => {
        // Validate two-sided quote (required for tighten operation)
        if (!quote.spread()) {
          throw new InvalidQuoteError(
            () => 'Cannot tighten one-sided quote',
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.NOT_TWO_SIDED,
                bid: quote.bid()?.value()?.toString() ?? 'null',
                ask: quote.ask()?.value()?.toString() ?? 'null',
              },
            }
          );
        }

        const newSpreadResult = SpreadService.tightenByRatio(quote.spread()!, deltaWidthRatio);

        if (isErr(newSpreadResult)) {
          throw new InvalidQuoteError(
            (ctx) => `Cannot tighten quote by ratio: ${ctx.spreadError}`,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.RATIO_OUT_OF_BOUNDS,
                bid: quote.spread()?.bid()?.value()?.toString() ?? 'null',
                ask: quote.spread()?.ask()?.value()?.toString() ?? 'null',
                deltaWidthRatio: deltaWidthRatio.toDecimal().toString(),
                spreadError: newSpreadResult.error.message,
              },
            }
          );
        }

        const newSpread = newSpreadResult.value;
        const newQuote = Quote.of(
          newSpread.bid()!,
          newSpread.ask()!,
          quote.bidSize(),
          quote.askSize(),
          quote.timestampMs(),
          quote.sourceId(),
          quote.instrumentId()
        );

        return Ok(newQuote);
      },
      InvalidQuoteError
    );
  }

  /**
   * Наклоняет quote spread на доли от midpoint
   */
  public static skewByRatio(
    quote: Quote,
    bidRatio: Ratio,
    askRatio: Ratio
  ): Result<Quote, InvalidQuoteError> {
    return wrapOp(
      QuoteService.SERVICE_NAME,
      'skewByRatio',
      {
        bid: quote.spread()?.bid()?.value()?.toString() ?? 'null',
        ask: quote.spread()?.ask()?.value()?.toString() ?? 'null',
        bidRatio: bidRatio.toDecimal().toString(),
        askRatio: askRatio.toDecimal().toString()
      },
      () => {
        // Validate two-sided quote (required for skew operation)
        if (!quote.spread()) {
          throw new InvalidQuoteError(
            () => 'Cannot skew one-sided quote',
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.NOT_TWO_SIDED,
                bid: quote.bid()?.value()?.toString() ?? 'null',
                ask: quote.ask()?.value()?.toString() ?? 'null',
              },
            }
          );
        }

        const newSpreadResult = SpreadService.skewByRatio(quote.spread()!, bidRatio, askRatio);

        if (isErr(newSpreadResult)) {
          throw new InvalidQuoteError(
            (ctx) => `Cannot skew quote by ratio: ${ctx.spreadError}`,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.RATIO_OUT_OF_BOUNDS,
                bid: quote.spread()?.bid()?.value()?.toString() ?? 'null',
                ask: quote.spread()?.ask()?.value()?.toString() ?? 'null',
                bidRatio: bidRatio.toDecimal().toString(),
                askRatio: askRatio.toDecimal().toString(),
                spreadError: newSpreadResult.error.message,
              },
            }
          );
        }

        const newSpread = newSpreadResult.value;
        const newQuote = Quote.of(
          newSpread.bid()!,
          newSpread.ask()!,
          quote.bidSize(),
          quote.askSize(),
          quote.timestampMs(),
          quote.sourceId(),
          quote.instrumentId()
        );

        return Ok(newQuote);
      },
      InvalidQuoteError
    );
  }

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
  public static scaleSizesByRatio(
    quote: Quote,
    sizeFactor: Ratio
  ): Result<Quote, InvalidQuoteError> {
    return wrapOp(
      QuoteService.SERVICE_NAME,
      'scaleSizesByRatio',
      {
        bidSize: quote.bidSize().toNumber(),
        askSize: quote.askSize().toNumber(),
        sizeFactor: sizeFactor.toDecimal().toString()
      },
      () => {
        // 1. Validate sizeFactor > 0
        if (sizeFactor.toDecimal().lessThanOrEqualTo(0)) {
          throw new InvalidQuoteError(
            () => 'Size factor must be positive',
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.INVALID_SIZE_FACTOR,
                sizeFactor: sizeFactor.toDecimal().toString(),
              },
            }
          );
        }

        // 2. Scale bid size
        const newBidSizeResult = QuantityService.multiply(
          quote.bidSize(),
          sizeFactor.toDecimal()
        );

        if (isErr(newBidSizeResult)) {
          throw new InvalidQuoteError(
            (ctx) => `Cannot scale bid size: ${ctx.quantityError}`,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.INVALID_FORMAT,
                bidSize: quote.bidSize().toNumber(),
                sizeFactor: sizeFactor.toDecimal().toString(),
                quantityError: newBidSizeResult.error.message,
              },
            }
          );
        }

        // 3. Scale ask size
        const newAskSizeResult = QuantityService.multiply(
          quote.askSize(),
          sizeFactor.toDecimal()
        );

        if (isErr(newAskSizeResult)) {
          throw new InvalidQuoteError(
            (ctx) => `Cannot scale ask size: ${ctx.quantityError}`,
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.INVALID_FORMAT,
                askSize: quote.askSize().toNumber(),
                sizeFactor: sizeFactor.toDecimal().toString(),
                quantityError: newAskSizeResult.error.message,
              },
            }
          );
        }

        // 4. Validate two-sided quote (required for accessing spread)
        if (!quote.spread()) {
          throw new InvalidQuoteError(
            () => 'Cannot scale sizes for one-sided quote',
            {
              context: {
                source: ErrorSource.SERVICE_CALL,
                reason: QuoteErrorReason.NOT_TWO_SIDED,
                bid: quote.bid()?.value()?.toString() ?? 'null',
                ask: quote.ask()?.value()?.toString() ?? 'null',
              },
            }
          );
        }

        // 5. Create new Quote with same spread, new sizes
        const newQuote = Quote.of(
          quote.spread()!.bid()!,
          quote.spread()!.ask()!,
          newBidSizeResult.value,
          newAskSizeResult.value,
          quote.timestampMs(),
          quote.sourceId(),
          quote.instrumentId()
        );

        return Ok(newQuote);
      },
      InvalidQuoteError
    );
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Helper: создаёт Price из Decimal (с обработкой null)
   *
   * @internal
   * @param value - Decimal значение или null
   * @param field - Название поля ('bid' или 'ask')
   * @param op - Название операции для error context
   * @returns Result с Price или InvalidQuoteError
   */
  private static createPrice(
    value: Decimal | null,
    field: 'bid' | 'ask',
    op: string
  ): Result<Price | null, InvalidQuoteError> {
    if (value === null) {
      return Ok(null);
    }

    const result = PriceService.create(value);
    if (isErr(result)) {
      const reason = field === 'bid'
        ? QuoteErrorReason.INVALID_BID
        : QuoteErrorReason.INVALID_ASK;

      // Передаём оригинальную ошибку в rewrap, который сохранит все root fields
      // и добавит компонент + новую причину
      return Err(
        rewrap(
          QuoteService.SERVICE_NAME,
          op,
          {
            component: field, // Добавляем component т.к. PriceService.create возвращает field: 'value', а не 'bid'/'ask'
            reason, // Override reason с Quote-специфичной причиной
            cause: toCause(result.error) // Add cause для trace
          },
          result.error, // Передаём оригинальную ошибку, чтобы сохранить opChain!
          InvalidQuoteError
        )
      );
    }

    return Ok(result.value);
  }

  /**
   * Helper: создаёт Quantity из Decimal
   *
   * @internal
   * @param value - Decimal значение
   * @param field - Название поля ('bidSize' или 'askSize')
   * @param op - Название операции для error context
   * @returns Result с Quantity или InvalidQuoteError
   */
  private static createQuantity(
    value: Decimal,
    field: 'bidSize' | 'askSize',
    op: string
  ): Result<Quantity, InvalidQuoteError> {
    const result = QuantityService.create(value);
    if (isErr(result)) {
      const reason = field === 'bidSize'
        ? QuoteErrorReason.INVALID_BID_SIZE
        : QuoteErrorReason.INVALID_ASK_SIZE;

      // Передаём оригинальную ошибку в rewrap, который сохранит все root fields
      return Err(
        rewrap(
          QuoteService.SERVICE_NAME,
          op,
          {
            component: field, // Добавляем component т.к. QuantityService.create возвращает field: 'value', а не 'bidSize'/'askSize'
            reason, // Override reason
            cause: toCause(result.error) // Add cause
          },
          result.error, // Передаём оригинальную ошибку
          InvalidQuoteError
        )
      );
    }

    return Ok(result.value);
  }
}
