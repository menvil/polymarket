import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { Price } from '../../price/core/Price.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { Quote, QuoteInvariantViolation } from '../core/index.js';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';
import {
  toDecimal,
  rewrap,
  wrapOp,
  unexpectedError,
  toCause
} from '../../shared/facade/errorUtils.js';
import { ErrorSource } from '../../shared/facade/ErrorSource.js';
import { PriceService } from '../../price/facade/PriceService.js';
import { QuantityService } from '../../quantity/facade/QuantityService.js';

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
   * Создаёт Quote
   *
   * @remarks
   * Публичный метод для создания котировок.
   * Использует toDecimal() для безопасного парсинга всех входных параметров.
   * Принимает number | string | Decimal для гибкости использования.
   *
   * @param bidValue - Значение bid (Decimal | number | string | null)
   * @param askValue - Значение ask (Decimal | number | string | null)
   * @param bidSizeValue - Значение bid size (Decimal | number | string)
   * @param askSizeValue - Значение ask size (Decimal | number | string)
   * @param timestamp - Временная метка (опционально, Date | Decimal | number | string)
   * @returns Result с Quote или InvalidQuoteError
   *
   * @example
   * ```typescript
   * // С numbers
   * const result1 = QuoteService.create(0.50, 0.51, 100, 200);
   *
   * // С strings
   * const result2 = QuoteService.create("0.50", "0.51", "100", "200");
   *
   * // С Decimal
   * const result3 = QuoteService.create(
   *   new Decimal(0.50),
   *   new Decimal(0.51),
   *   new Decimal(100),
   *   new Decimal(200)
   * );
   *
   * // С custom timestamp (Decimal)
   * const result4 = QuoteService.create(
   *   0.50,
   *   0.51,
   *   100,
   *   200,
   *   new Decimal(Date.now())
   * );
   *
   * // Односторонняя котировка
   * const result5 = QuoteService.create(0.50, null, 100, 0);
   *
   * if (result1.ok) {
   *   const quote = result1.value;
   *   console.log(quote.isTwoSided()); // true
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
    timestamp?: Date | Decimal | number | string
  ): Result<Quote, InvalidQuoteError> {
    const op = 'create';
    const ctx = {
      bidValue: bidValue !== null ? String(bidValue) : null,
      askValue: askValue !== null ? String(askValue) : null,
      bidSizeValue: String(bidSizeValue),
      askSizeValue: String(askSizeValue),
      timestamp: timestamp !== undefined ? String(timestamp) : undefined
    };

    return wrapOp(QuoteService.SERVICE_NAME, op, ctx, () => {
      // Конвертируем bid через toDecimal (если не null)
      let bidDecimal: Decimal | null = null;
      if (bidValue !== null) {
        const bidResult = toDecimal(
          'bidValue',
          bidValue,
          QuoteErrorReason.INVALID_FORMAT,
          InvalidQuoteError
        );
        if (isErr(bidResult)) {
          return Err(rewrap(QuoteService.SERVICE_NAME, op, {}, bidResult.error, InvalidQuoteError));
        }
        bidDecimal = bidResult.value;
      }

      // Конвертируем ask через toDecimal (если не null)
      let askDecimal: Decimal | null = null;
      if (askValue !== null) {
        const askResult = toDecimal(
          'askValue',
          askValue,
          QuoteErrorReason.INVALID_FORMAT,
          InvalidQuoteError
        );
        if (isErr(askResult)) {
          return Err(rewrap(QuoteService.SERVICE_NAME, op, {}, askResult.error, InvalidQuoteError));
        }
        askDecimal = askResult.value;
      }

      // Конвертируем bidSize через toDecimal
      const bidSizeResult = toDecimal(
        'bidSizeValue',
        bidSizeValue,
        QuoteErrorReason.INVALID_FORMAT,
        InvalidQuoteError
      );
      if (isErr(bidSizeResult)) {
        return Err(rewrap(QuoteService.SERVICE_NAME, op, {}, bidSizeResult.error, InvalidQuoteError));
      }

      // Конвертируем askSize через toDecimal
      const askSizeResult = toDecimal(
        'askSizeValue',
        askSizeValue,
        QuoteErrorReason.INVALID_FORMAT,
        InvalidQuoteError
      );
      if (isErr(askSizeResult)) {
        return Err(rewrap(QuoteService.SERVICE_NAME, op, {}, askSizeResult.error, InvalidQuoteError));
      }

      // Конвертируем timestamp через toDecimal
      let timestampDecimal: Decimal;
      if (timestamp !== undefined) {
        // Date → number (getTime)
        const tsValue = timestamp instanceof Date ? timestamp.getTime() : timestamp;
        const tsResult = toDecimal(
          'timestamp',
          tsValue,
          QuoteErrorReason.INVALID_FORMAT,
          InvalidQuoteError
        );
        if (isErr(tsResult)) {
          return Err(rewrap(QuoteService.SERVICE_NAME, op, {}, tsResult.error, InvalidQuoteError));
        }
        timestampDecimal = tsResult.value;
      } else {
        // Default: текущее время
        timestampDecimal = new Decimal(Date.now());
      }

      // Создаём Price объекты через helper
      const bidResult = this.createPrice(bidDecimal, 'bid', op);
      if (isErr(bidResult)) return bidResult;
      const bid = bidResult.value;

      const askResult = this.createPrice(askDecimal, 'ask', op);
      if (isErr(askResult)) return askResult;
      const ask = askResult.value;

      // Создаём Quantity объекты через helper
      const bidSizeQuantityResult = this.createQuantity(bidSizeResult.value, 'bidSize', op);
      if (isErr(bidSizeQuantityResult)) return bidSizeQuantityResult;

      const askSizeQuantityResult = this.createQuantity(askSizeResult.value, 'askSize', op);
      if (isErr(askSizeQuantityResult)) return askSizeQuantityResult;

      // Создаём Quote через Core (может бросить QuoteInvariantViolation)
      try {
        const quote = Quote.of(
          bid,
          ask,
          bidSizeQuantityResult.value,
          askSizeQuantityResult.value,
          timestampDecimal
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
          unexpectedError(QuoteService.SERVICE_NAME, op, ctx, error, InvalidQuoteError)
        );
      }
    }, InvalidQuoteError);
  }

  /**
   * Создаёт одностороннюю bid котировку
   *
   * @param bidValue - Значение bid (Decimal | number | string)
   * @param bidSizeValue - Значение bid size (Decimal | number | string)
   * @param timestamp - Временная метка (опционально, Date | Decimal | number | string)
   * @returns Result с Quote или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const result = QuoteService.bidOnly(0.50, 100);
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
    timestamp?: Date | Decimal | number | string
  ): Result<Quote, InvalidQuoteError> {
    // Делегируем на create с null для ask
    return QuoteService.create(
      bidValue,
      null, // ask отсутствует
      bidSizeValue,
      0, // zero ask size
      timestamp
    );
  }

  /**
   * Создаёт одностороннюю ask котировку
   *
   * @param askValue - Значение ask (Decimal | number | string)
   * @param askSizeValue - Значение ask size (Decimal | number | string)
   * @param timestamp - Временная метка (опционально, Date | Decimal | number | string)
   * @returns Result с Quote или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const result = QuoteService.askOnly(0.51, 200);
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
    timestamp?: Date | Decimal | number | string
  ): Result<Quote, InvalidQuoteError> {
    // Делегируем на create с null для bid
    return QuoteService.create(
      null, // bid отсутствует
      askValue,
      0, // zero bid size
      askSizeValue,
      timestamp
    );
  }

  /**
   * Сдвигает котировку на указанную величину
   *
   * @remarks
   * Shift - это параллельный сдвиг bid и ask на одинаковую величину.
   * Spread остаётся неизменным.
   *
   * Использует wrapOp для автоматической обработки ошибок.
   *
   * @param quote - Исходная котировка
   * @param shiftAmount - Величина сдвига (Decimal | number | string, может быть отрицательной)
   * @returns Result с новой Quote или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
   *
   * // Сдвиг вверх (с number)
   * const upResult = QuoteService.shift(quote, 0.01);
   * // bid: 0.48 → 0.49, ask: 0.52 → 0.53
   *
   * // Сдвиг вниз (с Decimal)
   * const downResult = QuoteService.shift(quote, new Decimal(-0.01));
   * // bid: 0.48 → 0.47, ask: 0.52 → 0.51
   *
   * if (isErr(upResult)) {
   *   // Полный контекст ошибки
   *   console.error(upResult.error.context?.op); // 'shift'
   *   console.error(upResult.error.context?.opChain); // ['create', 'shift']
   * }
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
      shiftAmount: String(shiftAmount)
    };

    return wrapOp(QuoteService.SERVICE_NAME, op, ctx, () => {
      // Конвертируем shiftAmount в Decimal
      const shiftDecimalResult = toDecimal(
        'shiftAmount',
        shiftAmount,
        QuoteErrorReason.INVALID_FORMAT,
        InvalidQuoteError
      );
      if (isErr(shiftDecimalResult)) {
        return Err(rewrap(QuoteService.SERVICE_NAME, op, {}, shiftDecimalResult.error, InvalidQuoteError));
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

      // Используем create - он сам сконвертирует Decimal в Price/Quantity
      return QuoteService.create(
        newBidDecimal,
        newAskDecimal,
        quote.bidSize().value(),
        quote.askSize().value(),
        Date.now()
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
      // Конвертируем bidAdjustment в Decimal
      const bidAdjustmentResult = toDecimal(
        'bidAdjustment',
        bidAdjustment,
        QuoteErrorReason.INVALID_FORMAT,
        InvalidQuoteError
      );
      if (isErr(bidAdjustmentResult)) {
        return Err(rewrap(QuoteService.SERVICE_NAME, op, {}, bidAdjustmentResult.error, InvalidQuoteError));
      }
      const bidAdjustmentDecimal = bidAdjustmentResult.value;

      // Конвертируем askAdjustment в Decimal
      const askAdjustmentResult = toDecimal(
        'askAdjustment',
        askAdjustment,
        QuoteErrorReason.INVALID_FORMAT,
        InvalidQuoteError
      );
      if (isErr(askAdjustmentResult)) {
        return Err(rewrap(QuoteService.SERVICE_NAME, op, {}, askAdjustmentResult.error, InvalidQuoteError));
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

      // Используем create - он сам сконвертирует Decimal в Price/Quantity
      return QuoteService.create(
        newBidDecimal,
        newAskDecimal,
        quote.bidSize().value(),
        quote.askSize().value(),
        Date.now()
      );
    }, InvalidQuoteError);
  }

  /**
   * Обновляет размеры котировки
   *
   * @param quote - Исходная котировка
   * @param newBidSize - Новый bid size
   * @param newAskSize - Новый ask size
   * @returns Result с новой Quote или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
   * const result = QuoteService.updateSizes(quote, 200, 300);
   *
   * if (result.ok) {
   *   const updated = result.value;
   *   console.log(updated.bidSize().value().toNumber()); // 200
   *   console.log(updated.askSize().value().toNumber()); // 300
   * }
   * ```
   */
  public static updateSizes(
    quote: Quote,
    newBidSize: number | Quantity,
    newAskSize: number | Quantity
  ): Result<Quote, InvalidQuoteError> {
    const op = 'updateSizes';
    const ctx = {
      quoteBid: quote.bid()?.value().toString() ?? null,
      quoteAsk: quote.ask()?.value().toString() ?? null,
      newBidSize: newBidSize instanceof Quantity ? newBidSize.value().toString() : String(newBidSize),
      newAskSize: newAskSize instanceof Quantity ? newAskSize.value().toString() : String(newAskSize)
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

      // Создаём новую котировку через Core
      try {
        const newQuote = Quote.of(
          quote.bid(),
          quote.ask(),
          bidSize,
          askSize,
          new Decimal(Date.now())
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
          unexpectedError(QuoteService.SERVICE_NAME, op, ctx, error, InvalidQuoteError)
        );
      }
    }, InvalidQuoteError);
  }

  /**
   * Получает spread width или 0 если односторонняя котировка
   *
   * @remarks
   * Утилита для безопасного получения spread width.
   * Использует quote.spread() для получения Spread объекта.
   *
   * @param quote - Котировка
   * @returns Decimal со значением spread (0 для one-sided)
   *
   * @example
   * ```typescript
   * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
   * const spread = QuoteService.getSpreadOrZero(quote);
   * console.log(spread.toString()); // "0.04"
   *
   * const bidOnly = expectOk(QuoteService.bidOnly(0.50, 100));
   * const spreadBid = QuoteService.getSpreadOrZero(bidOnly);
   * console.log(spreadBid.toString()); // "0"
   * ```
   */
  public static getSpreadOrZero(quote: Quote): Decimal {
    const spread = quote.spread();
    return spread !== null ? spread.width() : new Decimal(0);
  }

  /**
   * Получает mid price или null если односторонняя котировка
   *
   * @remarks
   * Использует quote.spread() для получения Spread объекта.
   * Преобразует Decimal в Price.
   *
   * @param quote - Котировка
   * @returns Price mid или null
   *
   * @example
   * ```typescript
   * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
   * const mid = QuoteService.getMidPrice(quote);
   * if (mid !== null) {
   *   console.log(mid.value().toString()); // "0.5"
   * }
   * ```
   */
  public static getMidPrice(quote: Quote): Price | null {
    const spread = quote.spread();
    if (spread === null) {
      return null;
    }

    const midDecimal = spread.mid();

    // SAFETY: mid всегда в [MIN_PRICE, MAX_PRICE] если bid/ask валидны
    // bid <= ask (инвариант) и оба в [MIN, MAX] → mid в [MIN, MAX]
    try {
      return Price.of(midDecimal);
    } catch (error) {
      // Это не должно случиться, но если случится - возвращаем null
      return null;
    }
  }

  // === Private Helper Methods ===

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
