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
  unexpectedError
} from '../../shared/facade/errorUtils.js';
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
  /**
   * Создаёт Quote из Decimal значений
   *
   * @remarks
   * Базовый метод создания. Используется внутри других методов Facade.
   * Использует wrapOp для централизованной обработки ошибок.
   *
   * @param bidValue - Значение bid (может быть null)
   * @param askValue - Значение ask (может быть null)
   * @param bidSizeValue - Значение bid size
   * @param askSizeValue - Значение ask size
   * @param timestamp - Временная метка (опционально)
   * @returns Result с Quote или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const result = QuoteService.createFromDecimals(
   *   new Decimal(0.50),
   *   new Decimal(0.51),
   *   new Decimal(100),
   *   new Decimal(200)
   * );
   * if (result.ok) {
   *   const quote = result.value;
   * }
   * ```
   */
  public static createFromDecimals(
    bidValue: Decimal | null,
    askValue: Decimal | null,
    bidSizeValue: Decimal,
    askSizeValue: Decimal,
    timestamp?: Date | number
  ): Result<Quote, InvalidQuoteError> {
    const ctx = {
      bidValue: bidValue?.toString() ?? null,
      askValue: askValue?.toString() ?? null,
      bidSizeValue: bidSizeValue.toString(),
      askSizeValue: askSizeValue.toString()
    };

    return wrapOp('creates', ctx, () => {
      // Создаём Price объекты
      let bid: Price | null = null;
      if (bidValue !== null) {
        const bidResult = PriceService.create(bidValue);
        if (isErr(bidResult)) {
          return Err(
            rewrap(
              'creates',
              { component: 'bid' },
              new InvalidQuoteError('Invalid bid price', {
                context: {
                  reason: QuoteErrorReason.INVALID_BID,
                  cause: bidResult.error
                }
              }),
              InvalidQuoteError
            )
          );
        }
        bid = bidResult.value;
      }

      let ask: Price | null = null;
      if (askValue !== null) {
        const askResult = PriceService.create(askValue);
        if (isErr(askResult)) {
          return Err(
            rewrap(
              'creates',
              { component: 'ask' },
              new InvalidQuoteError('Invalid ask price', {
                context: {
                  reason: QuoteErrorReason.INVALID_ASK,
                  cause: askResult.error
                }
              }),
              InvalidQuoteError
            )
          );
        }
        ask = askResult.value;
      }

      // Создаём Quantity объекты
      const bidSizeResult = QuantityService.create(bidSizeValue);
      if (isErr(bidSizeResult)) {
        return Err(
          rewrap(
            'creates',
            { component: 'bidSize' },
            new InvalidQuoteError('Invalid bid size', {
              context: {
                reason: QuoteErrorReason.INVALID_BID_SIZE,
                cause: bidSizeResult.error
              }
            }),
            InvalidQuoteError
          )
        );
      }

      const askSizeResult = QuantityService.create(askSizeValue);
      if (isErr(askSizeResult)) {
        return Err(
          rewrap(
            'creates',
            { component: 'askSize' },
            new InvalidQuoteError('Invalid ask size', {
              context: {
                reason: QuoteErrorReason.INVALID_ASK_SIZE,
                cause: askSizeResult.error
              }
            }),
            InvalidQuoteError
          )
        );
      }

      // Создаём Quote через Core (может бросить QuoteInvariantViolation)
      try {
        const ts = timestamp ?? Date.now();
        const quote = Quote.of(
          bid,
          ask,
          bidSizeResult.value,
          askSizeResult.value,
          ts
        );
        return Ok(quote);
      } catch (error) {
        // Обработка инвариантов Core
        if (error instanceof QuoteInvariantViolation) {
          return Err(
            new InvalidQuoteError(error.message, {
              context: {
                op: 'creates',
                reason: error.reason
              }
            })
          );
        }

        // Неожиданная ошибка
        return Err(
          unexpectedError(
            'creates',
            ctx,
            error,
            'quote',
            InvalidQuoteError
          )
        );
      }
    }, 'quote', InvalidQuoteError);
  }

  /**
   * Создаёт Quote из number значений
   *
   * @remarks
   * Публичный метод для создания котировок.
   * Использует toDecimal() для безопасного парсинга.
   *
   * @param bidValue - Значение bid (может быть null)
   * @param askValue - Значение ask (может быть null)
   * @param bidSizeValue - Значение bid size
   * @param askSizeValue - Значение ask size
   * @param timestamp - Временная метка (опционально)
   * @returns Result с Quote или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const result = QuoteService.create(0.50, 0.51, 100, 200);
   * if (result.ok) {
   *   const quote = result.value;
   *   console.log(quote.isTwoSided()); // true
   * } else {
   *   // Структурированная ошибка
   *   console.error(result.error.context?.op); // 'create'
   *   console.error(result.error.context?.reason); // QuoteErrorReason
   *   console.error(result.error.context?.raw); // { field, value }
   * }
   * ```
   */
  public static create(
    bidValue: number | null,
    askValue: number | null,
    bidSizeValue: number,
    askSizeValue: number,
    timestamp?: Date | number
  ): Result<Quote, InvalidQuoteError> {
    const ctx = {
      bidValue: bidValue ?? null,
      askValue: askValue ?? null,
      bidSizeValue,
      askSizeValue
    };

    return wrapOp('create', ctx, () => {
      // Парсим bid через toDecimal (если не null)
      let bidDecimal: Decimal | null = null;
      if (bidValue !== null) {
        const bidResult = toDecimal(
          'bidValue',
          bidValue,
          QuoteErrorReason.INVALID_FORMAT,
          InvalidQuoteError
        );
        if (isErr(bidResult)) {
          return Err(rewrap('create', { component: 'bid' }, bidResult.error, InvalidQuoteError));
        }
        bidDecimal = bidResult.value;
      }

      // Парсим ask через toDecimal (если не null)
      let askDecimal: Decimal | null = null;
      if (askValue !== null) {
        const askResult = toDecimal(
          'askValue',
          askValue,
          QuoteErrorReason.INVALID_FORMAT,
          InvalidQuoteError
        );
        if (isErr(askResult)) {
          return Err(rewrap('create', { component: 'ask' }, askResult.error, InvalidQuoteError));
        }
        askDecimal = askResult.value;
      }

      // Парсим bidSize
      const bidSizeResult = toDecimal(
        'bidSizeValue',
        bidSizeValue,
        QuoteErrorReason.INVALID_FORMAT,
        InvalidQuoteError
      );
      if (isErr(bidSizeResult)) {
        return Err(rewrap('create', { component: 'bidSize' }, bidSizeResult.error, InvalidQuoteError));
      }

      // Парсим askSize
      const askSizeResult = toDecimal(
        'askSizeValue',
        askSizeValue,
        QuoteErrorReason.INVALID_FORMAT,
        InvalidQuoteError
      );
      if (isErr(askSizeResult)) {
        return Err(rewrap('create', { component: 'askSize' }, askSizeResult.error, InvalidQuoteError));
      }

      // Делегируем creates (wrapOp сам сделает rewrap)
      return QuoteService.createFromDecimals(
        bidDecimal,
        askDecimal,
        bidSizeResult.value,
        askSizeResult.value,
        timestamp
      );
    }, 'quote', InvalidQuoteError);
  }

  /**
   * Создаёт одностороннюю bid котировку
   *
   * @param bidValue - Значение bid
   * @param bidSizeValue - Значение bid size
   * @param timestamp - Временная метка (опционально)
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
    bidValue: number | Decimal,
    bidSizeValue: number | Decimal,
    timestamp?: Date | number
  ): Result<Quote, InvalidQuoteError> {
    const ctx = {
      bidValue: String(bidValue),
      bidSizeValue: String(bidSizeValue)
    };

    return wrapOp('bidOnly', ctx, () => {
      // Парсим bid
      const bidResult = toDecimal('bidValue', bidValue, QuoteErrorReason.INVALID_FORMAT, InvalidQuoteError);
      if (isErr(bidResult)) {
        return Err(rewrap('bidOnly', {}, bidResult.error, InvalidQuoteError));
      }

      // Парсим bidSize
      const sizeResult = toDecimal('bidSizeValue', bidSizeValue, QuoteErrorReason.INVALID_FORMAT, InvalidQuoteError);
      if (isErr(sizeResult)) {
        return Err(rewrap('bidOnly', {}, sizeResult.error, InvalidQuoteError));
      }

      return QuoteService.createFromDecimals(
        bidResult.value,
        null,
        sizeResult.value,
        new Decimal(0), // zero ask size
        timestamp
      );
    }, 'quote', InvalidQuoteError);
  }

  /**
   * Создаёт одностороннюю ask котировку
   *
   * @param askValue - Значение ask
   * @param askSizeValue - Значение ask size
   * @param timestamp - Временная метка (опционально)
   * @returns Result с Quote або InvalidQuoteError
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
    askValue: number | Decimal,
    askSizeValue: number | Decimal,
    timestamp?: Date | number
  ): Result<Quote, InvalidQuoteError> {
    const ctx = {
      askValue: String(askValue),
      askSizeValue: String(askSizeValue)
    };

    return wrapOp('askOnly', ctx, () => {
      // Парсим ask
      const askResult = toDecimal('askValue', askValue, QuoteErrorReason.INVALID_FORMAT, InvalidQuoteError);
      if (isErr(askResult)) {
        return Err(rewrap('askOnly', {}, askResult.error, InvalidQuoteError));
      }

      // Парсим askSize
      const sizeResult = toDecimal('askSizeValue', askSizeValue, QuoteErrorReason.INVALID_FORMAT, InvalidQuoteError);
      if (isErr(sizeResult)) {
        return Err(rewrap('askOnly', {}, sizeResult.error, InvalidQuoteError));
      }

      return QuoteService.createFromDecimals(
        null,
        askResult.value,
        new Decimal(0), // zero bid size
        sizeResult.value,
        timestamp
      );
    }, 'quote', InvalidQuoteError);
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
   * @param shiftAmount - Величина сдвига (может быть отрицательной)
   * @returns Result с новой Quote или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
   *
   * // Сдвиг вверх
   * const upResult = QuoteService.shift(quote, new Decimal(0.01));
   * // bid: 0.48 → 0.49, ask: 0.52 → 0.53
   *
   * // Сдвиг вниз
   * const downResult = QuoteService.shift(quote, new Decimal(-0.01));
   * // bid: 0.48 → 0.47, ask: 0.52 → 0.51
   *
   * if (isErr(upResult)) {
   *   // Полный контекст ошибки
   *   console.error(upResult.error.context?.op); // 'shift'
   *   console.error(upResult.error.context?.opChain); // ['creates', 'shift']
   * }
   * ```
   */
  public static shift(
    quote: Quote,
    shiftAmount: Decimal
  ): Result<Quote, InvalidQuoteError> {
    const ctx = {
      quoteBid: quote.bid()?.value().toString() ?? null,
      quoteAsk: quote.ask()?.value().toString() ?? null,
      shiftAmount: shiftAmount.toString()
    };

    return wrapOp('shift', ctx, () => {
      let newBidDecimal: Decimal | null = null;
      if (quote.bid() !== null) {
        newBidDecimal = quote.bid()!.value().plus(shiftAmount);
      }

      let newAskDecimal: Decimal | null = null;
      if (quote.ask() !== null) {
        newAskDecimal = quote.ask()!.value().plus(shiftAmount);
      }

      // wrapOp автоматически обработает ошибки и добавит opChain
      return QuoteService.createFromDecimals(
        newBidDecimal,
        newAskDecimal,
        quote.bidSize().value(),
        quote.askSize().value(),
        Date.now()
      );
    }, 'quote', InvalidQuoteError);
  }

  /**
   * Применяет skew к котировке
   *
   * @remarks
   * Skew - это асимметричное изменение bid и ask.
   * Позволяет наклонить котировку в одну сторону.
   *
   * @param quote - Исходная котировка
   * @param bidAdjustment - Adjustment для bid
   * @param askAdjustment - Adjustment для ask
   * @returns Result с новой Quote или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
   *
   * // Сдвинуть bid вниз, ask вверх (расширить spread)
   * const result = QuoteService.skew(
   *   quote,
   *   new Decimal(-0.01), // bid вниз
   *   new Decimal(0.01)   // ask вверх
   * );
   * // bid: 0.48 → 0.47, ask: 0.52 → 0.53, spread: 0.04 → 0.06
   * ```
   */
  public static skew(
    quote: Quote,
    bidAdjustment: Decimal,
    askAdjustment: Decimal
  ): Result<Quote, InvalidQuoteError> {
    const ctx = {
      quoteBid: quote.bid()?.value().toString() ?? null,
      quoteAsk: quote.ask()?.value().toString() ?? null,
      bidAdjustment: bidAdjustment.toString(),
      askAdjustment: askAdjustment.toString()
    };

    return wrapOp('skew', ctx, () => {
      let newBidDecimal: Decimal | null = null;
      if (quote.bid() !== null) {
        newBidDecimal = quote.bid()!.value().plus(bidAdjustment);
      }

      let newAskDecimal: Decimal | null = null;
      if (quote.ask() !== null) {
        newAskDecimal = quote.ask()!.value().plus(askAdjustment);
      }

      return QuoteService.createFromDecimals(
        newBidDecimal,
        newAskDecimal,
        quote.bidSize().value(),
        quote.askSize().value(),
        Date.now()
      );
    }, 'quote', InvalidQuoteError);
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
    const ctx = {
      quoteBid: quote.bid()?.value().toString() ?? null,
      quoteAsk: quote.ask()?.value().toString() ?? null,
      newBidSize: String(newBidSize),
      newAskSize: String(newAskSize)
    };

    return wrapOp('updateSizes', ctx, () => {
      // Конвертируем в Quantity если нужно
      let bidSize: Quantity;
      if (newBidSize instanceof Quantity) {
        bidSize = newBidSize;
      } else {
        const bidSizeResult = QuantityService.create(newBidSize);
        if (isErr(bidSizeResult)) {
          return Err(
            rewrap(
              'updateSizes',
              { component: 'bidSize' },
              new InvalidQuoteError('Invalid bid size', {
                context: {
                  reason: QuoteErrorReason.INVALID_BID_SIZE,
                  cause: bidSizeResult.error
                }
              }),
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
          return Err(
            rewrap(
              'updateSizes',
              { component: 'askSize' },
              new InvalidQuoteError('Invalid ask size', {
                context: {
                  reason: QuoteErrorReason.INVALID_ASK_SIZE,
                  cause: askSizeResult.error
                }
              }),
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
          Date.now()
        );
        return Ok(newQuote);
      } catch (error) {
        if (error instanceof QuoteInvariantViolation) {
          return Err(
            new InvalidQuoteError(error.message, {
              context: {
                op: 'updateSizes',
                reason: error.reason
              }
            })
          );
        }

        return Err(
          unexpectedError('updateSizes', ctx, error, 'quote', InvalidQuoteError)
        );
      }
    }, 'quote', InvalidQuoteError);
  }

  /**
   * Получает spread width или 0 если односторонняя котировка
   *
   * @remarks
   * Утилита для безопасного получения spread.
   * В отличие от quote.spreadWidth(), всегда возвращает значение.
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
    const spread = quote.spreadWidth();
    return spread ?? new Decimal(0);
  }

  /**
   * Получает mid price или null если односторонняя котировка
   *
   * @remarks
   * Алиас для quote.midPrice() для консистентности API.
   *
   * @param quote - Котировка
   * @returns Price mid или null
   *
   * @example
   * ```typescript
   * const quote = expectOk(QuoteService.create(0.48, 0.52, 100, 150));
   * const mid = QuoteService.getMidOrNull(quote);
   * if (mid !== null) {
   *   console.log(mid.value().toString()); // "0.5"
   * }
   * ```
   */
  public static getMidOrNull(quote: Quote): Price | null {
    return quote.midPrice();
  }
}
