/**
 * OrderbookInvalidError - ошибка невалидного/crossed orderbook
 *
 * @remarks
 * Возвращается когда orderbook не проходит валидацию:
 * - Crossed book (bid >= ask)
 * - Empty sides при allowCrossed=false
 * - Некорректные данные после нормализации
 *
 * Критично для trading: crossed book = торговля по мусорным данным.
 * Должна быть явным сигналом, а не silent null.
 *
 * @example
 * ```typescript
 * import { OrderbookInvalidError, OrderbookInvalidReason } from '@polymarket/errors/orderbook';
 *
 * if (bestBid >= bestAsk) {
 *   return Err(new OrderbookInvalidError(
 *     'Crossed book detected',
 *     {
 *       context: { reason: OrderbookInvalidReason.CROSSED_BOOK, bestBid, bestAsk, marketId }
 *     }
 *   ));
 * }
 * ```
 */

import { TradingError } from '../base/TradingError.js';

/**
 * Код ошибки для OrderbookInvalidError
 */
export const ORDERBOOK_INVALID_ERROR_CODE = 'ORDERBOOK_INVALID_ERROR' as const;

/**
 * Причина невалидности orderbook
 */
export enum OrderbookInvalidReason {
  /**
   * Crossed book: best bid >= best ask
   *
   * @remarks
   * Самая критичная ошибка для trading.
   * Означает некорректные данные или арбитражную возможность.
   */
  CROSSED_BOOK = 'CROSSED_BOOK',

  /**
   * Empty orderbook: нет bid и ask
   *
   * @remarks
   * Может быть допустимо в некоторых случаях,
   * но для trading означает отсутствие ликвидности.
   */
  EMPTY_BOOK = 'EMPTY_BOOK',

  /**
   * One-sided book: есть только bid или только ask
   *
   * @remarks
   * Технически валидно, но торговать нельзя.
   */
  ONE_SIDED = 'ONE_SIDED',

  /**
   * Invalid price: price <= 0 или price > 1 (для prediction markets)
   *
   * @remarks
   * Некорректные данные от exchange.
   */
  INVALID_PRICE = 'INVALID_PRICE',

  /**
   * Invalid quantity: quantity < 0 (после агрегации)
   *
   * @remarks
   * Не должно происходить, но может быть из-за багов.
   */
  INVALID_QUANTITY = 'INVALID_QUANTITY',

  /**
   * Stale data: timestamp слишком старый
   *
   * @remarks
   * Данные устарели и не должны использоваться для trading.
   */
  STALE_DATA = 'STALE_DATA',
}

/**
 * Context для OrderbookInvalidError
 */
export interface OrderbookInvalidContext {
  /**
   * Причина невалидности
   */
  readonly reason: OrderbookInvalidReason;

  /**
   * Идентификатор market/instrument
   */
  readonly marketId?: string;

  /**
   * Идентификатор asset/token
   */
  readonly tokenId?: string;

  /**
   * Best bid price (если есть)
   */
  readonly bestBid?: number;

  /**
   * Best ask price (если есть)
   */
  readonly bestAsk?: number;

  /**
   * Age в миллисекундах (для STALE_DATA)
   */
  readonly ageMs?: number;

  /**
   * Дополнительные данные
   */
  readonly [key: string]: unknown;
}

/**
 * Ошибка невалидного orderbook
 *
 * @remarks
 * Extends TradingError из @polymarket/errors.
 * Severity 'high' — crossed book критично для trading.
 * Используется в Result<Orderbook, OrderbookInvalidError>.
 */
export class OrderbookInvalidError extends TradingError {
  public static readonly code = ORDERBOOK_INVALID_ERROR_CODE;
  public override readonly severity = 'high' as const;

  constructor(
    message: string | ((context: Record<string, unknown>) => string),
    options?: { context?: Record<string, unknown> }
  ) {
    super(message, {
      ...options,
      code: ORDERBOOK_INVALID_ERROR_CODE,
    });
  }

  /**
   * Type guard для OrderbookInvalidError
   *
   * @param error - Любая ошибка
   * @returns true если ошибка является OrderbookInvalidError
   * @throws {never} Не бросает исключений — безопасная проверка типа.
   *
   * @remarks
   * Используется для разветвления обработки ошибок в Result-цепочках.
   *
   * @example
   * ```typescript
   * if (OrderbookInvalidError.isOrderbookInvalidError(err)) {
   *   console.error('Invalid orderbook:', err.getReason());
   * }
   * ```
   */
  public static isOrderbookInvalidError(error: unknown): error is OrderbookInvalidError {
    return error instanceof OrderbookInvalidError;
  }

  /**
   * Получить причину невалидности из context
   *
   * @returns OrderbookInvalidReason или undefined если context отсутствует
   * @throws {never} Не бросает исключений.
   *
   * @remarks
   * Извлекает поле `reason` из context, установленного при создании ошибки.
   *
   * @example
   * ```typescript
   * const reason = err.getReason();
   * if (reason === OrderbookInvalidReason.CROSSED_BOOK) {
   *   // crossed book
   * }
   * ```
   */
  public getReason(): OrderbookInvalidReason | undefined {
    return (this.context as OrderbookInvalidContext | undefined)?.reason;
  }

  /**
   * Проверить, является ли ошибка crossed book
   *
   * @returns true если reason === CROSSED_BOOK
   * @throws {never} Не бросает исключений.
   *
   * @remarks
   * Удобный предикат для частного случая CROSSED_BOOK.
   *
   * @example
   * ```typescript
   * if (err.isCrossedBook()) {
   *   logger.error('Crossed book detected — halting trading');
   * }
   * ```
   */
  public isCrossedBook(): boolean {
    return this.getReason() === OrderbookInvalidReason.CROSSED_BOOK;
  }

  /**
   * Проверить, является ли ошибка stale data
   *
   * @returns true если reason === STALE_DATA
   * @throws {never} Не бросает исключений.
   *
   * @remarks
   * Удобный предикат для частного случая STALE_DATA.
   *
   * @example
   * ```typescript
   * if (err.isStaleData()) {
   *   logger.warn('Stale orderbook data — skipping update');
   * }
   * ```
   */
  public isStaleData(): boolean {
    return this.getReason() === OrderbookInvalidReason.STALE_DATA;
  }
}
